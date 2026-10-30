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

import { installConsoleShim, restoreConsole } from "../lib/core/ui.js";
import {
  dirNameStr,
  retrieveCdxgenVersion,
  safeExistsSync,
  safeMkdirSync,
  safeWriteSync,
} from "../lib/ecosystems/utils.js";
import { displayValue } from "../lib/helpers/bomSigner.js";
import {
  getNonCycloneDxErrorMessage,
  isCycloneDxBom,
} from "../lib/inventory/bomUtils.js";
import {
  importProtobomModule,
  isProtoBomPath,
} from "../lib/inventory/protobomLoader.js";
import { getBomWithOras } from "../lib/managers/oci.js";
import { parseStrictJson } from "../lib/parsers/strictJson.js";
import { shouldFail, validateBomAdvanced } from "../lib/validator/index.js";
import { render as renderReport } from "../lib/validator/reporters/index.js";

const _yargs = yargs(hideBin(process.argv));

const args = _yargs
  .option("input", {
    alias: "i",
    default: "bom.json",
    description: "Input SBOM JSON or protobuf file, or an OCI reference.",
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
      "Run the deep purl/ref/metadata checks from lib/validator/bomValidator.js. Pass --no-deep to skip.",
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
  .option("secret-key", {
    description:
      "Path to the shared secret for HMAC (HS256, HS384, HS512) signatures. HMAC signatures are only accepted with this option.",
  })
  .option("nested-signatures", {
    type: "boolean",
    default: true,
    description:
      "Also verify component, service, and annotation signatures, as cdx-verify does. Pass --no-nested-signatures to verify only the root signature.",
  })
  .option("require-signature", {
    type: "boolean",
    description:
      "Exit non-zero (4) when signature verification fails. On by default when --public-key or --secret-key is given; pass --no-require-signature to only report the result.",
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

// stdout carries the report and nothing else; messages from the validators
// go to the diagnostic stream so `-r json` and `-r sarif` stay parseable.
installConsoleShim();
process.once("exit", restoreConsole);

/**
 * Loads the BOM. When signatures are verified, the text must also pass
 * parseStrictJson(), and `strictError` explains why it did not.
 */
async function loadBom(input, platform, strict, requireSignature) {
  if (safeExistsSync(input)) {
    try {
      if (isProtoBomPath(input)) {
        const { readBinary } = await importProtobomModule(
          "cdx-validate",
          "protobuf BOM input",
        );
        return { bomJson: readBinary(input, true) };
      }
      const bytes = fs.readFileSync(input);
      const bomJson = JSON.parse(bytes.toString("utf8"));
      if (strict) {
        try {
          parseStrictJson(bytes);
        } catch (err) {
          return { bomJson, strictError: err.message };
        }
      }
      return { bomJson };
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
    let strictError;
    try {
      const bom = await getBomWithOras(
        input,
        platform,
        strict ? { checkBytes: parseStrictJson } : {},
      );
      if (bom) return { bomJson: bom };
    } catch (err) {
      if (requireSignature) {
        console.error(
          `cdx-validate: signature verification failed — the attached BOM cannot be verified: ${err.message}`,
        );
        process.exit(4);
      }
      strictError = err.message;
    }
    if (strictError) {
      const bom = await getBomWithOras(input, platform);
      if (bom) return { bomJson: bom, strictError };
    }
  }
  console.error(`Input '${input}' is not a readable SBOM.`);
  process.exit(1);
  return undefined;
}

function loadKeyFile(path, label, encoding) {
  if (path === undefined) return null;
  if (typeof path !== "string" || !path.trim()) {
    console.error(`cdx-validate: ${label} needs exactly one file path.`);
    process.exit(1);
  }
  if (!safeExistsSync(path)) {
    console.error(`${label} '${path}' not found.`);
    process.exit(1);
  }
  const content = fs.readFileSync(path, encoding);
  if (!content.toString().trim()) {
    console.error(`${label} '${path}' is empty.`);
    process.exit(1);
  }
  return content;
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
  safeWriteSync(outputPath, content);
}

function isLocalProtoBomInput(input) {
  if (!safeExistsSync(input)) {
    return false;
  }
  return isProtoBomPath(input);
}

const keyGiven = args.publicKey !== undefined || args.secretKey !== undefined;
const requireSignature = args.requireSignature ?? keyGiven;
const { bomJson, strictError } = await loadBom(
  args.input,
  args.platform,
  keyGiven,
  requireSignature,
);
if (args.publicKey !== undefined && args.secretKey !== undefined) {
  console.error("cdx-validate: use either --public-key or --secret-key.");
  process.exit(1);
}
const publicKeyStr = loadKeyFile(args.publicKey, "Public key", "utf8");
const secretKey = loadKeyFile(args.secretKey, "Shared secret");
const verificationRequested = keyGiven;
const inputIsLocalProtoBom = isLocalProtoBomInput(args.input);
if (!isCycloneDxBom(bomJson)) {
  console.error(getNonCycloneDxErrorMessage(bomJson, "cdx-validate"));
  process.exit(1);
}

if (inputIsLocalProtoBom && verificationRequested) {
  console.error(
    "cdx-validate: protobuf BOM input does not currently preserve JSF signature blocks. Verify signatures against the source JSON BOM instead.",
  );
  process.exit(requireSignature ? 4 : 1);
}

const report = await validateBomAdvanced(bomJson, {
  schema: args.schema,
  deep: args.deep,
  benchmarks: splitCsv(args.benchmark),
  categories: splitCsv(args.categories),
  minSeverity: args.minSeverity,
  includeManual: args.includeManual,
  includePass: args.includePass,
  publicKey: publicKeyStr ?? undefined,
  secretKey: secretKey ?? undefined,
  nestedSignatures: args.nestedSignatures,
});
if (strictError && verificationRequested) {
  report.signatureVerified = false;
  report.signatureEntries = null;
  report.signatureDetails = {
    error: `the BOM cannot be verified: ${strictError}`,
  };
}

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

for (const e of report.validationErrors || []) {
  console.error(`cdx-validate: ${e.stage} validation threw: ${e.message}`);
}

const { shouldFail: fail, reason } = shouldFail(report, {
  failSeverity: args.failSeverity,
  strict: args.strict,
  requireSignature: Boolean(requireSignature && verificationRequested),
});

if (report.signatureVerified === false && verificationRequested) {
  console.error(
    `cdx-validate: signature verification failed — ${report.signatureDetails?.error || "no matching key"}.`,
  );
  if (requireSignature) {
    process.exit(4);
  }
}
const unverifiedEntries = (report.signatureEntries || []).filter(
  (entry) => !entry.verified,
);
if (report.signatureVerified && unverifiedEntries.length) {
  console.error(
    `cdx-validate: warning — ${unverifiedEntries.length} of ${report.signatureEntries.length} signature entries did not verify with the given key: ${unverifiedEntries.map((entry) => `entry ${entry.index}${entry.keyId === undefined ? "" : ` (keyId '${displayValue(entry.keyId)}')`}`).join(", ")}.`,
  );
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
