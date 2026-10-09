import { assert, describe, it } from "poku";

import {
  classifyVcsRef,
  classifyVersionConstraint,
  OPENTOFU_REGISTRY_HOST,
  parseModuleSource,
  parseProviderSource,
  TERRAFORM_REGISTRY_HOST,
} from "./terraformSource.js";

const SHA_40 = "3d8f2c9a1b07e645f2c9ab8d0e1f23456789abcd";
const SHA_64 =
  "9f1c2a3b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8";
const SHA_256_HEX = "a".repeat(64);

describe("parseModuleSource", () => {
  const cases = [
    // Local sources
    {
      source: "./modules/network",
      expect: { kind: "local", path: "./modules/network" },
    },
    { source: ".", expect: { kind: "local", path: "." } },
    { source: "..", expect: { kind: "local", path: ".." } },
    { source: "../sibling", expect: { kind: "local", path: "../sibling" } },
    {
      source: ".\\modules\\network",
      expect: { kind: "local", path: ".\\modules\\network" },
    },
    // Absolute paths are file sources
    { source: "/opt/modules/vpc", expect: { kind: "file" } },
    { source: "C:\\modules\\vpc", expect: { kind: "file" } },
    { source: "c:/modules/vpc", expect: { kind: "file" } },
    // Registry shorthand, with and without host and subdirectory
    {
      source: "terraform-aws-modules/vpc/aws",
      expect: {
        kind: "registry",
        host: "registry.terraform.io",
        namespace: "terraform-aws-modules",
        name: "vpc",
        system: "aws",
        address: "registry.terraform.io/terraform-aws-modules/vpc/aws",
        displaySource: "registry.terraform.io/terraform-aws-modules/vpc/aws",
      },
    },
    {
      source: "hashicorp/consul/aws//modules/consul-cluster",
      expect: {
        kind: "registry",
        address: "registry.terraform.io/hashicorp/consul/aws",
        subdir: "modules/consul-cluster",
        displaySource:
          "registry.terraform.io/hashicorp/consul/aws//modules/consul-cluster",
      },
    },
    {
      source: "registry.opentofu.org/cloudposse/label/null",
      expect: {
        kind: "registry",
        host: "registry.opentofu.org",
        address: "registry.opentofu.org/cloudposse/label/null",
        displaySource: "registry.opentofu.org/cloudposse/label/null",
      },
    },
    {
      source: "app.terraform.io/hashicorp/aws/aws",
      expect: {
        kind: "registry",
        host: "app.terraform.io",
        address: "app.terraform.io/hashicorp/aws/aws",
      },
    },
    // Forced git getters
    {
      source:
        "git::https://github.com/cloudposse/terraform-null-label.git?ref=0.25.0",
      expect: {
        kind: "git",
        url: "https://github.com/cloudposse/terraform-null-label.git",
        ref: "0.25.0",
        displaySource:
          "git::https://github.com/cloudposse/terraform-null-label.git",
      },
    },
    {
      source:
        "git::ssh://git@example.com/platform/network.git//modules/vpc?ref=main",
      expect: {
        kind: "git",
        url: "ssh://example.com/platform/network.git",
        ref: "main",
        subdir: "modules/vpc",
        displaySource:
          "git::ssh://example.com/platform/network.git//modules/vpc",
      },
    },
    {
      source: "git::git@example.com:org/repo.git?ref=v1",
      expect: {
        kind: "git",
        url: "ssh://example.com/org/repo.git",
        ref: "v1",
        displaySource: "git::ssh://example.com/org/repo.git",
      },
    },
    { source: "git::file:///opt/modules/vpc", expect: { kind: "file" } },
    // Forced hg getter takes rev, accepts ref
    {
      source: "hg::http://hg.example.com/infra/repo?rev=tip",
      expect: {
        kind: "hg",
        url: "http://hg.example.com/infra/repo",
        ref: "tip",
        displaySource: "hg::http://hg.example.com/infra/repo",
      },
    },
    {
      source: "hg::https://hg.example.com/infra/repo?ref=v2.1.0",
      expect: {
        kind: "hg",
        url: "https://hg.example.com/infra/repo",
        ref: "v2.1.0",
      },
    },
    { source: "hg::git@example.com:repo", expect: { kind: "unknown" } },
    // Archive sources over http, s3 and gcs
    {
      source: `https://artifacts.example.com/modules/vpc-1.4.0.zip?checksum=sha256:${SHA_256_HEX}`,
      expect: {
        kind: "http",
        url: "https://artifacts.example.com/modules/vpc-1.4.0.zip",
        archive: true,
        checksum: { alg: "SHA-256", content: SHA_256_HEX },
        displaySource: "https://artifacts.example.com/modules/vpc-1.4.0.zip",
      },
    },
    {
      source: `s3::https://bucket.s3.amazonaws.com/modules/app.zip?aws_access_key_id=AKIAEXAMPLE&checksum=md5:${"b".repeat(32)}`,
      expect: {
        kind: "s3",
        url: "https://bucket.s3.amazonaws.com/modules/app.zip",
        archive: true,
        checksum: { alg: "MD5", content: "b".repeat(32) },
        credentialInSource: true,
        displaySource: "s3::https://bucket.s3.amazonaws.com/modules/app.zip",
      },
    },
    {
      source:
        "gcs::https://www.googleapis.com/storage/v1/b/modules/o/app.tar.gz//inner",
      expect: {
        kind: "gcs",
        url: "https://www.googleapis.com/storage/v1/b/modules/o/app.tar.gz",
        subdir: "inner",
        archive: true,
        displaySource:
          "gcs::https://www.googleapis.com/storage/v1/b/modules/o/app.tar.gz//inner",
      },
    },
    {
      source: "https://example.com/app.txt?archive=zip",
      expect: {
        kind: "http",
        url: "https://example.com/app.txt",
        archive: true,
      },
    },
    // Detected without a getter
    {
      source: `github.com/acme/terraform-modules//dns?ref=${SHA_40}`,
      expect: {
        kind: "git",
        url: "https://github.com/acme/terraform-modules.git",
        ref: SHA_40,
        subdir: "dns",
        displaySource:
          "git::https://github.com/acme/terraform-modules.git//dns",
      },
    },
    {
      source: "github.com/acme/terraform-modules/x/y?ref=v3",
      expect: {
        kind: "git",
        url: "https://github.com/acme/terraform-modules.git",
        ref: "v3",
        subdir: "x/y",
      },
    },
    {
      source: "bitbucket.org/atlassian/terraform-modules.git",
      expect: {
        kind: "git",
        url: "https://bitbucket.org/atlassian/terraform-modules.git",
        displaySource:
          "git::https://bitbucket.org/atlassian/terraform-modules.git",
      },
    },
    {
      source: "git@gitlab.com:acme/infra/modules.git?ref=main",
      expect: {
        kind: "git",
        url: "ssh://gitlab.com/acme/infra/modules.git",
        ref: "main",
        displaySource: "git::ssh://gitlab.com/acme/infra/modules.git",
      },
    },
    {
      source: "https://example.com/not-an-archive.txt",
      expect: {
        kind: "http",
        url: "https://example.com/not-an-archive.txt",
      },
    },
    // Unknown and rejected forms
    { source: "git::ftp://example.com/repo.git", expect: { kind: "unknown" } },
    {
      source: "ftp::https://example.com/repo.git",
      expect: { kind: "unknown" },
    },
    { source: "ssh::git@example.com:org/repo", expect: { kind: "unknown" } },
    { source: "", expect: { kind: "unknown" } },
    { source: "   ", expect: { kind: "unknown" } },
    // Registry negatives
    { source: "hashicorp/aws", expect: { kind: "unknown" } },
    {
      source: "registry.terraform.io/hashicorp/consul/aws/extra",
      expect: { kind: "unknown" },
    },
    {
      source: "registry.terraform.io/hashi corp/aws",
      expect: { kind: "unknown" },
    },
    {
      source: "registry.terraform.io/hashicorp/consul/AWS",
      expect: { kind: "unknown" },
    },
    { source: "hashicorp/consul/aws//../escape", expect: { kind: "unknown" } },
  ];

  for (const { source, expect } of cases) {
    it(`classifies ${JSON.stringify(source).slice(0, 64)}`, () => {
      const result = parseModuleSource(source);
      assert.ok(result, "returns a descriptor for strings");
      for (const [key, value] of Object.entries(expect)) {
        assert.deepStrictEqual(
          result[key],
          value,
          `${key} of ${source}: ${JSON.stringify(result[key])}`,
        );
      }
      assert.strictEqual(
        result.credentialInSource,
        !!expect.credentialInSource,
      );
    });
  }

  it("returns null for non-strings", () => {
    assert.strictEqual(parseModuleSource(undefined), null);
    assert.strictEqual(parseModuleSource(42), null);
  });

  it("keeps the host part of the gitlab github family exact", () => {
    // `github.com/a/b` is a git source, never a registry one, even though it
    // has three segments.
    const result = parseModuleSource("github.com/a/b");
    assert.strictEqual(result.kind, "git");
    assert.strictEqual(result.url, "https://github.com/a/b.git");
  });

  it("honours defaultRegistryHost", () => {
    const result = parseModuleSource("cloudposse/label/null", {
      defaultRegistryHost: OPENTOFU_REGISTRY_HOST,
    });
    assert.strictEqual(result.kind, "registry");
    assert.strictEqual(result.host, "registry.opentofu.org");
    assert.strictEqual(
      result.address,
      "registry.opentofu.org/cloudposse/label/null",
    );
    assert.strictEqual(
      TERRAFORM_REGISTRY_HOST,
      "registry.terraform.io",
      "default host constant",
    );
  });

  it("detects credentials without copying them into the result", () => {
    const result = parseModuleSource(
      "git::https://ci-bot:S3cr3tP4ss@git.example.com/infra/db.git?ref=v2.0.0&sshkey=U1NIS0VZ",
    );
    assert.strictEqual(result.kind, "git");
    assert.strictEqual(result.credentialInSource, true);
    assert.strictEqual(
      result.url,
      "https://git.example.com/infra/db.git",
      "userinfo stripped",
    );
    assert.strictEqual(result.ref, "v2.0.0");
    assert.strictEqual(
      result.displaySource,
      "git::https://git.example.com/infra/db.git",
    );
    const serialized = JSON.stringify(result);
    for (const secret of ["S3cr3tP4ss", "U1NIS0VZ", "ci-bot", "sshkey"]) {
      assert.ok(!serialized.includes(secret), `${secret} must not appear`);
    }
  });

  it("flags a password in scp-style userinfo", () => {
    const result = parseModuleSource(
      "git::deploy:key@example.com:org/repo.git?ref=v1",
    );
    assert.strictEqual(result.kind, "git");
    assert.strictEqual(result.credentialInSource, true);
    assert.strictEqual(result.url, "ssh://example.com/org/repo.git");
    assert.ok(!JSON.stringify(result).includes("deploy:key"));
  });

  it("drops a username silently", () => {
    const result = parseModuleSource(
      "git::https://ci-bot@git.example.com/infra/db.git?ref=v2.0.0",
    );
    assert.strictEqual(result.credentialInSource, false);
    assert.strictEqual(result.url, "https://git.example.com/infra/db.git");
    assert.ok(!JSON.stringify(result).includes("ci-bot"));
  });

  it("ignores checksums of the wrong length or algorithm", () => {
    const short = parseModuleSource(
      `https://example.com/a.zip?checksum=sha256:${"a".repeat(32)}`,
    );
    assert.strictEqual(short.checksum, undefined);
    const unknown = parseModuleSource(
      `https://example.com/a.zip?checksum=crc32:${"a".repeat(8)}`,
    );
    assert.strictEqual(unknown.checksum, undefined);
  });
});

describe("classifyVersionConstraint", () => {
  const cases = [
    ["5.1.2", { pinning: "exact", version: "5.1.2" }],
    ["= 4.2.1", { pinning: "exact", version: "4.2.1" }],
    ["=4.2.1", { pinning: "exact", version: "4.2.1" }],
    ["5", { pinning: "exact", version: "5" }],
    ["5.0", { pinning: "exact", version: "5.0" }],
    ["v1.2.3", { pinning: "exact", version: "v1.2.3" }],
    ["1.0.0-rc.1+build.2", { pinning: "exact", version: "1.0.0-rc.1+build.2" }],
    ["~> 5.1", { pinning: "range" }],
    [">= 5.0.0", { pinning: "range" }],
    [">= 5.0, < 6.0", { pinning: "range" }],
    ["!= 1.0.0", { pinning: "range" }],
    ["= 1.x", { pinning: "range" }],
    [undefined, { pinning: "none" }],
    ["", { pinning: "none" }],
    ["   ", { pinning: "none" }],
  ];
  for (const [constraint, expected] of cases) {
    it(`classifies ${JSON.stringify(constraint)} as ${expected.pinning}`, () => {
      assert.deepStrictEqual(classifyVersionConstraint(constraint), expected);
    });
  }
});

describe("classifyVcsRef", () => {
  const cases = [
    [undefined, "none"],
    ["", "none"],
    [SHA_40, "sha"],
    [SHA_64, "sha"],
    [SHA_40.toUpperCase(), "sha"],
    ["v1.0", "tag"],
    ["1.2.3", "tag"],
    ["v1.2.3-rc.1", "tag"],
    ["0.25.0", "tag"],
    ["main", "branch"],
    ["release/1.0", "branch"],
    ["refs/heads/main", "branch"],
    ["x".repeat(256), "branch"],
  ];
  for (const [ref, expected] of cases) {
    it(`classifies ${JSON.stringify(ref && ref.slice(0, 24))} as ${expected}`, () => {
      assert.strictEqual(classifyVcsRef(ref), expected);
    });
  }
});

describe("parseProviderSource", () => {
  it("parses shorthand with the default host", () => {
    assert.deepStrictEqual(parseProviderSource("hashicorp/aws"), {
      host: "registry.terraform.io",
      namespace: "hashicorp",
      type: "aws",
      address: "registry.terraform.io/hashicorp/aws",
    });
  });

  it("parses a fully qualified address and lower-cases it", () => {
    assert.deepStrictEqual(
      parseProviderSource("Registry.Terraform.io/Hashicorp/AWS"),
      {
        host: "registry.terraform.io",
        namespace: "hashicorp",
        type: "aws",
        address: "registry.terraform.io/hashicorp/aws",
      },
    );
  });

  it("uses the caller's default host for shorthand", () => {
    assert.deepStrictEqual(
      parseProviderSource("hashicorp/aws", {
        defaultRegistryHost: OPENTOFU_REGISTRY_HOST,
      }),
      {
        host: "registry.opentofu.org",
        namespace: "hashicorp",
        type: "aws",
        address: "registry.opentofu.org/hashicorp/aws",
      },
    );
  });

  it("recognises built-in providers", () => {
    assert.deepStrictEqual(
      parseProviderSource("terraform.io/builtin/terraform"),
      { builtin: true },
    );
    assert.deepStrictEqual(parseProviderSource("terraform.io/builtin/legacy"), {
      builtin: true,
    });
  });

  it("rejects other forms", () => {
    assert.strictEqual(parseProviderSource(undefined), null);
    assert.strictEqual(parseProviderSource(""), null);
    assert.strictEqual(parseProviderSource("aws"), null);
    assert.strictEqual(
      parseProviderSource("registry.terraform.io/hashicorp"),
      null,
    );
    assert.strictEqual(
      parseProviderSource("registry.terraform.io/a/b/c"),
      null,
    );
    assert.strictEqual(parseProviderSource("git::https://example.com/p"), null);
    assert.strictEqual(parseProviderSource("localhost:8080/a/b"), null);
  });
});
