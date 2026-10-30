import { strict as assert, describe, test } from "poku";

import { parseBunDescriptor, parseBunLock } from "./bunutils.js";

const FIXTURE = "./test/data/bun/bun.lock";

// Every fixture in test/data/bun is a real lockfile produced by running the
// matching bun binary against the committed package.json - the `-v1` twins
// were generated with bun 1.2.0 (lockfileVersion 1, the Zig implementation)
// and the others with bun 1.4.x (lockfileVersion 2, the Rust one).

const hasProp = (pkg, name, value = "true") =>
  pkg.properties.some((prop) => prop.name === name && prop.value === value);

describe("parseBunDescriptor", async () => {
  await test("parses an unscoped descriptor", () => {
    assert.deepStrictEqual(parseBunDescriptor("left-pad@1.3.0"), {
      group: "",
      name: "left-pad",
      version: "1.3.0",
    });
  });

  await test("parses a scoped descriptor", () => {
    assert.deepStrictEqual(parseBunDescriptor("@babel/parser@7.29.9"), {
      group: "@babel",
      name: "parser",
      version: "7.29.9",
    });
  });

  await test("preserves git specifiers as the version", () => {
    const parsed = parseBunDescriptor(
      "foo@git+https://github.com/foo/bar#abcdef",
    );
    assert.deepStrictEqual(parsed.group, "");
    assert.deepStrictEqual(parsed.name, "foo");
    assert.deepStrictEqual(
      parsed.version,
      "git+https://github.com/foo/bar#abcdef",
    );
  });
});

describe("parseBunLock", async () => {
  await test("returns empty lists for a missing file", async () => {
    const { pkgList, dependenciesList } = await parseBunLock(
      "./test/data/bun/does-not-exist.lock",
    );
    assert.deepStrictEqual(pkgList.length, 0);
    assert.deepStrictEqual(dependenciesList.length, 0);
  });

  // Generated with bun 1.2.0 (lockfileVersion 1): 13 registry packages
  // including a scoped dependency tree, string and object `bin` entries, the
  // single-string `os` form, a dev and an optional root dependency.
  await test("parses the v1 fixture lockfile", async () => {
    const { pkgList, dependenciesList } = await parseBunLock(FIXTURE);
    // 13 packages in the fixture.
    assert.deepStrictEqual(pkgList.length, 13);
    assert.deepStrictEqual(dependenciesList.length, 13);

    const byName = Object.fromEntries(pkgList.map((p) => [p.name, p]));

    // Scoped registry package: purl + bom-ref + integrity + distribution ref.
    const generator = byName.generator;
    assert.deepStrictEqual(generator.group, "@babel");
    assert.deepStrictEqual(generator.version, "7.26.5");
    assert.deepStrictEqual(generator.purl, "pkg:npm/%40babel/generator@7.26.5");
    assert.deepStrictEqual(
      generator["bom-ref"],
      "pkg:npm/@babel/generator@7.26.5",
    );
    assert.ok(generator._integrity.startsWith("sha512-"));
    assert.ok(
      generator.externalReferences.some(
        (ref) =>
          ref.type === "distribution" &&
          ref.url ===
            "https://registry.npmjs.org/@babel/generator/-/generator-7.26.5.tgz",
      ),
    );

    // Dependency graph: the scoped tree resolves through the walk-up.
    const generatorDeps = dependenciesList.find(
      (d) => d.ref === "pkg:npm/@babel/generator@7.26.5",
    );
    assert.deepStrictEqual(generatorDeps.dependsOn, [
      "pkg:npm/@babel/parser@7.29.9",
      "pkg:npm/@babel/types@7.29.8",
      "pkg:npm/@jridgewell/gen-mapping@0.3.13",
      "pkg:npm/@jridgewell/trace-mapping@0.3.31",
      "pkg:npm/jsesc@3.1.0",
    ]);

    // Both `bin` shapes are recorded: a plain string (@babel/parser) and a
    // map of commands (typescript).
    const parserBin = byName.parser.properties.find(
      (p) => p.name === "cdx:npm:bin",
    );
    assert.deepStrictEqual(parserBin.value, "./bin/babel-parser.js");
    const tsBin = byName.typescript.properties.find(
      (p) => p.name === "cdx:npm:bin",
    );
    assert.deepStrictEqual(tsBin.value, "tsc, tsserver");

    // left-pad is a plain production dependency (no optional scope).
    assert.deepStrictEqual(byName["left-pad"].scope, undefined);

    // typescript is a devDependency: scoped optional + development property.
    const ts = byName.typescript;
    assert.deepStrictEqual(ts.scope, "optional");
    assert.ok(
      ts.properties.some((prop) => prop.name === "cdx:npm:package:development"),
    );

    // fsevents is an optionalDependency written with the single-string `os`
    // form bun uses for one-value cases.
    const fsevents = byName.fsevents;
    assert.deepStrictEqual(fsevents.scope, "optional");
    assert.ok(
      fsevents.properties.some(
        (prop) => prop.name === "cdx:npm:package:optional",
      ),
    );
    assert.ok(
      fsevents.properties.some(
        (prop) => prop.name === "cdx:npm:os" && prop.value === "darwin",
      ),
    );

    // Every component carries the SrcFile property and manifest-analysis
    // evidence pointing at the lockfile.
    for (const pkg of pkgList) {
      assert.ok(
        pkg.properties.some(
          (prop) => prop.name === "internal:SrcFile" && prop.value === FIXTURE,
        ),
      );
      assert.deepStrictEqual(
        pkg.evidence.identity.methods[0].technique,
        "manifest-analysis",
      );
    }
  });

  await test("adds the root dependency entry when a parent component is given", async () => {
    const parentComponent = {
      name: "bun-fixture",
      version: "1.0.0",
      "bom-ref": "pkg:npm/bun-fixture@1.0.0",
    };
    const { pkgList, dependenciesList } = await parseBunLock(FIXTURE, {
      parentComponent,
    });
    const rootDeps = dependenciesList.find(
      (d) => d.ref === "pkg:npm/bun-fixture@1.0.0",
    );
    assert.ok(rootDeps);
    // Every declared dependency is an edge of the root, the devDependency
    // included (as the npm and pnpm parsers do): the scope, not the missing
    // edge, says it is development-only.
    assert.deepStrictEqual(rootDeps.dependsOn, [
      "pkg:npm/@babel/generator@7.26.5",
      "pkg:npm/fsevents@2.3.3",
      "pkg:npm/left-pad@1.3.0",
      "pkg:npm/typescript@5.9.3",
    ]);
    const typescript = pkgList.find((p) => p.name === "typescript");
    assert.deepStrictEqual(typescript.scope, "optional");
    assert.ok(hasProp(typescript, "cdx:npm:package:development"));
  });
});

// Generated with `bun install` (bun 1.4.2). The root asks for the same
// packages @isaacs/cliui needs, but at older versions, so bun nests cliui's
// newer versions under its key one level above its own dependencies.
describe("parseBunLock: intermediate nesting", async () => {
  const NESTING_FIXTURE = "./test/data/bun/nesting/bun.lock";

  await test("resolves a dependency placed at an intermediate nesting level", async () => {
    const { pkgList, dependenciesList } = await parseBunLock(NESTING_FIXTURE);

    // wrap-ansi@8.1.0 sits at `@isaacs/cliui/wrap-ansi` and declares
    // string-width ^5.0.1 / strip-ansi ^7.0.1, which bun placed one level up
    // at `@isaacs/cliui/string-width` and `@isaacs/cliui/strip-ansi`. The
    // graph must link those versions, not the top-level 4.2.3 / 6.0.1.
    const wrap8 = dependenciesList.find(
      (d) => d.ref === "pkg:npm/wrap-ansi@8.1.0",
    );
    assert.ok(wrap8);
    assert.deepStrictEqual(wrap8.dependsOn, [
      "pkg:npm/ansi-styles@6.2.3",
      "pkg:npm/string-width@5.1.2",
      "pkg:npm/strip-ansi@7.2.0",
    ]);
    assert.ok(!wrap8.dependsOn.includes("pkg:npm/string-width@4.2.3"));
    assert.ok(!wrap8.dependsOn.includes("pkg:npm/strip-ansi@6.0.1"));

    // string-width@5.1.2 at `@isaacs/cliui/string-width` also resolves
    // strip-ansi at the intermediate level.
    const stringWidth5 = dependenciesList.find(
      (d) => d.ref === "pkg:npm/string-width@5.1.2",
    );
    assert.deepStrictEqual(stringWidth5.dependsOn, [
      "pkg:npm/eastasianwidth@0.2.0",
      "pkg:npm/emoji-regex@9.2.2",
      "pkg:npm/strip-ansi@7.2.0",
    ]);

    // Directly nested and top-level resolutions are unaffected: emoji-regex
    // ^9.2.2 exists at `@isaacs/cliui/string-width/emoji-regex`, and the
    // top-level wrap-ansi@7.0.0 keeps using the top-level versions.
    const stripAnsi7 = dependenciesList.find(
      (d) => d.ref === "pkg:npm/strip-ansi@7.2.0",
    );
    assert.deepStrictEqual(stripAnsi7.dependsOn, ["pkg:npm/ansi-regex@6.4.0"]);
    const wrap7 = dependenciesList.find(
      (d) => d.ref === "pkg:npm/wrap-ansi@7.0.0",
    );
    assert.deepStrictEqual(wrap7.dependsOn, [
      "pkg:npm/ansi-styles@4.3.0",
      "pkg:npm/string-width@4.2.3",
      "pkg:npm/strip-ansi@6.0.1",
    ]);

    // Everything in this fixture is a production dependency chain: the walk
    // through the intermediate levels must not orphan any nested package
    // into the development scope.
    for (const pkg of pkgList) {
      assert.deepStrictEqual(pkg.scope, undefined, pkg.purl);
    }
  });
});

// Generated with `bun install` (bun 1.4.2). The monorepo member @acme/backend
// lives at packages/backend (name != path), pins strip-ansi ^7.1.0 while the
// root pins 6.0.1, carries a devDependency on chalk 0.5, and is consumed by a
// second member util-pkg through `workspace:*`.
describe("parseBunLock: workspace members", async () => {
  const WORKSPACE_FIXTURE = "./test/data/bun/workspace/bun.lock";
  const parentComponent = {
    name: "cdxgen-bun-workspace-repro",
    version: "1.0.0",
    "bom-ref": "pkg:npm/cdxgen-bun-workspace-repro@1.0.0",
  };

  await test("models members with their declared version and own dependency edges", async () => {
    const { pkgList, dependenciesList } = await parseBunLock(
      WORKSPACE_FIXTURE,
      { parentComponent },
    );

    const byPurl = Object.fromEntries(pkgList.map((p) => [p.purl, p]));

    // The member component uses the version declared in its manifest, not
    // the `workspace:packages/backend` reference bun records.
    const backend = byPurl["pkg:npm/%40acme/backend@2.1.0"];
    assert.ok(backend);
    assert.deepStrictEqual(backend.version, "2.1.0");
    assert.ok(
      !backend.purl.includes("download_url"),
      "workspace members must not carry a download_url qualifier",
    );

    // The member's production dependency keeps out of the development scope.
    const memberDep = byPurl["pkg:npm/strip-ansi@7.2.0"];
    assert.ok(memberDep);
    assert.deepStrictEqual(memberDep.scope, undefined);
    assert.ok(
      !memberDep.properties.some(
        (prop) => prop.name === "cdx:npm:package:development",
      ),
    );
    // Its own nested dependency ansi-regex@6.4.0 stays reachable as well.
    const nestedAnsiRegex = byPurl["pkg:npm/ansi-regex@6.4.0"];
    assert.deepStrictEqual(nestedAnsiRegex.scope, undefined);

    // Both members are flagged as workspace members.
    assert.ok(hasProp(backend, "cdx:npm:isWorkspace"));
    assert.ok(hasProp(byPurl["pkg:npm/util-pkg@1.0.0"], "cdx:npm:isWorkspace"));

    // Edges attach to the owning component: the member depends on
    // strip-ansi@7.2.0 (nested under its name) and its devDependency chalk,
    // and util-pkg depends on the member via `workspace:*` plus its registry
    // dependency.
    const backendEdges = dependenciesList.find(
      (d) => d.ref === "pkg:npm/@acme/backend@2.1.0",
    );
    assert.deepStrictEqual(backendEdges.dependsOn, [
      "pkg:npm/chalk@0.5.1",
      "pkg:npm/strip-ansi@7.2.0",
    ]);
    const utilEdges = dependenciesList.find(
      (d) => d.ref === "pkg:npm/util-pkg@1.0.0",
    );
    assert.deepStrictEqual(utilEdges.dependsOn, [
      "pkg:npm/@acme/backend@2.1.0",
      "pkg:npm/emoji-regex@9.2.2",
    ]);

    // The root only lists its own declared dependencies (the members, its
    // pinned strip-ansi, the optional fsevents and the dev typescript) - not
    // the members' deps.
    const rootDeps = dependenciesList.find(
      (d) => d.ref === "pkg:npm/cdxgen-bun-workspace-repro@1.0.0",
    );
    assert.deepStrictEqual(rootDeps.dependsOn, [
      "pkg:npm/@acme/backend@2.1.0",
      "pkg:npm/fsevents@2.3.3",
      "pkg:npm/strip-ansi@6.0.1",
      "pkg:npm/typescript@5.9.3",
      "pkg:npm/util-pkg@1.0.0",
    ]);

    // The member's devDependency tree stays development-scoped: chalk and
    // its whole subtree, plus the root's typescript.
    for (const purl of [
      "pkg:npm/chalk@0.5.1",
      "pkg:npm/ansi-styles@1.1.0",
      "pkg:npm/strip-ansi@0.3.0",
      "pkg:npm/ansi-regex@0.2.1",
      "pkg:npm/typescript@5.9.3",
    ]) {
      assert.ok(
        byPurl[purl].properties.some(
          (prop) => prop.name === "cdx:npm:package:development",
        ),
        `${purl} must be development-scoped`,
      );
    }
  });
});

// Generated with `bun install` (bun 1.4.2). The root depends on a github
// repository, a remote tarball and a `file:` folder whose own dependency must
// still produce an edge even though those entries put their metadata object
// at index 1 of the package tuple (npm entries carry a registry url there).
describe("parseBunLock: non-registry dependency sources", async () => {
  const GITDEPS_FIXTURE = "./test/data/bun/gitdeps/bun.lock";

  await test("keeps the dependency edges of git, tarball and file packages", async () => {
    const { pkgList, dependenciesList } = await parseBunLock(GITDEPS_FIXTURE);

    // The file: package's dependency is recorded in its metadata object,
    // which bun writes directly after the descriptor.
    const localPkg = dependenciesList.find((d) =>
      d.ref.startsWith("pkg:npm/local-pkg@"),
    );
    assert.deepStrictEqual(localPkg.dependsOn, ["pkg:npm/ansi-regex@2.1.1"]);

    // That dependency is production-reachable, not development-scoped.
    const ansiRegex = pkgList.find(
      (p) => p.purl === "pkg:npm/ansi-regex@2.1.1",
    );
    assert.deepStrictEqual(ansiRegex.scope, undefined);
    assert.ok(
      !ansiRegex.properties.some(
        (prop) => prop.name === "cdx:npm:package:development",
      ),
    );

    // The github dependency keeps its git qualifiers and manifest source.
    const kindOf = pkgList.find((p) => p.name === "kind-of");
    assert.ok(kindOf.purl.includes("vcs_url=github"));
    assert.ok(
      kindOf.properties.some(
        (prop) =>
          prop.name === "cdx:npm:manifestSourceType" && prop.value === "git",
      ),
    );
    assert.ok(
      kindOf.properties.some(
        (prop) =>
          prop.name === "cdx:npm:isRegistryDependency" &&
          prop.value === "false",
      ),
    );

    // The remote tarball records its url as the download_url qualifier.
    const tarball = pkgList.find((p) => p.name === "left-pad");
    assert.ok(tarball.purl.includes("download_url=https"));
  });
});

// Generated with `bun install` (bun 1.4.2). The root installs an `npm:`
// alias for wrap-ansi next to @isaacs/cliui, whose own -cjs aliases resolve
// against top-level entries.
describe("parseBunLock: aliased dependencies", async () => {
  const ALIASES_FIXTURE = "./test/data/bun/aliases/bun.lock";

  await test("resolves aliases to the underlying package version", async () => {
    const { pkgList, dependenciesList } = await parseBunLock(ALIASES_FIXTURE, {
      parentComponent: {
        name: "cdxgen-bun-alias-repro",
        version: "1.0.0",
        "bom-ref": "pkg:npm/cdxgen-bun-alias-repro@1.0.0",
      },
    });

    // `my-wrap` is an alias for wrap-ansi ^7.0.0: the root links to the real
    // package, and no component named my-wrap is emitted.
    const rootDeps = dependenciesList.find(
      (d) => d.ref === "pkg:npm/cdxgen-bun-alias-repro@1.0.0",
    );
    assert.deepStrictEqual(rootDeps.dependsOn, [
      "pkg:npm/@isaacs/cliui@8.0.2",
      "pkg:npm/string-width@4.2.3",
      "pkg:npm/strip-ansi@6.0.1",
      "pkg:npm/wrap-ansi@7.0.0",
    ]);
    assert.ok(!pkgList.some((p) => p.name === "my-wrap"));

    // cliui declares both direct deps and -cjs aliases, so it resolves to
    // both versions of each family (the alias keys walk up to the top-level
    // entries, the real names to the nested ones).
    const cliui = dependenciesList.find(
      (d) => d.ref === "pkg:npm/@isaacs/cliui@8.0.2",
    );
    assert.deepStrictEqual(cliui.dependsOn, [
      "pkg:npm/string-width@4.2.3",
      "pkg:npm/string-width@5.1.2",
      "pkg:npm/strip-ansi@6.0.1",
      "pkg:npm/strip-ansi@7.2.0",
      "pkg:npm/wrap-ansi@7.0.0",
      "pkg:npm/wrap-ansi@8.1.0",
    ]);
  });
});

// Generated with `bun install` (bun 1.4.2). `catalog:` specifiers resolve
// through the lockfile's `catalog` section; the member is nested under its
// name @repo/tooling even though it lives at pkgs/tooling.
describe("parseBunLock: catalog protocol", async () => {
  const CATALOG_FIXTURE = "./test/data/bun/catalog/bun.lock";

  await test("resolves catalog dependencies and versioned members", async () => {
    const { pkgList, dependenciesList } = await parseBunLock(CATALOG_FIXTURE, {
      parentComponent: {
        name: "cdxgen-bun-catalog-repro",
        version: "1.0.0",
        "bom-ref": "pkg:npm/cdxgen-bun-catalog-repro@1.0.0",
      },
    });

    const tooling = pkgList.find(
      (p) => p.purl === "pkg:npm/%40repo/tooling@0.1.0",
    );
    assert.ok(tooling);
    assert.deepStrictEqual(tooling.version, "0.1.0");

    const toolingEdges = dependenciesList.find(
      (d) => d.ref === "pkg:npm/@repo/tooling@0.1.0",
    );
    assert.deepStrictEqual(toolingEdges.dependsOn, ["pkg:npm/left-pad@1.3.0"]);

    // The root does not declare the member, but bun makes every workspace
    // member a dependency of the root, so the graph links it.
    const rootDeps = dependenciesList.find(
      (d) => d.ref === "pkg:npm/cdxgen-bun-catalog-repro@1.0.0",
    );
    assert.deepStrictEqual(rootDeps.dependsOn, [
      "pkg:npm/@repo/tooling@0.1.0",
      "pkg:npm/left-pad@1.3.0",
    ]);
  });
});

// Generated with `bun install` (bun 1.4.0). The root declares neither member,
// depends on aaa-member only through the workspace alias `aaa-alias` (which
// bun writes before the member's own key) and on a `file:` folder with a
// devDependency. Both members pin has-ansi@2.0.0 under their own names.
describe("parseBunLock: monorepo graph", async () => {
  const MONOREPO_FIXTURE = "./test/data/bun/monorepo/bun.lock";
  const ROOT = "pkg:npm/cdxgen-bun-monorepo-repro@1.0.0";

  await test("links every member to the root and keeps aliased members' edges", async () => {
    const { pkgList, dependenciesList } = await parseBunLock(MONOREPO_FIXTURE, {
      parentComponent: { "bom-ref": ROOT },
    });
    const edges = Object.fromEntries(
      dependenciesList.map((d) => [d.ref, d.dependsOn]),
    );
    const byRef = Object.fromEntries(pkgList.map((p) => [p["bom-ref"], p]));
    const localTool =
      "pkg:npm/local-tool@file:local-tool?download_url=file:local-tool";

    // zzz-member is undeclared by the root but still hangs off it, and the
    // aliased aaa-member appears once.
    assert.deepStrictEqual(edges[ROOT], [
      "pkg:npm/aaa-member@1.0.0",
      "pkg:npm/ansi-regex@2.0.0",
      "pkg:npm/has-ansi@4.0.1",
      localTool,
      "pkg:npm/zzz-member@1.0.0",
    ]);
    // The alias key sorts first, yet the member keeps the edges declared in
    // its workspaces entry.
    assert.deepStrictEqual(edges["pkg:npm/aaa-member@1.0.0"], [
      "pkg:npm/ansi-regex@2.1.1",
      "pkg:npm/has-ansi@2.0.0",
    ]);
    assert.deepStrictEqual(edges["pkg:npm/zzz-member@1.0.0"], [
      "pkg:npm/has-ansi@2.0.0",
      "pkg:npm/left-pad@1.3.0",
    ]);
    // Bun installs a `file:` folder's devDependencies too.
    assert.deepStrictEqual(edges[localTool], [
      "pkg:npm/is-number@7.0.0",
      "pkg:npm/strip-ansi@3.0.1",
    ]);

    // Every component is reachable from the root.
    const seen = new Set([ROOT]);
    const stack = [ROOT];
    while (stack.length) {
      for (const child of edges[stack.pop()] || []) {
        if (!seen.has(child)) {
          seen.add(child);
          stack.push(child);
        }
      }
    }
    for (const pkg of pkgList) {
      assert.ok(seen.has(pkg["bom-ref"]), `${pkg["bom-ref"]} is orphaned`);
    }

    // Dev-only packages: the root's ansi-regex@2.0.0, zzz-member's left-pad
    // and the folder's is-number. Everything else is production.
    const devRefs = pkgList
      .filter((p) => hasProp(p, "cdx:npm:package:development"))
      .map((p) => p["bom-ref"])
      .sort();
    assert.deepStrictEqual(devRefs, [
      "pkg:npm/ansi-regex@2.0.0",
      "pkg:npm/is-number@7.0.0",
      "pkg:npm/left-pad@1.3.0",
    ]);
    for (const pkg of pkgList) {
      assert.deepStrictEqual(
        pkg.scope,
        devRefs.includes(pkg["bom-ref"]) ? "optional" : undefined,
        pkg["bom-ref"],
      );
    }
    assert.ok(
      hasProp(byRef["pkg:npm/aaa-member@1.0.0"], "cdx:npm:isWorkspace"),
    );
    assert.ok(!hasProp(byRef[localTool], "cdx:npm:isWorkspace"));
  });
});

// Generated with `bun install` (bun 1.4.0). ws lists bufferutil and
// cosmiconfig lists typescript as optional peers; the root depends on
// bufferutil directly and on typescript and esbuild only for development.
describe("parseBunLock: optional peers and optional dependencies", async () => {
  const OPTIONAL_PEERS_FIXTURE = "./test/data/bun/optional-peers/bun.lock";

  await test("scopes by how the root reaches a package, not by any single edge", async () => {
    const { pkgList, dependenciesList } = await parseBunLock(
      OPTIONAL_PEERS_FIXTURE,
      {
        parentComponent: {
          "bom-ref": "pkg:npm/cdxgen-bun-optional-peers-repro@1.0.0",
        },
      },
    );
    const byRef = Object.fromEntries(pkgList.map((p) => [p["bom-ref"], p]));

    // bufferutil is an optional peer of ws but a direct production
    // dependency: required, neither optional nor peer.
    const bufferutil = byRef["pkg:npm/bufferutil@4.0.9"];
    assert.deepStrictEqual(bufferutil.scope, undefined);
    assert.ok(!hasProp(bufferutil, "cdx:npm:package:optional"));
    assert.ok(!hasProp(bufferutil, "cdx:npm:package:peer"));
    const wsEdges = dependenciesList.find((d) => d.ref === "pkg:npm/ws@8.18.3");
    assert.deepStrictEqual(wsEdges.dependsOn, ["pkg:npm/bufferutil@4.0.9"]);

    // typescript is an optional peer of the production cosmiconfig, which
    // never installs it: it is only there as the root's devDependency.
    const typescript = byRef["pkg:npm/typescript@5.9.3"];
    assert.deepStrictEqual(typescript.scope, "optional");
    assert.ok(hasProp(typescript, "cdx:npm:package:development"));
    assert.ok(!hasProp(typescript, "cdx:npm:package:optional"));
    assert.ok(!hasProp(typescript, "cdx:npm:package:peer"));

    // esbuild's platform binaries are optional dependencies of a dev-only
    // package. Their keys sort before esbuild's, which must not matter.
    const platformBinaries = pkgList.filter((p) => p.group === "@esbuild");
    assert.deepStrictEqual(platformBinaries.length, 25);
    for (const pkg of platformBinaries) {
      assert.deepStrictEqual(pkg.scope, "optional");
      assert.ok(hasProp(pkg, "cdx:npm:package:development"), pkg.purl);
      assert.ok(hasProp(pkg, "cdx:npm:package:optional"), pkg.purl);
    }
    const esbuild = byRef["pkg:npm/esbuild@0.25.4"];
    assert.ok(!hasProp(esbuild, "cdx:npm:package:optional"));
  });
});

// Generated with `bun install` (bun 1.4.0). The wasm32 oxide build ships its
// runtime in bundleDependencies; tslib is bundled there but also installed on
// its own for the root.
describe("parseBunLock: bundled dependencies", async () => {
  const BUNDLED_FIXTURE = "./test/data/bun/bundled/bun.lock";

  await test("marks only packages every copy of which is bundled", async () => {
    const { pkgList } = await parseBunLock(BUNDLED_FIXTURE);
    const bundled = pkgList
      .filter((p) => hasProp(p, "cdx:npm:inBundle"))
      .map((p) => p["bom-ref"])
      .sort();
    assert.deepStrictEqual(bundled, [
      "pkg:npm/@emnapi/core@1.11.3",
      "pkg:npm/@emnapi/runtime@1.11.3",
      "pkg:npm/@emnapi/wasi-threads@1.2.3",
      "pkg:npm/@napi-rs/wasm-runtime@0.2.12",
      "pkg:npm/@tybys/wasm-util@0.10.4",
    ]);
    // `"cpu": "none"` (no platform bun recognizes) carries no value.
    const oxide = pkgList.find((p) => p.name === "oxide-wasm32-wasi");
    assert.ok(!oxide.properties.some((prop) => prop.name === "cdx:npm:cpu"));
  });
});

// Generated with `bun install` (bun 1.4.2). Bun auto-installs and resolves
// the root's peer dependencies, so they must survive as production edges
// (found via a real-world monorepo lockfile while cross-checking against
// bun's own resolution algorithm).
describe("parseBunLock: root peer dependencies", async () => {
  const PEERS_FIXTURE = "./test/data/bun/peers/bun.lock";

  await test("links the root's peer dependencies as production edges", async () => {
    const { pkgList, dependenciesList } = await parseBunLock(PEERS_FIXTURE, {
      parentComponent: {
        name: "cdxgen-bun-peers-repro",
        version: "1.0.0",
        "bom-ref": "pkg:npm/cdxgen-bun-peers-repro@1.0.0",
      },
    });

    const rootDeps = dependenciesList.find(
      (d) => d.ref === "pkg:npm/cdxgen-bun-peers-repro@1.0.0",
    );
    assert.deepStrictEqual(rootDeps.dependsOn, ["pkg:npm/left-pad@1.3.0"]);

    const leftPad = pkgList.find((p) => p.purl === "pkg:npm/left-pad@1.3.0");
    assert.deepStrictEqual(leftPad.scope, undefined);
    assert.ok(
      !leftPad.properties.some(
        (prop) => prop.name === "cdx:npm:package:development",
      ),
    );
    assert.ok(
      leftPad.properties.some(
        (prop) => prop.name === "cdx:npm:package:peer" && prop.value === "true",
      ),
    );
  });
});

// The `-v1` twins were generated with bun 1.2.0 (lockfileVersion 1, the Zig
// implementation of the text lockfile) from the very same manifests as the
// v2 fixtures (bun 1.4.2, Rust). Both must parse to the same graph.
describe("parseBunLock: lockfile version parity", async () => {
  const assertSameParse = async (v2Path, v1Path) => {
    const [v2, v1] = await Promise.all([
      parseBunLock(v2Path),
      parseBunLock(v1Path),
    ]);
    const summarize = (parsed) => ({
      packages: parsed.pkgList
        .map((p) => [p.purl, p.scope ?? "", p.version ?? ""])
        .sort(),
      graph: parsed.dependenciesList.map((d) => [d.ref, ...d.dependsOn]).sort(),
    });
    assert.deepStrictEqual(summarize(v1), summarize(v2));
  };

  await test("parses the v1 nesting lockfile identically", async () => {
    await assertSameParse(
      "./test/data/bun/nesting/bun.lock",
      "./test/data/bun/nesting-v1/bun.lock",
    );
  });

  await test("parses the v1 workspace lockfile identically", async () => {
    await assertSameParse(
      "./test/data/bun/workspace/bun.lock",
      "./test/data/bun/workspace-v1/bun.lock",
    );
  });

  await test("parses the v1 gitdeps lockfile identically", async () => {
    await assertSameParse(
      "./test/data/bun/gitdeps/bun.lock",
      "./test/data/bun/gitdeps-v1/bun.lock",
    );
  });

  await test("parses the v1 peers lockfile identically", async () => {
    await assertSameParse(
      "./test/data/bun/peers/bun.lock",
      "./test/data/bun/peers-v1/bun.lock",
    );
  });
});

describe("bun local tarball resolutions", () => {
  test("a bare path resolution is a non-registry source", async () => {
    // bun writes a local tarball as `localdep@./localdep.tgz`, without a
    // `file:` prefix; it must not be read as a registry version.
    const { pkgList } = await parseBunLock(
      "./test/repotests/bun-build-metadata-smoke/bun.lock",
    );
    const tarball = pkgList.find((p) => p.name === "localdep");
    assert.ok(tarball.purl.includes("download_url="), tarball.purl);
    const member = pkgList.find((p) => p.name === "wsmember");
    assert.strictEqual(member.version, "3.0.0+ws");
    assert.strictEqual(member.purl, "pkg:npm/wsmember@3.0.0%2Bws");
  });
});
