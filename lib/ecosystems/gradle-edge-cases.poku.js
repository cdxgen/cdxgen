/**
 * Gradle layouts that once lost components or edges, run through cdxgen with
 * a real Gradle against the committed fixture `test/repotests/gradle-edge-cases`:
 *
 * - the root project and the included build `tools` have no group, so
 *   neither has a purl, and `tools` must still be listed with its own
 *   dependencies instead of being deduplicated against the root;
 * - `build-logic`, included from `pluginManagement`, builds a Gradle plugin,
 *   so the components only its classpath brings in are build tooling and
 *   get the `excluded` scope;
 * - the project `:my lib` has a space in its path, which a task header such
 *   as `> Task :my lib:dependencies` must keep;
 * - `gradle.properties` sets `org.gradle.logging.level=warn`, under which
 *   Gradle prints no task headers unless cdxgen overrides the level;
 * - `:app` resolves slf4j-api 2.0.17 over the 2.0.7 that `:my lib`
 *   declares, and that choice must not become an edge of `:my lib`;
 * - `:legacy:util` and `:shared:util` both publish as `com.example:util:1.0`,
 *   so the later one gets its project path as the purl subpath;
 * - `jackson-bom` is a platform, which becomes a `pom` component with the
 *   `excluded` scope;
 * - guava is compile-only in `:legacy:util` and sits in a custom `codegen`
 *   configuration of `:app`, so it does not ship and is `excluded`.
 *
 * Machines without Gradle and a JDK it can run skip.
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

const FIXTURE = join(repoRoot, "test", "repotests", "gradle-edge-cases");
const ROOT_REF = "application:edge-cases:latest";
const TOOLS_REF = "application:tools:latest";
const BUILD_LOGIC_REF = "application:build-logic:latest";
const APP_REF = "pkg:maven/com.example/app@1.0?type=jar";
const LIB_REF = "pkg:maven/com.other/my lib@7?type=jar";
const SLF4J_OLD = "pkg:maven/org.slf4j/slf4j-api@2.0.7?type=jar";
const SLF4J_NEW = "pkg:maven/org.slf4j/slf4j-api@2.0.17?type=jar";
const GSON = "pkg:maven/com.google.code.gson/gson@2.11.0?type=jar";
const LEGACY_UTIL_REF = "pkg:maven/com.example/util@1.0?type=jar";
const SHARED_UTIL_REF = "pkg:maven/com.example/util@1.0?type=jar#shared/util";
const JACKSON_BOM =
  "pkg:maven/com.fasterxml.jackson/jackson-bom@2.21.1?type=pom";

describe("gradle edge-case layouts keep their modules and edges", () => {
  const setup = prepareGradleE2e(FIXTURE);
  if (setup.skipReason) {
    it.skip(setup.skipReason);
    return;
  }

  const projectDir = scratchFixture(FIXTURE);
  let bom;
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
      { timeout: 600000, shell: false },
    );
    assert.equal(
      result.status,
      0,
      `cdxgen failed: ${`${result.stderr || result.stdout || ""}`.slice(-600)}`,
    );
    bom = JSON.parse(readFileSync(output, "utf-8"));
  } finally {
    rmSync(join(projectDir, ".."), { recursive: true, force: true });
  }
  const edges = new Map(
    (bom.dependencies || []).map((entry) => [entry.ref, entry.dependsOn]),
  );

  it("reads the modules despite the quiet log level", () => {
    assert.strictEqual(bom.metadata?.component?.["bom-ref"], ROOT_REF);
    const modules = (bom.metadata.component.components || []).map(
      (component) => component["bom-ref"],
    );
    for (const ref of [TOOLS_REF, BUILD_LOGIC_REF, APP_REF, LIB_REF]) {
      assert.ok(modules.includes(ref), `${ref} is missing: ${modules}`);
    }
  });

  it("keeps an included build without a purl apart from the root", () => {
    assert.deepStrictEqual(edges.get(TOOLS_REF), [GSON]);
    assert.ok(edges.get(ROOT_REF)?.includes(TOOLS_REF));
  });

  it("marks the classpath of a plugin build as excluded", () => {
    assert.deepStrictEqual(edges.get(BUILD_LOGIC_REF), [
      "pkg:maven/com.squareup.okio/okio@3.9.0?type=jar",
    ]);
    for (const name of ["okio", "okio-jvm", "kotlin-stdlib"]) {
      const component = (bom.components || []).find(
        (candidate) => candidate.name === name,
      );
      assert.strictEqual(component?.scope, "excluded", `${name} scope`);
    }
    const gson = (bom.components || []).find(
      (candidate) => candidate.name === "gson",
    );
    assert.notStrictEqual(gson?.scope, "excluded");
  });

  it("reads the report of a project whose path has a space", () => {
    assert.ok(edges.get(LIB_REF)?.includes(SLF4J_OLD));
    const commonsLang = (bom.components || []).find(
      (component) => component.name === "commons-lang3",
    );
    assert.strictEqual(commonsLang?.scope, "optional");
  });

  it("keeps two subprojects with the same coordinates apart", () => {
    const modules = (bom.metadata.component.components || []).map(
      (component) => component["bom-ref"],
    );
    assert.ok(modules.includes(LEGACY_UTIL_REF), modules.join(" "));
    assert.ok(modules.includes(SHARED_UTIL_REF), modules.join(" "));
    assert.deepStrictEqual(edges.get(SHARED_UTIL_REF), [GSON]);
    assert.ok(edges.get(APP_REF)?.includes(SHARED_UTIL_REF));
    assert.ok(!edges.get(APP_REF)?.includes(LEGACY_UTIL_REF));
  });

  it("scopes platforms, compile-only and unnamed configurations as excluded", () => {
    const byRef = new Map(
      (bom.components || []).map((component) => [
        component["bom-ref"],
        component,
      ]),
    );
    assert.strictEqual(byRef.get(JACKSON_BOM)?.scope, "excluded");
    assert.ok(
      !byRef.has("pkg:maven/com.fasterxml.jackson/jackson-bom@2.21.1?type=jar"),
    );
    assert.ok(edges.get(APP_REF)?.includes(JACKSON_BOM));
    assert.strictEqual(
      byRef.get("pkg:maven/com.google.guava/guava@33.0.0-jre?type=jar")?.scope,
      "excluded",
    );
    assert.strictEqual(
      byRef.get(
        "pkg:maven/com.fasterxml.jackson.core/jackson-databind@2.21.1?type=jar",
      )?.scope,
      "required",
    );
  });

  it("gives a project only the edges of its own report", () => {
    assert.ok(
      !edges.get(LIB_REF)?.includes(SLF4J_NEW),
      `the consumer's conflict resolution leaked into ${LIB_REF}: ${edges.get(LIB_REF)}`,
    );
    assert.ok(edges.get(APP_REF)?.includes(SLF4J_NEW));
    assert.ok(edges.get(APP_REF)?.includes(LIB_REF));
  });
});
