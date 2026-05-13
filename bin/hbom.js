#!/usr/bin/env node
import { resolve } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { getOutputDirectory } from "../lib/helpers/exportUtils.js";
import {
  ensureNoMixedHbomProjectTypes,
  ensureSupportedHbomSpecVersion,
  hasHbomProjectType,
} from "../lib/helpers/hbom.js";
import { thoughtLog } from "../lib/helpers/logger.js";
import {
  retrieveCdxgenVersion,
  safeExistsSync,
  safeMkdirSync,
  safeWriteSync,
} from "../lib/helpers/utils.js";
import { validateBom } from "../lib/validator/bomValidator.js";

const _yargs = yargs(hideBin(process.argv));

const args = _yargs
  .parserConfiguration({
    "boolean-negation": true,
    "greedy-arrays": false,
    "parse-numbers": true,
    "short-option-groups": false,
  })
  .usage("$0 [options]")
  .option("output", {
    alias: "o",
    default: "hbom.json",
    description: "Output file. Default hbom.json",
    type: "string",
  })
  .option("print", {
    alias: "p",
    description:
      "Print the generated HBOM to stdout instead of writing a file.",
    type: "boolean",
    default: false,
  })
  .option("pretty", {
    description: "Pretty-print the generated HBOM JSON.",
    type: "boolean",
    default: true,
  })
  .option("validate", {
    description: "Validate the generated HBOM using the CycloneDX schema.",
    type: "boolean",
    default: true,
  })
  .option("spec-version", {
    choices: [1.7],
    default: 1.7,
    description:
      "CycloneDX specification version to use. HBOM currently supports 1.7 only.",
    type: "number",
  })
  .option("platform", {
    description: "Override platform selection.",
    type: "string",
  })
  .option("arch", {
    description: "Override architecture selection.",
    type: "string",
  })
  .option("sensitive", {
    description: "Include raw identifiers instead of redacted defaults.",
    type: "boolean",
    default: false,
  })
  .option("no-command-enrichment", {
    description: "Disable optional command-based enrichment.",
    type: "boolean",
    default: false,
  })
  .option("privileged", {
    description: "Enable privileged Linux SMBIOS enrichment via dmidecode.",
    type: "boolean",
    default: false,
  })
  .option("plist-enrichment", {
    description: "Enable additional Darwin plist-based enrichment.",
    type: "boolean",
    default: false,
  })
  .option("strict", {
    description:
      "Fail instead of returning partial results when enrichment fails.",
    type: "boolean",
    default: false,
  })
  .option("timeout", {
    description: "Per-command timeout in milliseconds.",
    type: "number",
  })
  .option("type", {
    description:
      "Compatibility project type flag. Only 'hbom' or 'hardware' are accepted.",
    hidden: true,
  })
  .array("type")
  .example([
    ["$0", "Generate an HBOM file for the current host"],
    ["$0 -p", "Print the generated HBOM to stdout"],
    ["$0 --platform linux --arch amd64", "Override target selection"],
    ["$0 --privileged --pretty", "Enable privileged Linux enrichment"],
  ])
  .scriptName("hbom")
  .version(retrieveCdxgenVersion())
  .alias("v", "version")
  .help(false)
  .option("help", {
    alias: "h",
    description: "Show help",
    type: "boolean",
  })
  .wrap(Math.min(120, yargs().terminalWidth())).argv;

if (args.help) {
  console.log(`${retrieveCdxgenVersion()}\n`);
  _yargs.showHelp();
  process.exit(0);
}

const requestedTypes = args.type?.length ? args.type : ["hbom"];

try {
  ensureNoMixedHbomProjectTypes(requestedTypes);
  ensureSupportedHbomSpecVersion(args.specVersion);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (!hasHbomProjectType(requestedTypes)) {
  console.error(
    "The 'hbom' command only supports the 'hbom' or 'hardware' project type.",
  );
  process.exit(1);
}

const options = {
  arch: args.arch,
  noCommandEnrichment: args.noCommandEnrichment,
  output: resolve(args.output),
  platform: args.platform,
  plistEnrichment: args.plistEnrichment,
  pretty: args.pretty,
  print: args.print,
  privileged: args.privileged,
  projectType: [requestedTypes[0]],
  sensitive: args.sensitive,
  specVersion: args.specVersion,
  strict: args.strict,
  timeout: args.timeout,
  validate: args.validate,
};

(async () => {
  thoughtLog(
    "Let's generate a Hardware Bill-of-Materials (HBOM) for this host.",
  );
  const { createHbomDocument } = await import("../lib/helpers/hbom.js");
  const bomJson = await createHbomDocument(options);
  if (options.validate && !validateBom(bomJson)) {
    process.exit(1);
  }
  const output = JSON.stringify(bomJson, null, options.pretty ? 2 : null);
  if (options.print) {
    console.log(output);
    return;
  }
  const outputDirectory = getOutputDirectory(options.output);
  if (outputDirectory && !safeExistsSync(outputDirectory)) {
    safeMkdirSync(outputDirectory, { recursive: true });
  }
  safeWriteSync(options.output, output);
  thoughtLog(`Let's save the HBOM file to '${options.output}'.`);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
