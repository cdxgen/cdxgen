#!/usr/bin/env node
// Evinse (Evinse Verification Is Nearly SBOM Evidence)

import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  analyzeProject,
  createEvinseFile,
  prepareDB,
} from "../lib/evinser/evinser.js";
import {
  printCallStack,
  printOccurrences,
  printReachables,
  printServices,
} from "../lib/helpers/display.js";
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
      "c",
      "cpp",
      "php",
      "swift",
      "ios",
      "ruby",
      "scala",
    ],
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
