import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, it } from "poku";

import {
  inferJarGroupFromManifest,
  parseJarManifest,
  parsePomProperties,
  trimJarGroupSuffix,
} from "../ecosystems/utils.js";
import { getPomPropertiesFromMavenDir } from "./deps.js";

const jarMetadataFixturesDir = path.resolve("test", "data", "jar-metadata");

function readJarMetadataFixture(...segments) {
  return readFileSync(path.join(jarMetadataFixturesDir, ...segments), {
    encoding: "utf-8",
  });
}

it("jar manifest group inference tests", () => {
  const antManifest = parseJarManifest(
    readJarMetadataFixture("ant-1.10.13", "MANIFEST.MF"),
  );
  assert.deepStrictEqual(
    inferJarGroupFromManifest(antManifest),
    "org.apache.tools.ant",
  );
  const velocityManifest = parseJarManifest(
    readJarMetadataFixture("velocity-1.7", "MANIFEST.MF"),
  );
  assert.deepStrictEqual(velocityManifest["Extension-Name"], "velocity");
  assert.deepStrictEqual(
    velocityManifest["Bundle-SymbolicName"],
    "org.apache.velocity",
  );
  assert.deepStrictEqual(
    inferJarGroupFromManifest(velocityManifest),
    "org.apache.velocity",
  );
});

it("jar manifest inference and pom properties parsing tests", () => {
  const logbackManifest = parseJarManifest(
    readJarMetadataFixture("logback-classic-1.4.7", "MANIFEST.MF"),
  );
  const logbackPomProperties = parsePomProperties(
    readJarMetadataFixture("logback-classic-1.4.7", "pom.properties"),
  );
  assert.deepStrictEqual(
    inferJarGroupFromManifest(logbackManifest),
    "ch.qos.logback.classic",
  );
  assert.deepStrictEqual(logbackPomProperties, {
    artifactId: "logback-classic",
    groupId: "ch.qos.logback",
    version: "1.4.7",
  });
  const commonsMathManifest = parseJarManifest(
    readJarMetadataFixture("commons-math3-3.6.1", "MANIFEST.MF"),
  );
  const commonsMathPomProperties = parsePomProperties(
    readJarMetadataFixture("commons-math3-3.6.1", "pom.properties"),
  );
  assert.deepStrictEqual(
    inferJarGroupFromManifest(commonsMathManifest),
    "org.apache.commons.math3",
  );
  assert.deepStrictEqual(commonsMathPomProperties, {
    artifactId: "commons-math3",
    groupId: "org.apache.commons",
    version: "3.6.1",
  });
  assert.deepStrictEqual(parsePomProperties("artifactId=demo\ncustom=a=b=c"), {
    artifactId: "demo",
    custom: "a=b=c",
  });
  assert.deepStrictEqual(
    parsePomProperties("artifactId=demo\r\r\ncustom=a\r=b\r=c"),
    {
      artifactId: "demo",
      custom: "a=b=c",
    },
  );
});

it("jar group suffix trimming tests", () => {
  assert.deepStrictEqual(
    trimJarGroupSuffix("org.checkerframework.checker.qual", "checker-qual"),
    "org.checkerframework",
  );
  assert.deepStrictEqual(
    trimJarGroupSuffix("org.apache.velocity", "velocity"),
    "org.apache.velocity",
  );
});

it("getPomPropertiesFromMavenDir prefers the descriptor matching the jar name", () => {
  const mavenDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-props-"));
  const writeDescriptor = (group, artifact, version) => {
    const dir = path.join(mavenDir, group, artifact);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "pom.properties"),
      `groupId=${group}\nartifactId=${artifact}\nversion=${version}\n`,
    );
  };
  try {
    // A shaded jar carries the descriptors of everything folded into it.
    writeDescriptor("aaa.shaded", "netty", "4.0");
    writeDescriptor("io.netty", "netty-common", "4.1.1");
    writeDescriptor("com.example", "app", "1.0");
    assert.strictEqual(
      getPomPropertiesFromMavenDir(mavenDir, "app-1.0.jar").artifactId,
      "app",
    );
    // No exact version match: the longest artifactId prefix wins.
    assert.strictEqual(
      getPomPropertiesFromMavenDir(mavenDir, "netty-common-4.1.2.jar")
        .artifactId,
      "netty-common",
    );
    assert.strictEqual(
      getPomPropertiesFromMavenDir(mavenDir, "app-1.0-linux.jar").artifactId,
      "app",
    );
    // Without a usable hint the first descriptor, in sorted order, is used.
    assert.strictEqual(
      getPomPropertiesFromMavenDir(mavenDir, "unrelated.jar").groupId,
      "aaa.shaded",
    );
    assert.strictEqual(getPomPropertiesFromMavenDir(mavenDir).groupId, "aaa.shaded");
    assert.deepStrictEqual(
      getPomPropertiesFromMavenDir(path.join(mavenDir, "missing")),
      {},
    );
  } finally {
    rmSync(mavenDir, { force: true, recursive: true });
  }
});
