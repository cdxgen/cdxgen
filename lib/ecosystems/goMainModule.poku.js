import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// pkg.go.dev lookups against a stubbed agent, so the assertions are about the
// exact requests made. The go list output names the main module first, and its
// fifth field is true; no registry holds the project itself.

const GO_LIST_OUTPUT = [
  "example.com/acme/tool|v0.1.0|false|/p/go.mod|1.21|true|<nil>|||/p",
  "golang.org/x/text|v0.3.0|false|/x/go.mod|1.21|false|<nil>||h1:aaaa=|/x",
].join("\n");

it("parseGoListDep does not look up the main module", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousGoFetchVcs = process.env.GO_FETCH_VCS;
  const previousGoPkgUrl = process.env.GO_PKG_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.GO_FETCH_VCS = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.GO_PKG_URL = "http://127.0.0.1:1/go/";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return { statusCode: 200, body: "<html><body>go page</body></html>" };
  });
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { parseGoListDep } = await esmock(
      "./parsers-go.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const retMap = await parseGoListDep(GO_LIST_OUTPUT, {
      "golang.org/x/text@v0.3.0": "h1:aaaa=",
    });
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/go/golang.org/x/text",
      "http://127.0.0.1:1/go/golang.org/x/text?tab=licenses",
    ]);
    assert.strictEqual(retMap.parentComponent.name, "example.com/acme/tool");
    assert.deepStrictEqual(
      retMap.pkgList.map((p) => p.name),
      ["golang.org/x/text"],
    );
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      GO_FETCH_VCS: previousGoFetchVcs,
      GO_PKG_URL: previousGoPkgUrl,
      CDXGEN_RS_DISABLE: previousRsDisable,
    })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

it("parseGoModGraph does not look up the main module", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousGoFetchVcs = process.env.GO_FETCH_VCS;
  const previousGoPkgUrl = process.env.GO_PKG_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.GO_FETCH_VCS = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.GO_PKG_URL = "http://127.0.0.1:1/go/";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return { statusCode: 200, body: "<html><body>go page</body></html>" };
  });
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-gomod-"));
  const goModFile = join(dir, "go.mod");
  writeFileSync(
    goModFile,
    [
      "module example.com/acme/tool",
      "",
      "go 1.21",
      "",
      "require golang.org/x/text v0.3.0",
      "",
    ].join("\n"),
  );
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { parseGoModGraph } = await esmock(
      "./parsers-go.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const retMap = await parseGoModGraph(
      "example.com/acme/tool@v0.1.0 golang.org/x/text@v0.3.0\n",
      goModFile,
      {},
      [],
      {},
    );
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/go/golang.org/x/text",
      "http://127.0.0.1:1/go/golang.org/x/text?tab=licenses",
    ]);
    assert.strictEqual(retMap.parentComponent.name, "example.com/acme/tool");
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      GO_FETCH_VCS: previousGoFetchVcs,
      GO_PKG_URL: previousGoPkgUrl,
      CDXGEN_RS_DISABLE: previousRsDisable,
    })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
