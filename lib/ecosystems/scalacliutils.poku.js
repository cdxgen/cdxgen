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
