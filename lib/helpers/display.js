import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { createStream, table } from "./table.js";
import { isSecureMode, safeExistsSync, toCamel } from "./utils.js";

// https://github.com/yangshun/tree-node-cli/blob/master/src/index.js
const SYMBOLS_ANSI = {
  BRANCH: "├── ",
  EMPTY: "",
  INDENT: "  ",
  LAST_BRANCH: "└── ",
  VERTICAL: "│ ",
};

const MAX_TREE_DEPTH = 6;
const highlightStr = (s, highlight) => {
  if (highlight && s?.includes(highlight)) {
    s = s.replaceAll(highlight, `\x1b[1;33m${highlight}\x1b[0m`);
  }
  return s;
};
/**
 * Prints the BOM components as a streaming table to the console.
 * Delegates to {@link printOSTable} automatically when the BOM metadata indicates
 * an operating-system or platform component type.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @param {string[]} [filterTypes] Optional list of component types to include; all types shown when omitted
 * @param {string} [highlight] Optional string to highlight in the output
 * @returns {void}
 */
export function printTable(
  bomJson,
  filterTypes = undefined,
  highlight = undefined,
) {
  if (!bomJson?.components) {
    return;
  }
  if (
    bomJson.metadata?.component &&
    ["operating-system", "platform"].includes(bomJson.metadata.component.type)
  ) {
    return printOSTable(bomJson);
  }
  const config = {
    columnDefault: {
      width: 30,
    },
    columnCount: 5,
    columns: [
      { width: 25 },
      { width: 35 },
      { width: 25, alignment: "right" },
      { width: 15 },
      { width: 25 },
    ],
  };
  const stream = createStream(config);
  stream.write([
    filterTypes?.includes("cryptographic-asset")
      ? "Asset Type / Group"
      : "Group",
    "Name",
    filterTypes?.includes("cryptographic-asset") ? "Version / oid" : "Version",
    "Scope",
    "Tags",
  ]);
  for (const comp of bomJson.components) {
    if (filterTypes && !filterTypes.includes(comp.type)) {
      continue;
    }
    if (comp.type === "cryptographic-asset") {
      stream.write([
        comp.cryptoProperties?.assetType || comp.group || "",
        comp.name,
        `\x1b[1;35m${comp.cryptoProperties?.oid || ""}\x1b[0m`,
        comp.scope || "",
        (comp.tags || []).join(", "),
      ]);
    } else {
      stream.write([
        highlightStr(comp.group || "", highlight),
        highlightStr(comp.name, highlight),
        `\x1b[1;35m${comp.version || ""}\x1b[0m`,
        comp.scope || "",
        (comp.tags || []).join(", "),
      ]);
    }
  }
  stream.end();
  console.log();
  if (!filterTypes) {
    console.log(
      "BOM includes",
      bomJson?.components?.length || 0,
      "components and",
      bomJson?.dependencies?.length || 0,
      "dependencies",
    );
  } else {
    console.log(`Components filtered based on type: ${filterTypes.join(", ")}`);
  }
}
const formatProps = (props) => {
  const retList = [];
  for (const p of props) {
    retList.push(`\x1b[0;32m${p.name}\x1b[0m ${p.value}`);
  }
  return retList.join("\n");
};
/**
 * Prints OS package components from the BOM as a formatted streaming table.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printOSTable(bomJson) {
  const config = {
    columnDefault: {
      width: 50,
    },
    columnCount: 4,
    columns: [{ width: 20 }, { width: 40 }, { width: 50 }, { width: 25 }],
  };
  const stream = createStream(config);
  stream.write(["Type", "Title", "Properties", "Tags"]);
  for (const comp of bomJson.components) {
    stream.write([
      comp.type,
      `\x1b[1;35m${comp.name.replace(/\+/g, " ").replace(/--/g, "::")}\x1b[0m`,
      formatProps(comp.properties || []),
      (comp.tags || []).join(", "),
    ]);
  }
  stream.end();
  console.log();
}
/**
 * Prints the services listed in the BOM as a formatted table.
 * Includes endpoint URLs, authentication flag, and cross-trust-boundary flag.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printServices(bomJson) {
  const data = [["Name", "Endpoints", "Authenticated", "X Trust Boundary"]];
  if (!bomJson?.services) {
    return;
  }
  for (const aservice of bomJson.services) {
    data.push([
      aservice.name || "",
      aservice.endpoints ? aservice.endpoints.join("\n") : "",
      aservice.authenticated ? "\x1b[1;35mYes\x1b[0m" : "",
      aservice.xTrustBoundary ? "\x1b[1;35mYes\x1b[0m" : "",
    ]);
  }
  const config = {
    header: {
      alignment: "center",
      content: "List of Services\nGenerated with \u2665  by cdxgen",
    },
  };
  if (data.length > 1) {
    console.log(table(data, config));
  }
}

/**
 * Prints the formulation components from the BOM as a formatted table.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printFormulation(bomJson) {
  const data = [["Type", "Name", "Version"]];
  if (!bomJson?.formulation) {
    return;
  }
  for (const aform of bomJson.formulation) {
    if (aform.components) {
      for (const acomp of aform.components) {
        data.push([acomp.type || "", acomp.name || "", acomp.version || ""]);
      }
    }
  }
  const config = {
    header: {
      alignment: "center",
      content: "Formulation\nGenerated with \u2665  by cdxgen",
    },
  };
  if (data.length > 1) {
    console.log(table(data, config));
  }
}

const locationComparator = (a, b) => {
  if (a && b && a.includes("#") && b.includes("#")) {
    const tmpA = a.split("#");
    const tmpB = b.split("#");
    if (tmpA.length === 2 && tmpB.length === 2) {
      if (tmpA[0] === tmpB[0]) {
        return tmpA[1] - tmpB[1];
      }
    }
  }
  return a.localeCompare(b);
};

/**
 * Prints component evidence occurrences (file locations) as a streaming table.
 * Only components that have `evidence.occurrences` are included.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printOccurrences(bomJson) {
  if (!bomJson?.components) {
    return;
  }
  const data = ["Group", "Name", "Version", "Occurrences"];
  const config = {
    columnDefault: {
      width: 30,
    },
    columnCount: 4,
    columns: [
      { width: 30 },
      { width: 30 },
      { width: 25, alignment: "right" },
      { width: 80 },
    ],
  };
  const stream = createStream(config); // Create stream with the config
  const header = "Component Evidence\nGenerated with \u2665  by cdxgen";
  console.log(header);
  stream.write(data);
  // Stream the components
  for (const comp of bomJson.components) {
    if (comp.evidence?.occurrences) {
      const row = [
        comp.group || "",
        comp.name,
        comp.version || "",
        comp.evidence.occurrences
          .map((l) => l.location)
          .sort(locationComparator)
          .join("\n"),
      ];
      stream.write(row);
    }
  }
  stream.end();
  console.log();
}

/**
 * Prints the call stack evidence for each component in the BOM as a formatted table.
 * Only components that have `evidence.callstack.frames` are included.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printCallStack(bomJson) {
  const data = [["Group", "Name", "Version", "Call Stack"]];
  if (!bomJson?.components) {
    return;
  }
  for (const comp of bomJson.components) {
    if (!comp.evidence?.callstack?.frames) {
      continue;
    }
    const frames = Array.from(
      new Set(
        comp.evidence.callstack.frames.map(
          (c) => `${c.fullFilename}${c.line ? `#${c.line}` : ""}`,
        ),
      ),
    ).sort(locationComparator);
    const frameDisplay = [frames[0]];
    if (frames.length > 1) {
      for (let i = 1; i < frames.length - 1; i++) {
        frameDisplay.push(`${SYMBOLS_ANSI.BRANCH} ${frames[i]}`);
      }
      frameDisplay.push(
        `${SYMBOLS_ANSI.LAST_BRANCH} ${frames[frames.length - 1]}`,
      );
    }
    data.push([
      comp.group || "",
      comp.name,
      comp.version || "",
      frameDisplay.join("\n"),
    ]);
  }
  const config = {
    header: {
      alignment: "center",
      content:
        "Component Call Stack Evidence\nGenerated with \u2665  by cdxgen",
    },
  };
  if (data.length > 1) {
    console.log(table(data, config));
  }
}
/**
 * Prints the dependency tree from the BOM as an ASCII tree diagram.
 * Uses the `table` library for small trees and plain console output for larger ones.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object containing a `dependencies` array
 * @param {string} [mode="dependsOn"] Dependency relation to traverse (`"dependsOn"` or `"provides"`)
 * @param {string} [highlight] Optional string to highlight in the tree output
 * @returns {void}
 */
export function printDependencyTree(
  bomJson,
  mode = "dependsOn",
  highlight = undefined,
) {
  const dependencies = bomJson.dependencies || [];
  if (!dependencies.length) {
    return;
  }
  const depMap = {};
  const shownList = [];
  for (const d of dependencies) {
    if (d[mode]?.length) {
      depMap[d.ref] = d[mode].sort();
    } else {
      if (mode === "provides") {
        shownList.push(d.ref);
      }
    }
  }
  const treeGraphics = [];
  recursePrint(depMap, dependencies, 0, shownList, treeGraphics);
  // table library is too slow for display large lists.
  // Fixes #491
  if (treeGraphics.length && treeGraphics.length < 100) {
    const treeType =
      mode && mode === "provides" ? "Crypto Implementation" : "Dependency";
    const config = {
      header: {
        alignment: "center",
        content: `${treeType} Tree\nGenerated with \u2665  by cdxgen`,
      },
    };
    console.log(
      table([[highlightStr(treeGraphics.join("\n"), highlight)]], config),
    );
  } else if (treeGraphics.length < 500) {
    // https://github.com/nodejs/node/issues/35973
    console.log(highlightStr(treeGraphics.join("\n"), highlight));
  } else {
    console.log(highlightStr(treeGraphics.slice(0, 500).join("\n"), highlight));
  }
}

const levelPrefix = (level, isLast) => {
  if (level === 0) {
    return SYMBOLS_ANSI.EMPTY;
  }
  let prefix = `${isLast ? SYMBOLS_ANSI.LAST_BRANCH : SYMBOLS_ANSI.BRANCH}`;
  for (let i = 0; i < level - 1; i++) {
    prefix = `${
      isLast
        ? SYMBOLS_ANSI.LAST_BRANCH.replace(" ", "─")
        : SYMBOLS_ANSI.VERTICAL
    }${isLast ? "" : SYMBOLS_ANSI.INDENT}${prefix}`;
  }
  return prefix;
};

const isReallyRoot = (depMap, refStr) => {
  for (const k of Object.keys(depMap)) {
    const dependsOn = depMap[k] || [];
    if (
      dependsOn.includes(refStr) ||
      dependsOn.includes(refStr.toLowerCase())
    ) {
      return false;
    }
  }
  return true;
};

const recursePrint = (depMap, subtree, level, shownList, treeGraphics) => {
  const listToUse = Array.isArray(subtree) ? subtree : [subtree];
  for (let i = 0; i < listToUse.length; i++) {
    const l = listToUse[i];
    const refStr = l.ref || l;
    if (
      (level === 0 &&
        isReallyRoot(depMap, refStr) &&
        !shownList.includes(refStr.toLowerCase())) ||
      level > 0
    ) {
      treeGraphics.push(
        `${levelPrefix(level, i === listToUse.length - 1)}${refStr}`,
      );
      shownList.push(refStr.toLowerCase());
      if (l && depMap[refStr]) {
        if (level < MAX_TREE_DEPTH) {
          recursePrint(
            depMap,
            depMap[refStr],
            level + 1,
            shownList,
            treeGraphics,
          );
        }
      }
    }
  }
};

/**
 * Prints a table of reachable components derived from a reachability slices file.
 * Aggregates per-purl reachable-flow counts and sorts them descending.
 *
 * @param {Object} sliceArtefacts Slice artefact paths, must include `reachablesSlicesFile`
 * @returns {void}
 */
export function printReachables(sliceArtefacts) {
  const reachablesSlicesFile = sliceArtefacts.reachablesSlicesFile;
  if (!safeExistsSync(reachablesSlicesFile)) {
    return;
  }
  const purlCounts = {};
  const reachablesSlices = JSON.parse(
    readFileSync(reachablesSlicesFile, "utf-8"),
  );
  const rflows = Array.isArray(reachablesSlices)
    ? reachablesSlices
    : reachablesSlices.reachables || [];
  for (const areachable of rflows) {
    const purls = areachable.purls || [];
    for (const apurl of purls) {
      purlCounts[apurl] = (purlCounts[apurl] || 0) + 1;
    }
  }
  const sortedPurls = Object.fromEntries(
    Object.entries(purlCounts).sort(([, a], [, b]) => b - a),
  );
  const data = [["Package URL", "Reachable Flows"]];
  for (const apurl of Object.keys(sortedPurls)) {
    data.push([apurl, `${sortedPurls[apurl]}`]);
  }
  const config = {
    header: {
      alignment: "center",
      content: "Reachable Components\nGenerated with \u2665  by cdxgen",
    },
  };
  if (data.length > 1) {
    console.log(table(data, config));
  }
}

/**
 * Prints a formatted table of CycloneDX vulnerability objects.
 *
 * @param {Object[]} vulnerabilities Array of CycloneDX vulnerability objects
 * @returns {void}
 */
export function printVulnerabilities(vulnerabilities) {
  if (!vulnerabilities) {
    return;
  }
  const data = [["Ref", "Ratings", "State", "Justification"]];
  for (const avuln of vulnerabilities) {
    const arow = [
      avuln["bom-ref"],
      `${avuln?.ratings
        .map((r) => r?.severity?.toUpperCase())
        .join("\n")}\n${avuln?.ratings.map((r) => r?.score).join("\n")}`,
      avuln?.analysis?.state || "",
      avuln?.analysis?.justification || "",
    ];
    data.push(arow);
  }
  const config = {
    header: {
      alignment: "center",
      content: "Vulnerabilities\nGenerated with \u2665  by cdxgen",
    },
  };
  if (data.length > 1) {
    console.log(table(data, config));
  }
  console.log(`${vulnerabilities.length} vulnerabilities found.`);
}

/**
 * Prints an OWASP donation banner when running in a CI environment.
 * The banner is suppressed when `options.noBanner` is set or the repository
 * belongs to the cdxgen project itself.
 *
 * @param {Object} options CLI options
 * @returns {void}
 */
export function printSponsorBanner(options) {
  if (
    process?.env?.CI &&
    !options.noBanner &&
    !process.env?.GITHUB_REPOSITORY?.toLowerCase().startsWith("cdxgen")
  ) {
    const config = {
      header: {
        alignment: "center",
        content: "\u00A4 Donate to the OWASP Foundation",
      },
    };
    let message =
      "OWASP foundation relies on donations to fund our projects.\nDonation link: https://owasp.org/donate/?reponame=www-project-cdxgen&title=OWASP+cdxgen";
    if (options.serverUrl && options.apiKey) {
      message = `${message}\nDependency Track: https://owasp.org/donate/?reponame=www-project-dependency-track&title=OWASP+Dependency-Track`;
    }
    const data = [[message]];
    console.log(table(data, config));
  }
}

/**
 * Prints a BOM summary table including generator tool names, component package types,
 * and component namespaces extracted from BOM metadata properties.
 *
 * @param {Object} bomJson CycloneDX BOM JSON object
 * @returns {void}
 */
export function printSummary(bomJson) {
  const config = {
    header: {
      alignment: "center",
      content: "BOM summary",
    },
    columns: [{ wrapWord: true, width: 100 }],
  };
  const metadataProperties = bomJson?.metadata?.properties;
  if (!metadataProperties) {
    return;
  }
  let message = "";
  let bomPkgTypes = [];
  let bomPkgNamespaces = [];
  // Print any annotations found
  const annotations = bomJson?.annotations || [];
  if (annotations.length) {
    for (const annot of annotations) {
      message = `${message}\n${annot.text}`;
    }
  }
  const tools = bomJson?.metadata?.tools?.components;
  if (tools) {
    message = `${message}\n\n** Generator Tools **`;
    for (const atool of tools) {
      if (atool.name && atool.version) {
        message = `${message}\n${atool.name} (${atool.version})`;
      }
    }
  }
  for (const aprop of metadataProperties) {
    if (aprop.name === "cdx:bom:componentTypes") {
      bomPkgTypes = aprop?.value.split("\\n");
    }
    if (aprop.name === "cdx:bom:componentNamespaces") {
      bomPkgNamespaces = aprop?.value.split("\\n");
    }
  }
  if (!bomPkgTypes.length && !bomPkgNamespaces.length) {
    return;
  }
  message = `${message}\n\n** Package Types (${bomPkgTypes.length}) **\n${bomPkgTypes.join("\n")}`;
  if (bomPkgNamespaces.length) {
    message = `${message}\n\n** Namespaces (${bomPkgNamespaces.length}) **\n${bomPkgNamespaces.join("\n")}`;
  }
  const data = [[message]];
  console.log(table(data, config));
}

/**
 * @typedef {{type: string, variable: string, severity: string, message: string, mitigation: string}} EnvAuditFinding
 */

/**
 * Runs the pre-generation environment audit and renders the results as formatted
 * tables to the console. Called when the --env-audit CLI flag is set.
 *
 * @param {string} filePath Project path being scanned
 * @param {Object} config Loaded .cdxgenrc / config-file values
 * @param {Object} options Effective CLI options
 * @param {EnvAuditFinding[]} envAuditFindings Audit findings to display
 */
export function displaySelfThreatModel(
  filePath,
  config,
  options,
  envAuditFindings,
) {
  const TLP = options.tlpClassification || "CLEAR";
  const risks = [];
  let riskScore = 0;

  const addRisk = (level, reason, category = "configuration") => {
    const scores = { low: 1, medium: 3, high: 5, critical: 8 };
    riskScore = Math.min(10, riskScore + scores[level]);
    risks.push({ level, reason, category });
  };

  // Config file risks
  if (Object.keys(config).length > 0) {
    addRisk(
      "medium",
      "A .cdxgenrc config file was loaded from the working directory. It may override security-relevant settings without being visible on the command line.",
      "configuration",
    );
    const sensitive = ["server-url", "api-key", "include-formulation"];
    for (const key of sensitive) {
      if (config[key] || config[toCamel(key)]) {
        addRisk(
          key === "api-key" ? "high" : "medium",
          `Config file sets '${key}', which affects SBOM content or remote submission behavior.`,
          "configuration",
        );
      }
    }
  }

  // Remote submission risks
  if (options.serverUrl) {
    const isHttps = options.serverUrl.startsWith("https://");
    addRisk(
      isHttps ? "medium" : "critical",
      `SBOM will be submitted to ${options.serverUrl}${!isHttps ? " over plain HTTP — contents may be intercepted or tampered in transit." : "."}`,
      "network",
    );
    if (options.skipDtTlsCheck) {
      addRisk(
        "high",
        "TLS certificate validation is disabled for Dependency-Track uploads. SBOM contents may be intercepted or tampered in transit.",
        "network",
      );
    }
  }

  // Data exposure risks
  if (options.includeFormulation) {
    addRisk(
      "medium",
      "Formulation mode is active. The SBOM will include build metadata such as git history, committer identities, and CI environment variables.",
      "data-exposure",
    );
  }
  if (options.evidence || options.deep) {
    addRisk(
      "medium",
      "Evidence / deep mode will invoke build tools and parse source files to collect call graph and reachability evidence. Malicious build scripts may execute.",
      "data-exposure",
    );
  }
  if (options.installDeps) {
    addRisk(
      "high",
      "Dependency auto-install is enabled. Lifecycle hooks (install scripts) from third-party packages will execute in the current environment.",
      "data-exposure",
    );
  }

  // Output path outside the project directory
  if (options.output) {
    const resolvedOutput = path.resolve(options.output);
    const resolvedProject = path.resolve(filePath);
    if (
      !resolvedOutput.startsWith(resolvedProject + path.sep) &&
      resolvedOutput !== resolvedProject
    ) {
      addRisk(
        "medium",
        `Output path '${options.output}' resolves to '${resolvedOutput}', which is outside the project directory '${resolvedProject}'. Ensure this is intentional.`,
        "configuration",
      );
    }
  }

  // Environment variable risks (config-layer only; env-audit covers the rest)
  if (process.env.CDXGEN_SERVER_URL) {
    addRisk(
      "low",
      "CDXGEN_SERVER_URL is set in the environment and will override any --server-url value.",
      "environment",
    );
  }

  // Integrate environment audit findings
  if (envAuditFindings?.length) {
    for (const f of envAuditFindings) {
      const categoryMap = {
        "code-execution": "runtime",
        "debug-exposure": "runtime",
        "environment-variable": "environment",
        "network-interception": "network",
        "credential-exposure": "environment",
        "permission-misuse": "runtime",
        privilege: "runtime",
      };
      addRisk(
        f.severity,
        `${f.variable}: ${f.message}`,
        categoryMap[f.type] || "configuration",
      );
    }
  }

  const nodeOptions = process.env.NODE_OPTIONS || "";
  const riskLevel =
    riskScore >= 8
      ? "CRITICAL"
      : riskScore >= 5
        ? "HIGH"
        : riskScore >= 3
          ? "MEDIUM"
          : "LOW";

  const riskColor = {
    CRITICAL: "\x1b[1;31m",
    HIGH: "\x1b[1;33m",
    MEDIUM: "\x1b[1;36m",
    LOW: "\x1b[1;32m",
  };
  const reset = "\x1b[0m";
  const tlpGuidance = {
    CLEAR: "May be shared publicly. No restrictions.",
    GREEN: "Limited to community/peers. Not for public posting.",
    AMBER:
      "Limited to organisation and trusted partners. Handle-in-confidence.",
    AMBER_AND_STRICT: "Organisation only. No external sharing.",
    RED: "Named recipients only. Do not forward or store beyond session.",
  };
  const headerData = [
    ["TLP Classification", `${TLP} — ${tlpGuidance[TLP]}`],
    ["Risk Score", `${riskScore}/10`],
    ["Risk Level", `${riskColor[riskLevel]}${riskLevel}${reset}`],
  ];
  const headerConfig = {
    header: {
      alignment: "center",
      content:
        "SBOM Generation Environment Assessment\nPre-generation security audit by cdxgen",
    },
    columns: [{ width: 30, alignment: "right" }, { width: 70 }],
    columnDefault: { wrapWord: true },
  };

  console.log(table(headerData, headerConfig));
  if (risks.length > 0) {
    const findingsData = [["#", "Severity", "Category", "Finding"]];
    risks.forEach(({ level, reason, category }, i) => {
      const severityColor =
        level === "critical"
          ? "\x1b[1;31m"
          : level === "high"
            ? "\x1b[1;33m"
            : level === "medium"
              ? "\x1b[1;36m"
              : "\x1b[1;32m";
      findingsData.push([
        `${i + 1}`,
        `${severityColor}${level.toUpperCase()}${reset}`,
        category,
        reason,
      ]);
    });
    const findingsConfig = {
      header: {
        alignment: "center",
        content: `Findings (${risks.length})`,
      },
      columns: [
        { width: 5, alignment: "right" },
        { width: 12 },
        { width: 17 },
        { width: 66 },
      ],
      columnDefault: { wrapWord: true },
    };
    console.log(table(findingsData, findingsConfig));
  } else {
    const noFindingsData = [
      [
        `${riskColor[riskLevel]}✅ No risks detected in the current configuration.${reset}`,
      ],
    ];
    const noFindingsConfig = {
      header: { alignment: "center", content: "📋 Findings" },
      columns: [{ width: 100, alignment: "center" }],
    };
    console.log(table(noFindingsData, noFindingsConfig));
  }

  const configData = [
    ["Setting", "Value"],
    ["Project", options.projectName || filePath],
    ["Type(s)", options.projectType?.join(", ") || "auto-detect"],
    ["Profile", options.profile || "generic"],
    ["Path", filePath],
    ["Output", options.output || "(stdout)"],
    ["Recursive", options.recursive ? "yes" : "no"],
    ["Remote Submission", options.serverUrl || "none"],
    ["Formulation", options.includeFormulation ? "yes" : "no"],
    ["Evidence / Deep Mode", options.evidence || options.deep ? "yes" : "no"],
    ["Auto-install Dependencies", options.installDeps ? "yes" : "no"],
    ["NODE_OPTIONS", nodeOptions || "(not set)"],
  ];
  const effConfigTableConfig = {
    header: { alignment: "center", content: "Effective Configuration" },
    columns: [{ width: 28 }, { width: 72 }],
    columnDefault: { wrapWord: true },
  };
  console.log(table(configData, effConfigTableConfig));

  const recommendations = [];
  if (["AMBER", "AMBER_AND_STRICT", "RED"].includes(TLP)) {
    recommendations.push([
      "High",
      "Omit --include-formulation to avoid embedding committer identities and CI secrets in the SBOM.",
    ]);
    if (TLP === "RED") {
      recommendations.push([
        "Critical",
        "Run cdxgen inside an isolated container or VM with no access to production credentials.",
      ]);
      recommendations.push([
        "Critical",
        "Do not set --server-url; review and handle the output SBOM manually before sharing.",
      ]);
    }
  }
  if (riskScore >= 5) {
    recommendations.push([
      "High",
      "Address the findings above before scanning untrusted repositories.",
    ]);
    recommendations.push([
      "Medium",
      "Pass --no-install-deps to prevent package manager hooks from executing.",
    ]);
  }
  if (envAuditFindings.some((f) => f.type === "code-execution")) {
    recommendations.push([
      "High",
      "Remove code-execution flags (--require, --eval, --loader, --import) from NODE_OPTIONS and JAVA_TOOL_OPTIONS.",
    ]);
  }
  if (envAuditFindings.some((f) => f.variable === "NODE_PATH")) {
    recommendations.push([
      "High",
      "Unset NODE_PATH to prevent module-resolution poisoning by malicious packages.",
    ]);
  }
  if (envAuditFindings.some((f) => f.type === "privilege")) {
    recommendations.push([
      "High",
      "Do not run cdxgen as root. Create a dedicated low-privilege user or use a rootless container.",
    ]);
  }
  if (/--permission\b/i.test(nodeOptions)) {
    recommendations.push([
      "Medium",
      "Audit every --allow-* scope; use absolute paths rather than wildcards to minimise the permission surface.",
    ]);
  }
  recommendations.push([
    "Info",
    "Minimal safe invocation: cdxgen --no-install-deps --output ./sbom.cdx.json <path>",
  ]);
  const recommendationsData = [["Priority", "Action"]];
  recommendations.forEach(([priority, action]) => {
    const priorityColor =
      priority === "Critical"
        ? "\x1b[1;31m"
        : priority === "High"
          ? "\x1b[1;33m"
          : priority === "Medium"
            ? "\x1b[1;36m"
            : "\x1b[1;32m";
    recommendationsData.push([`${priorityColor}${priority}${reset}`, action]);
  });
  const recommendationsConfig = {
    header: {
      alignment: "center",
      content: `Recommendations for TLP:${TLP}`,
    },
    columns: [{ width: 12 }, { width: 88 }],
    columnDefault: { wrapWord: true },
  };

  console.log(table(recommendationsData, recommendationsConfig));
  // Only abort in secure mode when at least one finding is high or critical severity.
  // Accumulated low/medium findings may push riskScore above 5 but should not abort.
  if (
    isSecureMode &&
    envAuditFindings?.some((f) => ["high", "critical"].includes(f.severity))
  ) {
    const abortData = [
      [
        `${riskColor[riskLevel]}🚫 SECURE MODE: High-risk configuration detected. Aborting SBOM generation.${reset}`,
      ],
    ];
    const abortConfig = {
      columns: [{ width: 100, alignment: "center" }],
    };
    console.log(table(abortData, abortConfig));
    process.exit(1);
  }
}
