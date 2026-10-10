import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

// A lookup the batch did not answer is made by the metadata function itself.
// That request reaches the same host as the batch and must wait behind the
// same per-host gate, so a host paused for rate limiting is not asked through
// a side door. Prefetching is switched off here so every lookup takes its
// direct path, and a loopback registry records whatever arrives. The registry
// URLs, the caches and the prefetch switch are process-wide, so this file
// holds one sequential test.

const ENV_NAMES = [
  "CDXGEN_CASSETTE_REPLAY",
  "CDXGEN_RS_DISABLE",
  "FETCH_LICENSE",
  "PYPI_URL",
  "PUB_DEV_URL",
  "GO_PKG_URL",
  "RUST_CRATES_URL",
  "RUBYGEMS_V1_URL",
  "RUBYGEMS_V2_URL",
  "NUGET_URL",
  "NUGET_PACKAGES",
  "ELM_PACKAGE_URL",
  "JSR_API_URL",
  "CDXGEN_TF_REGISTRY_URL",
  "CDXGEN_TOFU_DOCS_URL",
  "MAVEN_CENTRAL_URL",
  "MAVEN_CACHE_DIR",
  "GRADLE_USER_HOME",
  "COURSIER_CACHE",
  "CARGO_HOME",
  "HOME",
];

it("every registry fallback waits behind the host's gate", async () => {
  const previous = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  const hits = [];
  const registry = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${registry.address().port}`;
  const empty = mkdtempSync(join(tmpdir(), "cdxgen-fallback-gate-"));
  Object.assign(process.env, {
    CDXGEN_CASSETTE_REPLAY: "true",
    CDXGEN_RS_DISABLE: "fetch",
    FETCH_LICENSE: "true",
    PYPI_URL: `${base}/pypi/`,
    PUB_DEV_URL: `${base}/pub`,
    GO_PKG_URL: `${base}/go/`,
    RUST_CRATES_URL: `${base}/crates/`,
    RUBYGEMS_V1_URL: `${base}/gems/v1/`,
    RUBYGEMS_V2_URL: `${base}/gems/v2/`,
    NUGET_URL: `${base}/nuget/`,
    NUGET_PACKAGES: empty,
    ELM_PACKAGE_URL: `${base}/elm`,
    JSR_API_URL: `${base}/jsr/`,
    CDXGEN_TF_REGISTRY_URL: `${base}/tf`,
    CDXGEN_TOFU_DOCS_URL: `${base}/tofu`,
    MAVEN_CENTRAL_URL: `${base}/maven2/`,
    MAVEN_CACHE_DIR: empty,
    GRADLE_USER_HOME: empty,
    COURSIER_CACHE: empty,
    CARGO_HOME: empty,
    HOME: empty,
  });
  const fetchBatch = await import("../inventory/fetchBatch.js");
  try {
    const ecosystems = await import("./ecosystems.js");
    const { getRubyGemsMetadata } = await import("./rubyutils.js");
    const { getJsrMetadata } = await import("./denoutils.js");
    const { getElmMetadata } = await import("./parsers-elm.js");
    const { getTerraformRegistryMetadata } = await import(
      "./terraformRegistry.js"
    );
    const { resetRunState } = await import("../core/runState.js");
    resetRunState();

    // Positive control: the direct path reaches the registry.
    await ecosystems.getNpmMetadata(
      [{ name: "left-pad", version: "1.3.0" }],
      `${base}/npm/`,
    );
    assert.deepStrictEqual(hits, ["/npm/left-pad"]);

    hits.length = 0;
    fetchBatch.openHostCircuit("127.0.0.1", { quiet: true });
    await ecosystems.getNpmMetadata(
      [{ name: "right-pad", version: "1.0.0" }],
      `${base}/npm/`,
    );
    await ecosystems.getPyMetadata([{ name: "attrs", version: "25.3.0" }]);
    await ecosystems.getDartMetadata([{ name: "http", version: "1.2.0" }]);
    await ecosystems.getGoPkgLicense({
      group: "golang.org/x",
      name: "text",
      version: "v0.3.0",
    });
    await ecosystems.getGoPkgVCSUrl("golang.org/x", "net", "v0.1.0");
    await ecosystems.getCratesMetadata([{ name: "serde", version: "1.0.0" }]);
    await ecosystems.getNugetMetadata(
      [{ group: "", name: "Serilog", version: "3.0.1" }],
      [],
    );
    await ecosystems.getMvnMetadata([
      { group: "org.example", name: "lib", version: "1.0.0" },
    ]);
    await getRubyGemsMetadata([{ name: "rake", version: "13.0.6" }]);
    await getJsrMetadata([
      {
        name: "std-path",
        version: "1.0.0",
        properties: [{ name: "cdx:deno:jsrKey", value: "@std/path@1.0.0" }],
      },
    ]);
    await getElmMetadata([
      { group: "elm", name: "core", version: "1.0.5", properties: [] },
    ]);
    await getTerraformRegistryMetadata([
      {
        type: "library",
        group: "registry.terraform.io/acme",
        name: "vpc/aws",
        version: "1.0.0",
        "bom-ref": "pkg:generic/registry.terraform.io/acme/vpc/aws@1.0.0",
        properties: [
          { name: "cdx:tf:kind", value: "module" },
          {
            name: "cdx:tf:address",
            value: "registry.terraform.io/acme/vpc/aws",
          },
        ],
      },
    ]);
    assert.deepStrictEqual(
      hits,
      [],
      "a fallback request reached a host paused for rate limiting",
    );
  } finally {
    fetchBatch.resetHostCircuits();
    await new Promise((resolve) => registry.close(resolve));
    rmSync(empty, { force: true, recursive: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
