/**
 * Shared end-to-end harness for the build-introspection fixture matrix.
 *
 * Introspection runs inside `postProcess`, which only `bin/cdxgen.js` calls,
 * so every assertion about the feature must drive the real CLI; a test built
 * on `createBom` passes while proving nothing. This module generalizes the
 * CLI-spawning harness written for `skill.poku.js` so the fixture-matrix and
 * loop tests import one implementation instead of each carrying a copy.
 *
 * The harness spawns the CLI through the runtime that is executing the test
 * (node, deno, or bun — `POKU_RUNTIME` names one when poku spawned the file),
 * which is what makes the fixture matrix a runtime matrix rather than a
 * node-only suite. Under Deno the child merges the parent environment instead
 * of honouring the `env` option, so degradation variables are applied to this
 * process and restored around each spawn.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, resolved once from this file's location. */
export const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const CDXGEN_BIN = join(repoRoot, "bin", "cdxgen.js");

/** Introspection variables that must never leak between harness runs. */
const INTROSPECTION_ENV_VARS = ["CDXGEN_INTROSPECT", "CDXGEN_INTROSPECT_LEDGER"];

/**
 * The runtime executing the test file.
 *
 * @returns {"node"|"deno"|"bun"} Runtime name.
 */
export function currentRuntime() {
  if (typeof globalThis.Deno?.version?.deno === "string") {
    return "deno";
  }
  if (typeof globalThis.Bun?.version === "string") {
    return "bun";
  }
  return "node";
}

/**
 * Command that runs a JavaScript file under the named runtime. Deno is
 * invoked with a script path — never `deno run -e` — and grants the
 * permissions the CLI needs in one flag.
 *
 * @param {string} script Absolute path of the script to run.
 * @param {string} runtime Runtime to command.
 * @returns {string[]} Command prefix.
 */
export function runtimeCommand(script, runtime) {
  if (runtime === "deno") {
    return [resolveRuntimeBinary("deno"), "run", "-A", script];
  }
  return [resolveRuntimeBinary(runtime), script];
}

/** All harness runs share one queue: scans are heavy, concurrent maven
 * resolution corrupts the shared local repository, and serializing the runs
 * keeps the matrix deterministic under poku's concurrent tests. */
let runQueue = Promise.resolve();

/**
 * Run a step on the shared queue, whether it is a CLI scan or a build action
 * that must not overlap one. Exposed for tests that spawn the CLI directly
 * instead of through {@link runIntrospectionScan}: two concurrent cdxgen
 * processes share the temp dir whose cleanup is not safe to race.
 *
 * @template T
 * @param {() => T|Promise<T>} fn Step to run.
 * @returns {Promise<T>} The step's result.
 */
export async function queueStep(fn) {
  const queued = runQueue.then(fn, fn);
  runQueue = queued.catch(() => {});
  return queued;
}

async function runQueued(fn) {
  return queueStep(fn);
}

/**
 * Command used to run scripts for a runtime. `node` uses the process
 * binary; deno and bun are invoked by bare name, which spawnSync resolves
 * through PATH on POSIX — a shell is only needed on Windows, where the
 * caller must pass one.
 *
 * @param {string} runtime Runtime to resolve.
 * @returns {string} Binary path or name.
 */
export function resolveRuntimeBinary(runtime) {
  if (runtime === "node") {
    return process.execPath;
  }
  if (runtime !== "deno" && runtime !== "bun") {
    throw new Error(`unknown runtime: ${runtime}`);
  }
  return runtime;
}

/**
 * Whether a runtime binary answers on PATH.
 *
 * @param {string} binary Runtime binary name.
 * @returns {boolean} True when the runtime is usable.
 */
export function runtimeAvailable(binary) {
  const result = spawnSync(resolveRuntimeBinary(binary), ["--version"], {
    encoding: "utf-8",
    timeout: 60000,
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

/**
 * Apply an environment patch to this process, returning the previous values
 * so the caller can restore them. A `null` patch value deletes the variable.
 *
 * @param {Object} patch Requested variable values.
 * @returns {Map<string, string|undefined>} Previous values keyed by name.
 */
function applyEnvPatch(patch) {
  const previous = new Map();
  for (const [name, value] of Object.entries(patch)) {
    previous.set(name, process.env[name]);
    if (value === null || value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return previous;
}

/**
 * Restore a previous environment state.
 *
 * @param {Map<string, string|undefined>} previous Values returned by applyEnvPatch.
 * @returns {void}
 */
function restoreEnv(previous) {
  for (const [name, value] of previous.entries()) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

/**
 * Build the child environment for one CLI run: the current environment minus
 * the introspection opt-ins, plus the caller's patch (a `null` value removes
 * a variable). Under Deno the returned object is ignored by the child, so the
 * same patch is applied to this process instead and restored by the caller.
 *
 * @param {Object} env Requested variable overrides.
 * @param {boolean} denoParentEnv True to mutate this process for Deno.
 * @returns {{env: Object, undo: () => void}} Child env and its restore function.
 */
export function childEnv(env, denoParentEnv) {
  const patch = {};
  for (const name of INTROSPECTION_ENV_VARS) {
    patch[name] = null;
  }
  for (const [name, value] of Object.entries(env || {})) {
    patch[name] = value === undefined ? null : value;
  }
  if (!denoParentEnv) {
    const merged = { ...process.env };
    for (const [name, value] of Object.entries(patch)) {
      if (value === null) {
        delete merged[name];
      } else {
        merged[name] = value;
      }
    }
    return { env: merged, undo: () => {} };
  }
  const previous = applyEnvPatch(patch);
  return { env: { ...process.env }, undo: () => restoreEnv(previous) };
}

/**
 * One `bin/cdxgen.js` invocation with `--introspect` on, through the current
 * runtime. The caller decides the degradation by passing environment
 * overrides; the project itself is never modified.
 *
 * @param {Object} options Run options.
 * @param {string} options.projectPath Project directory to scan.
 * @param {string} [options.projectType] Value for `-t`; omitted for auto-detect.
 * @param {string} options.output Path of the BOM file to write.
 * @param {string} [options.reportJsonPath] Where the JSON report lands; defaults next to the BOM.
 * @param {string} [options.reportMdPath] Where the markdown report lands; defaults next to the BOM.
 * @param {Object} [options.env] Environment overrides for the child.
 * @param {string[]} [options.extraArgs] Additional CLI arguments.
 * @param {"node"|"deno"|"bun"} [options.runtime] Run the CLI under this runtime instead of the one executing the test.
 * @param {number} [options.timeoutMs] Spawn timeout, default 10 minutes.
 * @returns {Promise<{status: number|null, stdout: string, stderr: string, report: Object|undefined, bom: Object|undefined}>} Run facts, the parsed `--introspect-json` report when written, and the parsed BOM.
 */
export function runIntrospectionScan(options) {
  const {
    projectPath,
    projectType,
    output,
    reportJsonPath,
    reportMdPath,
    env = {},
    extraArgs = [],
    timeoutMs = 600000,
  } = options;
  const run = () => {
    const runtime = options.runtime || currentRuntime();
    const introspectionJson = reportJsonPath || `${output}.introspection.json`;
    const introspectionMd = reportMdPath || `${output}.introspection.md`;
    const denoParentEnv = runtime === "deno";
    const { env: childEnvValue, undo } = childEnv(env, denoParentEnv);
    try {
      const args = [
        ...runtimeCommand(CDXGEN_BIN, runtime),
        ...(projectType ? ["-t", projectType] : []),
        "--no-install-deps",
        "--introspect",
        ...extraArgs,
        "-o",
        output,
        "--introspect-report",
        introspectionMd,
        "--introspect-json",
        introspectionJson,
        projectPath,
      ];
      const result = spawnSync(args[0], args.slice(1), {
        encoding: "utf-8",
        env: childEnvValue,
        timeout: timeoutMs,
      });
      return {
        status: result.status,
        stdout: `${result.stdout || ""}`,
        stderr: `${result.stderr || ""}`,
        report: existsSync(introspectionJson)
          ? JSON.parse(readFileSync(introspectionJson, "utf-8"))
          : undefined,
        bom: existsSync(output)
          ? JSON.parse(readFileSync(output, "utf-8"))
          : undefined,
      };
    } finally {
      undo();
    }
  };
  return runQueued(run);
}

/**
 * The cdxgen command-override variable for each tool an install action may
 * name. When a tool already answers on PATH, an install action can only mean
 * that a stale override is pinning cdxgen to a dead binary, so executing the
 * action in this sandbox removes the override.
 *
 * @type {Readonly<Record<string, string>>}
 */
const TOOL_CMD_OVERRIDES = Object.freeze({
  java: "JAVA_CMD",
  maven: "MVN_CMD",
  gradle: "GRADLE_CMD",
  node: "NODE_CMD",
  npm: "NPM_CMD",
  python: "PYTHON_CMD",
  ruby: "RUBY_CMD",
  dotnet: "DOTNET_CMD",
  go: "GO_CMD",
  cargo: "CARGO_CMD",
  rustc: "RUSTC_CMD",
  swift: "SWIFT_CMD",
  lein: "LEIN_CMD",
  clj: "CLJ_CMD",
  sbt: "SBT_CMD",
  pod: "POD_CMD",
});

/**
 * Executable a tool's availability is probed with, for tools whose binary
 * name differs from the catalog's tool name.
 *
 * @type {Readonly<Record<string, string>>}
 */
const TOOL_BINARIES = Object.freeze({
  maven: "mvn",
});

/**
 * Directories that may hold installed JDKs, joined with the layout each
 * uses: sdkman and `/usr/lib/jvm` name one directory per JDK, while macOS
 * bundles nest the home under `Contents/Home`.
 *
 * @type {ReadonlyArray<{base: string, macOS: boolean}>}
 */
const JAVA_HOME_BASES = Object.freeze([
  { base: join(homedir(), ".sdkman", "candidates", "java"), macOS: false },
  { base: "/usr/lib/jvm", macOS: false },
  { base: "/Library/Java/JavaVirtualMachines", macOS: true },
]);

/**
 * Discover the locally installed JDK homes and their Java majors, from the
 * `release` file each real JDK carries. Environment-only repairs may point
 * `JAVA_HOME` at one of these; nothing is ever installed.
 *
 * @returns {{major: number, home: string}[]} JDK homes, ordered by discovery.
 */
export function localJavaHomes() {
  const seen = new Set();
  const homes = [];
  for (const { base, macOS } of JAVA_HOME_BASES) {
    if (!existsSync(base)) {
      continue;
    }
    for (const entry of readdirSync(base).sort()) {
      const home = macOS
        ? join(base, entry, "Contents", "Home")
        : join(base, entry);
      if (seen.has(home) || !existsSync(join(home, "release"))) {
        continue;
      }
      const release = readFileSync(join(home, "release"), "utf-8");
      const match = /^JAVA_VERSION="(\d+)/m.exec(release);
      if (match) {
        seen.add(home);
        homes.push({ major: Number.parseInt(match[1], 10), home });
      }
    }
  }
  return homes;
}

/**
 * Extract the version token an install action names, after the report's
 * placeholder resolution: `sdk install java 21` names `21`, while an
 * unresolved `{{version}}` means the run recorded no expectation.
 *
 * @param {string} command The action command.
 * @returns {string|undefined} The named version, when resolved.
 */
function versionFromInstallCommand(command) {
  const tokens = `${command}`.split(" ").filter(Boolean);
  const installAt = tokens.indexOf("install");
  const candidate = installAt >= 0 ? tokens[installAt + 2] : undefined;
  if (!candidate || candidate.includes("{{")) {
    return undefined;
  }
  return candidate;
}

/**
 * Execute the remediation actions a report emitted, as a scripted
 * translation of `actions[]` into sandbox-safe environment fixes. The
 * translation keys on the action's own fields — never on which fixture is
 * being repaired — so a report that proposes unexecutable actions fails the
 * test instead of being silently worked over. The context's `env` object is
 * mutated in place so subsequent runs observe the applied fixes. An `install`
 * action for a tool that already answers on PATH is read as "clear the stale
 * `*_CMD` override" (the sandbox reading of D09's ask-first rule); an
 * `install java` action additionally points `JAVA_HOME` at a local JDK of the
 * requested version when one exists, since installing a JDK environment-only
 * can mean nothing else.
 *
 * @param {Object} entry A `report.remediation[]` entry.
 * @param {Object} context Execution context.
 * @param {string} context.projectDir Project directory build actions run in.
 * @param {Object} [context.env] Live environment overrides for subsequent runs.
 * @returns {Promise<{action: string, executed: boolean, detail?: string}[]>} One record per action.
 */
export async function applyRemediationActions(entry, context) {
  const { projectDir, env = {} } = context;
  const records = [];
  for (const action of entry.actions || []) {
    if (action.kind === "rerun") {
      records.push({ action: "rerun", executed: false, detail: "the caller re-scans" });
      continue;
    }
    if (action.kind === "install" && action.tool === "java") {
      // Installing a JDK environment-only means pointing JAVA_HOME at a JDK
      // of the version the action names, when the machine already has one.
      // A JAVA_HOME in the context is otherwise the stale pin that broke the
      // run, and is cleared the way any other stale override is.
      if (!toolAnswers("java", env) && !localJavaHomes().length) {
        throw new Error(
          `the report's action "${action.command}" cannot be executed in this sandbox: no usable JDK exists and installing one would mutate the machine`,
        );
      }
      const requested = versionFromInstallCommand(action.command);
      const home = requested
        ? localJavaHomes().find((entry) => `${entry.major}` === requested)
        : undefined;
      if (home) {
        env.JAVA_HOME = home.home;
        records.push({
          action: "install:java",
          executed: true,
          detail: `JAVA_HOME set to ${home.home} (JDK ${home.major})`,
        });
        continue;
      }
      if (env.JAVA_HOME !== undefined) {
        delete env.JAVA_HOME;
        records.push({
          action: "install:java",
          executed: false,
          detail: `no local JDK ${requested ?? ""} found; the stale JAVA_HOME override was cleared`,
        });
        continue;
      }
      records.push({
        action: "install:java",
        executed: false,
        detail: "already available, per the ask-first rule",
      });
      continue;
    }
    if (action.kind === "install") {
      if (toolAnswers(action.tool, env)) {
        const override = TOOL_CMD_OVERRIDES[action.tool];
        if (override && env[override] !== undefined) {
          delete env[override];
          records.push({
            action: `${action.kind}:${action.tool}`,
            executed: false,
            detail: `${action.tool} already answers; the stale ${override} override was removed`,
          });
        } else {
          records.push({
            action: `${action.kind}:${action.tool}`,
            executed: false,
            detail: "already available, per the ask-first rule",
          });
        }
      } else {
        throw new Error(
          `the report's action "${action.command}" cannot be executed in this sandbox: ${action.tool} is absent and installing it would mutate the machine`,
        );
      }
      continue;
    }
    if (action.kind === "build" || action.kind === "env" || action.kind === "config") {
      if (action.kind !== "build") {
        throw new Error(
          `the report emitted a ${action.kind} action ("${action.command}") that this harness does not execute; the fix is not achievable environment-only`,
        );
      }
      const [tool, ...args] = `${action.command}`.split(" ").filter(Boolean);
      const result = await runQueued(() =>
        spawnSync(tool, args, {
          cwd: projectDir,
          encoding: "utf-8",
          timeout: 600000,
          shell: process.platform === "win32",
          env: { ...process.env, ...env },
        }),
      );
      if (result.status !== 0) {
        throw new Error(
          `the report's build action failed (${tool} ${args.join(" ")}): ${(result.stderr || result.stdout || "").slice(-400)}`,
        );
      }
      records.push({ action: `${action.kind}:${tool}`, executed: true });
      continue;
    }
    throw new Error(
      `the report emitted a ${action.kind} action the harness cannot execute in this sandbox`,
    );
  }
  return records;
}

/**
 * Whether a tool answers a version probe on the current PATH.
 *
 * @param {string} tool Tool name or binary name.
 * @param {Object} env Environment overrides for the probe.
 * @returns {boolean} True when the tool answered.
 */
export function toolAnswers(tool, env = {}) {
  if (!tool) {
    return false;
  }
  const binary = TOOL_BINARIES[tool] || tool;
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf-8",
    timeout: 60000,
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  return result.status === 0;
}

/**
 * Bom-graph facts for the step-4 assertion that a tier improvement is backed
 * by a real SBOM change.
 *
 * @param {Object} bom Parsed CycloneDX BOM.
 * @returns {{components: number, dependencyNodes: number, dependencyEdges: number}} Graph facts.
 */
export function bomGraphFacts(bom) {
  const dependencies = Array.isArray(bom?.dependencies) ? bom.dependencies : [];
  return {
    components: Array.isArray(bom?.components) ? bom.components.length : 0,
    dependencyNodes: dependencies.length,
    dependencyEdges: dependencies.reduce(
      (total, entry) =>
        total + (Array.isArray(entry?.dependsOn) ? entry.dependsOn.length : 0),
      0,
    ),
  };
}

/**
 * Judge the previous attempt by the report that followed it, which is the
 * verdict the skill insists on: an action's exit code proves nothing, the next
 * report does. The outcome joins the attempt so a `no-change` is never retried
 * at the same inputs.
 *
 * @param {Object} history Loop history document, mutated in place.
 * @param {Object} report The report produced after the attempt.
 * @returns {void}
 */
function recordOutcome(history, report) {
  const attempt = history.attempted[history.attempted.length - 1];
  if (!attempt || attempt.outcome) {
    return;
  }
  const row = (report.ecosystems || []).find(
    (entry) => entry.ecosystem === attempt.ecosystem,
  );
  const rulesCleared = (attempt.verify?.rules || []).every((ruleId) =>
    (row?.tierReasons || []).every((reason) => reason.id !== ruleId),
  );
  const tierReached =
    !attempt.verify?.expectTier || row?.tier === attempt.verify.expectTier;
  attempt.outcome = rulesCleared && tierReached ? "verified" : "no-change";
  attempt.detail = `tier ${row?.tier ?? "ungraded"} against expected ${attempt.verify?.expectTier ?? "any"}`;
}

/**
 * The fidelity loop of `.agents/skills/sbom-fidelity-loop/SKILL.md`,
 * transcribed once for mechanical execution — the matrix tests run *this*
 * loop, so a drift between the skill text and the simulation is a test
 * failure rather than a silent divergence.
 *
 * @param {Object} options Loop options.
 * @param {string} options.projectPath Project directory to scan.
 * @param {string} options.output Path of the BOM file for every iteration.
 * @param {string} [options.projectType] Value for `-t`.
 * @param {string[]} [options.userArgs] The loop's user arguments, verbatim.
 * @param {Object} [options.env] Environment overrides applied to every run.
 * @param {number} [options.maxIterations] Budget, 6 in the skill.
 * @returns {Promise<Object>} The stop condition, the history document, and each iteration's report.
 */
export function runFidelityLoop(options) {
  const {
    projectPath,
    output,
    projectType,
    userArgs = [],
    env = {},
    maxIterations = 6,
  } = options;
  const scratch = mkdtempSync(join(osTmpdir(), "cdxgen-loop-"));
  const reportJson = join(scratch, "report.json");
  const reportMd = join(scratch, "report.md");
  const history = { schemaVersion: "1.0", iterations: [], attempted: [] };
  const iterationReports = [];

  const execute = async () => {
    let iterationArgs = [...userArgs];
    const scan = (envOverrides) =>
      runIntrospectionScan({
        projectPath,
        projectType,
        output,
        reportJsonPath: reportJson,
        reportMdPath: reportMd,
        env: envOverrides,
        extraArgs: iterationArgs,
      });
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const run = await scan(env);
      if (run.status === 1) {
        return {
          stop: "cdxgen-failed",
          detail: "cdxgen failed to generate a BOM; fix the invocation",
          history,
          iterationReports,
        };
      }
      if (!run.report) {
        return {
          stop: "unverifiable",
          detail: "the JSON report was not written",
          history,
          iterationReports,
        };
      }
      const report = run.report;
      iterationReports.push(report);
      recordOutcome(history, report);
      if (report.ledger?.complete === false) {
        // Re-run once with an explicit sidecar before distrusting the verdict.
        const retry = await scan({
          ...env,
          CDXGEN_INTROSPECT_LEDGER: join(scratch, "ledger.jsonl"),
        });
        if (retry.report?.ledger?.complete === false || !retry.report) {
          return {
            stop: "unverifiable",
            detail: "the ledger is incomplete even after the sidecar retry",
            history,
            iterationReports,
          };
        }
        iterationReports.push(retry.report);
        history.iterations.push({
          n: iteration,
          score: retry.report.overall.score,
          tier: retry.report.overall.tier,
          inputsFingerprint: retry.report.inputsFingerprint,
        });
        continue;
      }
      history.iterations.push({
        n: iteration,
        score: report.overall.score,
        tier: report.overall.tier,
        inputsFingerprint: report.inputsFingerprint,
      });

      const attemptedAt = new Set(
        history.attempted
          .filter((attempt) => attempt.inputsFingerprint === report.inputsFingerprint)
          .map((attempt) => attempt.remediationId),
      );
      const candidates = (report.remediation || []).filter(
        (entry) => !entry.blocked && !attemptedAt.has(entry.remediationId),
      );
      const blockedWaiting = (report.remediation || []).filter(
        (entry) => entry.blocked && !attemptedAt.has(entry.remediationId),
      );
      const done = (report.ecosystems || []).every(
        (row) =>
          row.state === "at-ceiling" ||
          row.tier === "resolved" ||
          (row.tier === "lockfile" &&
            !candidates.some((entry) => entry.ecosystem === row.ecosystem)),
      );
      if (done && (!report.gate || report.gate.passed)) {
        return { stop: "success", history, iterationReports };
      }
      if (
        iteration > 1 &&
        report.overall.score <=
          history.iterations[history.iterations.length - 2].score &&
        report.inputsFingerprint ===
          history.iterations[history.iterations.length - 2].inputsFingerprint
      ) {
        return { stop: "stalled", history, iterationReports };
      }
      if (!candidates.length) {
        return blockedWaiting.length
          ? { stop: "blocked", history, iterationReports }
          : { stop: "nothing-further-available", history, iterationReports };
      }
      const candidate = candidates[0];
      if (candidate.actions?.length) {
        await applyRemediationActions(candidate, {
          projectDir: projectPath,
          env,
        });
      } else {
        // Rule-derived entries carry no actions; their fix is the re-scan in
        // which cdxgen itself drives the ecosystem's resolver.
        iterationArgs = [...iterationArgs, "--install-deps"];
      }
      history.attempted.push({
        remediationId: candidate.remediationId,
        inputsFingerprint: report.inputsFingerprint,
        verify: candidate.verify,
        ecosystem: candidate.ecosystem,
        actions: (candidate.actions || []).map(
          (action) => action.command || action.kind,
        ),
      });
    }
    return { stop: "budget-exhausted", history, iterationReports };
  };

  return execute().finally(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
}
