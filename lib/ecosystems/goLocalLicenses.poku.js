import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// Local licence notices answer before pkg.go.dev: the directory go list
// reported, the vendor tree, and the module cache, whose directory names
// escape upper-case letters. A module the environment marks private is never
// sent. The go.sum hash map is built without any registry round trip. The
// assertions are on the exact requests a stubbed agent records, and the go
// tool output in the fixtures was recorded from a real module.

const FIXTURE = join(import.meta.dirname, "../../test/data/go-local-first");

it("go modules read local licences before pkg.go.dev", async () => {
  const previous = {
    FETCH_LICENSE: process.env.FETCH_LICENSE,
    GO_FETCH_VCS: process.env.GO_FETCH_VCS,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    GOMODCACHE: process.env.GOMODCACHE,
    GOPATH: process.env.GOPATH,
    GOPRIVATE: process.env.GOPRIVATE,
    GONOPROXY: process.env.GONOPROXY,
    GONOSUMDB: process.env.GONOSUMDB,
    GO_PKG_URL: process.env.GO_PKG_URL,
  };
  process.env.FETCH_LICENSE = "true";
  process.env.GO_FETCH_VCS = "false";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.GO_PKG_URL = "http://127.0.0.1:1/go/";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return { statusCode: 200, body: "<html><body>go page</body></html>" };
  });
  // An empty GOPATH keeps the module cache fallback away from this machine's
  // real cache, so every case below answers from the fixture or the stub.
  const scratch = mkdtempSync(join(tmpdir(), "cdxgen-go-local-"));
  const emptyCache = join(scratch, "empty-modcache");
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const {
      parseGosumHashes,
      parseGosumData,
      parseGoListDep,
      parseGoModulesTxt,
      readLocalGoLicense,
    } = await esmock(
      "./parsers-go.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const gosumData = readFileSync(join(FIXTURE, "go.sum"), "utf-8");
    const gosumMap = parseGosumHashes(gosumData);
    assert.deepStrictEqual(gosumMap, {
      "golang.org/x/text@v0.42.0":
        "sha256-ojzP1Z+2QtioaF8DTtO8K5q7JWVVYwZKenzujK0Zd0E=",
    });

    // The module cache layout escapes upper-case letters as `!` plus the
    // lower-case letter, and a COPYING notice answers like a LICENSE one.
    process.env.GOMODCACHE = join(FIXTURE, "modulecache");
    const tomlNotice = readLocalGoLicense("github.com/BurntSushi/toml", "v1.3.2");
    assert.ok(tomlNotice?.startsWith("The MIT License"));

    // A module whose notice the cache holds is not asked about.
    requested.length = 0;
    const fromCache = await parseGosumData(gosumData);
    assert.deepStrictEqual(requested, []);
    assert.ok(
      fromCache[0].licenses?.[0]?.license?.text?.content?.includes(
        "Copyright",
      ),
    );

    // The vendor tree and the go list directory answer as well. The recorded
    // output names its directories through placeholders, which are pointed at
    // this run's fixture trees.
    requested.length = 0;
    const project = join(scratch, "project");
    const listOutput = readFileSync(join(FIXTURE, "go-list-deps.txt"), "utf-8")
      .replaceAll("<GOMODCACHE>", join(FIXTURE, "modulecache"))
      .replaceAll("<PROJECT>", project);
    const { parentComponent, pkgList } = await parseGoListDep(listOutput, {});
    assert.deepStrictEqual(requested, []);
    assert.strictEqual(parentComponent.name, "gofix.example.com/hello");
    assert.ok(pkgList[0].licenses?.length);
    const vendored = await parseGoModulesTxt(
      join(FIXTURE, "vendor/modules.txt"),
      {},
    );
    assert.deepStrictEqual(requested, []);
    assert.ok(vendored[0].licenses?.length);

    // A module the environment marks private is never sent, even with no
    // local notice at all.
    process.env.GOMODCACHE = emptyCache;
    process.env.GOPRIVATE = "golang.org/x/*";
    requested.length = 0;
    await parseGosumData(gosumData);
    assert.deepStrictEqual(requested, []);

    // A public module without a local notice is still asked about, at the URL
    // that names the pinned version.
    process.env.GOPRIVATE = "";
    requested.length = 0;
    await parseGosumData(gosumData);
    assert.deepStrictEqual(requested, [
      "http://127.0.0.1:1/go/golang.org/x/text@v0.42.0?tab=licenses",
    ]);
  } finally {
    rmSync(scratch, { force: true, recursive: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
