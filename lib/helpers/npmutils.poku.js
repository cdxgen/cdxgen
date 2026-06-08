import { assert, describe, it } from "poku";

import {
  buildNpmGitDistributionIntakeRefs,
  buildNpmGitPurlQualifiers,
  buildNpmRegistryTarballUrl,
  normalizeNpmRegistryUrl,
  normalizeNpmScopeGroup,
  resolveNpmRegistryUrlForGitPackage,
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
