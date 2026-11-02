/**
 * How createMultiXBom runs and merges the per-ecosystem builders for a path.
 * Every builder is replaced by a stub, so these tests cover the merge rules
 * of the step list in createMultiXBom without any real project on disk.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";

const purlOf = (name) => `pkg:generic/${name}@1.0.0`;
const component = (name) => ({
  type: "library",
  name,
  version: "1.0.0",
  purl: purlOf(name),
  "bom-ref": purlOf(name),
});

/**
 * Loads index.js with every builder stubbed. Each stub records its call,
 * then sets options.parentComponent the way builders that force their own
 * project do, and returns what resultFor gives for its ecosystem.
 */
const loadWithStubs = async (resultFor) => {
  const calls = [];
  const stub = (eco) => async (_path, options) => {
    calls.push({ eco, parent: options.parentComponent?.["bom-ref"] });
    options.parentComponent = { "bom-ref": `forced-by-${eco}` };
    return structuredClone(resultFor(eco) || {});
  };
  const builders = {
    "./jsBom.js": {
      createAsarBom: "asar",
      createCaxaBom: "caxa",
      createChromeExtensionBom: "chrome-extension",
      createNodejsBom: "js",
      createVscodeExtensionBom: "vscode-extension",
    },
    "./jvmBom.js": { createJarBom: "jar", createJavaBom: "java" },
    "./managedBom.js": {
      createCloudBuildBom: "cloudbuild",
      createCryptoCertsBom: "cbom",
      createCsharpBom: "csharp",
      createGitHubBom: "github",
      createPHPBom: "php",
      createPythonBom: "py",
      createRubyBom: "ruby",
      createTerraformBom: "terraform",
    },
    "./nativeBom.js": {
      createClojureBom: "clojure",
      createCocoaBom: "cocoa",
      createCppBom: "c",
      createDartBom: "dart",
      createElixirBom: "elixir",
      createGoBom: "go",
      createHaskellBom: "haskell",
      createNixBom: "nix",
      createRustBom: "rust",
      createSwiftBom: "swift",
    },
  };
  const mocks = {};
  for (const [module, functions] of Object.entries(builders)) {
    mocks[module] = Object.fromEntries(
      Object.entries(functions).map(([fn, eco]) => [fn, stub(eco)]),
    );
  }
  const { createMultiXBom } = await esmock("./index.js", mocks);
  return { calls, createMultiXBom };
};

const withProjectDir = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-multix-steps-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("createMultiXBom() per-ecosystem steps", () => {
  it("runs the builders in order, each from the caller's parent component", async () => {
    const { calls, createMultiXBom } = await loadWithStubs(() => ({}));
    await withProjectDir((dir) =>
      createMultiXBom([dir], {
        multiProject: true,
        specVersion: 1.6,
        includeCrypto: true,
        parentComponent: { "bom-ref": "pkg:generic/caller@1.0.0" },
      }),
    );
    assert.deepStrictEqual(
      calls.map((c) => c.eco),
      [
        "js",
        "java",
        "py",
        "go",
        "rust",
        "php",
        "ruby",
        "csharp",
        "dart",
        "haskell",
        "elixir",
        "c",
        "clojure",
        "github",
        "cloudbuild",
        "swift",
        "jar",
        "cocoa",
        "nix",
        "terraform",
        "cbom",
      ],
    );
    for (const call of calls) {
      assert.strictEqual(call.parent, "pkg:generic/caller@1.0.0", call.eco);
    }
  });

  const javaResult = (eco) =>
    eco === "java"
      ? {
          bomJson: {
            components: [component("guava"), component("lib")],
            dependencies: [],
          },
          parentComponent: {
            ...component("multi-demo"),
            components: [component("app"), component("lib")],
          },
        }
      : {};
  const subComponentNames = (result) =>
    (result.bomJson.metadata.component.components || []).map((c) => c.name);

  // One test for both settings: the tests in this file run concurrently and
  // the setting is read from the environment.
  it("moves gradle sub-projects that are also components unless GRADLE_RESOLVE_FROM_NODE is false", async () => {
    const saved = process.env.GRADLE_RESOLVE_FROM_NODE;
    try {
      delete process.env.GRADLE_RESOLVE_FROM_NODE;
      let { createMultiXBom } = await loadWithStubs(javaResult);
      let result = await withProjectDir((dir) =>
        createMultiXBom([dir], { projectType: ["java", "js"] }),
      );
      assert.deepStrictEqual(subComponentNames(result), ["app"]);
      process.env.GRADLE_RESOLVE_FROM_NODE = "false";
      ({ createMultiXBom } = await loadWithStubs(javaResult));
      result = await withProjectDir((dir) =>
        createMultiXBom([dir], { projectType: ["java", "js"] }),
      );
      assert.deepStrictEqual(subComponentNames(result).sort(), ["app", "lib"]);
    } finally {
      if (saved === undefined) {
        delete process.env.GRADLE_RESOLVE_FROM_NODE;
      } else {
        process.env.GRADLE_RESOLVE_FROM_NODE = saved;
      }
    }
  });

  it("keeps a csharp project that uses no packages", async () => {
    const { createMultiXBom } = await loadWithStubs((eco) =>
      eco === "csharp"
        ? {
            bomJson: {
              components: [],
              dependencies: [{ ref: purlOf("console-app"), dependsOn: [] }],
            },
            parentComponent: component("console-app"),
          }
        : {},
    );
    const result = await withProjectDir((dir) =>
      createMultiXBom([dir], { projectType: ["csharp", "js"] }),
    );
    assert.strictEqual(
      result.bomJson.metadata.component["bom-ref"],
      purlOf("console-app"),
    );
  });

  it("does not throw when a js builder returns components without a parent component", async () => {
    const { createMultiXBom } = await loadWithStubs((eco) =>
      eco === "js"
        ? { bomJson: { components: [component("left-pad")], dependencies: [] } }
        : {},
    );
    const result = await withProjectDir((dir) =>
      createMultiXBom([dir], { projectType: ["js", "java"] }),
    );
    assert.ok(
      result.bomJson.components.some((c) => c.name === "left-pad"),
      "the js components are kept",
    );
  });
});
