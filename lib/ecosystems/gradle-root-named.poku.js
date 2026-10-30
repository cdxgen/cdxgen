/**
 * Issue #4695: in a multi-project build whose main module is named after the
 * root project and inherits the root's group and version, the module and the
 * root share one purl. cdxgen skipped the root's entry in the module map by
 * purl, so it never ran `:<module>:dependencies`, and the module's libraries
 * reached the BOM only through another module's test classpath, as optional.
 *
 * These rows run cdxgen against a real Gradle and the committed fixture
 * `test/repotests/gradle-root-named-module`, whose settings and main module
 * use the Kotlin DSL and whose other modules use Groovy. Machines without
 * Gradle and a JDK it can run skip.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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

const FIXTURE = join(repoRoot, "test", "repotests", "gradle-root-named-module");
const ROOT_REF = "pkg:maven/com.example/example-service@1.0.0?type=jar";

describe("a module named after the root project keeps its dependencies (issue #4695)", () => {
  const setup = prepareGradleE2e(FIXTURE);
  if (setup.skipReason) {
    it.skip(setup.skipReason);
    return;
  }

  /**
   * Run cdxgen on a scratch copy of the fixture and return the BOM.
   *
   * @param {Object} extraEnv Additional environment for the cdxgen child
   * @returns {Object} Parsed BOM
   */
  const scan = (extraEnv = {}) => {
    const projectDir = scratchFixture(FIXTURE);
    try {
      const output = join(projectDir, "bom.json");
      // runtimeCommand adds the subcommand and permission flags deno needs.
      const [runtime, ...runtimeArgs] = runtimeCommand(
        join(repoRoot, "bin", "cdxgen.js"),
        currentRuntime(),
      );
      const result = setup.spawnChild(
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
        { timeout: 600000, shell: false, extraEnv },
      );
      assert.equal(
        result.status,
        0,
        `cdxgen failed: ${`${result.stderr || result.stdout || ""}`.slice(-600)}`,
      );
      return JSON.parse(readFileSync(output, "utf-8"));
    } finally {
      rmSync(join(projectDir, ".."), { recursive: true, force: true });
    }
  };

  const componentByName = (bom, name) =>
    (bom.components || []).find((component) => component.name === name);

  it("reports the module's libraries as required", () => {
    const bom = scan();
    for (const name of ["slf4j-api", "commons-lang3", "okio", "okio-jvm"]) {
      const component = componentByName(bom, name);
      assert.ok(component, `${name} is missing from the BOM`);
      assert.notStrictEqual(
        component.scope,
        "optional",
        `${name} is optional, so the module's own dependencies task did not run`,
      );
    }
    const rootEdges = (bom.dependencies || []).find(
      (entry) => entry.ref === ROOT_REF,
    );
    assert.ok(rootEdges, "the root project has no dependency entry");
    for (const ref of [
      "pkg:maven/org.slf4j/slf4j-api@2.0.7?type=jar",
      "pkg:maven/org.apache.commons/commons-lang3@3.14.0?type=jar",
      "pkg:maven/com.example/example-service-rest-api@1.0.0?type=jar",
    ]) {
      assert.ok(
        rootEdges.dependsOn.includes(ref),
        `the module's edge to ${ref} is missing: ${JSON.stringify(rootEdges.dependsOn)}`,
      );
    }
  });

  it("still runs the module's task when another module is skipped", () => {
    const bom = scan({ GRADLE_SKIP_MODULES: ":example-service-it" });
    assert.notStrictEqual(componentByName(bom, "slf4j-api")?.scope, "optional");
    // A skipped module keeps its default coordinates but gets no edges.
    const skippedEdges = (bom.dependencies || []).find(
      (entry) =>
        entry.ref === "pkg:maven/com.example/example-service-it@1.0.0?type=jar",
    );
    assert.deepStrictEqual(skippedEdges?.dependsOn ?? [], []);
  });

  it("skips the module's task when GRADLE_SKIP_MODULE_DEPENDENCIES names it", () => {
    const bom = scan({ GRADLE_SKIP_MODULE_DEPENDENCIES: ":example-service" });
    // Only the integration-test module's test classpath reports the library
    // now, which is the behaviour the issue described.
    assert.strictEqual(componentByName(bom, "slf4j-api")?.scope, "optional");
    assert.notStrictEqual(componentByName(bom, "okio")?.scope, "optional");
  });
});
