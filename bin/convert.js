#!/usr/bin/env node

import fs from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  deriveSpdxOutputPath,
  normalizeOutputFormats,
} from "../lib/helpers/exportUtils.js";
import {
  retrieveCdxgenVersion,
  safeExistsSync,
  safeMkdirSync,
} from "../lib/helpers/utils.js";
import { convertCycloneDxToSpdx } from "../lib/stages/postgen/spdxConverter.js";
import { validateSpdx } from "../lib/validator/bomValidator.js";

const _yargs = yargs(hideBin(process.argv));

const args = _yargs
  .option("input", {
    alias: "i",
    default: "bom.json",
    description: "Input CycloneDX BOM JSON file.",
  })
  .option("output", {
    alias: "o",
    description: "Output SPDX JSON file. Defaults to <input>.spdx.json.",
  })
  .option("from", {
    default: "cyclonedx",
    description: "Input format. Supports cyclonedx/cdx aliases.",
  })
  .option("to", {
    default: "spdx",
    description: "Output format. Supports spdx aliases.",
  })
  .option("validate", {
    type: "boolean",
    default: true,
    description:
      "Validate the generated SPDX export. Pass --no-validate to skip.",
  })
  .option("json-pretty", {
    type: "boolean",
    default: false,
    description: "Pretty-print generated JSON output.",
  })
  .completion("completion", "Generate bash/zsh completion")
  .epilogue("for documentation, visit https://cdxgen.github.io/cdxgen")
  .scriptName("cdx-convert")
  .version(retrieveCdxgenVersion())
  .help()
  .wrap(Math.min(120, yargs().terminalWidth())).argv;

if (!safeExistsSync(args.input)) {
  console.error(`Input file '${args.input}' not found.`);
  process.exit(1);
}

const inputFormats = normalizeOutputFormats(args.from);
if (!inputFormats.length || !inputFormats.includes("cyclonedx")) {
  console.error(
    `Unsupported input format '${args.from}'. Use 'cyclonedx' or 'cdx'.`,
  );
  process.exit(1);
}

const outputFormats = normalizeOutputFormats(args.to);
if (!outputFormats.length || !outputFormats.includes("spdx")) {
  console.error(
    `Unsupported output format '${args.to}'. Use 'spdx', 'spdx-json', 'spdx3', or 'spdx3-json'.`,
  );
  process.exit(1);
}

let bomJson;
try {
  bomJson = JSON.parse(fs.readFileSync(args.input, "utf8"));
} catch (error) {
  console.error(`Failed to parse '${args.input}' as JSON: ${error.message}`);
  process.exit(1);
}

if (bomJson?.bomFormat !== "CycloneDX") {
  console.error(
    "Input must be a CycloneDX JSON BOM (missing or invalid bomFormat).",
  );
  process.exit(1);
}

const spdxJson = convertCycloneDxToSpdx(bomJson, args);
if (!spdxJson) {
  console.error("Conversion failed: unable to generate SPDX output.");
  process.exit(1);
}

if (args.validate && !validateSpdx(spdxJson)) {
  console.error("SPDX validation failed for the converted output.");
  process.exit(1);
}

const outputPath = args.output || deriveSpdxOutputPath(args.input);
const outputParent = dirname(outputPath);
if (outputParent && outputParent !== "." && !safeExistsSync(outputParent)) {
  safeMkdirSync(outputParent, { recursive: true });
}

fs.writeFileSync(
  outputPath,
  JSON.stringify(spdxJson, null, args.jsonPretty ? 2 : null),
);
console.log(`Successfully converted '${args.input}' to '${outputPath}'.`);
