import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { resetRunState } from "../core/runState.js";
import {
  collectJarNS,
  convertJarNSToPackages,
  parseJarManifest,
  parseManifestLicenseList,
} from "./deps.js";

// Jars are built in the test from small files, as stored (uncompressed) zip
// archives, so no toolchain is needed. The jars carry their own Maven
// descriptor and manifest, which is the data under test.

/** CRC-32 for zip entries. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/**
 * Build a stored zip archive from the given entries.
 *
 * @param {string} out Path of the archive to write.
 * @param {Object<string, string>} files Entry name to contents.
 * @returns {void}
 */
function buildZip(out, files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf-8");
    const data = Buffer.from(content, "utf-8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(out, Buffer.concat([...chunks, centralBuf, end]));
}

const POM = (artifactId, extra = "") =>
  `<project><modelVersion>4.0.0</modelVersion><groupId>com.ex</groupId><artifactId>${artifactId}</artifactId><version>1.2.3</version><description>The ${artifactId} library</description><organization><name>Acme Ltd</name></organization><licenses><license><name>Apache License, Version 2.0</name></license></licenses>${extra}</project>`;

const PROPERTIES = (artifactId, group = "com.ex") =>
  `groupId=${group}\nartifactId=${artifactId}\nversion=1.2.3\n`;

/** A jar with its own descriptor, a class file and a manifest. */
function writeJar(
  jarPath,
  {
    artifactId = "acme-embedded",
    pom = POM(artifactId),
    bundleLicense,
    shaded = [],
  } = {},
) {
  const files = {
    "org/ex/Lib.class": "not really a class",
    [`META-INF/maven/com.ex/${artifactId}/pom.properties`]:
      PROPERTIES(artifactId),
    [`META-INF/maven/com.ex/${artifactId}/pom.xml`]: pom,
  };
  for (const dep of shaded) {
    files[`META-INF/maven/${dep.groupPath}/${dep.artifactId}/pom.properties`] =
      PROPERTIES(dep.artifactId, dep.group);
    files[`META-INF/maven/${dep.groupPath}/${dep.artifactId}/pom.xml`] =
      dep.pom;
  }
  const manifest = ["Manifest-Version: 1.0"];
  if (bundleLicense) {
    manifest.push(`Bundle-License: ${bundleLicense}`);
  }
  files["META-INF/MANIFEST.MF"] = `${manifest.join("\n")}\n`;
  buildZip(jarPath, files);
}

/** A jar inside the Maven local repository layout, which names its
 * coordinates, without any sibling pom. */
function writeRepoJar(root, name, options = {}) {
  const jarDir = join(
    root,
    "home",
    ".m2",
    "repository",
    "com",
    "ex",
    "acme-embedded",
    "1.2.3",
  );
  mkdirSync(jarDir, { recursive: true });
  const jarPath = join(jarDir, `${name}.jar`);
  writeJar(jarPath, options);
  return { jarPath, jarDir };
}

await it("parseManifestLicenseList splits items with their link and description attributes", () => {
  assert.deepEqual(
    parseManifestLicenseList(
      'MIT;link="https://opensource.org/MIT", Apache-2.0;description="Apache License 2.0"',
    ),
    ["MIT", "Apache-2.0"],
  );
  assert.deepEqual(
    parseManifestLicenseList("https://www.apache.org/licenses/LICENSE-2.0.txt"),
    ["https://www.apache.org/licenses/LICENSE-2.0.txt"],
  );
  // Names map through findLicenseId.
  assert.deepEqual(parseManifestLicenseList("Eclipse Public License v1.0"), [
    "EPL-1.0",
  ]);
  assert.deepEqual(parseManifestLicenseList(undefined), []);
  assert.deepEqual(parseManifestLicenseList(""), []);
  // Quoted parts keep their own commas and semicolons, as published jars
  // write them.
  assert.deepEqual(
    parseManifestLicenseList(
      'Apache-2.0;description="This program is made available under the terms of the Apache License, Version 2.0.";link="https://www.apache.org/licenses/LICENSE-2.0"',
    ),
    ["Apache-2.0"],
  );
  assert.deepEqual(
    parseManifestLicenseList(
      '"Apache-2.0";link="https://www.apache.org/licenses/LICENSE-2.0.txt"',
    ),
    ["Apache-2.0"],
  );
  // An unmapped name gives way to its link; repeats and <<EXTERNAL>> add
  // nothing.
  assert.deepEqual(
    parseManifestLicenseList(
      '"Acme Licence";link="https://example.com/licence.txt", <<EXTERNAL>>, https://www.eclipse.org/legal/epl-v20.html, https://www.eclipse.org/legal/epl-v20.html',
    ),
    [
      "https://example.com/licence.txt",
      "https://www.eclipse.org/legal/epl-v20.html",
    ],
  );
});

await it("parseJarManifest joins the continuation lines a manifest wraps at 72 bytes", () => {
  const manifest = parseJarManifest(
    [
      "Manifest-Version: 1.0",
      "Bundle-License: http://opensource.org/licenses/apache2.0.php; link=\"h",
      ' ttp://www.apache.org/licenses/LICENSE-2.0"; description="Apache Licen',
      ' se, Version 2.0"',
      "Implementation-Title: acme: the library",
      "",
    ].join("\r\n"),
  );
  assert.equal(
    manifest["Bundle-License"],
    'http://opensource.org/licenses/apache2.0.php; link="http://www.apache.org/licenses/LICENSE-2.0"; description="Apache License, Version 2.0"',
  );
  assert.equal(manifest["Implementation-Title"], "acme: the library");
  // A licence URL findLicenseId cannot map gives way to its link as well.
  assert.deepEqual(parseManifestLicenseList(manifest["Bundle-License"]), [
    "http://www.apache.org/licenses/LICENSE-2.0",
  ]);
});

// The jar reads honour HOME, which is process-wide; the two cases below run
// one after the other and restore it.
await it("collectJarNS reads the descriptor and manifest licence a jar carries", async () => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const root = mkdtempSync(join(tmpdir(), "cdxgen-embedded-pom-"));
  try {
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    mkdirSync(process.env.HOME, { recursive: true });
    resetRunState();
    const { jarDir } = writeRepoJar(root, "acme-embedded-1.2.3", {
      bundleLicense: "Apache-2.0",
      shaded: [
        {
          group: "org.shaded",
          groupPath: "org/shaded",
          artifactId: "shaded-dep",
          pom: POM("shaded-dep"),
        },
      ],
    });
    // Positive control: the jar exists and the mapping holds its namespace.
    const mapping = await collectJarNS(jarDir);
    const key = Object.keys(mapping).find((k) => k.includes("acme-embedded"));
    assert.ok(
      key,
      `collectJarNS read no entry for the jar: ${Object.keys(mapping)}`,
    );
    assert.ok(
      mapping[key].namespaces.includes("org.ex.Lib"),
      "the jar's classes were not read",
    );
    // The descriptor of the jar itself is chosen, not the shaded one.
    assert.equal(mapping[key].pom?.description, "The acme-embedded library");
    assert.equal(mapping[key].pom?.artifactId, "acme-embedded");
    assert.ok(
      mapping[key].manifestLicenses?.length,
      "the manifest licence was not read",
    );

    // The local phase of getMvnMetadata applies it without any request.
    const { getMvnMetadata } = await import("../ecosystems/ecosystems.js");
    const purl = key;
    const enriched = await getMvnMetadata(
      [
        {
          group: "com.ex",
          name: "acme-embedded",
          version: "1.2.3",
          purl,
          "bom-ref": decodeURIComponent(purl),
        },
      ],
      mapping,
    );
    assert.equal(enriched[0].license, "Apache-2.0");
    assert.equal(enriched[0].description, "The acme-embedded library");
    assert.equal(enriched[0].publisher, "Acme Ltd");
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    resetRunState();
    rmSync(root, { force: true, recursive: true });
  }
});

await it("the manifest licence applies when the pom names none, and never replaces one", async () => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const root = mkdtempSync(join(tmpdir(), "cdxgen-embedded-pom-"));
  try {
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    mkdirSync(process.env.HOME, { recursive: true });
    resetRunState();
    const { jarDir } = writeRepoJar(root, "acme-embedded-1.2.3", {
      pom: "<project><modelVersion>4.0.0</modelVersion><groupId>com.ex</groupId><artifactId>acme-embedded</artifactId><version>1.2.3</version></project>",
      bundleLicense:
        "MIT;link=https://opensource.org/MIT, https://www.apache.org/licenses/LICENSE-2.0.txt",
    });
    const mapping = await collectJarNS(jarDir);
    const key = Object.keys(mapping).find((k) => k.includes("acme-embedded"));
    assert.ok(
      key,
      `collectJarNS read no entry for the jar: ${Object.keys(mapping)}`,
    );
    const { getMvnMetadata } = await import("../ecosystems/ecosystems.js");
    const withoutLicence = [
      {
        group: "com.ex",
        name: "acme-embedded",
        version: "1.2.3",
        purl: key,
        "bom-ref": decodeURIComponent(key),
      },
    ];
    const enriched = await getMvnMetadata(withoutLicence, mapping);
    assert.deepEqual(enriched[0].license, [
      "MIT",
      "https://www.apache.org/licenses/LICENSE-2.0.txt",
    ]);
    // A licence the package already has is kept.
    const kept = await getMvnMetadata(
      [
        {
          group: "com.ex",
          name: "acme-embedded",
          version: "1.2.3",
          purl: key,
          "bom-ref": decodeURIComponent(key),
          license: "MIT",
        },
      ],
      mapping,
    );
    assert.equal(kept[0].license, "MIT");
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    resetRunState();
    rmSync(root, { force: true, recursive: true });
  }
});

await it("a jar whose path names no coordinates gets no descriptor and no component", async () => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const root = mkdtempSync(join(tmpdir(), "cdxgen-embedded-pom-"));
  try {
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    mkdirSync(process.env.HOME, { recursive: true });
    resetRunState();
    const libDir = join(root, "lib");
    mkdirSync(libDir);
    const jarPath = join(libDir, "acme-embedded-1.2.3.jar");
    writeJar(jarPath, { bundleLicense: "Apache-2.0" });
    const mapping = await collectJarNS(libDir);
    // Positive control: the jar was read, keyed by its path.
    assert.ok(mapping[jarPath]?.namespaces?.includes("org.ex.Lib"));
    assert.equal(mapping[jarPath].pom, undefined);
    // Without a pom, the path-keyed entry is skipped instead of becoming a
    // component whose purl is a file path.
    const pkgs = await convertJarNSToPackages(mapping);
    assert.deepEqual(
      pkgs.map((p) => p.purl),
      [],
      "a jar without coordinates became a component",
    );
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    resetRunState();
    rmSync(root, { force: true, recursive: true });
  }
});
