#!/usr/bin/env node

import fs from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { installConsoleShim, restoreConsole } from "../lib/core/ui.js";
import {
  retrieveCdxgenVersion,
  safeExistsSync,
  safeMkdirSync,
  safeWriteSync,
} from "../lib/ecosystems/utils.js";
import {
  deriveSpdxOutputPath,
  deriveSpecVersionOutputPath,
} from "../lib/helpers/exportUtils.js";
import {
  getNonCycloneDxErrorMessage,
  isCycloneDx20SpecVersion,
  isCycloneDxBom,
  toCycloneDxSpecVersionString,
} from "../lib/inventory/bomUtils.js";
import {
  CDX20_INTERNAL_SECTIONS_KEY,
  loadBomForAnalysis,
  renderCycloneDx20WithReport,
} from "../lib/inventory/cyclonedx20.js";
import { hardwareRenderContext } from "../lib/inventory/hbomLoader.js";
import {
  importProtobomModule,
  isProtoBomPath,
} from "../lib/inventory/protobomLoader.js";
import { sortBomCollections } from "../lib/stages/postgen/sortBom.js";
import { convertCycloneDxToSpdx } from "../lib/stages/postgen/spdxConverter.js";
import {
  applySpecVersionCompatibility,
  diffMissingLeafValues,
  diffRemovedFieldPaths,
} from "../lib/stages/postgen/specVersionCompat.js";
import { validateBom, validateSpdx } from "../lib/validator/bomValidator.js";

// cdxgen bundles CycloneDX JSON schemas for these versions only, so a
// conversion to any other version is written without a schema check.
const VALIDATABLE_SPEC_VERSIONS = new Set(["1.6", "1.7", "2.0"]);
// The 2.0 renderer reads the 1.x model of these versions; older input has
// shapes it does not convert (a 1.5 tools array, a single identity object).
const CDX20_SOURCE_SPEC_VERSIONS = new Set(["1.6", "1.7", "2.0"]);
// Longest value printed for a missing 2.0 leaf; the comparison uses all of it.
const MAX_PRINTED_LEAF_LENGTH = 160;

const _yargs = yargs(hideBin(process.argv));

const args = _yargs
  .option("input", {
    alias: "i",
    default: "bom.json",
    description: "Input CycloneDX BOM JSON or protobuf file.",
  })
  .option("output", {
    alias: "o",
    description:
      "Output file. Defaults to <input>.spdx.json, or <input>-<to>.<ext> when --to names a CycloneDX version.",
  })
  .option("to", {
    default: "spdx",
    description:
      "Conversion target. 'spdx' exports SPDX 3.0.1 JSON-LD. A CycloneDX spec version (1.5, 1.6, 1.7, 2.0) cross-converts the BOM to that version instead.",
  })
  .option("validate", {
    type: "boolean",
    default: true,
    description:
      "Validate the converted output against its schema. Pass --no-validate to skip.",
  })
  .option("fail-on-loss", {
    type: "boolean",
    default: false,
    description:
      "Exit 2, without writing the output, when the conversion loses data: a CycloneDX 2.0 input's read losses for a 1.x or SPDX target, values the 2.0 render drops, or field paths the target version does not define.",
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

// stdout carries the payload and nothing else; every diagnostic goes to the
// live region's stream. Without the shim a `--print`/`--json` document shares
// stdout with progress messages and cannot be piped into a parser.
installConsoleShim();
process.once("exit", restoreConsole);

const loadCycloneDxBom = async (inputPath) => {
  if (!safeExistsSync(inputPath)) {
    console.error(`Input file '${inputPath}' not found.`);
    process.exit(1);
  }
  const isProtoInput = isProtoBomPath(inputPath);
  try {
    if (isProtoInput) {
      const { readBinary } = await importProtobomModule(
        "cdx-convert",
        "protobuf BOM input",
      );
      return readBinary(inputPath, true);
    }
    return JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (error) {
    const inputType = isProtoInput ? "protobuf" : "JSON";
    console.error(
      `Failed to parse '${inputPath}' as CycloneDX ${inputType}: ${error.message}`,
    );
    process.exit(1);
  }
};

const ensureOutputParent = (outputPath) => {
  const outputParent = dirname(outputPath);
  if (outputParent && outputParent !== "." && !safeExistsSync(outputParent)) {
    safeMkdirSync(outputParent, { recursive: true });
  }
};

const targetSpecVersion = toCycloneDxSpecVersionString(args.to);
const isSpdxTarget = `${args.to}`.trim().toLowerCase() === "spdx";
if (!isSpdxTarget && !targetSpecVersion) {
  console.error(
    `Unsupported conversion target '${args.to}'. Pass --to spdx for an SPDX 3.0.1 export, or a CycloneDX spec version such as 1.5, 1.6, 1.7 or 2.0.`,
  );
  process.exit(1);
}
const isCdx20Target = !isSpdxTarget && targetSpecVersion === "2.0";

const bomJson = await loadCycloneDxBom(args.input);

if (!isCycloneDxBom(bomJson)) {
  console.error(getNonCycloneDxErrorMessage(bomJson, "cdx-convert"));
  process.exit(1);
}
// A 2.0 input reads into the 1.x-shaped internal model first; the losses say
// what of the input that model (and so any 1.x or SPDX output) cannot hold.
const { internalBom, losses } = loadBomForAnalysis(bomJson);
const isCdx20Input =
  isCycloneDx20SpecVersion(bomJson?.specVersion) || !!bomJson?.specFormat;
const cdxSpecVersion = isCdx20Input
  ? "2.0"
  : toCycloneDxSpecVersionString(bomJson?.specVersion);
if (isCdx20Target && !CDX20_SOURCE_SPEC_VERSIONS.has(cdxSpecVersion)) {
  console.error(
    `cdx-convert --to 2.0 reads CycloneDX 1.6, 1.7 or 2.0 input, and '${args.input}' is CycloneDX ${bomJson?.specVersion ?? "(no specVersion)"}. Convert it with --to 1.7 first, then convert that file to 2.0.`,
  );
  process.exit(1);
}

// Every loss is printed, whatever the target; --fail-on-loss counts the ones
// the output really lacks.
let lostCount = 0;
if (losses.length) {
  const targetLabel = isSpdxTarget
    ? "the SPDX 3.0.1 export lacks what they name"
    : isCdx20Target
      ? "the 2.0 output keeps what the read model carries for 2.0, and any difference is reported below"
      : `the CycloneDX ${targetSpecVersion} output lacks what they name`;
  console.warn(
    `Reading the CycloneDX 2.0 input into cdxgen's 1.x model reported ${losses.length} loss(es); ${targetLabel}:`,
  );
  for (const loss of losses) {
    console.warn(`  - ${loss.pointer || "(root)"}: ${loss.reason}`);
  }
  if (!isCdx20Target) {
    lostCount += losses.length;
  }
}
const failIfLost = () => {
  if (args.failOnLoss && lostCount > 0) {
    console.error(
      `--fail-on-loss is set and the conversion lost data (${lostCount} loss(es) above).`,
    );
    process.exit(2);
  }
};

if (isSpdxTarget) {
  if (!["1.6", "1.7", "2.0"].includes(cdxSpecVersion)) {
    console.error(
      `Unsupported CycloneDX specVersion '${bomJson?.specVersion}'. cdx-convert supports CycloneDX 1.6, 1.7 and 2.0 input and exports SPDX 3.0.1.`,
    );
    process.exit(1);
  }
  failIfLost();

  const spdxJson = convertCycloneDxToSpdx(internalBom, args);
  if (!spdxJson) {
    console.error("Conversion failed: unable to generate SPDX output.");
    process.exit(1);
  }

  if (args.validate && !validateSpdx(spdxJson)) {
    console.error("SPDX validation failed for the converted output.");
    process.exit(1);
  }

  const outputPath = args.output || deriveSpdxOutputPath(args.input);
  ensureOutputParent(outputPath);
  safeWriteSync(
    outputPath,
    JSON.stringify(spdxJson, null, args.jsonPretty ? 2 : null),
  );
  console.log(`Successfully converted '${args.input}' to '${outputPath}'.`);
} else {
  const outputPath =
    args.output || deriveSpecVersionOutputPath(args.input, targetSpecVersion);
  if (outputPath === args.input) {
    console.error(
      `Refusing to overwrite the input BOM '${args.input}'. Pass an explicit -o.`,
    );
    process.exit(1);
  }

  // The same normalizer the postgen stage applies to freshly generated BOMs, so
  // `cdx-convert --to 1.6` and `cdxgen --spec-version 1.6` agree on the result.
  const convertedModel = applySpecVersionCompatibility(
    structuredClone(internalBom),
    { specVersion: targetSpecVersion },
  );
  let convertedBomJson = convertedModel;
  if (isCdx20Target) {
    // A 1.6/1.7 input is sorted, as postProcess sorts before its render, so
    // `cdx-convert --to 2.0` and `cdxgen --spec-version 2.0` agree on the
    // order. A 2.0 input keeps its own order: sorting would reorder the
    // objects the read model keeps as 2.0 originals, and they would no
    // longer render back unchanged.
    if (!isCdx20Input) {
      sortBomCollections(convertedModel);
    }
    // The optional cdx-hbom hardware mapper, as cdxgen --spec-version 2.0
    // uses it, so both render an HBOM the same way.
    const { bomJson: rendered, report } = renderCycloneDx20WithReport(
      convertedModel,
      await hardwareRenderContext(convertedModel),
    );
    convertedBomJson = rendered;
    const dropLabels = Object.keys(report.drops);
    const dropCount = dropLabels.reduce(
      (sum, label) => sum + report.drops[label],
      0,
    );
    if (dropCount) {
      console.warn(
        `Rendering CycloneDX 2.0 dropped ${dropCount} value(s) the 2.0 format has no place for:`,
      );
      for (const label of dropLabels) {
        console.warn(`  - ${label} ×${report.drops[label]}`);
      }
      lostCount += dropCount;
    }
    if (isCdx20Input) {
      // The read model carries 2.0-only content for 2.0 output, so a 2.0 to
      // 2.0 conversion loses only what is missing from the output.
      const missing = diffMissingLeafValues(bomJson, convertedBomJson);
      if (missing.length) {
        console.warn(
          `The CycloneDX 2.0 output lacks ${missing.length} value(s) of the input (member order ignored):`,
        );
        for (const leaf of missing) {
          console.warn(
            `  - ${leaf.length > MAX_PRINTED_LEAF_LENGTH ? `${leaf.slice(0, MAX_PRINTED_LEAF_LENGTH)}…` : leaf}`,
          );
        }
        lostCount += missing.length;
      }
    }
  } else {
    sortBomCollections(convertedBomJson);
    const removedFieldPaths = diffRemovedFieldPaths(
      internalBom,
      convertedBomJson,
    )
      // The internal sections key is a transport detail of the 1.x model,
      // not a document field, so it never counts as dropped data.
      .filter(
        (fieldPath) => !fieldPath.startsWith(CDX20_INTERNAL_SECTIONS_KEY),
      );
    if (removedFieldPaths.length) {
      console.warn(
        `Converting to CycloneDX ${targetSpecVersion} dropped ${removedFieldPaths.length} field path(s) that version does not define:`,
      );
      for (const fieldPath of removedFieldPaths) {
        console.warn(`  - ${fieldPath}`);
      }
      lostCount += removedFieldPaths.length;
    }
  }
  failIfLost();

  if (args.validate) {
    if (VALIDATABLE_SPEC_VERSIONS.has(targetSpecVersion)) {
      if (!(await validateBom(convertedBomJson))) {
        console.error(
          `CycloneDX ${targetSpecVersion} validation failed for the converted output.`,
        );
        process.exit(1);
      }
    } else {
      console.warn(
        `Skipping schema validation: cdxgen bundles CycloneDX schemas for ${[...VALIDATABLE_SPEC_VERSIONS].join(", ")} only.`,
      );
    }
  }

  ensureOutputParent(outputPath);
  if (isProtoBomPath(outputPath)) {
    const { writeBinary } = await importProtobomModule(
      "cdx-convert",
      "protobuf BOM output",
    );
    writeBinary(convertedBomJson, outputPath, targetSpecVersion);
  } else {
    safeWriteSync(
      outputPath,
      JSON.stringify(convertedBomJson, null, args.jsonPretty ? 2 : null),
    );
  }
  console.log(
    `Successfully converted '${args.input}' from CycloneDX ${cdxSpecVersion} to CycloneDX ${targetSpecVersion} at '${outputPath}'.`,
  );
}
