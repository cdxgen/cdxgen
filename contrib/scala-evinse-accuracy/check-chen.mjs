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
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { EXPECTED_DEPENDENCIES, runAllChecks } from "./checks.mjs";

// The build files that identify a Scala project. sbt 0.13 builds may keep
// everything under project/.
const SCALA_BUILD_MARKERS = [
  "build.sbt",
  "build.sc",
  "build.mill",
  "pom.xml",
  "project.scala",
  join("project", "build.properties"),
];

const DEFAULT_TIMEOUT_MINUTES = 60;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const cdxgenBin = join(repoRoot, "bin", "cdxgen.js");

const usageText = `usage: node contrib/scala-evinse-accuracy/check-chen.mjs [options] <path-to-chen>

  --keep                 keep the run directory (BOM, scalasem report, namespace
                         map and the cdxgen log), for inspecting a failure.
  --no-install-deps      pass --no-install-deps to cdxgen, which passes --no-build
                         to scalasem: no build tool runs and only what a previous
                         build left on disk is read. This is the mode the known
                         scalasem failures over chen were found in.
  --expect <a,b,...>     the dependencies that must have occurrences, by artifact
                         name without the Scala suffix; defaults to chen's list.
  --timeout-minutes <n>  stop cdxgen after this long (default ${DEFAULT_TIMEOUT_MINUTES}).
  -h, --help             print this help.`;

function parseArguments(argv) {
  const parsed = {
    keep: false,
    noInstallDeps: false,
    expected: EXPECTED_DEPENDENCIES,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
    } else if (arg === "--keep") {
      parsed.keep = true;
    } else if (arg === "--no-install-deps") {
      parsed.noInstallDeps = true;
    } else if (arg === "--expect" || arg === "--timeout-minutes") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) {
        return { error: `${arg} needs a value` };
      }
      if (arg === "--expect") {
        parsed.expected = value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
      } else {
        parsed.timeoutMinutes = Number(value);
        if (!Number.isFinite(parsed.timeoutMinutes) || parsed.timeoutMinutes <= 0) {
          return { error: "--timeout-minutes needs a positive number" };
        }
      }
    } else if (arg.startsWith("-")) {
      return { error: `unknown option ${arg}` };
    } else {
      parsed.paths.push(arg);
    }
  }
  if (!parsed.help && parsed.paths.length !== 1) {
    return { error: "name exactly one project directory" };
  }
  return parsed;
}

function fail(message, code = 1) {
  console.error(`check-chen: ${message}`);
  process.exit(code);
}

const args = parseArguments(process.argv.slice(2));
if (args.help) {
  console.log(usageText);
  process.exit(0);
}
if (args.error) {
  console.error(`check-chen: ${args.error}\n\n${usageText}`);
  process.exit(2);
}

const chenPath = resolve(args.paths[0]);
let chenStat;
try {
  chenStat = statSync(chenPath);
} catch (_err) {
  chenStat = undefined;
}
if (!chenStat?.isDirectory()) {
  fail(`"${chenPath}" is not a directory.`);
}
if (!SCALA_BUILD_MARKERS.some((name) => existsSync(join(chenPath, name)))) {
  fail(
    `"${chenPath}" does not look like a Scala project: none of ${SCALA_BUILD_MARKERS.join(", ")} is there.`,
  );
}
if (!existsSync(cdxgenBin)) {
  fail(`this checkout's cdxgen is missing at "${cdxgenBin}".`);
}
// SCALASEM_CMD names the analyzer to check, as it does for cdxgen; without it
// the installed atom-parsetools must be the version package.json pins, or the
// check would measure an analyzer cdxgen does not ship with.
const scalasemCommand = process.env.SCALASEM_CMD;
let analyzer;
if (scalasemCommand) {
  if (!existsSync(scalasemCommand)) {
    fail(`SCALASEM_CMD names "${scalasemCommand}", which does not exist.`);
  }
  analyzer = `SCALASEM_CMD=${scalasemCommand}`;
} else {
  const parsetoolsDir = join(
    repoRoot,
    "node_modules",
    "@appthreat",
    "atom-parsetools",
  );
  if (!existsSync(join(parsetoolsDir, "scalasem.js"))) {
    fail(
      `the atom-parsetools package is not installed under "${parsetoolsDir}". Run pnpm install in this checkout first, or set SCALASEM_CMD.`,
    );
  }
  const pinned = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"))
    ?.dependencies?.["@appthreat/atom-parsetools"];
  const installed = JSON.parse(
    readFileSync(join(parsetoolsDir, "package.json"), "utf-8"),
  )?.version;
  if (pinned && installed !== pinned) {
    fail(
      `atom-parsetools ${installed} is installed, but package.json pins ${pinned}. Run pnpm install, or set SCALASEM_CMD to check another analyzer on purpose.`,
    );
  }
  analyzer = `atom-parsetools ${installed}`;
}

const workDir = mkdtempSync(join(tmpdir(), "cdxgen-check-chen-"));
const bomFile = join(workDir, "bom.json");
const reportFile = join(workDir, "scalasem.slices.json");
const logFile = join(workDir, "cdxgen.log");
let exitCode = 1;
try {
  exitCode = runAndCheck();
} finally {
  if (args.keep) {
    console.log(
      `The run directory ${workDir} is kept: bom.json, bom.json.map, scalasem.slices.json and cdxgen.log.`,
    );
  } else {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (_err) {
      console.log(`The run directory ${workDir} could not be removed.`);
    }
  }
}
process.exit(exitCode);

function runAndCheck() {
  const cdxgenArgs = [
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
  if (args.noInstallDeps) {
    cdxgenArgs.push("--no-install-deps");
  }
  cdxgenArgs.push(chenPath);
  // A switch left on in the shell would turn the analyzer off, and the checks
  // would then measure whatever other evidence the BOM holds.
  const env = { ...process.env };
  for (const name of ["CDXGEN_SCALASEM_DISABLE", "CDXGEN_DRY_RUN"]) {
    if (env[name]) {
      console.log(`Ignoring ${name}=${env[name]} for this run.`);
      delete env[name];
    }
  }
  console.log(
    `Running cdxgen with ${analyzer} over ${chenPath}. The build runs in that checkout; the BOM, the report and the log land in ${workDir}. A chen build and analysis take minutes.`,
  );
  const startedAt = Date.now();
  const log = openSync(logFile, "w");
  let result;
  try {
    result = spawnSync(process.execPath, cdxgenArgs, {
      cwd: chenPath,
      env,
      stdio: ["ignore", log, log],
      timeout: args.timeoutMinutes * 60_000,
      killSignal: "SIGKILL",
    });
  } finally {
    closeSync(log);
  }
  const elapsedS = Math.round((Date.now() - startedAt) / 1000);
  if (result.error || result.status !== 0 || !existsSync(bomFile)) {
    const reason = result.error
      ? result.error.code === "ETIMEDOUT"
        ? `did not finish within ${args.timeoutMinutes} minutes`
        : `could not run (${result.error.message})`
      : `exited with status ${result.status ?? `signal ${result.signal}`}`;
    console.error(`cdxgen ${reason} after ${elapsedS}s. Last lines of its log:`);
    console.error(tail(logFile, 40));
    console.error(
      `check-chen: no usable BOM at ${bomFile}; the checks did not run.${args.keep ? "" : " Pass --keep to keep the full log."}`,
    );
    return 1;
  }
  console.log(`cdxgen finished in ${elapsedS}s. Checking the BOM.`);
  let bom;
  try {
    bom = JSON.parse(readFileSync(bomFile, "utf-8"));
  } catch (err) {
    console.error(`check-chen: the BOM at ${bomFile} is not valid JSON (${err.message}).`);
    return 1;
  }
  const report = readJson(reportFile);
  const namespaceMap = readJson(`${bomFile}.map`) || {};
  const lineCounts = new Map();
  const resolver = {
    root: chenPath,
    statFile(path) {
      if (!lineCounts.has(path)) {
        lineCounts.set(path, statFile(path));
      }
      return lineCounts.get(path);
    },
    namespacesOf(component) {
      for (const key of [component.purl, component["bom-ref"]]) {
        const namespaces = key ? namespaceMap[key]?.namespaces : undefined;
        if (namespaces?.length) {
          return namespaces;
        }
      }
      return undefined;
    },
  };
  const rows = runAllChecks(bom, report, resolver, {
    expectedDependencies: args.expected,
  });
  console.log("");
  console.log(
    `${chenPath} at ${gitHead(chenPath) || "an unknown revision"}; scalasem ${report?._meta?.toolVersion || "unknown"}.`,
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
  return failedRows.length ? 1 : 0;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (_err) {
    return undefined;
  }
}

// Whether a file exists, and how many lines it has. An empty file has none,
// and a last line without a newline still counts.
function statFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (_err) {
    return { exists: false };
  }
  if (!text) {
    return { exists: true, lineCount: 0 };
  }
  const newlines = text.split("\n").length - 1;
  return { exists: true, lineCount: newlines + (text.endsWith("\n") ? 0 : 1) };
}

function tail(file, count) {
  try {
    return readFileSync(file, "utf-8").split("\n").slice(-count).join("\n");
  } catch (_err) {
    return "(no log)";
  }
}

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
