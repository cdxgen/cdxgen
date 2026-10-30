import { strict as assert, describe, it } from "poku";

import {
  mergeScalaDuplicateComponents,
  rekeyNamespaceMapping,
} from "./scalaDedupe.js";

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

  it("keeps the artifacts of one library built for different Scala versions apart", () => {
    const maven = (name) => {
      const purl = `pkg:maven/org.apache.kafka/${name}@3.6.0?type=jar`;
      return {
        group: "org.apache.kafka",
        name,
        version: "3.6.0",
        purl,
        "bom-ref": purl,
        properties: [{ name: "internal:SrcFile", value: "/app/pom.xml" }],
      };
    };
    const kafka212 = maven("kafka_2.12");
    const kafka213 = maven("kafka_2.13");
    assert.deepStrictEqual(
      mergeScalaDuplicateComponents([kafka213, kafka212], []).components,
      [kafka213, kafka212],
    );
    const cats213 = jar(
      "org.typelevel",
      "cats-core_2.13",
      "2.9.0",
      "cats-core_2.13-2.9.0",
    );
    const cats3 = jar(
      "org.typelevel",
      "cats-core_3",
      "2.9.0",
      "cats-core_3-2.9.0",
    );
    assert.strictEqual(
      mergeScalaDuplicateComponents([cats3, cats213], []).components.length,
      2,
    );
    // An sbt library built for 2.13 takes the 2.13 jar and leaves the _3 one.
    const sbt = reported("org.typelevel", "cats-core", "2.9.0");
    sbt.properties = [{ name: "cdx:scala:compilerVersion", value: "2.13" }];
    const { components } = mergeScalaDuplicateComponents(
      [cats3, sbt, cats213],
      [],
    );
    assert.deepStrictEqual(components, [cats3, sbt]);
  });

  it("never leaves a merged component depending on itself or on a removed one", () => {
    const circe = reported("io.circe", "circe-core", "0.14.16");
    const found = jar(
      "io.circe",
      "circe-core_3",
      "0.14.16",
      "circe-core_3-0.14.16",
    );
    const { dependencies } = mergeScalaDuplicateComponents(
      [circe, found],
      [
        {
          ref: circe["bom-ref"],
          dependsOn: [found["bom-ref"], "pkg:maven/x/y@1"],
        },
        { ref: found["bom-ref"], dependsOn: ["pkg:maven/x/z@1"] },
      ],
    );
    assert.deepStrictEqual(dependencies, [
      {
        ref: circe["bom-ref"],
        dependsOn: ["pkg:maven/x/y@1", "pkg:maven/x/z@1"],
      },
    ]);
    // A surviving component without a bom-ref is referred to by its purl.
    const bare = { ...reported("io.circe", "circe-core", "0.14.16") };
    delete bare["bom-ref"];
    const other = jar(
      "io.circe",
      "circe-core_3",
      "0.14.16",
      "circe-core_3-0.14.16",
    );
    const merged = mergeScalaDuplicateComponents(
      [bare, other],
      [{ ref: other["bom-ref"], dependsOn: ["pkg:maven/x/z@1"] }],
    );
    assert.deepStrictEqual(merged.dependencies, [
      { ref: bare.purl, dependsOn: ["pkg:maven/x/z@1"] },
    ]);
  });

  it("renames a staged jar to the name and purl shape of a Maven-named library", () => {
    const anchor = {
      group: "org.typelevel",
      name: "cats-core_2.13",
      version: "2.9.0",
      purl: "pkg:maven/org.typelevel/cats-core_2.13@2.9.0?type=jar",
      "bom-ref": "pkg:maven/org.typelevel/cats-core_2.13@2.9.0?type=jar",
      properties: [{ name: "internal:SrcFile", value: "/app/pom.xml" }],
    };
    const stale = jar(
      "cats-core_2.13",
      "org.typelevel",
      "2.8.0",
      "org.typelevel.cats-core_2.13-2.8.0",
    );
    const { components, purlMap } = mergeScalaDuplicateComponents(
      [anchor, stale],
      [],
    );
    assert.strictEqual(components.length, 2);
    assert.strictEqual(stale.name, "cats-core_2.13");
    assert.strictEqual(
      stale.purl,
      "pkg:maven/org.typelevel/cats-core_2.13@2.8.0?type=jar",
    );
    assert.strictEqual(
      purlMap.get("pkg:maven/cats-core_2.13/org.typelevel@2.8.0?type=jar"),
      stale.purl,
    );
  });

  it("finds the reported version among several reported versions of a library", () => {
    const newer = reported("org.typelevel", "cats-core", "2.9.0");
    const older = reported("org.typelevel", "cats-core", "2.8.0");
    const staged = jar(
      "cats-core_3",
      "org.typelevel.cats-core_3",
      "2.8.0",
      "org.typelevel.cats-core_3-2.8.0",
    );
    const { components } = mergeScalaDuplicateComponents(
      [newer, staged, older],
      [],
    );
    assert.deepStrictEqual(components, [newer, older]);
  });

  it("matches the staged name of each Scala version a library was built for", () => {
    const cross = reported("org.typelevel", "cats-core", "2.9.0");
    cross.properties = [
      { name: "cdx:scala:compilerVersion", value: "2.13" },
      { name: "cdx:scala:compilerVersion", value: "3" },
    ];
    const staged213 = jar(
      "cats-core_2.13",
      "org.typelevel.cats-core_2.13",
      "2.9.0",
      "org.typelevel.cats-core_2.13-2.9.0",
    );
    const staged3 = jar(
      "cats-core_3",
      "org.typelevel.cats-core_3",
      "2.9.0",
      "ORG.typelevel.cats-core_3-2.9.0",
    );
    staged3.properties[0].value =
      "/stage/lib/org.typelevel.cats-core_3-2.9.0.JAR";
    const { components } = mergeScalaDuplicateComponents(
      [staged213, cross, staged3],
      [],
    );
    assert.deepStrictEqual(components, [cross]);
  });

  it("leaves a staged name whose version may carry a classifier alone", () => {
    const epoll = reported(
      "io.netty",
      "netty-transport-native-epoll",
      "4.1.100.Final",
    );
    epoll.properties = [];
    const staged = jar(
      "netty",
      "io.netty.netty-transport-native-epoll",
      "4.1.100.Final-linux-x86_64",
      "io.netty.netty-transport-native-epoll-4.1.100.Final-linux-x86_64",
    );
    const before = staged.purl;
    const { components } = mergeScalaDuplicateComponents([epoll, staged], []);
    assert.strictEqual(components.length, 2);
    assert.strictEqual(staged.purl, before);
  });

  it("trusts a jar that names itself in its Maven descriptor", () => {
    const core = reported("org.osgi", "core", "4.3.1");
    core.properties = [];
    const described = jar(
      "org.osgi",
      "org.osgi.core",
      "4.3.1",
      "org.osgi.core-4.3.1",
    );
    described.evidence = {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          { technique: "manifest-analysis", confidence: 0.5, value: "x" },
        ],
      },
    };
    const reportedPair = mergeScalaDuplicateComponents([core, described], []);
    assert.strictEqual(reportedPair.components.length, 2);
    const plainPair = mergeScalaDuplicateComponents(
      [
        core,
        { ...reported("org.osgi", "org.osgi.core", "4.3.1"), properties: [] },
      ],
      [],
    );
    assert.strictEqual(plainPair.components.length, 2);
  });

  it("merges the staged jar of a build module published without the Scala suffix", () => {
    // chen stages its own modules as io.appthreat.x2cpg-4.0.0.jar while sbt
    // reports them built for Scala 3.
    const module = reported("io.appthreat", "x2cpg", "4.0.0");
    const staged = jar(
      "io.appthreat",
      "io.appthreat.x2cpg",
      "4.0.0",
      "io.appthreat.x2cpg-4.0.0",
    );
    staged.evidence = {
      identity: [
        {
          field: "purl",
          confidence: 0.3,
          methods: [{ technique: "manifest-analysis", confidence: 0.3 }],
        },
      ],
    };
    const { components } = mergeScalaDuplicateComponents([staged, module], []);
    assert.deepStrictEqual(components, [module]);
  });

  it("gives the same result whatever the order of the components", () => {
    const build = () => [
      reported("io.circe", "circe-core", "0.14.16"),
      jar("io.circe", "circe-core_3", "0.14.16", "circe-core_3-0.14.16"),
      jar(
        "circe-core_3",
        "io.circe.circe-core_3",
        "0.14.16",
        "io.circe.circe-core_3-0.14.16",
      ),
      jar(
        "circe-core_3",
        "io.circe.circe-core_3",
        "0.14.10",
        "io.circe.circe-core_3-0.14.10",
      ),
      reported("org.typelevel", "cats-core", "2.9.0"),
    ];
    const purls = (list) =>
      mergeScalaDuplicateComponents(list, [])
        .components.map((c) => c.purl)
        .sort();
    const expected = purls(build());
    assert.deepStrictEqual(
      expected,
      [
        "pkg:maven/io.circe/circe-core@0.14.10?type=jar",
        reported("io.circe", "circe-core", "0.14.16").purl,
        reported("org.typelevel", "cats-core", "2.9.0").purl,
      ].sort(),
    );
    assert.deepStrictEqual(purls(build().reverse()), expected);
    const rotated = build();
    rotated.push(rotated.shift(), rotated.shift());
    assert.deepStrictEqual(purls(rotated), expected);
  });
});

describe("rekeyNamespaceMapping()", () => {
  it("moves an entry to the new purl and joins it with one already there", () => {
    const mapping = {
      "pkg:maven/a/old@1": { jarFile: "/x.jar", namespaces: ["a.B", "a.C"] },
      "pkg:maven/a/new@1": { jarFile: "/y.jar", namespaces: ["a.B"] },
      "pkg:maven/a/moved@1": { jarFile: "/z.jar", namespaces: ["z.Z"] },
    };
    const rekeyed = rekeyNamespaceMapping(
      mapping,
      new Map([
        ["pkg:maven/a/old@1", "pkg:maven/a/new@1"],
        ["pkg:maven/a/moved@1", "pkg:maven/a/target@1"],
      ]),
    );
    assert.deepStrictEqual(Object.keys(rekeyed).sort(), [
      "pkg:maven/a/new@1",
      "pkg:maven/a/target@1",
    ]);
    assert.deepStrictEqual(rekeyed["pkg:maven/a/new@1"].namespaces, [
      "a.B",
      "a.C",
    ]);
    assert.strictEqual(rekeyed["pkg:maven/a/target@1"].jarFile, "/z.jar");
    assert.strictEqual(rekeyNamespaceMapping(mapping, new Map()), mapping);
  });
});
