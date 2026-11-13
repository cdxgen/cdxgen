import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "poku";

import {
  collectScalaCliComponents,
  coordinatesFromCoursierPath,
  parseScalaCliDirectives,
  scalaCliComponent,
} from "./scalacliutils.js";

it("parseScalaCliDirectives reads the using directives", () => {
  const directives = parseScalaCliDirectives(
    "./test/data/scala-cli/project.scala",
  );
  assert.strictEqual(directives.scalaVersion, "3.3.7");
  assert.strictEqual(directives.platform, null);
  assert.deepStrictEqual(directives.deps, [
    {
      group: "com.lihaoyi",
      artifact: "requests",
      version: "0.9.3",
      cross: "::",
      test: false,
    },
    {
      group: "org.bouncycastle",
      artifact: "bcprov-jdk18on",
      version: "1.86",
      cross: "none",
      test: false,
    },
    {
      group: "org.scalameta",
      artifact: "munit",
      version: "1.0.0",
      cross: "::",
      test: true,
    },
  ]);
});

it("scala-cli components use the sbt purl form", () => {
  const directives = parseScalaCliDirectives(
    "./test/data/scala-cli/project.scala",
  );
  const requests = scalaCliComponent(
    directives.deps[0],
    directives,
    "project.scala",
  );
  assert.strictEqual(
    requests.purl,
    "pkg:maven/com.lihaoyi/requests@0.9.3?type=jar",
  );
  assert.strictEqual(
    requests.properties.find((p) => p.name === "cdx:scala:compilerVersion")
      ?.value,
    "3",
  );
  // A plain Java artifact keeps its name and gains no property
  const bcprov = scalaCliComponent(
    directives.deps[1],
    directives,
    "project.scala",
  );
  assert.strictEqual(
    bcprov.purl,
    "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.86?type=jar",
  );
  assert.strictEqual(bcprov.properties, undefined);
  // Test dependencies are scoped optional
  const munit = scalaCliComponent(
    directives.deps[2],
    directives,
    "project.scala",
  );
  assert.strictEqual(munit.scope, "optional");
});

it("scala-cli components carry the platform suffix of the declared platform", () => {
  const directives = parseScalaCliDirectives("./test/data/scala-cli/App.scala");
  assert.strictEqual(directives.platform, "scala-js");
  const laminar = scalaCliComponent(
    directives.deps[0],
    directives,
    "App.scala",
  );
  assert.strictEqual(
    laminar.purl,
    "pkg:maven/com.raquo/laminar_sjs1@17.2.0?type=jar",
  );
  // The platform directive alone does not reveal the compiler version
  assert.strictEqual(laminar.properties, undefined);
});

it("scala-cli components are collected from the source directives", () => {
  const pkgList = collectScalaCliComponents("./test/data/scala-cli", {
    installDeps: false,
  });
  const purls = pkgList.map((c) => c.purl);
  assert.ok(
    purls.includes("pkg:maven/com.lihaoyi/requests@0.9.3?type=jar"),
    `requests missing from ${purls}`,
  );
  assert.ok(
    purls.includes("pkg:maven/org.bouncycastle/bcprov-jdk18on@1.86?type=jar"),
    `bcprov missing from ${purls}`,
  );
  assert.ok(
    purls.includes("pkg:maven/com.raquo/laminar_sjs1@17.2.0?type=jar"),
    `laminar missing from ${purls}`,
  );
});

it("scalaCliComponent follows the sbt purl form for every separator", () => {
  const project = { scalaVersion: "3.3.7", platform: "jvm" };
  const explicit = scalaCliComponent(
    {
      group: "com.lihaoyi",
      artifact: "os-lib_3",
      version: "0.11.4",
      cross: "none",
    },
    project,
    "project.scala",
  );
  assert.strictEqual(
    explicit.purl,
    "pkg:maven/com.lihaoyi/os-lib@0.11.4?type=jar",
  );
  assert.deepStrictEqual(explicit.properties, [
    { name: "cdx:scala:compilerVersion", value: "3" },
  ]);
  const fullCross = scalaCliComponent(
    {
      group: "org.typelevel",
      artifact: "kind-projector",
      version: "0.13.3",
      cross: ":::",
    },
    project,
    "project.scala",
  );
  assert.strictEqual(
    fullCross.purl,
    "pkg:maven/org.typelevel/kind-projector_3.3.7@0.13.3?type=jar",
  );
});

it("coordinatesFromCoursierPath reads Windows cache paths", () => {
  assert.deepStrictEqual(
    coordinatesFromCoursierPath(
      "C:\\Users\\u\\AppData\\Local\\Coursier\\cache\\v1\\https\\repo1.maven.org\\maven2\\com\\lihaoyi\\os-lib_3\\0.11.4\\os-lib_3-0.11.4.jar",
    ),
    { group: "com.lihaoyi", name: "os-lib_3", version: "0.11.4" },
  );
});

it("coordinatesFromCoursierPath maps cache jars to coordinates", () => {
  assert.deepStrictEqual(
    coordinatesFromCoursierPath(
      "/home/user/.cache/coursier/v1/https/repo1.maven.org/maven2/org/scala-lang/scala3-compiler_3/3.3.7/scala3-compiler_3-3.3.7.jar",
    ),
    {
      group: "org.scala-lang",
      name: "scala3-compiler_3",
      version: "3.3.7",
    },
  );
  // Unknown repository layouts are skipped rather than guessed
  assert.strictEqual(
    coordinatesFromCoursierPath("/some/unknown/place/lib.jar"),
    null,
  );
});

it("parseScalaCliDirectives rejects a long unterminated directive line quickly", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-scala-cli-"));
  try {
    const sourceFile = join(dir, "project.scala");
    writeFileSync(
      sourceFile,
      `//> using dep g::a:1.0\n//> using x${" ".repeat(100000)}\r`,
    );
    const start = performance.now();
    const directives = parseScalaCliDirectives(sourceFile);
    assert.ok(
      performance.now() - start < 2000,
      "directive parsing backtracked",
    );
    assert.strictEqual(directives.deps.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("parseScalaCliDirectives ignores version directives that are not versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-scala-cli-"));
  try {
    const sourceFile = join(dir, "project.scala");
    writeFileSync(
      sourceFile,
      `//> using scala 3.${"1".repeat(100)}\n//> using platform scala-native\n//> using nativeVersion 0.${"1".repeat(100)}\n//> using dep g:::a:1.0\n`,
    );
    const directives = parseScalaCliDirectives(sourceFile);
    assert.strictEqual(directives.scalaVersion, null);
    assert.strictEqual(directives.nativeVersion, null);
    assert.strictEqual(directives.deps.length, 1);
    // Without a version to copy, the full cross dependency keeps its name
    const component = scalaCliComponent(
      directives.deps[0],
      directives,
      sourceFile,
    );
    assert.strictEqual(component.purl, "pkg:maven/g/a@1.0?type=jar");
    assert.strictEqual(component.properties, undefined);
    // A nightly version is still a version
    writeFileSync(
      sourceFile,
      "//> using scala 3.7.3-RC1-bin-20250708-9b1a6b0-NIGHTLY\n//> using nativeVersion 0.5.8\n",
    );
    const nightly = parseScalaCliDirectives(sourceFile);
    assert.strictEqual(
      nightly.scalaVersion,
      "3.7.3-RC1-bin-20250708-9b1a6b0-NIGHTLY",
    );
    assert.strictEqual(nightly.nativeVersion, "0.5.8");
    // The first of an unquoted list loses the comma that separates it
    writeFileSync(sourceFile, "//> using scala 3.3.1, 2.13.12\n");
    assert.strictEqual(
      parseScalaCliDirectives(sourceFile).scalaVersion,
      "3.3.1",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
