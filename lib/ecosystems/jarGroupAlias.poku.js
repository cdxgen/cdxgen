import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";

import { resetRunState } from "../core/runState.js";

// Which group a jar reports when the Maven descriptor is missing. A vendor
// alias does not move a jar to another organization when its
// Bundle-SymbolicName is exactly <group>.<artifactId>, as Jackson 3 jars
// declare; every looser manifest keeps the alias. The jars are built here from
// small files, as stored zip archives, mirroring the manifests the real
// Jackson artifacts ship. Jar identification reads HOME, which is
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

/** Build a stored zip archive from the given entries. */
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

/**
 * Build a jar with no Maven descriptor, so identification falls through to
 * the manifest, exactly as a jar that reaches the manifest fallback does.
 */
function writeManifestOnlyJar(jarPath, { manifest, classFile }) {
  buildZip(jarPath, {
    [classFile]: "not really a class",
    "META-INF/MANIFEST.MF": `${["Manifest-Version: 1.0", ...manifest].join(
      "\n",
    )}\n`,
  });
}

const ENV_NAMES = ["HOME", "USERPROFILE", "FETCH_LICENSE", "MAVEN_CACHE_DIR"];

async function scanJar(jarName, jarFiles) {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-jar-group-"));
  try {
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    resetRunState();
    const jarFile = join(root, jarName);
    writeManifestOnlyJar(jarFile, jarFiles);
    // The Central search must not leave the test machine: it answers with no
    // hit, as it would for a hash it has never indexed.
    const agent = {
      get: () => Promise.resolve({ body: { response: { numFound: 0 } } }),
    };
    const { extractJarArchive } = await esmock("./ecosystems.js", {
      "../core/activity.js": {
        cdxgenAgent: agent,
      },
    });
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

await it("a Jackson 3 jar keeps the group its manifest declares", async () => {
  const pkgList = await scanJar("jackson-databind-3.1.5.jar", {
    classFile: "tools/jackson/databind/ObjectMapper.class",
    manifest: [
      "Bundle-Name: jackson-databind",
      "Bundle-SymbolicName: tools.jackson.core.jackson-databind",
      "Bundle-Version: 3.1.5",
      "Implementation-Version: 3.1.5",
    ],
  });
  assert.equal(pkgList.length, 1, "the jar scan produced no component");
  const pkg = pkgList[0];
  assert.equal(pkg.name, "jackson-databind");
  assert.equal(pkg.version, "3.1.5");
  // The alias table maps jackson-databind to com.fasterxml.jackson.core; the
  // symbolic name the jar itself declares must win for the Jackson 3 group.
  assert.equal(
    pkg.group,
    "tools.jackson.core",
    "the Jackson 3 group was overridden by the vendor alias",
  );
  assert.equal(
    pkg.purl,
    "pkg:maven/tools.jackson.core/jackson-databind@3.1.5?type=jar",
  );
});

await it("a Jackson 2 jar keeps the com.fasterxml group its manifest declares", async () => {
  const pkgList = await scanJar("jackson-databind-2.16.1.jar", {
    classFile: "com/fasterxml/jackson/databind/ObjectMapper.class",
    manifest: [
      "Bundle-Name: jackson-databind",
      "Bundle-SymbolicName: com.fasterxml.jackson.core.jackson-databind",
      "Bundle-Version: 2.16.1",
    ],
  });
  assert.equal(pkgList.length, 1, "the jar scan produced no component");
  assert.equal(pkgList[0].group, "com.fasterxml.jackson.core");
  assert.equal(
    pkgList[0].purl,
    "pkg:maven/com.fasterxml.jackson.core/jackson-databind@2.16.1?type=jar",
  );
});

await it("a jar with no manifest group still gets the vendor alias", async () => {
  const pkgList = await scanJar("jackson-dataformat-xml-2.17.0.jar", {
    classFile: "com/fasterxml/jackson/dataformat/xml/XmlFactory.class",
    manifest: ["Bundle-Version: 2.17.0", "Implementation-Version: 2.17.0"],
  });
  assert.equal(pkgList.length, 1, "the jar scan produced no component");
  // Nothing in the manifest names a group, so the alias is the only source.
  assert.equal(pkgList[0].group, "com.fasterxml.jackson.dataformat");
  assert.equal(pkgList[0].name, "jackson-dataformat-xml");
});

await it("a looser symbolic name keeps the vendor alias", async () => {
  // commons-lang3 declares org.apache.commons.lang3, from which the manifest
  // fallback reads the group org.apache. The alias org.apache.commons is the
  // right group, so it still applies.
  const pkgList = await scanJar("commons-lang3-3.20.0.jar", {
    classFile: "org/apache/commons/lang3/StringUtils.class",
    manifest: [
      "Bundle-SymbolicName: org.apache.commons.lang3",
      "Bundle-Version: 3.20.0",
      "Automatic-Module-Name: org.apache.commons.lang3",
    ],
  });
  assert.equal(pkgList.length, 1, "the jar scan produced no component");
  assert.equal(pkgList[0].group, "org.apache.commons");
  assert.equal(pkgList[0].name, "commons-lang3");
});

await it("an exact symbolic name in the alias's own organization keeps the alias", async () => {
  // Tomcat names itself org.apache.tomcat-embed-core, so the manifest group is
  // org.apache, while the artifact lives in org.apache.tomcat.embed.
  const pkgList = await scanJar("tomcat-embed-core-11.0.24.jar", {
    classFile: "org/apache/catalina/Server.class",
    manifest: [
      "Bundle-SymbolicName: org.apache.tomcat-embed-core",
      "Bundle-Version: 11.0.24",
    ],
  });
  assert.equal(pkgList.length, 1, "the jar scan produced no component");
  assert.equal(pkgList[0].group, "org.apache.tomcat.embed");
});
