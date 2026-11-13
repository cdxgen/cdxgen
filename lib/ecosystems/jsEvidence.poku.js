import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { addEvidenceForImports } from "./jsEvidence.js";

// A junction needs no extra privilege on Windows, unlike a directory symlink.
const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

const importOf = (importedAs, fileName, extra = {}) =>
  new Set([
    {
      fileName,
      lineNumber: 1,
      importedAs,
      importedModules: [importedAs],
      ...extra,
    },
  ]);

const propValue = (pkg, name) =>
  (pkg?.properties || []).find((property) => property.name === name)?.value;

const writePackageJson = (dir, manifest) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
};

// The properties a hoisted npm lockfile component carries: the lock file it was
// parsed from and its arborist location relative to that file's directory.
const npmLockProps = (projectDir, location) => [
  { name: "internal:SrcFile", value: join(projectDir, "package-lock.json") },
  { name: "internal:LocalNodeModulesPath", value: location },
];

describe("addEvidenceForImports()", () => {
  // #4336: a missing import is not evidence that a package is optional.
  it("promotes imported packages and leaves the rest at their manifest scope", async () => {
    const pkgList = [
      { group: "", name: "debug", properties: [] },
      { group: "", name: "left-pad", properties: [] },
      {
        group: "@scope",
        name: "runtime-plugin",
        properties: [],
      },
      {
        group: "",
        name: "peer-only",
        properties: [{ name: "cdx:npm:package:peer", value: "true" }],
      },
      {
        group: "",
        name: "is-number",
        scope: "optional",
        properties: [{ name: "cdx:npm:package:development", value: "true" }],
      },
      {
        group: "",
        name: "picocolors",
        scope: "optional",
        properties: [{ name: "cdx:npm:package:development", value: "true" }],
      },
    ];
    await addEvidenceForImports(
      pkgList,
      {
        debug: importOf("debug", "index.js"),
        "is-number": importOf("is-number", "index.js"),
      },
      {},
      false,
    );
    const scopeOf = Object.fromEntries(
      pkgList.map((pkg) => [pkg.name, pkg.scope]),
    );

    assert.strictEqual(scopeOf.debug, "required");
    assert.strictEqual(scopeOf["is-number"], "required");
    assert.strictEqual(scopeOf["left-pad"], undefined);
    assert.strictEqual(scopeOf["runtime-plugin"], undefined);
    assert.strictEqual(scopeOf["peer-only"], undefined);
    assert.strictEqual(scopeOf.picocolors, "optional");
    assert.strictEqual(
      pkgList.find((pkg) => pkg.name === "is-number").evidence.occurrences[0]
        .location,
      "index.js",
    );
  });

  it("scopes a package imported only for its types as excluded", async () => {
    const pkgList = [
      { group: "", name: "is-odd", properties: [] },
      { group: "", name: "is-even", properties: [] },
    ];
    await addEvidenceForImports(
      pkgList,
      {
        "is-odd": importOf("is-odd", "src/index.ts", { isTypeOnly: true }),
        "is-even": importOf("is-even", "src/index.ts"),
      },
      {},
      false,
    );
    const [isOdd, isEven] = pkgList;

    assert.strictEqual(isOdd.scope, "excluded");
    assert.strictEqual(propValue(isOdd, "cdx:npm:package:type-only"), "true");
    assert.strictEqual(isOdd.evidence.occurrences[0].location, "src/index.ts");
    assert.strictEqual(isEven.scope, "required");
    assert.strictEqual(
      propValue(isEven, "cdx:npm:package:type-only"),
      undefined,
    );
  });

  it("keeps a type-only import required when its bin command is used", async () => {
    const pkgList = [
      {
        group: "",
        name: "license-report",
        scope: "optional",
        properties: [{ name: "cdx:npm:bin", value: "license-report" }],
      },
    ];
    await addEvidenceForImports(
      pkgList,
      {
        "license-report": importOf("license-report", "src/report.ts", {
          isTypeOnly: true,
        }),
        "cdx:npm:bin/license-report": importOf(
          "cdx:npm:bin/license-report",
          "package.json",
        ),
      },
      {},
      false,
    );

    assert.strictEqual(pkgList[0].scope, "required");
    assert.strictEqual(
      propValue(pkgList[0], "cdx:npm:package:type-only"),
      undefined,
    );
  });
});

// test/data/npm-version-resolution-repotest as parsePkgLock lists it: ms 2.1.3
// is hoisted for the root, ms 2.0.0 is installed under the workspace member
// packages/legacy and again under debug. Each copy appears once per location.
const versionResolutionProject = () => {
  const projectDir = join(tmpdir(), "npm-version-resolution");
  const rootLock = join(projectDir, "package-lock.json");
  const legacyLock = join(
    projectDir,
    "packages",
    "legacy",
    "package-lock.json",
  );
  const pkg = (name, version, srcFile, location, extra = []) => ({
    group: "",
    name,
    version,
    purl: `pkg:npm/${name}@${version}`,
    "bom-ref": `pkg:npm/${name}@${version}`,
    properties: [
      { name: "internal:SrcFile", value: srcFile },
      { name: "internal:LocalNodeModulesPath", value: location },
      ...extra,
    ],
  });
  return {
    projectDir,
    pkgList: [
      pkg("legacy", "1.0.0", legacyLock, "packages/legacy", [
        { name: "cdx:npm:isWorkspace", value: "true" },
        { name: "cdx:npm:resolvedPath", value: "packages/legacy" },
      ]),
      pkg("ms", "2.0.0", legacyLock, "packages/legacy/node_modules/ms"),
      pkg("debug", "2.6.9", rootLock, "node_modules/debug"),
      pkg("ms", "2.0.0", rootLock, "node_modules/debug/node_modules/ms"),
      pkg("ms", "2.1.3", rootLock, "node_modules/ms"),
    ],
  };
};

const occurrenceFiles = (pkgList, ref) => [
  ...new Set(
    pkgList
      .filter((p) => p["bom-ref"] === ref)
      .flatMap((p) => (p.evidence?.occurrences || []).map((o) => o.location)),
  ),
];

describe("addEvidenceForImports() with several installed versions", () => {
  it("credits each file's import to the version the file resolves to", async () => {
    const { projectDir, pkgList } = versionResolutionProject();
    const allImports = {
      ms: new Set([
        { fileName: "src/index.js", lineNumber: 2, importedAs: "ms" },
        {
          fileName: "packages/legacy/index.js",
          lineNumber: 1,
          importedAs: "ms",
        },
      ]),
    };
    await addEvidenceForImports(pkgList, allImports, {}, false, {
      srcDir: projectDir,
    });
    assert.deepStrictEqual(occurrenceFiles(pkgList, "pkg:npm/ms@2.1.3"), [
      "src/index.js",
    ]);
    assert.deepStrictEqual(occurrenceFiles(pkgList, "pkg:npm/ms@2.0.0"), [
      "packages/legacy/index.js",
    ]);
  });

  it("credits every version when it is not told where the files are", async () => {
    const { pkgList } = versionResolutionProject();
    const allImports = {
      ms: new Set([
        { fileName: "src/index.js", lineNumber: 2, importedAs: "ms" },
      ]),
    };
    await addEvidenceForImports(pkgList, allImports, {}, false);
    assert.deepStrictEqual(occurrenceFiles(pkgList, "pkg:npm/ms@2.1.3"), [
      "src/index.js",
    ]);
    assert.deepStrictEqual(occurrenceFiles(pkgList, "pkg:npm/ms@2.0.0"), [
      "src/index.js",
    ]);
  });

  it("leaves a copy no import resolves to unscoped and flags it", async () => {
    const { projectDir, pkgList } = versionResolutionProject();
    const nested = pkgList.filter((p) => p["bom-ref"] === "pkg:npm/ms@2.0.0");
    for (const p of nested) {
      p.scope = "optional";
    }
    const allImports = {
      ms: new Set([
        { fileName: "src/index.js", lineNumber: 2, importedAs: "ms" },
      ]),
    };
    await addEvidenceForImports(pkgList, allImports, {}, false, {
      srcDir: projectDir,
    });
    for (const p of nested) {
      assert.strictEqual(p.scope, "optional");
      assert.strictEqual(p.evidence?.occurrences, undefined);
      assert.strictEqual(propValue(p, "internal:ImportedModules"), undefined);
      assert.strictEqual(p._npmImportsResolveElsewhere, true);
    }
    const hoisted = pkgList.find((p) => p["bom-ref"] === "pkg:npm/ms@2.1.3");
    assert.strictEqual(hoisted.scope, "required");
    assert.strictEqual(hoisted._npmImportsResolveElsewhere, undefined);
  });

  it("credits a bin command to the copy the project resolves", async () => {
    const { projectDir, pkgList } = versionResolutionProject();
    for (const p of pkgList) {
      if (p.name === "ms") {
        p.scope = "optional";
        p.properties.push({ name: "cdx:npm:bin", value: "ms" });
      }
    }
    await addEvidenceForImports(
      pkgList,
      {
        "cdx:npm:bin/ms": new Set([
          {
            fileName: "package.json",
            lineNumber: 7,
            importedAs: "cdx:npm:bin/ms",
          },
        ]),
      },
      {},
      false,
      { srcDir: projectDir },
    );
    const hoisted = pkgList.find((p) => p["bom-ref"] === "pkg:npm/ms@2.1.3");
    assert.strictEqual(hoisted.scope, "required");
    assert.deepStrictEqual(occurrenceFiles(pkgList, "pkg:npm/ms@2.1.3"), [
      "package.json",
    ]);
    for (const p of pkgList.filter(
      (p) => p["bom-ref"] === "pkg:npm/ms@2.0.0",
    )) {
      assert.strictEqual(p.scope, "optional");
      assert.strictEqual(p._npmImportsResolveElsewhere, true);
    }
  });
});

// The working directory is process-wide, so the cases that scan from another
// directory live in lib/cli/jsBomDeepMetadata.poku.js and run one at a time.
describe("addEvidenceForImports() deep node_modules metadata", () => {
  it("takes metadata from the copy under the lock file's node_modules", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-js-evidence-"));
    try {
      writePackageJson(join(projectDir, "node_modules", "@scope", "demo"), {
        name: "@scope/demo",
        version: "2.0.0",
        description: "metadata from the scanned project",
        license: "MIT",
        author: "Fixture Author",
        homepage: "https://example.com/@scope/demo",
        repository: { url: "git+https://example.com/@scope/demo.git" },
      });
      const pkg = {
        group: "@scope",
        name: "demo",
        version: "2.0.0",
        properties: npmLockProps(projectDir, "node_modules/@scope/demo"),
      };
      await addEvidenceForImports([pkg], {}, {}, true);

      assert.strictEqual(pkg.description, "metadata from the scanned project");
      assert.strictEqual(pkg.license, "MIT");
      assert.strictEqual(pkg.author, "Fixture Author");
      assert.deepStrictEqual(pkg.homepage, {
        url: "https://example.com/@scope/demo",
      });
      assert.deepStrictEqual(pkg.repository, {
        url: "git+https://example.com/@scope/demo.git",
      });
      // The transient lookup property must not leak into the BOM.
      assert.strictEqual(
        propValue(pkg, "internal:LocalNodeModulesPath"),
        undefined,
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips a local package.json describing a different version", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-js-evidence-"));
    try {
      writePackageJson(join(projectDir, "node_modules", "@scope", "demo"), {
        name: "@scope/demo",
        version: "1.0.0",
        description: "stale local copy",
        license: "MIT",
      });
      const pkg = {
        group: "@scope",
        name: "demo",
        version: "2.0.0",
        license: "MIT",
        properties: npmLockProps(projectDir, "node_modules/@scope/demo"),
      };
      await addEvidenceForImports([pkg], {}, {}, true);

      assert.strictEqual(pkg.description, undefined);
      assert.strictEqual(pkg.license, "MIT");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips a local package.json naming a different package", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-js-evidence-"));
    try {
      writePackageJson(join(projectDir, "node_modules", "@scope", "demo"), {
        name: "@other/demo",
        version: "2.0.0",
        description: "another package at the same location",
        license: "GPL-3.0-only",
      });
      const pkg = {
        group: "@scope",
        name: "demo",
        version: "2.0.0",
        properties: npmLockProps(projectDir, "node_modules/@scope/demo"),
      };
      await addEvidenceForImports([pkg], {}, {}, true);

      assert.strictEqual(pkg.description, undefined);
      assert.strictEqual(pkg.license, undefined);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips a workspace-relative location", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-js-evidence-"));
    try {
      // A package nested under workspace member packages/a records that
      // member's directory in SrcFile and a location relative to the
      // workspace root, so joining the two names no installed copy.
      const srcFile = join(projectDir, "packages", "a", "package-lock.json");
      const location = "packages/a/node_modules/demo-lib";
      writePackageJson(
        join(
          projectDir,
          "packages",
          "a",
          "packages",
          "a",
          "node_modules",
          "demo-lib",
        ),
        {
          name: "demo-lib",
          version: "1.1.0",
          description: "not the installed copy",
        },
      );
      const pkg = {
        group: "",
        name: "demo-lib",
        version: "1.1.0",
        properties: [
          { name: "internal:SrcFile", value: srcFile },
          { name: "internal:LocalNodeModulesPath", value: location },
        ],
      };
      await addEvidenceForImports([pkg], {}, {}, true);

      assert.strictEqual(pkg.description, undefined);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("skips a package.json reached through a link out of the project", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cdxgen-js-evidence-"));
    try {
      // The scanned tree ships node_modules/demo-lib as a symbolic link to a
      // directory elsewhere on the host; its manifest matches name and version.
      const projectDir = join(tmpRoot, "project");
      const outsideDir = join(tmpRoot, "elsewhere", "demo-lib");
      writePackageJson(outsideDir, {
        name: "demo-lib",
        version: "1.1.0",
        description: "not part of the scanned tree",
        license: "MIT",
      });
      mkdirSync(join(projectDir, "node_modules"), { recursive: true });
      symlinkSync(
        outsideDir,
        join(projectDir, "node_modules", "demo-lib"),
        DIR_LINK_TYPE,
      );
      const pkg = {
        group: "",
        name: "demo-lib",
        version: "1.1.0",
        properties: npmLockProps(projectDir, "node_modules/demo-lib"),
      };
      await addEvidenceForImports([pkg], {}, {}, true);

      assert.strictEqual(pkg.description, undefined);
      assert.strictEqual(pkg.license, undefined);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("keeps fields the local package.json does not provide", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-js-evidence-"));
    try {
      // No license, author, homepage or repository in the local copy.
      writePackageJson(join(projectDir, "node_modules", "demo-lib"), {
        name: "demo-lib",
        version: "1.1.0",
        description: "unscoped demo lib",
      });
      const pkg = {
        group: "",
        name: "demo-lib",
        version: "1.1.0",
        license: "Apache-2.0",
        author: "Original Author",
        homepage: { url: "https://example.com/original" },
        repository: { url: "git+https://example.com/original.git" },
        properties: npmLockProps(projectDir, "node_modules/demo-lib"),
      };
      await addEvidenceForImports([pkg], {}, {}, true);

      assert.strictEqual(pkg.description, "unscoped demo lib");
      assert.strictEqual(pkg.license, "Apache-2.0");
      assert.strictEqual(pkg.author, "Original Author");
      assert.deepStrictEqual(pkg.homepage, {
        url: "https://example.com/original",
      });
      assert.deepStrictEqual(pkg.repository, {
        url: "git+https://example.com/original.git",
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("uses an absolute LocalNodeModulesPath without a SrcFile anchor", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "cdxgen-js-evidence-"));
    try {
      // pnpm metadata records the install directory itself.
      const absoluteDir = join(
        tmpRoot,
        "node_modules",
        ".pnpm",
        "demo-lib@1.1.0",
        "node_modules",
        "demo-lib",
      );
      writePackageJson(absoluteDir, {
        name: "demo-lib",
        version: "1.1.0",
        description: "pnpm virtual store copy",
        license: "BSD-2-Clause",
      });
      const pkg = {
        group: "",
        name: "demo-lib",
        version: "1.1.0",
        properties: [
          { name: "internal:LocalNodeModulesPath", value: absoluteDir },
        ],
      };
      await addEvidenceForImports([pkg], {}, {}, true);

      assert.strictEqual(pkg.description, "pnpm virtual store copy");
      assert.strictEqual(pkg.license, "BSD-2-Clause");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("enriches an unscoped package that the source imports", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-js-evidence-"));
    try {
      writePackageJson(join(projectDir, "node_modules", "demo-lib"), {
        name: "demo-lib",
        version: "1.1.0",
        description: "unscoped demo lib",
      });
      const pkg = {
        group: "",
        name: "demo-lib",
        version: "1.1.0",
        properties: npmLockProps(projectDir, "node_modules/demo-lib"),
      };
      // The alias matching the import ends the alias loop with a break.
      await addEvidenceForImports(
        [pkg],
        { "demo-lib": importOf("demo-lib", "src/index.js") },
        {},
        true,
      );

      assert.strictEqual(pkg.scope, "required");
      assert.strictEqual(pkg.description, "unscoped demo lib");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("leaves metadata alone outside deep mode", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-js-evidence-"));
    try {
      writePackageJson(join(projectDir, "node_modules", "demo-lib"), {
        name: "demo-lib",
        version: "1.1.0",
        description: "unscoped demo lib",
      });
      const pkg = {
        group: "",
        name: "demo-lib",
        version: "1.1.0",
        properties: npmLockProps(projectDir, "node_modules/demo-lib"),
      };
      await addEvidenceForImports([pkg], {}, {}, false);

      assert.strictEqual(pkg.description, undefined);
      assert.strictEqual(pkg.license, undefined);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
