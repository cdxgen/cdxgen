import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { assert, it } from "poku";

import {
  inferJarGroupFromManifest,
  parseJarManifest,
  parsePomProperties,
  trimJarGroupSuffix,
} from "../ecosystems/utils.js";
import {
  collectJarNS,
  getAarClasses,
  getPomPropertiesFromMavenDir,
  namespaceMappingOfComponents,
  readEmbeddedJarMetadata,
  readZipEntriesMatching,
  readZipEntry,
} from "./deps.js";

const jarMetadataFixturesDir = path.resolve("test", "data", "jar-metadata");
const gradleAarCacheDir = path.resolve(
  "test",
  "data",
  "gradle-aar-cache",
  "modules-2",
  "files-2.1",
);

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
    assert.strictEqual(
      getPomPropertiesFromMavenDir(mavenDir).groupId,
      "aaa.shaded",
    );
    assert.deepStrictEqual(
      getPomPropertiesFromMavenDir(path.join(mavenDir, "missing")),
      {},
    );
  } finally {
    rmSync(mavenDir, { force: true, recursive: true });
  }
});

it("collectJarNS skips documentation jars and keys classifier jars apart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-collect-ns-"));
  const write = (file, content) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  try {
    const versionDir = path.join(
      root,
      ".m2",
      "repository",
      "org",
      "ex",
      "lib",
      "1.0",
    );
    write(path.join(versionDir, "lib-1.0.jar"), "main");
    write(path.join(versionDir, "lib-1.0-sources.jar"), "sources");
    write(path.join(versionDir, "lib-1.0-javadoc.jar"), "docs");
    write(path.join(versionDir, "lib-1.0-linux.jar"), "native");
    write(
      path.join(versionDir, "lib-1.0.pom"),
      "<project><groupId>org.ex</groupId><artifactId>lib</artifactId><version>1.0</version></project>",
    );
    // No POM: coordinates come from the Gradle cache layout.
    const gradleJar = path.join(
      root,
      "gradle",
      "caches",
      "modules-2",
      "files-2.1",
      "com.acme",
      "tool",
      "2.0",
      "a".repeat(40),
      "tool-2.0.jar",
    );
    write(gradleJar, "gradle");

    // collectJarNS is handed the repository itself, as -t maven-cache does.
    const mapping = {
      ...(await collectJarNS(path.join(root, ".m2", "repository"))),
      ...(await collectJarNS(path.join(root, "gradle"))),
    };
    assert.deepStrictEqual(Object.keys(mapping).sort(), [
      "pkg:maven/com.acme/tool@2.0?type=jar",
      "pkg:maven/org.ex/lib@1.0?classifier=linux&type=jar",
      "pkg:maven/org.ex/lib@1.0?type=jar",
    ]);
    assert.strictEqual(
      mapping["pkg:maven/org.ex/lib@1.0?type=jar"].jarFile,
      path.join(versionDir, "lib-1.0.jar"),
    );

    // The memo is reused for the same, unchanged file and refreshed otherwise.
    const mainPurl = "pkg:maven/org.ex/lib@1.0?type=jar";
    const firstHash = mapping[mainPurl].hashes[1].content;
    const again = await collectJarNS(path.join(versionDir, "lib-1.0.jar"));
    assert.strictEqual(again[mainPurl].hashes[1].content, firstHash);
    write(path.join(versionDir, "lib-1.0.jar"), "rebuilt snapshot contents");
    const rebuilt = await collectJarNS(path.join(versionDir, "lib-1.0.jar"));
    assert.notStrictEqual(rebuilt[mainPurl].hashes[1].content, firstHash);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("sources and javadoc jars never claim a purl", async () => {
  const { collectJarNS } = await import("./deps.js");
  const cacheDir = mkdtempSync(path.join(tmpdir(), "cdxgen-scala-cache-"));
  const pomXml =
    "<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId>" +
    "<artifactId>__NAME__</artifactId><version>1.0</version></project>";
  try {
    // The sources jar is created first so that it also wins in directory
    // order; it must still not claim the purl of the main jar.
    writeFileSync(path.join(cacheDir, "foo_3-1.0-sources.jar"), "");
    for (const name of ["foo_3", "foo_sjs1_3", "foo_native0.5_3"]) {
      writeFileSync(path.join(cacheDir, `${name}-1.0.jar`), "");
      writeFileSync(
        path.join(cacheDir, `${name}-1.0.pom`),
        pomXml.replace("__NAME__", name),
      );
    }
    const nsMapping = await collectJarNS(cacheDir);
    const purls = Object.keys(nsMapping);
    assert.ok(
      purls.includes("pkg:maven/g/foo_3@1.0?type=jar"),
      `missing foo_3 in ${purls}`,
    );
    assert.ok(
      purls.includes("pkg:maven/g/foo_sjs1_3@1.0?type=jar"),
      `missing foo_sjs1_3 in ${purls}`,
    );
    assert.ok(
      purls.includes("pkg:maven/g/foo_native0.5_3@1.0?type=jar"),
      `missing foo_native0.5_3 in ${purls}`,
    );
    assert.ok(
      purls.every((p) => !p.includes("sources") && !p.includes("javadoc")),
      `classifier jar claimed a purl: ${purls}`,
    );
    assert.strictEqual(
      nsMapping["pkg:maven/g/foo_3@1.0?type=jar"].jarFile,
      path.join(cacheDir, "foo_3-1.0.jar"),
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

it("namespaceMappingOfComponents writes the map entries collectJarNS writes", () => {
  const existing = {
    "pkg:maven/a/kept@1": { jarFile: "/repo/kept-1.jar", namespaces: ["a.K"] },
  };
  const mapping = namespaceMappingOfComponents(
    [
      {
        purl: "pkg:maven/a/scanned@1",
        properties: [
          { name: "internal:SrcFile", value: "/tmp/jar-deps-x/scanned-1.jar" },
          { name: "internal:Namespaces", value: "a.B\na.B$\n\na.C\na.B" },
        ],
      },
      {
        purl: "pkg:maven/a/kept@1",
        properties: [{ name: "internal:Namespaces", value: "a.Other" }],
      },
      { purl: "pkg:maven/a/none@1", properties: [] },
      { properties: [{ name: "internal:Namespaces", value: "a.D" }] },
    ],
    existing,
  );
  assert.deepStrictEqual(mapping, {
    "pkg:maven/a/scanned@1": { namespaces: ["a.B", "a.B$", "a.C"] },
  });
});

it("getAarClasses reads classes.jar and the jars under libs/", async () => {
  // A real support-v13 AAR: classes.jar holds 17 classes, and
  // libs/internal_impl-23.0.1.jar holds 3 that no other jar in the AAR has.
  const aar = path.join(
    gradleAarCacheDir,
    "com.android.support",
    "support-v13",
    "23.0.1",
    "208b4644629446a334fae6a8c5fa7ade8b983ae6",
    "support-v13-23.0.1.aar",
  );
  const classes = await getAarClasses(aar);
  assert.strictEqual(classes.length, 20);
  assert.ok(classes.includes("android.support.v13.app.FragmentCompat"));
  assert.ok(classes.includes("android.support.v13.app.FragmentTabHost$1"));
  for (const libsOnly of [
    "android.support.v13.app.FragmentCompatICS",
    "android.support.v13.app.FragmentCompatICSMR1",
    "android.support.v13.app.FragmentCompat23",
  ]) {
    assert.ok(classes.includes(libsOnly), `missing ${libsOnly}`);
  }
  assert.deepStrictEqual(classes, [...classes].sort());
  assert.strictEqual(
    (await getAarClasses(path.join(path.dirname(aar), "..", "missing.aar")))
      .length,
    0,
  );
});

it("collectJarNS lists the classes of aar files in the gradle cache", async () => {
  const mapping = await collectJarNS(gradleAarCacheDir);
  assert.deepStrictEqual(Object.keys(mapping).sort(), [
    "pkg:maven/androidx.core/core-ktx@1.13.1?type=jar",
    "pkg:maven/androidx.core/core@1.13.1?type=jar",
    "pkg:maven/com.android.support/support-v13@23.0.1?type=jar",
  ]);
  const core = mapping["pkg:maven/androidx.core/core@1.13.1?type=jar"];
  const ktx = mapping["pkg:maven/androidx.core/core-ktx@1.13.1?type=jar"];
  // The classes the artifact names come from each artifact's own jars, so a
  // consumer of the BOM can tell the two apart.
  assert.ok(core.namespaces.includes("androidx.core.content.ContextCompat"));
  assert.ok(ktx.namespaces.includes("androidx.core.content.ContextKt"));
  assert.ok(!core.namespaces.includes("androidx.core.content.ContextKt"));
  assert.strictEqual(core.namespaces.length, 873);
  assert.strictEqual(ktx.namespaces.length, 130);
  assert.strictEqual(ktx.pom.groupId, "androidx.core");
  assert.strictEqual(ktx.pom.artifactId, "core-ktx");
  assert.strictEqual(ktx.pom.version, "1.13.1");
  assert.strictEqual(
    ktx.jarFile,
    path.join(
      gradleAarCacheDir,
      "androidx.core",
      "core-ktx",
      "1.13.1",
      "f595b8c10fad9099f71a3c1fc6ded1c9b5010190",
      "core-ktx-1.13.1.aar",
    ),
  );
  // The AAR is hashed as published: the recorded SHA-1 is the digest of the
  // file itself, which Gradle also uses as its hash directory name.
  const sha1Of = (file) =>
    createHash("sha1").update(readFileSync(file)).digest("hex");
  for (const entry of [core, ktx]) {
    const digest = sha1Of(entry.jarFile);
    assert.strictEqual(
      entry.hashes.find((hash) => hash.alg === "SHA-1").content,
      digest,
    );
    assert.strictEqual(path.basename(path.dirname(entry.jarFile)), digest);
  }
});

it("collectJarNS keys an aar without a POM by its path coordinates", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-aar-nopom-"));
  const hashDir = path.join(
    root,
    "files-2.1",
    "androidx.core",
    "core-ktx",
    "1.13.1",
    "0".repeat(40),
  );
  mkdirSync(hashDir, { recursive: true });
  const aar = path.join(hashDir, "core-ktx-1.13.1.aar");
  cpSync(
    path.join(
      gradleAarCacheDir,
      "androidx.core",
      "core-ktx",
      "1.13.1",
      "f595b8c10fad9099f71a3c1fc6ded1c9b5010190",
      "core-ktx-1.13.1.aar",
    ),
    aar,
  );
  try {
    const mapping = await collectJarNS(root);
    const purl = "pkg:maven/androidx.core/core-ktx@1.13.1?type=jar";
    assert.deepStrictEqual(Object.keys(mapping), [purl]);
    assert.strictEqual(mapping[purl].pom, undefined);
    assert.ok(
      mapping[purl].namespaces.includes("androidx.core.content.ContextKt"),
    );
    // The same aar read on its own, as a single file, keeps the same purl.
    const single = await collectJarNS(aar);
    assert.deepStrictEqual(Object.keys(single), [purl]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("collectJarNS reads an aar beside its POM in a maven repository layout", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-aar-m2-"));
  const versionDir = path.join(
    root,
    ".m2",
    "repository",
    "androidx.core",
    "core",
    "1.13.1",
  );
  mkdirSync(versionDir, { recursive: true });
  cpSync(
    path.join(
      gradleAarCacheDir,
      "androidx.core",
      "core",
      "1.13.1",
      "4606d420282fe1e5c8d5c4e647ec188e1045b7be",
      "core-1.13.1.aar",
    ),
    path.join(versionDir, "core-1.13.1.aar"),
  );
  cpSync(
    path.join(
      gradleAarCacheDir,
      "androidx.core",
      "core",
      "1.13.1",
      "9ca2e920780344b9f4b38c3967f88f780a69e966",
      "core-1.13.1.pom",
    ),
    path.join(versionDir, "core-1.13.1.pom"),
  );
  try {
    const mapping = await collectJarNS(path.join(root, ".m2", "repository"));
    const purl = "pkg:maven/androidx.core/core@1.13.1?type=jar";
    assert.deepStrictEqual(Object.keys(mapping), [purl]);
    assert.strictEqual(mapping[purl].pom.artifactId, "core");
    assert.ok(
      mapping[purl].namespaces.includes("androidx.core.content.ContextCompat"),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

const supportV13Aar = path.join(
  gradleAarCacheDir,
  "com.android.support",
  "support-v13",
  "23.0.1",
  "208b4644629446a334fae6a8c5fa7ade8b983ae6",
  "support-v13-23.0.1.aar",
);

it("getAarClasses skips an inner jar larger than the size bound", async () => {
  // classes.jar and libs/internal_impl-23.0.1.jar are each over a kilobyte.
  assert.deepStrictEqual(
    await getAarClasses(supportV13Aar, { maxInnerJarBytes: 1024 }),
    [],
  );
});

/**
 * Build a deflated zip in memory, in the streaming layout Java tools write:
 * general purpose bit 3 set and the sizes in a data descriptor after the
 * data. `declaredSize` overrides the uncompressed size the archive records
 * for an entry, which is what a hostile archive understates, and `stored`
 * writes the entry without compression.
 *
 * @param {Array<{name: string, content: Buffer, declaredSize?: number, stored?: boolean}>} files Entries
 * @returns {Buffer} The archive
 */
function buildStreamingZip(files) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const { name, content, declaredSize, stored } of files) {
    const nameBuffer = Buffer.from(name, "utf-8");
    const method = stored ? 0 : 8;
    const compressed = stored ? content : deflateRawSync(content);
    const crc = crc32(content);
    const size = declaredSize ?? content.length;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x8, 6); // bit 3: sizes follow the data
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(size, 12);
    const localRecord = Buffer.concat([
      localHeader,
      nameBuffer,
      compressed,
      descriptor,
    ]);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x8, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    localRecords.push(localRecord);
    centralRecords.push(Buffer.concat([centralHeader, nameBuffer]));
    offset += localRecord.length;
  }
  const central = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, central, eocd]);
}

it("getAarClasses abandons an inner jar that inflates past the bound it declares", async () => {
  // A 64 KiB classes.jar, storing one class of zero bytes, wrapped in an aar
  // that deflates it to a few hundred bytes and records 100 bytes for it.
  // With bit 3 set node-stream-zip does not hold the entry to its declared
  // size, so the bound has to count the inflated bytes.
  const classesJar = buildStreamingZip([
    {
      name: "com/example/Widget.class",
      content: Buffer.alloc(64 * 1024),
      stored: true,
    },
  ]);
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-aar-size-"));
  try {
    const truthful = path.join(root, "truthful.aar");
    writeFileSync(
      truthful,
      buildStreamingZip([{ name: "classes.jar", content: classesJar }]),
    );
    assert.deepStrictEqual(
      await getAarClasses(truthful, { maxInnerJarBytes: 1024 * 1024 }),
      ["com.example.Widget"],
    );
    const understated = path.join(root, "understated.aar");
    writeFileSync(
      understated,
      buildStreamingZip([
        { name: "classes.jar", content: classesJar, declaredSize: 100 },
      ]),
    );
    assert.deepStrictEqual(
      await getAarClasses(understated, { maxInnerJarBytes: 4096 }),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("readZipEntriesMatching abandons an entry that inflates past the bound it declares", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-whl-size-"));
  try {
    const wheel = path.join(root, "widget-1.0-py3-none-any.whl");
    writeFileSync(
      wheel,
      buildStreamingZip([
        {
          name: "widget-1.0.dist-info/sboms/bom.json",
          content: Buffer.alloc(64 * 1024, " "),
          declaredSize: 100,
        },
        {
          name: "widget-1.0.dist-info/sboms/small.json",
          content: Buffer.from("{}"),
        },
      ]),
    );
    assert.deepStrictEqual(
      await readZipEntriesMatching(wheel, ".dist-info/sboms/", {
        maxEntryBytes: 4096,
      }),
      [{ name: "widget-1.0.dist-info/sboms/small.json", data: "{}" }],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("readEmbeddedJarMetadata abandons a manifest that inflates past the bound it declares", async () => {
  const manifest = Buffer.from(
    `Manifest-Version: 1.0\nBundle-License: Apache-2.0\nX-Pad: ${"a".repeat(512 * 1024)}\n`,
  );
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-jar-size-"));
  try {
    const truthful = path.join(root, "truthful.jar");
    writeFileSync(
      truthful,
      buildStreamingZip([
        {
          name: "META-INF/MANIFEST.MF",
          content: Buffer.from(
            "Manifest-Version: 1.0\nBundle-License: Apache-2.0\n",
          ),
        },
      ]),
    );
    assert.ok(
      (await readEmbeddedJarMetadata(truthful))?.manifestLicenses?.length,
    );
    const understated = path.join(root, "understated.jar");
    writeFileSync(
      understated,
      buildStreamingZip([
        { name: "META-INF/MANIFEST.MF", content: manifest, declaredSize: 100 },
      ]),
    );
    assert.strictEqual(
      (await readEmbeddedJarMetadata(understated))?.manifestLicenses,
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("readZipEntriesMatching stops at the total size bound", async () => {
  const whlFile = path.resolve(
    "test",
    "data",
    "pep770-repotest",
    "demo_pkg-1.0.0-py3-none-any.whl",
  );
  // WHEEL (19 bytes), sboms/demo-pkg.cdx.json (594) and METADATA (98).
  const all = await readZipEntriesMatching(whlFile, ".dist-info/");
  assert.strictEqual(all.length, 3);
  assert.deepStrictEqual(
    await readZipEntriesMatching(whlFile, ".dist-info/", { maxTotalBytes: 0 }),
    [],
  );
  const bounded = await readZipEntriesMatching(whlFile, ".dist-info/", {
    maxTotalBytes: 19,
  });
  assert.strictEqual(bounded.length, 1);
  assert.ok(bounded[0].data.length <= 19);
});

it("readZipEntriesMatching counts the bytes it inflates against the total bound", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-whl-total-"));
  try {
    const wheel = path.join(root, "widget-1.0-py3-none-any.whl");
    writeFileSync(
      wheel,
      buildStreamingZip(
        [0, 1, 2].map((i) => ({
          name: `widget-1.0.dist-info/sboms/${i}.json`,
          content: Buffer.alloc(4096, " "),
          declaredSize: 10,
        })),
      ),
    );
    const entries = await readZipEntriesMatching(wheel, ".dist-info/sboms/", {
      maxEntryBytes: 8192,
      maxTotalBytes: 6144,
    });
    assert.deepStrictEqual(
      entries.map((entry) => entry.name),
      ["widget-1.0.dist-info/sboms/0.json"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("collectJarNS finds the POM of an aar under a directory named like an artifact", async () => {
  // The old lookup replaced the first ".aar" in the path, which here is the
  // temporary directory's name, so the POM named after the aar was missed.
  // A second POM in the same directory stops the fallback search, which
  // takes a POM only when it is the sole one, from hiding that.
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-x.aar-"));
  const versionDir = path.join(root, "androidx", "core", "core-ktx", "1.13.1");
  const ktxDir = path.join(
    gradleAarCacheDir,
    "androidx.core",
    "core-ktx",
    "1.13.1",
  );
  mkdirSync(versionDir, { recursive: true });
  cpSync(
    path.join(
      ktxDir,
      "f595b8c10fad9099f71a3c1fc6ded1c9b5010190",
      "core-ktx-1.13.1.aar",
    ),
    path.join(versionDir, "core-ktx-1.13.1.aar"),
  );
  for (const dir of readdirSync(ktxDir)) {
    for (const file of readdirSync(path.join(ktxDir, dir))) {
      if (file.endsWith(".pom")) {
        cpSync(path.join(ktxDir, dir, file), path.join(versionDir, file));
      }
    }
  }
  writeFileSync(path.join(versionDir, "core-ktx-1.13.1-unrelated.pom"), "");
  try {
    const mapping = await collectJarNS(root);
    const purl = "pkg:maven/androidx.core/core-ktx@1.13.1?type=jar";
    assert.deepStrictEqual(Object.keys(mapping), [purl]);
    assert.strictEqual(mapping[purl].pom.artifactId, "core-ktx");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("readZipEntry abandons an entry that inflates past the bound it declares", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-nupkg-size-"));
  try {
    const truthful = path.join(root, "truthful.nupkg");
    writeFileSync(
      truthful,
      buildStreamingZip([
        { name: "Widget.nuspec", content: Buffer.from("<package/>") },
      ]),
    );
    assert.strictEqual(
      await readZipEntry(truthful, ".nuspec", "utf-8", 4096),
      "<package/>",
    );
    const understated = path.join(root, "understated.nupkg");
    writeFileSync(
      understated,
      buildStreamingZip([
        {
          name: "Widget.nuspec",
          content: Buffer.alloc(64 * 1024, " "),
          declaredSize: 100,
        },
      ]),
    );
    assert.strictEqual(
      await readZipEntry(understated, ".nuspec", "utf-8", 4096),
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
