import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import esmock from "esmock";
import { safeExistsSync } from "../core/fs.js";
import { assert, describe, it } from "poku";

import { normalizeDosaiServiceMap } from "../inventory/dosai.js";
import { mergeServices } from "../inventory/depsUtils.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { validateBom } from "../validator/bomValidator.js";

import {
  ScalaJoinIndex,
  analyzeScalaProject,
  buildScalaJoinIndex,
  collectScalasemEvidence,
  componentCoordinateIndex,
  isScalasemLanguage,
  matchClasspathEntry,
  resolveScalasemCommand,
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
  console.log = () => {};
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
      JSON.stringify({ ...v2Report, _meta: { ...v2Report._meta, projectPath: projectDir } }),
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
  const upickleNative = { purl: "pkg:maven/com.lihaoyi/upickle_native0.5@3.0.0" };
  const millArtifact = {
    purl: "pkg:maven/com.lihaoyi/upickle_3@3.0.0?type=jar",
  };

  it("matches classpath jars to components through normalized coordinates", () => {
    const components = [catsSbt, upickleJvm, upickleSjs, upickleNative, millArtifact];
    const coordinateIndex = componentCoordinateIndex(components);
    // An sbt component: the Scala suffix is stripped, the platform suffix kept.
    assert.strictEqual(
      matchClasspathEntry(
        { group: "org.typelevel", artifact: "cats-core_3", version: "2.12.0" },
        coordinateIndex,
        "jvm",
      ),
      catsSbt,
    );
    // A Mill or Maven component keeps the full artifactId.
    assert.strictEqual(
      matchClasspathEntry(
        { group: "com.lihaoyi", artifact: "upickle_3", version: "3.0.0" },
        coordinateIndex,
        "jvm",
      ),
      millArtifact,
    );
    // The module platform picks between the JVM, JS and Native artifacts.
    assert.strictEqual(
      matchClasspathEntry(
        { group: "com.lihaoyi", artifact: "upickle_sjs1_3", version: "3.0.0" },
        coordinateIndex,
        "js",
      ),
      upickleSjs,
    );
    assert.strictEqual(
      matchClasspathEntry(
        {
          group: "com.lihaoyi",
          artifact: "upickle_native0.5_3",
          version: "3.0.0",
        },
        coordinateIndex,
        "native",
      ),
      upickleNative,
    );
    // A jar the BOM does not hold matches nothing.
    assert.strictEqual(
      matchClasspathEntry(
        { group: "org.unknown", artifact: "nope_3", version: "1.0.0" },
        coordinateIndex,
        "jvm",
      ),
      undefined,
    );
  });

  it("indexes symbols with earlier sources winning", () => {
    const index = new ScalaJoinIndex();
    index.addNamespaces(upickleJvm.purl, ["upickle.imp.Builder$", "upickle.core.Types"], 2);
    assert.strictEqual(index.lookup("upickle.imp.Builder$"), upickleJvm.purl);
    // A package-only reference joins through its single owner.
    assert.strictEqual(index.lookup("upickle.imp.Listener"), upickleJvm.purl);
    // The classpath source outranks the namespace property, whenever it runs.
    index.addNamespaces("pkg:maven/other/thing@1.0.0", ["upickle.core.Types"], 1);
    assert.strictEqual(
      index.lookup("upickle.core.Types"),
      "pkg:maven/other/thing@1.0.0",
    );
  });

  it("picks the platform variant when several purls own one class", () => {
    const index = new ScalaJoinIndex();
    index.addNamespaces(upickleJvm.purl, ["upickle.imp.Builder$"], 2);
    index.addNamespaces(upickleSjs.purl, ["upickle.imp.Builder$"], 2);
    index.addNamespaces(upickleNative.purl, ["upickle.imp.Builder$"], 2);
    assert.strictEqual(index.lookup("upickle.imp.Builder$", "js"), upickleSjs.purl);
    assert.strictEqual(
      index.lookup("upickle.imp.Builder$", "native"),
      upickleNative.purl,
    );
    // Without a platform the JVM speaks for the library.
    assert.strictEqual(index.lookup("upickle.imp.Builder$"), upickleJvm.purl);
  });

  it("leaves a package owned by two libraries unresolved", () => {
    const index = new ScalaJoinIndex();
    index.addNamespaces("pkg:maven/a/one@1.0.0", ["com.example.Foo"], 2);
    index.addNamespaces("pkg:maven/b/two@1.0.0", ["com.example.Bar"], 2);
    assert.strictEqual(index.lookup("com.example.Foo"), "pkg:maven/a/one@1.0.0");
    assert.strictEqual(index.lookup("com.example.New"), undefined);
  });

  it("reads the classpath jars of components without namespaces", async () => {
    const jarDir = mkdtempSync(join(tmpdir(), "scalasem-jar-"));
    const jarPath = join(jarDir, "lib_3-1.0.0.jar");
    writeFileSync(jarPath, "stub jar");
    const { buildScalaJoinIndex } = await esmock("./scalasem.js", {
      "../inventory/deps.js": {
        getJarClasses: async () => ["com.example.lib.Real", "com.example.lib.Helper"],
      },
    });
    const report = {
      modules: [
        {
          id: "root",
          platform: "jvm",
          classpath: [
            { group: "com.example", artifact: "lib_3", version: "1.0.0", path: jarPath },
            { group: "org.missing", artifact: "absent_3", version: "1.0.0", path: "/cache/absent.jar" },
          ],
        },
      ],
    };
    const libComponent = { purl: "pkg:maven/com.example/lib@1.0.0" };
    const withNamespaces = {
      purl: "pkg:maven/org.typelevel/cats-core@2.12.0",
      properties: [{ name: "internal:Namespaces", value: "cats.data.NonEmptyList" }],
    };
    const index = await buildScalaJoinIndex(report, [libComponent, withNamespaces], {
      "pkg:maven/com.lihaoyi/upickle_3@3.0.0?type=jar": {
        namespaces: ["upickle.imp.Builder$"],
      },
    });
    assert.strictEqual(index.lookup("com.example.lib.Real"), libComponent.purl);
    assert.strictEqual(index.namespacesByPurl.get(libComponent.purl).length, 2);
    // The namespace property source beats the map entry, which is never read.
    assert.strictEqual(index.lookup("cats.data.NonEmptyList"), withNamespaces.purl);
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
    JSON.parse(readFileSync(join("test", "data", "scalasem", `${name}.json`), "utf-8"));

  it("maps references and calls to occurrences with lines", async () => {
    const report = recording("services-jvm");
    const kafka = {
      purl: "pkg:maven/org.apache.kafka/kafka-clients@3.9.0?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
      properties: [
        {
          name: "internal:Namespaces",
          value: "org.apache.kafka.clients.producer.KafkaProducer\norg.apache.kafka.clients.producer.ProducerRecord",
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
        location.startsWith("src/main/scala/corpus/services/DataStores.scala#1"),
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

  it("caps the standard library at one occurrence per file", async () => {
    const report = recording("services-jvm");
    const stdlib = {
      purl: "pkg:maven/org.scala-lang/scala3-library@3.3.7",
      properties: [{ name: "internal:Namespaces", value: "scala.Any\nscala.collection.immutable.List" }],
    };
    const evidence = await collectScalasemEvidence(report, [stdlib], {});
    const locations = [...(evidence.purlLocationMap[stdlib.purl] || [])];
    const files = new Set(locations.map((location) => location.split("#")[0]));
    assert.strictEqual(locations.length, files.size);
  });

  it("keeps the sink hop in every call stack frame list", async () => {
    const report = recording("callstack-app");
    const sqlite = {
      purl: "pkg:maven/org.xerial/sqlite-jdbc@3.46.0",
      properties: [{ name: "internal:Namespaces", value: "org.sqlite.SQLiteDataSource" }],
    };
    const evidence = await collectScalasemEvidence(report, [sqlite], {});
    const stacks = evidence.dataFlowFrames[sqlite.purl];
    assert.ok(stacks?.length, "no sqlite stacks");
    const first = stacks[0];
    const last = first[first.length - 1];
    assert.strictEqual(last.fullFilename, "src/main/scala/corpus/flow/Repo.scala");
    assert.strictEqual(last.line, 16);
    assert.ok(
      first[0].fullFilename === "src/main/scala/corpus/flow/Main.scala",
      "the entry point must come first",
    );
  });

  it("attaches namespaces for components the classpath join read", async () => {
    const jarDir = mkdtempSync(join(tmpdir(), "scalasem-ns-"));
    const jarPath = join(jarDir, "http4s-ember-server_3-0.23.30.jar");
    writeFileSync(jarPath, "stub jar");
    const { collectScalasemEvidence: collect } = await esmock("./scalasem.js", {
      "../inventory/deps.js": {
        getJarClasses: async () => ["org.http4s.ember.server.EmberServerBuilder"],
      },
    });
    const report = {
      _meta: { schemaVersion: "scalasem/2", diagnostics: [] },
      modules: [
        {
          id: "root",
          platform: "jvm",
          classpath: [
            {
              group: "org.http4s",
              artifact: "http4s-ember-server_3",
              version: "0.23.30",
              path: jarPath,
            },
          ],
        },
      ],
    };
    const http4s = { purl: "pkg:maven/org.http4s/http4s-ember-server@0.23.30" };
    const evidence = await collect(report, [http4s], {});
    const properties = evidence.componentPropertiesMap[http4s.purl] || [];
    const namespaces = properties.find(
      (property) => property.name === "internal:Namespaces",
    );
    assert.strictEqual(
      namespaces?.value,
      "org.http4s.ember.server.EmberServerBuilder",
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
