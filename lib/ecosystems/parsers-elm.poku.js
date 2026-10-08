import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import {
  clearHttpInterceptor,
  setHttpInterceptor,
} from "../core/httpClient.js";
import {
  getElmMetadata,
  isElmProjectFile,
  isRegistryCrawlable,
  parseElmProject,
  parseLegacyElmProject,
} from "./parsers-elm.js";

const NO_CACHE = { readMetadata: () => null, listVersions: () => [] };

describe("parseElmProject — application", () => {
  it("pins exact versions and separates direct, indirect, and test scopes", () => {
    const { pkgList, parentComponent, rootInputs } = parseElmProject(
      "./test/data/elm-smoke/elm.json",
      NO_CACHE,
    );
    assert.strictEqual(parentComponent.type, "application");
    assert.strictEqual(parentComponent.name, "elm-smoke");
    assert.strictEqual(
      parentComponent.properties.find((p) => p.name === "cdx:elm:elmVersion")
        .value,
      "0.19.1",
    );

    assert.strictEqual(pkgList.length, 14);

    const http = pkgList.find((p) => p.name === "http");
    assert.strictEqual(http.group, "elm");
    assert.strictEqual(http.version, "1.0.0");
    assert.strictEqual(http.purl, "pkg:generic/elm/http@1.0.0");
    assert.strictEqual(http.scope, "required");
    assert.strictEqual(
      http.properties.find((p) => p.name === "cdx:purl:proposedType").value,
      "elm",
    );
    assert.strictEqual(
      http.properties.find((p) => p.name === "cdx:elm:dependency").value,
      "direct",
    );

    // Namespaced author names keep the author in the group and the purl.
    const decodePipeline = pkgList.find(
      (p) => p.name === "elm-json-decode-pipeline",
    );
    assert.strictEqual(decodePipeline.group, "NoRedInk");
    assert.strictEqual(
      decodePipeline.purl,
      "pkg:generic/NoRedInk/elm-json-decode-pipeline@1.0.0",
    );

    const parser = pkgList.find((p) => p.name === "parser");
    assert.strictEqual(
      parser.properties.find((p) => p.name === "cdx:elm:dependency").value,
      "indirect",
    );

    // Test dependencies are optional and carry their own origin labels.
    const test = pkgList.find((p) => p.name === "test");
    assert.strictEqual(test.scope, "optional");
    assert.strictEqual(
      test.properties.find((p) => p.name === "cdx:elm:dependency").value,
      "direct-test",
    );
    const random = pkgList.find((p) => p.name === "random");
    assert.strictEqual(random.scope, "optional");
    assert.strictEqual(
      random.properties.find((p) => p.name === "cdx:elm:dependency").value,
      "indirect-test",
    );

    // The root links the declared set: direct plus test-direct.
    assert.strictEqual(rootInputs.length, 11);
  });

  it("keeps every component in the dependency graph", () => {
    const { pkgList, dependencies } = parseElmProject(
      "./test/data/elm-smoke/elm.json",
      NO_CACHE,
    );
    assert.strictEqual(dependencies.length, pkgList.length);
    // Without a cache no edges are known, but nothing dangles either.
    for (const entry of dependencies) {
      assert.deepStrictEqual(entry.dependsOn, []);
    }
    assert.deepStrictEqual(
      dependencies.map((d) => d.ref).sort(),
      pkgList.map((p) => p["bom-ref"]).sort(),
    );
  });

  it("resolves transitive edges from the cached package manifests", () => {
    const cache = {
      readMetadata: (name) =>
        name === "elm/html"
          ? {
              dependencies: {
                "elm/core": "1.0.0 <= v < 2.0.0",
                "elm/virtual-dom": "1.0.0 <= v < 2.0.0",
                // Not part of this application's resolved set.
                "elm/absent": "1.0.0 <= v < 2.0.0",
              },
            }
          : null,
      listVersions: () => [],
    };
    const { dependencies } = parseElmProject(
      "./test/data/elm-smoke/elm.json",
      cache,
    );
    const html = dependencies.find(
      (d) => d.ref === "pkg:generic/elm/html@1.0.0",
    );
    assert.deepStrictEqual(html.dependsOn, [
      "pkg:generic/elm/core@1.0.0",
      "pkg:generic/elm/virtual-dom@1.0.0",
    ]);
  });
});

describe("parseElmProject — package", () => {
  it("carries the package identity and keeps declared ranges without a cache", () => {
    const { pkgList, parentComponent, rootInputs } = parseElmProject(
      "./test/data/elm-package-smoke/elm.json",
      NO_CACHE,
    );
    assert.strictEqual(parentComponent.group, "elm");
    assert.strictEqual(parentComponent.name, "http");
    assert.strictEqual(parentComponent.version, "2.0.0");
    assert.strictEqual(parentComponent.license, "BSD-3-Clause");
    assert.strictEqual(parentComponent.description, "Make HTTP requests");
    assert.strictEqual(
      parentComponent.properties.find((p) => p.name === "cdx:elm:elmVersion")
        .value,
      "0.19.0 <= v < 0.20.0",
    );

    assert.strictEqual(pkgList.length, 4);
    const bytes = pkgList.find((p) => p.name === "bytes");
    assert.strictEqual(bytes.version, undefined);
    assert.strictEqual(bytes.purl, "pkg:generic/elm/bytes");
    assert.strictEqual(
      bytes.properties.find((p) => p.name === "cdx:elm:versionRange").value,
      "1.0.0 <= v < 2.0.0",
    );
    assert.strictEqual(rootInputs.length, 4);
  });

  it("resolves the newest cached version inside the declared range", () => {
    const cache = {
      readMetadata: () => ({
        license: "BSD-3-Clause",
        summary: "Elm bytes",
      }),
      listVersions: (name) => (name === "elm/bytes" ? ["1.0.0", "1.5.0"] : []),
    };
    const { pkgList } = parseElmProject(
      "./test/data/elm-package-smoke/elm.json",
      cache,
    );
    const bytes = pkgList.find((p) => p.name === "bytes");
    assert.strictEqual(bytes.version, "1.5.0");
    assert.strictEqual(bytes.license, "BSD-3-Clause");
    assert.strictEqual(bytes.description, "Elm bytes");
    // The declared constraint stays visible next to the resolved version.
    assert.strictEqual(
      bytes.properties.find((p) => p.name === "cdx:elm:versionRange").value,
      "1.0.0 <= v < 2.0.0",
    );
  });

  it("ignores cached versions outside the declared range", () => {
    const cache = {
      readMetadata: () => null,
      listVersions: (name) => (name === "elm/bytes" ? ["2.0.0"] : []),
    };
    const { pkgList } = parseElmProject(
      "./test/data/elm-package-smoke/elm.json",
      cache,
    );
    const bytes = pkgList.find((p) => p.name === "bytes");
    assert.strictEqual(bytes.version, undefined);
  });
});

describe("parseElmProject — enrichment from ELM_HOME", () => {
  it("reads license and summary from the compiler cache layout", () => {
    const home = mkdtempSync(join(tmpdir(), "elm-home-"));
    const previous = process.env.ELM_HOME;
    process.env.ELM_HOME = home;
    try {
      const pkgDir = join(home, "0.19.1", "packages", "elm", "http", "1.0.0");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "elm.json"),
        JSON.stringify({
          type: "package",
          name: "elm/http",
          summary: "Make HTTP requests",
          license: "BSD-3-Clause",
          version: "1.0.0",
        }),
      );
      const { pkgList } = parseElmProject("./test/data/elm-smoke/elm.json");
      const http = pkgList.find((p) => p.name === "http");
      assert.strictEqual(http.license, "BSD-3-Clause");
      assert.strictEqual(http.description, "Make HTTP requests");
    } finally {
      if (previous === undefined) {
        delete process.env.ELM_HOME;
      } else {
        process.env.ELM_HOME = previous;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("parseLegacyElmProject — 0.18", () => {
  it("prefers the exact-dependencies lock and marks undeclared packages indirect", () => {
    const { pkgList, parentComponent, rootInputs } = parseLegacyElmProject(
      "./test/data/elm-smoke-18/elm-package.json",
      "./test/data/elm-smoke-18/elm-stuff/exact-dependencies.json",
    );
    assert.strictEqual(parentComponent.name, "elm-smoke-18");
    assert.strictEqual(parentComponent.version, "1.0.0");
    assert.strictEqual(
      parentComponent.properties.find((p) => p.name === "cdx:elm:elmVersion")
        .value,
      "0.18.0 <= v < 0.19.0",
    );

    assert.strictEqual(pkgList.length, 4);
    const core = pkgList.find((p) => p.name === "core");
    assert.strictEqual(core.group, "elm-lang");
    assert.strictEqual(core.version, "5.1.1");
    assert.strictEqual(core.purl, "pkg:generic/elm-lang/core@5.1.1");
    // The lock contains elm-lang/virtual-dom, which the manifest never
    // declared: it is transitive.
    const virtualDom = pkgList.find((p) => p.name === "virtual-dom");
    assert.strictEqual(
      virtualDom.properties.find((p) => p.name === "cdx:elm:dependency").value,
      "indirect",
    );
    assert.strictEqual(rootInputs.length, 3);
  });

  it("falls back to declared ranges without a lock", () => {
    const { pkgList, rootInputs } = parseLegacyElmProject(
      "./test/data/elm-smoke-18/elm-package.json",
      undefined,
    );
    assert.strictEqual(pkgList.length, 3);
    const core = pkgList.find((p) => p.name === "core");
    assert.strictEqual(core.version, undefined);
    assert.strictEqual(
      core.properties.find((p) => p.name === "cdx:elm:versionRange").value,
      "5.0.0 <= v < 6.0.0",
    );
    assert.strictEqual(rootInputs.length, 3);
  });
});

describe("registry enrichment", () => {
  const BASE = "https://package.elm-lang.org/packages/elm/http/2.0.0";

  /**
   * Serve the registry from memory through cdxgen's single network seam,
   * recording every request the enrichment makes.
   *
   * The seam is process-global, so the scenarios below share one installation
   * and run in sequence inside a single test rather than as separate cases
   * that would race each other for it.
   */
  async function withRegistry(documents, run) {
    const requests = [];
    setHttpInterceptor(async (req) => {
      const url = req.url.toString();
      requests.push({ url, headers: req.headers || {} });
      const body = documents[url];
      if (!body) {
        const err = new Error("Request failed with status code 404");
        err.statusCode = 404;
        throw err;
      }
      return {
        statusCode: 200,
        headers: {},
        body,
        url,
        request: { options: req.options },
      };
    });
    // Replay mode pins every request to the seam, exactly as the golden
    // harness does: it keeps the reordering batch pool and the out-of-process
    // Rust transport out of the way, either of which would let a request reach
    // the live registry unnoticed.
    process.env.CDXGEN_CASSETTE_REPLAY = "true";
    try {
      return await run(requests);
    } finally {
      clearHttpInterceptor();
      delete process.env.CDXGEN_CASSETTE_REPLAY;
    }
  }

  it("reads the published manifest and archive endpoint", async () => {
    const documents = {
      [`${BASE}/elm.json`]: {
        type: "package",
        name: "elm/http",
        summary: "Make HTTP requests",
        license: "BSD-3-Clause",
        version: "2.0.0",
        dependencies: { "elm/core": "1.0.0 <= v < 2.0.0" },
      },
      [`${BASE}/endpoint.json`]: {
        url: "https://github.com/elm/http/zipball/2.0.0/",
        hash: "83CB7ECB6800E55E3728C756AAC451881E55C40A",
      },
    };

    // 1. Summary, license, distribution and digest reach the component.
    await withRegistry(documents, async (requests) => {
      const pkgList = [
        { group: "elm", name: "http", version: "2.0.0", "bom-ref": "http-ref" },
      ];
      await getElmMetadata(pkgList);
      const [http] = pkgList;
      assert.strictEqual(requests.length, 2, "both documents were requested");
      assert.strictEqual(http.license, "BSD-3-Clause");
      assert.strictEqual(http.description, "Make HTTP requests");
      assert.deepStrictEqual(http.distribution, {
        url: "https://github.com/elm/http/zipball/2.0.0/",
      });
      // The registry publishes the digest the compiler checks the downloaded
      // archive against, in whatever case; CycloneDX wants lower-case hex.
      assert.deepStrictEqual(http.hashes, [
        { alg: "SHA-1", content: "83cb7ecb6800e55e3728c756aac451881e55c40a" },
      ]);
      // Every request identifies cdxgen and offers a contact route.
      for (const request of requests) {
        const ua = request.headers["user-agent"];
        assert.ok(ua?.startsWith("cdxgen/"), `unidentified request: ${ua}`);
      }
    });

    // 2. Edges the local cache could not describe are completed; ones it
    //    already resolved are left alone.
    await withRegistry(documents, async () => {
      const pkgList = [
        { group: "elm", name: "http", version: "2.0.0", "bom-ref": "http-ref" },
        { group: "elm", name: "core", version: "1.0.5", "bom-ref": "core-ref" },
      ];
      const dependencies = [
        { ref: "http-ref", dependsOn: [] },
        { ref: "core-ref", dependsOn: ["already-known"] },
      ];
      await getElmMetadata(pkgList, dependencies);
      assert.deepStrictEqual(dependencies[0].dependsOn, ["core-ref"]);
      assert.deepStrictEqual(dependencies[1].dependsOn, ["already-known"]);
    });

    // 3. Packages the registry's robots.txt disallows are never requested.
    await withRegistry({}, async (requests) => {
      const pkgList = [
        {
          group: "elm-lang",
          name: "core",
          version: "5.1.1",
          "bom-ref": "legacy-ref",
        },
        {
          group: "evancz",
          name: "elm-html",
          version: "4.0.2",
          "bom-ref": "legacy-html-ref",
        },
      ];
      await getElmMetadata(pkgList);
      assert.deepStrictEqual(requests, []);
    });

    // 4. A registry that answers 404 leaves the component as parsed.
    await withRegistry({}, async (requests) => {
      const pkgList = [
        { group: "elm", name: "http", version: "2.0.0", "bom-ref": "http-ref" },
      ];
      await getElmMetadata(pkgList);
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(pkgList[0].license, undefined);
      assert.strictEqual(pkgList[0].hashes, undefined);
    });

    // 5. Only the document whose field is still missing is requested. A
    //    component the local cache filled completely is not asked about at
    //    all.
    const complete = (name, ref) => ({
      "bom-ref": ref,
      description: `${name} from the local cache`,
      distribution: { url: `https://mirror.example/${name}.tgz` },
      group: "elm",
      hashes: [{ alg: "SHA-1", content: "f".repeat(40) }],
      license: "BSD-3-Clause",
      name,
      version: "2.0.0",
    });
    await withRegistry(
      {
        "https://package.elm-lang.org/packages/elm/core/2.0.0/elm.json": {
          license: "MIT",
          summary: "core from the registry",
        },
        "https://package.elm-lang.org/packages/elm/url/2.0.0/endpoint.json": {
          hash: "83CB7ECB6800E55E3728C756AAC451881E55C40A",
          url: "https://github.com/elm/url/zipball/2.0.0/",
        },
      },
      async (requests) => {
        const http = complete("http", "http-ref");
        // core has every field but the licence, which only the manifest
        // supplies; url has every field but the distribution and the hash,
        // which only the endpoint supplies.
        const core = complete("core", "core-ref");
        delete core.license;
        const url = complete("url", "url-ref");
        delete url.distribution;
        delete url.hashes;
        const pkgList = [http, core, url];
        const dependencies = pkgList.map((pkg) => ({
          ref: pkg["bom-ref"],
          dependsOn: ["already-known"],
        }));
        await getElmMetadata(pkgList, dependencies);
        assert.deepStrictEqual(
          requests.map((request) => request.url).sort(),
          [
            "https://package.elm-lang.org/packages/elm/core/2.0.0/elm.json",
            "https://package.elm-lang.org/packages/elm/url/2.0.0/endpoint.json",
          ],
        );
        // The filled component kept every local field untouched.
        assert.strictEqual(http.description, "http from the local cache");
        assert.deepStrictEqual(http.distribution, {
          url: "https://mirror.example/http.tgz",
        });
        // The missing fields came from the one document each that answers
        // them.
        assert.strictEqual(core.license, "MIT");
        assert.strictEqual(core.description, "core from the local cache");
        assert.deepStrictEqual(url.distribution, {
          url: "https://github.com/elm/url/zipball/2.0.0/",
        });
        assert.deepStrictEqual(url.hashes, [
          { alg: "SHA-1", content: "83cb7ecb6800e55e3728c756aac451881e55c40a" },
        ]);
      },
    );

    // 6. When registry provenance is wanted, as under --bom-audit, both
    //    documents are requested even for the component the local cache
    //    filled, and its own fields survive the round.
    const previousProvenance = process.env.CDXGEN_FETCH_PKG_METADATA;
    process.env.CDXGEN_FETCH_PKG_METADATA = "true";
    try {
      await withRegistry(
        {
          "https://package.elm-lang.org/packages/elm/time/2.0.0/elm.json": {
            license: "MIT",
            summary: "time from the registry",
          },
          "https://package.elm-lang.org/packages/elm/time/2.0.0/endpoint.json": {
            hash: "83CB7ECB6800E55E3728C756AAC451881E55C40A",
            url: "https://github.com/elm/time/zipball/2.0.0/",
          },
        },
        async (requests) => {
          // A package no earlier case fetched, so the in-run response
          // cache cannot answer for the registry.
          const time = complete("time", "time-ref");
          await getElmMetadata([time]);
          assert.strictEqual(requests.length, 2);
          // Its own fields survive the round.
          assert.strictEqual(time.license, "BSD-3-Clause");
          assert.strictEqual(time.description, "time from the local cache");
        },
      );
    } finally {
      if (previousProvenance === undefined) {
        delete process.env.CDXGEN_FETCH_PKG_METADATA;
      } else {
        process.env.CDXGEN_FETCH_PKG_METADATA = previousProvenance;
      }
    }
  });

  it("agrees with the published robots.txt rules", () => {
    assert.strictEqual(isRegistryCrawlable("elm/http"), true);
    assert.strictEqual(isRegistryCrawlable("elm-lang/core"), false);
    assert.strictEqual(isRegistryCrawlable("elm-community/elm-test"), false);
    // Only the one disallowed elm-community package, not the whole author.
    assert.strictEqual(isRegistryCrawlable("elm-community/list-extra"), true);
  });
});

describe("isElmProjectFile", () => {
  it("recognises elm manifests and rejects unrelated JSON", () => {
    assert.strictEqual(
      isElmProjectFile("./test/data/elm-smoke/elm.json"),
      true,
    );
    assert.strictEqual(
      isElmProjectFile("./test/data/elm-package-smoke/elm.json"),
      true,
    );
    assert.strictEqual(isElmProjectFile("./package.json"), false);
  });
});

describe("malformed names", () => {
  it("emits the component without a namespace or cache lookup", () => {
    const cache = {
      readMetadata: () => {
        throw new Error("must not be called");
      },
      listVersions: () => {
        throw new Error("must not be called");
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "elm-bad-"));
    try {
      const manifest = join(dir, "elm.json");
      writeFileSync(
        manifest,
        JSON.stringify({
          type: "application",
          "elm-version": "0.19.1",
          dependencies: {
            direct: { "../escape": "1.0.0", plain: "1.0.0" },
            indirect: {},
          },
          "test-dependencies": { direct: {}, indirect: {} },
        }),
      );
      const { pkgList } = parseElmProject(manifest, cache);
      const traversal = pkgList.find((p) => p.name === "../escape");
      assert.ok(traversal, "the component is still emitted");
      assert.strictEqual(traversal.group, undefined);
      // cdx-purl percent-encodes names that are not clean segments; the
      // traversal-shaped name never reaches a filesystem path either way.
      assert.strictEqual(traversal.purl, "pkg:generic/..%2Fescape@1.0.0");
      const plain = pkgList.find((p) => p.name === "plain");
      assert.strictEqual(plain.group, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
