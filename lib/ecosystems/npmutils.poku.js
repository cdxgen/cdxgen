import { assert, describe, it } from "poku";

import {
  buildNpmGitDistributionIntakeRefs,
  buildNpmGitPurlQualifiers,
  buildNpmRegistryTarballUrl,
  buildPnpmGitPkgRefs,
  cleanNpmVersion,
  collectNpmManifestSources,
  findMatchingNpmWorkspace,
  normalizeNpmRegistryUrl,
  normalizeNpmScopeGroup,
  resolveNpmLicense,
  resolveNpmRegistryUrlForGitPackage,
  setNpmCleanedVersionProperty,
} from "./npmutils.js";

describe("npmutils tests", () => {
  it("normalizeNpmRegistryUrl removes trailing slash from valid registry url", () => {
    assert.strictEqual(
      normalizeNpmRegistryUrl("https://registry.npmjs.org/"),
      "https://registry.npmjs.org",
    );
    assert.strictEqual(
      normalizeNpmRegistryUrl("https://registry.npmjs.org"),
      "https://registry.npmjs.org",
    );
    assert.strictEqual(
      normalizeNpmRegistryUrl("  https://registry.npmjs.org/  "),
      "https://registry.npmjs.org",
    );
    assert.strictEqual(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal token pattern
      normalizeNpmRegistryUrl("https://registry.npmjs.org/${NPM_TOKEN}"),
      undefined,
    );
    assert.strictEqual(normalizeNpmRegistryUrl(""), undefined);
  });

  it("normalizeNpmScopeGroup strips @ from group name", () => {
    assert.strictEqual(normalizeNpmScopeGroup("@my-scope"), "my-scope");
    assert.strictEqual(normalizeNpmScopeGroup("my-scope"), "my-scope");
    assert.strictEqual(normalizeNpmScopeGroup(""), "");
    assert.strictEqual(normalizeNpmScopeGroup(null), "");
  });

  it("resolveNpmRegistryUrlForGitPackage resolves registry urls", () => {
    const config = {
      registry: "https://default.registry.com/",
      "@my-scope:registry": "https://scoped.registry.com/",
    };
    assert.strictEqual(
      resolveNpmRegistryUrlForGitPackage("@my-scope", config),
      "https://scoped.registry.com",
    );
    assert.strictEqual(
      resolveNpmRegistryUrlForGitPackage("other-scope", config),
      "https://default.registry.com",
    );
    assert.strictEqual(
      resolveNpmRegistryUrlForGitPackage(null, config),
      "https://default.registry.com",
    );
  });

  it("buildNpmGitPurlQualifiers constructs correct purl qualifiers", () => {
    const config = {
      registry: "https://default.registry.com/",
      "@my-scope:registry": "https://scoped.registry.com/",
    };
    const qualifiers = buildNpmGitPurlQualifiers(
      "git+ssh://git@github.com/my-scope/my-project.git#commit-sha",
      "@my-scope",
      config,
    );
    assert.strictEqual(
      qualifiers.vcs_url,
      "git+ssh://git@github.com/my-scope/my-project.git#commit-sha",
    );
    assert.strictEqual(
      qualifiers.repository_url,
      "https://scoped.registry.com",
    );
  });

  it("buildNpmRegistryTarballUrl appends path segments correctly", () => {
    assert.strictEqual(
      buildNpmRegistryTarballUrl(
        "https://registry.npmjs.org",
        null,
        "asap",
        "2.0.5",
      ),
      "https://registry.npmjs.org/asap/-/asap-2.0.5.tgz",
    );
    assert.strictEqual(
      buildNpmRegistryTarballUrl(
        "https://registry.npmjs.org",
        "@group",
        "my_project",
        "1.0.6",
      ),
      "https://registry.npmjs.org/@group/my_project/-/my_project-1.0.6.tgz",
    );
  });

  it("buildNpmGitDistributionIntakeRefs builds distribution intake list", () => {
    const config = {
      "@my-scope:registry": "https://scoped.registry.com/",
    };
    const refs = buildNpmGitDistributionIntakeRefs(
      "@my-scope",
      "my-project",
      "1.0.6",
      config,
    );
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].type, "distribution-intake");
    assert.strictEqual(
      refs[0].url,
      "https://scoped.registry.com/@my-scope/my-project/-/my-project-1.0.6.tgz",
    );
  });
});

describe("cleanNpmVersion()", () => {
  it("drops semver build metadata as npm publish does", () => {
    assert.strictEqual(cleanNpmVersion("1.0.0+major"), "1.0.0");
    assert.strictEqual(cleanNpmVersion("1.0.0-rc.1+build.5"), "1.0.0-rc.1");
  });

  it("normalises the forms npm pkg fix rewrites before publishing", () => {
    assert.strictEqual(cleanNpmVersion("v1.2.3"), "1.2.3");
    assert.strictEqual(cleanNpmVersion("=1.2.3"), "1.2.3");
    assert.strictEqual(cleanNpmVersion(" 1.2.3 "), "1.2.3");
    // Loose-only forms are accepted by the `npm pkg fix` step and then
    // written in strict form.
    assert.strictEqual(cleanNpmVersion("1.2.3-beta.01"), "1.2.3-beta.1");
    assert.strictEqual(cleanNpmVersion("01.2.3"), "1.2.3");
  });

  it("keeps a version that is already clean", () => {
    assert.strictEqual(cleanNpmVersion("1.2.3"), "1.2.3");
    assert.strictEqual(cleanNpmVersion("1.2.3-alpha.1"), "1.2.3-alpha.1");
  });

  it("returns null for anything npm would reject as a version", () => {
    for (const version of [
      "1.2",
      "latest",
      "file:../local",
      "github:user/repo#abc",
      "",
      undefined,
      null,
    ]) {
      assert.strictEqual(cleanNpmVersion(version), null, String(version));
    }
  });
});

describe("setNpmCleanedVersionProperty()", () => {
  const cleanedValues = (component) =>
    (component.properties || [])
      .filter((p) => p.name === "cdx:npm:cleanedVersion")
      .map((p) => p.value);

  it("records the published form next to the recorded version", () => {
    const component = setNpmCleanedVersionProperty({
      name: "app",
      version: "1.0.0+build.5",
      purl: "pkg:npm/app@1.0.0%2Bbuild.5",
    });
    assert.deepStrictEqual(cleanedValues(component), ["1.0.0"]);
    // The recorded identity is left alone.
    assert.strictEqual(component.version, "1.0.0+build.5");
    assert.strictEqual(component.purl, "pkg:npm/app@1.0.0%2Bbuild.5");
  });

  it("leaves a clean or non-semver version without the property", () => {
    for (const version of ["1.0.0", "file:../local", undefined]) {
      const component = setNpmCleanedVersionProperty({
        name: "app",
        version,
        purl: "pkg:npm/app",
        properties: [{ name: "cdx:npm:isLink", value: "true" }],
      });
      assert.deepStrictEqual(cleanedValues(component), [], String(version));
      assert.strictEqual(component.properties.length, 1);
    }
  });

  it("only annotates npm components", () => {
    const component = setNpmCleanedVersionProperty({
      name: "wasi",
      version: "0.11.0+wasi-snapshot-preview1",
      purl: "pkg:cargo/wasi@0.11.0%2Bwasi-snapshot-preview1",
    });
    assert.strictEqual(component.properties, undefined);
    assert.strictEqual(setNpmCleanedVersionProperty(undefined), undefined);
  });

  it("replaces a stale value and never duplicates the property", () => {
    const component = {
      name: "app",
      version: "2.0.0+local",
      purl: "pkg:npm/app@2.0.0%2Blocal",
      properties: [
        { name: "cdx:npm:cleanedVersion", value: "1.0.0" },
        { name: "cdx:npm:cleanedVersion", value: "1.0.0" },
      ],
    };
    setNpmCleanedVersionProperty(component);
    setNpmCleanedVersionProperty(component);
    assert.deepStrictEqual(cleanedValues(component), ["2.0.0"]);
    component.version = "2.0.0";
    component.purl = "pkg:npm/app@2.0.0";
    setNpmCleanedVersionProperty(component);
    assert.deepStrictEqual(cleanedValues(component), []);
  });
});

describe("collectNpmManifestSources()", () => {
  it("ignores the workspace edges arborist synthesizes", () => {
    const sources = collectNpmManifestSources({
      edgesIn: [
        {
          type: "workspace",
          workspace: true,
          spec: "file:/home/user/project/packages/member",
        },
        { type: "prod", workspace: false, spec: "*" },
        { type: "prod", workspace: false, spec: "file:./localdep.tgz" },
      ],
    });
    assert.deepStrictEqual(sources, [
      { type: "path", value: "file:./localdep.tgz" },
    ]);
  });
});

describe("findMatchingNpmWorkspace()", () => {
  it("matches the whole package name, whether the ref is escaped or decoded", () => {
    const workspaces = [
      "pkg:npm/wsmember@3.0.0%2Bws",
      "pkg:npm/%40acme/tools@0.9.0",
      "pkg:npm/ws@0.1.0",
    ];
    assert.strictEqual(
      findMatchingNpmWorkspace(workspaces, "ws"),
      "pkg:npm/ws@0.1.0",
    );
    assert.strictEqual(
      findMatchingNpmWorkspace(workspaces, "wsmember"),
      "pkg:npm/wsmember@3.0.0%2Bws",
    );
    assert.strictEqual(
      findMatchingNpmWorkspace(
        ["pkg:npm/@acme/tools@0.9.0+exp"],
        "@acme/tools",
      ),
      "pkg:npm/@acme/tools@0.9.0+exp",
    );
    assert.strictEqual(findMatchingNpmWorkspace(workspaces, "w"), undefined);
    assert.strictEqual(
      findMatchingNpmWorkspace(workspaces, "@acme/tool"),
      undefined,
    );
  });
});

describe("buildPnpmGitPkgRefs prototype safety", () => {
  it("ignores git lock entries named __proto__ and keeps unknown lookups undefined", () => {
    const packages = {
      "lodash@git+https://github.com/lodash/lodash.git#abc123": {
        resolution: {
          type: "git",
          repo: "https://github.com/lodash/lodash.git",
          commit: "abc123",
        },
        version: "4.17.21",
      },
      "__proto__@git+https://evil.example/backdoor.git#deadbeef": {
        resolution: {
          type: "git",
          repo: "https://evil.example/backdoor.git",
          commit: "deadbeef",
        },
        version: "66.6.0",
      },
    };
    const refs = buildPnpmGitPkgRefs(packages, {});
    assert.ok(refs["lodash@git+https://github.com/lodash/lodash.git#abc123"]);
    // biome-ignore lint/suspicious/noProto: asserting the crafted key stays unregistered
    assert.strictEqual(refs["__proto__"], undefined);
    // Unrelated package names must not inherit anything: the poisoned-lookup
    // hazard from a crafted lock file is gone.
    assert.strictEqual(refs["react"], undefined);
    assert.strictEqual(refs["some-unrelated-pkg"], undefined);
    assert.strictEqual(Object.getPrototypeOf(refs), null);
  });

  it("resolveNpmLicense returns modern license values untouched", () => {
    assert.strictEqual(resolveNpmLicense({ license: "MIT" }), "MIT");
    assert.deepStrictEqual(
      resolveNpmLicense({
        license: { type: "MIT", url: "https://example.com" },
      }),
      { type: "MIT", url: "https://example.com" },
    );
    // The modern field wins over the legacy one.
    assert.strictEqual(
      resolveNpmLicense({ license: "ISC", licenses: [{ type: "MIT" }] }),
      "ISC",
    );
    // An empty, blank or null license is no declaration at all and defers to
    // `licenses`.
    for (const license of ["", "  ", null]) {
      assert.strictEqual(resolveNpmLicense({ license }), undefined);
      assert.strictEqual(
        resolveNpmLicense({ license, licenses: ["MIT"] }),
        "MIT",
        JSON.stringify(license),
      );
    }
  });

  it("resolveNpmLicense resolves the legacy licenses array format", () => {
    // Issue 4466: fuzzy 0.1.3 still publishes `licenses` instead of `license`.
    // The real manifest is committed under test/data/package-json/legacy-licenses.
    assert.deepStrictEqual(
      resolveNpmLicense({
        licenses: [
          {
            type: "MIT",
            url: "https://github.com/mattyork/fuzzy/blob/master/LICENSE-MIT",
          },
        ],
      }),
      {
        type: "MIT",
        url: "https://github.com/mattyork/fuzzy/blob/master/LICENSE-MIT",
      },
    );
    // One entry is returned as it is, whether alone or in an array.
    assert.deepStrictEqual(resolveNpmLicense({ licenses: ["MIT"] }), "MIT");
    assert.deepStrictEqual(resolveNpmLicense({ licenses: "MIT" }), "MIT");
    assert.deepStrictEqual(resolveNpmLicense({ licenses: { type: "MIT" } }), {
      type: "MIT",
    });
    // npm documents several entries as a choice between them: the example in
    // its package.json docs is today's `(MIT OR Apache-2.0)`.
    assert.strictEqual(
      resolveNpmLicense({
        licenses: [
          {
            type: "MIT",
            url: "https://www.opensource.org/licenses/mit-license.php",
          },
          {
            type: "Apache-2.0",
            url: "https://opensource.org/licenses/apache2.0.php",
          },
        ],
      }),
      "MIT OR Apache-2.0",
    );
    assert.strictEqual(
      resolveNpmLicense({ licenses: ["MIT", { type: "BSD-2-Clause" }, "MIT"] }),
      "MIT OR BSD-2-Clause",
    );
    // Without SPDX identifiers there is no expression to write; the entries
    // stay a list of named licenses.
    assert.deepStrictEqual(
      resolveNpmLicense({ licenses: [{ type: "MIT" }, { type: "GPL" }] }),
      [{ type: "MIT" }, { type: "GPL" }],
    );
  });

  it("resolveNpmLicense ignores malformed legacy licenses data", () => {
    assert.strictEqual(
      resolveNpmLicense({ licenses: [{ url: "no-type" }, "", null, {}] }),
      undefined,
    );
    // The valid entries of a partly malformed array still count.
    assert.strictEqual(
      resolveNpmLicense({ licenses: [{ url: "no-type" }, "MIT"] }),
      "MIT",
    );
    assert.strictEqual(resolveNpmLicense({ licenses: [] }), undefined);
    assert.strictEqual(resolveNpmLicense({ licenses: 42 }), undefined);
    assert.strictEqual(
      resolveNpmLicense({ name: "no-license-field" }),
      undefined,
    );
    assert.strictEqual(resolveNpmLicense(undefined), undefined);
    assert.strictEqual(resolveNpmLicense("MIT"), undefined);
  });
});
