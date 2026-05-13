#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createHBom } from "../lib/cli/index.js";
import { printActivitySummary } from "../lib/helpers/display.js";
import { getOutputDirectory } from "../lib/helpers/exportUtils.js";
import {
  ensureNoMixedHbomProjectTypes,
  ensureSupportedHbomSpecVersion,
  hasHbomProjectType,
} from "../lib/helpers/hbom.js";
import { getHbomSummary } from "../lib/helpers/hbomAnalysis.js";
import { thoughtLog } from "../lib/helpers/logger.js";
import {
  DEBUG_MODE,
  isDryRun,
  retrieveCdxgenVersion,
  safeExistsSync,
  safeMkdirSync,
  safeWriteSync,
  setActivityContext,
  setDryRunMode,
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
  .usage("$0 [command] [options]")
  .command(
    "diagnostics",
    "Identify HBOM collector missing-command and permission-denied issues from a live run or an existing HBOM JSON file.",
  )
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
  .option("dry-run", {
    description:
      "Read-only mode. Report the requested HBOM collection and block host probing plus filesystem writes.",
    type: "boolean",
    default: isDryRun,
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
  .option("include-runtime", {
    description:
      "Collect OBOM runtime inventory alongside the HBOM and emit a merged host view with strict topology links.",
    type: "boolean",
    default: false,
  })
  .option("privileged", {
    description:
      "Enable privileged Linux enrichment and non-interactive sudo retries for documented permission-sensitive commands.",
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
    description:
      "Per-command timeout in milliseconds. Increase this on slower hosts such as Raspberry Pi systems.",
    type: "number",
  })
  .option("type", {
    description:
      "Compatibility project type flag. Only 'hbom' or 'hardware' are accepted.",
    hidden: true,
  })
  .option("input", {
    alias: "i",
    description:
      "Read an existing HBOM JSON file instead of collecting a fresh live inventory. Primarily useful with the diagnostics command.",
    type: "string",
  })
  .option("json", {
    description:
      "Print the diagnostics summary as JSON instead of human-readable text. Only applies to the diagnostics command.",
    type: "boolean",
    default: false,
  })
  .array("type")
  .example([
    ["$0", "Generate an HBOM file for the current host"],
    ["$0 -p", "Print the generated HBOM to stdout"],
    ["$0 --platform linux --arch amd64", "Override target selection"],
    ["$0 --privileged --pretty", "Enable privileged Linux enrichment"],
    [
      "$0 diagnostics",
      "Run a live HBOM diagnostic pass and summarize missing commands or permission-sensitive enrichments",
    ],
    [
      "$0 diagnostics --input hbom.json",
      "Summarize missing commands or permission-denied enrichments from an existing HBOM file",
    ],
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
const selectedCommand = `${args._?.[0] ?? "generate"}`;

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
  command: selectedCommand,
  dryRun: args.dryRun,
  input: args.input ? resolve(args.input) : undefined,
  noCommandEnrichment: args.noCommandEnrichment,
  includeRuntime: args.includeRuntime,
  json: args.json,
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

setDryRunMode(options.dryRun);
setActivityContext({
  projectType: requestedTypes[0],
  sourcePath: process.cwd(),
});

if (options.dryRun) {
  thoughtLog(
    "HBOM dry-run mode is enabled. I must keep collection read-only, block command enrichment, and avoid filesystem writes.",
  );
}

function groupDiagnosticsByIssue(issue, commandDiagnostics = []) {
  const groupedDiagnostics = new Map();

  for (const entry of commandDiagnostics) {
    if (entry?.issue !== issue) {
      continue;
    }
    const commandName = `${entry.command ?? entry.id ?? "command"}`;
    const hint = `${entry.installHint ?? entry.privilegeHint ?? ""}`.trim();
    const message = `${entry.message ?? ""}`.trim();
    const groupingKey = [commandName, issue, hint, message].join("\u0000");
    const currentEntry = groupedDiagnostics.get(groupingKey) ?? {
      command: commandName,
      count: 0,
      hint: hint || undefined,
      message: message || undefined,
    };
    currentEntry.count += 1;
    groupedDiagnostics.set(groupingKey, currentEntry);
  }

  return [...groupedDiagnostics.values()].sort((firstEntry, secondEntry) =>
    firstEntry.command.localeCompare(secondEntry.command),
  );
}

function buildFormattedDiagnosticLines(groupedEntries = []) {
  return groupedEntries.flatMap((entry) => {
    const headline = `- ${entry.command}${entry.count > 1 ? ` (${entry.count} invocations)` : ""}`;
    const detailParts = [];
    if (entry.message) {
      detailParts.push(entry.message);
    }
    if (entry.hint) {
      detailParts.push(`Hint: ${entry.hint}`);
    }
    if (!detailParts.length) {
      return [headline];
    }
    return [headline, ...detailParts.map((value) => `  ${value}`)];
  });
}

function printHbomDiagnosticNotice(bomJson) {
  const hbomSummary = getHbomSummary(bomJson);
  if (!hbomSummary.actionableDiagnosticCount) {
    return;
  }
  const detailParts = [];
  if (hbomSummary.missingCommandCount) {
    detailParts.push(`${hbomSummary.missingCommandCount} missing command`);
  }
  if (hbomSummary.permissionDeniedCount) {
    detailParts.push(
      `${hbomSummary.permissionDeniedCount} permission-denied enrichment`,
    );
  }
  const followUpCommand = options.print
    ? "hbom diagnostics"
    : `hbom diagnostics --input ${options.output}`;
  console.error(
    `HBOM collector reported ${hbomSummary.actionableDiagnosticCount} actionable diagnostic(s) (${detailParts.join(", ")}). Run '${followUpCommand}' for detailed install and privilege guidance.`,
  );
}

function loadBomFromInputFile(inputFile) {
  if (!inputFile || !safeExistsSync(inputFile)) {
    throw new Error(`HBOM input file not found: ${inputFile}`);
  }
  return JSON.parse(readFileSync(inputFile, { encoding: "utf8" }));
}

function printHbomDiagnosticsReport(bomJson) {
  const hbomSummary = getHbomSummary(bomJson);
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          actionableDiagnosticCount: hbomSummary.actionableDiagnosticCount,
          architecture: hbomSummary.architecture,
          collectorProfile: hbomSummary.collectorProfile,
          commandDiagnosticCount: hbomSummary.commandDiagnosticCount,
          commandDiagnostics: hbomSummary.commandDiagnostics,
          commandErrorCount: hbomSummary.commandErrorCount,
          diagnosticIssues: hbomSummary.diagnosticIssues,
          installHints: hbomSummary.installHints,
          metadataName: hbomSummary.metadataName,
          missingCommandCount: hbomSummary.missingCommandCount,
          missingCommands: hbomSummary.missingCommands,
          partialSupportCount: hbomSummary.partialSupportCount,
          permissionDeniedCommands: hbomSummary.permissionDeniedCommands,
          permissionDeniedCount: hbomSummary.permissionDeniedCount,
          platform: hbomSummary.platform,
          privilegeHints: hbomSummary.privilegeHints,
          requiresPrivilegedEnrichment:
            hbomSummary.requiresPrivilegedEnrichment,
          timeoutCount: hbomSummary.timeoutCount,
        },
        null,
        2,
      ),
    );
    return;
  }

  const missingCommands = groupDiagnosticsByIssue(
    "missing-command",
    hbomSummary.commandDiagnostics,
  );
  const permissionDeniedCommands = groupDiagnosticsByIssue(
    "permission-denied",
    hbomSummary.commandDiagnostics,
  );

  console.log("HBOM diagnostics summary");
  console.log(
    `Target: ${hbomSummary.platform ?? "unknown"}/${hbomSummary.architecture ?? "unknown"}`,
  );
  if (hbomSummary.collectorProfile) {
    console.log(`Collector profile: ${hbomSummary.collectorProfile}`);
  }
  if (hbomSummary.metadataName) {
    console.log(`Host: ${hbomSummary.metadataName}`);
  }
  console.log(`Total diagnostics: ${hbomSummary.commandDiagnosticCount}`);
  console.log(`Missing commands: ${hbomSummary.missingCommandCount}`);
  console.log(`Permission denied: ${hbomSummary.permissionDeniedCount}`);
  console.log(`Partial support: ${hbomSummary.partialSupportCount}`);
  console.log(`Timeouts: ${hbomSummary.timeoutCount}`);
  console.log(`Other command errors: ${hbomSummary.commandErrorCount}`);

  if (!hbomSummary.commandDiagnosticCount) {
    console.log("No HBOM collector diagnostics were found.");
    return;
  }

  if (missingCommands.length) {
    console.log("\nMissing commands:");
    for (const line of buildFormattedDiagnosticLines(missingCommands)) {
      console.log(line);
    }
  }

  if (permissionDeniedCommands.length) {
    console.log("\nPermission-sensitive enrichments:");
    for (const line of buildFormattedDiagnosticLines(
      permissionDeniedCommands,
    )) {
      console.log(line);
    }
  }

  if (hbomSummary.requiresPrivilegedEnrichment) {
    console.log(
      "\nSome Linux enrichments can likely succeed only with --privileged and a target environment that allows non-interactive sudo.",
    );
  }
}

async function runDiagnosticsCommand() {
  if (options.includeRuntime) {
    thoughtLog(
      "The diagnostics subcommand focuses on HBOM collector gaps only, so I will skip the merged runtime host view.",
    );
  }
  const bomJson = options.input
    ? loadBomFromInputFile(options.input)
    : (
        await createHBom(process.cwd(), {
          ...options,
          includeRuntime: false,
          print: false,
          validate: false,
        })
      ).bomJson;
  printHbomDiagnosticsReport(bomJson);
}

(async () => {
  if (selectedCommand === "diagnostics") {
    await runDiagnosticsCommand();
    if (options.dryRun || DEBUG_MODE) {
      printActivitySummary();
    }
    return;
  }
  thoughtLog(
    "Let's generate a Hardware Bill-of-Materials (HBOM) for this host.",
  );
  if (options.includeRuntime) {
    thoughtLog(
      "Let's also collect the runtime inventory so I can build a merged HBOM+OBOM host view without guessing relationships.",
    );
  }
  const { bomJson } = await createHBom(process.cwd(), options);
  if (options.validate && !validateBom(bomJson)) {
    process.exit(1);
  }
  const output = JSON.stringify(bomJson, null, options.pretty ? 2 : null);
  if (options.print) {
    console.log(output);
  } else {
    const outputDirectory = getOutputDirectory(options.output);
    if (outputDirectory && !safeExistsSync(outputDirectory)) {
      safeMkdirSync(outputDirectory, { recursive: true });
    }
    safeWriteSync(options.output, output);
    thoughtLog(`Let's save the HBOM file to '${options.output}'.`);
  }
  printHbomDiagnosticNotice(bomJson);
  if (options.dryRun || DEBUG_MODE) {
    printActivitySummary();
  }
})().catch((error) => {
  if (options.dryRun || DEBUG_MODE) {
    printActivitySummary();
  }
  console.error(error.message || error);
  process.exit(1);
});
