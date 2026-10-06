import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// Jar identification reads the local caches through HOME, which is
// process-wide, so this file holds one sequential test.

const ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "MVN_ARGS",
  "MAVEN_ARGS",
  "MAVEN_OPTS",
  "MAVEN_CACHE_DIR",
  "GRADLE_USER_HOME",
  "GRADLE_CACHE_DIR",
  "GRADLE_RO_DEP_CACHE",
  "COURSIER_CACHE",
  "XDG_CACHE_HOME",
];

it("extractJarArchive identifies jars from the local caches without the search API", async () => {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-jar-identity-"));
  try {
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;

    // A jar without pom.properties, as Gradle builds them.
    const classes = join(root, "classes");
    mkdirSync(join(classes, "org", "ex"), { recursive: true });
    writeFileSync(join(classes, "org", "ex", "Lib.class"), "x");
    const built = join(root, "lib.jar");
    try {
      execFileSync("jar", ["cf", built, "-C", classes, "org"]);
    } catch {
      // No JDK on this machine; the behaviour is covered by the repotests.
      return;
    }
    const versionDir = join(
      process.env.HOME,
      ".m2",
      "repository",
      "org",
      "ex",
      "lib",
      "1.0",
    );
    mkdirSync(versionDir, { recursive: true });
    const mainJar = join(versionDir, "lib-1.0.jar");
    copyFileSync(built, mainJar);
    writeFileSync(
      `${mainJar}.sha1`,
      createHash("sha1").update(readFileSync(mainJar)).digest("hex"),
    );
    const classifierJar = join(versionDir, "lib-1.0-linux.jar");
    copyFileSync(built, classifierJar);
    const sourcesJar = join(versionDir, "lib-1.0-sources.jar");
    copyFileSync(built, sourcesJar);
    // The same bytes, copied somewhere unrelated.
    const copied = join(root, "dist", "renamed.jar");
    mkdirSync(join(root, "dist"));
    copyFileSync(built, copied);

    const get = sinon.stub().rejects(new Error("no network in this test"));
    const ecosystems = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get }),
        },
      },
    );
    const extract = async (jar) => {
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-jar-identity-x-"));
      try {
        return await ecosystems.extractJarArchive(jar, tempDir);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    };

    const [fromPath] = await extract(classifierJar);
    assert.strictEqual(
      fromPath.purl,
      "pkg:maven/org.ex/lib@1.0?classifier=linux&type=jar",
    );
    assert.strictEqual(
      fromPath.evidence.identity.methods[0].technique,
      "filename",
    );

    const [fromHash] = await extract(copied);
    assert.strictEqual(fromHash.purl, "pkg:maven/org.ex/lib@1.0?type=jar");
    assert.strictEqual(
      fromHash.evidence.identity.methods[0].technique,
      "hash-comparison",
    );

    assert.deepStrictEqual(await extract(sourcesJar), []);
    assert.strictEqual(get.callCount, 0, "no request reached the network");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
});
