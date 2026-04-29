#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  DEFAULT_AUDIT_CATEGORIES,
  finalizeAuditReport,
  runAudit,
} from "../lib/audit/index.js";
import { createProgressTracker } from "../lib/audit/progress.js";
import {
  retrieveCdxgenVersion,
  safeExistsSync,
  safeMkdirSync,
} from "../lib/helpers/utils.js";

const args = yargs(hideBin(process.argv))
  .option("bom", {
    description: "Path to a CycloneDX JSON BOM file.",
    type: "string",
  })
  .option("bom-dir", {
    description: "Directory containing one or more CycloneDX JSON BOM files.",
    type: "string",
  })
  .option("workspace-dir", {
    description:
      "Optional directory to reuse git clones for purl-to-source enrichment.",
    type: "string",
  })
  .option("reports-dir", {
    description:
      "Optional directory to store generated per-purl SBOMs and findings.",
    type: "string",
  })
  .option("report", {
    choices: ["console", "json", "sarif"],
    default: "console",
    description: "Output format.",
  })
  .option("report-file", {
    alias: "o",
    description: "Write the report to this file. Defaults to stdout.",
    type: "string",
  })
  .option("categories", {
    default: DEFAULT_AUDIT_CATEGORIES.join(","),
    description:
      "Comma-separated rule categories to evaluate for each generated child SBOM.",
    type: "string",
  })
  .option("min-severity", {
    choices: ["low", "medium", "high", "critical"],
    default: "low",
    description:
      "Minimum final target severity to include in console or SARIF output.",
    type: "string",
  })
  .option("fail-severity", {
    choices: ["low", "medium", "high", "critical"],
    default: "high",
    description:
      "Exit with code 3 when any target reaches this final severity or above.",
    type: "string",
  })
  .option("max-targets", {
    description:
      "Optional safety limit for the number of unique npm/PyPI purls to analyze.",
    type: "number",
  })
  .option("scope", {
    choices: ["all", "required"],
    default: "all",
    description:
      "Target selection scope. Use 'required' to scan only components with CycloneDX scope=required (missing scope is treated as required).",
    type: "string",
  })
  .option("include-trusted", {
    default: false,
    description:
      "Include packages already marked with trusted publishing metadata in predictive audit target selection.",
    type: "boolean",
  })
  .option("only-trusted", {
    default: false,
    description:
      "Restrict predictive audit target selection to packages marked with trusted publishing metadata.",
    type: "boolean",
  })
  .option("prioritize-direct-runtime", {
    default: true,
    description:
      "Prioritize direct runtime dependencies ahead of optional, development-only, or platform-specific transitive packages during target selection.",
    type: "boolean",
  })
  .check((argv) => {
    if (!argv.bom && !argv.bomDir) {
      throw new Error("Specify --bom or --bom-dir.");
    }
    if (argv.bom && argv.bomDir) {
      throw new Error("Use either --bom or --bom-dir, not both.");
    }
    if (argv.output && argv.reportFile) {
      throw new Error("Use either --report-file or --output, not both.");
    }
    if (argv.includeTrusted && argv.onlyTrusted) {
      throw new Error(
        "Use either --include-trusted or --only-trusted, not both.",
      );
    }
    return true;
  })
  .completion("completion", "Generate bash/zsh completion")
  .epilogue("for documentation, visit https://cdxgen.github.io/cdxgen")
  .scriptName("cdx-audit")
  .version(retrieveCdxgenVersion())
  .help()
  .wrap(Math.min(120, yargs().terminalWidth())).argv;

/**
 * Split a CSV option into a normalized string array.
 *
 * @param {string | undefined} value CSV string
 * @returns {string[] | undefined} parsed values
 */
function splitCsv(value) {
  if (!value) {
    return undefined;
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Print or write rendered report output.
 *
 * @param {string} output rendered output
 * @param {string | undefined} outputPath optional file path
 * @returns {void}
 */
function writeOrPrint(output, outputPath) {
  if (!outputPath) {
    process.stdout.write(output);
    return;
  }
  const parentDir = dirname(outputPath);
  if (!safeExistsSync(parentDir)) {
    safeMkdirSync(parentDir, { recursive: true });
  }
  writeFileSync(outputPath, output);
}

(async () => {
  const progressTracker = createProgressTracker();
  try {
    const reportFile = args.reportFile || args.output;
    const report = await runAudit({
      bom: args.bom,
      bomDir: args.bomDir,
      categories: splitCsv(args.categories),
      failSeverity: args.failSeverity,
      maxTargets: args.maxTargets,
      minSeverity: args.minSeverity,
      onProgress: progressTracker.onProgress,
      prioritizeDirectRuntime: args.prioritizeDirectRuntime,
      report: args.report,
      reportsDir: args.reportsDir,
      scope: args.scope === "required" ? "required" : undefined,
      trusted: args.onlyTrusted
        ? "only"
        : args.includeTrusted
          ? "include"
          : undefined,
      trustedSelectionHelp:
        "Use --include-trusted to include them or --only-trusted to audit just those packages.",
      workspaceDir: args.workspaceDir,
    });
    const finalized = finalizeAuditReport(report, {
      failSeverity: args.failSeverity,
      minSeverity: args.minSeverity,
      report: args.report,
    });
    writeOrPrint(finalized.output, reportFile);
    process.exit(finalized.exitCode);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  } finally {
    progressTracker.stop();
  }
})();
