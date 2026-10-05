/**
 * Issue #4444: a project that enables Gradle's isolated-projects mode from
 * `gradle.properties` (okhttp does, together with the configuration cache)
 * fails cdxgen's init script at configuration time, so the BOM silently
 * loses every Gradle component while cdxgen still exits zero.
 *
 * `buildGradleCommandArguments` answers by forcing that evaluation model off
 * on every invocation cdxgen makes. These rows pin the behavior against a
 * real Gradle, using the committed fixture
 * `test/repotests/gradle-isolated-projects`:
 *
 * - the `properties` invocation cdxgen itself constructs, init script
 *   included, must exit zero; without the overrides it fails on every
 *   Gradle that supports isolated projects (8.6 through 9.x);
 * - the CLI must resolve the fixture's components into the BOM, which is
 *   the regression the issue reported (an empty BOM).
 *
 * Both rows need a Gradle of 8.6 or newer and a JDK it can run; machines
 * without the pair skip, mirroring the introspection e2e gating.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { assert, describe, it } from "poku";

import {
  childEnv,
  currentRuntime,
  localJavaHomes,
  repoRoot,
  runtimeCommand,
  toolAnswers,
} from "../../test/helpers/introspection-e2e.js";
import { GRADLE_JAVA_CAPS } from "../inventory/jvmToolEnv.js";
import { compareVersions } from "../inventory/toolRequirements.js";
import {
  buildGradleCommandArguments,
  getGradleCommand,
} from "./gradleutils.js";

const FIXTURE = join(repoRoot, "test", "repotests", "gradle-isolated-projects");

/**
 * Copy the fixture into a scratch directory, so Gradle never writes build
 * state into the committed files.
 *
 * @returns {string} Scratch copy path.
 */
function scratchFixture() {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-iso-"));
  const target = join(dir, "project");
  cpSync(FIXTURE, target, { recursive: true });
  return target;
}

/**
 * The local Gradle's version and the newest Java major it can run, from the
 * measured compatibility table.
 *
 * @returns {{version: string, maxJava: number|undefined}|undefined} Gradle facts, when a version answered.
 */
function gradleFacts() {
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

describe("gradle invocations survive a project that enables isolated projects (issue #4444)", () => {
  if (!toolAnswers("gradle")) {
    it.skip("gradle is not installed; the fixture cannot run here");
    return;
  }
  const facts = gradleFacts();
  if (!facts || compareVersions(facts.version, "8.6") < 0) {
    it.skip(
      `gradle ${facts?.version ?? "?"} predates isolated projects (8.6); nothing to regress`,
    );
    return;
  }
  const javaHome = localJavaHomes()
    .filter(
      (entry) => facts.maxJava !== undefined && entry.major <= facts.maxJava,
    )
    .sort((a, b) => b.major - a.major)[0];
  if (!javaHome) {
    it.skip("no local JDK this gradle can run; the fixture cannot run here");
    return;
  }
  // The developer's cdxgen GRADLE_* settings (GRADLE_ARGS, GRADLE_CMD, ...)
  // would change what cdxgen runs, so the rows start from a clean slate.
  // GRADLE_USER_HOME and GRADLE_OPTS are Gradle's own (cache location,
  // proxies) and stay. A null value removes the variable from the child.
  // --no-daemon keeps the rows deterministic and leaves no daemon behind.
  const keptGradleVars = new Set(["GRADLE_USER_HOME", "GRADLE_OPTS"]);
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
   */
  const spawnChild = (command, args, options) => {
    const { env, undo } = childEnv(envPatch, currentRuntime() === "deno");
    try {
      return spawnSync(command, args, {
        encoding: "utf-8",
        shell: process.platform === "win32",
        ...options,
        env,
      });
    } finally {
      undo();
    }
  };
  // Toolchain probe without cdxgen's overrides: the fixture's own build
  // scripts are isolated-projects compatible, so a plain `help` only fails
  // when the JDK/Gradle pair is unusable. Probing with the overrides would
  // turn a Gradle that rejects them, the very regression to catch, into a
  // skip.
  const probeProject = scratchFixture();
  const probe = spawnChild(
    "gradle",
    ["--no-daemon", "--console", "plain", "help"],
    { cwd: probeProject, timeout: 180000 },
  );
  rmSync(probeProject, { recursive: true, force: true });
  if (probe.status !== 0) {
    it.skip(
      `the local gradle/JDK pair cannot build the fixture: ${`${probe.stderr || probe.stdout || ""}`.slice(-200)}`,
    );
    return;
  }

  it("exits zero for the properties invocation cdxgen constructs", () => {
    const projectDir = scratchFixture();
    try {
      const gradleCmd = getGradleCommand(projectDir, null, {
        installDeps: true,
      });
      // buildGradleCommandArguments reads GRADLE_USE_DAEMON from this
      // process, not from the child env, so pin it here as well.
      const previousDaemon = process.env.GRADLE_USE_DAEMON;
      process.env.GRADLE_USE_DAEMON = "false";
      let gradleArgs;
      try {
        [gradleArgs] = buildGradleCommandArguments(
          ["--init-script", join(repoRoot, "data", "helpers", "init.gradle")],
          ["properties"],
          [],
          basename(gradleCmd).length,
        );
      } finally {
        if (previousDaemon === undefined) {
          delete process.env.GRADLE_USE_DAEMON;
        } else {
          process.env.GRADLE_USE_DAEMON = previousDaemon;
        }
      }
      assert.ok(gradleArgs.includes("--no-daemon"));
      const result = spawnChild(gradleCmd, gradleArgs, {
        cwd: projectDir,
        timeout: 240000,
      });
      assert.equal(
        result.status,
        0,
        `the properties invocation failed: ${`${result.stderr || ""}`.slice(-400)}`,
      );
      assert.match(
        result.stdout,
        /Root project 'gradle-isolated-projects'/,
        "the properties output the parser feeds on was not produced",
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resolves the fixture's components into the BOM instead of failing silently", () => {
    const projectDir = scratchFixture();
    try {
      const output = join(projectDir, "bom.json");
      // runtimeCommand adds the subcommand and permission flags deno needs.
      const [runtime, ...runtimeArgs] = runtimeCommand(
        join(repoRoot, "bin", "cdxgen.js"),
        currentRuntime(),
      );
      const result = spawnChild(
        runtime,
        [
          ...runtimeArgs,
          "-t",
          "gradle",
          "--install-deps",
          "--no-db",
          "-o",
          output,
          projectDir,
        ],
        { timeout: 600000, shell: false },
      );
      assert.equal(
        result.status,
        0,
        `cdxgen failed: ${`${result.stderr || result.stdout || ""}`.slice(-600)}`,
      );
      const bom = JSON.parse(readFileSync(output, "utf-8"));
      const purls = (bom.components || [])
        .map((component) => component.purl)
        .filter(Boolean);
      assert.ok(
        purls.some((purl) => purl.startsWith("pkg:maven/org.slf4j/slf4j-api@")),
        `the root project's dependency is missing from the BOM: ${JSON.stringify(purls)}`,
      );
      assert.ok(
        purls.some((purl) =>
          purl.startsWith("pkg:maven/com.squareup.okio/okio@"),
        ),
        `the subproject's dependency is missing from the BOM: ${JSON.stringify(purls)}`,
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
