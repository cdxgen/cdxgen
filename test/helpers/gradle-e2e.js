/**
 * Shared gating and process helpers for the poku tests that run a real
 * Gradle against a committed fixture. A machine without Gradle, or without
 * a JDK the local Gradle can run, gets a skip reason instead of a failure,
 * mirroring the introspection e2e gating.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GRADLE_JAVA_CAPS } from "../../lib/inventory/jvmToolEnv.js";
import { compareVersions } from "../../lib/inventory/toolRequirements.js";
import {
  childEnv,
  currentRuntime,
  localJavaHomes,
  toolAnswers,
} from "./introspection-e2e.js";

/**
 * Copy a fixture into a scratch directory, so Gradle never writes build
 * state into the committed files.
 *
 * @param {string} fixture Absolute path of the committed fixture
 * @returns {string} Scratch copy path
 */
export function scratchFixture(fixture) {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-gradle-"));
  const target = join(dir, "project");
  cpSync(fixture, target, { recursive: true });
  return target;
}

/**
 * The local Gradle's version and the newest Java major it can run, from the
 * measured compatibility table.
 *
 * @returns {{version: string, maxJava: number|undefined}|undefined} Gradle facts, when a version answered
 */
export function gradleFacts() {
  const probe = spawnSync("gradle", ["--version"], {
    encoding: "utf-8",
    timeout: 60000,
    shell: process.platform === "win32",
  });
  if (probe.status !== 0) {
    return undefined;
  }
  const match = /^Gradle (\d[\d.]*)/m.exec(`${probe.stdout}`);
  if (!match) {
    return undefined;
  }
  let maxJava;
  for (const [major, minimumGradle] of Object.entries(GRADLE_JAVA_CAPS)) {
    if (compareVersions(match[1], minimumGradle) >= 0) {
      maxJava = Number.parseInt(major, 10);
    }
  }
  return { version: match[1], maxJava };
}

/**
 * Decide whether a real Gradle can build the fixture here, and return a
 * spawn helper whose children see a clean cdxgen Gradle environment.
 *
 * The developer's cdxgen GRADLE_* settings (GRADLE_ARGS, GRADLE_CMD, ...)
 * would change what cdxgen runs, so children start from a clean slate.
 * GRADLE_USER_HOME and GRADLE_OPTS are Gradle's own (cache location,
 * proxies) and stay. GRADLE_USE_DAEMON=false keeps runs deterministic and
 * leaves no daemon behind.
 *
 * @param {string} fixture Absolute path of the fixture the probe builds
 * @param {string} minimumGradle Oldest Gradle version the fixture needs
 * @returns {{skipReason: string}|{facts: Object, spawnChild: Function}} A skip reason, or the spawn helper
 */
export function prepareGradleE2e(fixture, minimumGradle = "0") {
  if (!toolAnswers("gradle")) {
    return {
      skipReason: "gradle is not installed; the fixture cannot run here",
    };
  }
  const facts = gradleFacts();
  if (!facts || compareVersions(facts.version, minimumGradle) < 0) {
    return {
      skipReason: `gradle ${facts?.version ?? "?"} is older than ${minimumGradle}; nothing to regress`,
    };
  }
  const javaHome = localJavaHomes()
    .filter(
      (entry) => facts.maxJava !== undefined && entry.major <= facts.maxJava,
    )
    .sort((a, b) => b.major - a.major)[0];
  if (!javaHome) {
    return {
      skipReason: "no local JDK this gradle can run; the fixture cannot run here",
    };
  }
  const keptGradleVars = new Set(["GRADLE_USER_HOME", "GRADLE_OPTS"]);
  // A null value removes the variable from the child.
  const envPatch = Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => name.startsWith("GRADLE_") && !keptGradleVars.has(name))
      .map((name) => [name, null]),
  );
  envPatch.JAVA_HOME = javaHome.home;
  envPatch.GRADLE_USE_DAEMON = "false";
  /**
   * Spawn a child with the patched environment. Deno merges the parent
   * environment into the child instead of honouring the `env` option, so
   * the shared harness applies the patch to this process for the duration
   * of the spawn there.
   *
   * @param {string} command Executable
   * @param {string[]} args Arguments
   * @param {Object} options spawnSync options; `extraEnv` adds variables
   * @returns {Object} spawnSync result
   */
  const spawnChild = (command, args, options = {}) => {
    const { extraEnv, ...spawnOptions } = options;
    const { env, undo } = childEnv(
      { ...envPatch, ...(extraEnv || {}) },
      currentRuntime() === "deno",
    );
    try {
      return spawnSync(command, args, {
        encoding: "utf-8",
        shell: process.platform === "win32",
        ...spawnOptions,
        env,
      });
    } finally {
      undo();
    }
  };
  // Toolchain probe: a plain `help` only fails when the JDK/Gradle pair
  // cannot build the fixture at all.
  const probeProject = scratchFixture(fixture);
  const probe = spawnChild(
    "gradle",
    ["--no-daemon", "--console", "plain", "help"],
    { cwd: probeProject, timeout: 180000 },
  );
  rmSync(join(probeProject, ".."), { recursive: true, force: true });
  if (probe.status !== 0) {
    return {
      skipReason: `the local gradle/JDK pair cannot build the fixture: ${`${probe.stderr || probe.stdout || ""}`.slice(-200)}`,
    };
  }
  return { facts, spawnChild };
}
