import { createHash } from "node:crypto";

import { assert, describe, it } from "poku";

import { resetRunState } from "../core/runState.js";
import { CDXGEN_VERSION } from "../core/state.js";
import {
  getExecutedTools,
  recordExecutedTool,
  resetExecutedTools,
} from "../core/toolRegistry.js";
import { getPluginToolComponents } from "../managers/binary.js";
import { validateBom } from "../validator/bomValidator.js";
import {
  addMetadata,
  addToolsSection,
  buildBomNSData,
  dedupeBom,
  HASH_PATTERN,
  listComponents,
  processHashes,
} from "./bomAssembly.js";
import { getNpmPackFilePaths, getProp } from "./bomTestHelpers.poku.js";

describe("bomAssembly", () => {
  describe("hash normalization", () => {
    const hashesFor = (pkg) => {
      const component = { hashes: [] };
      processHashes(pkg, component);
      return component.hashes ?? [];
    };

    it("converts a base64 integrity to hex", () => {
      const digest = createHash("sha512").update("hello").digest("base64");
      const [hash] = hashesFor({ _integrity: `sha512-${digest}` });
      assert.strictEqual(hash.alg, "SHA-512");
      assert.strictEqual(
        hash.content,
        createHash("sha512").update("hello").digest("hex"),
      );
    });

    it("keeps a hex digest as is", () => {
      const digest = createHash("sha1").update("hello").digest("hex");
      const [hash] = hashesFor({ _shasum: digest });
      assert.strictEqual(hash.content, digest);
    });

    it("drops a digest that decodes to the wrong length", () => {
      // A truncated npm integrity: it decodes, but to 63 bytes rather than 64.
      // Copying it through produced a BOM that failed schema validation.
      const truncated =
        "QIqJf7A1NVCjzCIdA1M6A+0ify9J50nDxzX7QgJ0006AAXMon0AhQI9bQ6tcG4IHHD5woAH+KUnLMaAz9x9A==";
      assert.deepStrictEqual(
        hashesFor({ _integrity: `sha512-${truncated}` }),
        [],
      );
    });

    it("drops a hex digest whose length contradicts its algorithm", () => {
      assert.deepStrictEqual(
        hashesFor({ hashes: [{ alg: "SHA-512", content: "a".repeat(64) }] }),
        [],
      );
    });

    it("emits only spec-valid content for mixed input", () => {
      const good = createHash("sha256").update("hello").digest("base64");
      const hashes = hashesFor({
        hashes: [
          { alg: "SHA-256", content: good },
          { alg: "SHA-512", content: "not a digest" },
        ],
      });
      assert.strictEqual(hashes.length, 1);
      for (const hash of hashes) {
        assert.ok(
          new RegExp(HASH_PATTERN).test(hash.content),
          `${hash.content} must satisfy the CycloneDX hash pattern`,
        );
      }
    });
  });

  describe("component creation", () => {
    it("keeps a purl a file component set for itself", () => {
      // `file` is a NON_PURL_TYPES member so no maven purl is derived for it,
      // but a collector that already resolved a generic purl is taken at its
      // word — this is how unpackaged executables and unidentified archives
      // stay joinable.
      const [component] = listComponents(
        { specVersion: 1.7 },
        undefined,
        [
          {
            name: "mystery.jar",
            type: "file",
            purl: "pkg:generic/mystery.jar#opt/app/mystery.jar",
            "bom-ref": "pkg:generic/mystery.jar#opt/app/mystery.jar",
          },
        ],
        "maven",
      );
      assert.strictEqual(
        component.purl,
        "pkg:generic/mystery.jar#opt/app/mystery.jar",
      );
      assert.strictEqual(
        component["bom-ref"],
        "pkg:generic/mystery.jar#opt/app/mystery.jar",
      );
    });

    it("keeps the CPE a collector recorded, and adds none otherwise", () => {
      // caxa records one for the Node.js runtime it bundles; NVD-based
      // scanners match Node.js by it.
      const [node, other] = listComponents(
        { specVersion: 1.7 },
        undefined,
        [
          {
            name: "node",
            version: "24.21.0",
            purl: "pkg:generic/nodejs/node@24.21.0",
            cpe: "cpe:2.3:a:nodejs:node.js:24.21.0:*:*:*:-:*:*:*",
          },
          {
            name: "left-pad",
            version: "1.3.0",
            purl: "pkg:npm/left-pad@1.3.0",
          },
        ],
        "npm",
      );
      assert.strictEqual(
        node.cpe,
        "cpe:2.3:a:nodejs:node.js:24.21.0:*:*:*:-:*:*:*",
      );
      assert.ok(!Object.hasOwn(other, "cpe"));
    });

    it("derives no purl for a file component that brought none", () => {
      const [component] = listComponents(
        { specVersion: 1.7 },
        undefined,
        [{ group: "com.example", name: "thing", version: "1.0", type: "file" }],
        "maven",
      );
      assert.strictEqual(component.purl, undefined);
    });

    it("keeps readable OBOM bom-refs when no package purl type is available", () => {
      const components = listComponents(
        { specVersion: 1.7 },
        undefined,
        [
          {
            "bom-ref":
              "osquery:authorized_keys_snapshot:data:root@ssh-ed25519[key_file=/root/.ssh/authorized_keys]",
            name: "root",
            properties: [
              {
                name: "cdx:osquery:category",
                value: "authorized_keys_snapshot",
              },
            ],
            type: "data",
            version: "ssh-ed25519",
          },
        ],
        "",
      );
      assert.strictEqual(components.length, 1);
      assert.strictEqual(components[0].purl, undefined);
      assert.strictEqual(
        components[0]["bom-ref"],
        "osquery:authorized_keys_snapshot:data:root@ssh-ed25519[key_file=/root/.ssh/authorized_keys]",
      );
      assert.strictEqual(components[0].type, "data");
    });

    it("marks npm packages required when analyzer command evidence matches package bin metadata", () => {
      const components = listComponents(
        { specVersion: 1.7 },
        {
          "cdx:npm:bin/license-report": new Set([
            {
              fileName: "package.json",
              importedAs: "cdx:npm:bin/license-report",
              importedModules: ["license-report"],
            },
          ]),
        },
        [
          {
            name: "license-report",
            version: "6.5.0",
            scope: "optional",
            properties: [
              {
                name: "cdx:npm:bin",
                value: "license-report",
              },
            ],
          },
          {
            name: "left-pad",
            version: "1.3.0",
            scope: "optional",
            properties: [],
          },
        ],
        "npm",
      );

      const licenseReport = components.find(
        (component) => component.name === "license-report",
      );
      const leftPad = components.find(
        (component) => component.name === "left-pad",
      );
      assert.strictEqual(licenseReport.scope, "required");
      assert.strictEqual(leftPad.scope, "optional");
    });

    it("keeps npm package required when bin-command evidence exists alongside type-only imports", () => {
      const components = listComponents(
        { specVersion: 1.7 },
        {
          "cdx:npm:bin/license-report": new Set([
            {
              fileName: "package.json",
              importedAs: "cdx:npm:bin/license-report",
              importedModules: ["license-report"],
            },
          ]),
          "license-report": new Set([
            {
              importedAs: "license-report",
              importedModules: ["license-report"],
              isTypeOnly: true,
            },
          ]),
        },
        [
          {
            name: "license-report",
            version: "6.5.0",
            scope: "optional",
            properties: [
              {
                name: "cdx:npm:bin",
                value: "license-report",
              },
            ],
          },
        ],
        "npm",
      );

      const licenseReport = components.find(
        (component) => component.name === "license-report",
      );
      assert.strictEqual(licenseReport.scope, "required");
      assert.strictEqual(
        getProp(licenseReport, "cdx:npm:package:type-only"),
        undefined,
      );
    });

    // #4336: a missing import is not evidence that a package is optional.
    it("keeps the scope of npm packages the imports do not mention", () => {
      const components = listComponents(
        { specVersion: 1.7 },
        {
          debug: new Set([
            {
              fileName: "index.js",
              importedAs: "debug",
              importedModules: ["debug"],
            },
          ]),
        },
        [
          { name: "debug", version: "4.4.1", properties: [] },
          { name: "left-pad", version: "1.3.0", properties: [] },
          // Promoted by propagateRequiredScopeFromDependencies through debug.
          { name: "ms", version: "2.1.3", scope: "required", properties: [] },
          // Promoted by addEvidenceForImports through its jsr specifier.
          {
            group: "@jsr",
            name: "std__assert",
            version: "1.0.13",
            scope: "required",
            properties: [
              { name: "cdx:deno:jsrKey", value: "@std/assert@1.0.13" },
            ],
          },
          {
            name: "picocolors",
            version: "1.1.1",
            scope: "optional",
            properties: [
              { name: "cdx:npm:package:development", value: "true" },
            ],
          },
        ],
        "npm",
      );
      const scopeOf = (name) =>
        components.find((component) => component.name === name)?.scope;

      assert.strictEqual(scopeOf("debug"), "required");
      assert.strictEqual(scopeOf("left-pad"), undefined);
      assert.strictEqual(scopeOf("ms"), "required");
      assert.strictEqual(scopeOf("std__assert"), "required");
      assert.strictEqual(scopeOf("picocolors"), "optional");
    });

    it("keeps pypi scopes when the imports list only undeclared modules", () => {
      // getPyModules reports the imported modules no manifest declares; the
      // declared packages it saw imported are already scoped required.
      const components = listComponents(
        { specVersion: 1.7 },
        { "extra-pkg": true },
        [
          { name: "requests", version: "2.32.3", scope: "required" },
          { name: "gunicorn", version: "23.0.0" },
          { name: "extra-pkg", version: "1.0.0", scope: "required" },
        ],
        "pypi",
      );
      const scopeOf = (name) =>
        components.find((component) => component.name === name)?.scope;

      assert.strictEqual(scopeOf("requests"), "required");
      assert.strictEqual(scopeOf("gunicorn"), undefined);
      assert.strictEqual(scopeOf("extra-pkg"), "required");
    });
  });

  describe("distribution filters", () => {
    it("keeps npm types while excluding poku tests from npm pack output", () => {
      const packedPaths = getNpmPackFilePaths();

      assert.ok(
        packedPaths.some((path) => path.startsWith("types/")),
        "expected npm pack output to keep generated type definitions",
      );
      assert.ok(
        packedPaths.every((path) => !path.endsWith(".poku.js")),
        "expected npm pack output to exclude co-located poku tests",
      );
      assert.ok(
        packedPaths.every((path) => !path.startsWith("test/")),
        "expected npm pack output to exclude test fixtures",
      );
    });
  });

  describe("parent component overrides", () => {
    const detected = {
      "bom-ref": "application:myproject:1.0.0",
      name: "myproject",
      type: "application",
      version: "1.0.0",
    };
    const child = {
      "bom-ref": "pkg:generic/dep@1.0.0",
      name: "dep",
      purl: "pkg:generic/dep@1.0.0",
      type: "library",
      version: "1.0.0",
    };
    const context = () => ({
      parentComponent: { ...detected },
      dependencies: [
        { ref: detected["bom-ref"], dependsOn: [child["bom-ref"]] },
        { ref: child["bom-ref"], dependsOn: [] },
      ],
    });

    it("keeps the generator's own root when no override is given", () => {
      const { bomJson } = buildBomNSData(
        { specVersion: 1.7 },
        [child],
        "generic",
        context(),
      );
      assert.strictEqual(
        bomJson.metadata.component["bom-ref"],
        "application:myproject:1.0.0",
      );
      assert.deepStrictEqual(bomJson.dependencies, context().dependencies);
    });

    it("re-anchors the graph under a caller-supplied parent", () => {
      const { bomJson } = buildBomNSData(
        { specVersion: 1.7, projectName: "monorepo", projectVersion: "9.9.9" },
        [child],
        "generic",
        context(),
      );
      const rootRef = bomJson.metadata.component["bom-ref"];
      assert.strictEqual(rootRef, "pkg:application/monorepo@9.9.9");

      // The detected project is a real subproject, so it survives as a
      // component instead of the edges below it being orphaned.
      assert.ok(
        bomJson.components.some(
          (comp) => comp["bom-ref"] === "application:myproject:1.0.0",
        ),
      );
      assert.deepStrictEqual(
        bomJson.dependencies.find((dep) => dep.ref === rootRef),
        { ref: rootRef, dependsOn: ["application:myproject:1.0.0"] },
      );

      const known = new Set(bomJson.components.map((c) => c["bom-ref"]));
      known.add(rootRef);
      const dangling = bomJson.dependencies
        .flatMap((dep) => [dep.ref, ...dep.dependsOn])
        .filter((ref) => !known.has(ref));
      assert.deepStrictEqual(dangling, []);
    });

    // Discussion 4388: naming the very project the generator detected must
    // not wrap it in an `application` of the same name and version.
    const gemDetected = {
      "bom-ref": "pkg:gem/mygem@0.8.1",
      purl: "pkg:gem/mygem@0.8.1",
      group: "",
      name: "mygem",
      type: "application",
      version: "0.8.1",
      description: "The gem being built",
    };
    const gemContext = () => ({
      parentComponent: { ...gemDetected },
      dependencies: [
        { ref: gemDetected["bom-ref"], dependsOn: [child["bom-ref"]] },
        { ref: child["bom-ref"], dependsOn: [] },
      ],
    });

    it("keeps the detected parent when the override names that project", async () => {
      const { bomJson } = buildBomNSData(
        { specVersion: 1.7, projectName: "mygem", projectVersion: "0.8.1" },
        [child],
        "gem",
        gemContext(),
      );
      assert.strictEqual(
        bomJson.metadata.component["bom-ref"],
        gemDetected["bom-ref"],
      );
      assert.strictEqual(
        bomJson.metadata.component.description,
        "The gem being built",
      );
      assert.deepStrictEqual(
        bomJson.components.map((comp) => comp["bom-ref"]),
        [child["bom-ref"]],
        "the project must not be listed as a subproject of itself",
      );
      assert.deepStrictEqual(bomJson.dependencies, gemContext().dependencies);
      assert.strictEqual(await validateBom(bomJson), true);
    });

    it("still anchors a detected parent of another version under the override", () => {
      const { bomJson } = buildBomNSData(
        { specVersion: 1.7, projectName: "mygem", projectVersion: "0.9.0" },
        [child],
        "gem",
        gemContext(),
      );
      assert.strictEqual(
        bomJson.metadata.component["bom-ref"],
        "pkg:application/mygem@0.9.0",
      );
      assert.ok(
        bomJson.components.some(
          (comp) => comp["bom-ref"] === gemDetected["bom-ref"],
        ),
      );
    });

    it("honours a caller-supplied parentComponent even when it matches", () => {
      const parentComponent = {
        "bom-ref": "pkg:generic/mygem@0.8.1",
        purl: "pkg:generic/mygem@0.8.1",
        name: "mygem",
        type: "application",
        version: "0.8.1",
      };
      const { bomJson } = buildBomNSData(
        { specVersion: 1.7, parentComponent },
        [child],
        "gem",
        gemContext(),
      );
      assert.strictEqual(
        bomJson.metadata.component["bom-ref"],
        "pkg:generic/mygem@0.8.1",
      );
    });

    it("builds an override for ecosystems whose purls need a namespace", () => {
      // Maven, Go, and Swift purls require a namespace. The override is an
      // `application`, so a project name without a group must still work.
      for (const ptype of ["maven", "golang", "swift"]) {
        const { bomJson } = buildBomNSData(
          { specVersion: 1.7, projectName: "foo", projectVersion: "1.0.0" },
          [child],
          ptype,
          context(),
        );
        assert.strictEqual(
          bomJson.metadata.component.purl,
          "pkg:application/foo@1.0.0",
        );
      }
    });

    it("drops parent external references that are not valid IRIs", async () => {
      const { bomJson } = buildBomNSData({ specVersion: 1.7 }, [child], "gem", {
        parentComponent: {
          ...gemDetected,
          externalReferences: [
            { type: "website", url: "https://example.com/mygem" },
            {
              type: "documentation",
              url: "https://example.com/#{spec.version}",
            },
          ],
        },
        dependencies: [],
      });
      assert.deepStrictEqual(bomJson.metadata.component.externalReferences, [
        { type: "website", url: "https://example.com/mygem" },
      ]);
      assert.strictEqual(await validateBom(bomJson), true);
    });

    it("leaves the caller's dependency array untouched", () => {
      const ctx = context();
      const before = JSON.parse(JSON.stringify(ctx.dependencies));
      buildBomNSData(
        { specVersion: 1.7, projectName: "monorepo", projectVersion: "9.9.9" },
        [child],
        "generic",
        ctx,
      );
      assert.deepStrictEqual(ctx.dependencies, before);
    });

    // Issue #4320: generators hand the detected parent over with transient
    // keys (`license`, `homepage`, `repository`, `evidence`, `_integrity`,
    // `qualifiers`) that only `metadata.component` used to be cleaned of.
    // Anchored as a regular component they fail schema validation.
    const licensedDetected = {
      ...detected,
      purl: "pkg:npm/myproject@1.0.0",
      "bom-ref": "pkg:npm/myproject@1.0.0",
      license: "Apache-2.0",
      homepage: { url: "https://example.com/myproject" },
      repository: { url: "git+https://github.com/example/myproject.git" },
      evidence: {
        identity: { field: "purl", confidence: 0.7, methods: [] },
      },
      _integrity:
        "sha512-mlYviEJVSQFSe2oNPPPUidoRv6Cb6iloaCLcdWOr7tPhBsfIw5TiS2o2WsXcXAUG9tTLO9cbLb5zcDzcVXc5w==",
      qualifiers: { arch: "x64" },
    };
    const licensedContext = () => ({
      parentComponent: { ...licensedDetected },
      dependencies: [
        {
          ref: licensedDetected["bom-ref"],
          dependsOn: [child["bom-ref"]],
        },
        { ref: child["bom-ref"], dependsOn: [] },
      ],
    });
    const overrideOptions = {
      specVersion: 1.6,
      projectName: "monorepo",
      projectVersion: "9.9.9",
    };

    it("cleans transient keys from the anchored subproject component", async () => {
      const { bomJson } = buildBomNSData(
        overrideOptions,
        [child],
        "npm",
        licensedContext(),
      );
      const anchored = bomJson.components.find(
        (comp) => comp["bom-ref"] === licensedDetected["bom-ref"],
      );
      assert.ok(anchored, "expected the detected parent to be anchored");
      for (const transientKey of [
        "license",
        "homepage",
        "repository",
        "evidence",
        "_integrity",
        "qualifiers",
      ]) {
        assert.strictEqual(
          anchored[transientKey],
          undefined,
          `anchored component must not carry '${transientKey}'`,
        );
      }
      assert.deepStrictEqual(anchored.licenses, [
        {
          license: {
            id: "Apache-2.0",
            url: "https://opensource.org/licenses/Apache-2.0",
          },
        },
      ]);
      assert.deepStrictEqual(
        (anchored.externalReferences || []).map((ref) => ref.type).sort(),
        ["vcs", "website"],
      );
      // The truncated fixture integrity decodes to 63 bytes, so it is
      // dropped rather than emitted as a corrupt digest.
      assert.strictEqual(anchored.hashes, undefined);
      assert.strictEqual(await validateBom(bomJson), true);
    });

    it("does not mutate the caller's detected parent object", () => {
      const ctx = licensedContext();
      const before = JSON.parse(JSON.stringify(ctx.parentComponent));
      buildBomNSData(overrideOptions, [child], "npm", ctx);
      assert.deepStrictEqual(ctx.parentComponent, before);
    });

    it("cleans the anchored component for an explicit options.parentComponent override", async () => {
      const explicitParent = {
        group: "",
        name: "shell",
        version: "3.2.1",
        type: "application",
        "bom-ref": "pkg:application/shell@3.2.1",
        purl: "pkg:application/shell@3.2.1",
      };
      const { bomJson } = buildBomNSData(
        { specVersion: 1.6, parentComponent: explicitParent },
        [child],
        "npm",
        licensedContext(),
      );
      assert.strictEqual(
        bomJson.metadata.component["bom-ref"],
        "pkg:application/shell@3.2.1",
      );
      const anchored = bomJson.components.find(
        (comp) => comp["bom-ref"] === licensedDetected["bom-ref"],
      );
      assert.ok(anchored, "expected the detected parent to be anchored");
      assert.strictEqual(anchored.license, undefined);
      assert.ok(anchored.licenses?.length);
      assert.strictEqual(await validateBom(bomJson), true);
    });

    // Issue #4326: workspace members nested under a detected parent carry the
    // same raw parser shape as the parent itself. Anchored without the
    // conversion `metadata.component` gets, they fail the strict Component
    // schema (`additionalProperties: false` on `homepage`/`repository`).
    const nestedDetected = {
      ...licensedDetected,
      components: [
        {
          group: "",
          name: "member",
          version: "1.2.3",
          purl: "pkg:cargo/member@1.2.3",
          "bom-ref": "pkg:cargo/member@1.2.3",
          type: "library",
          license: "MIT",
          homepage: { url: "https://example.com/member" },
          repository: { url: "https://github.com/example/member" },
          _integrity:
            "sha512-NDOSPBxcqSNHmT156HFVUjJJtSiofKkIJW+MIAXal6i3RWM8wC9l/dz+0vQUVX3btlAO3lfRs17rOHY2t9f9Gg==",
          properties: [
            { name: "internal:SrcFile", value: "crates/member/Cargo.toml" },
          ],
        },
      ],
    };
    const nestedContext = () => ({
      parentComponent: {
        ...nestedDetected,
        components: nestedDetected.components,
      },
      dependencies: [
        {
          ref: nestedDetected["bom-ref"],
          dependsOn: [nestedDetected.components[0]["bom-ref"]],
        },
      ],
    });

    it("converts nested workspace member components into schema-valid components", async () => {
      const { bomJson } = buildBomNSData(
        overrideOptions,
        [child],
        "npm",
        nestedContext(),
      );
      const anchored = bomJson.components.find(
        (comp) => comp["bom-ref"] === nestedDetected["bom-ref"],
      );
      assert.ok(anchored, "expected the detected parent to be anchored");
      const nested = anchored.components?.find(
        (comp) => comp["bom-ref"] === "pkg:cargo/member@1.2.3",
      );
      assert.ok(nested, "expected the nested member to survive anchoring");
      for (const transientKey of [
        "license",
        "homepage",
        "repository",
        "_integrity",
        "qualifiers",
      ]) {
        assert.strictEqual(
          nested[transientKey],
          undefined,
          `nested component must not carry '${transientKey}'`,
        );
      }
      assert.ok(
        nested.licenses?.some((license) => license.license?.id === "MIT"),
        "expected license converted into a licenses entry",
      );
      assert.deepStrictEqual(
        (nested.externalReferences || []).map((ref) => ref.type).sort(),
        ["vcs", "website"],
      );
      // The integrity transient is converted into a hex hashes[] entry, not
      // dropped.
      assert.deepStrictEqual(nested.hashes, [
        {
          alg: "SHA-512",
          content:
            "3433923c1c5ca92347993d79e87155523249b528a87ca908256f8c2005da97a8b745633cc02f65fddcfed2f414557ddbb6500ede57d1b35eeb387636b7d7fd1a",
        },
      ]);
      assert.strictEqual(await validateBom(bomJson), true);
    });

    it("does not mutate the caller's nested member components", () => {
      const ctx = nestedContext();
      const before = JSON.parse(JSON.stringify(ctx.parentComponent));
      buildBomNSData(overrideOptions, [child], "npm", ctx);
      assert.deepStrictEqual(ctx.parentComponent, before);
    });
  });
});

describe("reserved characters in component purls", () => {
  const cleanedVersion = (component) =>
    component.properties?.find((p) => p.name === "cdx:npm:cleanedVersion")
      ?.value;

  it("escapes a derived purl's name, group and subpath exactly once", () => {
    // Pre-escaping the parts before cdx-purl escaped them again turned
    // `@scope` into `%2540scope` and `libstdc++6` into `libstdc%252B%252B6`.
    const [os] = listComponents(
      { specVersion: 1.7 },
      null,
      [{ name: "libstdc++6", version: "12.2.0-14+deb12u1" }],
      "generic",
    );
    assert.strictEqual(
      os.purl,
      "pkg:generic/libstdc%2B%2B6@12.2.0-14%2Bdeb12u1",
    );
    assert.strictEqual(
      os["bom-ref"],
      "pkg:generic/libstdc++6@12.2.0-14+deb12u1",
    );
    const [scoped] = listComponents(
      { specVersion: 1.7 },
      null,
      [{ group: "@acme", name: "tools", version: "0.9.0+exp.sha.5114f85" }],
      "npm",
    );
    assert.strictEqual(
      scoped.purl,
      "pkg:npm/%40acme/tools@0.9.0%2Bexp.sha.5114f85",
    );
    assert.strictEqual(cleanedVersion(scoped), "0.9.0");
  });

  it("records the version npm would publish only when it differs", () => {
    const components = listComponents(
      { specVersion: 1.7 },
      null,
      [
        {
          name: "localdep",
          version: "2.0.0+local",
          purl: "pkg:npm/localdep@2.0.0%2Blocal",
        },
        {
          name: "left-pad",
          version: "1.3.0",
          purl: "pkg:npm/left-pad@1.3.0",
        },
        {
          name: "wasi",
          version: "0.11.0+wasi-snapshot-preview1",
          purl: "pkg:cargo/wasi@0.11.0%2Bwasi-snapshot-preview1",
        },
      ],
      "npm",
    );
    const byName = Object.fromEntries(components.map((c) => [c.name, c]));
    assert.strictEqual(cleanedVersion(byName.localdep), "2.0.0");
    assert.strictEqual(byName.localdep.version, "2.0.0+local");
    assert.strictEqual(cleanedVersion(byName["left-pad"]), undefined);
    // Only npm follows `npm publish`; cargo keeps build metadata.
    assert.strictEqual(cleanedVersion(byName.wasi), undefined);
  });

  it("recovers the parent purl from a decoded bom-ref and records its cleaned version", () => {
    const { bomJson } = buildBomNSData({ specVersion: 1.7 }, [], "npm", {
      parentComponent: {
        name: "app",
        version: "1.0.0+major",
        type: "application",
        "bom-ref": "pkg:npm/app@1.0.0+major",
      },
    });
    const root = bomJson.metadata.component;
    // Escaping the whole ref also escaped the `@` before the version and
    // produced a purl for a package named `app@1.0.0+major`.
    assert.strictEqual(root.purl, "pkg:npm/app@1.0.0%2Bmajor");
    assert.strictEqual(cleanedVersion(root), "1.0.0");
  });
});

describe("metadata properties handed over by a generator", () => {
  const platform = [
    { name: "cdx:composer:platform:ext-zip", value: "*" },
    { name: "cdx:composer:platform:php", value: "^8.1" },
  ];
  const log = {
    group: "psr",
    name: "log",
    version: "3.0.2",
    purl: "pkg:composer/psr/log@3.0.2",
    "bom-ref": "pkg:composer/psr/log@3.0.2",
  };

  it("buildBomNSData puts them in metadata.properties and hands them on", () => {
    const bomNSData = buildBomNSData({ specVersion: 1.7 }, [log], "composer", {
      metadataProperties: platform,
    });
    assert.deepStrictEqual(bomNSData.bomJson.metadata.properties, platform);
    assert.deepStrictEqual(bomNSData.metadataProperties, platform);
  });

  it("buildBomNSData adds no properties and hands on nothing without them", () => {
    const bomNSData = buildBomNSData({ specVersion: 1.7 }, [log], "composer", {
      src: ".",
    });
    assert.strictEqual(bomNSData.bomJson.metadata.properties, undefined);
    assert.strictEqual(bomNSData.metadataProperties, undefined);
  });

  it("dedupeBom keeps them when it rebuilds the metadata of a multi-type scan", () => {
    const { bomJson } = dedupeBom(
      { specVersion: 1.7 },
      [log],
      undefined,
      [],
      platform,
    );
    assert.deepStrictEqual(bomJson.metadata.properties, platform);
    assert.strictEqual(
      dedupeBom({ specVersion: 1.7 }, [log], undefined, []).bomJson.metadata
        .properties,
      undefined,
    );
  });
});

describe("addMetadata() oci:image:appLanguage", () => {
  const appLanguage = (Cmd) =>
    addMetadata(
      {},
      { exportData: { inspectData: { Config: { Cmd } } } },
    ).properties?.find((prop) => prop.name === "oci:image:appLanguage")?.value;

  it("names the language of the image's command, not an array position", () => {
    assert.strictEqual(appLanguage(["php", "artisan", "serve"]), "php");
    assert.strictEqual(appLanguage(["node", "server.js"]), "node");
    assert.strictEqual(appLanguage(["python3", "app.py"]), "python3");
    // A port number used to match the position "0".
    assert.strictEqual(
      appLanguage(["/app/server", "--port", "8000", "--host", "0.0.0.0"]),
      undefined,
    );
  });
});

describe("addMetadata() sub-components with the parent's coordinates", () => {
  const parent = () => ({
    type: "application",
    group: "com.example",
    name: "demo",
    version: "1.0",
    purl: "pkg:maven/com.example/demo@1.0?type=jar",
    "bom-ref": "pkg:maven/com.example/demo@1.0?type=jar",
  });

  it("drops a copy of the parent but keeps a separate project", () => {
    const parentComponent = parent();
    parentComponent.components = [
      parent(),
      {
        ...parent(),
        purl: "pkg:maven/com.example/demo@1.0?type=jar#one",
        "bom-ref": "pkg:maven/com.example/demo@1.0?type=jar#one",
      },
    ];
    const metadata = addMetadata(parentComponent, {});
    assert.deepStrictEqual(
      metadata.component.components.map((c) => c["bom-ref"]),
      ["pkg:maven/com.example/demo@1.0?type=jar#one"],
    );
  });
});

describe("metadata.tools external tool components", () => {
  // The registry is run-scoped module state; every case resets it so the
  // assertions cannot leak into each other through poku's interleaving.
  it("keeps the tools block unchanged when nothing external ran", () => {
    resetExecutedTools();
    assert.deepStrictEqual(getExecutedTools(), []);
    assert.deepStrictEqual(addToolsSection({ specVersion: 1.5 }, {}), {
      components: [
        {
          group: "@cdxgen",
          name: "cdxgen",
          version: CDXGEN_VERSION,
          purl: `pkg:npm/%40cdxgen/cdxgen@${CDXGEN_VERSION}`,
          type: "application",
          "bom-ref": `pkg:npm/@cdxgen/cdxgen@${CDXGEN_VERSION}`,
          author: "OWASP Foundation",
          publisher: "OWASP Foundation",
        },
      ],
    });
    assert.deepStrictEqual(addToolsSection({ specVersion: 1.4 }, {}), [
      { vendor: "cyclonedx", name: "cdxgen", version: CDXGEN_VERSION },
    ]);
    resetExecutedTools();
  });

  it("appends the executed tools sorted after cdxgen for 1.5+", () => {
    resetExecutedTools();
    recordExecutedTool("/usr/local/bin/zip");
    recordExecutedTool("gradle", "9.8.2");
    recordExecutedTool("mvn", "3.10.0");
    const { components } = addToolsSection({ specVersion: 1.5 }, {});
    const external = components.slice(0, -1);
    const cdxgen = components[components.length - 1];
    // cdxgen stays last in the assembled array, unchanged in shape, and the
    // executed tools are sorted by name.
    assert.strictEqual(cdxgen.name, "cdxgen");
    assert.deepStrictEqual(
      external.map((tool) => ({ name: tool.name, version: tool.version })),
      [
        { name: "gradle", version: "9.8.2" },
        { name: "mvn", version: "3.10.0" },
        { name: "zip", version: undefined },
      ],
    );
    for (const tool of external) {
      assert.strictEqual(tool.type, "application");
    }
    resetExecutedTools();
  });

  it("keeps the legacy tools array shape for spec version 1.4", () => {
    resetExecutedTools();
    recordExecutedTool("mvn", "3.10.0");
    recordExecutedTool("osqueryi");
    const tools = addToolsSection({ specVersion: 1.4 }, {});
    assert.deepStrictEqual(tools, [
      { vendor: "cyclonedx", name: "cdxgen", version: CDXGEN_VERSION },
      { name: "mvn", version: "3.10.0" },
      { name: "osqueryi" },
    ]);
    resetExecutedTools();
  });

  it("keeps context tools that share a name but differ in bom-ref", () => {
    resetExecutedTools();
    const contextTools = [
      {
        type: "application",
        group: "org.apache.maven.plugins",
        name: "maven-compiler-plugin",
        "bom-ref":
          "pkg:maven/org.apache.maven.plugins/maven-compiler-plugin@3.14.0",
      },
      {
        type: "application",
        group: "org.example.plugins",
        name: "maven-compiler-plugin",
        "bom-ref": "pkg:maven/org.example.plugins/maven-compiler-plugin@1.0.0",
      },
    ];
    const { components } = addToolsSection(
      { specVersion: 1.5 },
      { tools: contextTools },
    );
    assert.deepStrictEqual(
      components.slice(0, -1).map((component) => component["bom-ref"]),
      contextTools.map((component) => component["bom-ref"]),
    );
  });

  it("forgets the executed tools when the run state is reset", () => {
    resetExecutedTools();
    recordExecutedTool("mvn", "3.10.0");
    resetRunState();
    assert.deepStrictEqual(getExecutedTools(), []);
    assert.deepStrictEqual(
      addToolsSection({ specVersion: 1.5 }, {}).components.map(
        (component) => component.name,
      ),
      ["cdxgen"],
    );
  });

  it("de-duplicates context tools against the registry by name", () => {
    resetExecutedTools();
    recordExecutedTool("osqueryi", "5.24.0");
    const contextTools = [
      {
        type: "application",
        name: "osqueryi",
        version: "5.24.0",
        "bom-ref": "pkg:generic/osquery/osqueryi@5.24.0",
      },
    ];
    const { components } = addToolsSection(
      { specVersion: 1.5 },
      { tools: contextTools },
    );
    const osqueryEntries = components.filter(
      (component) => component.name === "osqueryi",
    );
    assert.deepStrictEqual(osqueryEntries.length, 1);
    // The explicitly passed context entry wins.
    assert.strictEqual(
      osqueryEntries[0]["bom-ref"],
      "pkg:generic/osquery/osqueryi@5.24.0",
    );
    resetExecutedTools();
  });

  it("enriches bundled plugin helpers with the manifest component", () => {
    resetExecutedTools();
    // trivy ships in cdxgen-plugins-bin; its manifest carries the plugin
    // package version, purl, and hashes. Skip the assertion when the optional
    // plugin package (and its manifest) is not installed.
    const manifestComponents = getPluginToolComponents(["trivy"]);
    if (!manifestComponents.length) {
      resetExecutedTools();
      return;
    }
    recordExecutedTool("trivy");
    const { components } = addToolsSection({ specVersion: 1.5 }, {});
    const trivy = components.find((component) => component.name === "trivy");
    assert.ok(trivy, "trivy tool component missing");
    assert.strictEqual(trivy["bom-ref"], manifestComponents[0]["bom-ref"]);
    assert.ok(trivy.version, "plugin version missing");
    resetExecutedTools();
  });
});
