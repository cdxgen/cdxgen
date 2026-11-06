import { join, resolve } from "node:path";

import { assert, describe, it } from "poku";

import {
  createDirectDependencyLookup,
  createNpmVersionChooser,
  keepResolvedNpmVersions,
  npmInstallDirectory,
  npmPackageNameOfPurl,
} from "./npmVersionResolution.js";

// The project of test/data/npm-version-resolution-repotest: the root depends
// on debug 2.6.9 and ms 2.1.3, debug needs ms 2.0.0 (nested under it), and the
// workspace member packages/legacy depends on ms 2.0.0 (installed under it).
const projectDir = resolve("project-root");
const rootLock = join(projectDir, "package-lock.json");
const legacyLock = join(projectDir, "packages", "legacy", "package-lock.json");

const lockPkg = (name, version, srcFile, location, extra = []) => ({
  name,
  version,
  group: "",
  purl: `pkg:npm/${name}@${version}`,
  "bom-ref": `pkg:npm/${name}@${version}`,
  properties: [
    { name: "internal:SrcFile", value: srcFile },
    ...(location
      ? [{ name: "internal:LocalNodeModulesPath", value: location }]
      : []),
    ...extra,
  ],
});

const workspaceProps = [
  { name: "cdx:npm:isWorkspace", value: "true" },
  { name: "cdx:npm:resolvedPath", value: "packages/legacy" },
];

const fixturePkgList = () => [
  lockPkg("legacy", "1.0.0", legacyLock, "packages/legacy", workspaceProps),
  lockPkg("ms", "2.0.0", legacyLock, "packages/legacy/node_modules/ms"),
  lockPkg("legacy", "1.0.0", rootLock, "node_modules/legacy", workspaceProps),
  lockPkg("debug", "2.6.9", rootLock, "node_modules/debug"),
  lockPkg("ms", "2.0.0", rootLock, "node_modules/debug/node_modules/ms"),
  lockPkg("ms", "2.1.3", rootLock, "node_modules/ms"),
];

const fixtureDependencies = [
  {
    ref: "pkg:npm/npm-version-resolution@1.0.0",
    dependsOn: [
      "pkg:npm/debug@2.6.9",
      "pkg:npm/legacy@1.0.0",
      "pkg:npm/ms@2.1.3",
    ],
  },
  { ref: "pkg:npm/legacy@1.0.0", dependsOn: ["pkg:npm/ms@2.0.0"] },
  { ref: "pkg:npm/debug@2.6.9", dependsOn: ["pkg:npm/ms@2.0.0"] },
];

const rootRefs = ["pkg:npm/npm-version-resolution@1.0.0"];

const byRef = (pkgList, ref) => pkgList.find((p) => p["bom-ref"] === ref);

describe("npmPackageNameOfPurl()", () => {
  it("names scoped and unscoped npm packages", () => {
    assert.strictEqual(
      npmPackageNameOfPurl("pkg:npm/%40angular/core@15.2.10"),
      "@angular/core",
    );
    assert.strictEqual(npmPackageNameOfPurl("pkg:npm/ms@2.1.3"), "ms");
  });

  it("names nothing for other purl types and unparsable text", () => {
    assert.strictEqual(npmPackageNameOfPurl("pkg:pypi/ms@1.0"), undefined);
    assert.strictEqual(npmPackageNameOfPurl("not a purl"), undefined);
  });
});

describe("npmInstallDirectory()", () => {
  it("resolves hoisted and nested locations against the lock file", () => {
    assert.strictEqual(
      npmInstallDirectory(lockPkg("ms", "2.1.3", rootLock, "node_modules/ms")),
      join(projectDir, "node_modules", "ms"),
    );
    assert.strictEqual(
      npmInstallDirectory(
        lockPkg("ms", "2.0.0", rootLock, "node_modules/debug/node_modules/ms"),
      ),
      join(projectDir, "node_modules", "debug", "node_modules", "ms"),
    );
  });

  it("resolves a copy under a workspace member from the member's SrcFile", () => {
    assert.strictEqual(
      npmInstallDirectory(
        lockPkg("ms", "2.0.0", legacyLock, "packages/legacy/node_modules/ms"),
      ),
      join(projectDir, "packages", "legacy", "node_modules", "ms"),
    );
  });

  it("accepts a location spelled with backslashes", () => {
    assert.strictEqual(
      npmInstallDirectory(
        lockPkg(
          "ms",
          "2.0.0",
          legacyLock,
          "packages\\legacy\\node_modules\\ms",
        ),
      ),
      join(projectDir, "packages", "legacy", "node_modules", "ms"),
    );
  });

  it("names no install for a workspace member, an absolute path or no SrcFile", () => {
    assert.strictEqual(
      npmInstallDirectory(
        lockPkg("legacy", "1.0.0", legacyLock, "packages/legacy"),
      ),
      undefined,
    );
    assert.strictEqual(
      npmInstallDirectory(
        lockPkg("ms", "2.1.3", rootLock, join(projectDir, "node_modules/ms")),
      ),
      undefined,
    );
    assert.strictEqual(
      npmInstallDirectory({
        properties: [
          { name: "internal:LocalNodeModulesPath", value: "node_modules/ms" },
        ],
      }),
      undefined,
    );
  });
});

describe("createDirectDependencyLookup()", () => {
  it("gives a member's file the member's declarations before the root's", () => {
    const lookup = createDirectDependencyLookup(
      fixturePkgList(),
      fixtureDependencies,
      rootRefs,
    );
    const [member, root] = lookup("packages/legacy/index.js");
    assert.deepStrictEqual([...member], ["pkg:npm/ms@2.0.0"]);
    assert.ok(root.has("pkg:npm/ms@2.1.3"));
    assert.strictEqual(lookup("src/index.js").length, 1);
    assert.ok(lookup("src/index.js")[0].has("pkg:npm/ms@2.1.3"));
  });

  it("does not take a sibling directory sharing the member's prefix", () => {
    const lookup = createDirectDependencyLookup(
      fixturePkgList(),
      fixtureDependencies,
      rootRefs,
    );
    assert.strictEqual(lookup("packages/legacy-tools/index.js").length, 1);
  });
});

describe("createNpmVersionChooser()", () => {
  it("gives each file the copy Node.js resolves from its directory", () => {
    const pkgList = fixturePkgList();
    const chooser = createNpmVersionChooser(pkgList, {
      srcDir: projectDir,
      dependencies: fixtureDependencies,
      rootRefs,
    });
    const ms200 = byRef(pkgList, "pkg:npm/ms@2.0.0");
    const ms213 = byRef(pkgList, "pkg:npm/ms@2.1.3");
    assert.strictEqual(chooser.allows(ms213, "src/index.js"), true);
    assert.strictEqual(chooser.allows(ms200, "src/index.js"), false);
    assert.strictEqual(chooser.allows(ms200, "packages/legacy/index.js"), true);
    assert.strictEqual(
      chooser.allows(ms213, "packages/legacy/index.js"),
      false,
    );
  });

  it("uses install locations without a dependency tree", () => {
    const pkgList = fixturePkgList();
    const chooser = createNpmVersionChooser(pkgList, { srcDir: projectDir });
    const ms200 = byRef(pkgList, "pkg:npm/ms@2.0.0");
    const ms213 = byRef(pkgList, "pkg:npm/ms@2.1.3");
    assert.strictEqual(chooser.allows(ms213, "src/index.js"), true);
    assert.strictEqual(chooser.allows(ms200, "src/index.js"), false);
    assert.strictEqual(chooser.allows(ms200, "packages/legacy/index.js"), true);
    assert.strictEqual(
      chooser.allows(ms213, "packages/legacy/index.js"),
      false,
    );
  });

  it("allows every file for a package installed in one version", () => {
    const pkgList = fixturePkgList();
    const chooser = createNpmVersionChooser(pkgList, { srcDir: projectDir });
    const debug = byRef(pkgList, "pkg:npm/debug@2.6.9");
    assert.strictEqual(chooser.isAmbiguous(debug), false);
    assert.strictEqual(chooser.allows(debug, "anywhere/at/all.js"), true);
  });

  it("falls back to direct dependencies when no install location is known", () => {
    const pkgList = fixturePkgList().map((p) => ({
      ...p,
      properties: p.properties.filter(
        (prop) => prop.name !== "internal:LocalNodeModulesPath",
      ),
    }));
    const chooser = createNpmVersionChooser(pkgList, {
      srcDir: projectDir,
      dependencies: fixtureDependencies,
      rootRefs,
    });
    const ms200 = byRef(pkgList, "pkg:npm/ms@2.0.0");
    const ms213 = byRef(pkgList, "pkg:npm/ms@2.1.3");
    assert.strictEqual(chooser.allows(ms213, "src/index.js"), true);
    assert.strictEqual(chooser.allows(ms200, "src/index.js"), false);
    assert.strictEqual(chooser.allows(ms200, "packages/legacy/index.js"), true);
    assert.strictEqual(
      chooser.allows(ms213, "packages/legacy/index.js"),
      false,
    );
  });

  it("keeps every version when nothing tells them apart", () => {
    const pkgList = [
      lockPkg("ms", "2.0.0", rootLock),
      lockPkg("ms", "2.1.3", rootLock),
    ];
    const chooser = createNpmVersionChooser(pkgList, { srcDir: projectDir });
    for (const pkg of pkgList) {
      assert.strictEqual(chooser.allows(pkg, "src/index.js"), true);
    }
  });
});

describe("keepResolvedNpmVersions()", () => {
  const bomOf = (components) => ({
    metadata: {
      component: { "bom-ref": "pkg:npm/npm-version-resolution@1.0.0" },
    },
    components,
    dependencies: fixtureDependencies,
  });
  const comp = (name, version, properties = []) => ({
    name,
    version,
    purl: `pkg:npm/${name}@${version}`,
    "bom-ref": `pkg:npm/${name}@${version}`,
    properties,
  });
  const fixtureBom = () =>
    bomOf([
      comp("legacy", "1.0.0", workspaceProps),
      comp("ms", "2.0.0"),
      comp("debug", "2.6.9"),
      comp("ms", "2.1.3"),
    ]);

  it("keeps a slice occurrence on the version the BOM's import evidence names", () => {
    const seeded = {
      "pkg:npm/ms@2.0.0": new Set(["packages/legacy/index.js#1"]),
      "pkg:npm/ms@2.1.3": new Set(["src/index.js#2"]),
    };
    // a slice record names the package: evinse adds it to both versions
    const purlLocationMap = {
      "pkg:npm/ms@2.0.0": new Set([
        "packages/legacy/index.js#1",
        "packages/legacy/index.js:3:23",
        "src/index.js:8:9",
      ]),
      "pkg:npm/ms@2.1.3": new Set([
        "src/index.js#2",
        "packages/legacy/index.js:3:23",
        "src/index.js:8:9",
      ]),
    };
    const purlSymbolMap = {
      "pkg:npm/ms@2.0.0": {
        "packages/legacy/index.js:3:23": "ms",
        "src/index.js:8:9": "ms",
      },
      "pkg:npm/ms@2.1.3": {
        "packages/legacy/index.js:3:23": "ms",
        "src/index.js:8:9": "ms",
      },
    };
    const cleared = keepResolvedNpmVersions(
      purlLocationMap,
      purlSymbolMap,
      seeded,
      fixtureBom(),
    );
    assert.deepStrictEqual([...purlLocationMap["pkg:npm/ms@2.0.0"]].sort(), [
      "packages/legacy/index.js#1",
      "packages/legacy/index.js:3:23",
    ]);
    assert.deepStrictEqual([...purlLocationMap["pkg:npm/ms@2.1.3"]].sort(), [
      "src/index.js#2",
      "src/index.js:8:9",
    ]);
    assert.deepStrictEqual(purlSymbolMap["pkg:npm/ms@2.0.0"], {
      "packages/legacy/index.js:3:23": "ms",
    });
    assert.deepStrictEqual(purlSymbolMap["pkg:npm/ms@2.1.3"], {
      "src/index.js:8:9": "ms",
    });
    assert.strictEqual(cleared.size, 0);
  });

  it("follows the BOM's import evidence over the direct dependencies", () => {
    // a directory with its own node_modules/ms: cdxgen credited 2.0.0 there
    const seeded = {
      "pkg:npm/ms@2.0.0": new Set(["tools/clock.js#1"]),
      "pkg:npm/ms@2.1.3": new Set(["src/index.js#2"]),
    };
    const purlLocationMap = {
      "pkg:npm/ms@2.0.0": new Set(["tools/clock.js#1", "tools/clock.js:4:2"]),
      "pkg:npm/ms@2.1.3": new Set(["src/index.js#2", "tools/clock.js:4:2"]),
    };
    keepResolvedNpmVersions(purlLocationMap, {}, seeded, fixtureBom());
    assert.deepStrictEqual([...purlLocationMap["pkg:npm/ms@2.0.0"]].sort(), [
      "tools/clock.js#1",
      "tools/clock.js:4:2",
    ]);
    assert.deepStrictEqual(
      [...purlLocationMap["pkg:npm/ms@2.1.3"]],
      ["src/index.js#2"],
    );
  });

  it("narrows an input BOM that credits every version to the direct dependencies", () => {
    // what cdxgen wrote before it resolved versions: both copies everywhere
    const everywhere = () =>
      new Set(["packages/legacy/index.js#1", "src/index.js#2"]);
    const seeded = {
      "pkg:npm/ms@2.0.0": everywhere(),
      "pkg:npm/ms@2.1.3": everywhere(),
    };
    const purlLocationMap = {
      "pkg:npm/ms@2.0.0": everywhere(),
      "pkg:npm/ms@2.1.3": everywhere(),
    };
    keepResolvedNpmVersions(purlLocationMap, {}, seeded, fixtureBom());
    assert.deepStrictEqual(
      [...purlLocationMap["pkg:npm/ms@2.0.0"]],
      ["packages/legacy/index.js#1"],
    );
    assert.deepStrictEqual(
      [...purlLocationMap["pkg:npm/ms@2.1.3"]],
      ["src/index.js#2"],
    );
  });

  it("reports a version left with no occurrence", () => {
    const bom = bomOf([comp("ms", "2.0.0"), comp("ms", "2.1.3")]);
    bom.dependencies = [
      {
        ref: "pkg:npm/npm-version-resolution@1.0.0",
        dependsOn: ["pkg:npm/ms@2.1.3"],
      },
    ];
    const seeded = {
      "pkg:npm/ms@2.0.0": new Set(["src/index.js#2"]),
      "pkg:npm/ms@2.1.3": new Set(["src/index.js#2"]),
    };
    const purlLocationMap = {
      "pkg:npm/ms@2.0.0": new Set(["src/index.js#2"]),
      "pkg:npm/ms@2.1.3": new Set(["src/index.js#2"]),
    };
    const cleared = keepResolvedNpmVersions(purlLocationMap, {}, seeded, bom);
    assert.deepStrictEqual([...cleared], ["pkg:npm/ms@2.0.0"]);
    assert.strictEqual(purlLocationMap["pkg:npm/ms@2.0.0"].size, 0);
  });

  it("leaves single-version and non-npm components alone", () => {
    const bom = bomOf([
      comp("debug", "2.6.9"),
      {
        name: "ms",
        version: "1.0",
        purl: "pkg:pypi/ms@1.0",
        "bom-ref": "pkg:pypi/ms@1.0",
      },
      comp("ms", "2.1.3"),
    ]);
    const purlLocationMap = {
      "pkg:npm/debug@2.6.9": new Set(["src/index.js#1", "other/file.js#3"]),
      "pkg:pypi/ms@1.0": new Set(["src/index.js#2"]),
      "pkg:npm/ms@2.1.3": new Set(["src/index.js#2"]),
    };
    keepResolvedNpmVersions(purlLocationMap, {}, {}, bom);
    assert.strictEqual(purlLocationMap["pkg:npm/debug@2.6.9"].size, 2);
    assert.strictEqual(purlLocationMap["pkg:pypi/ms@1.0"].size, 1);
    assert.strictEqual(purlLocationMap["pkg:npm/ms@2.1.3"].size, 1);
  });
});
