#!/usr/bin/env node

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import repl from "node:repl";

import jsonata from "jsonata";

import { createBom } from "../lib/cli/index.js";
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
import { readBinary } from "../lib/helpers/protobom.js";
import { getTmpDir } from "../lib/helpers/utils.js";
import { validateBom } from "../lib/helpers/validator.js";
import { getBomWithOras } from "../lib/managers/oci.js";

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

if (process.env?.CDXGEN_NODE_OPTIONS) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} ${process.env.CDXGEN_NODE_OPTIONS}`;
}

// The current sbom is stored here
let sbom;

let historyFile;
const historyConfigDir = join(homedir(), ".config", ".cdxgen");
if (!process.env.CDXGEN_REPL_HISTORY && !fs.existsSync(historyConfigDir)) {
  try {
    fs.mkdirSync(historyConfigDir, { recursive: true });
    historyFile = join(historyConfigDir, ".repl_history");
  } catch (_e) {
    // ignore
  }
} else {
  historyFile = join(historyConfigDir, ".repl_history");
}

export const importSbom = (sbomOrPath) => {
  if (sbomOrPath?.endsWith(".json") && fs.existsSync(sbomOrPath)) {
    try {
      sbom = JSON.parse(fs.readFileSync(sbomOrPath, "utf-8"));
      let bomType = "SBOM";
      if (sbom?.vulnerabilities && Array.isArray(sbom.vulnerabilities)) {
        bomType = "VDR";
      }
      console.log(`✅ ${bomType} imported successfully from ${sbomOrPath}`);
      printSummary(sbom);
    } catch (e) {
      console.log(`⚠ Unable to import the BOM from ${sbomOrPath} due to ${e}`);
    }
  } else if (
    (sbomOrPath?.endsWith(".cdx") || sbomOrPath?.endsWith(".proto")) &&
    fs.existsSync(sbomOrPath)
  ) {
    sbom = readBinary(sbomOrPath, true);
    printSummary(sbom);
  } else if (
    sbomOrPath.startsWith("ghcr.io") ||
    sbomOrPath.startsWith("docker.io")
  ) {
    try {
      sbom = getBomWithOras(sbomOrPath);
      if (sbom) {
        printSummary(sbom);
      } else {
        console.log(
          `cyclonedx sbom attachment was not found within ${sbomOrPath}`,
        );
      }
    } catch (e) {
      console.log(`⚠ Unable to import the BOM from ${sbomOrPath} due to ${e}`);
    }
  } else {
    console.log(`⚠ ${sbomOrPath} is invalid.`);
  }
};
// Load any sbom passed from the command line
if (process.argv.length > 2) {
  importSbom(process.argv[process.argv.length - 1]);
  console.log("💭 Type .print to view the BOM as a table");
} else if (fs.existsSync("bom.json")) {
  // If the current directory has a bom.json load it
  importSbom("bom.json");
} else {
  console.log("💭 Use .create <path> to create an SBOM for the given path.");
  console.log("💭 Use .import <json> to import an existing BOM.");
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
    const tempDir = fs.mkdtempSync(join(getTmpDir(), "cdxgen-repl-"));
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
          let components = await expression.evaluate(sbom);
          const dexpression = jsonata(dependenciesSearchStr);
          let dependencies = await dexpression.evaluate(sbom);
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
        console.log("⚠ Specify the search string. Eg: .search <search string>");
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
    if (sbom) {
      printTable(sbom);
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
    if (sbom) {
      printDependencyTree(sbom);
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
    if (sbom) {
      printDependencyTree(sbom, "provides");
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
      fs.writeFileSync(saveToFile, JSON.stringify(sbom, null, null));
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
cdxgenRepl.defineCommand("licenses", {
  help: "visualize license distribution",
  async action() {
    if (!sbom || !sbom.components) {
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
    if (!sbom || !sbom.components) {
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
  "vscode_extensions",
  "homebrew_packages",
  "installed_applications",
  "interface_addresses",
  "kernel_info",
  "kernel_integrity",
  "kernel_modules",
  "ld_preload",
  "listening_ports",
  "os_version",
  "pipes",
  "pipes_snapshot",
  "portage_packages",
  "process_events",
  "processes",
  "python_packages",
  "rpm_packages",
  "scheduled_tasks",
  "services_snapshot",
  "startup_items",
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
