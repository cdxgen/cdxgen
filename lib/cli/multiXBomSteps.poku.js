/**
 * How createMultiXBom runs and merges the per-ecosystem builders for a path.
 * Most tests replace every builder with a stub, so they cover the merge rules
 * of the step list in createMultiXBom without any real project on disk. The
 * final test runs the real ruby and c builders to check the options object
 * the steps share.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * project do, and returns what resultFor gives for its ecosystem and path
 * (resultFor may be async, to finish the paths in a chosen order).
 */
const loadWithStubs = async (resultFor) => {
  const calls = [];
  const stub = (eco) => async (path, options) => {
    calls.push({ eco, path, parent: options.parentComponent?.["bom-ref"] });
    options.parentComponent = { "bom-ref": `forced-by-${eco}` };
    return structuredClone((await resultFor(eco, path)) || {});
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

/** Runs fn with several empty project directories under one temp root. */
const withProjectDirs = async (count, fn) =>
  withProjectDir(async (root) => {
    const dirs = [];
    for (let i = 0; i < count; i++) {
      const dir = join(root, `project-${i}`);
      mkdirSync(dir);
      dirs.push(dir);
    }
    return fn(dirs, root);
  });

const scan = (createMultiXBom, projectType, extra = {}) =>
  withProjectDir((dir) =>
    createMultiXBom([dir], { projectType, multiProject: true, ...extra }),
  );

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
  it("runs the extension and archive builders in order", async () => {
    const { calls, createMultiXBom } = await loadWithStubs(() => ({}));
    await scan(createMultiXBom, [
      "terraform",
      "chrome-extension",
      "vscode-extension",
      "asar",
      "caxa",
    ]);
    assert.deepStrictEqual(
      calls.map((c) => c.eco),
      ["caxa", "asar", "vscode-extension", "chrome-extension", "terraform"],
    );
  });

  it("drops ruby dependency edges that point back at the ruby project", async () => {
    const { createMultiXBom } = await loadWithStubs((eco) =>
      eco === "ruby"
        ? {
            bomJson: {
              components: [component("rack"), component("rake")],
              dependencies: [
                {
                  ref: purlOf("rack"),
                  dependsOn: [purlOf("rails-app"), purlOf("rake")],
                },
              ],
            },
            parentComponent: component("rails-app"),
          }
        : {},
    );
    const result = await scan(createMultiXBom, ["ruby", "js"]);
    const rack = result.bomJson.dependencies.find(
      (d) => d.ref === purlOf("rack"),
    );
    assert.deepStrictEqual(rack.dependsOn, [purlOf("rake")]);
  });

  it("merges the crypto scan's own dependencies and does not keep its parent", async () => {
    const { createMultiXBom } = await loadWithStubs((eco) =>
      eco === "cbom"
        ? {
            bomJson: { components: [component("rsa-key")] },
            dependencies: [{ ref: purlOf("rsa-key"), dependsOn: [] }],
            parentComponent: component("crypto-root"),
          }
        : {},
    );
    const result = await scan(createMultiXBom, ["js"], {
      specVersion: 1.6,
      includeCrypto: true,
    });
    assert.ok(
      result.bomJson.dependencies.some((d) => d.ref === purlOf("rsa-key")),
      "the crypto dependencies are merged",
    );
    assert.ok(
      !JSON.stringify(result.bomJson.metadata).includes("crypto-root"),
      "the crypto scan's parent is not a sub-component",
    );
  });

  it("keeps php platform properties when the lock lists no packages", async () => {
    const { createMultiXBom } = await loadWithStubs((eco) =>
      eco === "php"
        ? {
            bomJson: { components: [], dependencies: [] },
            metadataProperties: [
              { name: "cdx:php:platform:php", value: "8.4" },
            ],
          }
        : {},
    );
    const result = await scan(createMultiXBom, ["php", "js"]);
    assert.ok(
      JSON.stringify(result.bomJson.metadata).includes("cdx:php:platform:php"),
      "the platform property reaches the metadata",
    );
  });

  it("keeps python and c formulation when no components are found", async () => {
    const { createMultiXBom } = await loadWithStubs((eco) =>
      ["py", "c"].includes(eco)
        ? {
            bomJson: { components: [], dependencies: [] },
            formulationList: [component(`${eco}-toolchain`)],
          }
        : {},
    );
    const result = await scan(createMultiXBom, ["python", "c"]);
    assert.deepStrictEqual(
      result.formulationList.map((c) => c.name),
      ["py-toolchain", "c-toolchain"],
    );
  });

  it("orders the formulation of concurrently scanned paths by path", async () => {
    // The paths must really run at the same time for the order to be at
    // risk, so the test sets the concurrency itself and checks that the py
    // builders overlapped. With paths scanned one at a time, for example in
    // debug mode, it fails instead of passing without testing anything.
    const saved = process.env.CDXGEN_MAX_PATH_SCANS;
    process.env.CDXGEN_MAX_PATH_SCANS = "3";
    let running = 0;
    let mostRunning = 0;
    try {
      const { createMultiXBom } = await loadWithStubs(async (eco, path) => {
        if (eco !== "py") {
          return {};
        }
        const index = Number(path.slice(-1));
        running += 1;
        mostRunning = Math.max(mostRunning, running);
        // the first path finishes last
        await new Promise((r) => setTimeout(r, index === 0 ? 60 : 5));
        running -= 1;
        return {
          bomJson: { components: [], dependencies: [] },
          formulationList: [component(`toolchain-${index}`)],
        };
      });
      const result = await withProjectDirs(3, (dirs) =>
        createMultiXBom(dirs, { projectType: ["python", "js"] }),
      );
      assert.ok(mostRunning > 1, "the py builders of the paths overlapped");
      assert.deepStrictEqual(
        result.formulationList.map((c) => c.name),
        ["toolchain-0", "toolchain-1", "toolchain-2"],
      );
    } finally {
      if (saved === undefined) {
        delete process.env.CDXGEN_MAX_PATH_SCANS;
      } else {
        process.env.CDXGEN_MAX_PATH_SCANS = saved;
      }
    }
  });

  it("merges the services a js project defines", async () => {
    const { createMultiXBom } = await loadWithStubs((eco) =>
      eco === "js"
        ? {
            bomJson: {
              components: [component("express")],
              dependencies: [],
              services: [
                {
                  "bom-ref": "urn:service:api:1.0.0",
                  name: "api",
                  version: "1.0.0",
                },
              ],
            },
            parentComponent: component("web-app"),
          }
        : {},
    );
    const result = await scan(createMultiXBom, ["js", "java"]);
    assert.ok(
      result.bomJson.services?.some((s) => s.name === "api"),
      "the js service is kept",
    );
  });

  it("scans the host's chrome extensions once, and every explicit extension path", async () => {
    const { calls, createMultiXBom } = await loadWithStubs(() => ({}));
    await withProjectDirs(3, (dirs) => {
      writeFileSync(join(dirs[2], "manifest.json"), "{}");
      return createMultiXBom(dirs, {
        projectType: ["chrome-extension"],
        multiProject: true,
      });
    });
    const chromeCalls = calls.filter((c) => c.eco === "chrome-extension");
    assert.strictEqual(chromeCalls.length, 2);
    assert.ok(
      chromeCalls.some((c) => c.path.endsWith("project-2")),
      "the explicit extension path is scanned",
    );
  });

  it("keeps cocoa components when the result has no dependency list", async () => {
    const { createMultiXBom } = await loadWithStubs((eco) =>
      eco === "cocoa"
        ? {
            bomJson: { components: [component("AFNetworking")] },
            parentComponent: component("ios-app"),
          }
        : {},
    );
    const result = await scan(createMultiXBom, ["cocoa", "js"]);
    assert.ok(
      result.bomJson.components.some((c) => c.name === "AFNetworking"),
      "the cocoa components are kept",
    );
  });

  it("keeps a csharp project whose result has dependencies but no components list", async () => {
    const { createMultiXBom } = await loadWithStubs((eco) =>
      eco === "csharp"
        ? {
            bomJson: {
              dependencies: [{ ref: purlOf("console-app"), dependsOn: [] }],
            },
            parentComponent: component("console-app"),
          }
        : {},
    );
    const result = await scan(createMultiXBom, ["csharp", "js"]);
    assert.strictEqual(
      result.bomJson.metadata.component["bom-ref"],
      purlOf("console-app"),
    );
  });
});

describe("createMultiXBom() with the real ruby and c builders", () => {
  // The ruby step widens includeNodeModulesDir for its own gem search, and
  // the c step reads the same options object when it looks for vendored
  // code, so node_modules must stay out of that search.
  it("does not report node_modules directories as vendored code", async () => {
    const { createMultiXBom } = await import("./index.js");
    const MIT =
      "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-multix-node-modules-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "web-app", license: "Apache-2.0" }),
      );
      mkdirSync(join(dir, "node_modules", "debug"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "debug", "LICENSE"), MIT);
      mkdirSync(join(dir, "third_party", "json"), { recursive: true });
      writeFileSync(join(dir, "third_party", "json", "LICENSE"), MIT);
      const result = await createMultiXBom([dir], {
        projectType: ["ruby", "c"],
        specVersion: 1.6,
      });
      const purls = (result.bomJson.components || []).map((c) => c.purl);
      assert.ok(
        !purls.some(
          (p) => p?.startsWith("pkg:generic/") && p.includes("#node_modules/"),
        ),
        purls.join(", "),
      );
      assert.ok(
        purls.includes("pkg:generic/json#third_party/json"),
        purls.join(", "),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
