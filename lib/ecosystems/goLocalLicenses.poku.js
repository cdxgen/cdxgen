import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  // The fixture is the module cache, and GOPATH points nowhere, so no case
  // below can be answered by this machine's own cache.
  const scratch = mkdtempSync(join(tmpdir(), "cdxgen-go-local-"));
  const emptyCache = join(scratch, "empty-modcache");
  process.env.GOMODCACHE = join(FIXTURE, "modulecache");
  process.env.GOPATH = join(scratch, "gopath");
  delete process.env.GOPRIVATE;
  delete process.env.GONOPROXY;
  delete process.env.GONOSUMDB;
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { prefetchGoPkgMetadata, resetGoPkgPrefetch } = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
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

    // A module whose notice the cache holds is not asked about.
    requested.length = 0;
    const fromCache = await parseGosumData(gosumData);
    assert.deepStrictEqual(requested, []);
    assert.ok(
      fromCache[0].licenses?.[0]?.license?.text?.content?.includes("Copyright"),
    );
    // The notice names its licence, so the component carries the SPDX id
    // pkg.go.dev would have given.
    assert.strictEqual(fromCache[0].licenses[0].license.id, "BSD-3-Clause");

    // Without FETCH_LICENSE the module cache is not read: it stands in for
    // pkg.go.dev, which is not being asked either.
    process.env.FETCH_LICENSE = "false";
    const unfetched = await parseGosumData(gosumData);
    assert.strictEqual(unfetched[0].licenses, undefined);
    process.env.FETCH_LICENSE = "true";

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
    // local notice at all. Go ignores a trailing slash on a pattern.
    process.env.GOMODCACHE = emptyCache;
    for (const pattern of ["golang.org/x/*", "golang.org/x/"]) {
      process.env.GOPRIVATE = pattern;
      requested.length = 0;
      await parseGosumData(gosumData);
      assert.deepStrictEqual(requested, [], pattern);
    }

    // A public module without a local notice is still asked about, at the URL
    // that names the pinned version.
    process.env.GOPRIVATE = "";
    requested.length = 0;
    await parseGosumData(gosumData);
    assert.deepStrictEqual(requested, [
      "http://127.0.0.1:1/go/golang.org/x/text@v0.42.0?tab=licenses",
    ]);

    // The module cache layout escapes upper-case letters as `!` plus the
    // lower-case letter, and a COPYING notice answers like a LICENSE one.
    process.env.GOMODCACHE = join(FIXTURE, "modulecache");
    const tomlNotice = readLocalGoLicense(
      "github.com/BurntSushi/toml",
      "v1.3.2",
    );
    assert.ok(tomlNotice?.startsWith("The MIT License"));

    // A module whose licence is known locally is still batched for its module
    // page, which the repository URL comes from; only the licence tab goes.
    process.env.GO_FETCH_VCS = "true";
    resetGoPkgPrefetch();
    requested.length = 0;
    await prefetchGoPkgMetadata([
      { name: "golang.org/x/text", version: "v0.42.0", licenseKnown: true },
      { name: "golang.org/x/net", version: "v0.1.0" },
    ]);
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/go/golang.org/x/net@v0.1.0",
      "http://127.0.0.1:1/go/golang.org/x/net@v0.1.0?tab=licenses",
      "http://127.0.0.1:1/go/golang.org/x/text@v0.42.0",
    ]);
    process.env.GO_FETCH_VCS = "false";

    // The go.sum hash map is built without any registry round trip, and
    // holds the checksum of the module content, not of its go.mod file.
    const gosumMap = parseGosumHashes(gosumData);
    assert.deepStrictEqual(gosumMap, {
      "golang.org/x/text@v0.42.0":
        "sha256-JbOZXgfeCPU9gacVtYliJqOhD+zhrEqK4LfdpmlUZqI=",
    });
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

// The notices below are the real files of these module releases, as
// `go mod download` unpacked them into the module cache.
it("go modules read every local notice, at Go's escaped cache path, and nothing outside it", async () => {
  const previous = {
    FETCH_LICENSE: process.env.FETCH_LICENSE,
    GO_FETCH_VCS: process.env.GO_FETCH_VCS,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    GOMODCACHE: process.env.GOMODCACHE,
    GO_PKG_URL: process.env.GO_PKG_URL,
  };
  process.env.FETCH_LICENSE = "true";
  process.env.GO_FETCH_VCS = "false";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.GO_PKG_URL = "http://127.0.0.1:1/go/";
  process.env.GOMODCACHE = join(FIXTURE, "modulecache");
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return { statusCode: 200, body: "<html><body>go page</body></html>" };
  });
  const scratch = mkdtempSync(join(tmpdir(), "cdxgen-go-notices-"));
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const httpClientMock = {
      "../core/httpClient.js": {
        createHttpClient: sinon.stub().returns({ get: agentGet }),
      },
    };
    const {
      getGoPkgComponent,
      parseGoModGraph,
      parseGoModulesTxt,
      readLocalGoLicenses,
    } = await esmock("./parsers-go.js", {}, httpClientMock);
    const licenseIds = (component) =>
      component.licenses.map((l) => l.license?.id || l.expression);

    // The module cache escapes upper-case letters of the version as well as
    // of the path: v2.10.17-RC.1 is stored as v2.10.17-!r!c.1.
    assert.deepStrictEqual(
      readLocalGoLicenses(
        "github.com/nats-io/nats-server/v2",
        "v2.10.17-RC.1",
      ).map((n) => n.fileName),
      ["LICENSE"],
    );

    // One notice granting two licenses yields both, as pkg.go.dev reports.
    const yaml = await getGoPkgComponent("", "gopkg.in/yaml.v3", "v3.0.1");
    assert.deepStrictEqual(licenseIds(yaml), ["MIT", "Apache-2.0"]);
    // A Windows checkout may hold the notice with CRLF line endings.
    assert.ok(
      yaml.licenses.every((l) =>
        l.license.text.content
          .replaceAll("\r\n", "\n")
          .startsWith("\nThis project is covered by two different licenses"),
      ),
    );
    // Every notice of the module is read: the code's choice of Apache-2.0 or
    // GPL-2.0 and the documentation's CC-BY-4.0.
    const spdxTools = await getGoPkgComponent(
      "",
      "github.com/spdx/tools-golang",
      "v0.5.5",
    );
    assert.deepStrictEqual(licenseIds(spdxTools), [
      "Apache-2.0",
      "GPL-2.0-only",
      "CC-BY-4.0",
    ]);
    // A license with an exception is an SPDX expression, not a name.
    const cm = await getGoPkgComponent(
      "",
      "go.bytecodealliance.org/cm",
      "v0.3.0",
    );
    assert.deepStrictEqual(cm.licenses, [
      { expression: "Apache-2.0 WITH LLVM-exception" },
    ]);

    // A component go mod graph names keeps the module path as Go prints
    // it, so the module cache directory github.com/!burnt!sushi is found.
    const graph = await parseGoModGraph(
      "example.com/app github.com/BurntSushi/toml@v1.3.2\n",
      undefined,
      {},
      [],
      {},
    );
    const toml = graph.pkgList.find((c) => c.version === "v1.3.2");
    assert.strictEqual(toml.name, "github.com/BurntSushi/toml");
    assert.deepStrictEqual(licenseIds(toml), ["MIT"]);
    assert.deepStrictEqual(requested, []);

    // A module path or version Go rejects names no directory to read, and
    // no module to ask pkg.go.dev about: `..` elements would leave the vendor
    // tree or the module cache.
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "LICENSE"), "INTERNAL: not a module notice\n");
    const vendorDir = join(scratch, "project", "vendor");
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(
      join(vendorDir, "modules.txt"),
      "# ../../outside v1.0.0\n## explicit\n../../outside\n",
    );
    const [traversal] = await parseGoModulesTxt(
      join(vendorDir, "modules.txt"),
      {},
    );
    assert.strictEqual(traversal.licenses, undefined);
    assert.strictEqual(traversal.license, undefined);
    process.env.GOMODCACHE = join(scratch, "modcache");
    assert.deepStrictEqual(
      readLocalGoLicenses("example.com/x", "v1.0.0/../../../outside"),
      [],
    );
    assert.deepStrictEqual(requested, []);
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

it("local Go licence notices stay inside the project and under the size cap", async () => {
  const previous = process.env.FETCH_LICENSE;
  process.env.FETCH_LICENSE = "true";
  const scratch = mkdtempSync(join(tmpdir(), "cdxgen-go-notice-links-"));
  try {
    const { readLocalGoLicenses } = await import("./parsers-go.js");
    const project = join(scratch, "project");
    const outside = join(scratch, "outside", "example.com", "m");
    mkdirSync(outside, { recursive: true });
    mkdirSync(project);
    writeFileSync(join(outside, "LICENSE"), "INTERNAL: not a module notice\n");
    // The vendor tree is a link out of the project.
    symlinkSync(
      join(scratch, "outside"),
      join(project, "vendor"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.deepStrictEqual(
      readLocalGoLicenses("example.com/m", undefined, { projectRoot: project }),
      [],
    );
    // A notice over the cap is not read.
    const big = join(scratch, "big");
    mkdirSync(big);
    writeFileSync(join(big, "LICENSE"), "x".repeat(1024 * 1024 + 1));
    assert.deepStrictEqual(
      readLocalGoLicenses("example.com/big", undefined, { dir: big }),
      [],
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
    if (previous === undefined) {
      delete process.env.FETCH_LICENSE;
    } else {
      process.env.FETCH_LICENSE = previous;
    }
  }
});
