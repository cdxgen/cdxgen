import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import {
  determineSbtVersion,
  findCoursierRegistryUrl,
  findLocalJarPath,
  parseSbtLock,
  parseSbtProjects,
  parseSbtTree,
  resolveJarDistribution,
} from "./sbtutils.js";
import { readEnvironmentVariable } from "./utils.js";

it("parse scala sbt tree", async () => {
  const retMap = await parseSbtTree("./test/data/atom-sbt-tree.txt");
  assert.deepStrictEqual(retMap.pkgList.length, 153);
  assert.deepStrictEqual(retMap.dependenciesList.length, 153);

  // Assert Scala suffix was trimmed and registered as property
  const coursierPkg = retMap.pkgList.find(
    (p) => p.name === "coursier" && p.group === "io.get-coursier",
  );
  assert.ok(coursierPkg);
  assert.ok(
    coursierPkg.purl.startsWith("pkg:maven/io.get-coursier/coursier@2.1.2?"),
  );
  assert.ok(coursierPkg.purl.includes("type=jar"));

  const compilerVersionProp = coursierPkg.properties.find(
    (prop) => prop.name === "cdx:scala:compilerVersion",
  );
  assert.ok(compilerVersionProp);
  assert.strictEqual(compilerVersionProp.value, "2.13");
});

it("parse sbt projects output", () => {
  const output = `[info] welcome to sbt 1.11.7
[info] loading project definition
[info] In file:/app/
[info] 	   * chen
[info] 	     platform
[info] 	     dataflowengineoss
[info] 	     semanticcpg
[info]
[info] done`;
  const { projects, root } = parseSbtProjects(output);
  assert.strictEqual(root, "chen");
  assert.deepStrictEqual(projects, [
    "chen",
    "platform",
    "dataflowengineoss",
    "semanticcpg",
  ]);

  // Single project build (root only)
  const singleOutput = `[info] In file:/app/
[info] 	   * atom`;
  const single = parseSbtProjects(singleOutput);
  assert.strictEqual(single.root, "atom");
  assert.deepStrictEqual(single.projects, ["atom"]);

  // Empty / unexpected output
  const empty = parseSbtProjects("");
  assert.deepStrictEqual(empty.projects, []);
  assert.strictEqual(empty.root, undefined);
});

it("parse scala sbt lock", async () => {
  const deps = await parseSbtLock("./test/data/build.sbt.lock");
  assert.deepStrictEqual(deps.length, 117);

  // Assert Scala suffix was trimmed and registered as property in sbt lock
  const akkaActorPkg = deps.find(
    (p) => p.name === "akka-actor" && p.group === "com.typesafe.akka",
  );
  assert.ok(akkaActorPkg);

  const compilerVersionProp = akkaActorPkg.properties.find(
    (prop) => prop.name === "cdx:scala:compilerVersion",
  );
  assert.ok(compilerVersionProp);
  assert.strictEqual(compilerVersionProp.value, "2.13");
});

it("parse scala sbt tree with spaces for columns (monorepo tree)", async () => {
  const retMap = await parseSbtTree("./test/data/chen-sbt-tree.txt");
  // The first component is the root "c2cpg", the rest are dependencies.
  // There are some evicted lines, let's check unique parsed non-evicted pkg entries.
  assert.ok(retMap.pkgList.length > 50);

  // Verify that a node with space indentation like org.slf4j:slf4j-api:2.0.18 under slf4j-nop
  // is correctly identified as a child of its parent (org.slf4j:slf4j-nop:2.0.18)
  const nopDep = retMap.dependenciesList.find((d) =>
    d.ref.includes("slf4j-nop"),
  );
  assert.ok(nopDep);
  assert.ok(nopDep.dependsOn.some((child) => child.includes("slf4j-api")));
});

it("findCoursierRegistryUrl resolves registry URL from local cache path structure", () => {
  const tmpCacheRoot = path.join(
    tmpdir(),
    `cdxgen-coursier-test-${Date.now()}`,
  );
  const targetDir = path.join(
    tmpCacheRoot,
    "https",
    "repo1.maven.org",
    "maven2",
    "org",
    "scala-lang",
    "scala-library",
    "2.13.8",
  );
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(path.join(targetDir, "scala-library-2.13.8.jar"), "mock");

  const oldCacheEnv = readEnvironmentVariable("COURSIER_CACHE");
  process.env.COURSIER_CACHE = tmpCacheRoot;

  try {
    const url = findCoursierRegistryUrl(
      "org.scala-lang",
      "scala-library",
      "2.13.8",
    );
    assert.strictEqual(url, "https://repo1.maven.org/maven2");
  } finally {
    if (oldCacheEnv) {
      process.env.COURSIER_CACHE = oldCacheEnv;
    } else {
      delete process.env.COURSIER_CACHE;
    }
    rmSync(tmpCacheRoot, { recursive: true, force: true });
  }
});

it("resolveJarDistribution resolves registry URLs, validates existence, and extracts hashes", async () => {
  const tmpCacheRoot = path.join(
    tmpdir(),
    `cdxgen-coursier-https-test-${Date.now()}`,
  );
  const cacheTargetDir = path.join(
    tmpCacheRoot,
    "https",
    "repo1.maven.org",
    "maven2",
    "org",
    "scala-lang",
    "scala-library",
    "2.13.8",
  );
  mkdirSync(cacheTargetDir, { recursive: true });
  writeFileSync(path.join(cacheTargetDir, "scala-library-2.13.8.jar"), "mock");

  const oldCacheEnv = readEnvironmentVariable("COURSIER_CACHE");
  process.env.COURSIER_CACHE = tmpCacheRoot;

  try {
    const localJar = findLocalJarPath(
      "org.scala-lang",
      "scala-library",
      "2.13.8",
    );
    assert.ok(localJar);

    const dist = await resolveJarDistribution(
      "org.scala-lang",
      "scala-library",
      "2.13.8",
    );
    assert.ok(dist);
    assert.strictEqual(dist.repoUrl, "https://repo1.maven.org/maven2");
    assert.strictEqual(
      dist.jarUrl,
      "https://repo1.maven.org/maven2/org/scala-lang/scala-library/2.13.8/scala-library-2.13.8.jar",
    );
    assert.ok(dist.hashes);
    const sha256Hash = dist.hashes.find((h) => h.alg === "SHA-256");
    assert.ok(sha256Hash);
  } finally {
    if (oldCacheEnv) {
      process.env.COURSIER_CACHE = oldCacheEnv;
    } else {
      delete process.env.COURSIER_CACHE;
    }
    rmSync(tmpCacheRoot, { recursive: true, force: true });
  }
});

it("determineSbtVersion reads and parses sbt.version from build.properties", () => {
  const tmpProjectRoot = path.join(
    tmpdir(),
    `cdxgen-sbt-version-test-${Date.now()}`,
  );
  const projectDir = path.join(tmpProjectRoot, "project");
  mkdirSync(projectDir, { recursive: true });

  const buildPropertiesContent = `
# This is a comment
! This is also a comment
sbt.version=1.9.0
`;
  writeFileSync(
    path.join(projectDir, "build.properties"),
    buildPropertiesContent,
  );

  try {
    const version = determineSbtVersion(tmpProjectRoot);
    assert.strictEqual(version, "1.9.0");
  } finally {
    rmSync(tmpProjectRoot, { recursive: true, force: true });
  }
});

it("parseSbtTree keeps dependency refs equal to component bom-refs", async () => {
  // A package present in the Coursier cache gains a `repository_url` qualifier,
  // which percent-encodes the `//` of the URL. The dependency graph has to use the
  // decoded form so that it matches the component `bom-ref`, otherwise every
  // cached package ends up with a ref that resolves to nothing and the tree is
  // discarded downstream. See https://github.com/cdxgen/cdxgen/issues/4291
  const tmpCacheRoot = path.join(
    tmpdir(),
    `cdxgen-coursier-refs-${Date.now()}`,
  );
  const cachedDir = path.join(
    tmpCacheRoot,
    "https",
    "repo1.maven.org",
    "maven2",
    "org",
    "scala-lang",
    "scala3-library_3",
    "3.3.4",
  );
  mkdirSync(cachedDir, { recursive: true });
  writeFileSync(path.join(cachedDir, "scala3-library_3-3.3.4.jar"), "mock");

  const oldCacheEnv = readEnvironmentVariable("COURSIER_CACHE");
  process.env.COURSIER_CACHE = tmpCacheRoot;
  try {
    const retMap = await parseSbtTree("./test/data/sbt-tree-4291.txt");
    const scalaPkg = retMap.pkgList.find((p) => p.name === "scala3-library");
    assert.ok(scalaPkg);
    // Non-vacuity: the qualifier has to be present and percent-encoded, otherwise
    // there would be nothing for the decoding to fix. Which characters get encoded
    // differs between purl libraries, so only the fact of the encoding is asserted.
    assert.ok(scalaPkg.purl.includes("repository_url="), scalaPkg.purl);
    assert.notStrictEqual(scalaPkg.purl, scalaPkg["bom-ref"]);
    assert.ok(
      scalaPkg["bom-ref"].includes(
        "repository_url=https://repo1.maven.org/maven2",
      ),
      scalaPkg["bom-ref"],
    );

    const refs = new Set(retMap.pkgList.map((p) => p["bom-ref"]));
    let edges = 0;
    for (const adep of retMap.dependenciesList) {
      assert.ok(refs.has(adep.ref), `dangling entry ref ${adep.ref}`);
      for (const child of adep.dependsOn) {
        edges++;
        assert.ok(refs.has(child), `dangling dependsOn ${child}`);
      }
    }
    assert.ok(edges > 0);
    const libA = retMap.dependenciesList.find((d) => d.ref.includes("lib-a"));
    assert.deepStrictEqual(libA.dependsOn, [scalaPkg["bom-ref"]]);
  } finally {
    if (oldCacheEnv) {
      process.env.COURSIER_CACHE = oldCacheEnv;
    } else {
      delete process.env.COURSIER_CACHE;
    }
    rmSync(tmpCacheRoot, { recursive: true, force: true });
  }
});

it("parseSbtTree drops evicted subtrees, ranges and truncated coordinates", async () => {
  const retMap = await parseSbtTree("./test/data/sbt-tree-4291.txt");
  const names = retMap.pkgList.map((p) => `${p.group}:${p.name}:${p.version}`);
  assert.deepStrictEqual(names.sort(), [
    "com.example:app-core:1.0.0",
    "com.example:lib-a:2.0.0",
    "com.example:lib-b:3.1.0",
    "com.example:lib-c:4.2.0",
    "org.scala-lang:scala3-library:3.3.4",
  ]);
  // The transitive dependency of an evicted version is not part of the resolved
  // graph and must not be reparented onto an unrelated node.
  assert.ok(!names.some((n) => n.includes("evicted-only-child")));
  // A version range is not a resolved version.
  assert.ok(!names.some((n) => n.includes("equinox")));
  // A coordinate cut short by asciiGraphWidth cannot yield a valid maven purl.
  assert.ok(!names.some((n) => n.includes("jackson-module-jakarta")));

  const byRef = (frag) =>
    retMap.dependenciesList.find((d) => d.ref.includes(frag));
  assert.deepStrictEqual(byRef("app-core").dependsOn.length, 2);
  assert.ok(byRef("app-core").dependsOn.every((r) => /lib-a|lib-b/.test(r)));
  assert.ok(byRef("lib-b").dependsOn.some((r) => r.includes("lib-c")));
  assert.deepStrictEqual(byRef("lib-c").dependsOn, []);
});

const chunkDir = mkdtempSync(path.join(tmpdir(), "cdxgen-sbt2-"));
const chunkFiles = [];
function writeFileChunk(chunk) {
  const chunkFile = path.join(chunkDir, `chunk-${chunkFiles.length}.tmp`);
  writeFileSync(chunkFile, chunk);
  chunkFiles.push(chunkFile);
  return chunkFile;
}

it("sbt2DependencyTreeCommand scopes every step to its project", async () => {
  const { sbt2DependencyTreeCommand } = await import("./sbtutils.js");
  assert.strictEqual(
    sbt2DependencyTreeCommand(["backend", "ui"], true),
    "set ThisBuild / asciiGraphWidth := 800; backend/updateClassifiers; backend/dependencyTree; ui/updateClassifiers; ui/dependencyTree",
  );
  // The per-subproject retry never resolves the classifiers of the others
  assert.strictEqual(
    sbt2DependencyTreeCommand(["backend"], true),
    "set ThisBuild / asciiGraphWidth := 800; backend/updateClassifiers; backend/dependencyTree",
  );
  assert.strictEqual(
    sbt2DependencyTreeCommand([], false),
    "set ThisBuild / asciiGraphWidth := 800; dependencyTree",
  );
  // One argument, no shell quoting: it reaches sbt verbatim
  assert.ok(!sbt2DependencyTreeCommand(["a"], false).includes("'"));
});

it("splitSbtDependencyTrees splits the captured sbt 2 stdout per project", async () => {
  const { readFileSync } = await import("node:fs");
  const { splitSbtDependencyTrees } = await import("./sbtutils.js");
  const stdout = readFileSync("./test/data/sbt2-dependency-tree.txt", {
    encoding: "utf-8",
  });
  const chunks = splitSbtDependencyTrees(stdout);
  // One chunk per tree: the backend, ui and docker projects in command order
  assert.strictEqual(
    chunks.length,
    3,
    `expected 3 chunks, got ${chunks.length}`,
  );
  assert.ok(chunks[0].startsWith("com.softwaremill.bootzooka:backend_3:"));
  assert.ok(chunks[1].startsWith("com.softwaremill.bootzooka:ui_3:"));
  assert.ok(chunks[2].startsWith("com.softwaremill.bootzooka:docker_3:"));
  // Every chunk parses into the components and relations the tree describes
  const backendMap = await parseSbtTree(writeFileChunk(chunks[0]));
  const backendRoot = backendMap.pkgList[0];
  assert.strictEqual(backendRoot.group, "com.softwaremill.bootzooka");
  assert.strictEqual(backendRoot.name, "backend");
  assert.strictEqual(backendRoot.version, "893fceb");
  assert.ok(backendMap.pkgList.length > 50, "the backend tree lost components");
  assert.ok(
    backendMap.dependenciesList.some((d) => d.dependsOn.length > 5),
    "the backend tree lost its relations",
  );
  const uiMap = await parseSbtTree(writeFileChunk(chunks[1]));
  assert.deepStrictEqual(
    uiMap.pkgList.map((p) => p.name),
    // The ui project only depends on the Scala 3 library, which carries the
    // library marker sbt prints for scala-library dependencies
    ["ui", "scala3-library"],
  );
});

it("sbt 2 output without any tree yields no chunks", async () => {
  const { splitSbtDependencyTrees } = await import("./sbtutils.js");
  assert.deepStrictEqual(
    splitSbtDependencyTrees(
      "[info] welcome to sbt 2.0.10\n> print backend/dependencyTree\n[error] Not a valid key: dependencyTree\n",
    ),
    [],
  );
  assert.deepStrictEqual(splitSbtDependencyTrees(""), []);
});

it("sbt project discovery keeps a root project that has sources", async () => {
  const { mkdirSync } = await import("node:fs");
  const esmock = (await import("esmock")).default;
  const sinon = (await import("sinon")).default;
  const fsCore = await import("../core/fs.js");
  const projectsOutput = `[info] In file:/app/
[info] 	   * play-rest-api
[info] 	     docs
[info] 	     gatling
[info]
`;
  const safeSpawnSync = sinon
    .stub()
    .returns({ status: 0, stdout: projectsOutput });
  const { discoverSbtProjectsFromCmd } = await esmock("../cli/jvmBom.js", {
    "../core/fs.js": { ...fsCore, safeSpawnSync },
  });
  // A root with main sources is the application and stays in the list
  const appDir = mkdtempSync(path.join(tmpdir(), "cdxgen-sbt-app-"));
  mkdirSync(path.join(appDir, "src", "main", "scala"), { recursive: true });
  try {
    assert.deepStrictEqual(discoverSbtProjectsFromCmd(appDir, "sbt", {}), [
      "play-rest-api",
      "docs",
      "gatling",
    ]);
    // A root without sources is a pure aggregator and is dropped
    const aggDir = mkdtempSync(path.join(tmpdir(), "cdxgen-sbt-agg-"));
    try {
      assert.deepStrictEqual(discoverSbtProjectsFromCmd(aggDir, "sbt", {}), [
        "docs",
        "gatling",
      ]);
    } finally {
      rmSync(aggDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

it("sbt project discovery keeps a Play root application", async () => {
  const { mkdirSync } = await import("node:fs");
  const esmock = (await import("esmock")).default;
  const sinon = (await import("sinon")).default;
  const fsCore = await import("../core/fs.js");
  const projectsOutput = `[info] In file:/app/
[info] 	   * bank-account-verification-frontend
[info] 	     it
[info]
`;
  const safeSpawnSync = sinon
    .stub()
    .returns({ status: 0, stdout: projectsOutput });
  const { discoverSbtProjectsFromCmd } = await esmock("../cli/jvmBom.js", {
    "../core/fs.js": { ...fsCore, safeSpawnSync },
  });
  const playDir = mkdtempSync(path.join(tmpdir(), "cdxgen-sbt-play-"));
  mkdirSync(path.join(playDir, "app", "controllers"), { recursive: true });
  try {
    assert.deepStrictEqual(discoverSbtProjectsFromCmd(playDir, "sbt", {}), [
      "bank-account-verification-frontend",
      "it",
    ]);
  } finally {
    rmSync(playDir, { recursive: true, force: true });
  }
});

it("sbt project discovery passes the launcher options first", async () => {
  const esmock = (await import("esmock")).default;
  const sinon = (await import("sinon")).default;
  const fsCore = await import("../core/fs.js");
  const safeSpawnSync = sinon.stub().returns({
    status: 0,
    stdout: "[info] In file:/app/\n[info] \t * root\n[info] \t   backend\n",
  });
  const { discoverSbtProjectsFromCmd } = await esmock("../cli/jvmBom.js", {
    "../core/fs.js": { ...fsCore, safeSpawnSync },
  });
  const dir = mkdtempSync(path.join(tmpdir(), "cdxgen-sbt2-"));
  try {
    assert.deepStrictEqual(
      discoverSbtProjectsFromCmd(dir, "sbt", {}, ["--server"]),
      ["backend"],
    );
    assert.deepStrictEqual(safeSpawnSync.firstCall.args[1], [
      "--server",
      "-batch",
      "-no-colors",
      '"projects"',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("parseSbtTree names the build definition, not the temporary tree file", async () => {
  const retMap = await parseSbtTree(
    "./test/data/atom-sbt-tree.txt",
    path.join("src", "build.sbt"),
  );
  assert.ok(retMap.pkgList.length > 0);
  for (const pkg of retMap.pkgList) {
    const method = pkg.evidence?.identity?.methods?.[0];
    assert.ok(method, "every tree component carries identity evidence");
    assert.strictEqual(method.value, path.join("src", "build.sbt"));
  }
  // Without a build definition the tree file keeps standing, as the callers
  // of this module outside the sbt scan do.
  const fallback = await parseSbtTree("./test/data/atom-sbt-tree.txt");
  assert.strictEqual(
    fallback.pkgList[0].evidence.identity.methods[0].value,
    "./test/data/atom-sbt-tree.txt",
  );
});
