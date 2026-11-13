import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// package-lock enrichment against a stubbed agent, so the assertions are about
// the exact requests made. The npm fixture holds a workspace, a link, a file
// dependency, a git dependency and a scope that .npmrc maps to another
// registry; none of them can be asked about on the default registry.

it("parsePkgLock asks the registry only for packages it can hold", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousNpmUrl = process.env.NPM_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const documents = {
    "http://127.0.0.1:1/left-pad": {
      name: "left-pad",
      description: "from the default registry",
      versions: {},
    },
    "http://127.0.0.1:1/nolic": { name: "nolic" },
    "http://npm.acme.invalid/@acme/private": {
      name: "@acme/private",
      description: "from the acme registry",
      versions: {},
    },
  };
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    return { statusCode: 200, body: documents[url] || {} };
  });
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { parsePkgLock } = await esmock(
      "./parsers-js.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    process.env.NPM_URL = "http://127.0.0.1:1/";
    const { pkgList } = await parsePkgLock(
      join(
        import.meta.dirname,
        "../../test/data/registry-stub/npm/package-lock.json",
      ),
    );
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/left-pad",
      "http://127.0.0.1:1/nolic",
      "http://npm.acme.invalid/@acme/private",
    ]);
    const find = (name, version) =>
      pkgList.filter((p) => p.name === name && p.version === version);
    // The public package is enriched from the default registry, and the
    // mapped scope from its own.
    assert.strictEqual(
      find("left-pad", "1.3.0")[0].description,
      "from the default registry",
    );
    assert.strictEqual(
      find("private", "2.0.0")[0].description,
      "from the acme registry",
    );
    // The project, the workspace member, the file and git sources keep the
    // data the lockfile gave them and were never asked about.
    assert.strictEqual(find("root", "1.0.0")[0].license, undefined);
    for (const local of find("localdep", "0.0.1")) {
      assert.strictEqual(local.license, "ISC");
    }
    for (const ws of find("my-ws", "0.1.0")) {
      assert.strictEqual(ws.license, "Apache-2.0");
    }
    assert.strictEqual(find("gitdep", "1.0.0")[0].license, "MIT");

    // A scope with no .npmrc mapping is asked at the registry that served its
    // tarball. The public registry's other hosts and the registry cdxgen is
    // configured to ask count as the default.
    // Each load is a fresh run, with no packument remembered from another.
    const loadGetNpmMetadata = async () =>
      (
        await esmock(
          "./ecosystems.js",
          {},
          {
            "../core/httpClient.js": {
              createHttpClient: sinon.stub().returns({ get: agentGet }),
            },
          },
        )
      ).getNpmMetadata;
    const getNpmMetadata = await loadGetNpmMetadata();
    const tarballPkg = (group, name, resolved) => ({
      group,
      name,
      version: "1.0.0",
      properties: [{ name: "internal:ResolvedUrl", value: resolved }],
    });
    const scoped = () => [
      tarballPkg(
        "@mirror",
        "lib",
        "https://npm.mirror.invalid/repo/@mirror/lib/-/lib-1.0.0.tgz",
      ),
      tarballPkg(
        "@local",
        "lib",
        "http://127.0.0.1:1/@local/lib/-/lib-1.0.0.tgz",
      ),
      tarballPkg(
        "@babel",
        "core",
        "https://registry.yarnpkg.com/@babel/core/-/core-1.0.0.tgz",
      ),
      // Served elsewhere in a layout that does not name the registry.
      tarballPkg("@odd", "lib", "https://odd.invalid/download?id=1"),
      { group: "@acme", name: "private", version: "2.0.0", properties: [] },
    ];
    const npmrcConfig = { "@acme:registry": "http://npm.acme.invalid/" };
    requested.length = 0;
    await getNpmMetadata(scoped(), undefined, {
      npmrcConfig,
      secureMode: false,
    });
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/@babel/core",
      "http://127.0.0.1:1/@local/lib",
      "http://npm.acme.invalid/@acme/private",
      "https://npm.mirror.invalid/repo/@mirror/lib",
    ]);
    // Secure mode asks no host the scanned project names, and does not send
    // those names to the default registry either.
    requested.length = 0;
    await (await loadGetNpmMetadata())(scoped(), undefined, {
      npmrcConfig,
      secureMode: true,
    });
    assert.deepStrictEqual(requested.sort(), [
      "http://127.0.0.1:1/@babel/core",
      "http://127.0.0.1:1/@local/lib",
    ]);
    // A component that is not an npm package, such as the pkg:generic module a
    // deno lockfile's https import becomes, is never asked about: the registry
    // may hold a stranger's package under that file name.
    const remoteModule = {
      name: "left-pad",
      version: "112233445566",
      purl: "pkg:generic/left-pad@112233445566?download_url=https://deno.land/x/left-pad/mod.ts",
      externalReferences: [
        { type: "distribution", url: "https://deno.land/x/left-pad/mod.ts" },
      ],
      properties: [{ name: "cdx:deno:source", value: "https" }],
    };
    requested.length = 0;
    await (await loadGetNpmMetadata())(
      [
        remoteModule,
        { name: "left-pad", version: "1.3.0", purl: "pkg:npm/left-pad@1.3.0" },
      ],
      undefined,
      { secureMode: false },
    );
    assert.deepStrictEqual(requested, ["http://127.0.0.1:1/left-pad"]);
    assert.strictEqual(remoteModule.description, undefined);
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      NPM_URL: previousNpmUrl,
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

it("getNpmMetadata does not copy an oversized packument field onto every version", async () => {
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const longValue = "x".repeat(100_000);
  const agentGet = sinon.stub().resolves({
    statusCode: 200,
    body: {
      name: "big",
      description: longValue,
      homepage: longValue,
      license: longValue,
      repository: { url: longValue },
      time: { created: longValue },
      versions: {
        "1.0.1": { description: "one line" },
        "1.0.2": { licenses: [{ type: longValue, url: "https://x" }] },
        "1.0.3": { license: "MIT" },
      },
    },
  });
  try {
    const { getNpmMetadata } = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const pkgList = await getNpmMetadata(
      [
        { name: "big", version: "1.0.0", properties: [] },
        { name: "big", version: "1.0.1", properties: [] },
        { name: "big", version: "1.0.2", properties: [] },
        { name: "big", version: "1.0.3", properties: [] },
      ],
      "http://127.0.0.1:1/",
      { secureMode: false },
    );
    assert.strictEqual(agentGet.callCount, 1);
    assert.strictEqual(pkgList.length, 4);
    for (const p of pkgList) {
      assert.strictEqual(p.homepage, undefined);
      assert.strictEqual(p.repository, undefined);
      assert.ok(p.properties.every((prop) => prop.value.length <= 4096));
    }
    assert.strictEqual(pkgList[0].description, undefined);
    // The version's own one-line description is still used.
    assert.strictEqual(pkgList[1].description, "one line");
    // Neither an oversized licence string nor an oversized legacy licences
    // array is copied, while a version's own short licence still is.
    assert.strictEqual(pkgList[0].license, undefined);
    assert.strictEqual(pkgList[1].license, undefined);
    assert.strictEqual(pkgList[2].license, undefined);
    assert.strictEqual(pkgList[3].license, "MIT");
  } finally {
    if (previousRsDisable === undefined) {
      delete process.env.CDXGEN_RS_DISABLE;
    } else {
      process.env.CDXGEN_RS_DISABLE = previousRsDisable;
    }
  }
});

it("getNpmMetadata ignores another package's document and query-bearing registries", async () => {
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(String(url));
    return {
      statusCode: 200,
      body: {
        name: "evil-pad",
        description: "from another package",
        homepage: "https://evil.example.com",
        license: "WTFPL",
        versions: {},
      },
    };
  });
  try {
    const { getNpmMetadata } = await esmock(
      "./ecosystems.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const pkgList = await getNpmMetadata(
      [
        { group: "", name: "mismatch-pad", version: "1.0.0", properties: [] },
        { group: "@corp", name: "secret", version: "1.0.0", properties: [] },
        {
          group: "@corp2",
          name: "thing",
          version: "1.0.0",
          properties: [
            {
              name: "internal:ResolvedUrl",
              value:
                "https://npm.other.example/?q=/@corp2/thing/-/thing-1.0.0.tgz",
            },
          ],
        },
      ],
      "http://127.0.0.1:2/",
      {
        npmrcConfig: { "@corp:registry": "https://npm.corp.example/?x=" },
        secureMode: false,
      },
    );
    assert.deepStrictEqual(requested, ["http://127.0.0.1:2/mismatch-pad"]);
    assert.strictEqual(pkgList.length, 3);
    for (const p of pkgList) {
      assert.strictEqual(p.license, undefined);
      assert.strictEqual(p.description, undefined);
      assert.strictEqual(p.homepage, undefined);
    }
  } finally {
    if (previousRsDisable === undefined) {
      delete process.env.CDXGEN_RS_DISABLE;
    } else {
      process.env.CDXGEN_RS_DISABLE = previousRsDisable;
    }
  }
});
