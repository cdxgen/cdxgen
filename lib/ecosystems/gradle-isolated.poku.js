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
import { readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { assert, describe, it } from "poku";

import {
  prepareGradleE2e,
  scratchFixture,
} from "../../test/helpers/gradle-e2e.js";
import {
  currentRuntime,
  repoRoot,
  runtimeCommand,
} from "../../test/helpers/introspection-e2e.js";
import {
  buildGradleCommandArguments,
  getGradleCommand,
} from "./gradleutils.js";

const FIXTURE = join(repoRoot, "test", "repotests", "gradle-isolated-projects");

describe("gradle invocations survive a project that enables isolated projects (issue #4444)", () => {
  // The toolchain probe runs without cdxgen's overrides: the fixture's own
  // build scripts are isolated-projects compatible, so a plain `help` only
  // fails when the JDK/Gradle pair is unusable. Probing with the overrides
  // would turn a Gradle that rejects them, the very regression to catch,
  // into a skip.
  const setup = prepareGradleE2e(FIXTURE, "8.6");
  if (setup.skipReason) {
    it.skip(setup.skipReason);
    return;
  }
  const spawnChild = setup.spawnChild;

  it("exits zero for the properties invocation cdxgen constructs", () => {
    const projectDir = scratchFixture(FIXTURE);
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
      rmSync(join(projectDir, ".."), { recursive: true, force: true });
    }
  });

  it("resolves the fixture's components into the BOM instead of failing silently", () => {
    const projectDir = scratchFixture(FIXTURE);
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
      rmSync(join(projectDir, ".."), { recursive: true, force: true });
    }
  });
});
