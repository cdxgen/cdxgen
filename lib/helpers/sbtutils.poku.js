import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import {
  findCoursierRegistryUrl,
  findLocalJarPath,
  parseSbtLock,
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
