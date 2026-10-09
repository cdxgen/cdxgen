import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { describe, test } from "poku";

import { findJSImportsExports } from "../inventory/analyzer.js";
import {
  findDenoJson,
  parseDenoJsonFile,
  parseDenoLock,
  stripJsonc,
} from "./denoutils.js";
import { addEvidenceForImports } from "./utils.js";

const V5_FIXTURE = "./test/data/deno-project/deno.lock";
const V5_PROJECT = "./test/data/deno-project";
const V2_FIXTURE = "./test/data/deno-test.lock.json";

// Collect the unique occurrence locations recorded on a component.
const occurrenceLocations = (pkg) => [
  ...new Set((pkg?.evidence?.occurrences || []).map((o) => o.location)),
];

// Collect the occurrence "location#line" markers recorded on a component.
const occurrenceLines = (pkg) =>
  (pkg?.evidence?.occurrences || []).map(
    (o) => `${o.location}${o.line ? `#${o.line}` : ""}`,
  );

describe("stripJsonc", () => {
  test("strips line and block comments plus trailing commas", () => {
    const src = `{
  // a line comment
  "a": 1, /* a block comment */
  "b": "https://deno.land/x", // url with slashes inside a string
  "c": 2,
}`;
    const parsed = JSON.parse(stripJsonc(src));
    assert.deepStrictEqual(parsed, {
      a: 1,
      b: "https://deno.land/x",
      c: 2,
    });
  });

  test("handles escaped quotes inside strings", () => {
    const src = '{"msg": "say \\"hi\\" // not a comment"}';
    const parsed = JSON.parse(stripJsonc(src));
    assert.strictEqual(parsed.msg, 'say "hi" // not a comment');
  });

  test("passes through empty/blank input", () => {
    assert.strictEqual(stripJsonc(""), "");
  });
});

describe("parseDenoJsonFile / findDenoJson", () => {
  test("parses the fixture deno.json", () => {
    const config = parseDenoJsonFile(join(V5_PROJECT, "deno.json"));
    assert.strictEqual(config.name, "@demo/deno-app");
    assert.strictEqual(config.version, "1.0.0");
    assert.strictEqual(config.exports, "./main.ts");
  });

  test("parses a deno.jsonc (jsonc-tolerant)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-deno-jsonc-"));
    try {
      const jsoncPath = join(dir, "deno.jsonc");
      writeFileSync(
        jsoncPath,
        `{
  // manifest
  "name": "@demo/jsonc-app",
  "version": "2.5.0",
}`,
      );
      const config = parseDenoJsonFile(jsoncPath);
      assert.strictEqual(config.name, "@demo/jsonc-app");
      assert.strictEqual(config.version, "2.5.0");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("returns undefined for a missing file", () => {
    assert.strictEqual(
      parseDenoJsonFile(join(V5_PROJECT, "missing.json")),
      undefined,
    );
  });

  test("findDenoJson prefers deno.json and falls back to deno.jsonc", () => {
    assert.strictEqual(findDenoJson(V5_PROJECT), join(V5_PROJECT, "deno.json"));

    const dir = mkdtempSync(join(tmpdir(), "cdxgen-deno-find-"));
    try {
      const jsoncPath = join(dir, "deno.jsonc");
      writeFileSync(jsoncPath, "{}");
      assert.strictEqual(findDenoJson(dir), jsoncPath);
      assert.strictEqual(findDenoJson(tmpdir()), undefined);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("parseDenoLock", async () => {
  await test("returns empty lists for a missing file", async () => {
    const { pkgList, dependenciesList } = await parseDenoLock(
      "./test/data/deno-project/does-not-exist.lock",
    );
    assert.strictEqual(pkgList.length, 0);
    assert.strictEqual(dependenciesList.length, 0);
  });

  await test("parses the v5 fixture into jsr + npm components", async () => {
    const parentComponent = { "bom-ref": "pkg:npm/@demo/deno-app@1.0.0" };
    const { pkgList, dependenciesList } = await parseDenoLock(V5_FIXTURE, {
      parentComponent,
    });
    // 12 jsr packages + 2 npm packages.
    assert.strictEqual(pkgList.length, 14);
    const byPurl = Object.fromEntries(pkgList.map((p) => [p.purl, p]));

    // jsr package -> pkg:npm/@jsr/<owner>__<name> (dep-scan-friendly). The
    // `@jsr` scope is the purl group/namespace and `<owner>__<name>` is the
    // npm-compat package name, so the purl is a valid two-segment npm purl.
    // The purl keeps the group's `@` URL-encoded (%40jsr); the bom-ref is the
    // decoded form (mirrors how bun/npm packages are keyed).
    const assertPurl = "pkg:npm/%40jsr/std__assert@1.0.19";
    const assertBomRef = "pkg:npm/@jsr/std__assert@1.0.19";
    const assertPkg = pkgList.find(
      (p) => p.group === "@jsr" && p.name === "std__assert",
    );
    assert.ok(assertPkg, "expected an @std/assert component");
    assert.strictEqual(assertPkg.purl, assertPurl);
    assert.strictEqual(assertPkg["bom-ref"], assertBomRef);
    // jsr integrity is raw sha256 hex; normalised to a sha256- prefixed value
    // while the hex payload is preserved verbatim (not base64-re-encoded).
    assert.strictEqual(
      assertPkg._integrity,
      "sha256-eaada96ee120cb980bc47e040f82814d786fe8162ecc53c91d8df60b8755991e",
    );
    // jsr components carry a deterministic canonical jsr.io website reference
    // (the npm-mirror tarball is only known after a registry lookup).
    assert.ok(
      assertPkg.externalReferences.some(
        (ref) =>
          ref.type === "website" &&
          ref.url === "https://jsr.io/@std/assert@1.0.19",
      ),
      "expected a jsr.io website external reference",
    );
    // Original jsr identity is preserved for traceability.
    const jsrKeyProp = assertPkg.properties.find(
      (p) => p.name === "cdx:deno:jsrKey",
    );
    assert.ok(jsrKeyProp, "expected a cdx:deno:jsrKey property");
    assert.strictEqual(jsrKeyProp.value, "@std/assert@1.0.19");

    // npm package -> pkg:npm/<name> with sha512 integrity + distribution ref.
    const chalkPurl = "pkg:npm/chalk@5.6.2";
    const chalkPkg = byPurl[chalkPurl];
    assert.ok(chalkPkg, "expected a chalk component");
    assert.ok(chalkPkg._integrity.startsWith("sha512-"));
    assert.ok(
      chalkPkg.externalReferences.some(
        (ref) =>
          ref.type === "distribution" &&
          ref.url === "https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz",
      ),
      "chalk should carry a registry tarball distribution reference",
    );

    // Dependency graph: @std/http depends on the other @std packages, and
    // @std/assert depends on @std/internal. The parent is wired to its direct
    // workspace dependencies.
    const httpEntry = dependenciesList.find(
      (d) => d.ref === "pkg:npm/@jsr/std__http@1.1.2",
    );
    assert.ok(httpEntry, "expected an @std/http dependency entry");
    assert.ok(
      httpEntry.dependsOn.length >= 9,
      `expected @std/http to depend on >=9 packages, got ${httpEntry.dependsOn.length}`,
    );
    const assertEntry = dependenciesList.find(
      (d) => d.ref === "pkg:npm/@jsr/std__assert@1.0.19",
    );
    assert.ok(assertEntry, "expected an @std/assert dependency entry");
    assert.ok(
      assertEntry.dependsOn.includes("pkg:npm/@jsr/std__internal@1.0.14"),
      "expected @std/assert -> @std/internal edge",
    );
    // Every component must appear in the dependency graph, including leaf jsr
    // packages that have no dependencies of their own (regression guard).
    const cliEntry = dependenciesList.find(
      (d) => d.ref === "pkg:npm/@jsr/std__cli@1.0.32",
    );
    assert.ok(cliEntry, "expected leaf @std/cli to appear in the graph");
    assert.strictEqual(cliEntry.dependsOn.length, 0);
    for (const p of pkgList) {
      assert.ok(
        dependenciesList.some((d) => d.ref === p["bom-ref"]),
        `component ${p["bom-ref"]} missing from the dependency graph`,
      );
    }
    const parentEntry = dependenciesList.find(
      (d) => d.ref === "pkg:npm/@demo/deno-app@1.0.0",
    );
    assert.ok(parentEntry, "expected a parent dependency entry");
    // assert, http, chalk, lodash are the 4 direct workspace deps.
    assert.strictEqual(parentEntry.dependsOn.length, 4);
  });

  await test("parses the v2 fixture (nested npm.packages) with integrity and edges", async () => {
    const parentComponent = { "bom-ref": "pkg:npm/demo@1.0.0" };
    const { pkgList, dependenciesList } = await parseDenoLock(V2_FIXTURE, {
      parentComponent,
    });
    // The stale fixture is a real cdxgen 9.x install with >100 packages.
    assert.ok(
      pkgList.length > 100,
      `expected many v2 packages, got ${pkgList.length}`,
    );
    const atomPkg = pkgList.find(
      (p) => p.group === "@appthreat" && p.name === "atom",
    );
    assert.ok(atomPkg, "expected @appthreat/atom in the v2 fixture");
    assert.strictEqual(atomPkg.version, "0.10.1");
    assert.ok(
      atomPkg._integrity.startsWith("sha512-"),
      "v2 npm integrity should be sha512- SRI",
    );
    // v2 nested packages carry explicit dependency maps -> many edges.
    const edgesWithDeps = dependenciesList.filter((d) => d.dependsOn.length);
    assert.ok(
      edgesWithDeps.length > 10,
      `expected many v2 edges with deps, got ${edgesWithDeps.length}`,
    );
    // Parent wired to the top-level specifier (@cyclonedx/cdxgen@9.0.1).
    const parentEntry = dependenciesList.find(
      (d) => d.ref === "pkg:npm/demo@1.0.0",
    );
    assert.ok(parentEntry, "expected a parent dependency entry for v2");
    assert.ok(
      parentEntry.dependsOn.includes("pkg:npm/@cyclonedx/cdxgen@9.0.1"),
      "expected parent -> @cyclonedx/cdxgen edge",
    );
  });
});

describe("occurrence evidence for deno and jsr imports", async () => {
  await test("attaches occurrences to jsr and npm components from source imports", async () => {
    // The fixture's main.ts imports @std/assert, @std/http/file-server (jsr)
    // and chalk, lodash (npm).
    const { pkgList } = await parseDenoLock(V5_FIXTURE, {
      parentComponent: { "bom-ref": "pkg:npm/@demo/deno-app@1.0.0" },
    });
    const { allImports, allExports } = await findJSImportsExports(
      V5_PROJECT,
      false,
    );
    await addEvidenceForImports(pkgList, allImports, allExports, false);

    const byName = Object.fromEntries(pkgList.map((p) => [p.name, p]));

    // jsr imports: the source uses the original `@std/...` specifier even
    // though the component is published under the `@jsr` npm-compat scope.
    assert.deepStrictEqual(occurrenceLocations(byName["std__assert"]), [
      "main.ts",
    ]);
    assert.strictEqual(byName["std__assert"].scope, "required");
    // A jsr subpath import (@std/http/file-server) must still resolve to the
    // owning @std/http component.
    assert.deepStrictEqual(occurrenceLocations(byName["std__http"]), [
      "main.ts",
    ]);

    // npm imports continue to resolve as before.
    assert.deepStrictEqual(occurrenceLocations(byName["chalk"]), ["main.ts"]);
    assert.deepStrictEqual(occurrenceLocations(byName["lodash"]), ["main.ts"]);

    // Transitive-only jsr packages that are never imported in source get no
    // occurrence evidence.
    assert.strictEqual(occurrenceLocations(byName["std__internal"]).length, 0);
  });

  await test("records use sites of imported bindings, not just import lines", async () => {
    const { pkgList } = await parseDenoLock(V5_FIXTURE, {
      parentComponent: { "bom-ref": "pkg:npm/@demo/deno-app@1.0.0" },
    });
    const { allImports, allExports } = await findJSImportsExports(
      V5_PROJECT,
      false,
    );
    await addEvidenceForImports(pkgList, allImports, allExports, false);
    const byName = Object.fromEntries(pkgList.map((p) => [p.name, p]));

    // chalk is imported on line 3 and its `green` method is called on line 6:
    // both the import site and the call site are recorded as occurrences.
    assert.deepStrictEqual(occurrenceLines(byName["chalk"]).sort(), [
      "main.ts#3",
      "main.ts#6",
    ]);

    // The jsr `assert` binding is invoked directly (assert(true)) on line 9,
    // which is tracked as an additional use site alongside the import.
    assert.deepStrictEqual(occurrenceLines(byName["std__assert"]).sort(), [
      "main.ts#1",
      "main.ts#9",
    ]);

    // fileServer is only referenced (typeof), never called, so only the import
    // site is recorded.
    assert.deepStrictEqual(occurrenceLines(byName["std__http"]), ["main.ts#2"]);
  });
});

describe("offline metadata mining from node_modules", async () => {
  // Build a throwaway project with a v5 deno.lock and a node_modules tree
  // containing minimal package.json manifests for an npm and a jsr package.
  const setupProject = () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-deno-nm-"));
    writeFileSync(
      join(dir, "deno.lock"),
      JSON.stringify({
        version: "5",
        specifiers: {
          "jsr:@std/assert@1": "1.0.19",
          "npm:chalk@^5": "5.6.2",
          "npm:fuzzy@0.1.3": "0.1.3",
        },
        jsr: { "@std/assert@1.0.19": { integrity: "abcd" } },
        npm: {
          "chalk@5.6.2": { integrity: "sha512-deadbeef" },
          "fuzzy@0.1.3": { integrity: "sha512-feedface" },
        },
        workspace: {
          dependencies: [
            "jsr:@std/assert@1",
            "npm:chalk@^5",
            "npm:fuzzy@0.1.3",
          ],
        },
      }),
    );
    const writeManifest = (relDir, manifest) => {
      const pkgDir = join(dir, "node_modules", relDir);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest));
    };
    writeManifest("chalk", {
      name: "chalk",
      version: "5.6.2",
      license: "MIT",
      description: "Terminal string styling done right",
      repository: { url: "git+https://github.com/chalk/chalk.git" },
    });
    // Issue 4466: a manifest that still declares the legacy licenses array.
    writeManifest("fuzzy", {
      name: "fuzzy",
      version: "0.1.3",
      license: "",
      licenses: [{ type: "MIT" }, { type: "Apache-2.0" }],
    });
    // jsr packages materialise under their @jsr npm-compat name.
    writeManifest(join("@jsr", "std__assert"), {
      name: "@jsr/std__assert",
      version: "1.0.19",
      license: "MIT",
      description: "Common assertion functions",
    });
    return dir;
  };

  await test("enriches npm and jsr components from node_modules without network", async () => {
    const dir = setupProject();
    try {
      const { pkgList } = await parseDenoLock(join(dir, "deno.lock"), {
        projectRoot: dir,
      });
      const chalk = pkgList.find((p) => p.name === "chalk");
      // license/description are mined offline (raw string; normalised later in
      // the pipeline) and the repository becomes a vcs external reference.
      assert.strictEqual(chalk.license, "MIT");
      assert.strictEqual(
        chalk.description,
        "Terminal string styling done right",
      );
      assert.ok(
        chalk.externalReferences.some(
          (ref) =>
            ref.type === "vcs" &&
            ref.url === "git+https://github.com/chalk/chalk.git",
        ),
        "expected a vcs external reference mined from package.json",
      );

      // jsr packages resolve under their @jsr npm-compat directory.
      const stdAssert = pkgList.find((p) => p.name === "std__assert");
      assert.strictEqual(stdAssert.license, "MIT");
      assert.strictEqual(stdAssert.description, "Common assertion functions");

      // An empty modern field defers to the legacy array, whose two entries
      // npm documents as a choice between them.
      const fuzzy = pkgList.find((p) => p.name === "fuzzy");
      assert.strictEqual(fuzzy.license, "MIT OR Apache-2.0");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("jsr metadata API", async () => {
  await test("fetches license, description and repository from api.jsr.io", async () => {
    // Mock the shared HTTP client so the test is hermetic (no network).
    const requestedUrls = [];
    const fakeAgent = {
      get: async (url) => {
        requestedUrls.push(url);
        if (url.endsWith("/versions/1.0.19")) {
          return { body: { license: "MIT" } };
        }
        return {
          body: {
            description: "Common assertion functions",
            githubRepository: { owner: "denoland", name: "std" },
          },
        };
      },
    };
    // The agent mock is in-process, so it cannot observe requests made by the
    // cdxrs subprocess. Disable the prefetch to keep this test on the JS loop;
    // the jsr prefetch path is covered by contrib/fetch-parity-test.js.
    const { getJsrMetadata } = await esmock("./denoutils.js", {
      "../core/activity.js": { cdxgenAgent: fakeAgent },
      "../inventory/fetchBatch.js": { prefetchEnabled: () => false },
    });
    const component = {
      name: "std__assert",
      group: "@jsr",
      version: "1.0.19",
      properties: [{ name: "cdx:deno:jsrKey", value: "@std/assert@1.0.19" }],
    };
    await getJsrMetadata([component]);

    assert.strictEqual(component.license, "MIT");
    assert.strictEqual(component.description, "Common assertion functions");
    assert.ok(
      component.externalReferences.some(
        (ref) =>
          ref.type === "vcs" && ref.url === "https://github.com/denoland/std",
      ),
      "expected a github vcs external reference from the jsr API",
    );
    // The original jsr scope/name/version drive the api.jsr.io paths.
    assert.ok(
      requestedUrls.includes(
        "https://api.jsr.io/scopes/std/packages/assert/versions/1.0.19",
      ),
    );
    assert.ok(
      requestedUrls.includes("https://api.jsr.io/scopes/std/packages/assert"),
    );
  });
});
