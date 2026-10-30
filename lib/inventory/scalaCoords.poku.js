import { assert, it } from "poku";

import {
  coordinateKeyFromPurl,
  parseScalaArtifact,
  publishedArtifactId,
  scalaCoordinateKey,
} from "./scalaCoords.js";

it("parseScalaArtifact splits the scala suffixes", () => {
  assert.deepStrictEqual(parseScalaArtifact("jwt-core_3"), {
    originalName: "jwt-core_3",
    artifactBase: "jwt-core",
    binaryVersion: "3",
    platformSuffix: "",
    purlName: "jwt-core",
  });
  assert.deepStrictEqual(parseScalaArtifact("coursier_2.13"), {
    originalName: "coursier_2.13",
    artifactBase: "coursier",
    binaryVersion: "2.13",
    platformSuffix: "",
    purlName: "coursier",
  });
  assert.deepStrictEqual(parseScalaArtifact("upickle_sjs1_3"), {
    originalName: "upickle_sjs1_3",
    artifactBase: "upickle",
    binaryVersion: "3",
    platformSuffix: "_sjs1",
    purlName: "upickle_sjs1",
  });
  assert.deepStrictEqual(parseScalaArtifact("upickle_native0.5_3"), {
    originalName: "upickle_native0.5_3",
    artifactBase: "upickle",
    binaryVersion: "3",
    platformSuffix: "_native0.5",
    purlName: "upickle_native0.5",
  });
  assert.deepStrictEqual(parseScalaArtifact("upickle_sjs1_2.12"), {
    originalName: "upickle_sjs1_2.12",
    artifactBase: "upickle",
    binaryVersion: "2.12",
    platformSuffix: "_sjs1",
    purlName: "upickle_sjs1",
  });
  // Java artifacts without a Scala suffix are returned unchanged
  assert.deepStrictEqual(parseScalaArtifact("bcprov-jdk18on"), {
    originalName: "bcprov-jdk18on",
    artifactBase: "bcprov-jdk18on",
    binaryVersion: null,
    platformSuffix: "",
    purlName: "bcprov-jdk18on",
  });
  // A version-looking suffix must not be mistaken for a Scala binary version
  assert.strictEqual(parseScalaArtifact("foo_3.0").binaryVersion, null);
});

it("coordinateKeyFromPurl normalizes the scala coordinates", () => {
  // POM coordinates and sbt-style purls of the same library share a key
  assert.strictEqual(
    coordinateKeyFromPurl(
      "pkg:maven/com.github.jwt-scala/jwt-core_3@11.0.4?type=jar",
    ),
    coordinateKeyFromPurl(
      "pkg:maven/com.github.jwt-scala/jwt-core@11.0.4?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
    ),
  );
  // The platform suffix keeps Scala.js artifacts separate from the JVM ones
  assert.notStrictEqual(
    coordinateKeyFromPurl(
      "pkg:maven/com.lihaoyi/upickle_sjs1_3@4.4.3?type=jar",
    ),
    coordinateKeyFromPurl("pkg:maven/com.lihaoyi/upickle@4.4.3?type=jar"),
  );
  assert.strictEqual(
    coordinateKeyFromPurl(
      "pkg:maven/com.lihaoyi/upickle_sjs1_3@4.4.3?type=jar",
    ),
    coordinateKeyFromPurl("pkg:maven/com.lihaoyi/upickle_sjs1@4.4.3?type=jar"),
  );
  assert.strictEqual(
    coordinateKeyFromPurl(
      "pkg:maven/com.github.jwt-scala/jwt-core_3@11.0.4?type=jar",
    ),
    "maven:com.github.jwt-scala:jwt-core::11.0.4",
  );
  // Anything that is not a purl has no key
  assert.strictEqual(coordinateKeyFromPurl("/path/to/some.jar"), undefined);
  assert.strictEqual(coordinateKeyFromPurl(undefined), undefined);
});

it("scalaCoordinateKey ignores qualifiers and defaults", () => {
  assert.strictEqual(
    scalaCoordinateKey({ artifactBase: "foo", version: "1.0" }),
    "maven::foo::1.0",
  );
  assert.strictEqual(
    scalaCoordinateKey({
      type: "maven",
      group: "g",
      artifactBase: "foo",
      platformSuffix: "_native0.4",
      version: "1.0",
    }),
    "maven:g:foo:_native0.4:1.0",
  );
});

it("parseScalaArtifact reads the platform suffixes of old and new Scala.js and Scala Native", () => {
  for (const [name, platformSuffix, binaryVersion] of [
    ["scalajs-dom_sjs0.6_2.12", "_sjs0.6", "2.12"],
    ["scalajs-dom_sjs1_2.13", "_sjs1", "2.13"],
    ["upickle_native0.4_2.13", "_native0.4", "2.13"],
    ["upickle_native0.5_3", "_native0.5", "3"],
    ["upickle_native1_3", "_native1", "3"],
    ["upickle_sjs1", "_sjs1", null],
  ]) {
    const parsed = parseScalaArtifact(name);
    assert.strictEqual(parsed.platformSuffix, platformSuffix, name);
    assert.strictEqual(parsed.binaryVersion, binaryVersion, name);
  }
  // A name that only ends like a platform keeps it as part of its base.
  assert.strictEqual(parseScalaArtifact("natives_3").platformSuffix, "");
});

it("publishedArtifactId keeps a name that ends in a nightly or release candidate Scala version", () => {
  const properties = [{ name: "cdx:scala:compilerVersion", value: "3" }];
  for (const name of [
    "semanticdb-scalac_2.13.16",
    "scala3-plugin_3.3.0-RC1",
    "scala3-plugin_3.4.0-RC1-bin-20231010-abc1234-NIGHTLY",
  ]) {
    assert.strictEqual(publishedArtifactId({ name, properties }), name);
  }
  assert.strictEqual(
    publishedArtifactId({ name: "cats-core", properties }),
    "cats-core_3",
  );
});
