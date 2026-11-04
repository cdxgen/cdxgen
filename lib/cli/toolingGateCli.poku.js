/**
 * End-to-end checks, through bin/cdxgen.js, that the operator's choice about
 * running the scanned project's own build tooling is final (issue #4527).
 *
 * Each scan runs cdxgen as a child process on a tiny Maven project that plants
 * the `.mvn/jvm.config` payload of the issue, with a stand-in mvn first on
 * PATH that records every run. A config file in the scanned project, a
 * profile, the post-build lifecycle and the `cdxgen-secure` command must not
 * start mvn once installs are off. Every negative test has a positive control
 * that differs only in the operator's choice, so a negative test cannot pass
 * just because the stand-in was never reachable.
 *
 * mvn is spawned with `shell: isWin`, so on Windows the stand-in is a .cmd
 * script that cmd.exe finds through PATHEXT.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assert, it } from "poku";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const cdxgenBin = path.join(repoRoot, "bin", "cdxgen.js");
const isWin = process.platform === "win32";

const POM =
  "<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>demo</artifactId><version>1.0.0</version><dependencies><dependency><groupId>com.example</groupId><artifactId>demo-lib</artifactId><version>1.0.0</version></dependency></dependencies></project>";

// Variables that would pick a Maven other than the stand-in, or change what
// the child scan does, beyond the CDXGEN_* ones (all of which are dropped:
// yargs reads every CDXGEN_* variable as an option).
const SCRUBBED_ENV = new Set([
  "MAVEN_HOME",
  "M2_HOME",
  "MVN_CMD",
  "MAVEN_CMD",
  "MVN_ARGS",
  "MAVEN_ARGS",
  "MAVEN_CACHE_DIR",
  "JAVA_TOOL_OPTIONS",
  "FETCH_LICENSE",
  // High findings of the environment audit end a secure-mode scan before it
  // reaches Maven; npx, for one, sets NODE_PATH.
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "JDK_JAVA_OPTIONS",
  "GRADLE_ARGS",
  "BAZEL_ARGS",
  "DENO_CERT",
  "HOME",
  "USERPROFILE",
  "PATH",
]);

const SKIP_MAVEN_MESSAGE =
  "Skipping Maven since dependency installation is disabled";

/**
 * Write a stand-in that appends `<cwd> @@ <args>` to `log` and exits 1.
 *
 * @param {string} binDir Directory placed first on PATH
 * @param {string} name Tool name without extension
 * @param {string} log File each run appends to
 */
function writeStandIn(binDir, name, log) {
  if (isWin) {
    writeFileSync(
      path.join(binDir, `${name}.cmd`),
      ["@echo off", `>>"${log}" echo %CD% @@ %*`, "exit /b 1", ""].join("\r\n"),
    );
    return;
  }
  const tool = path.join(binDir, name);
  writeFileSync(
    tool,
    `#!/bin/sh\nprintf '%s @@ %s\\n' "$(pwd -P)" "$*" >> ${JSON.stringify(log)}\nexit 1\n`,
  );
  chmodSync(tool, 0o755);
}

/**
 * The runs a stand-in recorded, or an empty list when it never ran.
 *
 * @param {string} log Stand-in log file
 * @returns {{cwd: string, args: string}[]}
 */
function standInRuns(log) {
  let text;
  try {
    text = readFileSync(log, "utf-8");
  } catch (_err) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const at = line.indexOf(" @@");
      return at === -1
        ? { cwd: "", args: line.trim() }
        : { cwd: line.slice(0, at).trim(), args: line.slice(at + 3).trim() };
    });
}

/**
 * Remove a scratch directory. On Windows a ledger sidecar can still be open
 * for a moment after the child exits.
 *
 * @param {string} root Directory to remove
 */
function removeScratch(root) {
  try {
    rmSync(root, { force: true, recursive: true, maxRetries: 3 });
  } catch (err) {
    if (err?.code !== "EBUSY" && !(isWin && err?.code === "EPERM")) {
      throw err;
    }
  }
}

/**
 * Create a Maven project with the issue's `.mvn/jvm.config` payload, an empty
 * home, a private temp directory and a stand-in mvn.
 *
 * @param {string} prefix Scratch directory prefix
 * @returns {{root: string, project: string, binDir: string, home: string, tmp: string, log: string}}
 */
function setupScratch(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const project = path.join(root, "project");
  const binDir = path.join(root, "bin");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const log = path.join(root, "mvn-runs.txt");
  mkdirSync(path.join(project, ".mvn"), { recursive: true });
  mkdirSync(binDir);
  mkdirSync(home);
  mkdirSync(tmp);
  writeFileSync(path.join(project, "pom.xml"), POM);
  writeFileSync(
    path.join(project, ".mvn", "jvm.config"),
    "-javaagent:.mvn/agent.jar\n",
  );
  writeStandIn(binDir, "mvn", log);
  return { root, project, binDir, home, tmp, log };
}

/**
 * Run cdxgen as a child process with the stand-in mvn first on PATH.
 *
 * @param {Object} scratch Result of setupScratch
 * @param {string[]} args Scan arguments, without the output and the path
 * @param {Object} [opts]
 * @param {string} [opts.cwd] Working directory (default: the repository)
 * @param {Object} [opts.env] Extra environment for the child
 * @param {string} [opts.entry] Script to run (default: bin/cdxgen.js)
 * @returns {{status: number|null, output: string, runs: {cwd: string, args: string}[]}}
 */
function runCdxgen(scratch, args, opts = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("CDXGEN_") || SCRUBBED_ENV.has(upper)) {
      continue;
    }
    env[name] = value;
  }
  const searchPath = process.env.PATH ?? process.env.Path ?? "";
  Object.assign(env, {
    PATH: [scratch.binDir, searchPath].filter(Boolean).join(path.delimiter),
    HOME: scratch.home,
    USERPROFILE: scratch.home,
    CDXGEN_NO_CACHE: "true",
    CDXGEN_TEMP_DIR: scratch.tmp,
    // Keeps the license lookups of the ml profile off the network.
    CDXGEN_ALLOWED_HOSTS: "cdxgen-tooling-gate.invalid",
    // Secure mode refuses to run as root outside the cdxgen container image,
    // which would end the scan before the Maven step.
    ...(process.getuid?.() === 0 ? { CDXGEN_IN_CONTAINER: "true" } : {}),
    ...(opts.env || {}),
  });
  const result = spawnSync(
    process.execPath,
    [
      opts.entry || cdxgenBin,
      ...args,
      "-o",
      path.join(scratch.root, "bom.json"),
      "--no-banner",
      "--no-validate",
      scratch.project,
    ],
    {
      cwd: opts.cwd || repoRoot,
      encoding: "utf-8",
      env,
      timeout: 2 * 60 * 1000,
    },
  );
  return {
    status: result.status,
    output: `${result.stdout || ""}\n${result.stderr || ""}`,
    runs: standInRuns(scratch.log),
  };
}

/**
 * Assert a condition. poku prints the message of passing assertions too, so
 * the scan output is appended only when the assertion fails.
 *
 * @param {boolean} condition Expected to be true
 * @param {string} message What is expected
 * @param {string} detail Shown on failure
 */
function expectOk(condition, message, detail) {
  assert.ok(condition, condition ? message : `${message}\n${detail}`);
}

/**
 * Assert that the scan finished, reached the Maven step and did not start mvn.
 *
 * @param {{status: number|null, output: string, runs: Object[]}} result Scan result
 * @param {string} expectation What the test expects, e.g. "secure mode keeps mvn off"
 */
function assertMavenSkipped(result, expectation) {
  expectOk(result.status === 0, "the scan finishes", result.output);
  expectOk(
    result.runs.length === 0,
    expectation,
    `mvn runs: ${JSON.stringify(result.runs, null, 2)}`,
  );
  expectOk(
    result.output.includes(SKIP_MAVEN_MESSAGE),
    "the scan reaches the Maven step and reports the skip",
    result.output,
  );
}

/**
 * Assert that the stand-in mvn ran.
 *
 * @param {{output: string, runs: {cwd: string, args: string}[]}} result Scan result
 */
function assertMavenRan(result) {
  expectOk(
    result.runs.some((run) => run.args.includes("dependency:")),
    "the stand-in mvn runs",
    result.output,
  );
}

// a. Secure mode: a config file in the scanned project cannot turn installs on.

await it("secure mode: install-deps from the project's .cdxgen.yml does not start mvn", () => {
  const scratch = setupScratch("cdxgen-cli-gate-secure-config-");
  try {
    writeFileSync(
      path.join(scratch.project, ".cdxgen.yml"),
      "install-deps: true\n",
    );
    const result = runCdxgen(scratch, ["-t", "java"], {
      cwd: scratch.project,
      env: { CDXGEN_SECURE_MODE: "true" },
    });
    expectOk(
      result.output.includes("sets 'install-deps'"),
      "cdxgen reads the project's config file",
      result.output,
    );
    assertMavenSkipped(
      result,
      "the config file does not turn installs on in secure mode",
    );
  } finally {
    removeScratch(scratch.root);
  }
});

await it("secure mode: --install-deps on the command line still starts mvn (positive control)", () => {
  const scratch = setupScratch("cdxgen-cli-gate-secure-flag-");
  try {
    const result = runCdxgen(scratch, ["-t", "java", "--install-deps"], {
      cwd: scratch.project,
      env: { CDXGEN_SECURE_MODE: "true" },
    });
    assertMavenRan(result);
  } finally {
    removeScratch(scratch.root);
  }
});

// b. Introspection asked for only by the project's config file does not keep
// the project's tooling on.

await it("introspect from the project's .cdxgenrc does not start mvn with --no-install-deps", () => {
  const scratch = setupScratch("cdxgen-cli-gate-rc-introspect-");
  try {
    writeFileSync(
      path.join(scratch.project, ".cdxgenrc"),
      JSON.stringify({ introspect: true }),
    );
    const result = runCdxgen(scratch, ["-t", "java", "--no-install-deps"], {
      cwd: scratch.project,
    });
    expectOk(
      result.output.includes("sets 'introspect'"),
      "cdxgen reads the project's config file",
      result.output,
    );
    assertMavenSkipped(
      result,
      "introspection from the config file does not keep mvn on",
    );
  } finally {
    removeScratch(scratch.root);
  }
});

await it("--introspect on the command line still starts mvn with --no-install-deps (positive control)", () => {
  const scratch = setupScratch("cdxgen-cli-gate-flag-introspect-");
  try {
    // The same config file stays in place: only the operator's flag differs.
    writeFileSync(
      path.join(scratch.project, ".cdxgenrc"),
      JSON.stringify({ introspect: true }),
    );
    const result = runCdxgen(
      scratch,
      ["-t", "java", "--no-install-deps", "--introspect"],
      { cwd: scratch.project },
    );
    assertMavenRan(result);
  } finally {
    removeScratch(scratch.root);
  }
});

// c. A profile may skip installs but never turn them back on.

await it("--profile ml does not turn installs back on after --no-install-deps", () => {
  const scratch = setupScratch("cdxgen-cli-gate-ml-off-");
  try {
    const result = runCdxgen(scratch, [
      "-t",
      "java",
      "--no-install-deps",
      "--profile",
      "ml",
    ]);
    assertMavenSkipped(result, "the ml profile keeps installs off");
  } finally {
    removeScratch(scratch.root);
  }
});

await it("--profile ml still starts mvn when installs stay on (positive control)", () => {
  const scratch = setupScratch("cdxgen-cli-gate-ml-on-");
  try {
    const result = runCdxgen(scratch, ["-t", "java", "--profile", "ml"]);
    assertMavenRan(result);
  } finally {
    removeScratch(scratch.root);
  }
});

// d. The post-build lifecycle keeps a disabled install disabled. Post-build
// accepts a scan whose first type supports it; csharp itself then reads
// binaries only (createCsharpBom hands post-build to createBinaryBom and never
// starts dotnet), so the Maven project of the same scan is what would run.

await it("--lifecycle post-build does not turn installs back on after --no-install-deps", () => {
  const scratch = setupScratch("cdxgen-cli-gate-postbuild-off-");
  try {
    const result = runCdxgen(scratch, [
      "-t",
      "csharp",
      "-t",
      "java",
      "--lifecycle",
      "post-build",
      "--no-install-deps",
    ]);
    assertMavenSkipped(result, "post-build keeps installs off");
  } finally {
    removeScratch(scratch.root);
  }
});

await it("--lifecycle post-build still starts mvn when installs stay on (positive control)", () => {
  const scratch = setupScratch("cdxgen-cli-gate-postbuild-on-");
  try {
    const result = runCdxgen(scratch, [
      "-t",
      "csharp",
      "-t",
      "java",
      "--lifecycle",
      "post-build",
    ]);
    assertMavenRan(result);
  } finally {
    removeScratch(scratch.root);
  }
});

// e. The cdxgen-secure command turns secure mode on after the modules load, so
// --introspect must not reopen the project's tooling. The command name comes
// from the basename of process.argv[1], so the scan runs through a symlink
// with that name (node resolves the real path of the main module, so its
// relative imports still load). Creating symlinks on Windows needs privileges.

const symlinkIt = isWin
  ? (title, cb) =>
      it.skip(
        `${title} [skipped on Windows: creating the command symlink needs symlink privileges]`,
        cb,
      )
  : it;

/**
 * Scan through a symlink to bin/cdxgen.js with the given command name.
 *
 * @param {string} commandName Symlink name
 * @param {string} prefix Scratch directory prefix
 * @returns {{status: number|null, output: string, runs: Object[]}}
 */
function scanThroughCommand(commandName, prefix) {
  const scratch = setupScratch(prefix);
  try {
    const linkDir = path.join(scratch.root, "commands");
    mkdirSync(linkDir);
    const entry = path.join(linkDir, commandName);
    symlinkSync(cdxgenBin, entry);
    return runCdxgen(scratch, ["-t", "java", "--introspect"], { entry });
  } finally {
    removeScratch(scratch.root);
  }
}

await symlinkIt("cdxgen-secure with --introspect does not start mvn", () => {
  const result = scanThroughCommand(
    "cdxgen-secure",
    "cdxgen-cli-gate-secure-cmd-",
  );
  expectOk(
    result.output.includes("NOTE: Secure mode only restricts cdxgen"),
    "the scan runs as cdxgen-secure",
    result.output,
  );
  assertMavenSkipped(
    result,
    "cdxgen-secure keeps mvn off despite --introspect",
  );
});

await symlinkIt(
  "the same scan through a plain cdxgen command starts mvn (positive control)",
  () => {
    const result = scanThroughCommand("cdxgen", "cdxgen-cli-gate-plain-cmd-");
    assertMavenRan(result);
  },
);
