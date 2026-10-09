import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { assert, describe, it } from "poku";

import {
  parseTerraformLockFile,
  parseTerraformWorkspace,
} from "./parsers-terraform.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "test", "data");

/** Normalize a path so assertions hold on Windows too. */
const norm = (p) => (p || "").split(sep).join("/");

const prop = (pkg, name) =>
  (pkg.properties || []).find((entry) => entry.name === name)?.value;

const PARENT_REF = "pkg:generic/parent@latest";

/** Write a file (creating parent directories) inside a temp tree. */
const write = (root, rel, content) => {
  const segments = rel.split("/");
  const target = join(root, ...segments);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
};

const summarize = (result) => ({
  pkgList: result.pkgList,
  dependencies: result.dependencies,
  parentProperties: result.parentProperties,
});

describe("parseTerraformLockFile", () => {
  it("parses providers with generic purls, constraints, and zip digests", () => {
    const { pkgList } = parseTerraformLockFile(
      "./test/data/terraform-smoke/.terraform.lock.hcl",
    );
    assert.strictEqual(pkgList.length, 2);

    const aws = pkgList.find((p) => p.name === "aws");
    assert.strictEqual(aws.group, "registry.terraform.io/hashicorp");
    assert.strictEqual(aws.version, "5.80.0");
    assert.strictEqual(
      aws.purl,
      "pkg:generic/registry.terraform.io/hashicorp/aws@5.80.0",
    );
    assert.strictEqual(
      aws.properties.find((p) => p.name === "cdx:purl:proposedType").value,
      "terraform-provider",
    );
    assert.strictEqual(
      aws.properties.find((p) => p.name === "cdx:tf:kind").value,
      "provider",
    );
    assert.strictEqual(
      aws.properties.find((p) => p.name === "cdx:tf:constraints").value,
      ">= 5.0.0",
    );
    assert.strictEqual(
      aws.properties.find((p) => p.name === "cdx:tf:address").value,
      "registry.terraform.io/hashicorp/aws",
    );

    // A zh: digest is the SHA-256 of a published provider zip, so it is what
    // the hashes array can carry; the provider is published once per
    // platform, which is why a block yields more than one.
    assert.deepStrictEqual(
      aws.hashes,
      [
        "274f8d3e3a20b9604baa5e6ccc70c6a904a0973f3e6274b6ffef6d02a4d3c6b4",
        "8dcb9bd1a0ba1bbd0ec64a1ba5e0e2e0c2e4b8c9d0a1e6f3b2c5d8e9f0a1b2c3",
      ].map((content) => ({ alg: "SHA-256", content })),
    );

    // An h1: digest hashes the package contents rather than the archive, so
    // it is kept as a property instead of being labelled SHA-256.
    assert.strictEqual(
      aws.properties.find((p) => p.name === "cdx:tf:h1").value,
      "h1:JNWQeVmmv5FTRgQ4lFzptzk3PQBIJDYzI8+qNjsVgp0=",
    );

    const random = pkgList.find((p) => p.name === "random");
    assert.strictEqual(random.version, "3.6.3");
    // The fixture writes this block's first digest on the hashes bracket line.
    assert.deepStrictEqual(random.hashes, [
      {
        alg: "SHA-256",
        content:
          "1b12d1c5b7f83f80a76c38af2aa0ecdfcb8a10f8d6183e47a3f1e0ec074b30ec",
      },
    ]);
    assert.strictEqual(
      random.properties.find((p) => p.name === "cdx:tf:h1").value,
      "h1:xZcaobHj6bc4S7g4Em3p6iZr8thjpCgxoQmuZO8M4Ew=",
    );
  });

  it("returns no providers for unreadable input", () => {
    const { pkgList } = parseTerraformLockFile(
      "./test/data/terraform-smoke/missing.lock.hcl",
    );
    assert.deepStrictEqual(pkgList, []);
  });
});

describe("parseTerraformWorkspace (installed layout)", () => {
  const result = parseTerraformWorkspace(
    join(FIXTURES, "terraform-modules"),
    { multiProject: false },
    PARENT_REF,
  );

  it("emits exactly the expected module and provider components", () => {
    assert.deepStrictEqual(result.pkgList.map((p) => p.purl).sort(), [
      "pkg:generic/registry.terraform.io/cloudposse/label/null@0.25.0",
      "pkg:generic/registry.terraform.io/hashicorp/aws@5.80.0",
      "pkg:generic/registry.terraform.io/hashicorp/random@3.6.3",
      "pkg:generic/registry.terraform.io/terraform-aws-modules/vpc/aws@5.1.2",
      "pkg:github/cloudposse/terraform-null-label@0.25.0",
    ]);
    // Local modules and comment/heredoc phantoms never become components.
    for (const pkg of result.pkgList) {
      assert.ok(
        !["network", "endpoints", "c1", "c2", "heredoc"].includes(pkg.name),
        pkg.name,
      );
    }
  });

  it("describes the registry module with constraints, pinning and license", () => {
    const vpc = result.pkgList.find((p) => p.name === "vpc/aws");
    assert.strictEqual(
      vpc.group,
      "registry.terraform.io/terraform-aws-modules",
    );
    assert.strictEqual(vpc.version, "5.1.2");
    assert.strictEqual(prop(vpc, "cdx:tf:kind"), "module");
    assert.strictEqual(
      prop(vpc, "cdx:tf:address"),
      "registry.terraform.io/terraform-aws-modules/vpc/aws",
    );
    assert.strictEqual(prop(vpc, "cdx:tf:constraints"), "~> 5.1");
    assert.strictEqual(prop(vpc, "cdx:tf:module:pinning"), "range");
    assert.strictEqual(prop(vpc, "cdx:tf:module:installed"), "true");
    assert.strictEqual(
      prop(vpc, "cdx:tf:module:source"),
      "registry.terraform.io/terraform-aws-modules/vpc/aws",
    );
    assert.strictEqual(prop(vpc, "cdx:tf:module:sourceType"), "registry");
    assert.strictEqual(vpc.license, "Apache-2.0");
    assert.strictEqual(prop(vpc, "cdx:tf:licenseSource"), "file");
    assert.strictEqual(
      norm(prop(vpc, "cdx:tf:licenseFile")),
      ".terraform/modules/vpc/LICENSE",
    );
    const occurrence = vpc.evidence.occurrences[0];
    assert.strictEqual(norm(occurrence.location), "main.tf");
    assert.strictEqual(occurrence.symbol, "module.vpc");
    assert.strictEqual(occurrence.line, 7);
    assert.strictEqual(vpc.evidence.identity.confidence, 1);
  });

  it("describes the git module with ref, pinning and sanitized source", () => {
    const label = result.pkgList.find(
      (p) => p.purl === "pkg:github/cloudposse/terraform-null-label@0.25.0",
    );
    assert.strictEqual(label.version, "0.25.0");
    assert.strictEqual(prop(label, "cdx:tf:module:ref"), "0.25.0");
    assert.strictEqual(prop(label, "cdx:tf:module:pinning"), "tag");
    assert.strictEqual(
      prop(label, "cdx:tf:module:source"),
      "git::https://github.com/cloudposse/terraform-null-label.git",
    );
    assert.strictEqual(prop(label, "cdx:tf:module:sourceType"), "git");
    assert.strictEqual(prop(label, "cdx:tf:module:installed"), "true");
    assert.strictEqual(label.license, "MIT");
    assert.strictEqual(prop(label, "cdx:tf:licenseSource"), "file");
    // The manifest source keeps the query string; the BOM must not.
    assert.ok(!JSON.stringify(label).includes("ref=0.25.0"));
  });

  it("resolves nested registry modules through local callers", () => {
    const label = result.pkgList.find((p) => p.name === "label/null");
    assert.strictEqual(label.version, "0.25.0");
    assert.strictEqual(prop(label, "cdx:tf:module:pinning"), "exact");
    assert.strictEqual(prop(label, "cdx:tf:module:installed"), "true");
    assert.strictEqual(label.license, "BSD-3-Clause");
    const occurrence = label.evidence.occurrences[0];
    assert.strictEqual(norm(occurrence.location), "modules/network/main.tf");
    assert.strictEqual(occurrence.symbol, "module.label");
  });

  it("reads provider licenses from the installed platform directories", () => {
    const aws = result.pkgList.find(
      (p) =>
        p.purl === "pkg:generic/registry.terraform.io/hashicorp/aws@5.80.0",
    );
    assert.strictEqual(prop(aws, "cdx:tf:kind"), "provider");
    assert.strictEqual(aws.license, "MPL-2.0");
    assert.strictEqual(
      norm(prop(aws, "cdx:tf:licenseFile")),
      ".terraform/providers/registry.terraform.io/hashicorp/aws/5.80.0/linux_amd64/LICENSE",
    );
    const random = result.pkgList.find(
      (p) =>
        p.purl === "pkg:generic/registry.terraform.io/hashicorp/random@3.6.3",
    );
    assert.strictEqual(random.license, "MPL-2.0");
    assert.strictEqual(
      norm(prop(random, "cdx:tf:licenseFile")),
      ".terraform/providers/registry.terraform.io/hashicorp/random/3.6.3/linux_amd64/LICENSE.txt",
    );
  });

  it("builds the documented dependency graph", () => {
    const dependsOn = (ref) =>
      result.dependencies.find((d) => d.ref === ref)?.dependsOn || [];
    const vpc =
      "pkg:generic/registry.terraform.io/terraform-aws-modules/vpc/aws@5.1.2";
    const labelGit = "pkg:github/cloudposse/terraform-null-label@0.25.0";
    const labelNull =
      "pkg:generic/registry.terraform.io/cloudposse/label/null@0.25.0";
    const aws = "pkg:generic/registry.terraform.io/hashicorp/aws@5.80.0";
    const random = "pkg:generic/registry.terraform.io/hashicorp/random@3.6.3";
    assert.deepStrictEqual(dependsOn(PARENT_REF), [
      labelNull,
      aws,
      random,
      vpc,
      labelGit,
    ]);
    assert.deepStrictEqual(dependsOn(vpc), [aws]);
    assert.deepStrictEqual(dependsOn(labelNull), [random]);
    assert.deepStrictEqual(dependsOn(labelGit), []);
    assert.deepStrictEqual(dependsOn(aws), []);
    // Every ref mentioned exists.
    const refs = new Set(
      result.pkgList.map((p) => p["bom-ref"]).concat([PARENT_REF]),
    );
    for (const dep of result.dependencies) {
      assert.ok(refs.has(dep.ref), dep.ref);
      for (const target of dep.dependsOn) {
        assert.ok(refs.has(target), target);
      }
    }
  });

  it("puts the root properties on the parent and names the sources", () => {
    assert.deepStrictEqual(result.parentProperties, [
      { name: "cdx:tf:root", value: "." },
      { name: "cdx:tf:requiredVersion", value: ">= 1.6.0" },
    ]);
    assert.deepStrictEqual(result.srcFiles, [
      ".terraform.lock.hcl",
      ".terraform/modules/modules.json",
    ]);
  });

  it("keeps credentials and raw sources out of the serialized output", () => {
    const serialized = JSON.stringify(summarize(result));
    for (const marker of [
      "S3cr3tP4ss",
      "U1NIS0VZ",
      "ci-bot",
      "sshkey",
      "pkg:terraform/",
    ]) {
      assert.ok(!serialized.includes(marker), marker);
    }
  });

  it("reports the installed commit from a synthesized .git/HEAD", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-git-head-"));
    try {
      cpSyncWhole(join(FIXTURES, "terraform-modules"), dir);
      const commit = "488ab91e2a7d8c7e5f3b2a19087654321fedcba9";
      write(dir, ".terraform/modules/label_git/.git/HEAD", `${commit}\n`);
      const withHead = parseTerraformWorkspace(
        dir,
        { multiProject: false },
        PARENT_REF,
      );
      const label = withHead.pkgList.find(
        (p) => p.purl === "pkg:github/cloudposse/terraform-null-label@0.25.0",
      );
      assert.ok(label, "git module still emitted");
      assert.strictEqual(prop(label, "cdx:tf:module:commit"), commit);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Small recursive copy so tests can clone fixture subtrees. */
function cpSyncWhole(src, dest) {
  const entries = readdirSync(src, { withFileTypes: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      cpSyncWhole(join(src, entry.name), join(dest, entry.name));
    } else {
      writeFileSync(
        join(dest, entry.name),
        readFileSync(join(src, entry.name)),
      );
    }
  }
}

describe("parseTerraformWorkspace (static walk)", () => {
  const result = parseTerraformWorkspace(
    join(FIXTURES, "terraform-static"),
    { multiProject: true },
    PARENT_REF,
  );

  it("emits the canonical purls for every source kind", () => {
    assert.deepStrictEqual(result.pkgList.map((p) => p.purl).sort(), [
      "pkg:generic/artifacts.example.com/vpc-1.4.0?download_url=https:%2F%2Fartifacts.example.com%2Fmodules%2Fvpc-1.4.0.zip",
      "pkg:generic/example.com/platform/network@main?vcs_url=ssh:%2F%2Fexample.com%2Fplatform%2Fnetwork.git#modules/vpc",
      "pkg:generic/git.example.com/infra/db@v2.0.0?vcs_url=https:%2F%2Fgit.example.com%2Finfra%2Fdb.git",
      "pkg:generic/registry.terraform.io/hashicorp/consul/aws#modules/consul-cluster",
      "pkg:generic/registry.terraform.io/hashicorp/google@6.10.0",
      "pkg:generic/registry.terraform.io/hashicorp/random",
      "pkg:generic/registry.terraform.io/terraform-aws-modules/iam/aws",
      "pkg:generic/registry.terraform.io/terraform-aws-modules/s3-bucket/aws@4.2.1",
      "pkg:github/acme/terraform-modules@3d8f2c9a1b07e645f2c9ab8d0e1f23456789abcd#dns",
    ]);
  });

  it("classifies pinning per source kind", () => {
    const pinningOf = (name) =>
      prop(
        result.pkgList.find((p) => p.name === name),
        "cdx:tf:module:pinning",
      );
    assert.strictEqual(pinningOf("s3-bucket/aws"), "exact");
    assert.strictEqual(pinningOf("iam/aws"), "range");
    assert.strictEqual(pinningOf("consul/aws"), "none");
    assert.strictEqual(pinningOf("network"), "branch");
    assert.strictEqual(pinningOf("terraform-modules"), "sha");
    assert.strictEqual(pinningOf("vpc-1.4.0"), "checksum");
    assert.strictEqual(pinningOf("db"), "tag");
  });

  it("marks every module declared-only and the credential-bearing source", () => {
    for (const pkg of result.pkgList) {
      if (prop(pkg, "cdx:tf:kind") === "module") {
        assert.strictEqual(
          prop(pkg, "cdx:tf:module:installed"),
          "false",
          pkg.name,
        );
      }
    }
    const db = result.pkgList.find((p) => p.name === "db");
    assert.strictEqual(prop(db, "cdx:tf:module:credentialInSource"), "true");
    assert.strictEqual(
      prop(db, "cdx:tf:module:source"),
      "git::https://git.example.com/infra/db.git",
    );
  });

  it("gives the archive module its checksum hash and distribution url", () => {
    const archive = result.pkgList.find((p) => p.name === "vpc-1.4.0");
    assert.deepStrictEqual(archive.hashes, [
      {
        alg: "SHA-256",
        content:
          "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
    ]);
    assert.strictEqual(
      archive.distribution.url,
      "https://artifacts.example.com/modules/vpc-1.4.0.zip",
    );
  });

  it("derives implied provider addresses", () => {
    const google = result.pkgList.find((p) => p.name === "google");
    assert.strictEqual(google.version, "6.10.0");
    assert.strictEqual(
      prop(google, "cdx:tf:address"),
      "registry.terraform.io/hashicorp/google",
    );
    const random = result.pkgList.find((p) => p.name === "random");
    assert.strictEqual(random.version, undefined);
    assert.strictEqual(prop(random, "cdx:tf:constraints"), "~> 3.0");
    assert.strictEqual(
      prop(random, "cdx:tf:address"),
      "registry.terraform.io/hashicorp/random",
    );
  });

  it("counts unresolved calls and wires the root edges", () => {
    assert.deepStrictEqual(result.parentProperties, [
      { name: "cdx:tf:root", value: "." },
      { name: "cdx:tf:unresolvedModuleCalls", value: "1" },
    ]);
    const parent = result.dependencies.find((d) => d.ref === PARENT_REF);
    assert.strictEqual(parent.dependsOn.length, 9);
    for (const pkg of result.pkgList) {
      const dep = result.dependencies.find((d) => d.ref === pkg["bom-ref"]);
      assert.ok(dep, pkg["bom-ref"]);
      if (prop(pkg, "cdx:tf:kind") === "module") {
        assert.deepStrictEqual(dep.dependsOn, [], pkg.name);
      }
    }
  });

  it("never leaks the embedded credentials", () => {
    const serialized = JSON.stringify(summarize(result));
    for (const marker of ["S3cr3tP4ss", "U1NIS0VZ", "ci-bot", "sshkey"]) {
      assert.ok(!serialized.includes(marker), marker);
    }
  });
});

describe("parseTerraformWorkspace (monorepo)", () => {
  const result = parseTerraformWorkspace(
    join(FIXTURES, "terraform-monorepo"),
    { multiProject: true },
    PARENT_REF,
  );

  it("creates one root application per unreferenced configuration", () => {
    const roots = result.pkgList.filter((p) => p.type === "application");
    assert.deepStrictEqual(roots.map((r) => r["bom-ref"]).sort(), [
      "terraform-root:envs/dev",
      "terraform-root:envs/prod",
    ]);
    const dev = roots.find((r) => r.name === "envs/dev");
    assert.deepStrictEqual(dev.properties, [
      { name: "cdx:tf:root", value: "envs/dev" },
      { name: "cdx:tf:requiredVersion", value: ">= 1.5" },
    ]);
  });

  it("splits provider versions per root and shares the module", () => {
    const dependsOn = (ref) =>
      result.dependencies.find((d) => d.ref === ref)?.dependsOn || [];
    assert.deepStrictEqual(dependsOn("terraform-root:envs/dev"), [
      "pkg:generic/registry.terraform.io/hashicorp/aws",
      "pkg:generic/registry.terraform.io/terraform-aws-modules/security-group/aws@5.2.0",
    ]);
    assert.deepStrictEqual(dependsOn("terraform-root:envs/prod"), [
      "pkg:generic/registry.terraform.io/hashicorp/aws@5.80.0",
      "pkg:generic/registry.terraform.io/terraform-aws-modules/security-group/aws@5.2.0",
    ]);
    assert.deepStrictEqual(dependsOn(PARENT_REF), [
      "terraform-root:envs/dev",
      "terraform-root:envs/prod",
    ]);
  });
});

describe("parseTerraformWorkspace (OpenTofu)", () => {
  const result = parseTerraformWorkspace(
    join(FIXTURES, "terraform-tofu"),
    { multiProject: false },
    PARENT_REF,
  );

  it("prefers .tofu files and the OpenTofu registry, and honours overrides", () => {
    assert.deepStrictEqual(result.pkgList.map((p) => p.purl).sort(), [
      "pkg:generic/registry.opentofu.org/cloudposse/label/null@0.24.1",
      "pkg:generic/registry.opentofu.org/hashicorp/consul/aws@0.1.0",
      "pkg:generic/registry.opentofu.org/terraform-aws-modules/vpc/aws@5.1.0",
    ]);
    // The JSON-declared module carries an occurrence without a line number.
    const consul = result.pkgList.find((p) => p.name === "consul/aws");
    assert.strictEqual(
      norm(consul.evidence.occurrences[0].location),
      "cdk.tf.json",
    );
    assert.strictEqual(consul.evidence.occurrences[0].line, undefined);
  });
});

describe("parseTerraformWorkspace (safety)", () => {
  const manifestWith = (records) => JSON.stringify({ Modules: records });
  const registryRecord = (key, version, dir) => ({
    Key: key,
    Source: `registry.terraform.io/example/${key}/aws`,
    Version: version,
    Dir: dir,
  });

  it("rejects manifest directories that escape the root", () => {
    const base = mkdtempSync(join(tmpdir(), "tf-escape-"));
    const root = join(base, "root");
    try {
      // A license at the escape target: a containment bug would find it.
      write(base, "outside/LICENSE", "Mozilla Public License Version 2.0\n");
      write(
        root,
        "main.tf",
        'module "ok" {\n  source = "example/ok/aws"\n  version = "1.0.0"\n}\n',
      );
      write(
        root,
        ".terraform/modules/modules.json",
        manifestWith([
          { Key: "", Source: "", Dir: "." },
          registryRecord("esc", "1.0.0", "../../../outside"),
          registryRecord("abs", "1.0.0", "/etc"),
          {
            Key: "remote_out",
            Source: "git::https://github.com/example/repo.git?ref=v1.0.0",
            Dir: "modules/outside",
          },
        ]),
      );
      write(
        root,
        "modules/outside/LICENSE",
        "Mozilla Public License Version 2.0\n",
      );
      const result = parseTerraformWorkspace(
        root,
        { multiProject: false },
        PARENT_REF,
      );
      const esc = result.pkgList.find((p) => p.name === "esc/aws");
      const abs = result.pkgList.find((p) => p.name === "abs/aws");
      const remote = result.pkgList.find((p) => p.name === "repo");
      assert.ok(
        esc && esc.version === "1.0.0",
        "component survives a rejected Dir",
      );
      assert.ok(abs && abs.version === "1.0.0");
      assert.ok(remote && remote.version === "v1.0.0");
      for (const pkg of [esc, abs, remote]) {
        assert.strictEqual(
          prop(pkg, "cdx:tf:licenseFile"),
          undefined,
          pkg.name,
        );
        assert.strictEqual(pkg.license, undefined, pkg.name);
        assert.strictEqual(
          prop(pkg, "cdx:tf:module:commit"),
          undefined,
          pkg.name,
        );
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("ignores symlinked licenses and configs pointing outside the root", () => {
    const base = mkdtempSync(join(tmpdir(), "tf-symlink-"));
    const root = join(base, "root");
    let symlinksOk = true;
    try {
      write(base, "escaped/LICENSE", "Mozilla Public License Version 2.0\n");
      write(
        base,
        "escaped/extra.tf",
        'module "smuggled" {\n  source = "bad/smuggled/aws"\n}\n',
      );
      write(
        root,
        "main.tf",
        'module "m" {\n  source = "example/m/aws"\n  version = "1.0.0"\n}\n',
      );
      write(
        root,
        ".terraform/modules/modules.json",
        manifestWith([
          { Key: "", Source: "", Dir: "." },
          registryRecord("m", "1.0.0", ".terraform/modules/m"),
        ]),
      );
      write(root, ".terraform/modules/m/main.tf", "# empty\n");
      mkdirSync(join(root, "other"), { recursive: true });
      try {
        symlinkSync(
          join(base, "escaped", "LICENSE"),
          join(root, ".terraform/modules/m/LICENSE"),
        );
        symlinkSync(
          join(base, "escaped", "extra.tf"),
          join(root, "other/extra.tf"),
        );
      } catch {
        symlinksOk = false;
      }
      if (!symlinksOk) {
        return;
      }
      const result = parseTerraformWorkspace(
        root,
        { multiProject: false },
        PARENT_REF,
      );
      const m = result.pkgList.find((p) => p.name === "m/aws");
      assert.ok(m, "module emitted");
      assert.strictEqual(prop(m, "cdx:tf:licenseFile"), undefined);
      assert.strictEqual(m.license, undefined);
      const smuggled = result.pkgList.find((p) => p.name === "smuggled/aws");
      assert.strictEqual(smuggled, undefined);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("ignores a modules.json over the size cap", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-capped-"));
    try {
      write(
        root,
        "main.tf",
        'module "m" {\n  source = "example/m/aws"\n  version = "1.0.0"\n}\n',
      );
      write(
        root,
        ".terraform/modules/modules.json",
        manifestWith([
          { Key: "", Source: "", Dir: "." },
          registryRecord("m", "9.9.9", ".terraform/modules/m"),
        ]).padEnd(21 * 1024 * 1024, " "),
      );
      const result = parseTerraformWorkspace(
        root,
        { multiProject: false },
        PARENT_REF,
      );
      const m = result.pkgList.find((p) => p.name === "m/aws");
      assert.ok(m, "static walk still finds the module");
      assert.strictEqual(prop(m, "cdx:tf:module:installed"), "false");
      assert.strictEqual(m.version, "1.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never reads tfvars or tfstate files", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-sensitive-"));
    try {
      write(
        root,
        "main.tf",
        'module "m" {\n  source = "example/m/aws"\n  version = "1.0.0"\n}\n',
      );
      write(root, "terraform.tfvars", 'secret = "TFVARSMARKER"\n');
      write(
        root,
        ".terraform/terraform.tfstate",
        '{"marker": "TFSTATEMARKER"}\n',
      );
      const result = parseTerraformWorkspace(
        root,
        { multiProject: false },
        PARENT_REF,
      );
      const serialized = JSON.stringify(summarize(result));
      assert.ok(!serialized.includes("TFVARSMARKER"));
      assert.ok(!serialized.includes("TFSTATEMARKER"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates a module called twice into one component with two occurrences", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-dedupe-"));
    try {
      write(
        root,
        "main.tf",
        [
          'module "first" {',
          '  source  = "terraform-aws-modules/vpc/aws"',
          '  version = "5.1.2"',
          "}",
          'module "second" {',
          '  source  = "terraform-aws-modules/vpc/aws"',
          '  version = "5.1.2"',
          "}",
        ].join("\n"),
      );
      const result = parseTerraformWorkspace(
        root,
        { multiProject: false },
        PARENT_REF,
      );
      const modules = result.pkgList.filter(
        (p) => prop(p, "cdx:tf:kind") === "module",
      );
      assert.strictEqual(modules.length, 1);
      assert.strictEqual(
        modules[0].evidence.occurrences.length,
        2,
        JSON.stringify(modules[0].evidence.occurrences),
      );
      assert.deepStrictEqual(
        modules[0].evidence.occurrences.map((o) => o.symbol).sort(),
        ["module.first", "module.second"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminates on deep local chains and self-references", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-deep-"));
    try {
      const depth = 64;
      write(root, "main.tf", 'module "l1" {\n  source = "./chain"\n}\n');
      for (let n = 1; n <= depth; n++) {
        const rel = [
          ...Array.from({ length: n }, (_, i) => `d${i}`),
          "main.tf",
        ];
        // d0 is `chain`, then each level nests one directory deeper.
        rel[0] = "chain";
        const file = rel.join("/");
        if (n < depth) {
          write(root, file, `module "l${n + 1}" {\n  source = "./d${n}"\n}\n`);
        } else {
          write(
            root,
            file,
            'module "deep" {\n  source = "example/deep/aws"\n  version = "1.0.0"\n}\n',
          );
        }
      }
      write(root, "self/main.tf", 'module "me" {\n  source = "./"\n}\n');
      const result = parseTerraformWorkspace(
        root,
        { multiProject: true },
        PARENT_REF,
      );
      const refs = result.pkgList.map((p) => p.purl);
      assert.ok(
        refs.includes(
          "pkg:generic/registry.terraform.io/example/deep/aws@1.0.0",
        ),
        JSON.stringify(refs),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
