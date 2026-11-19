import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// The local Maven caches are found through HOME and the cache variables, which
// are process-wide. poku gives each file its own process, so this test lives in
// a file of its own.

const ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "MVN_ARGS",
  "MAVEN_ARGS",
  "MAVEN_OPTS",
  "MAVEN_CACHE_DIR",
  "MAVEN_HOME",
  "M2_HOME",
  "GRADLE_USER_HOME",
  "GRADLE_CACHE_DIR",
  "GRADLE_RO_DEP_CACHE",
  "COURSIER_CACHE",
  "XDG_CACHE_HOME",
  "FETCH_LICENSE",
];

it("getMvnMetadata reads a cached artifact once however often it is named", async () => {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-mvn-repeated-"));
  const { resetJvmLocalRepoCaches } = await import(
    "../inventory/jvmLocalRepos.js"
  );
  try {
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = process.env.HOME;
    const dir = join(
      root,
      "home",
      ".m2",
      "repository",
      "com",
      "acme",
      "named-often",
      "1.0",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "named-often-1.0.jar"), "jar bytes");
    writeFileSync(
      join(dir, "named-often-1.0.pom"),
      "<project><groupId>com.acme</groupId><artifactId>named-often</artifactId><version>1.0</version><licenses><license><name>MIT</name></license></licenses></project>",
    );
    const multiChecksumFile = sinon.spy(
      (await import("../core/fs.js")).multiChecksumFile,
    );
    const xml2js = sinon.spy((await import("../parsers/xml.js")).xml2js);
    const { getMvnMetadata } = await esmock("./ecosystems.js", {
      "../core/fs.js": { multiChecksumFile },
      "../parsers/xml.js": { xml2js },
    });
    resetJvmLocalRepoCaches();

    // A scanned archive may hold any number of jars that claim one coordinate.
    // The cached jar is hashed, and its POM parsed, for the first of them only.
    const named = () => ({
      group: "com.acme",
      name: "named-often",
      version: "1.0",
    });
    const pkgList = [named(), named(), named()];
    await getMvnMetadata(pkgList, {});
    assert.strictEqual(multiChecksumFile.callCount, 1);
    assert.strictEqual(xml2js.callCount, 1);
    for (const p of pkgList) {
      assert.deepStrictEqual(
        p.hashes.map((hash) => hash.alg),
        ["MD5", "SHA-1", "SHA-256", "SHA-512"],
      );
      assert.deepStrictEqual(p.hashes, pkgList[0].hashes);
      assert.deepStrictEqual(p.license, ["MIT"]);
    }
    // Every component still owns what it was given.
    assert.notStrictEqual(pkgList[1].hashes, pkgList[0].hashes);
    assert.notStrictEqual(pkgList[1].license, pkgList[0].license);

    // The next run reads the caches again.
    const { resetRunState } = await import("../core/runState.js");
    resetRunState();
    const nextRun = [named()];
    await getMvnMetadata(nextRun, {});
    assert.strictEqual(multiChecksumFile.callCount, 2);
    assert.strictEqual(xml2js.callCount, 2);
    assert.deepStrictEqual(nextRun[0].hashes, pkgList[0].hashes);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    resetJvmLocalRepoCaches();
    rmSync(root, { force: true, recursive: true });
  }
});
