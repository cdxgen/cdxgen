#!/usr/bin/env node

import fs from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
} from "../lib/helpers/bomUtils.js";
import { deriveSpdxOutputPath } from "../lib/helpers/exportUtils.js";
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

let bomJson;
try {
  bomJson = JSON.parse(fs.readFileSync(args.input, "utf8"));
} catch (error) {
  console.error(`Failed to parse '${args.input}' as JSON: ${error.message}`);
  process.exit(1);
}

if (!isCycloneDxBom(bomJson)) {
  console.error(getNonCycloneDxErrorMessage(bomJson, "cdx-convert"));
  process.exit(1);
}
const cdxSpecVersion = Number.parseFloat(`${bomJson?.specVersion || ""}`);
if (![1.6, 1.7].includes(cdxSpecVersion)) {
  console.error(
    `Unsupported CycloneDX specVersion '${bomJson?.specVersion}'. cdx-convert currently supports CycloneDX 1.6 or 1.7 input and exports SPDX 3.0.1.`,
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
