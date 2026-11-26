import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

// Registry documents saved from npm, PyPI and crates.io, served by a local
// stand-in for all three, run through the same lookup, collector and rules a
// direct audit with --fetch-registry-metadata runs. Only the HTTP layer is
// replaced. NPM_URL, PYPI_URL and RUST_CRATES_URL are process-wide, so this
// file holds one sequential test.

const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "test",
  "data",
  "registry",
);

const NPM_DOCUMENTS = {
  "@types/component-emitter": "npm-types-component-emitter-packument.json",
  "better-sqlite3": "npm-better-sqlite3-packument.json",
  bufferutil: "npm-bufferutil-packument.json",
  "event-stream": "npm-event-stream-packument.json",
  "left-pad": "npm-left-pad-packument.json",
  semver: "npm-semver-packument.json",
};
const PYPI_VERSION_DOCUMENTS = {
  "attrs/21.1.0": "pypi-attrs-21.1.0-version.json",
  "requests/2.31.0": "pypi-requests-2.31.0-version.json",
};
const PYPI_PROJECT_DOCUMENTS = {
  attrs: "pypi-attrs.json",
  requests: "pypi-requests.json",
};
const CRATE_DOCUMENTS = {
  anyhow: "cargo-anyhow.json",
};

function route(url) {
  const path = decodeURIComponent(url.split("?")[0]);
  let match = path.match(/^\/npm\/(.+)$/);
  if (match) {
    return NPM_DOCUMENTS[match[1]];
  }
  match = path.match(/^\/pypi\/([^/]+)\/([^/]+)\/json$/);
  if (match) {
    return PYPI_VERSION_DOCUMENTS[`${match[1]}/${match[2]}`];
  }
  match = path.match(/^\/pypi\/([^/]+)\/json$/);
  if (match) {
    return PYPI_PROJECT_DOCUMENTS[match[1]];
  }
  match = path.match(/^\/api\/v1\/crates\/([^/]+)$/);
  if (match) {
    return CRATE_DOCUMENTS[match[1]];
  }
  return undefined;
}

function component(purl, extra = {}) {
  return { type: "library", purl, "bom-ref": purl, ...extra };
}

it("runs real registry documents through the lookups, the collectors and the rules", async () => {
  const requested = [];
  const server = createServer((req, res) => {
    requested.push(req.url);
    const file = route(req.url);
    res.writeHead(file ? 200 : 404, { "content-type": "application/json" });
    res.end(file ? readFileSync(join(FIXTURES, file)) : "{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = {
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    NPM_URL: process.env.NPM_URL,
    PYPI_URL: process.env.PYPI_URL,
    RUST_CRATES_URL: process.env.RUST_CRATES_URL,
  };
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.NPM_URL = `${base}/npm/`;
  process.env.PYPI_URL = `${base}/pypi/`;
  process.env.RUST_CRATES_URL = `${base}/api/v1/crates/`;
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { enrichInputBomsWithRegistryMetadata } = await import(
      "./targets.js"
    );
    const { auditBom } = await import("../stages/postgen/auditBom.js");
    const { getNpmMetadata } = await import("../ecosystems/ecosystems.js");

    const bomJson = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      metadata: {},
      components: [
        // Unpublished: npm keeps its publish time but no version entry.
        component("pkg:npm/event-stream@3.3.6"),
        // Build metadata the registry does not key versions by.
        component("pkg:npm/semver@7.7.2%2Bbuild.1"),
        // Deprecated itself, and released last in 2018.
        component("pkg:npm/left-pad@1.3.0"),
        // Only the newest release (2.0.0) is deprecated.
        component("pkg:npm/%40types/component-emitter@1.2.13"),
        // Native modules built or fetched by the install script.
        component("pkg:npm/bufferutil@4.0.8"),
        component("pkg:npm/better-sqlite3@12.11.1"),
        // A pinned release the index serves, a yanked one, one the index
        // never had, and a name the index does not hold at all.
        component("pkg:pypi/requests@2.31.0"),
        component("pkg:pypi/attrs@21.1.0"),
        component("pkg:pypi/requests@9.9.9"),
        component("pkg:pypi/acme-private-tool@1.0.0"),
        // A crate version crates.io does not list.
        component("pkg:cargo/anyhow@0.0.999"),
      ],
    };
    await enrichInputBomsWithRegistryMetadata(
      [{ bomJson, source: "bom.json" }],
      { forDirectAudit: true },
    );
    const findings = await auditBom(bomJson, {
      bomAuditCategories: "package-integrity",
      bomAuditMinSeverity: "low",
    });
    const registryRules = new Set([
      "INT-005",
      ...Array.from({ length: 12 }, (_, index) => `INT-0${20 + index}`),
    ]);
    const firedFor = (purl) =>
      findings
        .filter(
          (finding) =>
            finding.location?.purl === purl &&
            registryRules.has(finding.ruleId),
        )
        .map((finding) => finding.ruleId)
        .sort();
    assert.deepStrictEqual(firedFor("pkg:npm/event-stream@3.3.6"), [
      "INT-020",
      "INT-026",
    ]);
    assert.match(
      findings.find((finding) => finding.ruleId === "INT-020").message,
      /was published and then unpublished/,
    );
    assert.deepStrictEqual(firedFor("pkg:npm/semver@7.7.2%2Bbuild.1"), []);
    assert.deepStrictEqual(firedFor("pkg:npm/left-pad@1.3.0"), [
      "INT-005",
      "INT-026",
    ]);
    assert.deepStrictEqual(
      firedFor("pkg:npm/%40types/component-emitter@1.2.13"),
      ["INT-031"],
    );
    assert.match(
      findings.find((finding) => finding.ruleId === "INT-031").message,
      /newest release 2\.0\.0 is: This is a stub types definition/,
    );
    assert.deepStrictEqual(firedFor("pkg:npm/bufferutil@4.0.8"), ["INT-029"]);
    assert.deepStrictEqual(firedFor("pkg:npm/better-sqlite3@12.11.1"), [
      "INT-029",
    ]);
    assert.deepStrictEqual(firedFor("pkg:pypi/requests@2.31.0"), []);
    assert.deepStrictEqual(firedFor("pkg:pypi/attrs@21.1.0"), ["INT-030"]);
    assert.strictEqual(
      findings.find((finding) => finding.ruleId === "INT-030").evidence
        .yankedReason,
      "Installable but not importable on Python 3.4.",
    );
    assert.deepStrictEqual(firedFor("pkg:pypi/requests@9.9.9"), ["INT-021"]);
    assert.deepStrictEqual(firedFor("pkg:pypi/acme-private-tool@1.0.0"), []);
    assert.deepStrictEqual(firedFor("pkg:cargo/anyhow@0.0.999"), ["INT-022"]);

    const propertiesOf = (purl) =>
      bomJson.components.find((c) => c.purl === purl).properties || [];
    const propertyValue = (purl, name) =>
      propertiesOf(purl).find((property) => property.name === name)?.value;
    // The project document was read for the package's age and newest release.
    assert.strictEqual(
      propertyValue("pkg:pypi/attrs@21.1.0", "cdx:pypi:latestPublishTime"),
      "2022-07-28T13:20:27.076Z",
    );
    assert.strictEqual(
      propertyValue("pkg:npm/bufferutil@4.0.8", "cdx:npm:nativeBuildTool"),
      "node-gyp-build",
    );
    assert.strictEqual(
      propertyValue(
        "pkg:npm/better-sqlite3@12.11.1",
        "cdx:npm:nativeBuildTool",
      ),
      "node-gyp, prebuild-install",
    );
    // Each project document is fetched once per name.
    assert.strictEqual(
      requested.filter((url) => url === "/pypi/requests/json").length,
      1,
    );

    // The npm lookup keeps the deprecation a lockfile parser already wrote,
    // and an application's own package.json read from an image is not
    // marked missing because a public package shares its name.
    const [fromLockfile, appManifest] = await getNpmMetadata([
      {
        name: "left-pad",
        version: "1.3.0",
        purl: "pkg:npm/left-pad@1.3.0",
        properties: [
          {
            name: "cdx:npm:deprecation_notice",
            value: "use String.prototype.padStart()",
          },
        ],
      },
      {
        name: "left-pad",
        version: "9.0.0",
        purl: "pkg:npm/left-pad@9.0.0",
        properties: [{ name: "internal:SrcFile", value: "/app/package.json" }],
      },
    ]);
    assert.strictEqual(
      fromLockfile.properties.filter(
        (property) => property.name === "cdx:npm:deprecation_notice",
      ).length,
      1,
    );
    assert.strictEqual(
      appManifest.properties.some(
        (property) => property.name === "cdx:npm:versionMissing",
      ),
      false,
    );
    const [installed] = await getNpmMetadata([
      {
        name: "left-pad",
        version: "9.0.0",
        purl: "pkg:npm/left-pad@9.0.0",
        properties: [
          {
            name: "internal:SrcFile",
            value: "/app/node_modules/left-pad/package.json",
          },
        ],
      },
    ]);
    assert.strictEqual(
      installed.properties.find(
        (property) => property.name === "cdx:npm:versionMissing",
      )?.value,
      "true",
    );
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
