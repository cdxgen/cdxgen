#!/usr/bin/env node
/**
 * Vue.js SBOM Precision Evaluation Script
 *
 * Measures the precision improvement of cdxgen's Vue.js component-scope
 * detection between a baseline (pre-vite-config-parsing) and an enhanced
 * (current branch) version by comparing `required` vs `optional` scope
 * assignments across a set of sample Vue.js applications.
 *
 * Two comparison modes are supported:
 *
 *   1. ASTGEN simulation (default, no network required)
 *      Sets ASTGEN_IGNORE_FILE_PATTERN to the old regex so that
 *      vite.config.* / vue.config.* files are excluded from analysis,
 *      approximating master behaviour for the file-ignore half of the change.
 *
 *   2. Side-by-side cdxgen binary comparison (--baseline-cdxgen <dir>)
 *      Runs two cdxgen installations (baseline + current) against every
 *      sample app and diffs the resulting BOM files.  Use this mode to get
 *      a fully accurate comparison including the parseVueConfigFiles change.
 *
 * Usage:
 *   node index.js [options]
 *
 * Options:
 *   --apps-dir <dir>         Directory of local Vue apps to scan.
 *                            Defaults to test/data inside the cdxgen repo.
 *   --baseline-cdxgen <dir>  Path to a baseline cdxgen installation.
 *                            When omitted, ASTGEN simulation mode is used.
 *   --output-dir <dir>       Where to write per-app BOM JSON files.
 *                            Defaults to /tmp/vue-precision-eval.
 *   --samples <file>         Path to a JSON array of sample app descriptors.
 *                            Defaults to samples.json next to this script.
 *   --clone-samples          Clone remote samples listed in samples.json
 *                            before evaluating.  Requires git and internet.
 *   --help                   Show this message and exit.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Locate the script root and cdxgen root
// ---------------------------------------------------------------------------

let _url = import.meta?.url;
if (_url && !_url.startsWith("file://")) {
  _url = new URL(`file://${import.meta.url}`).toString();
}
const SCRIPT_DIR = _url ? dirname(fileURLToPath(_url)) : process.cwd();
const CDXGEN_ROOT = resolve(SCRIPT_DIR, "../..");
const CDXGEN_BIN = join(CDXGEN_ROOT, "bin", "cdxgen.js");

// ---------------------------------------------------------------------------
// Old ASTGEN_IGNORE_FILE_PATTERN (pre-vite-config-fix)
// ---------------------------------------------------------------------------
const OLD_IGNORE_PATTERN =
  "(conf|config|test|spec|mock|setup-jest|\\.d)\\.(js|ts|tsx)$";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    appsDir: null,
    baselineCdxgen: null,
    outputDir: join("/tmp", "vue-precision-eval"),
    samplesFile: join(SCRIPT_DIR, "samples.json"),
    cloneSamples: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--apps-dir":
        args.appsDir = resolve(argv[++i]);
        break;
      case "--baseline-cdxgen":
        args.baselineCdxgen = resolve(argv[++i]);
        break;
      case "--output-dir":
        args.outputDir = resolve(argv[++i]);
        break;
      case "--samples":
        args.samplesFile = resolve(argv[++i]);
        break;
      case "--clone-samples":
        args.cloneSamples = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function runCdxgen(cdxgenBin, appDir, outputFile, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [cdxgenBin, "-t", "js", "--no-recurse", "-o", outputFile, appDir],
    {
      encoding: "utf-8",
      env: { ...process.env, ...extraEnv },
      timeout: 120_000,
    },
  );
  return result;
}

function readBom(bomFile) {
  if (!existsSync(bomFile)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(bomFile, "utf-8"));
  } catch {
    return null;
  }
}

/** Returns a map of { "group/name" -> scope } from a BOM object. */
function scopeMap(bom) {
  const map = {};
  for (const c of bom?.components ?? []) {
    const key = c.group ? `${c.group}/${c.name}` : c.name;
    map[key] = c.scope ?? "unset";
  }
  return map;
}

/** Summarise scope counts from a BOM object. */
function scopeCounts(bom) {
  const counts = { required: 0, optional: 0, excluded: 0, unset: 0 };
  for (const c of bom?.components ?? []) {
    const s = c.scope ?? "unset";
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

function gitClone(name, repoUrl, commit, cloneDir) {
  console.log(`  Cloning ${name} …`);
  const repoDir = join(cloneDir, name);
  if (existsSync(repoDir)) {
    console.log(`  Already exists at ${repoDir}, skipping clone.`);
    return repoDir;
  }
  let res = spawnSync("git", ["clone", "--depth", "1", repoUrl, repoDir], {
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error(`  Failed to clone ${repoUrl}`);
    return null;
  }
  if (commit) {
    res = spawnSync("git", ["checkout", commit], {
      encoding: "utf-8",
      cwd: repoDir,
      stdio: "inherit",
    });
    if (res.status !== 0) {
      console.warn(`  Warning: could not checkout ${commit}`);
    }
  }
  return repoDir;
}

// ---------------------------------------------------------------------------
// Print helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function printHeader(text) {
  console.log(`\n${BOLD}${CYAN}${"═".repeat(60)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${text}${RESET}`);
  console.log(`${BOLD}${CYAN}${"═".repeat(60)}${RESET}`);
}

function printSectionHeader(text) {
  console.log(`\n${BOLD}── ${text} ──${RESET}`);
}

// ---------------------------------------------------------------------------
// Evaluate a single app
// ---------------------------------------------------------------------------

function evaluateApp(appName, appDir, outputDir, baselineCdxgen) {
  const appOut = join(outputDir, appName);
  mkdirSync(appOut, { recursive: true });

  const enhancedBomFile = join(appOut, "enhanced.bom.json");
  const baselineBomFile = join(appOut, "baseline.bom.json");

  // --- Run enhanced (current branch) ---
  process.stdout.write(`  Running enhanced cdxgen … `);
  const enhancedResult = runCdxgen(CDXGEN_BIN, appDir, enhancedBomFile);
  if (enhancedResult.status !== 0 && enhancedResult.status !== null) {
    console.log(`${YELLOW}exit ${enhancedResult.status}${RESET}`);
  } else {
    console.log(`${GREEN}done${RESET}`);
  }

  // --- Run baseline ---
  if (baselineCdxgen) {
    const baselineBin = join(baselineCdxgen, "bin", "cdxgen.js");
    process.stdout.write(`  Running baseline cdxgen  … `);
    const baselineResult = runCdxgen(baselineBin, appDir, baselineBomFile);
    if (baselineResult.status !== 0 && baselineResult.status !== null) {
      console.log(`${YELLOW}exit ${baselineResult.status}${RESET}`);
    } else {
      console.log(`${GREEN}done${RESET}`);
    }
  } else {
    // ASTGEN simulation: re-run the current branch with the old ignore pattern.
    // NOTE: This approximates only the IGNORE_FILE_PATTERN half of the change.
    // The parseVueConfigFiles enhancement (CSS additionalData scanning) runs in
    // both the enhanced and simulated-baseline runs, so its contribution is NOT
    // reflected in the delta produced by this mode.  Use --baseline-cdxgen for
    // a fully accurate comparison that covers both improvements.
    process.stdout.write(
      `  Simulating baseline (ASTGEN_IGNORE_FILE_PATTERN) … `,
    );
    const simResult = runCdxgen(CDXGEN_BIN, appDir, baselineBomFile, {
      ASTGEN_IGNORE_FILE_PATTERN: OLD_IGNORE_PATTERN,
    });
    if (simResult.status !== 0 && simResult.status !== null) {
      console.log(`${YELLOW}exit ${simResult.status}${RESET}`);
    } else {
      console.log(`${GREEN}done${RESET}`);
    }
  }

  const enhanced = readBom(enhancedBomFile);
  const baseline = readBom(baselineBomFile);

  if (!enhanced || !baseline) {
    console.log(`  ${YELLOW}⚠ Could not read BOM files — skipping.${RESET}`);
    return null;
  }

  const enhancedCounts = scopeCounts(enhanced);
  const baselineCounts = scopeCounts(baseline);
  const enhancedScopes = scopeMap(enhanced);
  const baselineScopes = scopeMap(baseline);

  // Find reclassified packages (optional/unset → required)
  const improvedPackages = [];
  const regressedPackages = [];

  const allPkgs = new Set([
    ...Object.keys(enhancedScopes),
    ...Object.keys(baselineScopes),
  ]);

  for (const pkg of allPkgs) {
    const before = baselineScopes[pkg] ?? "unset";
    const after = enhancedScopes[pkg] ?? "unset";
    if (before !== "required" && after === "required") {
      improvedPackages.push({ pkg, before, after });
    } else if (before === "required" && after !== "required") {
      regressedPackages.push({ pkg, before, after });
    }
  }

  const totalComponents =
    (enhanced.components?.length ?? 0) || 1; // avoid /0
  const baselineRequired = baselineCounts.required ?? 0;
  const enhancedRequired = enhancedCounts.required ?? 0;
  const delta = enhancedRequired - baselineRequired;
  const precisionDelta = ((delta / totalComponents) * 100).toFixed(1);

  return {
    appName,
    appDir,
    enhanced: enhancedCounts,
    baseline: baselineCounts,
    improvedPackages,
    regressedPackages,
    delta,
    precisionDelta,
    totalComponents,
    enhancedBomFile,
    baselineBomFile,
  };
}

// ---------------------------------------------------------------------------
// Print a single app result
// ---------------------------------------------------------------------------

function printAppResult(result) {
  if (!result) return;

  const {
    appName,
    enhanced,
    baseline,
    improvedPackages,
    regressedPackages,
    delta,
    precisionDelta,
    totalComponents,
  } = result;

  printSectionHeader(appName);

  console.log(
    `  ${"Package".padEnd(20)} ${"Baseline scope".padEnd(16)} Enhanced scope`,
  );
  console.log(`  ${"─".repeat(52)}`);

  const allPkgs = [
    ...new Set([
      ...Object.keys(scopeMap(readBom(result.baselineBomFile) ?? {})),
      ...Object.keys(scopeMap(readBom(result.enhancedBomFile) ?? {})),
    ]),
  ].sort();

  const baselineScopes = scopeMap(readBom(result.baselineBomFile) ?? {});
  const enhancedScopes = scopeMap(readBom(result.enhancedBomFile) ?? {});

  for (const pkg of allPkgs) {
    const before = baselineScopes[pkg] ?? "—";
    const after = enhancedScopes[pkg] ?? "—";
    let indicator = "  ";
    let color = RESET;
    if (before !== "required" && after === "required") {
      indicator = "↑ ";
      color = GREEN;
    } else if (before === "required" && after !== "required") {
      indicator = "↓ ";
      color = RED;
    }
    console.log(
      `${color}  ${indicator}${pkg.padEnd(20)} ${before.padEnd(16)} ${after}${RESET}`,
    );
  }

  console.log();
  console.log(
    `  Baseline : required=${baseline.required ?? 0}  optional=${baseline.optional ?? 0}  excluded=${baseline.excluded ?? 0}`,
  );
  console.log(
    `  Enhanced : required=${enhanced.required ?? 0}  optional=${enhanced.optional ?? 0}  excluded=${enhanced.excluded ?? 0}`,
  );
  console.log(`  Total components   : ${totalComponents}`);

  const deltaColor = delta > 0 ? GREEN : delta < 0 ? RED : RESET;
  const sign = delta >= 0 ? "+" : "";
  console.log(
    `  ${deltaColor}Required-scope delta : ${sign}${delta} packages (${sign}${precisionDelta}%)${RESET}`,
  );

  if (improvedPackages.length > 0) {
    console.log(
      `  ${GREEN}Newly required  : ${improvedPackages.map((p) => p.pkg).join(", ")}${RESET}`,
    );
  }
  if (regressedPackages.length > 0) {
    console.log(
      `  ${RED}Lost required   : ${regressedPackages.map((p) => p.pkg).join(", ")}${RESET}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Print summary table
// ---------------------------------------------------------------------------

function printSummary(results) {
  printHeader("Overall Precision Summary");

  let totalDelta = 0;
  let totalComponents = 0;
  let totalBaselineRequired = 0;
  let totalEnhancedRequired = 0;
  let appsWithImprovement = 0;

  console.log(
    `\n  ${"App".padEnd(30)} ${"Base Req".padEnd(10)} ${"Enh Req".padEnd(10)} Delta`,
  );
  console.log(`  ${"─".repeat(60)}`);

  for (const r of results) {
    if (!r) continue;
    const bReq = r.baseline.required ?? 0;
    const eReq = r.enhanced.required ?? 0;
    const d = eReq - bReq;
    const sign = d >= 0 ? "+" : "";
    const color = d > 0 ? GREEN : d < 0 ? RED : RESET;
    console.log(
      `  ${r.appName.padEnd(30)} ${String(bReq).padEnd(10)} ${String(eReq).padEnd(10)} ${color}${sign}${d}${RESET}`,
    );
    totalDelta += d;
    totalComponents += r.totalComponents;
    totalBaselineRequired += bReq;
    totalEnhancedRequired += eReq;
    if (d > 0) appsWithImprovement++;
  }

  console.log(`  ${"─".repeat(60)}`);
  const sign = totalDelta >= 0 ? "+" : "";
  const color = totalDelta > 0 ? GREEN : totalDelta < 0 ? RED : RESET;
  console.log(
    `  ${"TOTAL".padEnd(30)} ${String(totalBaselineRequired).padEnd(10)} ${String(totalEnhancedRequired).padEnd(10)} ${color}${BOLD}${sign}${totalDelta}${RESET}`,
  );

  const overallPrecisionDelta =
    totalComponents > 0
      ? ((totalDelta / totalComponents) * 100).toFixed(1)
      : "0.0";

  console.log();
  console.log(`  Apps evaluated        : ${results.filter(Boolean).length}`);
  console.log(`  Apps improved         : ${appsWithImprovement}`);
  console.log(`  Total components      : ${totalComponents}`);
  console.log(
    `  ${color}${BOLD}Required-scope delta  : ${sign}${totalDelta} components (${sign}${overallPrecisionDelta}% of total)${RESET}`,
  );
}

// ---------------------------------------------------------------------------
// Build default local sample list from the repo's test/data directory
// ---------------------------------------------------------------------------

function defaultLocalSamples() {
  const testDataDir = join(CDXGEN_ROOT, "test", "data");
  const vueDirs = [
    join(testDataDir, "vue-repotest"),
    join(testDataDir, "vue-scss-app"),
  ];
  return vueDirs
    .filter((d) => existsSync(d))
    .map((d) => ({ name: basename(d), local: true, path: d }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf-8").split("\n").slice(1, 40).filter((l) => l.startsWith(" *")).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
    process.exit(0);
  }

  mkdirSync(args.outputDir, { recursive: true });

  // Load samples
  let samples = [];
  if (existsSync(args.samplesFile)) {
    try {
      samples = JSON.parse(readFileSync(args.samplesFile, "utf-8"));
    } catch (e) {
      console.error(`Failed to parse samples file: ${e.message}`);
    }
  }

  // Always include built-in local fixtures
  const localSamples = defaultLocalSamples();

  // Merge: give local samples their filesystem path from defaultLocalSamples()
  const localByName = {};
  for (const ls of localSamples) {
    localByName[ls.name] = ls;
  }
  for (const s of samples) {
    if (s.local && !s.path && localByName[s.name]) {
      s.path = localByName[s.name].path;
    }
  }
  // Add any local fixtures not already listed in samples.json
  for (const ls of localSamples) {
    if (!samples.some((s) => s.name === ls.name)) {
      samples.unshift(ls);
    }
  }

  if (samples.length === 0) {
    console.error("No samples found.  Provide a --samples file or ensure test/data/vue-* fixtures exist.");
    process.exit(1);
  }

  // Optionally clone remote samples
  const cloneDir = join(args.outputDir, "_repos");
  if (args.cloneSamples) {
    mkdirSync(cloneDir, { recursive: true });
    for (const sample of samples) {
      if (!sample.local && sample.repoUrl && !sample.path) {
        const cloned = gitClone(sample.name, sample.repoUrl, sample.commit, cloneDir);
        if (cloned) {
          sample.path = cloned;
        }
      }
    }
  }

  printHeader("Vue.js SBOM Precision Evaluation");

  const mode = args.baselineCdxgen
    ? `Side-by-side (baseline: ${args.baselineCdxgen})`
    : "ASTGEN simulation (baseline: old ASTGEN_IGNORE_FILE_PATTERN)";
  console.log(`\n  Mode    : ${mode}`);
  console.log(`  Output  : ${args.outputDir}`);
  console.log(`  Samples : ${samples.length}`);

  const results = [];

  for (const sample of samples) {
    const appDir = sample.path ?? (args.appsDir ? join(args.appsDir, sample.name) : null);

    if (!appDir || !existsSync(appDir)) {
      console.log(`\n  ⚠ Skipping '${sample.name}': directory not found (${appDir ?? "no path"}).`);
      if (!sample.local && !args.cloneSamples) {
        console.log("    Pass --clone-samples to automatically clone remote samples.");
      }
      results.push(null);
      continue;
    }

    console.log(`\n  Evaluating: ${BOLD}${sample.name}${RESET}  (${appDir})`);

    const result = evaluateApp(
      sample.name,
      appDir,
      args.outputDir,
      args.baselineCdxgen,
    );

    printAppResult(result);
    results.push(result);
  }

  printSummary(results);

  // Write machine-readable report
  const reportFile = join(args.outputDir, "precision-report.json");
  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.baselineCdxgen ? "side-by-side" : "astgen-simulation",
    baselineCdxgen: args.baselineCdxgen ?? null,
    results: results.filter(Boolean).map((r) => ({
      appName: r.appName,
      appDir: r.appDir,
      baseline: r.baseline,
      enhanced: r.enhanced,
      improvedPackages: r.improvedPackages,
      regressedPackages: r.regressedPackages,
      delta: r.delta,
      precisionDelta: r.precisionDelta,
      totalComponents: r.totalComponents,
    })),
  };
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\n  Machine-readable report saved to ${BOLD}${reportFile}${RESET}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
