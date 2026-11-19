import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { resetRunState } from "../core/runState.js";
import { extractJarArchive } from "./ecosystems.js";

// The jars are built in the test from small files, as stored zip archives,
// and carry their own Maven descriptor and manifest: the data the jar scan
// is expected to read locally. Jar identification reads HOME, which is
// process-wide, so this file holds sequential tests.

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
 * Build a stored zip archive from the given entries. `repeated` names entries
 * that get that many further central directory records pointing at their data.
 */
function buildZip(out, files, repeated = {}) {
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
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, nameBuf]));
    for (let i = 0; i < (repeated[name] ?? 0); i++) {
      const copyName = Buffer.from(`${i}/${name}`, "utf-8");
      const copy = Buffer.from(entry);
      copy.writeUInt16LE(copyName.length, 28);
      central.push(Buffer.concat([copy, copyName]));
    }
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(out, Buffer.concat([...chunks, centralBuf, end]));
}

const POM = (artifactId, { licence = true, description = true } = {}) =>
  `<project><modelVersion>4.0.0</modelVersion><groupId>com.ex</groupId><artifactId>${artifactId}</artifactId><version>1.2.3</version>${
    description ? `<description>The ${artifactId} library</description>` : ""
  }<organization><name>Acme Ltd</name></organization>${
    licence
      ? "<licenses><license><name>Apache License, Version 2.0</name></license></licenses>"
      : ""
  }</project>`;

const PROPERTIES = (artifactId, group = "com.ex") =>
  `groupId=${group}\nartifactId=${artifactId}\nversion=1.2.3\n`;

function writeJar(
  jarPath,
  {
    artifactId = "acme-embedded",
    pom,
    bundleLicense,
    shaded = [],
    repeated = {},
  } = {},
) {
  const files = {
    "org/ex/Lib.class": "not really a class",
    [`META-INF/maven/com.ex/${artifactId}/pom.properties`]:
      PROPERTIES(artifactId),
    [`META-INF/maven/com.ex/${artifactId}/pom.xml`]: pom ?? POM(artifactId),
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
  for (const name of Object.keys(repeated)) {
    files[name] = "0".repeat(1024 * 1024);
  }
  buildZip(jarPath, files, repeated);
}

const ENV_NAMES = ["HOME", "USERPROFILE", "FETCH_LICENSE", "MAVEN_CACHE_DIR"];

async function scanJar(options) {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-jar-embedded-"));
  try {
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    mkdirSync(process.env.HOME, { recursive: true });
    resetRunState();
    const jarFile = join(root, "acme-embedded-1.2.3.jar");
    writeJar(jarFile, options);
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-jar-extract-"));
    try {
      return await extractJarArchive(jarFile, tempDir);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    resetRunState();
    rmSync(root, { force: true, recursive: true });
  }
}

await it("the jar scan reads the metadata and licence the jar carries", async () => {
  const pkgList = await scanJar({});
  // Positive control: the jar produced a component.
  assert.equal(pkgList.length, 1, "the jar scan produced no component");
  const pkg = pkgList[0];
  assert.equal(pkg.name, "acme-embedded");
  assert.equal(pkg.group, "com.ex");
  assert.equal(pkg.version, "1.2.3");
  assert.equal(
    pkg.license,
    "Apache-2.0",
    "the embedded pom licence was not read",
  );
  assert.equal(pkg.description, "The acme-embedded library");
  assert.equal(pkg.publisher, "Acme Ltd");
});

await it("the manifest licence applies when the pom names none", async () => {
  const pkgList = await scanJar({
    pom: "<project><modelVersion>4.0.0</modelVersion><groupId>com.ex</groupId><artifactId>acme-embedded</artifactId><version>1.2.3</version><description>The acme-embedded library</description></project>",
    bundleLicense:
      "MIT;link=https://opensource.org/MIT, Apache-2.0;description=Apache License 2.0",
  });
  assert.equal(pkgList.length, 1, "the jar scan produced no component");
  assert.deepEqual(pkgList[0].license, ["MIT", "Apache-2.0"]);
  assert.equal(pkgList[0].description, "The acme-embedded library");
});

await it("a shaded jar's own descriptor is the one read", async () => {
  const pkgList = await scanJar({
    shaded: [
      {
        group: "org.shaded",
        groupPath: "org/shaded",
        artifactId: "shaded-dep",
        pom: POM("shaded-dep"),
      },
    ],
  });
  assert.equal(pkgList.length, 1, "the jar scan produced no component");
  assert.equal(pkgList[0].name, "acme-embedded");
  assert.equal(pkgList[0].description, "The acme-embedded library");
  assert.equal(pkgList[0].license, "Apache-2.0");
});

await it("a jar that declares more than it may unpack to is not extracted", async () => {
  // Positive control: a few records for one entry are within the budget.
  assert.equal(
    (await scanJar({ repeated: { "org/ex/Pad.bin": 2 } })).length,
    1,
  );
  // A jar of 1 MiB whose 301 records for that entry declare 301 MiB.
  assert.deepEqual(await scanJar({ repeated: { "org/ex/Pad.bin": 300 } }), []);
});
