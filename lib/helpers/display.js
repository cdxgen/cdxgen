import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

import { createStream, table } from "table";

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
  if (highlight && s && s.includes(highlight)) {
    s = s.replaceAll(highlight, `\x1b[1;33m${highlight}\x1b[0m`);
  }
  return s;
};
export function printTable(
  bomJson,
  filterTypes = undefined,
  highlight = undefined,
) {
  if (!bomJson || !bomJson.components) {
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
  console.log();
}
export function printServices(bomJson) {
  const data = [["Name", "Endpoints", "Authenticated", "X Trust Boundary"]];
  if (!bomJson || !bomJson.services) {
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

export function printFormulation(bomJson) {
  const data = [["Tyoe", "Name", "Version"]];
  if (!bomJson || !bomJson.formulation) {
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

export function printOccurrences(bomJson) {
  if (!bomJson || !bomJson.components) {
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
  console.log();
}

export function printCallStack(bomJson) {
  const data = [["Group", "Name", "Version", "Call Stack"]];
  if (!bomJson || !bomJson.components) {
    return;
  }
  for (const comp of bomJson.components) {
    if (
      !comp.evidence ||
      !comp.evidence.callstack ||
      !comp.evidence.callstack.frames
    ) {
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

export function printReachables(sliceArtefacts) {
  const reachablesSlicesFile = sliceArtefacts.reachablesSlicesFile;
  if (!existsSync(reachablesSlicesFile)) {
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
      "OWASP foundation relies on donations to fund our projects.\nDonation link: https://owasp.org/donate/?reponame=www-project-cyclonedx&title=OWASP+CycloneDX";
    if (options.serverUrl && options.apiKey) {
      message = `${message}\nDependency Track: https://owasp.org/donate/?reponame=www-project-dependency-track&title=OWASP+Dependency-Track`;
    }
    const data = [[message]];
    console.log(table(data, config));
  }
}

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
