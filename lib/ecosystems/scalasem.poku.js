import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import { safeExistsSync } from "../core/fs.js";
import { mergeServices } from "../inventory/depsUtils.js";
import { normalizeDosaiServiceMap } from "../inventory/dosai.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { validateBom } from "../validator/bomValidator.js";
import {
  analyzeScalaProject,
  collectScalaJsNpmComponents,
  collectScalasemApiEndpoints,
  collectScalasemEvidence,
  collectScalasemServices,
  componentCoordinateIndex,
  isScalasemLanguage,
  matchClasspathEntry,
  resolveScalasemCommand,
  SCALASEM_KEYSTORE_NAMES,
  SCALASEM_NO_OID_ALGORITHMS,
  SCALASEM_PROTOCOL_NAMES,
  ScalaJoinIndex,
  scalasemCryptoOidKey,
  scalasemDisabled,
  scalasemMetadataProperties,
  scalasemOutputFile,
} from "./scalasem.js";

const v2Report = {
  _meta: {
    schemaVersion: "scalasem/2",
    tool: "scalasem",
    projectPath: "/src/app",
    generatedFrom: ["tasty"],
    compilers: [{ version: "3.3.7", source: "sbt" }],
    platforms: ["jvm"],
    counts: { files: 4, calls: 110 },
    diagnostics: [{ code: "unreadable-tasty", count: 2 }],
  },
  config: { routes: [] },
  modules: [],
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stubDir = mkdtempSync(join(tmpdir(), "scalasem-poku-"));

// One file per stub: tests run concurrently and rewrite their stubs.
let stubCount = 0;
function writeStub(body) {
  stubCount += 1;
  const stub = join(stubDir, `scalasem-stub-${stubCount}.js`);
  writeFileSync(stub, body);
  return stub;
}

function quiet(fn) {
  const original = console.log;
  console.log = () => undefined;
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

it("recognises every scala project type", () => {
  for (const language of ["scala", "scala3", "sbt", "mill", "scala-cli"]) {
    assert.ok(isScalasemLanguage(language), language);
  }
  assert.ok(!isScalasemLanguage("java"));
  assert.ok(!isScalasemLanguage(undefined));
});

it("resolves the report output path beside the evinse output", () => {
  const bomDir = mkdtempSync(join(tmpdir(), "scalasem-out-"));
  try {
    assert.strictEqual(
      scalasemOutputFile({
        semanticsSlicesFile: "/abs/report.json",
        output: join(bomDir, "bom.evinse.json"),
      }),
      "/abs/report.json",
    );
    assert.strictEqual(
      scalasemOutputFile({
        semanticsSlicesFile: "semantics.slices.json",
        output: join(bomDir, "bom.evinse.json"),
      }),
      join(bomDir, "semantics.slices.json"),
    );
    assert.strictEqual(
      scalasemOutputFile({
        semanticsSlicesFile: "semantics.slices.json",
        output: bomDir,
      }),
      join(bomDir, "semantics.slices.json"),
    );
  } finally {
    rmSync(bomDir, { recursive: true, force: true });
  }
});

it("reuses a matching report newer than the input BOM", () => {
  const work = mkdtempSync(join(tmpdir(), "scalasem-reuse-"));
  const projectDir = join(work, "app");
  mkdirSync(projectDir);
  try {
    const exitStub = writeStub("process.exit(9);");
    const reportFile = join(work, "semantics.slices.json");
    const bomFile = join(work, "bom.json");
    writeFileSync(
      reportFile,
      JSON.stringify({
        ...v2Report,
        _meta: { ...v2Report._meta, projectPath: projectDir },
      }),
    );
    writeFileSync(bomFile, "{}");
    const older = new Date(Date.now() - 60_000);
    utimesSync(bomFile, older, older);
    const options = {
      input: bomFile,
      semanticsSlicesFile: reportFile,
      output: join(work, "bom.evinse.json"),
      scalasemCommand: exitStub,
    };
    const reused = quiet(() => analyzeScalaProject(projectDir, options));
    assert.strictEqual(reused.report._meta.schemaVersion, "scalasem/2");
    // A report from another project is regenerated, and the failure to write
    // one shows up as a diagnostic instead of silence.
    const otherProject = join(work, "other");
    mkdirSync(otherProject);
    const other = quiet(() => analyzeScalaProject(otherProject, options));
    assert.strictEqual(other.report, undefined);
    const codes = other.metadataProperties
      .filter((property) => property.name.startsWith("cdx:scalasem:diagnostic"))
      .map((property) => property.name);
    assert.ok(codes.length > 0, JSON.stringify(codes));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("returns a version 1 slice beside the fresh report without overwriting it", () => {
  const work = mkdtempSync(join(tmpdir(), "scalasem-v1-"));
  const projectDir = join(work, "app");
  mkdirSync(projectDir);
  try {
    const sliceFile = join(work, "semantics.slices.json");
    const bomFile = join(work, "bom.json");
    const v1Slice = {
      "src/main/scala/App.scala": { usedTypes: ["jwt.core.Jwt"] },
    };
    writeFileSync(sliceFile, JSON.stringify(v1Slice));
    writeFileSync(bomFile, "{}");
    const newer = new Date(Date.now() + 60_000);
    utimesSync(sliceFile, newer, newer);
    const v1Stub = writeStub(
      `require("node:fs").writeFileSync(process.argv[3], JSON.stringify(${JSON.stringify(
        v2Report,
      ).replace("/src/app", projectDir)}));`,
    );
    const analysis = quiet(() =>
      analyzeScalaProject(projectDir, {
        input: bomFile,
        semanticsSlicesFile: sliceFile,
        output: join(work, "bom.evinse.json"),
        scalasemCommand: v1Stub,
      }),
    );
    assert.ok(analysis.report._meta);
    assert.deepStrictEqual(analysis.v1Slice, v1Slice);
    assert.deepStrictEqual(
      JSON.parse(readFileSync(sliceFile, "utf-8")),
      v1Slice,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("reports a failing analyzer as diagnostics, not silence", () => {
  const work = mkdtempSync(join(tmpdir(), "scalasem-fail-"));
  const projectDir = join(work, "app");
  mkdirSync(projectDir);
  try {
    const bomFile = join(work, "bom.json");
    writeFileSync(bomFile, "{}");
    const failStub = writeStub("process.exit(3);");
    const analysis = quiet(() =>
      analyzeScalaProject(projectDir, {
        input: bomFile,
        semanticsSlicesFile: join(work, "semantics.slices.json"),
        output: join(work, "bom.evinse.json"),
        scalasemCommand: failStub,
      }),
    );
    assert.strictEqual(analysis.report, undefined);
    const codes = analysis.metadataProperties
      .filter((property) => property.name.startsWith("cdx:scalasem:diagnostic"))
      .map((property) => property.name);
    assert.ok(
      codes.includes("cdx:scalasem:diagnostic:scalasem-no-report"),
      JSON.stringify(codes),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("maps report metadata onto cdx:scalasem properties", () => {
  const properties = scalasemMetadataProperties(v2Report);
  const byName = Object.fromEntries(
    properties.map((property) => [property.name, property.value]),
  );
  assert.strictEqual(byName["cdx:scalasem:schemaVersion"], "scalasem/2");
  assert.strictEqual(byName["cdx:scalasem:factsSource"], "tasty");
  assert.strictEqual(byName["cdx:scalasem:compilerSource"], "sbt");
  assert.strictEqual(byName["cdx:scalasem:scalaVersions"], "3.3.7");
  assert.strictEqual(byName["cdx:scalasem:platforms"], "jvm");
  assert.strictEqual(byName["cdx:scalasem:filesAnalyzed"], "4");
  assert.strictEqual(byName["cdx:scalasem:degraded"], "true");
  assert.strictEqual(byName["cdx:scalasem:diagnostic:unreadable-tasty"], "2");
});

it("reads the command override and the disable switch through the environment", () => {
  const previousCommand = process.env.SCALASEM_CMD;
  const previousDisable = process.env.CDXGEN_SCALASEM_DISABLE;
  try {
    process.env.SCALASEM_CMD = "/opt/scalasem.js";
    assert.strictEqual(resolveScalasemCommand(), "/opt/scalasem.js");
    assert.ok(!scalasemDisabled({}));
    process.env.CDXGEN_SCALASEM_DISABLE = "true";
    assert.ok(scalasemDisabled({}));
    process.env.CDXGEN_SCALASEM_DISABLE = "0";
    assert.ok(!scalasemDisabled({}));
    assert.ok(scalasemDisabled({ noScalasem: true }));
  } finally {
    if (previousCommand === undefined) {
      delete process.env.SCALASEM_CMD;
    } else {
      process.env.SCALASEM_CMD = previousCommand;
    }
    if (previousDisable === undefined) {
      delete process.env.CDXGEN_SCALASEM_DISABLE;
    } else {
      process.env.CDXGEN_SCALASEM_DISABLE = previousDisable;
    }
  }
});

rmSync(stubDir, { recursive: true, force: true });

describe("scala purl join", () => {
  const catsSbt = {
    purl: "pkg:maven/org.typelevel/cats-core@2.12.0?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
  };
  const upickleJvm = { purl: "pkg:maven/com.lihaoyi/upickle@3.0.0" };
  const upickleSjs = { purl: "pkg:maven/com.lihaoyi/upickle_sjs1@3.0.0" };
  const upickleNative = {
    purl: "pkg:maven/com.lihaoyi/upickle_native0.5@3.0.0",
  };
  const millArtifact = {
    purl: "pkg:maven/com.lihaoyi/upickle_3@3.0.0?type=jar",
  };

  it("matches classpath jars to components through normalized coordinates", () => {
    const components = [
      catsSbt,
      upickleJvm,
      upickleSjs,
      upickleNative,
      millArtifact,
    ];
    const coordinateIndex = componentCoordinateIndex(components);
    const match = (entry, platform) =>
      matchClasspathEntry(entry, coordinateIndex, platform)?.component;
    // An sbt component: the Scala suffix is stripped, the platform suffix kept.
    assert.strictEqual(
      match(
        { group: "org.typelevel", artifact: "cats-core_3", version: "2.12.0" },
        "jvm",
      ),
      catsSbt,
    );
    // A Mill or Maven component keeps the full artifactId.
    assert.strictEqual(
      match(
        { group: "com.lihaoyi", artifact: "upickle_3", version: "3.0.0" },
        "jvm",
      ),
      millArtifact,
    );
    // The module platform picks between the JVM, JS and Native artifacts.
    assert.strictEqual(
      match(
        { group: "com.lihaoyi", artifact: "upickle_sjs1_3", version: "3.0.0" },
        "js",
      ),
      upickleSjs,
    );
    assert.strictEqual(
      match(
        {
          group: "com.lihaoyi",
          artifact: "upickle_native0.5_3",
          version: "3.0.0",
        },
        "native",
      ),
      upickleNative,
    );
    // A jar the BOM does not hold matches nothing.
    assert.strictEqual(
      match(
        { group: "org.unknown", artifact: "nope_3", version: "1.0.0" },
        "jvm",
      ),
      undefined,
    );
    // Another version of a library matches, but not as an exact match.
    const other = matchClasspathEntry(
      { group: "org.typelevel", artifact: "cats-core_3", version: "2.13.0" },
      coordinateIndex,
      "jvm",
    );
    assert.strictEqual(other.component, catsSbt);
    assert.strictEqual(other.exact, false);
  });

  it("keeps the Scala 2 and Scala 3 artifacts of one Maven library apart", () => {
    const cats213 = { purl: "pkg:maven/org.typelevel/cats-core_2.13@2.12.0" };
    const cats3 = { purl: "pkg:maven/org.typelevel/cats-core_3@2.12.0" };
    const coordinateIndex = componentCoordinateIndex([cats213, cats3]);
    for (const [artifact, component] of [
      ["cats-core_2.13", cats213],
      ["cats-core_3", cats3],
    ]) {
      assert.strictEqual(
        matchClasspathEntry(
          { group: "org.typelevel", artifact, version: "2.12.0" },
          coordinateIndex,
          "jvm",
        )?.component,
        component,
        artifact,
      );
    }
  });

  it("indexes symbols with earlier sources winning", () => {
    const index = new ScalaJoinIndex();
    index.addNamespaces(
      upickleJvm.purl,
      ["upickle.imp.Builder$", "upickle.core.Types"],
      2,
    );
    assert.strictEqual(index.lookup("upickle.imp.Builder$"), upickleJvm.purl);
    // A member joins through its class, a nested type through its outer class.
    assert.strictEqual(
      index.lookup("upickle.core.Types.Reader"),
      upickleJvm.purl,
    );
    // A package-only reference joins through the package the jar fills.
    assert.strictEqual(index.lookup("upickle.imp.Listener"), upickleJvm.purl);
    // The classpath source outranks the namespace property, whenever it runs.
    index.addNamespaces(
      "pkg:maven/other/thing@1.0.0",
      ["upickle.core.Types"],
      1,
    );
    assert.strictEqual(
      index.lookup("upickle.core.Types"),
      "pkg:maven/other/thing@1.0.0",
    );
  });

  it("owns only the packages a jar ships classes in, never their parents", () => {
    const index = new ScalaJoinIndex();
    const plugin = "pkg:maven/org.scala-steward/mill-plugin@0.19.1";
    const compat = "pkg:maven/org.scala-lang.modules/compat@2.8.1";
    index.addNamespaces(plugin, ["org.scalasteward.mill.plugin.Main"], 1);
    index.addNamespaces(compat, ["scala.collection.compat.Factory"], 1);
    assert.strictEqual(
      index.lookup("org.scalasteward.mill.plugin.Other"),
      plugin,
    );
    assert.strictEqual(
      index.lookup("org.scalasteward.core.Steward"),
      undefined,
    );
    assert.strictEqual(index.lookup("org.scalasteward"), undefined);
    assert.strictEqual(
      index.lookup("scala.collection.IterableOnceOps.foreach"),
      undefined,
    );
    assert.strictEqual(index.lookup("scala.Unit"), undefined);
  });

  it("gives the JDK and the project's own code no component", () => {
    const index = new ScalaJoinIndex();
    const nativelib = "pkg:maven/org.scala-native/nativelib_native0.5@0.5.6";
    const servlet = "pkg:maven/javax.servlet/javax.servlet-api@4.0.1";
    index.addNamespaces(nativelib, ["java.lang.process.WindowsUtils"], 1);
    index.addNamespaces(
      servlet,
      ["javax.servlet.http.HttpServlet", "javax.servlet.Filter"],
      1,
    );
    index.addNamespaces(
      "pkg:maven/com.example/client@1.0.0",
      ["com.example.app.Client"],
      1,
    );
    index.addProjectDefinitions({
      "src/main/scala/App.scala": {
        definitions: [
          { kind: "object", owner: "com.example.app", name: "App" },
        ],
      },
    });
    assert.strictEqual(index.lookup("java.lang.Object.<init>"), undefined);
    assert.strictEqual(
      index.lookup("java.lang.process.WindowsUtils", "native"),
      undefined,
    );
    // javax joins a library through an exact class only.
    assert.strictEqual(
      index.lookup("javax.servlet.http.HttpServlet.service"),
      servlet,
    );
    assert.strictEqual(index.lookup("javax.servlet.http.Cookie"), undefined);
    // The project's classes, and a package the project fills, join nothing.
    assert.strictEqual(index.lookup("com.example.app.App.main"), undefined);
    assert.strictEqual(index.lookup("com.example.app.Helper"), undefined);
    assert.strictEqual(
      index.lookup("com.example.app.Client.send"),
      "pkg:maven/com.example/client@1.0.0",
    );
  });

  it("picks the platform variant when several purls own one class", () => {
    const index = new ScalaJoinIndex();
    index.addNamespaces(upickleJvm.purl, ["upickle.imp.Builder$"], 2);
    index.addNamespaces(upickleSjs.purl, ["upickle.imp.Builder$"], 2);
    index.addNamespaces(upickleNative.purl, ["upickle.imp.Builder$"], 2);
    assert.strictEqual(
      index.lookup("upickle.imp.Builder$", "js"),
      upickleSjs.purl,
    );
    assert.strictEqual(
      index.lookup("upickle.imp.Builder$", "native"),
      upickleNative.purl,
    );
    // A package the variants share resolves through the platform too.
    assert.strictEqual(
      index.lookup("upickle.imp.Listener", "native"),
      upickleNative.purl,
    );
    // Without a platform the JVM speaks for the library.
    assert.strictEqual(index.lookup("upickle.imp.Builder$"), upickleJvm.purl);
    // A file on one platform never joins another platform's only variant.
    const sjsOnly = new ScalaJoinIndex();
    sjsOnly.addNamespaces(upickleSjs.purl, ["upickle.imp.Builder$"], 2);
    assert.strictEqual(
      sjsOnly.lookup("upickle.imp.Builder$", "jvm"),
      undefined,
    );
  });

  it("joins a file only to libraries on its module's classpath", () => {
    const index = new ScalaJoinIndex();
    const zio206 = "pkg:maven/dev.zio/zio@2.0.6";
    const zio219 = "pkg:maven/dev.zio/zio@2.1.9";
    index.addNamespaces(zio206, ["zio.ZIO", "zio.Console"], 1);
    index.addNamespaces(zio219, ["zio.ZIO", "zio.Console"], 1);
    const allowed = new Set([zio219]);
    assert.strictEqual(index.lookup("zio.ZIO.succeed"), undefined);
    assert.strictEqual(index.lookup("zio.ZIO.succeed", "jvm", allowed), zio219);
    assert.strictEqual(index.lookup("zio.Clock", "jvm", allowed), zio219);
    assert.deepStrictEqual(index.lookupAll("zio.ZIO", "jvm", allowed), [
      zio219,
    ]);
    // A library the module does not compile against is never its owner.
    assert.strictEqual(
      index.lookup("zio.ZIO.succeed", "jvm", new Set(["pkg:maven/x/y@1"])),
      undefined,
    );
  });

  it("leaves a package owned by two libraries unresolved", () => {
    const index = new ScalaJoinIndex();
    index.addNamespaces("pkg:maven/a/one@1.0.0", ["com.example.Foo"], 2);
    index.addNamespaces("pkg:maven/b/two@1.0.0", ["com.example.Bar"], 2);
    assert.strictEqual(
      index.lookup("com.example.Foo"),
      "pkg:maven/a/one@1.0.0",
    );
    assert.strictEqual(index.lookup("com.example.New"), undefined);
  });

  it("reads the classpath jars of components without namespaces, once each", async () => {
    const jarDir = mkdtempSync(join(tmpdir(), "scalasem-jar-"));
    const jarPath = join(jarDir, "lib_3-1.0.0.jar");
    writeFileSync(jarPath, "stub jar");
    const reads = [];
    const { buildScalaJoinIndex } = await esmock("./scalasem.js", {
      "../inventory/deps.js": {
        getJarClasses: async (path) => {
          reads.push(path);
          return ["com.example.lib.Real", "com.example.lib.Helper"];
        },
      },
    });
    const classpath = [
      {
        group: "com.example",
        artifact: "lib_3",
        version: "1.0.0",
        path: jarPath,
      },
      {
        group: "org.missing",
        artifact: "absent_3",
        version: "1.0.0",
        path: "/cache/absent.jar",
      },
    ];
    const report = {
      modules: [
        { id: "core", platform: "jvm", classpath },
        { id: "app", platform: "jvm", classpath },
      ],
    };
    const libComponent = { purl: "pkg:maven/com.example/lib@1.0.0" };
    const withNamespaces = {
      purl: "pkg:maven/org.typelevel/cats-core@2.12.0",
      properties: [
        { name: "internal:Namespaces", value: "cats.data.NonEmptyList" },
      ],
    };
    const index = await buildScalaJoinIndex(
      report,
      [libComponent, withNamespaces],
      {
        "pkg:maven/com.lihaoyi/upickle_3@3.0.0?type=jar": {
          namespaces: ["upickle.imp.Builder$"],
        },
      },
    );
    assert.deepStrictEqual(reads, [jarPath]);
    assert.strictEqual(index.lookup("com.example.lib.Real"), libComponent.purl);
    assert.strictEqual(index.namespacesByPurl.get(libComponent.purl).length, 2);
    // The namespace property source beats the map entry, which is never read.
    assert.strictEqual(
      index.lookup("cats.data.NonEmptyList"),
      withNamespaces.purl,
    );
    // A map entry whose library has no component joins nothing.
    assert.strictEqual(index.lookup("upickle.imp.Builder$"), undefined);
    // The map entry joins through the component coordinates.
    const upickleSbtComponent = { purl: "pkg:maven/com.lihaoyi/upickle@3.0.0" };
    const indexTwo = await buildScalaJoinIndex(report, [upickleSbtComponent], {
      "pkg:maven/com.lihaoyi/upickle_3@3.0.0?type=jar": {
        namespaces: ["upickle.imp.Builder$"],
      },
    });
    assert.strictEqual(
      indexTwo.lookup("upickle.imp.Builder$"),
      upickleSbtComponent.purl,
    );
    rmSync(jarDir, { recursive: true, force: true });
  });
});

describe("scalasem evidence mapping", () => {
  const recording = (name) =>
    JSON.parse(
      readFileSync(join("test", "data", "scalasem", `${name}.json`), "utf-8"),
    );

  it("maps references and calls to occurrences with lines", async () => {
    const report = recording("services-jvm");
    const kafka = {
      purl: "pkg:maven/org.apache.kafka/kafka-clients@3.9.0?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
      properties: [
        {
          name: "internal:Namespaces",
          value:
            "org.apache.kafka.clients.producer.KafkaProducer\norg.apache.kafka.clients.producer.ProducerRecord",
        },
      ],
    };
    const evidence = await collectScalasemEvidence(report, [kafka], {});
    const locations = [...(evidence.purlLocationMap[kafka.purl] || [])].sort();
    assert.ok(locations.length > 0, "no kafka occurrences");
    assert.ok(
      locations.includes("src/main/scala/corpus/services/DataStores.scala#6"),
      JSON.stringify(locations),
    );
    assert.ok(
      locations.some((location) =>
        location.startsWith(
          "src/main/scala/corpus/services/DataStores.scala#1",
        ),
      ),
      "the call at the usage line is missing",
    );
    const properties = evidence.componentPropertiesMap[kafka.purl] || [];
    const byName = Object.fromEntries(
      properties.map((property) => [property.name, property.value]),
    );
    assert.strictEqual(byName["cdx:scalasem:usageScopes"], "main");
    assert.ok(Number(byName["cdx:scalasem:callSites"]) > 0);
  });

  it("counts every call site whatever the occurrence cap keeps", async () => {
    const previous = process.env.CDXGEN_SCALASEM_MAX_OCCURRENCES;
    process.env.CDXGEN_SCALASEM_MAX_OCCURRENCES = "2";
    try {
      const lib = {
        purl: "pkg:maven/com.example/lib@1.0.0",
        properties: [
          { name: "internal:Namespaces", value: "com.example.lib.Api" },
        ],
      };
      const symbol = "com.example.lib.Api";
      const report = {
        "src/main/scala/App.scala": {
          references: [1, 2, 3].map((line) => ({ line, symbol })),
          calls: [4, 5, 6].map((line) => ({ line, owner: symbol, name: "f" })),
        },
        "build.sc": { references: [{ line: 1, symbol }] },
        "src/main/java/Legacy.java": { calls: [{ line: 2, owner: symbol }] },
      };
      const evidence = await collectScalasemEvidence(report, [lib], {});
      assert.strictEqual(evidence.purlLocationMap[lib.purl].size, 2);
      const callSites = evidence.componentPropertiesMap[lib.purl].find(
        (property) => property.name === "cdx:scalasem:callSites",
      );
      assert.strictEqual(callSites?.value, "4");
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_SCALASEM_MAX_OCCURRENCES;
      } else {
        process.env.CDXGEN_SCALASEM_MAX_OCCURRENCES = previous;
      }
    }
  });

  it("caps the standard library at one occurrence per file", async () => {
    const report = recording("services-jvm");
    const stdlib = {
      purl: "pkg:maven/org.scala-lang/scala3-library@3.3.7",
      properties: [
        {
          name: "internal:Namespaces",
          value: "scala.Any\nscala.collection.immutable.List",
        },
      ],
    };
    const evidence = await collectScalasemEvidence(report, [stdlib], {});
    const locations = [...(evidence.purlLocationMap[stdlib.purl] || [])];
    assert.ok(locations.length > 1);
    const files = new Set(locations.map((location) => location.split("#")[0]));
    assert.strictEqual(locations.length, files.size);
  });

  it("publishes each call stack on its own for the frame picker", async () => {
    const report = recording("callstack-app");
    const okhttp = {
      purl: "pkg:maven/com.squareup.okhttp3/okhttp@4.12.0",
      properties: [
        {
          name: "internal:Namespaces",
          value: "okhttp3.OkHttpClient\nokhttp3.Call\nokhttp3.Request$Builder",
        },
      ],
    };
    const evidence = await collectScalasemEvidence(report, [okhttp], {});
    const stacks = evidence.dataFlowFrames[okhttp.purl];
    const sinks = report.callStacks.filter((stack) =>
      stack.sink.owner.startsWith("okhttp3."),
    );
    assert.ok(sinks.length > 1, "the fixture has several okhttp stacks");
    assert.strictEqual(stacks.length, sinks.length);
    for (const frames of stacks) {
      // Each list is one path: it ends at its own sink call.
      const last = frames[frames.length - 1];
      assert.ok(
        sinks.some(
          (stack) =>
            stack.sink.file === last.fullFilename &&
            stack.sink.line === last.line,
        ),
        JSON.stringify(last),
      );
    }
    // A frame names its class and package when a definition encloses it.
    const resolved = stacks.flat().find((frame) => frame.module);
    assert.ok(resolved, "no frame resolved to its class");
    assert.ok(resolved.module.startsWith(`${resolved.package}.`));
  });

  it("attaches namespaces with --deep, for a jar of the component's version only", async () => {
    const jarDir = mkdtempSync(join(tmpdir(), "scalasem-ns-"));
    const jarPath = join(jarDir, "http4s-ember-server_3-0.23.30.jar");
    writeFileSync(jarPath, "stub jar");
    const { collectScalasemEvidence: collect } = await esmock("./scalasem.js", {
      "../inventory/deps.js": {
        getJarClasses: async () => [
          "org.http4s.ember.server.EmberServerBuilder",
        ],
      },
    });
    const reportFor = (version) => ({
      _meta: { schemaVersion: "scalasem/2", diagnostics: [] },
      modules: [
        {
          id: "root",
          platform: "jvm",
          classpath: [
            {
              group: "org.http4s",
              artifact: "http4s-ember-server_3",
              version,
              path: jarPath,
            },
          ],
        },
      ],
    });
    const http4s = { purl: "pkg:maven/org.http4s/http4s-ember-server@0.23.30" };
    const namespacesOf = (evidence) =>
      (evidence.componentPropertiesMap[http4s.purl] || []).find(
        (property) => property.name === "internal:Namespaces",
      )?.value;
    assert.strictEqual(
      namespacesOf(
        await collect(reportFor("0.23.30"), [http4s], { deep: true }),
      ),
      "org.http4s.ember.server.EmberServerBuilder",
    );
    assert.strictEqual(
      namespacesOf(await collect(reportFor("0.23.30"), [http4s], {})),
      undefined,
    );
    assert.strictEqual(
      namespacesOf(
        await collect(reportFor("0.23.31"), [http4s], { deep: true }),
      ),
      undefined,
    );
    rmSync(jarDir, { recursive: true, force: true });
  });
});

let registryKeys;
const oidRegistryKeys = () => {
  registryKeys ??= new Set(
    Object.keys(
      JSON.parse(readFileSync(join("data", "crypto-oid.json"), "utf-8")),
    ),
  );
  return registryKeys;
};

describe("scalasem crypto assets", () => {
  const recording = (name) =>
    JSON.parse(
      readFileSync(join("test", "data", "scalasem", `${name}.json`), "utf-8"),
    );

  it("resolves key size and mode dependent spellings", () => {
    assert.strictEqual(scalasemCryptoOidKey("HS256"), "hmacWithSHA256");
    assert.strictEqual(
      scalasemCryptoOidKey("SHA256withECDSA"),
      "ecdsaWithSHA256",
    );
    assert.strictEqual(scalasemCryptoOidKey("PBKDF2WithHmacSHA256"), "PBKDF2");
    assert.strictEqual(scalasemCryptoOidKey("AES", 256, "GCM"), "aes256-GCM");
    assert.strictEqual(scalasemCryptoOidKey("AES", undefined, "GCM"), "aes");
    assert.strictEqual(scalasemCryptoOidKey("AES", 256), "aes");
    assert.strictEqual(scalasemCryptoOidKey("AES-KW", 128), "aes128-wrap");
    assert.strictEqual(scalasemCryptoOidKey("SHA-256"), "sha-256");
    assert.strictEqual(scalasemCryptoOidKey("Argon2id"), undefined);
    assert.strictEqual(scalasemCryptoOidKey("DRBG"), undefined);
  });

  it("keeps every canonical name either mapped or explicitly without an OID", () => {
    const canonical = JSON.parse(
      readFileSync(
        join("test", "data", "scalasem", "canonical-algorithms.json"),
        "utf-8",
      ),
    );
    assert.ok(Array.isArray(canonical) && canonical.length > 100);
    for (const name of canonical) {
      const key = scalasemCryptoOidKey(name);
      if (key) {
        assert.ok(
          oidRegistryKeys().has(key),
          `${name} resolved to ${key}, which the registry does not hold`,
        );
        assert.ok(
          !SCALASEM_NO_OID_ALGORITHMS.has(name) &&
            !SCALASEM_PROTOCOL_NAMES.has(name) &&
            !SCALASEM_KEYSTORE_NAMES.has(name),
          `${name} is both mapped and listed without an OID`,
        );
      } else {
        assert.ok(
          SCALASEM_NO_OID_ALGORITHMS.has(name) ||
            SCALASEM_PROTOCOL_NAMES.has(name) ||
            SCALASEM_KEYSTORE_NAMES.has(name),
          `${name} has neither an OID nor a list entry`,
        );
      }
    }
  });

  it("emits OID-backed assets with occurrence evidence", async () => {
    const report = recording("crypto-jvm");
    const bcprov = { purl: "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.86" };
    const evidence = await collectScalasemEvidence(report, [bcprov], {});
    const byName = Object.fromEntries(
      evidence.cryptoComponents.map((asset) => [asset.name, asset]),
    );
    assert.ok(byName["SHA3-256"]?.cryptoProperties.oid);
    assert.ok(
      byName["AES-GCM"].evidence.occurrences.some(
        (occurrence) =>
          occurrence.location.endsWith("corpus/crypto/JcaOps.scala") &&
          occurrence.line === 13,
      ),
    );
    assert.strictEqual(
      byName["DES-ECB"].cryptoProperties.algorithmProperties.mode,
      "ecb",
    );
    assert.strictEqual(
      byName["DES-ECB"].cryptoProperties.algorithmProperties.padding,
      "pkcs5",
    );
    assert.strictEqual(
      byName["RSA-2048"].cryptoProperties.algorithmProperties
        .parameterSetIdentifier,
      "2048",
    );
    // The library that provides the algorithms is linked and tagged.
    assert.ok(
      evidence.cryptoGeneratePurls[bcprov.purl]?.size > 0,
      "bcprov must provide its algorithms",
    );
  });

  it("keeps OID-less algorithms as properties, never as assets", async () => {
    const report = recording("crypto-jvm");
    const bcprov = { purl: "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.86" };
    const bcrypt = { purl: "pkg:maven/at.favre.lib/bcrypt@0.10.2" };
    const evidence = await collectScalasemEvidence(
      report,
      [bcprov, bcrypt],
      {},
    );
    const names = evidence.cryptoComponents.map((asset) => asset.name);
    assert.ok(!names.includes("Argon2id"));
    assert.ok(!names.includes("DRBG"));
    assert.ok(!names.includes("bcrypt"));
    const values = evidence.componentPropertiesMap[bcprov.purl]
      ?.filter((property) => property.name === "cdx:scalasem:crypto:algorithm")
      .map((property) => property.value);
    assert.ok(
      values.includes(
        "Argon2id@src/main/scala/corpus/crypto/BouncyCastleOps.scala#21",
      ),
      JSON.stringify(values),
    );
  });
});

describe("scalasem services", () => {
  const recording = (name) =>
    JSON.parse(
      readFileSync(join("test", "data", "scalasem", `${name}.json`), "utf-8"),
    );

  it("names outbound services after what they talk to", () => {
    const report = recording("services-jvm");
    const services = collectScalasemServices(report, {});
    assert.ok(services["payments.example.com"]);
    // A JDBC target is named by its scheme and host, and keeps the database
    // name in its endpoint.
    assert.ok(
      services["postgresql-db.internal"].endpoints.has(
        "jdbc:postgresql://db.internal:5432/orders",
      ),
    );
    // A messaging topic is named client:topic.
    assert.ok(
      services["kafka:order-events"].endpoints.has("kafka:order-events"),
    );
    assert.strictEqual(
      services["payments.example.com"].properties.find(
        (property) => property.name === "cdx:scalasem:service:kind",
      )?.value,
      "http-client",
    );
    assert.strictEqual(services["payments.example.com"].xTrustBoundary, true);
    const locations = services["payments.example.com"].properties
      .filter((property) => property.name === "cdx:scalasem:service:location")
      .map((property) => property.value);
    assert.ok(
      locations.includes(
        "src/main/scala/corpus/services/Http4sClients.scala#9",
      ),
      JSON.stringify(locations),
    );
  });

  it("names each inbound route like the OpenAPI reader", () => {
    const report = recording("services-jvm");
    const services = collectScalasemApiEndpoints(report, {});
    const service = services["service-caskhello{name}-get"];
    assert.ok(service, JSON.stringify(Object.keys(services).slice(0, 4)));
    assert.ok(service.endpoints.has("/cask/hello/{name}"));
    assert.strictEqual(
      service.properties.find((p) => p.name === "cdx:service:httpMethod")
        ?.value,
      "GET",
    );
  });

  it("validates BOMs with Scala services at 1.6 and 1.7", async () => {
    const report = recording("services-jvm");
    const servicesMap = collectScalasemApiEndpoints(
      report,
      collectScalasemServices(report, {}),
    );
    const services = mergeServices([], normalizeDosaiServiceMap(servicesMap));
    for (const specVersion of ["1.6", "1.7"]) {
      const bomJson = {
        bomFormat: "CycloneDX",
        specVersion,
        version: 1,
        metadata: {
          timestamp: new Date().toISOString(),
          component: {
            type: "application",
            name: "scala-services",
            "bom-ref": "app",
          },
        },
        components: [{ type: "library", name: "lib", "bom-ref": "lib" }],
        dependencies: [{ ref: "app", dependsOn: ["lib"] }],
        services,
      };
      const result = await postProcess({ bomJson }, { specVersion });
      assert.strictEqual(
        await validateBom(result.bomJson),
        true,
        `Scala services BOM must validate at ${specVersion}`,
      );
      // The evidence field is gone below 2.0; the location properties remain.
      for (const service of result.bomJson.services) {
        assert.strictEqual(service.evidence, undefined);
      }
      assert.ok(
        result.bomJson.services.some((service) =>
          (service.properties || []).some(
            (property) => property.name === "cdx:scalasem:service:location",
          ),
        ),
      );
    }
  });
});

describe("scala dispatch never runs atom", () => {
  const stubReport = {
    _meta: {
      schemaVersion: "scalasem/2",
      tool: "scalasem",
      projectPath: "WILL_REPLACE",
      generatedFrom: ["tasty"],
      compilers: [{ version: "3.3.7", source: "sbt" }],
      platforms: ["jvm"],
      counts: { files: 1 },
      diagnostics: [],
    },
    config: { routes: [] },
    modules: [],
    "src/App.scala": {
      sourceFile: "src/App.scala",
      tags: [],
      usedTypes: [],
      literals: [],
      scope: "main",
      references: [
        {
          line: 1,
          column: 1,
          symbol: "jwt.core.Jwt",
          owner: "jwt.core",
          kind: "import",
        },
      ],
      calls: [],
    },
    crypto: [
      {
        algorithm: "SHA-256",
        api: "JCA",
        file: "src/App.scala",
        kind: "algorithm",
        line: 3,
        primitive: "hash",
        provider: "jdk",
        resolution: "literal",
      },
    ],
    services: [
      {
        kind: "http-client",
        client: "sttp",
        url: "https://api.example.com/v1",
        file: "src/App.scala",
        line: 4,
        resolution: "literal",
      },
    ],
    endpoints: [
      {
        framework: "cask",
        method: "GET",
        path: "/hello",
        file: "src/App.scala",
        line: 6,
        handler: "App$.hello",
      },
    ],
  };

  const work = mkdtempSync(join(tmpdir(), "scalasem-dispatch-"));
  const reportText = JSON.stringify(
    JSON.stringify({
      ...stubReport,
      _meta: { ...stubReport._meta, projectPath: "__PROJECT__" },
    }),
  );

  it("analyzes through scalasem and leaves the atom stub uncalled", async () => {
    const atomLog = join(work, "atom-calls.log");
    writeFileSync(
      join(work, "atom-stub.js"),
      `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(atomLog)}, process.argv.join(" ") + "\\n");
process.exit(0);
`,
    );
    // The report the scalasem stub writes names the project it ran on.
    writeFileSync(
      join(work, "scalasem-stub.js"),
      `#!/usr/bin/env node
const report = ${reportText}.replace('"__PROJECT__"', JSON.stringify(process.argv[2]));
require("node:fs").writeFileSync(process.argv[3], report);
`,
    );
    const projectDir = join(work, "project");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "App.scala"), "object App\n");
    const bomFile = join(work, "bom.json");
    const jwt = {
      purl: "pkg:maven/com.github.jwt-scala/jwt-core@11.0.0?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
      properties: [{ name: "internal:Namespaces", value: "jwt.core.Jwt" }],
    };
    writeFileSync(
      bomFile,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: {
          component: { type: "application", name: "app", "bom-ref": "app" },
        },
        components: [jwt],
        dependencies: [{ ref: "app", dependsOn: [jwt.purl] }],
      }),
    );
    const { analyzeProject, createEvinseFile } = await import(
      "../evinser/evinser.js"
    );
    const artefacts = await analyzeProject(undefined, {
      _: [projectDir],
      input: bomFile,
      output: join(work, "bom.evinse.json"),
      language: "scala",
      semanticsSlicesFile: join(work, "semantics.slices.json"),
      scalasemCommand: join(work, "scalasem-stub.js"),
      scalasemIncludeTests: false,
    });
    // The report evidence arrived for every kind.
    assert.ok(artefacts.purlLocationMap[jwt.purl]?.size > 0);
    assert.ok(artefacts.cryptoComponents.length === 1);
    assert.ok(Object.keys(artefacts.servicesMap).length === 2);
    assert.ok(artefacts.metadataProperties.length > 0);
    const evinseJson = await createEvinseFile(artefacts, {
      input: bomFile,
      output: join(work, "bom.evinse.json"),
      jsonPretty: false,
    });
    assert.ok(
      evinseJson.components.some((c) => c.evidence?.occurrences?.length),
    );
    assert.ok(evinseJson.services.length === 2);
    // Atom was never invoked.
    assert.strictEqual(
      safeExistsSync(atomLog),
      false,
      "the atom stub recorded a call",
    );
  });

  it("evinse -l scala, cdxgen --evidence and cbom never spawn the atom stub", async () => {
    // The real CLIs run here, so this test keeps a directory of its own.
    const work = mkdtempSync(join(tmpdir(), "scalasem-cli-"));
    const atomLog = join(work, "atom-cli-calls.log");
    writeFileSync(
      join(work, "atom-cli-stub.js"),
      `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(atomLog)}, process.argv.join(" ") + "\\n");
process.exit(0);
`,
    );
    const projectDir = join(work, "cli-project");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "App.scala"), "object App\n");
    // This test stands on its own: the sibling test above may not have run
    // yet, so the input BOM is written here.
    writeFileSync(
      join(work, "bom.json"),
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: {
          component: { type: "application", name: "app", "bom-ref": "app" },
        },
        components: [],
        dependencies: [{ ref: "app", dependsOn: [] }],
      }),
    );
    writeFileSync(
      join(work, "scalasem-cli-stub.js"),
      `#!/usr/bin/env node
const report = ${reportText}.replace('"__PROJECT__"', JSON.stringify(process.argv[2]));
require("node:fs").writeFileSync(process.argv[3], report);
`,
    );
    const env = {
      ...process.env,
      ATOM_CMD: join(work, "atom-cli-stub.js"),
      SCALASEM_CMD: join(work, "scalasem-cli-stub.js"),
      CDXGEN_SCALASEM_TIMEOUT: "120000",
    };
    const run = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, args, { env, cwd: work });
        let settled = false;
        child.on("close", (code) => {
          if (!settled) {
            settled = true;
            resolve(code);
          }
        });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill("SIGKILL");
            resolve("timeout");
          }
        }, 240_000).unref();
      });
    const code = await run([
      join(repoRoot, "bin", "evinse.js"),
      "-i",
      join(work, "bom.json"),
      "-o",
      join(work, "bom.evinse.cli.json"),
      "-l",
      "scala",
      "--semantics-slices-file",
      join(work, "cli-semantics.slices.json"),
      projectDir,
    ]);
    assert.ok(code === 0, `evinse exited ${code}`);
    const evidenceCode = await run([
      join(repoRoot, "bin", "cdxgen.js"),
      "-t",
      "scala",
      "--evidence",
      "-o",
      join(work, "bom.evidence.json"),
      projectDir,
    ]);
    assert.ok(evidenceCode === 0, `cdxgen --evidence exited ${evidenceCode}`);
    const cbomCode = await run([
      join(repoRoot, "bin", "cdxgen.js"),
      "cbom",
      "-t",
      "scala",
      "-o",
      join(work, "bom.cbom.json"),
      projectDir,
    ]);
    assert.ok(cbomCode === 0, `cbom exited ${cbomCode}`);
    assert.strictEqual(
      safeExistsSync(atomLog),
      false,
      "the atom stub recorded a call from one of the three entry points",
    );
    rmSync(work, { recursive: true, force: true });
  }, 600_000);
});

describe("scalajs npm dependencies", () => {
  it("collects the npm packages a scalajs build bundles", async () => {
    const scalajs = await collectScalaJsNpmComponents(
      join("test", "data", "scalajs-npm"),
      [{ name: "client_sjs1" }],
    );
    const purls = scalajs.components.map((component) => component.purl);
    assert.ok(purls.includes("pkg:npm/chart.js@4.4.1"), JSON.stringify(purls));
    assert.ok(purls.includes("pkg:npm/%40kurkle/color@0.3.2"));
    assert.ok(scalajs.roots.includes("pkg:npm/client-app@0.1.0"));
    assert.ok(scalajs.dependencies.length > 0);
    // A JVM-only build collects nothing.
    const plain = await collectScalaJsNpmComponents(
      join("test", "data", "scalajs-npm"),
      [{ name: "bcprov-jdk18on" }],
    );
    assert.deepStrictEqual(plain.components, []);
  });

  it("attributes module imports to npm components and names the rest", async () => {
    const report = {
      _meta: { schemaVersion: "scalasem/2", diagnostics: [] },
      modules: [],
      jsModules: [
        {
          module: "chart.js/auto",
          owner: "ui.Charts",
          file: "src/Charts.scala",
          line: 4,
        },
        {
          module: "@kurkle/color",
          owner: "ui.Colors",
          file: "src/Colors.scala",
          line: 6,
        },
        { module: "left-pad", owner: "ui.Pad", file: "src/Pad.scala", line: 8 },
        {
          module: "./relative.js",
          owner: "ui.Rel",
          file: "src/Rel.scala",
          line: 9,
        },
      ],
    };
    const chartjs = { purl: "pkg:npm/chart.js@4.4.1" };
    const kurkle = { purl: "pkg:npm/%40kurkle/color@0.3.2" };
    const evidence = await collectScalasemEvidence(
      report,
      [chartjs, kurkle],
      {},
    );
    assert.ok(
      [...(evidence.purlLocationMap[chartjs.purl] || [])].includes(
        "src/Charts.scala#4",
      ),
    );
    assert.ok(
      [...(evidence.purlLocationMap[kurkle.purl] || [])].includes(
        "src/Colors.scala#6",
      ),
    );
    const jsModuleProps = evidence.componentPropertiesMap[chartjs.purl]
      ?.filter((property) => property.name === "cdx:scalasem:jsModule")
      .map((property) => property.value);
    assert.deepStrictEqual(jsModuleProps, ["chart.js/auto"]);
    // No component owns left-pad: the project component names it. The
    // relative import is not a module dependency at all.
    const unmatched = evidence.metadataProperties.find(
      (property) => property.name === "cdx:scalasem:jsModules",
    );
    assert.strictEqual(unmatched?.value, "left-pad");
  });
});
