import { strict as assert } from "node:assert";

import { describe, it } from "poku";

import { mergeScalaDuplicateComponents } from "./scalaDedupe.js";

const compiler = { name: "cdx:scala:compilerVersion", value: "3" };
const src = (name) => ({
  name: "internal:SrcFile",
  value: `/tmp/jar-deps-x/${name}`,
});

function reported(group, name, version) {
  const purl = `pkg:maven/${group}/${name}@${version}?repository_url=https:%2F%2Fr.example%2Fmaven&type=jar`;
  return {
    type: "library",
    group,
    name,
    version,
    purl,
    "bom-ref": decodeURIComponent(purl),
    properties: [{ ...compiler }],
  };
}

function jar(group, name, version, stem) {
  const purl = `pkg:maven/${group}/${name}@${version}?type=jar`;
  return {
    type: "library",
    group,
    name,
    version,
    purl,
    "bom-ref": purl,
    properties: [
      src(`${stem}.jar`),
      { name: "internal:Namespaces", value: "a.B" },
    ],
  };
}

describe("mergeScalaDuplicateComponents()", () => {
  it("folds a jar spelled with the Scala suffix into the reported library", () => {
    const circe = reported("io.circe", "circe-core", "0.14.16");
    const found = jar(
      "io.circe",
      "circe-core_3",
      "0.14.16",
      "io.circe.circe-core_3-0.14.16",
    );
    const { components, dependencies } = mergeScalaDuplicateComponents(
      [found, circe],
      [
        { ref: "pkg:maven/app/app@1", dependsOn: [found["bom-ref"]] },
        { ref: found["bom-ref"], dependsOn: [] },
      ],
    );
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0], circe);
    assert.ok(
      components[0].properties.some((p) => p.name === "internal:Namespaces"),
    );
    assert.deepStrictEqual(
      dependencies.find((d) => d.ref === "pkg:maven/app/app@1").dependsOn,
      [circe["bom-ref"]],
    );
  });

  it("recognises the staged file name even when the guessed group is wrong", () => {
    const cpg2 = reported("io.appthreat", "cpg2-protos", "3.1.1");
    const mangled = jar(
      "cpg2-protos",
      "io.appthreat.cpg2-protos_3",
      "3.1.1",
      "io.appthreat.cpg2-protos_3-3.1.1",
    );
    const { components } = mergeScalaDuplicateComponents([cpg2, mangled], []);
    assert.deepStrictEqual(components, [cpg2]);
  });

  it("renames a staged jar of another version to the reported coordinates", () => {
    const cpg2 = reported("io.appthreat", "cpg2-protos", "3.1.1");
    const stale = jar(
      "cpg2-protos",
      "io.appthreat.cpg2-protos_3",
      "3.0.10",
      "io.appthreat.cpg2-protos_3-3.0.10",
    );
    const { components } = mergeScalaDuplicateComponents([cpg2, stale], []);
    assert.strictEqual(components.length, 2);
    assert.strictEqual(
      stale.purl,
      "pkg:maven/io.appthreat/cpg2-protos@3.0.10?type=jar",
    );
    assert.strictEqual(stale["bom-ref"], stale.purl);
    assert.strictEqual(stale.group, "io.appthreat");
  });

  it("merges the same Java library listed with and without a repository", () => {
    const guava = {
      group: "com.google.guava",
      name: "guava",
      version: "33.6.0-jre",
      purl: "pkg:maven/com.google.guava/guava@33.6.0-jre?repository_url=https:%2F%2Fr.example%2Fmaven&type=jar",
      "bom-ref": "guava-reported",
    };
    const found = jar(
      "com.google.guava",
      "guava",
      "33.6.0-jre",
      "guava-33.6.0-jre",
    );
    const { components } = mergeScalaDuplicateComponents(
      [found, guava, jar("org.acme", "widget", "1.0", "widget-1.0")],
      [],
    );
    assert.strictEqual(components.length, 2);
    assert.strictEqual(components[0], guava);
  });

  it("does not merge a classifier jar into the main artifact", () => {
    const main = reported("io.netty", "netty-transport-native-epoll", "4.1.0");
    const classified = {
      ...jar("io.netty", "netty-transport-native-epoll", "4.1.0", "x-4.1.0"),
      purl: "pkg:maven/io.netty/netty-transport-native-epoll@4.1.0?classifier=linux-x86_64&type=jar",
    };
    const { components } = mergeScalaDuplicateComponents(
      [main, classified],
      [],
    );
    assert.strictEqual(components.length, 2);
  });

  it("strips the group a staging copy prefixed to a name, when the plain one is present", () => {
    const plain = jar("io.appthreat", "x2cpg", "4.0.0", "x2cpg_3-4.0.0");
    const prefixed = jar(
      "io.appthreat",
      "io.appthreat.x2cpg",
      "4.0.0",
      "io.appthreat.x2cpg-4.0.0",
    );
    const { components } = mergeScalaDuplicateComponents([prefixed, plain], []);
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0], plain);
    // A real artifactId that merely starts with its group stays.
    const osgi = jar("org.osgi", "org.osgi.service.prefs", "1.1.2", "p-1.1.2");
    assert.strictEqual(
      mergeScalaDuplicateComponents([osgi, plain], []).components.length,
      2,
    );
  });

  it("leaves unrelated components and builds without a reported library alone", () => {
    const other = jar("org.acme", "widget", "1.0", "widget-1.0");
    const input = [other];
    assert.strictEqual(
      mergeScalaDuplicateComponents(input, []).components,
      input,
    );
    const circe = reported("io.circe", "circe-core", "0.14.16");
    const merged = mergeScalaDuplicateComponents([circe, other], []);
    assert.deepStrictEqual(merged.components, [circe, other]);
  });
});
