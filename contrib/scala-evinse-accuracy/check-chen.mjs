#!/usr/bin/env node
// Local accuracy check of cdxgen's Scala evidence join against a chen
// checkout. Runs this checkout's cdxgen with the research profile over the
// checkout you name, then verifies what reached the BOM:
//
//   node contrib/scala-evinse-accuracy/check-chen.mjs <path-to-chen>
//
// The checks live in checks.mjs next to this script, with the unit tests that
// cover them under test/scala-evinse-accuracy. This is a development check,
// not a CI job: run it by hand when the atom-parsetools version cdxgen
// depends on changes, or when lib/ecosystems/scalasem.js changes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { runAllChecks } from "./checks.mjs";

// The build files that identify a Scala project, the list scalasem itself
// uses to find the project root.
const SCALA_BUILD_MARKERS = [
  "build.sbt",
  "build.sc",
  "build.mill",
  "pom.xml",
  "project.scala",
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const cdxgenBin = join(repoRoot, "bin", "cdxgen.js");

function fail(message, code = 1) {
  console.error(`check-chen: ${message}`);
  process.exit(code);
}

function usage() {
  console.log(usageText);
}

const usageText =
  "usage: node contrib/scala-evinse-accuracy/check-chen.mjs [--keep] [--no-install-deps] <path-to-chen>";
const keepArtifacts = process.argv.includes("--keep");
const noInstallDeps = process.argv.includes("--no-install-deps");
const positional = process.argv
  .slice(2)
  .filter((arg) => arg !== "--keep" && arg !== "--no-install-deps");
const chenArg = positional[0];
if (!chenArg || chenArg === "-h" || chenArg === "--help") {
  console.log(usageText);
  if (chenArg === "-h" || chenArg === "--help") {
    console.log(
      "\n  --keep             keep the temporary directory with the BOM and the scalasem report, for inspecting a failure.",
    );
    console.log(
      "  --no-install-deps  pass --no-install-deps to cdxgen, which passes --no-build to scalasem: no build tool runs and only what a previous build left on disk is read. This is the mode the known scalasem failures over chen were found in.",
    );
    process.exit(0);
  }
  process.exit(2);
}
const chenPath = resolve(chenArg);
let chenStat;
try {
  chenStat = statSync(chenPath);
} catch (_err) {
  chenStat = undefined;
}
if (!chenStat?.isDirectory()) {
  fail(`"${chenPath}" is not a directory.`);
}
const marker = SCALA_BUILD_MARKERS.find((name) =>
  existsSync(join(chenPath, name)),
);
if (!marker) {
  fail(
    `"${chenPath}" does not look like a Scala project: none of ${SCALA_BUILD_MARKERS.join(", ")} is there.`,
  );
}
if (!existsSync(cdxgenBin)) {
  fail(`this checkout's cdxgen is missing at "${cdxgenBin}".`);
}
const parsetoolsDir = join(
  repoRoot,
  "node_modules",
  "@appthreat",
  "atom-parsetools",
);
if (!existsSync(join(parsetoolsDir, "scalasem.js"))) {
  fail(
    `the atom-parsetools package is not installed under "${parsetoolsDir}". Run pnpm install in this checkout first; without it cdxgen produces no Scala evidence.`,
  );
}

// The scalasem entry point a run uses, so the report says which analyzer the
// numbers belong to. SCALASEM_CMD, if set, wins inside cdxgen itself.
let scalasemUsed = process.env.SCALASEM_CMD;
if (!scalasemUsed) {
  try {
    const require = createRequire(join(repoRoot, "package.json"));
    scalasemUsed = require.resolve("@appthreat/atom-parsetools/scalasem.js");
  } catch (_err) {
    scalasemUsed = undefined;
  }
}

const workDir = mkdtempSync(join(tmpdir(), "cdxgen-check-chen-"));
const bomFile = join(workDir, "bom.json");
const reportFile = join(workDir, "scalasem.slices.json");
const args = [
  cdxgenBin,
  "-t",
  "scala",
  "--evidence",
  "--profile",
  "research",
  "-o",
  bomFile,
  "--semantics-slices-file",
  reportFile,
];
if (noInstallDeps) {
  args.push("--no-install-deps");
}
args.push(chenPath);
console.log(
  `Running cdxgen over ${chenPath}. The output lands in ${workDir}; a chen build and analysis take minutes.`,
);
const startedAt = Date.now();
const result = spawnSync(process.execPath, args, {
  cwd: chenPath,
  encoding: "utf-8",
  maxBuffer: 128 * 1024 * 1024,
});
const elapsedS = Math.round((Date.now() - startedAt) / 1000);
const runFailed = result.status !== 0 || !existsSync(bomFile);
if (runFailed) {
  console.error(
    `cdxgen failed after ${elapsedS}s (exit status ${result.status}). Captured stderr:`,
  );
  if (result.stderr) {
    console.error(result.stderr);
  }
  const stdoutTail = (result.stdout || "").split("\n").slice(-40).join("\n");
  if (stdoutTail.trim()) {
    console.error("Last lines of stdout:");
    console.error(stdoutTail);
  }
  fail(`no usable BOM at ${bomFile}; the checks did not run.`);
}
console.log(`cdxgen finished in ${elapsedS}s. Checking the BOM.`);

let bom;
try {
  bom = JSON.parse(readFileSync(bomFile, "utf-8"));
} catch (err) {
  fail(`the BOM at ${bomFile} is not valid JSON (${err.message}).`);
}

// Every occurrence location is tried against the chen checkout first, then
// against the source roots the scalasem report extracted.
const roots = [chenPath];
let report;
let scalasemVersion;
try {
  report = JSON.parse(readFileSync(reportFile, "utf-8"));
} catch (_err) {
  report = undefined;
}
if (report?._meta) {
  scalasemVersion = report._meta.toolVersion;
  for (const module of report.modules || []) {
    for (const root of module.sourceRoots || []) {
      const absolute = resolve(report._meta.projectPath || chenPath, root);
      if (!roots.includes(absolute)) {
        roots.push(absolute);
      }
    }
  }
}
const lineCounts = new Map();
const resolver = {
  roots,
  statFile(path) {
    if (lineCounts.has(path)) {
      return lineCounts.get(path);
    }
    let stat;
    try {
      const text = readFileSync(path, "utf-8");
      stat = {
        exists: true,
        lineCount: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
      };
    } catch (_err) {
      stat = { exists: false };
    }
    lineCounts.set(path, stat);
    return stat;
  },
};

const rows = runAllChecks(bom, resolver);

const chenHead = gitHead(chenPath);
console.log("");
console.log(
  `chen at ${chenHead || chenPath}; scalasem ${scalasemVersion || "unknown"}; ${report ? "report read" : "scalasem report not readable, locations resolve against the checkout only"}.`,
);
console.log("");
const labelWidth = Math.max(...rows.map((row) => row.check.length));
for (const row of rows) {
  const verdict = row.pass ? "pass" : "FAIL";
  console.log(
    `${row.check.padEnd(labelWidth)}  ${verdict.padEnd(5)}  ${row.summary}`,
  );
}
const failedRows = rows.filter((row) => !row.pass);
if (failedRows.length) {
  console.log("");
  console.log("Failures:");
  for (const row of failedRows) {
    console.log("");
    console.log(`  ${row.check}`);
    for (const detail of row.details) {
      console.log(`    ${detail}`);
    }
  }
}
if (keepArtifacts) {
  console.log(
    `The run directory ${workDir} is kept (BOM, scalasem report and log).`,
  );
} else {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (_err) {
    console.log(`The run directory ${workDir} could not be removed.`);
  }
}
process.exit(failedRows.length ? 1 : 0);

function gitHead(projectPath) {
  const head = spawnSync(
    "git",
    ["-C", projectPath, "rev-parse", "--short", "HEAD"],
    { encoding: "utf-8" },
  );
  const branch = spawnSync(
    "git",
    ["-C", projectPath, "rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf-8" },
  );
  if (head.status !== 0) {
    return undefined;
  }
  return branch.status === 0
    ? `${head.stdout.trim()} (${branch.stdout.trim()})`
    : head.stdout.trim();
}
