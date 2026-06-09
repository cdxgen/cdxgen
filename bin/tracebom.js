#!/usr/bin/env node
import { basename, resolve } from "node:path";
import process from "node:process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { createDynamicBom } from "../lib/cli/index.js";
import {
  DEBUG_MODE,
  retrieveCdxgenVersion,
  safeWriteSync,
} from "../lib/helpers/utils.js";

const _yargs = yargs(hideBin(process.argv));

const args = _yargs
  .parserConfiguration({
    "boolean-negation": true,
    "greedy-arrays": false,
    "parse-numbers": true,
    "short-option-groups": false,
  })
  .option("cmd", {
    description:
      "Command to execute and trace for dynamic library SBOM generation.",
    type: "string",
  })
  .option("working-dir", {
    alias: "d",
    description: "Working directory for the traced process.",
    type: "string",
  })
  .option("output", {
    alias: "o",
    description: "Output SBOM file path.",
    default: "bom.json",
    type: "string",
  })
  .option("spec-version", {
    description: "CycloneDX specification version.",
    default: 1.7,
    type: "number",
  })
  .option("project-name", {
    description: "Override component name.",
    type: "string",
  })
  .option("project-version", {
    description: "Override component version.",
    type: "string",
  })
  .option("read-paths", {
    description: "Comma-separated extra filesystem read paths for the sandbox.",
    type: "string",
  })
  .option("write-paths", {
    description:
      "Comma-separated sandbox write paths (overrides default of OS tmpdir).",
    type: "string",
  })
  .option("max-memory", {
    description: "Max memory MB for sandbox.",
    default: 512,
    type: "number",
  })
  .option("max-processes", {
    description: "Max process count for sandbox.",
    default: 64,
    type: "number",
  })
  .option("timeout", {
    description: "Trace timeout in milliseconds.",
    default: 60000,
    type: "number",
  })
  .option("disable-network", {
    description:
      "Disable network inside sandbox. Automatically disabled when --trace-http-urls is set.",
    default: true,
    type: "boolean",
  })
  .option("trace-http-urls", {
    description:
      "Enable eBPF-based HTTP URL tracing (Linux only, kernel >= 5.8). Requires CAP_BPF.",
    default: false,
    type: "boolean",
  })
  .option("trace-period", {
    description:
      "Stop tracing after N seconds (for long-running or persistent commands).",
    type: "number",
  })
  .option("print", {
    description: "Print BOM to stdout.",
    default: false,
    type: "boolean",
  })
  .scriptName(
    basename(process.argv[1] || "tracebom").replace(/\.(?:[cm]?js|exe)$/u, ""),
  )
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

const workingDir = args.workingDir || process.cwd();

const options = {
  traceCmd: args.cmd,
  traceWorkingDir: workingDir,
  specVersion: args.specVersion,
  projectName: args.projectName,
  projectVersion: args.projectVersion,
  traceReadPaths: args.readPaths
    ? args.readPaths.split(",").filter(Boolean)
    : [],
  traceWritePaths: args.writePaths
    ? args.writePaths.split(",").filter(Boolean)
    : [],
  traceMaxMemoryMB: args.maxMemory,
  traceMaxProcesses: args.maxProcesses,
  traceTimeoutMs: args.timeout,
  traceDisableNetwork: args.traceHttpUrls
    ? false
    : (args.disableNetwork ?? true),
  traceHTTPURLs: args.traceHttpUrls ?? false,
  tracePeriod: args.tracePeriod,
  projectType: ["dynamic"],
  output: resolve(args.output),
};

(async () => {
  const { bomJson } = await createDynamicBom(workingDir, options);

  const jsonPayload = JSON.stringify(bomJson, null, DEBUG_MODE ? 2 : null);

  if (args.print) {
    console.log(jsonPayload);
  }

  safeWriteSync(options.output, jsonPayload);

  const serviceCount = bomJson?.services?.length || 0;
  const componentCount = bomJson?.components?.length || 0;
  const summaryParts = [
    `SBOM written to ${options.output}`,
    `${componentCount} component(s)`,
  ];
  if (serviceCount > 0) {
    summaryParts.push(`${serviceCount} service(s)`);
  }
  console.log(summaryParts.join(", "));
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
