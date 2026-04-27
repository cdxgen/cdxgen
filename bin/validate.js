#!/usr/bin/env node

/**
 * cdx-validate CLI — structural, deep, and compliance validation for
 * CycloneDX SBOMs.
 *
 * Exit codes:
 *   0 — all checks pass (or no findings >= --fail-severity).
 *   1 — configuration error (bad input, missing file, unknown reporter).
 *   2 — schema validation failed (in --strict mode).
 *   3 — compliance findings at or above --fail-severity.
 *   4 — signature verification was requested and failed.
 */

import fs from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
} from "../lib/helpers/bomUtils.js";
import {
  dirNameStr,
  retrieveCdxgenVersion,
  safeExistsSync,
  safeMkdirSync,
} from "../lib/helpers/utils.js";
import { getBomWithOras } from "../lib/managers/oci.js";
import { shouldFail, validateBomAdvanced } from "../lib/validator/index.js";
import { render as renderReport } from "../lib/validator/reporters/index.js";

const _yargs = yargs(hideBin(process.argv));

const args = _yargs
  .option("input", {
    alias: "i",
    default: "bom.json",
    description: "Input SBOM JSON file or OCI reference.",
  })
  .option("platform", {
    description:
      "Platform to use when resolving an OCI reference (passed to oras).",
  })
  .option("report", {
    alias: "r",
    default: "console",
    choices: ["console", "json", "sarif", "annotations"],
    description: "Output format.",
  })
  .option("report-file", {
    alias: "o",
    description:
      "Write the report to this file. Defaults to stdout. Required for the 'annotations' reporter when you want to save the annotated BOM.",
  })
  .option("schema", {
    type: "boolean",
    default: true,
    description:
      "Run the CycloneDX JSON-schema validation. Pass --no-schema to skip.",
  })
  .option("deep", {
    type: "boolean",
    default: true,
    description:
      "Run the deep purl/ref/metadata checks from lib/helpers/bomValidator.js. Pass --no-deep to skip.",
  })
  .option("benchmark", {
    alias: "b",
    type: "string",
    description:
      "Comma-separated list of compliance benchmark aliases to include in the scorecards (scvs, scvs-l1, scvs-l2, scvs-l3, cra). Defaults to all.",
  })
  .option("categories", {
    type: "string",
    description:
      "Comma-separated list of compliance rule categories to evaluate (compliance-scvs, compliance-cra). Defaults to all.",
  })
  .option("min-severity", {
    type: "string",
    default: "info",
    choices: ["info", "low", "medium", "high", "critical"],
    description:
      "Drop findings below this severity from the output (benchmark scoring is unaffected).",
  })
  .option("fail-severity", {
    type: "string",
    default: "high",
    choices: ["info", "low", "medium", "high", "critical"],
    description:
      "Exit with code 3 when any failing finding is at or above this severity.",
  })
  .option("include-manual", {
    type: "boolean",
    default: true,
    description:
      "Include non-automatable manual-review findings in the output. Pass --no-include-manual to hide them.",
  })
  .option("include-pass", {
    type: "boolean",
    default: false,
    description:
      "Include passing findings in the output (useful for audits). Defaults to false.",
  })
  .option("public-key", {
    description:
      "Path to a PEM public key. When set, cdx-validate also verifies the BOM signature.",
  })
  .option("require-signature", {
    type: "boolean",
    default: false,
    description:
      "Exit non-zero (4) when --public-key is provided but signature verification fails.",
  })
  .option("strict", {
    type: "boolean",
    default: false,
    description:
      "Treat a failing schema or deep validation as a non-zero exit (code 2).",
  })
  .completion("completion", "Generate bash/zsh completion")
  .epilogue("for documentation, visit https://cdxgen.github.io/cdxgen")
  .scriptName("cdx-validate")
  .version(retrieveCdxgenVersion())
  .help()
  .wrap(Math.min(120, yargs().terminalWidth())).argv;

function loadBom(input, platform) {
  if (safeExistsSync(input)) {
    try {
      return JSON.parse(fs.readFileSync(input, "utf8"));
    } catch (err) {
      console.error(`Failed to parse ${input}: ${err.message}`);
      process.exit(1);
    }
  }
  if (
    input.includes(":") ||
    input.includes("docker") ||
    input.includes("ghcr")
  ) {
    const bom = getBomWithOras(input, platform);
    if (bom) return bom;
  }
  console.error(`Input '${input}' is not a readable SBOM.`);
  process.exit(1);
  return undefined;
}

function loadPublicKey(path) {
  if (!path) return null;
  if (!safeExistsSync(path)) {
    console.error(`Public key '${path}' not found.`);
    process.exit(1);
  }
  return fs.readFileSync(path, "utf8");
}

function splitCsv(value) {
  if (!value) return undefined;
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function writeOrPrint(content, outputPath) {
  if (!outputPath) {
    process.stdout.write(`${content}\n`);
    return;
  }
  const parent = dirname(outputPath);
  if (parent && !safeExistsSync(parent)) {
    safeMkdirSync(parent, { recursive: true });
  }
  fs.writeFileSync(outputPath, content);
}

const bomJson = loadBom(args.input, args.platform);
const publicKeyStr = loadPublicKey(args.publicKey);
if (!isCycloneDxBom(bomJson)) {
  console.error(getNonCycloneDxErrorMessage(bomJson, "cdx-validate"));
  process.exit(1);
}

const report = validateBomAdvanced(bomJson, {
  schema: args.schema,
  deep: args.deep,
  benchmarks: splitCsv(args.benchmark),
  categories: splitCsv(args.categories),
  minSeverity: args.minSeverity,
  includeManual: args.includeManual,
  includePass: args.includePass,
  publicKey: publicKeyStr || undefined,
});

let output;
try {
  const { version: pkgVersion } = JSON.parse(
    fs.readFileSync(join(dirNameStr, "package.json"), "utf8"),
  );
  output = renderReport(args.report, report, {
    bomJson,
    toolName: "cdx-validate",
    toolVersion: pkgVersion,
    pretty: true,
  });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

writeOrPrint(output, args.reportFile);

const { shouldFail: fail, reason } = shouldFail(report, {
  failSeverity: args.failSeverity,
  strict: args.strict,
  requireSignature: Boolean(args.requireSignature && publicKeyStr),
});

if (report.signatureVerified === false && args.requireSignature) {
  console.error(
    `cdx-validate: signature verification failed — ${report.signatureDetails?.error || "no matching key"}.`,
  );
  process.exit(4);
}

if (args.strict && report.schemaValid === false) {
  console.error("cdx-validate: schema validation failed.");
  process.exit(2);
}

if (fail) {
  console.error(`cdx-validate: ${reason}`);
  process.exit(3);
}

process.exit(0);
