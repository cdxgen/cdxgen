#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import repl from "node:repl";

import jsonata from "jsonata";

import { createBom } from "../lib/cli/index.js";
import { isSpdxJsonLd } from "../lib/helpers/bomUtils.js";
import {
  printCallStack,
  printDependencyTree,
  printFormulation,
  printOccurrences,
  printOSTable,
  printServices,
  printSummary,
  printTable,
  printVulnerabilities,
} from "../lib/helpers/display.js";
import {
  formatHbomHardwareClassSummary,
  getHbomSummary,
  isHbomLikeBom,
} from "../lib/helpers/hbomAnalysis.js";
import {
  getPropertyValue,
  getSourceDerivedCryptoComponents,
  getUnpackagedExecutableComponents,
  getUnpackagedSharedLibraryComponents,
} from "../lib/helpers/inventoryStats.js";
import { readBinary } from "../lib/helpers/protobom.js";
import {
  getProvenanceComponents,
  getTrustedComponents,
} from "../lib/helpers/provenanceUtils.js";
import { toCycloneDxLikeBom } from "../lib/helpers/spdxUtils.js";
import { table } from "../lib/helpers/table.js";
import {
  getTmpDir,
  isDryRun,
  safeExistsSync,
  safeMkdirSync,
  safeMkdtempSync,
  safeWriteSync,
} from "../lib/helpers/utils.js";
import { getBomWithOras } from "../lib/managers/oci.js";
import { validateBom } from "../lib/validator/bomValidator.js";

const options = {
  useColors: true,
  breakEvalOnSigint: true,
  preview: true,
  prompt: "cdx ↝ ",
  ignoreUndefined: true,
  useGlobal: true,
};

// Use canonical terminal settings to support custom readlines
process.env.NODE_NO_READLINE = 1;

const cdxArt = `
 ██████╗██████╗ ██╗  ██╗
██╔════╝██╔══██╗╚██╗██╔╝
██║     ██║  ██║ ╚███╔╝
██║     ██║  ██║ ██╔██╗
╚██████╗██████╔╝██╔╝ ██╗
 ╚═════╝╚═════╝ ╚═╝  ╚═╝
`;

console.log(cdxArt);

if (process.env.CDXGEN_NODE_OPTIONS) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} ${process.env.CDXGEN_NODE_OPTIONS}`;
}

// The current sbom is stored here
let sbom;
const getInteractiveBom = () => toCycloneDxLikeBom(sbom);

function getContainerRegistryHost(reference) {
  const trimmedReference = `${reference || ""}`.trim().toLowerCase();
  if (!trimmedReference) {
    return undefined;
  }
  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  return trimmedReference.slice(0, slashIndex).replace(/:\d+$/, "");
}

function isSupportedSbomRegistryReference(reference) {
  const registryHost = getContainerRegistryHost(reference);
  return registryHost === "ghcr.io" || registryHost === "docker.io";
}

function unescapeAnnotationText(value) {
  return String(value || "")
    .replace(/<br>/g, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\\([\\`*_{}\[\]()#+!|])/g, "$1")
    .trim();
}

function parseAnnotationProperties(text) {
  const properties = {};
  const lines = String(text || "").split(/\r?\n/);
  let foundHeader = false;
  for (const line of lines) {
    if (!line.startsWith("|")) {
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) {
      continue;
    }
    if (cells[0] === "Property" && cells[1] === "Value") {
      foundHeader = true;
      continue;
    }
    if (
      foundHeader &&
      /^-+$/.test(cells[0].replace(/\s/g, "")) &&
      /^-+$/.test(cells[1].replace(/\s/g, ""))
    ) {
      continue;
    }
    if (!foundHeader) {
      continue;
    }
    properties[unescapeAnnotationText(cells[0])] = unescapeAnnotationText(
      cells[1],
    );
  }
  return properties;
}

function getAuditAnnotations() {
  return (sbom?.annotations || [])
    .map((annotation) => {
      const properties = parseAnnotationProperties(annotation?.text);
      return {
        firstLine: unescapeAnnotationText(
          String(annotation?.text || "").split(/\r?\n/, 1)[0],
        ),
        properties,
        raw: annotation,
      };
    })
    .filter(
      (annotation) =>
        Object.keys(annotation.properties).some((key) =>
          key.startsWith("cdx:audit:"),
        ) || annotation.firstLine.includes("cdx:audit:"),
    );
}

function printAuditTable(title, rows) {
  if (rows.length <= 1) {
    return;
  }
  console.log(
    table(rows, {
      header: {
        alignment: "center",
        content: title,
      },
    }),
  );
}

function printKeyValueTable(title, entries) {
  const rows = [["Field", "Value"]];
  entries.forEach(([field, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    rows.push([field, `${value}`]);
  });
  printAuditTable(title, rows);
}

function isLikelyObom(bom) {
  return Boolean(
    bom?.components?.some((comp) =>
      comp?.properties?.some((prop) => prop?.name === "cdx:osquery:category"),
    ),
  );
}

function isLikelyHbom(bom) {
  return isHbomLikeBom(bom);
}

function isLikelyCargoBom(bom) {
  const formulation = Array.isArray(bom?.formulation)
    ? bom.formulation
    : bom?.formulation
      ? [bom.formulation]
      : [];
  return Boolean(
    bom?.components?.some((component) =>
      component?.purl?.startsWith("pkg:cargo/"),
    ) ||
      formulation.some((entry) =>
        entry?.components?.some(
          (component) =>
            getPropertyValue(component, "cdx:rust:buildTool") === "cargo",
        ),
      ),
  );
}

function getCargoHotspotComponents(bom) {
  return (bom?.components || []).filter(
    (component) =>
      component?.purl?.startsWith("pkg:cargo/") &&
      (getPropertyValue(component, "cdx:cargo:yanked") === "true" ||
        Boolean(getPropertyValue(component, "cdx:cargo:git")) ||
        Boolean(getPropertyValue(component, "cdx:cargo:path")) ||
        getPropertyValue(component, "cdx:cargo:dependencyKind") === "build" ||
        getPropertyValue(component, "cdx:cargo:workspaceDependencyResolved") ===
          "true" ||
        Boolean(getPropertyValue(component, "cdx:cargo:target"))),
  );
}

function getCargoWorkflowComponents(bom) {
  return (bom?.components || []).filter(
    (component) =>
      getPropertyValue(component, "cdx:github:action:ecosystem") === "cargo" ||
      getPropertyValue(component, "cdx:github:step:usesCargo") === "true",
  );
}

function getCargoFormulationEntries(bom) {
  const formulation = Array.isArray(bom?.formulation)
    ? bom.formulation
    : bom?.formulation
      ? [bom.formulation]
      : [];
  const matchingEntries = [];
  for (const formulationEntry of formulation) {
    const cargoComponents = (formulationEntry?.components || []).filter(
      (component) =>
        getPropertyValue(component, "cdx:rust:buildTool") === "cargo",
    );
    if (cargoComponents.length) {
      matchingEntries.push({
        ...formulationEntry,
        components: cargoComponents,
      });
    }
  }
  return matchingEntries;
}

const HBOM_FIRMWARE_PROPERTIES = Object.freeze([
  "cdx:hbom:protocol",
  "cdx:hbom:flags",
  "cdx:hbom:guids",
  "cdx:hbom:instanceIds",
  "cdx:hbom:createdEpoch",
  "cdx:hbom:firmwareDate",
]);

const HBOM_BUS_SECURITY_PROPERTIES = Object.freeze([
  "cdx:hbom:securityLevel",
  "cdx:hbom:iommuProtection",
  "cdx:hbom:policy",
  "cdx:hbom:authorized",
  "cdx:hbom:usbVersion",
  "cdx:hbom:usbClassName",
  "cdx:hbom:usbInterfaceClasses",
  "cdx:hbom:pciClass",
  "cdx:hbom:pciClassCode",
  "cdx:hbom:displayConnectorType",
  "cdx:hbom:contentProtection",
  "cdx:hbom:drmNode",
]);

const HBOM_POWER_PROPERTIES = Object.freeze([
  "cdx:hbom:designCapacityPercent",
  "cdx:hbom:energyNow",
  "cdx:hbom:energyFull",
  "cdx:hbom:energyFullDesign",
  "cdx:hbom:chargeNow",
  "cdx:hbom:chargeFull",
  "cdx:hbom:chargeFullDesign",
  "cdx:hbom:powerNow",
  "cdx:hbom:voltageNow",
  "cdx:hbom:currentNow",
  "cdx:hbom:warningLevel",
]);

function getInteractiveHbomOrWarn(replContext) {
  const interactiveBom = getInteractiveBom();
  if (!interactiveBom) {
    console.log(
      "⚠ No BOM is loaded. Use .import command to import an existing BOM",
    );
    replContext.displayPrompt();
    return undefined;
  }
  if (!isLikelyHbom(interactiveBom)) {
    console.log(
      "This BOM does not look like an HBOM. Import an HBOM generated with 'cdxgen -t hbom' to use this view.",
    );
    replContext.displayPrompt();
    return undefined;
  }
  return interactiveBom;
}

function filterHbomComponentsByProperties(
  bom,
  propertyNames,
  hardwareClasses = [],
) {
  return (bom?.components || []).filter((component) => {
    const hardwareClass = getPropertyValue(component, "cdx:hbom:hardwareClass");
    if (hardwareClasses.includes(hardwareClass)) {
      return true;
    }
    return propertyNames.some((propertyName) =>
      Boolean(getPropertyValue(component, propertyName)),
    );
  });
}

function getDiagnosticDisplayDetail(diagnostic) {
  return (
    diagnostic.installHint ||
    diagnostic.privilegeHint ||
    diagnostic.message ||
    diagnostic.code ||
    "-"
  );
}

let historyFile;
const historyConfigDir = join(homedir(), ".config", ".cdxgen");
if (!process.env.CDXGEN_REPL_HISTORY && !safeExistsSync(historyConfigDir)) {
  try {
    safeMkdirSync(historyConfigDir, { recursive: true });
    historyFile = join(historyConfigDir, ".repl_history");
  } catch (_e) {
    // ignore
  }
} else {
  historyFile = join(historyConfigDir, ".repl_history");
}

export const importSbom = (sbomOrPath) => {
  const importTarget = String(sbomOrPath || "").trim();
  if (!importTarget) {
    console.log("⚠ An SBOM path or image reference is required.");
    return;
  }
  if (importTarget.endsWith(".json") && safeExistsSync(importTarget)) {
    try {
      sbom = JSON.parse(readFileSync(importTarget, "utf-8"));
      let bomType = "SBOM";
      if (isSpdxJsonLd(sbom)) {
        bomType = "SPDX";
      }
      if (sbom?.vulnerabilities && Array.isArray(sbom.vulnerabilities)) {
        bomType = "VDR";
      }
      console.log(`✅ ${bomType} imported successfully from ${importTarget}`);
      printSummary(sbom);
      if (isLikelyHbom(sbom)) {
        console.log(
          "💭 HBOM detected. Try .hbomsummary, .hbomevidence, .hbomdiagnostics, or .hbomtips",
        );
      }
      if (isLikelyObom(sbom)) {
        console.log(
          "💭 OBOM detected. Try .osinfocategories, .obomtips, .processes, or .services_snapshot",
        );
      }
      if (isLikelyCargoBom(sbom)) {
        console.log(
          "💭 Cargo signals detected. Try .cargohotspots or .cargoworkflows.",
        );
      }
      if (getAuditAnnotations().length) {
        console.log(
          "💭 Audit annotations detected. Try .auditfindings, .auditactions, or .dispatchedges.",
        );
      }
    } catch (e) {
      console.log(
        `⚠ Unable to import the BOM from ${importTarget} due to ${e}`,
      );
    }
  } else if (
    (importTarget.endsWith(".cdx") || importTarget.endsWith(".proto")) &&
    safeExistsSync(importTarget)
  ) {
    sbom = readBinary(importTarget, true);
    printSummary(sbom);
  } else if (isSupportedSbomRegistryReference(importTarget)) {
    try {
      sbom = getBomWithOras(importTarget);
      if (sbom) {
        printSummary(sbom);
      } else {
        console.log(
          `cyclonedx sbom attachment was not found within ${importTarget}`,
        );
      }
    } catch (e) {
      console.log(
        `⚠ Unable to import the BOM from ${importTarget} due to ${e}`,
      );
    }
  } else {
    console.log(`⚠ ${importTarget} is invalid.`);
  }
};
// Load any sbom passed from the command line
if (process.argv.length > 2) {
  importSbom(process.argv[process.argv.length - 1]);
  console.log("💭 Type .print to view the BOM as a table");
  console.log("💭 Type .trusted to list components with trusted publishing.");
  console.log(
    "💭 Type .provenance to list components with registry provenance evidence.",
  );
  if (isLikelyHbom(sbom)) {
    console.log(
      "💭 Type .hbomsummary to review the host profile, evidence coverage, hardware-class mix, and collector diagnostics.",
    );
  }
  if (getAuditAnnotations().length) {
    console.log(
      "💭 Type .auditfindings to review cdx-audit and bom-audit annotations.",
    );
  }
} else if (safeExistsSync("bom.json")) {
  // If the current directory has a bom.json load it
  importSbom("bom.json");
} else {
  console.log("💭 Use .create <path> to create an SBOM for the given path.");
  console.log("💭 Use .import <json> to import an existing BOM.");
  console.log(
    "💭 For OBOM investigations, try .obomtips after importing an OBOM.",
  );
  console.log(
    "💭 For HBOM investigations, try .hbomtips after importing an HBOM.",
  );
  console.log("💭 Type .exit or press ctrl+d to close.");
}

const cdxgenRepl = repl.start(options);
if (historyFile) {
  cdxgenRepl.setupHistory(
    process.env.CDXGEN_REPL_HISTORY || historyFile,
    (err) => {
      if (err) {
        console.log(
          "⚠ REPL history would not be persisted for this session. Set the environment variable CDXGEN_REPL_HISTORY to specify a custom history file",
        );
      }
    },
  );
}
cdxgenRepl.defineCommand("create", {
  help: "create an SBOM for the given path",
  async action(sbomOrPath) {
    this.clearBufferedCommand();
    const tempDir = safeMkdtempSync(join(getTmpDir(), "cdxgen-repl-"));
    const bomFile = join(tempDir, "bom.json");
    const bomNSData = await createBom(sbomOrPath, {
      multiProject: true,
      installDeps: true,
      output: bomFile,
    });
    if (bomNSData) {
      sbom = bomNSData.bomJson;
      console.log("✅ BOM imported successfully.");
      console.log("💭 Type .print to view the BOM as a table");
      console.log(
        "💭 Type .trusted to list components with trusted publishing.",
      );
      console.log(
        "💭 Type .provenance to list components with registry provenance evidence.",
      );
      if (isLikelyHbom(sbom)) {
        console.log(
          "💭 Type .hbomsummary or .hbomdiagnostics for focused hardware inventory and collector-diagnostic summaries.",
        );
      }
      if (getAuditAnnotations().length) {
        console.log(
          "💭 Type .auditfindings to review cdx-audit and bom-audit annotations.",
        );
      }
      if (isLikelyCargoBom(sbom)) {
        console.log(
          "💭 Type .cargohotspots or .cargoworkflows for Cargo-specific pivots.",
        );
      }
    } else {
      console.log("BOM was not generated successfully");
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("import", {
  help: "import an existing BOM",
  action(sbomOrPath) {
    this.clearBufferedCommand();
    importSbom(sbomOrPath);
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("summary", {
  help: "summarize an existing BOM",
  action() {
    if (sbom) {
      printSummary(sbom);
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("hbomsummary", {
  help: "summarize HBOM host metadata, evidence coverage, and hardware-class mix",
  action() {
    const interactiveBom = getInteractiveBom();
    if (!interactiveBom) {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
      this.displayPrompt();
      return;
    }
    if (!isLikelyHbom(interactiveBom)) {
      console.log(
        "This BOM does not look like an HBOM. Import an HBOM generated with 'cdxgen -t hbom' to use this view.",
      );
      this.displayPrompt();
      return;
    }
    const hbomSummary = getHbomSummary(interactiveBom);
    printKeyValueTable("HBOM summary", [
      ["Host", hbomSummary.metadataName],
      ["Component type", hbomSummary.metadataType],
      ["Manufacturer", hbomSummary.manufacturer],
      ["Platform", hbomSummary.platform],
      ["Architecture", hbomSummary.architecture],
      ["Collector profile", hbomSummary.collectorProfile],
      ["Identifier policy", hbomSummary.identifierPolicy],
      ["Component count", hbomSummary.componentCount],
      ["Hardware class count", hbomSummary.hardwareClassCount],
      [
        "Top hardware classes",
        formatHbomHardwareClassSummary(hbomSummary.hardwareClassCounts),
      ],
      ["Command evidence count", hbomSummary.evidenceCommandCount],
      ["Observed file count", hbomSummary.evidenceFileCount],
    ]);
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("hbomclasses", {
  help: "show HBOM component counts by hardware class",
  action() {
    const interactiveBom = getInteractiveBom();
    if (!interactiveBom) {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
      this.displayPrompt();
      return;
    }
    if (!isLikelyHbom(interactiveBom)) {
      console.log(
        "This BOM does not look like an HBOM. Import an HBOM generated with 'cdxgen -t hbom' to use this view.",
      );
      this.displayPrompt();
      return;
    }
    const hbomSummary = getHbomSummary(interactiveBom);
    if (!hbomSummary.hardwareClassCounts.length) {
      console.log(
        "No HBOM hardware classes were found on the loaded BOM. Check whether the document includes cdx:hbom:hardwareClass properties.",
      );
      this.displayPrompt();
      return;
    }
    printAuditTable("HBOM hardware classes", [
      ["Hardware class", "Count"],
      ...hbomSummary.hardwareClassCounts.map(({ hardwareClass, count }) => [
        hardwareClass,
        `${count}`,
      ]),
    ]);
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("hbomevidence", {
  help: "show HBOM collector profile plus command and observed-file evidence",
  action() {
    const interactiveBom = getInteractiveBom();
    if (!interactiveBom) {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
      this.displayPrompt();
      return;
    }
    if (!isLikelyHbom(interactiveBom)) {
      console.log(
        "This BOM does not look like an HBOM. Import an HBOM generated with 'cdxgen -t hbom' to use this view.",
      );
      this.displayPrompt();
      return;
    }
    const hbomSummary = getHbomSummary(interactiveBom);
    printKeyValueTable("HBOM evidence overview", [
      ["Collector profile", hbomSummary.collectorProfile],
      ["Command evidence count", hbomSummary.evidenceCommandCount],
      ["Observed file count", hbomSummary.evidenceFileCount],
    ]);
    if (hbomSummary.evidenceCommands.length) {
      printAuditTable("HBOM command evidence", [
        ["Command #", "Evidence"],
        ...hbomSummary.evidenceCommands.map((command, index) => [
          `${index + 1}`,
          command,
        ]),
      ]);
    }
    if (hbomSummary.evidenceFiles.length) {
      printAuditTable("HBOM observed files", [
        ["File #", "Path"],
        ...hbomSummary.evidenceFiles.map((filePath, index) => [
          `${index + 1}`,
          filePath,
        ]),
      ]);
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("hbomdiagnostics", {
  help: "show parsed HBOM command diagnostics, issue counts, and install or privilege guidance",
  action() {
    const interactiveBom = getInteractiveHbomOrWarn(this);
    if (!interactiveBom) {
      return;
    }
    const hbomSummary = getHbomSummary(interactiveBom);
    if (!hbomSummary.commandDiagnosticCount) {
      console.log(
        "No HBOM command diagnostics were found. This usually means the collector completed without recording missing-command or permission-denied enrichments.",
      );
      this.displayPrompt();
      return;
    }
    printKeyValueTable("HBOM diagnostic overview", [
      ["Diagnostic count", hbomSummary.commandDiagnosticCount],
      ["Actionable diagnostics", hbomSummary.actionableDiagnosticCount],
      ["Missing commands", hbomSummary.missingCommandCount],
      ["Permission denied", hbomSummary.permissionDeniedCount],
      ["Partial support", hbomSummary.partialSupportCount],
      ["Timeouts", hbomSummary.timeoutCount],
      ["Other command errors", hbomSummary.commandErrorCount],
      ["Diagnostic issues", hbomSummary.diagnosticIssues.join(", ")],
      ["Missing command IDs", hbomSummary.missingCommandIds.join(", ")],
      ["Permission-denied IDs", hbomSummary.permissionDeniedIds.join(", ")],
      ["Install hint count", hbomSummary.installHintCount],
      ["Privilege hint count", hbomSummary.privilegeHintCount],
      [
        "Requires privileged rerun",
        hbomSummary.requiresPrivilegedEnrichment ? "yes" : "no",
      ],
    ]);
    printAuditTable("HBOM command diagnostics", [
      ["Issue", "Diagnostic ID", "Command", "Hint / Message"],
      ...hbomSummary.commandDiagnostics.map((diagnostic) => [
        diagnostic.issue || "unknown",
        diagnostic.id || "-",
        diagnostic.command || "-",
        getDiagnosticDisplayDetail(diagnostic),
      ]),
    ]);
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("hbomfirmware", {
  help: "show firmware, board, TPM, and update-managed HBOM components plus host firmware provenance",
  action() {
    const interactiveBom = getInteractiveHbomOrWarn(this);
    if (!interactiveBom) {
      return;
    }
    const metadataComponent = interactiveBom.metadata?.component;
    const firmwareComponents = filterHbomComponentsByProperties(
      interactiveBom,
      HBOM_FIRMWARE_PROPERTIES,
      ["firmware", "board", "tpm"],
    );
    const metadataEntries = [
      [
        "Board vendor",
        getPropertyValue(metadataComponent, "cdx:hbom:boardVendor"),
      ],
      ["Board name", getPropertyValue(metadataComponent, "cdx:hbom:boardName")],
      [
        "BIOS vendor",
        getPropertyValue(metadataComponent, "cdx:hbom:biosVendor"),
      ],
      [
        "BIOS version",
        getPropertyValue(metadataComponent, "cdx:hbom:biosVersion"),
      ],
      [
        "Firmware date",
        getPropertyValue(metadataComponent, "cdx:hbom:firmwareDate"),
      ],
      [
        "Device-tree revision",
        getPropertyValue(metadataComponent, "cdx:hbom:deviceTreeRevision"),
      ],
    ];
    const hasMetadataProvenance = metadataEntries.some(([, value]) =>
      Boolean(value),
    );
    if (!firmwareComponents.length && !hasMetadataProvenance) {
      console.log(
        "No focused firmware or board provenance pivots were found. Import an HBOM from a host that exposes board, TPM, or firmware-management metadata to use this view.",
      );
      this.displayPrompt();
      return;
    }
    if (hasMetadataProvenance) {
      printKeyValueTable("HBOM host firmware provenance", metadataEntries);
    }
    if (firmwareComponents.length) {
      printTable(
        { components: firmwareComponents, dependencies: [] },
        undefined,
        undefined,
        `Found ${firmwareComponents.length} firmware, board, TPM, or update-managed component(s).`,
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("hbombuses", {
  help: "show bus, connector, USB, PCI, and external-expansion HBOM components with security or topology metadata",
  action() {
    const interactiveBom = getInteractiveHbomOrWarn(this);
    if (!interactiveBom) {
      return;
    }
    const busComponents = filterHbomComponentsByProperties(
      interactiveBom,
      HBOM_BUS_SECURITY_PROPERTIES,
      [
        "bus",
        "usb-device",
        "pci-device",
        "display-adapter",
        "display-connector",
      ],
    );
    if (!busComponents.length) {
      console.log(
        "No bus or connector components with focused security or topology metadata were found.",
      );
      this.displayPrompt();
      return;
    }
    printTable(
      { components: busComponents, dependencies: [] },
      undefined,
      undefined,
      `Found ${busComponents.length} bus, USB, PCI, or display-link component(s) with bus-security or topology pivots.`,
    );
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("hbompower", {
  help: "show HBOM power and battery components with detailed design-capacity and runtime telemetry",
  action() {
    const interactiveBom = getInteractiveHbomOrWarn(this);
    if (!interactiveBom) {
      return;
    }
    const powerComponents = filterHbomComponentsByProperties(
      interactiveBom,
      HBOM_POWER_PROPERTIES,
      ["power"],
    );
    if (!powerComponents.length) {
      console.log(
        "No focused power or battery telemetry components were found on the loaded HBOM.",
      );
      this.displayPrompt();
      return;
    }
    printTable(
      { components: powerComponents, dependencies: [] },
      undefined,
      undefined,
      `Found ${powerComponents.length} power or battery component(s) with detailed runtime telemetry.`,
    );
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("exit", {
  help: "exit",
  action() {
    this.close();
  },
});
cdxgenRepl.defineCommand("sbom", {
  help: "show the current sbom",
  action() {
    if (sbom) {
      console.log(sbom);
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("search", {
  help: "search the current bom. performs case insensitive search on various attributes.",
  async action(searchStr) {
    if (sbom) {
      if (searchStr) {
        try {
          let fixedSearchStr = searchStr.replaceAll("/", "\\/");
          let dependenciesSearchStr = fixedSearchStr;
          if (!fixedSearchStr.includes("~>")) {
            dependenciesSearchStr = `dependencies[ref ~> /${fixedSearchStr}/i or dependsOn ~> /${fixedSearchStr}/i or provides ~> /${fixedSearchStr}/i]`;
            fixedSearchStr = `components[group ~> /${fixedSearchStr}/i or name ~> /${fixedSearchStr}/i or description ~> /${fixedSearchStr}/i or publisher ~> /${fixedSearchStr}/i or purl ~> /${fixedSearchStr}/i or tags ~> /${fixedSearchStr}/i]`;
          }
          const expression = jsonata(fixedSearchStr);
          const bomForSearch = searchStr.includes("~>")
            ? sbom
            : getInteractiveBom();
          let components = await expression.evaluate(bomForSearch);
          const dexpression = jsonata(dependenciesSearchStr);
          let dependencies = await dexpression.evaluate(bomForSearch);
          if (components && !Array.isArray(components)) {
            components = [components];
          }
          if (dependencies && !Array.isArray(dependencies)) {
            dependencies = [dependencies];
          }
          if (!components) {
            console.log("No results found!");
          } else {
            printTable({ components, dependencies }, undefined, searchStr);
            if (dependencies?.length) {
              printDependencyTree(
                { components, dependencies },
                "dependsOn",
                searchStr,
              );
            }
          }
        } catch (e) {
          console.log(e);
        }
      } else {
        console.log('⚠ Specify the search string. Eg: .search "search string"');
      }
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("sort", {
  help: "sort the current bom based on the attribute",
  async action(sortStr) {
    if (sbom) {
      if (sortStr) {
        try {
          if (!sortStr.includes("^")) {
            sortStr = `components^(${sortStr})`;
          }
          const expression = jsonata(sortStr);
          const components = await expression.evaluate(sbom);
          if (!components) {
            console.log("No results found!");
          } else {
            printTable({ components, dependencies: [] });
            // Store the sorted list in memory
            if (components.length === sbom.components.length) {
              sbom.components = components;
            }
          }
        } catch (e) {
          console.log(e);
        }
      } else {
        console.log("⚠ Specify the attribute to sort by. Eg: .sort name");
      }
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("query", {
  help: "query the current bom using jsonata expression",
  async action(querySpec) {
    if (sbom) {
      if (querySpec) {
        try {
          const expression = jsonata(querySpec);
          console.log(await expression.evaluate(sbom));
        } catch (e) {
          console.log(e);
        }
      } else {
        console.log(
          "⚠ Specify the search specification in jsonata format. Eg: .query metadata.component",
        );
      }
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("print", {
  help: "print the current bom as a table",
  action() {
    const interactiveBom = getInteractiveBom();
    if (interactiveBom) {
      printTable(interactiveBom);
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("trusted", {
  help: "print components with trusted publishing",
  action() {
    const interactiveBom = getInteractiveBom();
    if (interactiveBom?.components) {
      const trustedComponents = getTrustedComponents(interactiveBom.components);
      if (!trustedComponents.length) {
        console.log(
          "No trusted-publishing components found. Look for components enriched with cdx:npm:trustedPublishing or cdx:pypi:trustedPublishing.",
        );
      } else {
        printTable(
          { components: trustedComponents, dependencies: [] },
          undefined,
          undefined,
          `Found ${trustedComponents.length} trusted component(s) backed by trusted publishing metadata.`,
        );
      }
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("provenance", {
  help: "print components with direct registry provenance evidence",
  action() {
    const interactiveBom = getInteractiveBom();
    if (interactiveBom?.components) {
      const provenanceComponents = getProvenanceComponents(
        interactiveBom.components,
      );
      if (!provenanceComponents.length) {
        console.log(
          "No provenance-backed components found. Look for registry URLs, digests, signatures, or key IDs captured as component properties.",
        );
      } else {
        printTable(
          { components: provenanceComponents, dependencies: [] },
          undefined,
          undefined,
          `Found ${provenanceComponents.length} component(s) with direct registry provenance evidence.`,
        );
      }
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("cryptos", {
  help: "print the components of type cryptographic-asset as a table",
  action() {
    if (sbom) {
      printTable(sbom, ["cryptographic-asset"]);
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("sourcecryptos", {
  help: "show source-derived cryptographic assets detected from JS AST analysis",
  action() {
    const interactiveBom = getInteractiveBom();
    if (!interactiveBom?.components) {
      console.log("⚠ No BOM is loaded. Use .import command to import an SBOM");
      this.displayPrompt();
      return;
    }
    const sourceCryptoComponents = getSourceDerivedCryptoComponents(
      interactiveBom.components,
    );
    if (!sourceCryptoComponents.length) {
      console.log(
        "No source-derived crypto assets found. Generate a CBOM or SBOM with source crypto analysis to use this view.",
      );
      this.displayPrompt();
      return;
    }
    printTable(
      { components: sourceCryptoComponents, dependencies: [] },
      ["cryptographic-asset"],
      undefined,
      `Found ${sourceCryptoComponents.length} source-derived cryptographic asset component(s).`,
    );
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("unpackagedbins", {
  help: "show executable file components that were not matched to OS package ownership",
  action() {
    const interactiveBom = getInteractiveBom();
    if (!interactiveBom?.components) {
      console.log("⚠ No BOM is loaded. Use .import command to import an SBOM");
      this.displayPrompt();
      return;
    }
    const unpackagedExecutables = getUnpackagedExecutableComponents(
      interactiveBom.components,
    );
    if (!unpackagedExecutables.length) {
      console.log(
        "No unpackaged executable file components found. Import a container or rootfs BOM with native file inventory to use this view.",
      );
      this.displayPrompt();
      return;
    }
    printTable(
      { components: unpackagedExecutables, dependencies: [] },
      ["file"],
      undefined,
      `Found ${unpackagedExecutables.length} executable file component(s) that were not traced to OS package ownership.`,
    );
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("unpackagedlibs", {
  help: "show shared library file components that were not matched to OS package ownership",
  action() {
    const interactiveBom = getInteractiveBom();
    if (!interactiveBom?.components) {
      console.log("⚠ No BOM is loaded. Use .import command to import an SBOM");
      this.displayPrompt();
      return;
    }
    const unpackagedSharedLibraries = getUnpackagedSharedLibraryComponents(
      interactiveBom.components,
    );
    if (!unpackagedSharedLibraries.length) {
      console.log(
        "No unpackaged shared library file components found. Import a container or rootfs BOM with native file inventory to use this view.",
      );
      this.displayPrompt();
      return;
    }
    printTable(
      { components: unpackagedSharedLibraries, dependencies: [] },
      ["file"],
      undefined,
      `Found ${unpackagedSharedLibraries.length} shared library file component(s) that were not traced to OS package ownership.`,
    );
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("frameworks", {
  help: "print the components of type framework as a table",
  action() {
    if (sbom) {
      printTable(sbom, ["framework"]);
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("tree", {
  help: "display the dependency tree",
  action() {
    const interactiveBom = getInteractiveBom();
    if (interactiveBom) {
      printDependencyTree(interactiveBom);
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("provides", {
  help: "display the provides tree",
  action() {
    const interactiveBom = getInteractiveBom();
    if (interactiveBom) {
      printDependencyTree(interactiveBom, "provides");
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("validate", {
  help: "validate the bom using jsonschema",
  action() {
    if (sbom) {
      const result = validateBom(sbom);
      if (result) {
        console.log("BOM is valid!");
      }
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("save", {
  help: "save the bom to a new file",
  action(saveToFile) {
    if (sbom) {
      if (!saveToFile) {
        saveToFile = "bom.json";
      }
      if (isDryRun) {
        console.log(
          `⚠ Dry run mode blocks saving the BOM to ${saveToFile}. Disable --dry-run or CDXGEN_DRY_RUN to persist it.`,
        );
        this.displayPrompt();
        return;
      }
      safeWriteSync(saveToFile, JSON.stringify(sbom, null, 2));
      console.log(`BOM saved successfully to ${saveToFile}`);
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("update", {
  help: "update the bom components based on the given query",
  async action(updateSpec) {
    if (sbom) {
      if (!updateSpec) {
        return;
      }
      if (!updateSpec.startsWith("|")) {
        updateSpec = `|${updateSpec}`;
      }
      if (!updateSpec.endsWith("|")) {
        updateSpec = `${updateSpec}|`;
      }
      updateSpec = `$ ~> ${updateSpec}`;
      const expression = jsonata(updateSpec);
      const newSbom = await expression.evaluate(sbom);
      if (newSbom && newSbom.components.length <= sbom.components.length) {
        sbom = newSbom;
      }
      console.log("BOM updated successfully.");
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an existing BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("occurrences", {
  help: "view components with evidence.occurrences",
  async action() {
    if (sbom) {
      try {
        const expression = jsonata(
          "components[$count(evidence.occurrences) > 0]",
        );
        let components = await expression.evaluate(sbom);
        if (!components) {
          console.log(
            "No results found. Use evinse command to generate an BOM with evidence.",
          );
        } else {
          if (!Array.isArray(components)) {
            components = [components];
          }
          printOccurrences({ components });
        }
      } catch (e) {
        console.log(e);
      }
    } else {
      console.log(
        "⚠ No BOM is loaded. Use .import command to import an evinse BOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("callstack", {
  help: "view components with evidence.callstack",
  async action() {
    if (sbom) {
      try {
        const expression = jsonata(
          "components[$count(evidence.callstack.frames) > 0]",
        );
        let components = await expression.evaluate(sbom);
        if (!components) {
          console.log(
            "callstack evidence was not found. Use evinse command to generate an SBOM with evidence.",
          );
        } else {
          if (!Array.isArray(components)) {
            components = [components];
          }
          printCallStack({ components });
        }
      } catch (e) {
        console.log(e);
      }
    } else {
      console.log(
        "⚠ No SBOM is loaded. Use .import command to import an evinse SBOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("services", {
  help: "view services",
  async action() {
    if (sbom) {
      try {
        const expression = jsonata("services");
        let services = await expression.evaluate(sbom);
        if (!services) {
          console.log(
            "No services found. Use evinse command to generate a SaaSBOM with evidence.",
          );
        } else {
          if (!Array.isArray(services)) {
            services = [services];
          }
          printServices({ services });
        }
      } catch (e) {
        console.log(e);
      }
    } else {
      console.log(
        "⚠ No SaaSBOM is loaded. Use .import command to import a SaaSBOM",
      );
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("vulnerabilities", {
  help: "view vulnerabilities",
  async action() {
    if (sbom) {
      try {
        const expression = jsonata("vulnerabilities");
        let vulnerabilities = await expression.evaluate(sbom);
        if (!vulnerabilities) {
          console.log(
            "No vulnerabilities found. Use depscan to generate a VDR file with vulnerabilities.",
          );
        } else {
          if (!Array.isArray(vulnerabilities)) {
            vulnerabilities = [vulnerabilities];
          }
          printVulnerabilities(vulnerabilities);
        }
      } catch (e) {
        console.log(e);
      }
    } else {
      console.log("⚠ No BOM is loaded. Use .import command to import a VDR");
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("formulation", {
  help: "view formulation",
  async action() {
    if (sbom) {
      try {
        const expression = jsonata("formulation");
        let formulation = await expression.evaluate(sbom);
        if (!formulation) {
          console.log(
            "No formulation found. Pass the argument --include-formulation to generate SBOM with formulation details.",
          );
        } else {
          if (!Array.isArray(formulation)) {
            formulation = [formulation];
          }
          printFormulation({ formulation });
        }
      } catch (e) {
        console.log(e);
      }
    } else {
      console.log("⚠ No SBOM is loaded. Use .import command to import an SBOM");
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("cargohotspots", {
  help: "show Cargo package components with high-signal source, workspace, or build metadata",
  action() {
    const interactiveBom = getInteractiveBom();
    if (!interactiveBom?.components) {
      console.log("⚠ No BOM is loaded. Use .import command to import an SBOM");
      this.displayPrompt();
      return;
    }
    const cargoComponents = getCargoHotspotComponents(interactiveBom);
    if (!cargoComponents.length) {
      console.log(
        "No Cargo hotspot components found. Look for Cargo BOMs enriched with manifest, registry, or workspace metadata.",
      );
      this.displayPrompt();
      return;
    }
    printTable(
      { components: cargoComponents, dependencies: [] },
      undefined,
      undefined,
      `Found ${cargoComponents.length} Cargo component(s) with high-signal source, workspace, or build metadata.`,
    );
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("cargoworkflows", {
  help: "show Cargo-native build formulation plus Cargo-related workflow actions and run steps",
  action() {
    const interactiveBom = getInteractiveBom();
    if (!interactiveBom) {
      console.log("⚠ No BOM is loaded. Use .import command to import an SBOM");
      this.displayPrompt();
      return;
    }
    const cargoWorkflowComponents = getCargoWorkflowComponents(interactiveBom);
    const cargoFormulation = getCargoFormulationEntries(interactiveBom);
    if (!cargoWorkflowComponents.length && !cargoFormulation.length) {
      console.log(
        "No Cargo workflow or formulation pivots found. Import an SBOM generated with --include-formulation for Cargo projects.",
      );
      this.displayPrompt();
      return;
    }
    if (cargoWorkflowComponents.length) {
      printTable(
        { components: cargoWorkflowComponents, dependencies: [] },
        undefined,
        undefined,
        `Found ${cargoWorkflowComponents.length} Cargo-related workflow component(s).`,
      );
    }
    if (cargoFormulation.length) {
      printFormulation({ formulation: cargoFormulation });
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("auditfindings", {
  help: "summarize cdx-audit and bom-audit annotations from the loaded BOM",
  action() {
    if (!sbom) {
      console.log("⚠ No BOM is loaded. Use .import command to import an SBOM");
      this.displayPrompt();
      return;
    }
    const auditAnnotations = getAuditAnnotations();
    if (!auditAnnotations.length) {
      console.log(
        "No audit annotations found. Generate an SBOM with --bom-audit or import a BOM enriched by cdx-audit.",
      );
      this.displayPrompt();
      return;
    }
    const rows = [
      ["Engine", "Severity", "Rule", "Target / Edge", "Next action"],
    ];
    auditAnnotations.forEach((annotation) => {
      const props = annotation.properties;
      rows.push([
        props["cdx:audit:engine"] || "bom-audit",
        props["cdx:audit:severity"] || "unknown",
        props["cdx:audit:topFinding:ruleId"] ||
          props["cdx:audit:ruleId"] ||
          "-",
        props["cdx:audit:dispatch:edge"] ||
          props["cdx:audit:target:purl"] ||
          props["cdx:audit:location:file"] ||
          annotation.firstLine,
        props["cdx:audit:nextAction"] ||
          props["cdx:audit:upstreamGuidance"] ||
          props["cdx:audit:mitigation"] ||
          "-",
      ]);
    });
    printAuditTable("Audit findings", rows);
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("auditactions", {
  help: "list next actions from predictive audit annotations",
  action() {
    if (!sbom) {
      console.log("⚠ No BOM is loaded. Use .import command to import an SBOM");
      this.displayPrompt();
      return;
    }
    const auditAnnotations = getAuditAnnotations().filter(
      (annotation) => annotation.properties["cdx:audit:nextAction"],
    );
    if (!auditAnnotations.length) {
      console.log(
        "No predictive next actions found. Import a BOM annotated by cdx-audit to review remediation guidance.",
      );
      this.displayPrompt();
      return;
    }
    const rows = [["Severity", "Target", "Next action", "Upstream guidance"]];
    auditAnnotations.forEach((annotation) => {
      const props = annotation.properties;
      rows.push([
        props["cdx:audit:severity"] || "unknown",
        props["cdx:audit:dispatch:edge"] ||
          props["cdx:audit:target:purl"] ||
          annotation.firstLine,
        props["cdx:audit:nextAction"] || "-",
        props["cdx:audit:upstreamGuidance"] || "-",
      ]);
    });
    printAuditTable("Predictive audit actions", rows);
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("dispatchedges", {
  help: "show local sender to receiver workflow edges captured by predictive audit",
  action() {
    if (!sbom) {
      console.log("⚠ No BOM is loaded. Use .import command to import an SBOM");
      this.displayPrompt();
      return;
    }
    const auditAnnotations = getAuditAnnotations().filter(
      (annotation) => annotation.properties["cdx:audit:dispatch:edge"],
    );
    if (!auditAnnotations.length) {
      console.log(
        "No local dispatch edges found. Import a BOM annotated by cdx-audit with correlated workflow dispatch findings.",
      );
      this.displayPrompt();
      return;
    }
    const rows = [["Severity", "Rule", "Sender -> Receiver", "Receiver files"]];
    auditAnnotations.forEach((annotation) => {
      const props = annotation.properties;
      rows.push([
        props["cdx:audit:severity"] || "unknown",
        props["cdx:audit:topFinding:ruleId"] || "-",
        props["cdx:audit:dispatch:edge"] || annotation.firstLine,
        props["cdx:audit:dispatch:receiverFiles"] || "-",
      ]);
    });
    printAuditTable("Predictive workflow dispatch edges", rows);
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("osinfocategories", {
  help: "view the category names for the OS info from the obom",
  async action() {
    if (sbom) {
      try {
        const expression = jsonata(
          '$distinct(components.properties[name="cdx:osquery:category"].value)',
        );
        const catgories = await expression.evaluate(sbom);
        if (!catgories) {
          console.log(
            "Unable to retrieve the os info categories. Only OBOMs generated by cdxgen are supported by this tool.",
          );
        } else {
          console.log(catgories.join("\n"));
        }
      } catch (e) {
        console.log(e);
      }
    } else {
      console.log("⚠ No OBOM is loaded. Use .import command to import an OBOM");
    }
    this.displayPrompt();
  },
});
// OBOM-specific analyst helper tips for SOC/IR and compliance workflows.
cdxgenRepl.defineCommand("obomtips", {
  help: "show analyst tips and useful commands for OBOM investigations",
  action() {
    console.log("OBOM analyst quick guide:");
    console.log("1. .osinfocategories");
    console.log(
      "2. Run an OS-query category command from .help (examples below)",
    );
    console.log("   .processes");
    console.log("   .services_snapshot");
    console.log("   .scheduled_tasks");
    console.log("   .startup_items");
    console.log("3. .inspect <name>");
    console.log("4. .services / .print / .summary for quick pivots");
    console.log(
      "Tip: Generate with --bom-audit --bom-audit-categories obom-runtime for prioritized findings.",
    );
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("hbomtips", {
  help: "show analyst tips and useful commands for HBOM investigations",
  action() {
    console.log("HBOM analyst quick guide:");
    console.log("1. .hbomsummary");
    console.log("2. .hbomclasses");
    console.log("3. .hbomevidence");
    console.log("4. .hbomdiagnostics");
    console.log("5. .hbomfirmware / .hbombuses / .hbompower");
    console.log(
      "6. .auditfindings to review hbom-security, hbom-performance, and hbom-compliance findings",
    );
    console.log("7. .search <hardwareClass or device name>");
    console.log(
      'Tip: .query components[properties[name="cdx:hbom:hardwareClass" and value="storage"]] filters directly by hardware class.',
    );
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("licenses", {
  help: "visualize license distribution",
  async action() {
    if (!sbom?.components) {
      console.log("⚠ No SBOM loaded.");
      this.displayPrompt();
      return;
    }
    const licenseCounts = {};
    let unknown = 0;
    sbom.components.forEach((c) => {
      if (c.licenses && c.licenses.length > 0) {
        c.licenses.forEach((l) => {
          const name = l.license?.id || l.license?.name || "Unknown";
          licenseCounts[name] = (licenseCounts[name] || 0) + 1;
        });
      } else {
        unknown++;
      }
    });
    if (unknown > 0) licenseCounts["None/Unknown"] = unknown;
    const sorted = Object.entries(licenseCounts).sort((a, b) => b[1] - a[1]);
    const maxVal = sorted[0][1];
    const maxBarLength = 40;
    console.log("\n📊 License Distribution:\n");
    sorted.forEach(([license, count]) => {
      const barLen = Math.ceil((count / maxVal) * maxBarLength);
      const bar = "█".repeat(barLen);
      let icon = "✅";
      if (["GPL", "AGPL"].some((r) => license.includes(r))) icon = "⚖️ ";
      if (license === "None/Unknown") icon = "❓";
      console.log(`${icon} ${license.padEnd(60)} | ${bar} (${count})`);
    });
    console.log("");
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("inspect", {
  help: "view full JSON details of a component: .inspect <name_search_string>",
  async action(nameStr) {
    if (!nameStr) {
      console.log(
        "⚠ Specify a component name or purl fragment. Eg: .inspect lodash",
      );
      this.displayPrompt();
      return;
    }
    if (sbom?.components) {
      const found = sbom.components.find(
        (c) =>
          c.name.toLowerCase().includes(nameStr.toLowerCase()) ||
          c.purl?.includes(nameStr),
      );
      if (found) {
        console.log(JSON.stringify(found, null, 2));
      } else {
        console.log("❌ Component not found.");
      }
    }
    this.displayPrompt();
  },
});
cdxgenRepl.defineCommand("tagcloud", {
  help: "generate a text/tag cloud based on component descriptions and tags",
  action() {
    if (!sbom?.components) {
      console.log("⚠ No SBOM loaded.");
      this.displayPrompt();
      return;
    }
    const stopWords = new Set([
      "the",
      "and",
      "for",
      "with",
      "that",
      "this",
      "from",
      "are",
      "can",
      "use",
      "library",
      "framework",
      "package",
      "component",
      "module",
      "application",
      "software",
      "tool",
      "version",
      "implementation",
      "support",
      "based",
      "provided",
      "provides",
      "using",
      "api",
      "interface",
      "data",
      "system",
      "http",
      "https",
      "com",
      "org",
      "net",
      "git",
      "source",
      "code",
      "file",
      "project",
      "open",
      "free",
      "web",
      "runtime",
      "client",
      "server",
      "utils",
    ]);
    const wordCounts = new Map();
    const addWord = (w) => {
      if (!w) return;
      const clean = w.toLowerCase().replace(/[^a-z0-9-]/g, "");
      if (clean.length > 2 && !stopWords.has(clean) && Number.isNaN(clean)) {
        wordCounts.set(clean, (wordCounts.get(clean) || 0) + 1);
      }
    };
    sbom.components.forEach((c) => {
      if (c.tags) {
        c.tags.forEach((t) => {
          addWord(t);
          addWord(t);
        });
      }
      if (c.description) {
        c.description.split(/\s+/).forEach(addWord);
      }
      if (c.group) {
        addWord(c.group);
      }
    });
    if (wordCounts.size === 0) {
      console.log("⚠ Not enough text data found in Description or Tags.");
      this.displayPrompt();
      return;
    }
    let sortedWords = Array.from(wordCounts.entries()).sort(
      (a, b) => b[1] - a[1],
    );
    sortedWords = sortedWords.slice(0, 100);
    const maxCount = sortedWords[0][1];
    const minCount = sortedWords[sortedWords.length - 1][1];
    const styles = {
      tier1: (str) => `\x1b[1;35m${str.toUpperCase()}\x1b[0m`,
      tier2: (str) => `\x1b[1;36m${str}\x1b[0m`,
      tier3: (str) => `\x1b[32m${str}\x1b[0m`,
      tier4: (str) => `\x1b[2m${str}\x1b[0m`,
    };
    const cloudNodes = sortedWords.map(([word, count]) => {
      const score = (count - minCount) / (maxCount - minCount || 1);
      let styledWord = "";
      if (score > 0.7) styledWord = styles.tier1(word);
      else if (score > 0.4) styledWord = styles.tier2(word);
      else if (score > 0.1) styledWord = styles.tier3(word);
      else styledWord = styles.tier4(word);
      return styledWord;
    });
    for (let i = cloudNodes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cloudNodes[i], cloudNodes[j]] = [cloudNodes[j], cloudNodes[i]];
    }
    console.log("\n☁️  Word Cloud\n");
    const terminalWidth = process.stdout.columns || 80;
    let currentLine = "";
    cloudNodes.forEach((node) => {
      const visualLength = node.replace(/[[0-9;]*m/g, "").length + 1;
      if (currentLine.length + visualLength > terminalWidth) {
        console.log(currentLine);
        currentLine = "";
      }
      currentLine += `${node} `;
    });
    console.log(currentLine);
    console.log("\n");
    this.displayPrompt();
  },
});
// Let's dynamically define more commands from the queries
[
  "apt_sources",
  "behavioral_reverse_shell",
  "certificates",
  "chrome_extensions",
  "crontab_snapshot",
  "deb_packages",
  "docker_container_ports",
  "docker_containers",
  "docker_networks",
  "docker_volumes",
  "etc_hosts",
  "firefox_addons",
  "gatekeeper",
  "vscode_extensions",
  "homebrew_packages",
  "installed_applications",
  "interface_addresses",
  "kernel_info",
  "kernel_integrity",
  "kernel_modules",
  "ld_preload",
  "elevated_processes",
  "listening_ports",
  "os_version",
  "pipes",
  "pipes_snapshot",
  "portage_packages",
  "process_events",
  "processes",
  "secureboot_certificates",
  "privilege_transitions",
  "privileged_listening_ports",
  "npm_packages",
  "python_packages",
  "rpm_packages",
  "scheduled_tasks",
  "services_snapshot",
  "startup_items",
  "sudo_executions",
  "system_info_snapshot",
  "windows_drivers",
  "windows_patches",
  "windows_programs",
  "windows_shared_resources",
  "yum_sources",
  "appcompat_shims",
  "browser_plugins",
  "certificates",
  "chocolatey_packages",
  "chrome_extensions",
  "etc_hosts",
  "firefox_addons",
  "ie_extensions",
  "kernel_info",
  "npm_packages",
  "opera_extensions",
  "pipes_snapshot",
  "process_open_handles_snapshot",
  "process_open_sockets",
  "safari_extensions",
  "scheduled_tasks",
  "services_snapshot",
  "startup_items",
  "routes",
  "system_info_snapshot",
  "win_version",
  "windows_firewall_rules",
  "windows_optional_features",
  "windows_programs",
  "windows_shared_resources",
  "windows_update_history",
  "wmi_cli_event_consumers",
  "wmi_cli_event_consumers_snapshot",
  "wmi_event_filters",
  "wmi_filter_consumer_binding",
].forEach((c) => {
  cdxgenRepl.defineCommand(c, {
    help: `query the ${c} category from the OS info`,
    async action() {
      if (sbom) {
        try {
          const expression = jsonata(
            `components[properties[name="cdx:osquery:category" and value="${c}"]]`,
          );
          let components = await expression.evaluate(sbom);
          if (!components) {
            console.log("No results found.");
          } else {
            if (!Array.isArray(components)) {
              components = [components];
            }
            printOSTable({ components });
          }
        } catch (e) {
          console.log(e);
        }
      } else {
        console.log(
          "⚠ No OBOM is loaded. Use .import command to import an OBOM",
        );
      }
      this.displayPrompt();
    },
  });
});
