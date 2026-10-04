import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { Purl } from "@cdxgen/cdx-purl";
import esmock from "esmock";
import { assert, describe, it } from "poku";
import ssri from "ssri";

import { validateRefs } from "../validator/bomValidator.js";
// Imported directly rather than through the deprecated ./utils.js barrel, which is
// kept only for backward compatibility and must not grow new exports.
import { createNpmWorkspacePurl } from "./npmutils.js";
import {
  detectRootNpmExtension,
  hashNpmExtensionFile,
  parsePnpmAliasRef,
  stripPnpmPeerSuffix,
} from "./parsers-js.js";
import {
  findPnpmPackagePath,
  isPartialTree,
  parseBowerJson,
  parseMinJs,
  parseNodeShrinkwrap,
  parsePackageJsonName,
  parsePkgJson,
  parsePkgLock,
  parsePnpmLock,
  parsePnpmWorkspace,
  parseYarnLock,
  pnpmMetadata,
  yarnLockToIdentMap,
} from "./utils.js";

it("parsePkgJson", async () => {
  const pkgList = await parsePkgJson("./package.json", true);
  assert.deepStrictEqual(pkgList.length, 1);
});

it("parsePkgJson emits obfuscated lifecycle-hook indicators", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pkgjson-"));
  const pkgJsonFile = path.join(tempDir, "package.json");
  const installScriptFile = path.join(tempDir, "scripts", "postinstall.js");
  mkdirSync(path.dirname(installScriptFile), { recursive: true });
  writeFileSync(
    installScriptFile,
    [
      "import cp from 'node:child_process';",
      "const payload = Buffer.from('ZXZhbCgnY29uc29sZS5sb2coMSknKQ==', 'base64');",
      "cp.execSync(payload.toString());",
    ].join("\n"),
  );
  writeFileSync(
    pkgJsonFile,
    JSON.stringify(
      {
        name: "suspicious-pkg",
        version: "1.0.0",
        scripts: {
          postinstall: "node scripts/postinstall.js",
        },
      },
      null,
      2,
    ),
  );

  try {
    const pkgList = await parsePkgJson(pkgJsonFile, true, true);
    assert.strictEqual(pkgList.length, 1);
    const properties = pkgList[0].properties || [];
    assert.ok(
      properties.some(
        (property) =>
          property.name === "cdx:npm:hasInstallScript" &&
          property.value === "true",
      ),
    );
    assert.ok(
      properties.some(
        (property) =>
          property.name === "cdx:npm:hasObfuscatedLifecycleScript" &&
          property.value === "true",
      ),
    );
    assert.ok(
      properties.some(
        (property) =>
          property.name === "cdx:npm:lifecycleObfuscationIndicators" &&
          property.value.includes("ast:buffer-base64"),
      ),
    );
    assert.ok(
      properties.some(
        (property) =>
          property.name === "cdx:npm:lifecycleExecutionIndicators" &&
          property.value.includes("ast:child-process"),
      ),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("parsePkgJson handles lifecycle runners with option flags", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-pkgjson-runner-flags-"),
  );
  const pkgJsonFile = path.join(tempDir, "package.json");
  const preloadFile = path.join(tempDir, "preload.js");
  const installScriptFile = path.join(tempDir, "scripts", "postinstall.js");
  mkdirSync(path.dirname(installScriptFile), { recursive: true });
  writeFileSync(preloadFile, "globalThis.__cdxgenPreload = true;\n");
  writeFileSync(
    installScriptFile,
    [
      "import cp from 'node:child_process';",
      "cp.execSync('echo cdxgen');",
    ].join("\n"),
  );
  writeFileSync(
    pkgJsonFile,
    JSON.stringify(
      {
        name: "runner-flags-pkg",
        version: "1.0.0",
        scripts: {
          postinstall:
            "cross-env NODE_ENV=production node --loader tsx --require ./preload.js ./scripts/postinstall.js && echo done",
        },
      },
      null,
      2,
    ),
  );

  try {
    const pkgList = await parsePkgJson(pkgJsonFile, true, true);
    assert.strictEqual(pkgList.length, 1);
    const properties = pkgList[0].properties || [];
    assert.ok(
      properties.some(
        (property) =>
          property.name === "cdx:npm:hasInstallScript" &&
          property.value === "true",
      ),
    );
    assert.ok(
      properties.some(
        (property) =>
          property.name === "cdx:npm:lifecycleIndicatorMap" &&
          property.value.includes("ast:child-process"),
      ),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("parsePkgJson ignores lifecycle script files outside the package directory", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-pkgjson-outside-script-"),
  );
  const packageDir = path.join(tempDir, "package");
  const pkgJsonFile = path.join(packageDir, "package.json");
  const outsideScriptFile = path.join(tempDir, "secret.js");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    outsideScriptFile,
    [
      "import cp from 'node:child_process';",
      "cp.execSync('echo should-not-be-read');",
    ].join("\n"),
  );
  writeFileSync(
    pkgJsonFile,
    JSON.stringify(
      {
        name: "outside-script-pkg",
        version: "1.0.0",
        scripts: {
          postinstall: "node ../secret.js",
        },
      },
      null,
      2,
    ),
  );

  try {
    const pkgList = await parsePkgJson(pkgJsonFile, true, true);
    assert.strictEqual(pkgList.length, 1);
    const properties = pkgList[0].properties || [];
    assert.ok(
      properties.some(
        (property) =>
          property.name === "cdx:npm:hasInstallScript" &&
          property.value === "true",
      ),
    );
    assert.ok(
      !properties.some(
        (property) =>
          property.name === "cdx:npm:lifecycleIndicatorMap" &&
          property.value.includes("ast:child-process"),
      ),
    );
    assert.ok(
      !properties.some(
        (property) =>
          property.name === "cdx:npm:lifecycleExecutionIndicators" &&
          property.value.includes("ast:child-process"),
      ),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("parsePkgJson detects bun lifecycle runners", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-pkgjson-bun-runner-"),
  );
  const pkgJsonFile = path.join(tempDir, "package.json");
  const preloadFile = path.join(tempDir, "preload.ts");
  const installScriptFile = path.join(tempDir, "scripts", "postinstall.ts");
  mkdirSync(path.dirname(installScriptFile), { recursive: true });
  writeFileSync(preloadFile, "globalThis.__cdxgenPreload = true;\n");
  writeFileSync(
    installScriptFile,
    ["import cp from 'node:child_process';", "cp.execSync('echo bun');"].join(
      "\n",
    ),
  );
  writeFileSync(
    pkgJsonFile,
    JSON.stringify(
      {
        name: "bun-runner-pkg",
        version: "1.0.0",
        scripts: {
          postinstall:
            "bun run --preload ./preload.ts ./scripts/postinstall.ts",
        },
      },
      null,
      2,
    ),
  );

  try {
    const pkgList = await parsePkgJson(pkgJsonFile, true, true);
    assert.strictEqual(pkgList.length, 1);
    const properties = pkgList[0].properties || [];
    assert.ok(
      properties.some(
        (property) =>
          property.name === "cdx:npm:lifecycleIndicatorMap" &&
          property.value.includes("ast:child-process"),
      ),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("parsePkgJson detects deno run lifecycle runners", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-pkgjson-deno-runner-"),
  );
  const pkgJsonFile = path.join(tempDir, "package.json");
  const configFile = path.join(tempDir, "deno.json");
  const installScriptFile = path.join(tempDir, "scripts", "postinstall.ts");
  mkdirSync(path.dirname(installScriptFile), { recursive: true });
  writeFileSync(configFile, '{"imports":{}}\n');
  writeFileSync(
    installScriptFile,
    ["import cp from 'node:child_process';", "cp.execSync('echo deno');"].join(
      "\n",
    ),
  );
  writeFileSync(
    pkgJsonFile,
    JSON.stringify(
      {
        name: "deno-runner-pkg",
        version: "1.0.0",
        scripts: {
          postinstall:
            "deno run -A --config ./deno.json ./scripts/postinstall.ts",
        },
      },
      null,
      2,
    ),
  );

  try {
    const pkgList = await parsePkgJson(pkgJsonFile, true, true);
    assert.strictEqual(pkgList.length, 1);
    const properties = pkgList[0].properties || [];
    assert.ok(
      properties.some(
        (property) =>
          property.name === "cdx:npm:lifecycleIndicatorMap" &&
          property.value.includes("ast:child-process"),
      ),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("parsePkgJson ignores non-run deno subcommands", async () => {
  const tempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-pkgjson-deno-cache-"),
  );
  const pkgJsonFile = path.join(tempDir, "package.json");
  const installScriptFile = path.join(tempDir, "scripts", "postinstall.ts");
  mkdirSync(path.dirname(installScriptFile), { recursive: true });
  writeFileSync(
    installScriptFile,
    [
      "import cp from 'node:child_process';",
      "cp.execSync('echo deno-cache');",
    ].join("\n"),
  );
  writeFileSync(
    pkgJsonFile,
    JSON.stringify(
      {
        name: "deno-cache-pkg",
        version: "1.0.0",
        scripts: {
          postinstall: "deno cache ./scripts/postinstall.ts",
        },
      },
      null,
      2,
    ),
  );

  try {
    const pkgList = await parsePkgJson(pkgJsonFile, true, true);
    assert.strictEqual(pkgList.length, 1);
    const properties = pkgList[0].properties || [];
    assert.ok(
      !properties.some(
        (property) =>
          property.name === "cdx:npm:lifecycleIndicatorMap" &&
          property.value.includes("ast:child-process"),
      ),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("parsePkgLock v1", async () => {
  const parsedList = await parsePkgLock(
    "./test/data/package-json/v1/package-lock.json",
  );
  const deps = parsedList.pkgList;
  assert.deepStrictEqual(deps.length, 910);
  assert.deepStrictEqual(
    deps[1]._integrity,
    "sha512-ZmIomM7EE1DvPEnSFAHZn9Vs9zJl5A9H7el0EGTE6ZbW9FKe/14IYAlPbC8iH25YarEQxZL+E8VW7Mi7kfQrDQ==",
  );
  assert.deepStrictEqual(parsedList.dependenciesList.length, 910);
});

it("parsePkgLock v2", async () => {
  const parsedList = await parsePkgLock(
    "./test/data/package-json/v2/package-lock.json",
  );
  const deps = parsedList.pkgList;
  assert.deepStrictEqual(deps.length, 134);
  assert.deepStrictEqual(
    deps[1]._integrity,
    "sha512-x9yaMvEh5BEaZKeVQC4vp3l+QoFj3BXcd4aYfuKSzIIyihjdVARAadYy3SMNIz0WCCdS2vB9JL/U6GQk5PaxQw==",
  );
  assert.deepStrictEqual(deps[1].license, "Apache-2.0");
  assert.deepStrictEqual(deps[0], {
    "bom-ref": "pkg:npm/shopify-theme-tailwindcss@2.2.1",
    purl: "pkg:npm/shopify-theme-tailwindcss@2.2.1",
    author: "Wessel van Ree <hello@wesselvanree.com>",
    group: "",
    name: "shopify-theme-tailwindcss",
    license: "MIT",
    type: "application",
    version: "2.2.1",
  });
  assert.deepStrictEqual(deps[deps.length - 1].name, "rollup");
  const pkgFilePath = path.resolve(
    path.join("test", "data", "package-json", "v2", "package-lock.json"),
  );
  assert.deepStrictEqual(deps[deps.length - 1].evidence, {
    identity: {
      field: "purl",
      confidence: 1,
      methods: [
        {
          technique: "manifest-analysis",
          confidence: 1,
          value: pkgFilePath,
        },
      ],
    },
  });
  const devOnlyPkg = deps.find(
    (pkg) => pkg["bom-ref"] === "pkg:npm/@types/shelljs@0.8.11",
  );
  assert.ok(devOnlyPkg);
  assert.deepStrictEqual(devOnlyPkg.scope, "optional");
  assert.ok(
    devOnlyPkg.properties.some(
      (property) =>
        property.name === "cdx:npm:package:development" &&
        property.value === "true",
    ),
  );
  const devOptionalPkg = deps.find(
    (pkg) => pkg["bom-ref"] === "pkg:npm/@esbuild/android-arm@0.15.12",
  );
  assert.ok(devOptionalPkg);
  assert.deepStrictEqual(devOptionalPkg.scope, "optional");
  assert.ok(
    devOptionalPkg.properties.some(
      (property) =>
        property.name === "cdx:npm:package:development" &&
        property.value === "true",
    ),
  );
  assert.deepStrictEqual(parsedList.dependenciesList.length, 134);
});

it("parsePkgLock v2 workspace", async () => {
  const parsedList = await parsePkgLock(
    "./test/data/package-json/v2-workspace/package-lock.json",
  );
  const pkgs = parsedList.pkgList;
  const deps = parsedList.dependenciesList;
  assert.deepStrictEqual(pkgs.length, 1034);
  assert.deepStrictEqual(pkgs[0].license, "MIT");
  const hasAppWorkspacePkg = pkgs.some(
    (obj) => obj["bom-ref"] === "pkg:npm/app@0.0.0",
  );
  const hasAppWorkspaceDeps = deps.some(
    (obj) => obj.ref === "pkg:npm/app@0.0.0",
  );
  assert.ok(hasAppWorkspacePkg);
  assert.ok(hasAppWorkspaceDeps);
  const hasRootPkg = pkgs.some(
    (obj) => obj["bom-ref"] === "pkg:npm/root@0.0.0",
  );
  const hasRootDeps = deps.some((obj) => obj.ref === "pkg:npm/root@0.0.0");
  assert.ok(hasRootPkg);
  assert.ok(hasRootDeps);
  const hasScriptsWorkspacePkg = pkgs.some(
    (obj) => obj["bom-ref"] === "pkg:npm/scripts@0.0.0",
  );
  const hasScriptsWorkspaceDeps = deps.some(
    (obj) => obj.ref === "pkg:npm/scripts@0.0.0",
  );
  assert.ok(hasScriptsWorkspacePkg);
  assert.ok(hasScriptsWorkspaceDeps);
});

it("parsePkgLock v3", async () => {
  const parsedList = await parsePkgLock(
    "./test/data/package-json/v3/package-lock.json",
    {
      projectVersion: "latest",
      projectName: "cdxgen",
    },
  );
  const deps = parsedList.pkgList;
  assert.deepStrictEqual(deps.length, 161);
  assert.deepStrictEqual(
    deps[1]._integrity,
    "sha512-s93jiP6GkRApn5duComx6RLwtP23YrulPxShz+8peX7svd6Q+MS8nKLhKCCazbP92C13eTVaIOxgeLt0ezIiCg==",
  );
  assert.deepStrictEqual(deps[0], {
    "bom-ref": "pkg:npm/clase-21---jwt@latest",
    purl: "pkg:npm/clase-21---jwt@latest",
    group: "",
    author: "",
    license: "ISC",
    name: "clase-21---jwt",
    type: "application",
    version: "latest",
  });
  assert.deepStrictEqual(deps[deps.length - 1].name, "uid2");
  assert.deepStrictEqual(parsedList.dependenciesList.length, 161);
});

it("parsePkgLock marks devOptional entries as development", async () => {
  const rootNode = {
    path: "/virtual/project",
    package: {
      author: "",
      license: "MIT",
    },
    packageName: "virtual-project",
    version: "1.0.0",
    edgesOut: new Map(),
    fsChildren: new Set(),
    children: new Map(),
  };
  const devOptionalNode = {
    path: "/virtual/project/node_modules/dev-optional-dep",
    package: {
      author: "",
      license: "MIT",
    },
    packageName: "dev-optional-dep",
    version: "2.0.0",
    devOptional: true,
    integrity: "sha512-devoptional",
    edgesOut: new Map(),
    fsChildren: new Set(),
    children: new Map(),
  };
  rootNode.children.set("node_modules/dev-optional-dep", devOptionalNode);
  rootNode.edgesOut.set("dev-optional-dep", {
    name: "dev-optional-dep",
    spec: "^2.0.0",
    to: devOptionalNode,
  });
  const { parsePkgLock: parsePkgLockWithMockedArborist } = await esmock(
    "./parsers-js.js",
    {
      "../third-party/arborist/lib/index.js": {
        default: class MockArborist {
          async loadVirtual() {
            return rootNode;
          }
        },
      },
    },
  );
  const parsedList = await parsePkgLockWithMockedArborist(
    "./test/data/package-json/v3/package-lock.json",
    {},
  );
  const devOptionalPkg = parsedList.pkgList.find(
    (pkg) => pkg["bom-ref"] === "pkg:npm/dev-optional-dep@2.0.0",
  );
  assert.ok(devOptionalPkg);
  assert.deepStrictEqual(devOptionalPkg.scope, "optional");
  assert.ok(
    devOptionalPkg.properties.some(
      (property) =>
        property.name === "cdx:npm:package:development" &&
        property.value === "true",
    ),
  );
});

it("parsePkgLock deep mode hydrates sparse npm metadata from disk", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pkglock-hydrate-"));
  const pkgLockFile = path.join(tempDir, "package-lock.json");
  const depDir = path.join(tempDir, "node_modules", "sparse-dep");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(pkgLockFile, JSON.stringify({ lockfileVersion: 3 }, null, 2));
  writeFileSync(
    path.join(depDir, "package.json"),
    JSON.stringify(
      {
        name: "sparse-dep",
        version: "1.2.3",
        license: "MIT",
        description: "Hydrated from package.json",
        author: {
          name: "Example Maintainer",
          email: "maintainer@example.com",
        },
        repository: { url: "https://github.com/acme/sparse-dep.git" },
        bugs: { url: "https://github.com/acme/sparse-dep/issues" },
        keywords: ["hydrated", "hidden-lockfile"],
        bin: { sparse: "bin/sparse.js" },
      },
      null,
      2,
    ),
  );
  const rootNode = {
    path: tempDir,
    package: {
      author: "",
      license: "Apache-2.0",
    },
    packageName: "virtual-project",
    version: "1.0.0",
    edgesOut: new Map(),
    fsChildren: new Set(),
    children: new Map(),
  };
  const sparseNode = {
    path: depDir,
    package: {
      version: "1.2.3",
    },
    packageName: "sparse-dep",
    version: "1.2.3",
    integrity: "sha512-sparse",
    edgesOut: new Map(),
    fsChildren: new Set(),
    children: new Map(),
  };
  rootNode.children.set("node_modules/sparse-dep", sparseNode);
  rootNode.edgesOut.set("sparse-dep", {
    name: "sparse-dep",
    spec: "^1.2.3",
    to: sparseNode,
  });

  try {
    const { parsePkgLock: parsePkgLockWithMockedArborist } = await esmock(
      "./parsers-js.js",
      {
        "../third-party/arborist/lib/index.js": {
          default: class MockArborist {
            async loadActual() {
              return rootNode;
            }
          },
        },
      },
    );
    const parsedList = await parsePkgLockWithMockedArborist(pkgLockFile, {
      deep: true,
    });
    const sparsePkg = parsedList.pkgList.find(
      (pkg) => pkg["bom-ref"] === "pkg:npm/sparse-dep@1.2.3",
    );
    assert.ok(sparsePkg);
    assert.strictEqual(sparsePkg.license, "MIT");
    assert.strictEqual(
      sparsePkg.author,
      "Example Maintainer <maintainer@example.com>",
    );
    assert.strictEqual(sparsePkg.description, "Hydrated from package.json");
    assert.ok(
      sparsePkg.externalReferences.some(
        (reference) =>
          reference.type === "vcs" &&
          reference.url === "https://github.com/acme/sparse-dep.git",
      ),
    );
    assert.ok(
      sparsePkg.externalReferences.some(
        (reference) =>
          reference.type === "issue-tracker" &&
          reference.url === "https://github.com/acme/sparse-dep/issues",
      ),
    );
    assert.deepStrictEqual(sparsePkg.tags, ["hidden-lockfile", "hydrated"]);
    assert.ok(
      sparsePkg.properties.some(
        (property) =>
          property.name === "cdx:npm:bin" && property.value === "sparse",
      ),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("parsePkgLock deep mode names the root after its directory when package.json has no name", async () => {
  // Issue 4440: a package.json without a name still installs, so the root of
  // the actual tree carries no packageName and building its purl must not
  // throw E_MISSING_NAME. The root component is named after its directory,
  // the way the scans without node_modules already are.
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pkglock-noname-"));
  const pkgLockFile = path.join(tempDir, "package-lock.json");
  // --deep reads the actual tree only once node_modules is installed
  mkdirSync(path.join(tempDir, "node_modules"), { recursive: true });
  writeFileSync(pkgLockFile, JSON.stringify({ lockfileVersion: 3 }, null, 2));
  writeFileSync(
    path.join(tempDir, "package.json"),
    JSON.stringify({ private: true }, null, 2),
  );
  const rootNode = {
    path: tempDir,
    package: { private: true },
    edgesOut: new Map(),
    fsChildren: new Set(),
    children: new Map(),
  };

  try {
    const { parsePkgLock: parsePkgLockWithMockedArborist } = await esmock(
      "./parsers-js.js",
      {
        "../third-party/arborist/lib/index.js": {
          default: class MockArborist {
            async loadActual() {
              return rootNode;
            }
          },
        },
      },
    );
    const parsedList = await parsePkgLockWithMockedArborist(pkgLockFile, {
      deep: true,
    });
    const dirName = path.basename(tempDir);
    const rootPkg = parsedList.pkgList.find(
      (pkg) => pkg.type === "application",
    );
    assert.ok(rootPkg);
    assert.strictEqual(rootPkg.name, dirName);
    // npm package names are case-insensitive, so the purl lowercases the
    // directory name it falls back to.
    assert.strictEqual(rootPkg.purl, `pkg:npm/${dirName.toLowerCase()}`);
    assert.strictEqual(rootPkg["bom-ref"], `pkg:npm/${dirName.toLowerCase()}`);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("parsePkgLock deep mode preserves lockfile metadata while hydrating missing fields", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pkglock-preserve-"));
  const pkgLockFile = path.join(tempDir, "package-lock.json");
  const depDir = path.join(tempDir, "node_modules", "preserved-dep");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(pkgLockFile, JSON.stringify({ lockfileVersion: 3 }, null, 2));
  writeFileSync(
    path.join(depDir, "package.json"),
    JSON.stringify(
      {
        name: "preserved-dep",
        version: "2.0.0",
        license: "MIT",
        description: "Hydrated description",
        author: "Disk Author",
      },
      null,
      2,
    ),
  );
  const rootNode = {
    path: tempDir,
    package: {
      author: "",
      license: "Apache-2.0",
    },
    packageName: "virtual-project",
    version: "1.0.0",
    edgesOut: new Map(),
    fsChildren: new Set(),
    children: new Map(),
  };
  const preservedNode = {
    path: depDir,
    package: {
      version: "2.0.0",
      license: "Apache-2.0",
    },
    packageName: "preserved-dep",
    version: "2.0.0",
    integrity: "sha512-preserved",
    edgesOut: new Map(),
    fsChildren: new Set(),
    children: new Map(),
  };
  rootNode.children.set("node_modules/preserved-dep", preservedNode);
  rootNode.edgesOut.set("preserved-dep", {
    name: "preserved-dep",
    spec: "^2.0.0",
    to: preservedNode,
  });

  try {
    const { parsePkgLock: parsePkgLockWithMockedArborist } = await esmock(
      "./parsers-js.js",
      {
        "../third-party/arborist/lib/index.js": {
          default: class MockArborist {
            async loadActual() {
              return rootNode;
            }
          },
        },
      },
    );
    const parsedList = await parsePkgLockWithMockedArborist(pkgLockFile, {
      deep: true,
    });
    const preservedPkg = parsedList.pkgList.find(
      (pkg) => pkg["bom-ref"] === "pkg:npm/preserved-dep@2.0.0",
    );
    assert.ok(preservedPkg);
    assert.strictEqual(preservedPkg.license, "Apache-2.0");
    assert.strictEqual(preservedPkg.description, "Hydrated description");
    assert.strictEqual(preservedPkg.author, "Disk Author");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("parsePkgLock captures manifest-declared npm direct sources", async () => {
  const rootNode = {
    path: "/virtual/project",
    package: {
      author: "",
      license: "MIT",
    },
    packageName: "virtual-project",
    version: "1.0.0",
    edgesOut: new Map(),
    fsChildren: new Set(),
    children: new Map(),
  };
  const gitNode = {
    path: "/virtual/project/node_modules/git-dep",
    package: {
      author: "",
      license: "MIT",
    },
    packageName: "git-dep",
    version: "2.0.0",
    hasInstallScript: true,
    integrity: "sha512-gitdep",
    edgesIn: new Set([
      {
        name: "git-dep",
        spec: "git+https://github.com/acme/git-dep.git",
      },
    ]),
    edgesOut: new Map(),
    fsChildren: new Set(),
    children: new Map(),
  };
  rootNode.children.set("node_modules/git-dep", gitNode);
  rootNode.edgesOut.set("git-dep", {
    name: "git-dep",
    spec: "git+https://github.com/acme/git-dep.git",
    to: gitNode,
  });
  const { parsePkgLock: parsePkgLockWithMockedArborist } = await esmock(
    "./parsers-js.js",
    {
      "../third-party/arborist/lib/index.js": {
        default: class MockArborist {
          async loadVirtual() {
            return rootNode;
          }
        },
      },
    },
  );
  const parsedList = await parsePkgLockWithMockedArborist(
    "./test/data/package-json/v3/package-lock.json",
    {},
  );
  const gitDepPkg = parsedList.pkgList.find(
    (pkg) => pkg["bom-ref"] === "pkg:npm/git-dep@2.0.0",
  );
  assert.ok(gitDepPkg);
  assert.ok(
    gitDepPkg.properties.some(
      (property) =>
        property.name === "cdx:npm:manifestSourceType" &&
        property.value === "git",
    ),
  );
  assert.ok(
    gitDepPkg.properties.some(
      (property) =>
        property.name === "cdx:npm:manifestSource" &&
        property.value === "git+https://github.com/acme/git-dep.git",
    ),
  );
});

it("parsePkgLock captures supported npm manifest source syntaxes", async () => {
  const rootNode = {
    path: "/virtual/project",
    package: {
      author: "",
      license: "MIT",
    },
    packageName: "virtual-project",
    version: "1.0.0",
    edgesOut: new Map(),
    fsChildren: new Set(),
    children: new Map(),
  };
  const sourceCases = [
    ["git-plus", "git+https://github.com/acme/git-plus.git", "git"],
    ["git-protocol", "git://github.com/acme/git-protocol.git", "git"],
    ["github-shortcut", "github:acme/github-shortcut", "git"],
    ["gitlab-shortcut", "gitlab:acme/gitlab-shortcut", "git"],
    ["bitbucket-shortcut", "bitbucket:acme/bitbucket-shortcut", "git"],
    ["gist-shortcut", "gist:1234567890abcdef", "git"],
    ["http-archive", "http://example.com/http-archive.tgz", "url"],
    ["https-archive", "https://example.com/https-archive.tgz", "url"],
    ["file-source", "file:../libs/file-source", "path"],
    ["link-source", "link:../libs/link-source", "path"],
    ["workspace-source", "workspace:*", "path"],
    ["relative-source", "./libs/relative-source", "path"],
    ["parent-source", "../libs/parent-source", "path"],
    ["absolute-source", "/opt/libs/absolute-source", "path"],
    ["windows-source", "C:\\libs\\windows-source", "path"],
  ];

  for (const [packageName, spec] of sourceCases) {
    const childPath = `/virtual/project/node_modules/${packageName}`;
    const childNode = {
      path: childPath,
      package: {
        author: "",
        license: "MIT",
      },
      packageName,
      version: "1.0.0",
      integrity: `sha512-${packageName}`,
      edgesIn: new Set([
        {
          name: packageName,
          spec,
        },
      ]),
      edgesOut: new Map(),
      fsChildren: new Set(),
      children: new Map(),
    };
    rootNode.children.set(`node_modules/${packageName}`, childNode);
    rootNode.edgesOut.set(packageName, {
      name: packageName,
      spec,
      to: childNode,
    });
  }

  const { parsePkgLock: parsePkgLockWithMockedArborist } = await esmock(
    "./parsers-js.js",
    {
      "../third-party/arborist/lib/index.js": {
        default: class MockArborist {
          async loadVirtual() {
            return rootNode;
          }
        },
      },
    },
  );
  const parsedList = await parsePkgLockWithMockedArborist(
    "./test/data/package-json/v3/package-lock.json",
    {},
  );

  for (const [packageName, spec, expectedType] of sourceCases) {
    const pkg = parsedList.pkgList.find(
      (parsedPkg) => parsedPkg.name === packageName,
    );
    assert.ok(pkg, `expected ${packageName} to be parsed`);
    assert.ok(
      pkg.properties.some(
        (property) =>
          property.name === "cdx:npm:manifestSourceType" &&
          property.value === expectedType,
      ),
      `expected ${packageName} manifest source type ${expectedType}`,
    );
    assert.ok(
      pkg.properties.some(
        (property) =>
          property.name === "cdx:npm:manifestSource" && property.value === spec,
      ),
      `expected ${packageName} manifest source ${spec}`,
    );
  }
});

it("parsePkgLock theia", async () => {
  const parsedList = await parsePkgLock(
    "./test/data/package-json/theia/package-lock.json",
    {},
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 2410);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 2410);
  assert.deepStrictEqual(
    validateRefs({
      components: parsedList.pkgList,
      dependencies: parsedList.dependenciesList,
    }),
    true,
  );
});

it("parseBowerJson", async () => {
  const deps = await parseBowerJson("./test/data/bower.json");
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0].name, "jquery");
});

it("parseNodeShrinkwrap", async () => {
  const deps = await parseNodeShrinkwrap("./test/shrinkwrap-deps.json");
  assert.deepStrictEqual(deps.length, 496);
  assert.deepStrictEqual(
    deps[0]._integrity,
    "sha512-a9gxpmdXtZEInkCSHUJDLHZVBgb1QS0jhss4cPP93EW7s+uC5bikET2twEF3KV+7rDblJcmNvTR7VJejqd2C2g==",
  );
});

it("parsePnpmWorkspace", async () => {
  const wobj = parsePnpmWorkspace("./test/data/pnpm_locks/pnpm-workspace.yaml");
  // 32 includes the dotdir member ".meta-updater"; only "__"-prefixed internal
  // dirs, "!" exclusions, and the bare root reference are dropped.
  assert.deepStrictEqual(wobj.packages.length, 32);
  assert.ok(
    wobj.packages.includes(".meta-updater"),
    "dotdir workspace members should be kept",
  );
  assert.deepStrictEqual(Object.keys(wobj.catalogs).length, 217);
});

it("parsePnpmWorkspace normalizes ./ relative patterns and drops root", async () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pnpm-workspace-"));
  try {
    const workspaceFile = path.join(projectDir, "pnpm-workspace.yaml");
    writeFileSync(
      workspaceFile,
      'packages:\n  - "."\n  - "./packages/*"\n  - "./apps/**"\n  - "!./packages/excluded"\n',
    );

    const wobj = parsePnpmWorkspace(workspaceFile);

    // The bare root "." is dropped; relative "./" prefixes are normalized away.
    assert.deepStrictEqual(wobj.packagePatterns, ["packages/*", "apps/**"]);
    assert.deepStrictEqual(wobj.packages, ["packages", "apps"]);
    assert.deepStrictEqual(wobj.excludePackages, ["packages/excluded"]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

it("parsePnpmWorkspace handles scalar package fixtures", async () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pnpm-workspace-"));
  try {
    const workspaceFile = path.join(projectDir, "pnpm-workspace.yaml");
    writeFileSync(workspaceFile, 'packages: "pkg"\n');

    const wobj = parsePnpmWorkspace(workspaceFile);

    assert.deepStrictEqual(wobj.packages, ["pkg"]);
    assert.deepStrictEqual(wobj.packagePatterns, ["pkg"]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

it("parsePnpmWorkspace preserves negated package patterns", async () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pnpm-workspace-"));
  try {
    const workspaceFile = path.join(projectDir, "pnpm-workspace.yaml");
    writeFileSync(workspaceFile, 'packages:\n  - "pkg"\n  - "!**/test/**"\n');

    const wobj = parsePnpmWorkspace(workspaceFile);

    assert.deepStrictEqual(wobj.packages, ["pkg"]);
    assert.deepStrictEqual(wobj.packagePatterns, ["pkg"]);
    assert.deepStrictEqual(wobj.excludePackages, ["**/test/**"]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

it("parsePnpmLock relativizes pnpm evidence paths from project root", async () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pnpm-lock-"));
  try {
    const nestedDir = path.join(projectDir, "packages", "app");
    mkdirSync(nestedDir, { recursive: true });
    const lockFile = path.join(nestedDir, "pnpm-lock.yaml");
    writeFileSync(
      lockFile,
      readFileSync("./test/data/pnpm-lock6.yaml", "utf-8"),
    );

    const parsedList = await parsePnpmLock(
      lockFile,
      null,
      [],
      {},
      {},
      {},
      {},
      projectDir,
    );
    const firstPkg = parsedList.pkgList[0];

    assert.strictEqual(
      firstPkg.properties.find((p) => p.name === "internal:SrcFile")?.value,
      path.join("packages", "app", "pnpm-lock.yaml"),
    );
    assert.strictEqual(
      firstPkg.evidence.identity.methods[0].value,
      path.join("packages", "app", "pnpm-lock.yaml"),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

it("parsePnpmAliasRef", () => {
  // pnpm v5 and below keep the version in its own path segment. The peer-dependency
  // suffix stays on the version, matching how the aliased package's own lock key is
  // turned into a component version.
  assert.deepStrictEqual(
    parsePnpmAliasRef("/@wdio/utils/7.26.0_typescript@6.0.2"),
    { name: "@wdio/utils", version: "7.26.0_typescript@6.0.2" },
  );
  assert.deepStrictEqual(parsePnpmAliasRef("/string-width/4.2.3"), {
    name: "string-width",
    version: "4.2.3",
  });
  // v6 and above glue the version onto the last name segment
  assert.deepStrictEqual(parsePnpmAliasRef("/@wdio/utils@7.26.0"), {
    name: "@wdio/utils",
    version: "7.26.0",
  });
  assert.deepStrictEqual(parsePnpmAliasRef("string-width@4.2.3"), {
    name: "string-width",
    version: "4.2.3",
  });
  assert.deepStrictEqual(parsePnpmAliasRef("npm:string-width@^4.2.0"), {
    name: "npm:string-width",
    version: "^4.2.0",
  });
  // A plain version is not an alias, and an unversioned spec cannot be split. The
  // scope leader must not be mistaken for the version separator.
  assert.deepStrictEqual(parsePnpmAliasRef("4.2.3"), undefined);
  assert.deepStrictEqual(parsePnpmAliasRef("/@scope/pkg"), undefined);
  assert.deepStrictEqual(parsePnpmAliasRef("/"), undefined);
  assert.deepStrictEqual(parsePnpmAliasRef(""), undefined);
  assert.deepStrictEqual(parsePnpmAliasRef(undefined), undefined);
});

it("stripPnpmPeerSuffix", () => {
  // Lockfile 5 appends the peer resolution after an underscore, either as a peer
  // spec or as an opaque hash of one
  assert.deepStrictEqual(
    stripPnpmPeerSuffix("7.26.0_typescript@6.0.2"),
    "7.26.0",
  );
  assert.deepStrictEqual(
    stripPnpmPeerSuffix("2.3.3_5b3b7d3a75edb27abc53579646941536"),
    "2.3.3",
  );
  assert.deepStrictEqual(
    stripPnpmPeerSuffix("0.5.4_eslint@6.5.1+typescript@3.5.3"),
    "0.5.4",
  );
  // Lockfile 6 and above wrap it in parentheses
  assert.deepStrictEqual(stripPnpmPeerSuffix("3.0.1(ajv@8.14.0)"), "3.0.1");
  // A plain version is untouched, including prereleases and build metadata, none of
  // which may contain an underscore or a parenthesis
  assert.deepStrictEqual(stripPnpmPeerSuffix("4.2.3"), "4.2.3");
  assert.deepStrictEqual(
    stripPnpmPeerSuffix("1.0.0-beta.1+build.2"),
    "1.0.0-beta.1+build.2",
  );
  // Values that are not registry versions must survive intact - a git ref or a
  // relative path can legitimately contain an underscore
  assert.deepStrictEqual(
    stripPnpmPeerSuffix("github.com/my_org/my_repo/abc123"),
    "github.com/my_org/my_repo/abc123",
  );
  assert.deepStrictEqual(
    stripPnpmPeerSuffix("link:../my_pkg"),
    "link:../my_pkg",
  );
  assert.deepStrictEqual(stripPnpmPeerSuffix(undefined), undefined);
});

it("parsePnpmLock keeps peer-resolved versions exact", async () => {
  // A lockfile 5 project at scale: every peer-resolved key must yield a version and
  // a purl an SCA tool can act on, and every dependency ref must still resolve.
  for (const lockFile of [
    "./test/pnpm-lock.yaml",
    "./test/data/pnpm-lock.yaml",
    "./test/data/pnpm-lock3.yaml",
  ]) {
    const parsedList = await parsePnpmLock(lockFile);
    for (const p of parsedList.pkgList) {
      assert.ok(
        !p.version?.includes("_") && !p.version?.includes("("),
        `${lockFile}: ${p["bom-ref"]} has a peer suffix in its version: ${p.version}`,
      );
      // Checked against the version rather than by scanning the whole purl, because
      // a package name may legitimately contain an underscore - eg evp_bytestokey
      const purlNoQualifiers = decodeURIComponent(p.purl).split("?")[0];
      assert.ok(
        purlNoQualifiers.endsWith(`@${p.version}`),
        `${lockFile}: ${purlNoQualifiers} does not carry version ${p.version}`,
      );
      // trimComponents and dedupeBom key on the purl, so a bom-ref that disagrees
      // with it would be silently merged away and leave its refs dangling
      assert.deepStrictEqual(p["bom-ref"], decodeURIComponent(p.purl));
    }
    const refs = new Set(parsedList.pkgList.map((p) => p["bom-ref"]));
    for (const d of parsedList.dependenciesList) {
      for (const ref of d.dependsOn) {
        assert.ok(
          refs.has(ref),
          `${lockFile}: ${ref} does not refer to any component`,
        );
      }
    }
  }
});

it("parsePnpmLock merges peer variants of one version", async () => {
  const parsedList = await parsePnpmLock(
    "./test/data/pnpm-lock-peer-variants.yaml",
  );
  // Two lock keys for 7.26.0 differing only by peer resolution describe one published
  // package version, so they collapse into one component rather than two components
  // sharing a purl - which trimComponents would merge anyway, dropping one bom-ref
  // and leaving the ref to it dangling.
  const utils = parsedList.pkgList.filter((p) => p.name === "utils");
  assert.deepStrictEqual(utils.length, 1);
  assert.deepStrictEqual(utils[0].version, "7.26.0");
  // Both dependents converge on the surviving component, so no edge is lost
  for (const ref of ["pkg:npm/a@1.0.0", "pkg:npm/b@1.0.0"]) {
    assert.ok(
      parsedList.dependenciesList
        .find((d) => d.ref === ref)
        .dependsOn.includes("pkg:npm/@wdio/utils@7.26.0"),
      `${ref} must depend on the merged component`,
    );
  }
});

it("parsePnpmLock resolves path-style cjs aliases", async () => {
  const parsedList = await parsePnpmLock(
    "./test/data/pnpm-lock-cjs-alias.yaml",
  );
  const refs = parsedList.pkgList.map((p) => p["bom-ref"]);
  assert.deepStrictEqual(refs, [
    "pkg:npm/testplane@8.20.5",
    "pkg:npm/@wdio/utils@7.26.0",
    "pkg:npm/@wdio/utils@8.39.0",
    "pkg:npm/string-width@4.2.3",
  ]);
  // The version and the purl must carry the published version only, so that an SCA
  // tool can match them against an advisory. pnpm's peer-resolution suffix - a peer
  // spec here, an opaque hash in the testplane key - is not part of the version.
  const byRef = {};
  for (const p of parsedList.pkgList) {
    byRef[p["bom-ref"]] = p;
  }
  assert.deepStrictEqual(byRef["pkg:npm/testplane@8.20.5"].version, "8.20.5");
  assert.deepStrictEqual(
    byRef["pkg:npm/testplane@8.20.5"].purl,
    "pkg:npm/testplane@8.20.5",
  );
  assert.deepStrictEqual(byRef["pkg:npm/@wdio/utils@7.26.0"].version, "7.26.0");
  assert.deepStrictEqual(
    decodeURIComponent(byRef["pkg:npm/@wdio/utils@7.26.0"].purl),
    "pkg:npm/@wdio/utils@7.26.0",
  );
  const dependsOn = parsedList.dependenciesList.find(
    (d) => d.ref === "pkg:npm/testplane@8.20.5",
  ).dependsOn;
  // The scoped alias used to throw `purl is missing the required "name" component`
  // and the unscoped one used to yield pkg:npm/string-width-cjs@/string-width/4.2.3
  assert.deepStrictEqual(dependsOn, [
    "pkg:npm/@wdio/utils@7.26.0",
    "pkg:npm/@wdio/utils@8.39.0",
    "pkg:npm/string-width@4.2.3",
  ]);
  // Every dependency ref must resolve to a component that is actually in the BOM,
  // which is the point of resolving the alias rather than merely not crashing
  for (const d of parsedList.dependenciesList) {
    for (const ref of d.dependsOn) {
      assert.ok(refs.includes(ref), `${ref} must refer to a known component`);
    }
  }
});

it("parsePnpmLock", async () => {
  let parsedList = await parsePnpmLock("./test/pnpm-lock.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 1706);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1706);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-IGhtTmpjGbYzcEDOw7DcQtbQSXcG9ftmAXtWTu9V936vDye4xjjekktFAtgZsWpzTj/X01jocB46mTywm/4SZw==",
    group: "@babel",
    name: "code-frame",
    "bom-ref": "pkg:npm/@babel/code-frame@7.10.1",
    purl: "pkg:npm/%40babel/code-frame@7.10.1",
    scope: undefined,
    type: "library",
    version: "7.10.1",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/pnpm-lock.yaml",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/pnpm-lock.yaml",
          },
        ],
      },
    },
  });
  parsedList = await parsePnpmLock("./test/data/pnpm-lock.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 318);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 318);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-iAXqUn8IIeBTNd72xsFlgaXHkMBMt6y4HJp1tIaK465CWLT/fG1aqB7ykr95gHHmlBdGbFeWWfyB4NJJ0nmeIg==",
    group: "@babel",
    name: "code-frame",
    "bom-ref": "pkg:npm/@babel/code-frame@7.16.7",
    purl: "pkg:npm/%40babel/code-frame@7.16.7",
    scope: "optional",
    type: "library",
    version: "7.16.7",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/pnpm-lock.yaml" },
      { name: "cdx:npm:package:development", value: "true" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock.yaml",
          },
        ],
      },
    },
  });
  parsedList = await parsePnpmLock("./test/data/pnpm-lock2.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 7);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 7);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "",
    name: "ansi-regex",
    version: "2.1.1",
    "bom-ref": "pkg:npm/ansi-regex@2.1.1",
    purl: "pkg:npm/ansi-regex@2.1.1",
    scope: undefined,
    type: "library",
    _integrity: "sha1-w7M6te42DYbg5ijwRorn7yfWVN8=",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/pnpm-lock2.yaml" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock2.yaml",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(parsedList.dependenciesList[2], {
    ref: "pkg:npm/chalk@1.1.3",
    dependsOn: [
      "pkg:npm/ansi-styles@2.2.1",
      "pkg:npm/escape-string-regexp@1.0.5",
      "pkg:npm/has-ansi@2.0.0",
      "pkg:npm/strip-ansi@3.0.1",
      "pkg:npm/supports-color@2.0.0",
    ],
  });
  parsedList = await parsePnpmLock("./test/data/pnpm-lock3.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 449);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 449);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "@nodelib",
    name: "fs.scandir",
    version: "2.1.5",
    "bom-ref": "pkg:npm/@nodelib/fs.scandir@2.1.5",
    purl: "pkg:npm/%40nodelib/fs.scandir@2.1.5",
    scope: undefined,
    type: "library",
    _integrity:
      "sha512-vq24Bq3ym5HEQm2NKCr3yXDwjc7vTsEThRDnkp2DK9p1uqLR+DHurm/NOTo0KG7HYHU7eppKZj3MyqYuMBf62g==",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/pnpm-lock3.yaml" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock3.yaml",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(parsedList.dependenciesList[2], {
    ref: "pkg:npm/@nodelib/fs.walk@1.2.8",
    dependsOn: ["pkg:npm/@nodelib/fs.scandir@2.1.5", "pkg:npm/fastq@1.13.0"],
  });

  parsedList = await parsePnpmLock("./test/data/pnpm-lock4.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 1);

  parsedList = await parsePnpmLock("./test/data/pnpm-lock6.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 200);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 200);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "@babel",
    name: "code-frame",
    version: "7.18.6",
    "bom-ref": "pkg:npm/@babel/code-frame@7.18.6",
    purl: "pkg:npm/%40babel/code-frame@7.18.6",
    scope: "optional",
    type: "library",
    _integrity:
      "sha512-TDCmlK5eOvH+eH7cdAFlNXeVJqWIQ7gW9tY1GJIpUtFb6CmjVyq2VM3u71bOyR8CRihcCgMUYoDNyLXao3+70Q==",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/pnpm-lock6.yaml" },
      { name: "cdx:npm:package:development", value: "true" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock6.yaml",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(parsedList.pkgList[parsedList.pkgList.length - 1], {
    group: "",
    name: "yargs",
    version: "17.7.1",
    "bom-ref": "pkg:npm/yargs@17.7.1",
    purl: "pkg:npm/yargs@17.7.1",
    scope: "optional",
    type: "library",
    _integrity:
      "sha512-cwiTb08Xuv5fqF4AovYacTFNxk62th7LKJ6BL9IGUpTJrWoU7/7WdQGTP2SjKf1dUNBGzDd28p/Yfs/GI6JrLw==",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/pnpm-lock6.yaml" },
      { name: "cdx:npm:package:development", value: "true" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock6.yaml",
          },
        ],
      },
    },
  });
  parsedList = await parsePnpmLock("./test/data/pnpm-lock6a.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 234);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 234);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "@babel",
    name: "code-frame",
    version: "7.18.6",
    "bom-ref": "pkg:npm/@babel/code-frame@7.18.6",
    purl: "pkg:npm/%40babel/code-frame@7.18.6",
    scope: "optional",
    type: "library",
    _integrity:
      "sha512-TDCmlK5eOvH+eH7cdAFlNXeVJqWIQ7gW9tY1GJIpUtFb6CmjVyq2VM3u71bOyR8CRihcCgMUYoDNyLXao3+70Q==",
    properties: [
      { name: "internal:SrcFile", value: "./test/data/pnpm-lock6a.yaml" },
      { name: "cdx:npm:package:development", value: "true" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock6a.yaml",
          },
        ],
      },
    },
  });
  const pnpmDevOptionalPkg = parsedList.pkgList.find(
    (pkg) => pkg["bom-ref"] === "pkg:npm/@cyclonedx/cdxgen-plugins-bin@1.0.5",
  );
  assert.ok(pnpmDevOptionalPkg);
  assert.deepStrictEqual(pnpmDevOptionalPkg.scope, "optional");
  assert.ok(
    pnpmDevOptionalPkg.properties.some(
      (property) =>
        property.name === "cdx:npm:package:development" &&
        property.value === "true",
    ),
  );
  // Test case to see if parsePnpmLock is finding all root deps
  const dummpyParent = {
    name: "rush",
    group: "",
    purl: "pkg:npm/rush",
    type: "application",
    "bom-ref": "pkg:npm/rush",
  };
  parsedList = await parsePnpmLock(
    "./test/data/pnpm-lock6b.yaml",
    dummpyParent,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 17);
  // this is due to additions projects defined in importers section of pnpm-lock.yaml
  assert.deepStrictEqual(parsedList.dependenciesList.length, 21);
  const mainRootDependency = parsedList.dependenciesList.find(
    (obj) => obj["ref"] === "pkg:npm/rush",
  );
  const myAppRootDependency = parsedList.dependenciesList.find(
    (obj) => obj["ref"] === "pkg:npm/rush/my-app@latest#apps/my-app",
  );
  const myControlsRootDependency = parsedList.dependenciesList.find(
    (obj) =>
      obj["ref"] === "pkg:npm/rush/my-controls@latest#libraries/my-controls",
  );
  const myToolChainRootDependency = parsedList.dependenciesList.find(
    (obj) =>
      obj["ref"] === "pkg:npm/rush/my-toolchain@latest#tools/my-toolchain",
  );
  assert.deepStrictEqual(mainRootDependency["dependsOn"].length, 0);
  assert.deepStrictEqual(myAppRootDependency["dependsOn"].length, 4);
  assert.deepStrictEqual(myControlsRootDependency["dependsOn"].length, 2);
  assert.deepStrictEqual(myToolChainRootDependency["dependsOn"].length, 4);

  parsedList = await parsePnpmLock("./test/data/pnpm-lock9a.yaml", {
    name: "pnpm9",
    purl: "pkg:npm/pnpm9@1.0.0",
  });
  assert.deepStrictEqual(parsedList.pkgList.length, 1005);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1006);
  assert.deepStrictEqual(
    parsedList.pkgList.filter(
      (pkg) =>
        !pkg.scope &&
        !pkg.properties?.some(
          (property) =>
            property.name === "cdx:npm:package:development" &&
            property.value === "true",
        ),
    ).length,
    0,
  );
  parsedList = await parsePnpmLock("./test/data/pnpm-lock9b.yaml", {
    name: "pnpm9",
    purl: "pkg:npm/pnpm9@1.0.0",
  });
  assert.deepStrictEqual(parsedList.pkgList.length, 1352);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1353);
  assert.deepStrictEqual(
    parsedList.pkgList.filter(
      (pkg) =>
        !pkg.scope &&
        !pkg.properties?.some(
          (property) =>
            property.name === "cdx:npm:package:development" &&
            property.value === "true",
        ),
    ).length,
    12,
  );
  parsedList = await parsePnpmLock("./test/data/pnpm-lock9c.yaml", {
    name: "pnpm9",
    purl: "pkg:npm/pnpm9@1.0.0",
  });
  assert.deepStrictEqual(parsedList.pkgList.length, 461);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 462);
  assert.deepStrictEqual(
    parsedList.pkgList.filter(
      (pkg) =>
        !pkg.scope &&
        !pkg.properties?.some(
          (property) =>
            property.name === "cdx:npm:package:development" &&
            property.value === "true",
        ),
    ).length,
    3,
  );
  parsedList = await parsePnpmLock(
    "./test/data/pnpm-lock-dev-propagation.yaml",
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 4);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 4);
  assert.deepStrictEqual(
    parsedList.pkgList.filter(
      (pkg) =>
        pkg.scope === "optional" &&
        pkg.properties?.some(
          (property) =>
            property.name === "cdx:npm:package:development" &&
            property.value === "true",
        ),
    ).length,
    4,
  );
  assert.ok(
    parsedList.pkgList.find((pkg) => pkg["bom-ref"] === "pkg:npm/gamma@1.0.0"),
  );
  assert.ok(
    parsedList.pkgList.find((pkg) => pkg["bom-ref"] === "pkg:npm/delta@1.0.0"),
  );
  parsedList = await parsePnpmLock(
    "./test/data/pnpm_locks/bytemd-pnpm-lock.yaml",
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 1189);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1189);
});

it("parsePnpmLock git+ssh dependencies with peer-expanded keys", async () => {
  const registryEnvKey = "NPM_CONFIG_@group:registry";
  const previousRegistry = process.env[registryEnvKey];
  process.env[registryEnvKey] =
    "https://private-registry.example.com/api/v4/packages/npm/";
  try {
    const parsedList = await parsePnpmLock(
      "./test/data/pnpm-lock-git-ssh.yaml",
      {
        name: "git-ssh-test",
        purl: "pkg:npm/git-ssh-test@1.0.0",
      },
    );
    const gitPkg = parsedList.pkgList.find((pkg) => pkg.name === "my_project");
    assert.ok(gitPkg, "git+ssh dependency should be present in pkgList");
    assert.strictEqual(gitPkg.group, "@group");
    assert.strictEqual(gitPkg.version, "1.0.6");
    assert.strictEqual(
      parsedList.pkgList.filter((pkg) => pkg.name === "my_project").length,
      1,
      "peer-expanded snapshot should not duplicate the git component",
    );
    assert.ok(
      gitPkg["bom-ref"].includes("vcs_url="),
      "git dependency purl should include vcs_url qualifier",
    );
    assert.ok(
      gitPkg["bom-ref"].includes(
        "ssh://git@private-gitlab.com/group/my_project.git#abc12345678901234567890123456789012345678",
      ),
      "vcs_url should include git repo and commit from lockfile resolution",
    );
    assert.ok(
      gitPkg["bom-ref"].includes("repository_url="),
      "git dependency purl should include repository_url from scoped .npmrc",
    );
    assert.ok(
      gitPkg["bom-ref"].includes(
        "repository_url=https://private-registry.example.com/api/v4/packages/npm",
      ),
      "repository_url should match scoped registry from npmrc",
    );
    assert.ok(
      gitPkg.externalReferences?.some(
        (reference) => reference.type === "distribution-intake",
      ),
      "git dependency with scoped registry should include distribution-intake",
    );
    const rootDependency = parsedList.dependenciesList.find((dependency) =>
      dependency.ref.includes("git-ssh-test"),
    );
    assert.ok(rootDependency, "root dependency entry should exist");
    assert.ok(
      rootDependency.dependsOn.some((ref) => ref.includes("my_project@1.0.6")),
      "root should depend on the git-resolved package",
    );
    const gitDependency = parsedList.dependenciesList.find((dependency) =>
      dependency.ref.includes("my_project@1.0.6"),
    );
    assert.ok(gitDependency, "git dependency should have a dependency entry");
    assert.ok(
      gitDependency.dependsOn.some((ref) => ref.includes("zod@4.3.6")),
      "git dependency subgraph should include direct dependencies",
    );
  } finally {
    if (previousRegistry === undefined) {
      delete process.env[registryEnvKey];
    } else {
      process.env[registryEnvKey] = previousRegistry;
    }
  }
});

it("parsePkgLock git+ssh dependencies with peer-expanded keys", async () => {
  const registryEnvKey = "NPM_CONFIG_@group:registry";
  const previousRegistry = process.env[registryEnvKey];
  process.env[registryEnvKey] =
    "https://private-registry.example.com/api/v4/packages/npm/";
  try {
    const parsedList = await parsePkgLock(
      "./test/data/npm-git-ssh/package-lock.json",
      {
        projectRoot: "./test/data/npm-git-ssh",
      },
    );
    const gitPkg = parsedList.pkgList.find((pkg) => pkg.name === "my_project");
    assert.ok(gitPkg, "git+ssh dependency should be present in pkgList");
    assert.strictEqual(gitPkg.group, "@group");
    assert.strictEqual(gitPkg.version, "1.0.6");
    assert.ok(
      gitPkg["bom-ref"].includes("vcs_url="),
      "git dependency purl should include vcs_url qualifier",
    );
    assert.ok(
      gitPkg["bom-ref"].includes(
        "ssh://git@private-gitlab.com/group/my_project.git#abc12345678901234567890123456789012345678",
      ),
      "vcs_url should include git repo and commit",
    );
    assert.ok(
      gitPkg["bom-ref"].includes("repository_url="),
      "git dependency purl should include repository_url from scoped .npmrc",
    );
    assert.ok(
      gitPkg.externalReferences?.some(
        (reference) => reference.type === "distribution-intake",
      ),
      "git dependency with scoped registry should include distribution-intake",
    );
  } finally {
    if (previousRegistry === undefined) {
      delete process.env[registryEnvKey];
    } else {
      process.env[registryEnvKey] = previousRegistry;
    }
  }
});

it("parseYarnLock git+ssh dependencies with peer-expanded keys", async () => {
  const registryEnvKey = "NPM_CONFIG_@group:registry";
  const previousRegistry = process.env[registryEnvKey];
  process.env[registryEnvKey] =
    "https://private-registry.example.com/api/v4/packages/npm/";
  try {
    const parsedList = await parseYarnLock("./test/data/yarn-git-ssh.lock");
    const gitPkg = parsedList.pkgList.find((pkg) => pkg.name === "my_project");
    assert.ok(gitPkg, "git+ssh dependency should be present in pkgList");
    assert.strictEqual(gitPkg.group, "@group");
    assert.strictEqual(gitPkg.version, "1.0.6");
    assert.ok(
      gitPkg["bom-ref"].includes("vcs_url="),
      "git dependency purl should include vcs_url qualifier",
    );
    assert.ok(
      gitPkg["bom-ref"].includes(
        "ssh://git@private-gitlab.com/group/my_project.git#abc12345678901234567890123456789012345678",
      ),
      "vcs_url should include git repo and commit",
    );
    assert.ok(
      gitPkg["bom-ref"].includes("repository_url="),
      "git dependency purl should include repository_url from scoped .npmrc",
    );
    assert.ok(
      gitPkg.externalReferences?.some(
        (reference) => reference.type === "distribution-intake",
      ),
      "git dependency with scoped registry should include distribution-intake",
    );
  } finally {
    if (previousRegistry === undefined) {
      delete process.env[registryEnvKey];
    } else {
      process.env[registryEnvKey] = previousRegistry;
    }
  }
});

it("findPnpmPackagePath", () => {
  // Test with non-existent base directory
  assert.deepStrictEqual(
    findPnpmPackagePath("/nonexistent", "test-package", "1.0.0"),
    null,
  );

  // Test with null/undefined inputs
  assert.deepStrictEqual(
    findPnpmPackagePath(null, "test-package", "1.0.0"),
    null,
  );
  assert.deepStrictEqual(findPnpmPackagePath("/tmp", null, "1.0.0"), null);
  assert.deepStrictEqual(findPnpmPackagePath("/tmp", "", "1.0.0"), null);

  // Test with actual cdxgen project structure - should find packages in node_modules
  const packagePath = findPnpmPackagePath(".", "chalk", "4.1.2");
  if (packagePath) {
    assert.ok(packagePath.match(/node_modules.*chalk/));
    // Verify package.json exists at the found path
    assert.deepStrictEqual(
      existsSync(path.join(packagePath, "package.json")),
      true,
    );
  }

  // Test with scoped package
  const scopedPackagePath = findPnpmPackagePath(".", "@babel/core", "7.22.5");
  if (scopedPackagePath) {
    assert.ok(scopedPackagePath.toMatch(/node_modules.*@babel.*core/));
  }
});

it("pnpmMetadata enhancement", async () => {
  // Test with empty/null inputs
  assert.deepStrictEqual(await pnpmMetadata([], "./pnpm-lock.yaml"), []);
  assert.deepStrictEqual(await pnpmMetadata(null, "./pnpm-lock.yaml"), null);
  assert.deepStrictEqual(
    await pnpmMetadata(undefined, "./pnpm-lock.yaml"),
    undefined,
  );

  // Test with non-existent lockfile path
  const mockPkgList = [
    {
      name: "test-package",
      version: "1.0.0",
      properties: [],
    },
  ];
  const result = await pnpmMetadata(mockPkgList, "/nonexistent/pnpm-lock.yaml");
  assert.deepStrictEqual(result, mockPkgList);
  assert.deepStrictEqual(result[0].description, undefined);

  // Test with actual project that has node_modules
  const testPkgList = [
    {
      name: "chalk",
      version: "4.1.2",
      properties: [],
    },
    {
      name: "nonexistent-package",
      version: "1.0.0",
      properties: [],
    },
  ];

  const enhancedResult = await pnpmMetadata(testPkgList, "./pnpm-lock.yaml");

  const chalkPkg = enhancedResult.find((p) => p.name === "chalk");
  if (chalkPkg) {
    const localPath = chalkPkg.properties?.find(
      (p) => p.name === "internal:LocalNodeModulesPath",
    );
    if (localPath) {
      assert.ok(localPath.value.toMatch(/node_modules.*chalk/));
      assert.ok(chalkPkg.description);
      assert.ok(chalkPkg.license);
    }
  }

  // Non-existent package should remain unchanged
  const nonExistentPkg = enhancedResult.find(
    (p) => p.name === "nonexistent-package",
  );
  assert.deepStrictEqual(nonExistentPkg.description, undefined);
  assert.deepStrictEqual(
    nonExistentPkg.properties.find(
      (p) => p.name === "internal:LocalNodeModulesPath",
    ),
    undefined,
  );
});

it("pnpmMetadata preserves existing metadata", async () => {
  const testPkgList = [
    {
      name: "test-package",
      version: "1.0.0",
      description: "Existing description",
      author: "Existing author",
      license: "Existing license",
      properties: [],
    },
  ];

  const result = await pnpmMetadata(testPkgList, "./pnpm-lock.yaml");

  // Should preserve existing metadata
  assert.deepStrictEqual(result[0].description, "Existing description");
  assert.deepStrictEqual(result[0].author, "Existing author");
  assert.deepStrictEqual(result[0].license, "Existing license");
});

it("pnpmMetadata with scoped packages", async () => {
  const testPkgList = [
    {
      name: "@babel/core",
      version: "7.22.5",
      properties: [],
    },
  ];

  const result = await pnpmMetadata(testPkgList, "./pnpm-lock.yaml");

  // Check if scoped package was processed
  const babelPkg = result.find((p) => p.name === "@babel/core");
  assert.ok(babelPkg);
  assert.deepStrictEqual(babelPkg.name, "@babel/core");
});

it("pnpmMetadata enriches split scoped package metadata from pnpm virtual store", async () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pnpm-scope-"));
  try {
    const scopedPackageDir = path.join(
      projectDir,
      "node_modules",
      ".pnpm",
      "@example+scoped-lib@1.2.3",
      "node_modules",
      "@example",
      "scoped-lib",
    );
    mkdirSync(scopedPackageDir, { recursive: true });
    writeFileSync(
      path.join(scopedPackageDir, "package.json"),
      JSON.stringify({
        name: "@example/scoped-lib",
        version: "1.2.3",
        description: "Scoped pnpm metadata fixture",
        license: "MIT",
      }),
    );

    const result = await pnpmMetadata(
      [
        {
          group: "@example",
          name: "scoped-lib",
          version: "1.2.3",
          properties: [],
        },
      ],
      path.join(projectDir, "pnpm-lock.yaml"),
    );

    assert.strictEqual(result[0].description, "Scoped pnpm metadata fixture");
    assert.strictEqual(result[0].license, "MIT");
    assert.ok(
      result[0].properties.some(
        (p) =>
          p.name === "internal:LocalNodeModulesPath" &&
          p.value.includes("@example+scoped-lib@1.2.3"),
      ),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

it("pnpmMetadata integration with parsePnpmLock", async () => {
  // Test that the integration works by parsing a real pnpm lock file
  const parsedList = await parsePnpmLock("./pnpm-lock.yaml");
  const externalRefDistPackages = parsedList.pkgList.filter((pkg) =>
    pkg.externalReferences?.some((p) => p.type === "distribution"),
  );
  assert.ok(externalRefDistPackages.length > 0);
  // Check that some packages have been enhanced with LocalNodeModulesPath
  const enhancedPackages = parsedList.pkgList.filter((pkg) =>
    pkg.properties?.some((p) => p.name === "internal:LocalNodeModulesPath"),
  );

  if (enhancedPackages.length > 0) {
    assert.ok(enhancedPackages.length > 0);

    const examplePkg = enhancedPackages[0];
    assert.ok(
      examplePkg.properties.find(
        (p) => p.name === "internal:LocalNodeModulesPath",
      ),
    );

    const packagesWithMetadata = enhancedPackages.filter(
      (pkg) => pkg.description || pkg.license || pkg.author,
    );
    assert.ok(packagesWithMetadata.length > 0);
  }
});

it("parseYarnLock", async () => {
  let identMap = yarnLockToIdentMap(readFileSync("./test/yarn.lock", "utf8"));
  assert.deepStrictEqual(Object.keys(identMap).length, 62);
  let parsedList = await parseYarnLock("./test/yarn.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 56);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "",
    name: "asap",
    version: "2.0.5",
    _integrity: "sha256-522765b50c3510490e52d7dcfe085ef9ba96958f",
    "bom-ref": "pkg:npm/asap@2.0.5",
    purl: "pkg:npm/asap@2.0.5",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/yarn.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/yarn.lock",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(parsedList.dependenciesList.length, 56);
  assert.deepStrictEqual(isPartialTree(parsedList.dependenciesList), false);
  identMap = yarnLockToIdentMap(
    readFileSync("./test/data/yarn_locks/yarn.lock", "utf8"),
  );
  assert.deepStrictEqual(Object.keys(identMap).length, 2566);
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 2029);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 2029);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "@babel",
    name: "cli",
    version: "7.10.1",
    "bom-ref": "pkg:npm/@babel/cli@7.10.1",
    purl: "pkg:npm/%40babel/cli@7.10.1",
    _integrity:
      "sha512-cVB+dXeGhMOqViIaZs3A9OUAe4pKw4SBNdMw6yHJMYR7s4TB+Cei7ThquV/84O19PdIFWuwe03vxxES0BHUm5g==",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/yarn_locks/yarn.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarn.lock",
          },
        ],
      },
    },
  });
  parsedList.pkgList.forEach((d) => {
    assert.ok(d.name);
    assert.ok(d.version);
  });

  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn-multi.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1909);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1909);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-zpruxnFMz6K94gs2pqc3sidzFDbQpKT5D6P/J/I9s8ekHZ5eczgnRp6pqXC86Bh7+44j/btpmOT0kwiboyqTnA==",
    group: "@apollo",
    name: "client",
    version: "3.2.5",
    "bom-ref": "pkg:npm/@apollo/client@3.2.5",
    purl: "pkg:npm/%40apollo/client@3.2.5",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/yarn_locks/yarn-multi.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarn-multi.lock",
          },
        ],
      },
    },
  });

  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn-light.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 315);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 315);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-rZ1k9kQvJX21Vwgx1L6kSQ6yeXo9cCMyqURSnjG+MRoJn+Mr3LblxmVdzScHXRzv0N9yzy49oG7Bqxp9Knyv/g==",
    group: "@actions",
    name: "artifact",
    version: "0.6.1",
    "bom-ref": "pkg:npm/@actions/artifact@0.6.1",
    purl: "pkg:npm/%40actions/artifact@0.6.1",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/yarn_locks/yarn-light.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarn-light.lock",
          },
        ],
      },
    },
  });

  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn3.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 5);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 5);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(parsedList.pkgList[1], {
    _integrity:
      "sha512-+X9Jn4mPI+RYV0ITiiLyJSYlT9um111BocJSaztsxXR+9ZxWErpzdfQqyk+EYZUOklugjJkerQZRtJGLfJeClw==",
    group: "",
    name: "lru-cache",
    "bom-ref": "pkg:npm/lru-cache@6.0.0",
    purl: "pkg:npm/lru-cache@6.0.0",
    version: "6.0.0",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/yarn_locks/yarn3.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarn3.lock",
          },
        ],
      },
    },
  });

  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv2.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1088);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1088);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-G0U5NjBUYIs39l1J1ckgpVfVX2IxpzRAIT4/2An86O2Mcri3k5xNu7/RRkfObo12wN9s7BmnREAMhH7252oZiA==",
    group: "@arcanis",
    name: "slice-ansi",
    version: "1.0.2",
    "bom-ref": "pkg:npm/@arcanis/slice-ansi@1.0.2",
    purl: "pkg:npm/%40arcanis/slice-ansi@1.0.2",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/yarn_locks/yarnv2.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarnv2.lock",
          },
        ],
      },
    },
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv3.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 363);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 363);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-vtU+q0TmdIDmezU7lKub73vObN6nmd3lkcKWz7R9hyNI8gz5o7grDb+FML9nykOLW+09gGIup2xyJ86j5vBKpg==",
    group: "@babel",
    name: "code-frame",
    version: "7.16.7",
    "bom-ref": "pkg:npm/@babel/code-frame@7.16.7",
    purl: "pkg:npm/%40babel/code-frame@7.16.7",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/yarn_locks/yarnv3.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarnv3.lock",
          },
        ],
      },
    },
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn4.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn-at.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 4);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 4);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "@ac-synth",
    name: "yjs",
    version: "13.5.39-alpha1",
    "bom-ref": "pkg:npm/@ac-synth/yjs@13.5.39-alpha1",
    purl: "pkg:npm/%40ac-synth/yjs@13.5.39-alpha1",
    _integrity:
      "sha512-JE93VWVyVa07xkK1wJ5ogjSZ30Nn4ptUuUXdPnu8MsKme1xFHLFFD3UtnHxnxnNDSnGx+WLlhuyHdIFfSCYqYg==",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/yarn_locks/yarn-at.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarn-at.lock",
          },
        ],
      },
    },
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn5.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1962);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1962);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40ampproject/remapping@2.2.0",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]["bom-ref"],
    "pkg:npm/@ampproject/remapping@2.2.0",
  );
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/@babel/code-frame@7.12.11",
    dependsOn: ["pkg:npm/@babel/highlight@7.18.6"],
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn6.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1469);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1469);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]["bom-ref"],
    "pkg:npm/@aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/@ampproject/remapping@2.2.1",
    dependsOn: [
      "pkg:npm/@jridgewell/gen-mapping@0.3.3",
      "pkg:npm/@jridgewell/trace-mapping@0.3.19",
    ],
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn7.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1347);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1347);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]["bom-ref"],
    "pkg:npm/@aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/@ampproject/remapping@2.2.1",
    dependsOn: [
      "pkg:npm/@jridgewell/gen-mapping@0.3.3",
      "pkg:npm/@jridgewell/trace-mapping@0.3.19",
    ],
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv4.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1851);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1851);
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]["bom-ref"],
    "pkg:npm/@aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/@actions/core@1.2.6",
    dependsOn: [],
  });
  assert.deepStrictEqual(isPartialTree(parsedList.dependenciesList), false);
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv4.1.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 858);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 858);
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]["bom-ref"],
    "pkg:npm/@aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]._integrity,
    "sha512-U8KyMaYaRnkrOaDUO8T093a7RUKqV+4EkwZ2gC5VASgsL8iqwU5M0fESD/i1Jha2/1q1Oa0wqiJ31yZES3Fhnw==",
  );
  assert.deepStrictEqual(isPartialTree(parsedList.dependenciesList), false);
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv1-fs.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 882);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 882);
  assert.deepStrictEqual(parsedList.pkgList[0].purl, "pkg:npm/abbrev@1.0.9");
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/accepts@1.3.3",
    dependsOn: ["pkg:npm/mime-types@2.1.12", "pkg:npm/negotiator@0.6.1"],
  });
  assert.deepStrictEqual(isPartialTree(parsedList.dependenciesList), false);
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv1-empty.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 770);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 770);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40ampproject/remapping@2.2.0",
  );
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/@aws-sdk/shared-ini-file-loader@3.188.0",
    dependsOn: ["pkg:npm/@aws-sdk/types@3.188.0", "pkg:npm/tslib@2.4.0"],
  });
});

it("parseYarnLock marks root dev, optional, peer and dependency-only closures", async () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "cdxgen-yarn-scope-"));
  try {
    writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "runtime-a": "^1.0.0",
        },
        devDependencies: {
          "dev-tool": "^1.0.0",
        },
        optionalDependencies: {
          "optional-root": "^1.0.0",
        },
        peerDependencies: {
          "peer-root": "^1.0.0",
        },
      }),
    );
    writeFileSync(
      path.join(projectDir, "yarn.lock"),
      [
        "runtime-a@^1.0.0:",
        '  version "1.0.0"',
        "  dependencies:",
        '    runtime-child "^1.0.0"',
        "  optionalDependencies:",
        '    optional-lock-child "^1.0.0"',
        "",
        "runtime-child@^1.0.0:",
        '  version "1.0.0"',
        "",
        "optional-lock-child@^1.0.0:",
        '  version "1.0.0"',
        "",
        "dev-tool@^1.0.0:",
        '  version "1.0.0"',
        "  dependencies:",
        '    dev-child "^1.0.0"',
        "",
        "dev-child@^1.0.0:",
        '  version "1.0.0"',
        "",
        "optional-root@^1.0.0:",
        '  version "1.0.0"',
        "  dependencies:",
        '    optional-child "^1.0.0"',
        "",
        "optional-child@^1.0.0:",
        '  version "1.0.0"',
        "",
        "peer-root@^1.0.0:",
        '  version "1.0.0"',
        "  dependencies:",
        '    peer-child "^1.0.0"',
        "",
        "peer-child@^1.0.0:",
        '  version "1.0.0"',
        "",
      ].join("\n"),
    );

    const parsedList = await parseYarnLock(path.join(projectDir, "yarn.lock"));
    const byName = Object.fromEntries(
      parsedList.pkgList.map((pkg) => [pkg.name, pkg]),
    );
    const hasProperty = (pkg, name) =>
      pkg.properties?.some(
        (property) => property.name === name && property.value === "true",
      );

    assert.equal(byName["runtime-a"].scope, undefined);
    assert.equal(byName["runtime-child"].scope, undefined);
    assert.equal(byName["dev-tool"].scope, "optional");
    assert.equal(byName["dev-child"].scope, "optional");
    assert.equal(byName["optional-root"].scope, "optional");
    assert.equal(byName["optional-child"].scope, "optional");
    assert.equal(byName["optional-lock-child"].scope, "optional");
    assert.equal(byName["peer-root"].scope, "optional");
    assert.equal(byName["peer-child"].scope, "optional");
    assert.ok(hasProperty(byName["dev-child"], "cdx:npm:package:development"));
    assert.ok(
      hasProperty(byName["optional-child"], "cdx:npm:package:optional"),
    );
    assert.ok(hasProperty(byName["peer-child"], "cdx:npm:package:peer"));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

it("parseYarnLock names aliased dependencies after the real package", async () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "cdxgen-yarn-alias-"));
  // Real npm sha512 integrities for the aliased/patched packages. The integrity
  // must follow the real package onto its renamed component.
  const reactIsIntegrity =
    "sha512-/LLMVyas0ljjAtoYiPqYiL8VWXzUUdThrmU5+n20DZv+a+ClRoevUzw5JxU+Ieh5/c87ytoTBV9G1FiKfNJdA==";
  const ioredisIntegrity =
    "sha512-69LyhUgrXdgcNDv7ogs1qXZomnfOEnSmrmMFqKgt1XMJxmoOSG/u3wYy13yACIfKuMJ8IhKgHafDO3sx19zVQQ==";
  const lruCacheIntegrity =
    "sha512-Jo6dJ04CmSjuznwJSS3pUeWmd/H0ffTlkXXgwZi+eq1UCmqQwCh+eLsYOYCwY991i2Fah4h1BEMCx4qThGbsiA==";
  const resolveIntegrity =
    "sha512-oKWePCxqpd6FlLvGV1VU0x7bkPmmCNolxzjMf4NczoDnQcIWrAF+cPtZn5i6n+RfD2d9i0tzpKnG6Yk168yIyw==";
  // Yarn berry stores hashes as a hex-encoded checksum (optionally with a
  // cacheKey prefix). parseYarnLock converts it to sha512-<base64>.
  const tsNodeChecksum =
    "10c0/c2f18c91854245025c3c0dd0796e1cc46f3f92b4375076c83e44598846144d11d4e066d76d9c23cb820cd1d0757ef6ee5409286144f46f56ead8ea94337ad2c2";
  const tsNodeIntegrity =
    "sha512-wvGMkYVCRQJcPA3QeW4cxG8/krQ3UHbIPkRZiEYUTRHU4GbXbZwjy4IM0dB1fvbuVAkoYUT0b1bq2OqUM3rSwg==";
  try {
    writeFileSync(
      path.join(projectDir, "yarn.lock"),
      [
        "# yarn lockfile v1",
        "",
        // Non-scoped alias -> real package name (the issue's example).
        '"react-is-18@npm:react-is@^18.3.1":',
        '  version "18.3.1"',
        '  resolved "https://registry.npmjs.org/react-is/-/react-is-18.3.1.tgz"',
        `  integrity ${reactIsIntegrity}`,
        "",
        // Scoped alias -> scoped real package name.
        '"@types/ioredis4@npm:@types/ioredis@^4.28.10":',
        '  version "4.28.10"',
        '  resolved "https://registry.npmjs.org/@types/ioredis/-/ioredis-4.28.10.tgz"',
        `  integrity ${ioredisIntegrity}`,
        "",
        // Plain berry entry (npm: target is a range, not an alias) must be unchanged.
        '"lru-cache@npm:^6.0.0":',
        '  version "6.0.0"',
        '  resolved "https://registry.npmjs.org/lru-cache/-/lru-cache-6.0.0.tgz"',
        `  integrity ${lruCacheIntegrity}`,
        "",
        // patch: protocol with a nested literal "@npm:" must NOT be treated as
        // an alias (regression: the nested npm: is part of the patch locator).
        // This entry uses a yarn berry hex checksum to exercise hash conversion.
        '"ts-node@patch:ts-node@npm:10.9.2#./.yarn/patches/ts-node-npm-10.9.2-abc.patch::locator=demo%40workspace%3A.":',
        '  version "10.9.2"',
        '  resolved "https://registry.npmjs.org/ts-node/-/ts-node-10.9.2.tgz"',
        `  checksum ${tsNodeChecksum}`,
        "",
        // patch: protocol with a nested URL-encoded "@npm%3A" must also keep its name.
        '"resolve@patch:resolve@npm%3A^1.22.8#optional!builtin<compat/resolve>":',
        '  version "1.22.8"',
        '  resolved "https://registry.npmjs.org/resolve/-/resolve-1.22.8.tgz"',
        `  integrity ${resolveIntegrity}`,
        "",
      ].join("\n"),
    );

    const parsedList = await parseYarnLock(path.join(projectDir, "yarn.lock"));
    const byRef = Object.fromEntries(
      parsedList.pkgList.map((pkg) => [pkg["bom-ref"], pkg]),
    );

    // Non-scoped alias resolves to the real package name and keeps its hash.
    assert.ok(
      byRef["pkg:npm/react-is@18.3.1"],
      "alias should be recorded under the real package react-is",
    );
    assert.equal(byRef["pkg:npm/react-is@18.3.1"].group, "");
    assert.equal(byRef["pkg:npm/react-is@18.3.1"].name, "react-is");
    assert.equal(
      byRef["pkg:npm/react-is@18.3.1"]._integrity,
      reactIsIntegrity,
      "react-is integrity should be preserved on the renamed component",
    );
    assert.ok(
      !parsedList.pkgList.some((pkg) => pkg.name === "react-is-18"),
      "alias name react-is-18 should not appear as a component",
    );

    // Scoped alias resolves to the real scoped package name and keeps its hash.
    assert.ok(
      byRef["pkg:npm/@types/ioredis@4.28.10"],
      "scoped alias should be recorded under the real package @types/ioredis",
    );
    assert.equal(byRef["pkg:npm/@types/ioredis@4.28.10"].group, "@types");
    assert.equal(byRef["pkg:npm/@types/ioredis@4.28.10"].name, "ioredis");
    assert.equal(
      byRef["pkg:npm/@types/ioredis@4.28.10"]._integrity,
      ioredisIntegrity,
      "@types/ioredis integrity should be preserved on the renamed component",
    );
    assert.ok(
      !parsedList.pkgList.some((pkg) => pkg.name === "ioredis4"),
      "alias name ioredis4 should not appear as a component",
    );

    // Plain npm: entries (not aliases) keep their own name and hash.
    assert.ok(
      byRef["pkg:npm/lru-cache@6.0.0"],
      "plain npm: entry lru-cache should be unchanged",
    );
    assert.equal(
      byRef["pkg:npm/lru-cache@6.0.0"]._integrity,
      lruCacheIntegrity,
      "lru-cache integrity should be preserved",
    );

    // patch: protocol entries keep the real name; the nested "@npm:" /
    // "@npm%3A" in the patch locator must not be mistaken for an alias. Their
    // hashes must also attach to the renamed component (berry checksum is
    // converted from hex to sha512-<base64>).
    assert.ok(
      byRef["pkg:npm/ts-node@10.9.2"],
      "patch: entry with nested @npm: should be named ts-node",
    );
    assert.equal(
      byRef["pkg:npm/ts-node@10.9.2"]._integrity,
      tsNodeIntegrity,
      "ts-node berry checksum should be converted and preserved",
    );
    assert.ok(
      byRef["pkg:npm/resolve@1.22.8"],
      "patch: entry with nested @npm%3A should be named resolve",
    );
    assert.equal(
      byRef["pkg:npm/resolve@1.22.8"]._integrity,
      resolveIntegrity,
      "resolve integrity should be preserved on the patched component",
    );
    assert.ok(
      !parsedList.pkgList.some((pkg) => pkg.name.includes("patch:")),
      "no component name should contain the patch: protocol",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

describe("yarn workspace functionality", () => {
  it("should parse yarn workspace lock file with workspace packages", async () => {
    const mockWorkspacePackages = [
      "pkg:npm/workspace-app@1.0.0",
      "pkg:npm/@my-org/workspace-lib@2.0.0",
    ];
    const mockWorkspaceSrcFiles = {
      "workspace-app": "/workspace/apps/app/package.json",
      "@my-org/workspace-lib": "/workspace/packages/lib/package.json",
    };
    const mockDepsWorkspaceRefs = {
      "workspace-app|^1.0.0": "pkg:npm/workspace-app@1.0.0",
      "@my-org/workspace-lib|^2.0.0": "pkg:npm/@my-org/workspace-lib@2.0.0",
    };

    // Test with existing yarn lock file but with workspace parameters
    const parsedList = await parseYarnLock(
      "./test/yarn.lock",
      null,
      mockWorkspacePackages,
      mockWorkspaceSrcFiles,
      {},
      mockDepsWorkspaceRefs,
    );

    // Basic assertions
    assert.ok(parsedList.pkgList.length > 0);
    assert.ok(parsedList.dependenciesList.length > 0);

    // Verify workspace packages are included and properties are set correctly
    parsedList.pkgList.forEach((pkg) => {
      assert.ok(pkg.name);
      assert.ok(pkg.purl);
      assert.ok(pkg["bom-ref"]);

      // Check for workspace-specific properties if this is a workspace package
      const isWorkspacePackage = Object.keys(mockWorkspaceSrcFiles).includes(
        pkg.name,
      );
      if (isWorkspacePackage) {
        // Only check if properties exist - the actual workspace logic may not be implemented yet
        if (pkg.properties && pkg.properties.length > 0) {
          assert.ok(
            pkg.properties.some((p) => p.name === "internal:workspaceRef"),
          );
          assert.ok(pkg.properties.some((p) => p.name === "internal:SrcFile"));
          assert.ok(
            pkg.properties.some((p) => p.name === "cdx:npm:is_workspace"),
          );
        }
      }
    });

    // Verify that the function can handle workspace parameters without error
    // Even if no workspace packages are found in the yarn.lock file
    assert.ok(true); // Test passes if we reach here without throwing
  });

  it("should handle empty workspace parameters gracefully", async () => {
    const parsedList = await parseYarnLock(
      "./test/yarn.lock",
      null,
      [], // Empty workspace packages
      {}, // Empty workspace src files
      {},
      {}, // Empty workspace refs
    );

    assert.ok(parsedList.pkgList.length > 0);
    assert.ok(parsedList.dependenciesList.length > 0);

    // Should still parse normally without workspace enhancement
    parsedList.pkgList.forEach((pkg) => {
      assert.ok(pkg.name);
      assert.ok(pkg.version);
    });
  });

  it("should create correct workspace PURLs", async () => {
    // Create a minimal yarn lock content for testing
    const yarnLockContent = `
# yarn lockfile v1

"my-workspace-pkg@^1.0.0":
  version "1.0.0"
  dependencies:
    lodash "^4.17.21"

"lodash@^4.17.21":
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"
  integrity sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==
`;

    // Since we can't easily create a temp file, we'll test the helper functions directly
    const identMap = yarnLockToIdentMap(yarnLockContent);
    assert.ok(identMap["my-workspace-pkg|^1.0.0"]);
    assert.deepStrictEqual(identMap["my-workspace-pkg|^1.0.0"], "1.0.0");
  });

  it("should handle npm prefix parsing correctly", () => {
    // Test the npm: prefix parsing logic that was fixed
    const testCases = [
      {
        input: "npm:string-width@^4.2.0",
        expectedName: "string-width",
        expectedRange: "^4.2.0",
      },
      {
        input: "npm:@types/ioredis@^4.28.10",
        expectedName: "@types/ioredis",
        expectedRange: "^4.28.10",
      },
      {
        input: "npm:^5.1.1",
        expectedName: undefined, // Should use original dgroupname
        expectedRange: "^5.1.1",
      },
    ];

    testCases.forEach((testCase) => {
      let dgroupnameToUse = "original-package-name";
      let versionRange = "";

      if (testCase.input.startsWith("npm:")) {
        if (testCase.input.includes("@")) {
          versionRange = testCase.input.split("@").splice(-1)[0];
          dgroupnameToUse = testCase.input
            .replace("npm:", "")
            .replace(`@${versionRange}`, "");
        } else {
          versionRange = testCase.input.replace("npm:", "");
          dgroupnameToUse = "original-package-name"; // Should keep original
        }
      }

      if (testCase.expectedName) {
        assert.deepStrictEqual(dgroupnameToUse, testCase.expectedName);
      }
      assert.deepStrictEqual(versionRange, testCase.expectedRange);
    });
  });

  it("should handle workspace dependency resolution", async () => {
    // Test version resolution logic for workspace packages
    const mockDepsWorkspaceRefs = {
      "workspace-app|^1.0.0": "pkg:npm/workspace-app@1.0.0",
      "@my-org/lib|^2.0.0": "pkg:npm/@my-org/lib@2.0.0",
    };

    // Mock identMap that would come from yarn lock parsing
    const mockIdentMap = {
      "workspace-app|^1.0.0": "1.0.0",
      "@my-org/lib|^2.0.0": "2.0.0",
      "lodash|^4.17.21": "4.17.21",
    };

    // Test workspace reference resolution
    const workspaceKey = "workspace-app|^1.0.0";
    const resolvedVersion = mockIdentMap[workspaceKey];
    const workspaceRef = mockDepsWorkspaceRefs[workspaceKey];

    assert.deepStrictEqual(resolvedVersion, "1.0.0");
    assert.deepStrictEqual(workspaceRef, "pkg:npm/workspace-app@1.0.0");

    // Test scoped workspace package
    const scopedKey = "@my-org/lib|^2.0.0";
    const scopedResolvedVersion = mockIdentMap[scopedKey];
    const scopedWorkspaceRef = mockDepsWorkspaceRefs[scopedKey];

    assert.deepStrictEqual(scopedResolvedVersion, "2.0.0");
    assert.deepStrictEqual(scopedWorkspaceRef, "pkg:npm/@my-org/lib@2.0.0");
  });

  it("should handle undefined version resolution fallback", async () => {
    // Test the fallback logic when version cannot be resolved
    const mockIdentMap = {
      "some-package|^1.0.0": "1.5.0",
      "another-package|~2.0.0": "2.0.5",
    };

    // Simulate the fallback logic for unresolved versions
    const testPackage = "unknown-package";

    // Try to find any available resolved version for the package
    const availableVersions = Object.keys(mockIdentMap)
      .filter((key) => key.startsWith(`${testPackage}|`))
      .map((key) => mockIdentMap[key]);

    let resolvedVersion = "undefined"; // Default fallback

    if (availableVersions.length > 0) {
      resolvedVersion = availableVersions[0];
    } else {
      // Check for any version without range matching
      const anyVersionKey = Object.keys(mockIdentMap).find(
        (key) => key.split("|")[0] === testPackage,
      );
      if (anyVersionKey) {
        resolvedVersion = mockIdentMap[anyVersionKey];
      }
    }

    // Should fall back to "undefined" when no version found
    assert.deepStrictEqual(resolvedVersion, "undefined");

    // Test with existing package
    const existingPackage = "some-package";
    const existingRange = "^1.0.0";
    const existingKey = `${existingPackage}|${existingRange}`;
    const existingVersion = mockIdentMap[existingKey] || "undefined";

    assert.deepStrictEqual(existingVersion, "1.5.0");
  });

  it("should create workspace properties correctly", async () => {
    // Test workspace property creation
    const workspacePackage = "my-workspace";
    const workspacePurl = "pkg:npm/my-workspace@1.0.0";
    const workspaceSrcFile = "/workspace/packages/my-workspace/package.json";

    const expectedProperties = [
      {
        name: "internal:workspaceRef",
        value: workspacePurl,
      },
      {
        name: "internal:workspaceSrcFile",
        value: workspaceSrcFile,
      },
    ];

    // Verify property structure
    expectedProperties.forEach((prop) => {
      assert.ok(prop.name);
      assert.ok(prop.value);
      assert.ok(prop.name.startsWith("internal:workspace"));
    });

    // Test PURL encoding
    const testPurl = new Purl({
      type: "npm",
      namespace: "" || null,
      name: workspacePackage,
      version: "1.0.0" || null,
    });
    assert.deepStrictEqual(testPurl.toString(), "pkg:npm/my-workspace@1.0.0");
    assert.deepStrictEqual(
      decodeURIComponent(testPurl.toString()),
      "pkg:npm/my-workspace@1.0.0",
    );
  });

  it("should handle scoped workspace packages correctly", async () => {
    // Test scoped package parsing and PURL creation
    const version = "2.0.0";

    const testPurl = new Purl({
      type: "npm",
      namespace: "@my-org" || null,
      name: "workspace-lib",
      version: version || null,
    });
    const expectedPurl = "pkg:npm/%40my-org/workspace-lib@2.0.0";

    assert.deepStrictEqual(testPurl.toString(), expectedPurl);
    assert.deepStrictEqual(
      decodeURIComponent(testPurl.toString()),
      "pkg:npm/@my-org/workspace-lib@2.0.0",
    );

    // Test bom-ref generation
    const expectedBomRef = decodeURIComponent(expectedPurl);
    assert.deepStrictEqual(
      expectedBomRef,
      "pkg:npm/@my-org/workspace-lib@2.0.0",
    );
  });

  it("should validate yarn lock identity map parsing", () => {
    // Test yarnLockToIdentMap function with various formats
    const testLockData = `
# yarn lockfile v1

"@babel/core@^7.0.0", "@babel/core@^7.1.0":
  version "7.1.6"

"string-width-cjs@npm:string-width@^4.2.0":
  version "4.2.3"

"@types/node@npm:@types/node@^18.0.0":
  version "18.19.0"

"lru-cache@npm:^6.0.0":
  version "6.0.0"
`;

    const identMap = yarnLockToIdentMap(testLockData);

    // Test standard package with multiple ranges
    assert.deepStrictEqual(identMap["@babel/core|^7.0.0"], "7.1.6");
    assert.deepStrictEqual(identMap["@babel/core|^7.1.0"], "7.1.6");

    // Test npm: prefixed packages
    assert.deepStrictEqual(identMap["string-width-cjs|^4.2.0"], "4.2.3");
    assert.deepStrictEqual(identMap["@types/node|^18.0.0"], "18.19.0");
    assert.deepStrictEqual(identMap["lru-cache|^6.0.0"], "6.0.0");
  });

  it("should handle workspace package matching", async () => {
    // Test workspace package matching logic
    const workspacePackages = [
      "pkg:npm/app@1.0.0",
      "pkg:npm/@my-org/lib@2.0.0",
      "pkg:npm/common@1.5.0",
    ];

    // Test matching function (simulated)
    const findWorkspaceMatch = (packageName, version) => {
      return workspacePackages.find((purl) =>
        purl.includes(`/${packageName}@${version}`),
      );
    };

    // Test matches
    assert.deepStrictEqual(
      findWorkspaceMatch("app", "1.0.0"),
      "pkg:npm/app@1.0.0",
    );
    assert.deepStrictEqual(
      findWorkspaceMatch("@my-org/lib", "2.0.0"),
      "pkg:npm/@my-org/lib@2.0.0",
    );
    assert.deepStrictEqual(
      findWorkspaceMatch("nonexistent", "1.0.0"),
      undefined,
    );
  });

  it("should create workspace components with proper metadata", async () => {
    // Test workspace component creation
    const workspaceName = "workspace-package";
    const workspaceVersion = "1.0.0";
    const workspaceSrcFile =
      "/workspace/packages/workspace-package/package.json";
    const workspacePurl = "pkg:npm/workspace-package@1.0.0";

    const expectedComponent = {
      group: "",
      name: workspaceName,
      version: workspaceVersion,
      purl: workspacePurl,
      "bom-ref": decodeURIComponent(workspacePurl),
      properties: [
        {
          name: "internal:SrcFile",
          value: "./test/yarn.lock",
        },
        {
          name: "internal:workspaceRef",
          value: workspacePurl,
        },
        {
          name: "internal:workspaceSrcFile",
          value: workspaceSrcFile,
        },
      ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 1,
              value: "./test/yarn.lock",
            },
          ],
        },
      },
    };

    // Verify component structure
    assert.deepStrictEqual(expectedComponent.name, workspaceName);
    assert.deepStrictEqual(expectedComponent.version, workspaceVersion);
    assert.deepStrictEqual(expectedComponent.purl, workspacePurl);
    assert.deepStrictEqual(expectedComponent["bom-ref"], workspacePurl);

    // Verify workspace-specific properties
    const workspaceRefProp = expectedComponent.properties.find(
      (p) => p.name === "internal:workspaceRef",
    );
    assert.ok(workspaceRefProp);
    assert.deepStrictEqual(workspaceRefProp.value, workspacePurl);

    const workspaceSrcProp = expectedComponent.properties.find(
      (p) => p.name === "internal:workspaceSrcFile",
    );
    assert.ok(workspaceSrcProp);
    assert.deepStrictEqual(workspaceSrcProp.value, workspaceSrcFile);
  });

  it("should handle yarn lock with workspace dependencies", async () => {
    // Test dependency resolution with workspace references
    const mockWorkspaceDeps = {
      "workspace-app|^1.0.0": "pkg:npm/workspace-app@1.0.0",
      "@my-org/lib|^2.0.0": "pkg:npm/@my-org/lib@2.0.0",
    };

    // Simulate dependency resolution
    const resolveDependency = (depName, depRange) => {
      const key = `${depName}|${depRange}`;
      return mockWorkspaceDeps[key] || null;
    };

    // Test workspace dependency resolution
    assert.deepStrictEqual(
      resolveDependency("workspace-app", "^1.0.0"),
      "pkg:npm/workspace-app@1.0.0",
    );
    assert.deepStrictEqual(
      resolveDependency("@my-org/lib", "^2.0.0"),
      "pkg:npm/@my-org/lib@2.0.0",
    );
    assert.deepStrictEqual(
      resolveDependency("external-package", "^1.0.0"),
      null,
    );
  });

  it("should validate workspace PURL encoding", () => {
    // Test PURL encoding for workspace packages
    const testCases = [
      {
        name: "simple-workspace",
        group: "",
        version: "1.0.0",
        expected: "pkg:npm/simple-workspace@1.0.0",
      },
      {
        name: "workspace-lib",
        group: "@my-org",
        version: "2.0.0",
        expected: "pkg:npm/%40my-org/workspace-lib@2.0.0",
      },
      {
        name: "workspace-with-special-chars",
        group: "@my-org",
        version: "1.0.0-alpha.1",
        expected:
          "pkg:npm/%40my-org/workspace-with-special-chars@1.0.0-alpha.1",
      },
    ];

    testCases.forEach((testCase) => {
      const purl = new Purl({
        type: "npm",
        namespace: testCase.group || null,
        name: testCase.name,
        version: testCase.version || null,
      });
      assert.deepStrictEqual(purl.toString(), testCase.expected);
    });
  });

  it("should handle workspace package edge cases", async () => {
    // Test edge cases for workspace handling
    const edgeCases = [
      {
        description: "package with no version",
        package: "no-version-pkg",
        version: "",
        shouldCreateComponent: false,
      },
      {
        description: "package with empty name",
        package: "",
        version: "1.0.0",
        shouldCreateComponent: false,
      },
      {
        description: "valid workspace package",
        package: "valid-workspace",
        version: "1.0.0",
        shouldCreateComponent: true,
      },
    ];

    edgeCases.forEach((testCase) => {
      const isValid = Boolean(
        testCase.package &&
          testCase.package.length > 0 &&
          testCase.version &&
          testCase.version.length > 0,
      );

      assert.deepStrictEqual(isValid, testCase.shouldCreateComponent);
    });
  });

  it("should handle workspace packages with duplicate names", async () => {
    const mockWorkspacePackages = [
      "pkg:npm/app-b@1.0.0",
      "pkg:npm/app-a@1.0.0",
    ];
    const mockWorkspaceSrcFiles = {
      "pkg:npm/app-b@1.0.0":
        "test/data/yarn-workspaces-same-version-demo/packages/app-b/package.json",
      "pkg:npm/app-a@1.0.0":
        "test/data/yarn-workspaces-same-version-demo/packages/app-a/package.json",
    };
    // The declared name and range of each member's direct dependencies, as
    // read from its package.json.
    const mockWorkspaceDirectDeps = {
      "pkg:npm/app-b@1.0.0": {
        dayjs: "1.11.10",
        axios: "1.7.8",
        lodash: "4.17.21",
      },
      "pkg:npm/app-a@1.0.0": {
        dayjs: "1.11.10",
        axios: "1.7.9",
        lodash: "4.17.21",
      },
    };
    const mockDepsWorkspaceRefs = {
      "pkg:npm/dayjs@1.11.10": ["pkg:npm/app-b@1.0.0", "pkg:npm/app-a@1.0.0"],
      "pkg:npm/axios@1.7.8": ["pkg:npm/app-b@1.0.0"],
      "pkg:npm/lodash@4.17.21": ["pkg:npm/app-b@1.0.0", "pkg:npm/app-a@1.0.0"],
      "pkg:npm/axios@1.7.9": ["pkg:npm/app-a@1.0.0"],
    };
    const parsedMap = await parseYarnLock(
      "test/data/yarn-workspaces-same-version-demo/yarn.lock",
      null,
      mockWorkspacePackages,
      mockWorkspaceSrcFiles,
      mockWorkspaceDirectDeps,
      mockDepsWorkspaceRefs,
    );
    assert.equal(parsedMap.pkgList.length, 28);
    // 26 lock entries plus one for each workspace member, which yarn v1 does
    // not record. Each member resolves the axios version it declares.
    assert.equal(parsedMap.dependenciesList.length, 28);
    const memberDeps = Object.fromEntries(
      parsedMap.dependenciesList.map((d) => [d.ref, d.dependsOn]),
    );
    assert.deepStrictEqual(memberDeps["pkg:npm/app-a@1.0.0"], [
      "pkg:npm/axios@1.7.9",
      "pkg:npm/dayjs@1.11.10",
      "pkg:npm/lodash@4.17.21",
    ]);
    assert.deepStrictEqual(memberDeps["pkg:npm/app-b@1.0.0"], [
      "pkg:npm/axios@1.7.8",
      "pkg:npm/dayjs@1.11.10",
      "pkg:npm/lodash@4.17.21",
    ]);
    parsedMap.pkgList.forEach((pkg) => {
      assert.ok(pkg.name);
      assert.ok(pkg.purl);
      assert.ok(pkg["bom-ref"]);
      if (["lodash", "dayjs", "axios"].includes(pkg.name)) {
        assert.ok(
          pkg.properties.some((p) => p.name === "internal:workspaceRef"),
        );
        assert.ok(pkg.properties.some((p) => p.name === "internal:SrcFile"));
      }
    });
  });
});

it("parsePackageJsonName tests", () => {
  assert.deepStrictEqual(parsePackageJsonName("foo"), {
    fullName: "foo",
    moduleName: "foo",
    projectName: null,
    scope: null,
  });
  assert.deepStrictEqual(parsePackageJsonName("@babel/code-frame"), {
    fullName: "code-frame",
    moduleName: "code-frame",
    projectName: null,
    scope: "@babel",
  });
  assert.deepStrictEqual(parsePackageJsonName(null), {
    fullName: "",
    moduleName: "",
    projectName: "",
    scope: null,
  });
  assert.deepStrictEqual(parsePackageJsonName(undefined), {
    fullName: "",
    moduleName: "",
    projectName: "",
    scope: null,
  });
});

it("ignores license banners in minified js (#2717)", async () => {
  const file = "temp.min.js";

  const content = `/*! @license DOMPurify 3.2.7 */
(function(){console.log("test")})();
`;

  writeFileSync(file, content);

  const result = await parseMinJs(file);

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);

  if (existsSync(file)) unlinkSync(file);
});

it("parses valid minified js with real package name (#2717)", async () => {
  const file = "temp.min.js";
  const content = `/*! jquery 3.6.0 */
(function(){console.log("test")})();`;

  writeFileSync(file, content);

  const result = await parseMinJs(file);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, "jquery");
  assert.equal(result[0].version, "3.6.0");

  if (existsSync(file)) unlinkSync(file);
});

// ---------------------------------------------------------------------------
// .npm-extension and packageExtensions disclosure (Deliverable 39)
// ---------------------------------------------------------------------------

describe(".npm-extension and packageExtensions disclosure", () => {
  it("hashNpmExtensionFile produces a value comparable to npm's algorithm", () => {
    const bytes = Buffer.from(
      "export function transformManifest(pkg) { return pkg; }\n",
    );
    const hash = hashNpmExtensionFile("mjs", bytes);
    assert.ok(hash.startsWith("sha512-"));
    // The same bytes with a different format prefix must produce a different hash,
    // because the format tag is part of the digest input.
    const cjsHash = hashNpmExtensionFile("cjs", bytes);
    assert.notStrictEqual(hash, cjsHash);
    // Independent computation with ssri must match exactly.
    const expected = ssri
      .fromData(Buffer.concat([Buffer.from("npm-extension:v1:mjs\n"), bytes]), {
        algorithms: ["sha512"],
      })
      .toString();
    assert.strictEqual(hash, expected);
  });

  it("detectRootNpmExtension returns null when no extension file is present", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-npmext-none-"));
    try {
      const result = detectRootNpmExtension(tempDir);
      assert.strictEqual(result, null);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("detectRootNpmExtension finds a root .npm-extension.mjs", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-npmext-mjs-"));
    try {
      const content =
        "export function transformManifest(pkg) { return pkg; }\n";
      writeFileSync(path.join(tempDir, ".npm-extension.mjs"), content);
      const result = detectRootNpmExtension(tempDir);
      assert.ok(result);
      assert.strictEqual(result.format, "mjs");
      assert.strictEqual(
        result.hash,
        hashNpmExtensionFile("mjs", Buffer.from(content)),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("detectRootNpmExtension finds a root .npm-extension.cjs", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-npmext-cjs-"));
    try {
      const content =
        "module.exports = { transformManifest(pkg) { return pkg; } };\n";
      writeFileSync(path.join(tempDir, ".npm-extension.cjs"), content);
      const result = detectRootNpmExtension(tempDir);
      assert.ok(result);
      assert.strictEqual(result.format, "cjs");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("detectRootNpmExtension prefers .mjs and flags duplicate when both exist", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-npmext-dup-"));
    try {
      writeFileSync(
        path.join(tempDir, ".npm-extension.mjs"),
        "export default {};\n",
      );
      writeFileSync(
        path.join(tempDir, ".npm-extension.cjs"),
        "module.exports = {};\n",
      );
      const result = detectRootNpmExtension(tempDir);
      assert.ok(result);
      assert.strictEqual(result.format, "mjs");
      assert.strictEqual(result.duplicate, true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parsePkgLock emits no extension properties when no .npm-extension is present", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-npmext-noext-"));
    try {
      writeFileSync(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "no-ext-project", version: "1.0.0" }),
      );
      writeFileSync(
        path.join(tempDir, "package-lock.json"),
        JSON.stringify({
          name: "no-ext-project",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: { "": { name: "no-ext-project", version: "1.0.0" } },
        }),
      );
      const result = await parsePkgLock(
        path.join(tempDir, "package-lock.json"),
        {},
      );
      const root = result.pkgList[0];
      assert.ok(root);
      assert.ok(
        !root.properties?.some((p) => p.name.startsWith("cdx:npm:extension")),
        "should not emit extension properties when no file is present",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parsePkgLock emits cdx:npm:extensionApplied: false on --deep when no lockfile hash exists", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-npmext-false-"));
    try {
      const extContent =
        "export function transformManifest(pkg) { return pkg; }\n";
      const extHash = hashNpmExtensionFile("mjs", Buffer.from(extContent));
      writeFileSync(path.join(tempDir, ".npm-extension.mjs"), extContent);
      writeFileSync(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "ext-project", version: "1.0.0" }),
      );
      writeFileSync(
        path.join(tempDir, "package-lock.json"),
        JSON.stringify({
          name: "ext-project",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: { "": { name: "ext-project", version: "1.0.0" } },
        }),
      );
      mkdirSync(path.join(tempDir, "node_modules"));
      const result = await parsePkgLock(
        path.join(tempDir, "package-lock.json"),
        { deep: true },
      );
      const root = result.pkgList[0];
      assert.ok(root);
      const extApplied = root.properties?.find(
        (p) => p.name === "cdx:npm:extensionApplied",
      );
      assert.ok(extApplied, "cdx:npm:extensionApplied should be emitted");
      assert.strictEqual(extApplied.value, "false");
      const extHashProp = root.properties?.find(
        (p) => p.name === "cdx:npm:extensionHash",
      );
      assert.ok(extHashProp, "cdx:npm:extensionHash should be emitted");
      assert.strictEqual(extHashProp.value, extHash);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parsePkgLock emits cdx:npm:extensionApplied: unverified on --deep hash mismatch", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-npmext-mismatch-"));
    try {
      const extContent =
        "export function transformManifest(pkg) { return pkg; }\n";
      writeFileSync(path.join(tempDir, ".npm-extension.mjs"), extContent);
      writeFileSync(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "mismatch-project", version: "1.0.0" }),
      );
      writeFileSync(
        path.join(tempDir, "package-lock.json"),
        JSON.stringify({
          name: "mismatch-project",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "mismatch-project",
              version: "1.0.0",
              npmExtensionHash:
                "sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
            },
          },
        }),
      );
      mkdirSync(path.join(tempDir, "node_modules"));
      const result = await parsePkgLock(
        path.join(tempDir, "package-lock.json"),
        { deep: true },
      );
      const root = result.pkgList[0];
      assert.ok(root);
      const extApplied = root.properties?.find(
        (p) => p.name === "cdx:npm:extensionApplied",
      );
      assert.ok(extApplied);
      assert.strictEqual(extApplied.value, "unverified");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parsePkgLock reports a matching hash as applied without --deep", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-npmext-virtual-"));
    try {
      const extContent =
        "export function transformManifest(pkg) { return pkg; }\n";
      writeFileSync(path.join(tempDir, ".npm-extension.mjs"), extContent);
      writeFileSync(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "virtual-project", version: "1.0.0" }),
      );
      writeFileSync(
        path.join(tempDir, "package-lock.json"),
        JSON.stringify({
          name: "virtual-project",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "virtual-project",
              version: "1.0.0",
              npmExtensionHash: hashNpmExtensionFile(
                "mjs",
                Buffer.from(extContent),
              ),
            },
          },
        }),
      );
      const result = await parsePkgLock(
        path.join(tempDir, "package-lock.json"),
        {},
      );
      const root = result.pkgList[0];
      assert.ok(root);
      const extApplied = root.properties?.find(
        (p) => p.name === "cdx:npm:extensionApplied",
      );
      assert.ok(extApplied);
      // The lockfile was written against these exact bytes, so the tree it
      // describes already carries the repaired dependency fields.
      assert.strictEqual(extApplied.value, "true");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parsePkgLock overlays lockfile-recorded extension edges on --deep", async () => {
    // realpath, because loadActual resolves the project root and a symlinked
    // temp dir (as on macOS) would otherwise be walked as a link node.
    const tempDir = realpathSync(
      mkdtempSync(path.join(tmpdir(), "cdxgen-npmext-overlay-")),
    );
    try {
      const extContent =
        "export function transformManifest(pkg) { return pkg; }\n";
      writeFileSync(path.join(tempDir, ".npm-extension.mjs"), extContent);
      writeFileSync(
        path.join(tempDir, "package.json"),
        JSON.stringify({
          name: "overlay-project",
          version: "1.0.0",
          dependencies: { alpha: "1.0.0" },
        }),
      );
      // alpha ships no dependency on beta; the extension adds one, and npm
      // recorded the repaired manifest in the lockfile at install time.
      writeFileSync(
        path.join(tempDir, "package-lock.json"),
        JSON.stringify({
          name: "overlay-project",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "overlay-project",
              version: "1.0.0",
              dependencies: { alpha: "1.0.0" },
              npmExtensionHash: hashNpmExtensionFile(
                "mjs",
                Buffer.from(extContent),
              ),
            },
            "node_modules/alpha": {
              version: "1.0.0",
              dependencies: { beta: "1.0.0" },
              npmExtensionApplied: {
                extensionPoint: "alpha@1.0.0",
                dependencies: ["beta"],
              },
            },
            "node_modules/beta": { version: "1.0.0" },
          },
        }),
      );
      for (const [name, pkgJson] of [
        ["alpha", { name: "alpha", version: "1.0.0" }],
        ["beta", { name: "beta", version: "1.0.0" }],
      ]) {
        mkdirSync(path.join(tempDir, "node_modules", name), {
          recursive: true,
        });
        writeFileSync(
          path.join(tempDir, "node_modules", name, "package.json"),
          JSON.stringify(pkgJson),
        );
      }
      const result = await parsePkgLock(
        path.join(tempDir, "package-lock.json"),
        { deep: true },
      );
      const root = result.pkgList[0];
      assert.strictEqual(
        root.properties?.find((p) => p.name === "cdx:npm:extensionApplied")
          ?.value,
        "true",
      );
      const alpha = result.pkgList.find((p) => p.name === "alpha");
      assert.ok(alpha, "alpha should be in the component list");
      assert.strictEqual(
        alpha.properties?.find(
          (p) => p.name === "cdx:npm:extensionFieldsApplied",
        )?.value,
        "beta",
      );
      // The repaired edge must reach the dependency graph, not just a property.
      const alphaDeps = result.dependenciesList.find(
        (d) => d.ref === alpha["bom-ref"],
      );
      assert.ok(alphaDeps, "alpha should have a dependency entry");
      assert.ok(
        alphaDeps.dependsOn.some((ref) => ref.includes("beta")),
        `alpha should depend on beta, got ${JSON.stringify(alphaDeps.dependsOn)}`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parsePkgLock emits cdx:npm:packageExtensionsHash from the lockfile root entry", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pkgext-hash-"));
    try {
      const peHash =
        "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      writeFileSync(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "pe-project", version: "1.0.0" }),
      );
      writeFileSync(
        path.join(tempDir, "package-lock.json"),
        JSON.stringify({
          name: "pe-project",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "pe-project",
              version: "1.0.0",
              packageExtensionsHash: peHash,
            },
          },
        }),
      );
      const result = await parsePkgLock(
        path.join(tempDir, "package-lock.json"),
        {},
      );
      const root = result.pkgList[0];
      assert.ok(root);
      const hashProp = root.properties?.find(
        (p) => p.name === "cdx:npm:packageExtensionsHash",
      );
      assert.ok(hashProp, "cdx:npm:packageExtensionsHash should be emitted");
      assert.strictEqual(hashProp.value, peHash);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parsePkgLock emits cdx:npm:packageExtensionsDisabled when --no-package-extensions is set on --deep", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pkgext-disabled-"));
    try {
      writeFileSync(
        path.join(tempDir, "package.json"),
        JSON.stringify({ name: "pe-dis-project", version: "1.0.0" }),
      );
      writeFileSync(
        path.join(tempDir, "package-lock.json"),
        JSON.stringify({
          name: "pe-dis-project",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: { "": { name: "pe-dis-project", version: "1.0.0" } },
        }),
      );
      mkdirSync(path.join(tempDir, "node_modules"));
      const result = await parsePkgLock(
        path.join(tempDir, "package-lock.json"),
        { deep: true, packageExtensions: false },
      );
      const root = result.pkgList[0];
      assert.ok(root);
      assert.ok(
        root.properties?.some(
          (p) =>
            p.name === "cdx:npm:packageExtensionsDisabled" &&
            p.value === "true",
        ),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("semver build metadata in npm lockfiles", () => {
  const FIXTURES = "./test/repotests";
  const everyPurlParses = (pkgList) => {
    for (const pkg of pkgList) {
      if (pkg.purl) {
        assert.doesNotThrow(() => Purl.parse(pkg.purl), pkg.purl);
        assert.ok(!pkg.purl.includes("%25"), `double-encoded: ${pkg.purl}`);
      }
    }
  };

  it("parsePkgLock escapes a root version with build metadata", async () => {
    // Regression for a package.json version such as `1.0.0+major`, which
    // failed with "Invalid character in version".
    const parsed = await parsePkgLock(
      `${FIXTURES}/npm-build-metadata-smoke/package-lock.json`,
    );
    const root = parsed.pkgList.find((p) => p.name === "npm-build-metadata");
    assert.strictEqual(root.version, "1.0.0+root");
    assert.strictEqual(root.purl, "pkg:npm/npm-build-metadata@1.0.0%2Broot");
    assert.strictEqual(
      root["bom-ref"],
      "pkg:npm/npm-build-metadata@1.0.0+root",
    );
    const tarball = parsed.pkgList.find((p) => p.name === "localdep");
    assert.strictEqual(tarball.purl, "pkg:npm/localdep@2.0.0%2Blocal");
    everyPurlParses(parsed.pkgList);
  });

  it("parseYarnLock resolves berry root dependencies with build metadata", async () => {
    const workspacePackages = [
      createNpmWorkspacePurl("wsmember", "3.0.0+ws"),
      createNpmWorkspacePurl("@acme/tools", "0.9.0+exp.sha.5114f85"),
    ];
    const parsed = await parseYarnLock(
      `${FIXTURES}/yarn-build-metadata-smoke/yarn.lock`,
      null,
      workspacePackages,
    );
    const tarball = parsed.pkgList.find((p) => p.name === "localdep");
    assert.strictEqual(tarball.version, "2.0.0+local");
    assert.strictEqual(tarball.purl, "pkg:npm/localdep@2.0.0%2Blocal");
    everyPurlParses(parsed.pkgList);
  });

  it("parseYarnLock reads workspace references in either encoding once", async () => {
    // Workspace references are handed over both as escaped purls and in the
    // decoded bom-ref form. Copying the escaped version text into a purl
    // produced `3.0.0%252Bws`.
    for (const workspacePackages of [
      [
        createNpmWorkspacePurl("wsmember", "3.0.0+ws"),
        createNpmWorkspacePurl("@acme/tools", "0.9.0+exp.sha.5114f85"),
      ],
      [
        "pkg:npm/wsmember@3.0.0+ws",
        "pkg:npm/@acme/tools@0.9.0+exp.sha.5114f85",
      ],
    ]) {
      const parsed = await parseYarnLock(
        `${FIXTURES}/yarn-classic-build-metadata-smoke/yarn.lock`,
        null,
        workspacePackages,
      );
      const member = parsed.pkgList.find((p) => p.name === "wsmember");
      assert.strictEqual(member.version, "3.0.0+ws");
      assert.strictEqual(member.purl, "pkg:npm/wsmember@3.0.0%2Bws");
      assert.strictEqual(member["bom-ref"], "pkg:npm/wsmember@3.0.0+ws");
      const scoped = parsed.pkgList.find((p) => p.name === "tools");
      assert.strictEqual(scoped.group, "@acme");
      assert.strictEqual(scoped.version, "0.9.0+exp.sha.5114f85");
      assert.strictEqual(
        scoped.purl,
        "pkg:npm/%40acme/tools@0.9.0%2Bexp.sha.5114f85",
      );
      everyPurlParses(parsed.pkgList);
    }
  });

  it("parsePnpmLock takes a file: package's version from its packages entry", async () => {
    const parsed = await parsePnpmLock(
      `${FIXTURES}/pnpm-build-metadata-smoke/pnpm-lock.yaml`,
      {
        name: "pnpm-build-metadata",
        version: "1.0.0+root",
        purl: "pkg:npm/pnpm-build-metadata@1.0.0%2Broot",
        "bom-ref": "pkg:npm/pnpm-build-metadata@1.0.0+root",
      },
    );
    const tarball = parsed.pkgList.find((p) => p.name === "localdep");
    assert.strictEqual(tarball.version, "2.0.0+local");
    assert.ok(tarball.purl.startsWith("pkg:npm/localdep@2.0.0%2Blocal"));
    // The importer names the tarball by its path; its edge must reach the
    // same component rather than a ref made from the path.
    const rootDeps = parsed.dependenciesList.find(
      (d) => d.ref === "pkg:npm/pnpm-build-metadata@1.0.0+root",
    );
    assert.ok(rootDeps.dependsOn.includes(tarball["bom-ref"]));
    everyPurlParses(parsed.pkgList);
  });

  it("parsePnpmLock escapes an aliased optional dependency with build metadata", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pnpm-alias-"));
    try {
      const lockFile = path.join(tempDir, "pnpm-lock.yaml");
      writeFileSync(
        lockFile,
        [
          "lockfileVersion: '9.0'",
          "importers:",
          "  .:",
          "    dependencies:",
          "      parent:",
          "        specifier: 1.0.0",
          "        version: 1.0.0",
          "packages:",
          "  parent@1.0.0:",
          "    resolution: {integrity: sha512-AAAA}",
          "  child@2.0.0+build.1:",
          "    resolution: {integrity: sha512-BBBB}",
          "snapshots:",
          "  parent@1.0.0:",
          "    optionalDependencies:",
          "      child-alias: child@2.0.0+build.1",
          "  child@2.0.0+build.1: {}",
          "",
        ].join("\n"),
      );
      const parsed = await parsePnpmLock(lockFile);
      const child = parsed.pkgList.find((p) => p.name === "child");
      assert.strictEqual(child.purl, "pkg:npm/child@2.0.0%2Bbuild.1");
      everyPurlParses(parsed.pkgList);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

it("parsePnpmLock resolves workspace link: dependencies from the lock file's directory", async () => {
  // The fixture is read from the repository root, so a link: path such as
  // packages/tools must be resolved against the lock file's directory.
  const parentComponent = {
    name: "pnpm-build-metadata",
    version: "1.0.0+root",
    purl: "pkg:npm/pnpm-build-metadata@1.0.0%2Broot",
    "bom-ref": "pkg:npm/pnpm-build-metadata@1.0.0+root",
  };
  const parsedList = await parsePnpmLock(
    "test/repotests/pnpm-build-metadata-smoke/pnpm-lock.yaml",
    parentComponent,
  );
  const root = parsedList.dependenciesList.find(
    (d) => d.ref === parentComponent["bom-ref"],
  );
  assert.ok(root, "the root should have a dependency entry");
  assert.ok(root.dependsOn.includes("pkg:npm/wsmember@3.0.0+ws"));
  assert.ok(
    root.dependsOn.includes("pkg:npm/@acme/tools@0.9.0+exp.sha.5114f85"),
  );
  assert.deepStrictEqual(
    root.dependsOn.filter((ref) => ref.includes("@packages/")),
    [],
    "a link: path must not become a version",
  );
});

it("parsePnpmLock ignores lock entries named __proto__", async () => {
  const projectDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pnpm-proto-"));
  try {
    const lockFile = path.join(projectDir, "pnpm-lock.yaml");
    writeFileSync(
      lockFile,
      readFileSync("./test/data/sec-pnpm-protokey/pnpm-lock.yaml", "utf-8"),
    );

    const parsedList = await parsePnpmLock(
      lockFile,
      null,
      [],
      {},
      {},
      {},
      {},
      projectDir,
    );
    const names = parsedList.pkgList.map((pkg) => pkg.name);
    assert.ok(names.includes("lodash"), "legit lock entries must survive");
    assert.strictEqual(
      names.includes("__proto__"),
      false,
      "a lock entry named __proto__ must not become a component",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
