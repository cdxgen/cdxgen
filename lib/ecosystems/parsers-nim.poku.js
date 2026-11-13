import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { parseNimProject, readNimbleFile } from "./parsers-nim.js";

describe("parseNimProject", () => {
  it("parses the lock with generic purls and revision provenance", () => {
    const { pkgList, parentComponent, rootInputs, dependencies } =
      parseNimProject(
        "./test/data/nim-smoke/example.nimble",
        "./test/data/nim-smoke/nimble.lock",
      );
    assert.strictEqual(parentComponent.name, "example");
    assert.strictEqual(parentComponent.version, "0.1.0");
    assert.strictEqual(parentComponent.license, "MIT");

    // nimble.lock keys `packages` by name; each record names the packages it
    // depends on, which gives the graph between locked entries.
    assert.strictEqual(pkgList.length, 2);
    const semver = pkgList.find((p) => p.name === "semver");
    assert.strictEqual(semver.name, "semver");
    assert.strictEqual(semver.version, "1.0.0");
    assert.strictEqual(semver.purl, "pkg:generic/semver@1.0.0");
    assert.strictEqual(
      semver.properties.find((p) => p.name === "cdx:purl:proposedType").value,
      "nim",
    );
    assert.strictEqual(
      semver.properties.find((p) => p.name === "cdx:nim:dependency").value,
      "direct",
    );
    assert.strictEqual(
      semver.properties.find((p) => p.name === "cdx:nim:vcsRevision").value,
      "5a1ef38c5b0b1e4b1c82d182a2af1cd8c851bf60",
    );
    // results is locked but not declared in the .nimble, so it is transitive
    // and reachable only through semver.
    const results = pkgList.find((p) => p.name === "results");
    assert.strictEqual(
      results.properties.find((p) => p.name === "cdx:nim:dependency").value,
      "transitive",
    );
    assert.deepStrictEqual(rootInputs, [semver["bom-ref"]]);
    assert.deepStrictEqual(
      dependencies.find((d) => d.ref === semver["bom-ref"]).dependsOn,
      [results["bom-ref"]],
    );
  });

  it("falls back to declared requirements without a lock", () => {
    const { pkgList } = parseNimProject(
      "./test/data/nim-smoke/example.nimble",
      undefined,
    );
    // nim itself is a language requirement; URL requirements resolve to the
    // repository name.
    assert.deepStrictEqual(pkgList.map((p) => p.name).sort(), [
      "nim",
      "semver",
    ]);
  });
});

describe("readNimbleFile", () => {
  it("reads assignments and requires lines including URL requirements", () => {
    const fields = readNimbleFile("./test/data/nim-smoke/example.nimble");
    assert.strictEqual(fields.version, "0.1.0");
    assert.strictEqual(fields.license, "MIT");
    assert.deepStrictEqual(fields.requires, [
      { name: "nim", constraint: ">= 2.0.0" },
      { name: "semver", constraint: ">= 1.0.0" },
    ]);
  });
});

describe("parseNimProject with a large lock", () => {
  it("reads a package array longer than a call takes arguments", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-nim-large-lock-"));
    const lockFile = join(tempDir, "nimble.lock");
    writeFileSync(
      lockFile,
      JSON.stringify({
        packages: Array.from({ length: 200000 }, (_, i) => ({
          name: `p${i}`,
          version: "1.0.0",
        })),
      }),
    );
    try {
      const result = parseNimProject(
        "./test/data/nim-smoke/example.nimble",
        lockFile,
      );
      assert.strictEqual(result.lockEntries, 200000);
      assert.strictEqual(result.pkgList.length, 200000);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
