#!/usr/bin/env node
// Evinse (Evinse Verification Is Nearly SBOM Evidence)

import fs from "node:fs";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  analyzeProject,
  createEvinseFile,
  prepareDB,
} from "../lib/evinser/evinser.js";
import {
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
} from "../lib/helpers/bomUtils.js";
import {
  printCallStack,
  printOccurrences,
  printReachables,
  printServices,
} from "../lib/helpers/display.js";
import { safeExistsSync } from "../lib/helpers/utils.js";
import { validateBom } from "../lib/validator/bomValidator.js";

const args = yargs(hideBin(process.argv))
  .env("EVINSE")
  .option("input", {
    alias: "i",
    description: "Input SBOM file. Default bom.json",
    default: "bom.json",
  })
  .option("output", {
    alias: "o",
    description: "Output file. Default bom.evinse.json",
    default: "bom.evinse.json",
  })
  .option("language", {
    alias: "l",
    description: "Application language",
    default: "java",
    choices: [
      "java",
      "jar",
      "js",
      "ts",
      "javascript",
      "nodejs",
      "py",
      "python",
      "android",
      "go",
      "golang",
      "rust",
      "rs",
      "rust-lang",
      "csharp",
      "cs",
      "c",
      "cpp",
      "dotnet",
      "php",
      "swift",
      "ios",
      "ruby",
      "scala",
      "vb",
      "vbnet",
      "visualbasic",
      "f#",
      "fs",
      "fsharp",
    ],
  })
  .option("profile", {
    description:
      "Evidence profile. The research profile enables data-flow and crypto analysis where supported.",
    default: "generic",
    choices: ["generic", "research"],
  })
  .option("deep", {
    description:
      "Enable deeper evidence collection. For Go, this enables Golem data-flow with performance safeguards so crypto flows can be captured.",
    default: false,
    type: "boolean",
  })
  .option("golem-command", {
    description: "Use a specific golem binary for Go Evinse analysis.",
    default: process.env.GOLEM_CMD,
  })
  .option("golem-callgraph", {
    description: "Golem call graph mode for Go Evinse analysis.",
    choices: ["none", "static", "cha", "rta", "vta"],
    default: "static",
  })
  .option("golem-dataflow", {
    description:
      "Golem data-flow mode for Go Evinse analysis. Defaults to all with --with-data-flow, research profile, or --deep, and none otherwise.",
    choices: ["none", "security", "crypto", "all"],
    default: "all",
  })
  .option("golem-dataflow-callgraph", {
    description:
      "Golem call graph mode used only for data-flow dynamic summary replay.",
    default: "static",
    choices: ["none", "static", "cha", "rta", "vta"],
  })
  .option("golem-dataflow-patterns", {
    description: "Custom Golem data-flow pattern JSON file.",
  })
  .option("golem-dataflow-pattern-packs", {
    description:
      "Comma-separated Golem data-flow pattern packs: all, base, http, frameworks, data, filesystem, process, crypto, native, config, cloud.",
  })
  .option("golem-dataflow-max-slices", {
    description: "Maximum Golem data-flow slices to emit.",
    type: "number",
  })
  .option("golem-dataflow-workers", {
    description:
      "Golem data-flow worker count. Defaults to a capped CPU count for predictable performance.",
    type: "number",
  })
  .option("golem-dataflow-large-repo-functions", {
    description:
      "Function count at which Golem large-repo data-flow safeguards apply.",
    type: "number",
  })
  .option("golem-dataflow-max-function-instructions", {
    description:
      "Skip Golem per-function data-flow materialization above this SSA instruction count in large repos.",
    type: "number",
  })
  .option("golem-dataflow-max-trace-nodes", {
    description: "Maximum ordered Golem data-flow node IDs retained per trace.",
    type: "number",
  })
  .option("golem-dataflow-max-trace-edges", {
    description: "Maximum ordered Golem data-flow edge IDs retained per trace.",
    type: "number",
  })
  .option("golem-dataflow-skip-generated", {
    description: "Skip generated files during Golem data-flow analysis.",
    type: "boolean",
  })
  .option("golem-dataflow-skip-tests", {
    description:
      "Skip test/example/benchmark files during Golem data-flow analysis.",
    type: "boolean",
  })
  .option("golem-max-procs", {
    description:
      "Maximum Go scheduler threads for Golem. Defaults to a capped CPU count when data-flow is enabled.",
    type: "number",
  })
  .option("golem-memory-limit", {
    description: "Optional Golem Go soft memory limit such as 4GiB or 800MiB.",
  })
  .option("golem-progress", {
    description: "Emit coarse Golem progress logs to stderr during analysis.",
    default: false,
    type: "boolean",
  })
  .option("golem-patterns", {
    description: "Comma-separated go/packages patterns for golem.",
    default: "./...",
  })
  .option("golem-tags", {
    description: "Comma-separated Go build tags for golem.",
  })
  .option("golem-tests", {
    description: "Include Go test variants in golem analysis.",
    default: false,
    type: "boolean",
  })
  .option("rusi-command", {
    description: "Use a specific rusi binary for Rust Evinse analysis.",
    default: process.env.RUSI_CMD,
  })
  .option("rusi-mode", {
    description: "Rusi analysis mode.",
    choices: ["analyze", "cryptos"],
    default: "analyze",
  })
  .option("rusi-backend", {
    description: "Rusi analysis backend.",
    choices: ["stable", "compiler"],
    default: "stable",
  })
  .option("rusi-toolchain", {
    description:
      "Rust toolchain for the Rusi compiler backend (e.g., auto, nightly, stable).",
    default: "auto",
  })
  .option("rusi-callgraph", {
    description: "Rusi call graph mode.",
    choices: ["none", "static"],
    default: "static",
  })
  .option("rusi-dataflow", {
    description:
      "Rusi data-flow mode. Defaults to security with --with-data-flow, research profile, or --deep, and none otherwise.",
    choices: ["none", "security", "security-deps"],
  })
  .option("rusi-patterns", {
    description: "Custom Rusi data-flow pattern JSON file.",
  })
  .option("db-path", {
    description: "Atom slices DB path. Unused",
    default: undefined,
    hidden: true,
  })
  .option("force", {
    description: "Force creation of the database",
    default: false,
    type: "boolean",
  })
  .option("skip-maven-collector", {
    description:
      "Skip collecting jars from maven and gradle caches. Can speedup re-runs if the data was cached previously.",
    default: false,
    type: "boolean",
  })
  .option("with-deep-jar-collector", {
    description:
      "Enable collection of all jars from maven cache directory. Useful to improve the recall for callstack evidence.",
    default: false,
    type: "boolean",
  })
  .option("annotate", {
    description: "Include contents of atom slices as annotations",
    default: false,
    type: "boolean",
  })
  .option("with-data-flow", {
    description: "Enable inter-procedural data-flow slicing.",
    default: false,
    type: "boolean",
  })
  .option("with-reachables", {
    description:
      "Enable auto-tagged reachable slicing. Requires SBOM generated with --deep mode.",
    default: false,
    type: "boolean",
  })
  .option("exclude", {
    alias: "exclude-regex",
    description:
      "Additional glob pattern(s) to ignore during Atom evidence generation.",
    nargs: 1,
    type: "array",
  })
  .option("usages-slices-file", {
    description: "Use an existing usages slices file.",
    default: "usages.slices.json",
  })
  .option("data-flow-slices-file", {
    description: "Use an existing data-flow slices file.",
    default: "data-flow.slices.json",
  })
  .option("reachables-slices-file", {
    description: "Use an existing reachables slices file.",
    default: "reachables.slices.json",
  })
  .option("semantics-slices-file", {
    description: "Use an existing semantics slices file.",
    default: "semantics.slices.json",
  })
  .option("openapi-spec-file", {
    description: "Use an existing openapi specification file (SaaSBOM).",
    default: "openapi.json",
  })
  .option("print", {
    alias: "p",
    type: "boolean",
    description: "Print the evidences as table",
  })
  .example([
    [
      "$0 -i bom.json -o bom.evinse.json -l java .",
      "Generate a Java SBOM with evidence for the current directory",
    ],
    [
      "$0 -i bom.json -o bom.evinse.json -l java --with-reachables .",
      "Generate a Java SBOM with occurrence and reachable evidence for the current directory",
    ],
    [
      "$0 -i bom.json -o bom.evinse.json -l rust --with-data-flow --rusi-backend compiler .",
      "Generate a Rust SBOM with Rusi data-flow and compiler-backed evidence",
    ],
  ])
  .completion("completion", "Generate bash/zsh completion")
  .epilogue("for documentation, visit https://cdxgen.github.io/cdxgen")
  .scriptName("evinse")
  .version()
  .help("h")
  .alias("h", "help")
  .wrap(Math.min(120, yargs().terminalWidth())).argv;

const evinseArt = `
███████╗██╗   ██╗██╗███╗   ██╗███████╗███████╗
██╔════╝██║   ██║██║████╗  ██║██╔════╝██╔════╝
█████╗  ██║   ██║██║██╔██╗ ██║███████╗█████╗
██╔══╝  ╚██╗ ██╔╝██║██║╚██╗██║╚════██║██╔══╝
███████╗ ╚████╔╝ ██║██║ ╚████║███████║███████╗
╚══════╝  ╚═══╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝
`;

if (process.env?.CDXGEN_NODE_OPTIONS) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} ${process.env.CDXGEN_NODE_OPTIONS}`;
}

console.log(evinseArt);
function ensureCycloneDxInput(inputFile) {
  if (!safeExistsSync(inputFile)) {
    return;
  }
  let bomJson;
  try {
    bomJson = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  } catch (error) {
    console.error(`Unable to parse '${inputFile}' as JSON: ${error.message}`);
    process.exit(1);
  }
  if (!isCycloneDxBom(bomJson)) {
    console.error(getNonCycloneDxErrorMessage(bomJson, "evinse"));
    process.exit(1);
  }
}
ensureCycloneDxInput(args.input);
(async () => {
  // First, prepare the database by cataloging jars and other libraries
  const dbObjMap = await prepareDB(args);
  if (dbObjMap) {
    // Analyze the project using atom. Convert package namespaces to purl using the db
    const sliceArtefacts = await analyzeProject(dbObjMap, args);
    // Create the SBOM with Evidence
    const bomJson = createEvinseFile(sliceArtefacts, args);
    // Validate our final SBOM
    if (!validateBom(bomJson)) {
      process.exit(1);
    }
    if (args.print) {
      printOccurrences(bomJson);
      printCallStack(bomJson);
      printReachables(sliceArtefacts);
      printServices(bomJson);
    }
  }
})();
