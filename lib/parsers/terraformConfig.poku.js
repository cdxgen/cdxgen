import { strict as assert } from "node:assert";

import { describe, it } from "poku";

import {
  isTerraformOverrideFile,
  mergeTerraformConfigs,
  parseTerraformConfig,
  terraformConfigFileSet,
} from "./terraformConfig.js";

describe("parseTerraformConfig (native)", () => {
  it("extracts module calls with sources, versions and line numbers", () => {
    const text = [
      "# leading comment",
      'module "vpc" {',
      '  source = "terraform-aws-modules/vpc/aws"',
      '  version = "~> 5.1"',
      '  tags = { note = "}{" }',
      "}",
      "",
      'module "label_git" {',
      '  source = "git::https://github.com/cloudposse/terraform-null-label.git?ref=0.25.0"',
      "}",
    ].join("\n");
    const result = parseTerraformConfig(text);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.moduleCalls.length, 2);
    const vpc = result.moduleCalls[0];
    assert.strictEqual(vpc.name, "vpc");
    assert.strictEqual(vpc.line, 2);
    assert.strictEqual(vpc.source, "terraform-aws-modules/vpc/aws");
    assert.strictEqual(vpc.sourceLiteral, true);
    assert.strictEqual(vpc.sourceLine, 3);
    assert.strictEqual(vpc.version, "~> 5.1");
    assert.strictEqual(vpc.versionLiteral, true);
    const label = result.moduleCalls[1];
    assert.strictEqual(label.name, "label_git");
    assert.strictEqual(label.line, 8);
    // `version` was never mentioned, so the literal flag is absent entirely.
    assert.strictEqual("versionLiteral" in label, false);
    assert.strictEqual("version" in label, false);
  });

  it("accepts identifier block labels", () => {
    const result = parseTerraformConfig(
      'module vpc {\n  source = "a/b/c"\n}\n',
    );
    assert.strictEqual(result.moduleCalls.length, 1);
    assert.strictEqual(result.moduleCalls[0].name, "vpc");
  });

  it("skips modules that only exist inside comments", () => {
    const text = [
      '# module "c1" { source = "x/y/z" }',
      '/* module "c2" { source = "x/y/z" } */',
      '// module "c3" { source = "x/y/z" }',
      'module "real" { source = "a/b/c" }',
    ].join("\n");
    const result = parseTerraformConfig(text);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(
      result.moduleCalls.map((call) => call.name),
      ["real"],
    );
  });

  it("skips modules that only exist inside heredocs", () => {
    const text = [
      "locals {",
      "  doc = <<-EOT",
      '    module "heredoc" { source = "a/b/c" }',
      "    EOT",
      "}",
      'module "real" { source = "d/e/f" }',
    ].join("\n");
    const result = parseTerraformConfig(text);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(
      result.moduleCalls.map((call) => call.name),
      ["real"],
    );
  });

  it("treats strings with template sequences as non-literal", () => {
    const text = [
      'module "templated" {',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL template fixture, not a JS template
      '  source = "${var.registry}/vpc/aws"',
      '  version = join(".", ["5", var.minor])',
      "}",
      'module "escaped" {',
      '  source = "$${literal}/vpc/aws"',
      "}",
    ].join("\n");
    const result = parseTerraformConfig(text);
    const templated = result.moduleCalls.find((c) => c.name === "templated");
    assert.strictEqual(templated.sourceLiteral, false);
    assert.strictEqual("source" in templated, false);
    assert.strictEqual(templated.versionLiteral, false);
    const escaped = result.moduleCalls.find((c) => c.name === "escaped");
    assert.strictEqual(escaped.sourceLiteral, true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: escaped HCL template fixture
    assert.strictEqual(escaped.source, "${literal}/vpc/aws");
  });

  it("survives nested quotes inside template sequences", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: nested HCL template fixture
    const text = 'module "jq" {\n  source = "${jsonencode({a = "}"})}"\n}\n';
    const result = parseTerraformConfig(text);
    assert.strictEqual(result.moduleCalls[0].sourceLiteral, false);
  });

  it("marks var-expression sources non-literal", () => {
    const result = parseTerraformConfig(
      'module "dyn" {\n  source = var.module_source\n}\n',
    );
    const call = result.moduleCalls[0];
    assert.strictEqual(call.sourceLiteral, false);
    assert.strictEqual("source" in call, false);
  });

  it("extracts every required_providers form", () => {
    const text = [
      "terraform {",
      '  required_version = ">= 1.6.0"',
      "  required_providers {",
      "    aws = {",
      '      source  = "hashicorp/aws"',
      '      version = ">= 5.0.0"',
      "    }",
      '    random = "~> 3.6"',
      '    google = { source = "hashicorp/google", version = "6.10.0" }',
      '    "quoted" = {',
      '      source: "hashicorp/quoted"',
      "    }",
      "    aliased = {",
      "      configuration_aliases = [aws.alt]",
      '      version = "~> 1"',
      "    }",
      "  }",
      "}",
    ].join("\n");
    const result = parseTerraformConfig(text);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.requiredVersions, [">= 1.6.0"]);
    const byName = new Map(
      result.requiredProviders.map((entry) => [entry.localName, entry]),
    );
    assert.deepStrictEqual(byName.get("aws"), {
      localName: "aws",
      source: "hashicorp/aws",
      version: ">= 5.0.0",
      line: 4,
    });
    assert.deepStrictEqual(byName.get("random"), {
      localName: "random",
      version: "~> 3.6",
      line: 8,
    });
    assert.deepStrictEqual(byName.get("google"), {
      localName: "google",
      source: "hashicorp/google",
      version: "6.10.0",
      line: 9,
    });
    assert.strictEqual(byName.get("quoted").source, "hashicorp/quoted");
    // configuration_aliases is ignored but version still counts.
    assert.strictEqual(byName.get("aliased").version, "~> 1");
    assert.strictEqual("source" in byName.get("aliased"), false);
  });

  it("ignores nested blocks, providers maps and inputs", () => {
    const text = [
      'module "big" {',
      '  source = "a/b/c"',
      "  providers = {",
      "    aws = aws.west",
      "  }",
      "  count = 2",
      '  for_each = { "a" = 1 }',
      '  tags = ["x", "y"]',
      '  nested_label "deep" {',
      '    source = "never/extracted"',
      "  }",
      "}",
      'resource "aws_vpc" "main" {',
      '  cidr_block = "10.0.0.0/16"',
      "}",
    ].join("\n");
    const result = parseTerraformConfig(text);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.moduleCalls.length, 1);
    assert.strictEqual(result.moduleCalls[0].source, "a/b/c");
  });

  it("skips backend and cloud blocks without recording anything", () => {
    const text = [
      "terraform {",
      '  backend "s3" {',
      '    bucket = "secrets"',
      "  }",
      "  cloud {",
      '    organization = "acme"',
      "  }",
      '  required_version = "~> 1.9"',
      "}",
    ].join("\n");
    const result = parseTerraformConfig(text);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.requiredVersions, ["~> 1.9"]);
    assert.deepStrictEqual(result.requiredProviders, []);
  });

  it("never throws on unterminated input and reports errors", () => {
    const cases = [
      ['module "x" {\n  source = "unterminated', "string"],
      ["locals {\n  doc = <<-EOT\n  body\n", "heredoc"],
      ['/* never closed\nmodule "x" { source = "a/b/c" }\n', "comment"],
      ['module "x" {\n  source = "a/b/c"\n', "brace"],
      ['module "broken" { source = }\n', "expression"],
      ['module { source = "a/b/c" }\n', "label"],
      ["= = =\n,,,,\n}}}}\n", "garbage"],
    ];
    for (const [text, label] of cases) {
      const result = parseTerraformConfig(text);
      assert.ok(Array.isArray(result.errors), `${label}: errors recorded`);
      assert.ok(Array.isArray(result.moduleCalls), `${label}: calls array`);
    }
    // The unterminated brace still yields the module that was complete.
    const partial = parseTerraformConfig('module "x" {\n  source = "a/b/c"\n');
    assert.strictEqual(partial.moduleCalls[0].source, "a/b/c");
    assert.ok(partial.errors.length > 0);
  });

  it("accepts CRLF line endings", () => {
    const text = [
      'module "vpc" {',
      '  source = "terraform-aws-modules/vpc/aws"',
      '  version = "5.1.2"',
      "}",
    ].join("\r\n");
    const result = parseTerraformConfig(text);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.moduleCalls[0].line, 1);
    assert.strictEqual(
      result.moduleCalls[0].source,
      "terraform-aws-modules/vpc/aws",
    );
    assert.strictEqual(result.moduleCalls[0].version, "5.1.2");
  });

  it("decodes string escapes", () => {
    const result = parseTerraformConfig(
      'module "esc" {\n  source = "a\\tb\\u0063\\"d"\n}\n',
    );
    assert.strictEqual(result.moduleCalls[0].source, 'a\tbc"d');
  });
});

describe("parseTerraformConfig (JSON variant)", () => {
  it("extracts modules, providers and required_version", () => {
    const result = parseTerraformConfig(
      JSON.stringify({
        module: {
          c: { source: "hashicorp/consul/aws", version: "0.1.0" },
          "//": { source: "ignored/comment" },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: JSON-config template fixture
          templated: { source: "${var.src}/aws" },
        },
        terraform: [
          {
            required_version: ">= 1.5",
            required_providers: {
              aws: { source: "hashicorp/aws", version: ">= 5.0" },
              random: "~> 3.0",
              "//": "ignored",
            },
          },
        ],
      }),
      { json: true },
    );
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.moduleCalls.length, 2);
    const c = result.moduleCalls.find((call) => call.name === "c");
    assert.strictEqual(c.source, "hashicorp/consul/aws");
    assert.strictEqual(c.version, "0.1.0");
    assert.strictEqual(c.sourceLiteral, true);
    assert.strictEqual("line" in c, false);
    const templated = result.moduleCalls.find(
      (call) => call.name === "templated",
    );
    assert.strictEqual(templated.sourceLiteral, false);
    assert.deepStrictEqual(result.requiredVersions, [">= 1.5"]);
    assert.strictEqual(result.requiredProviders.length, 2);
    assert.deepStrictEqual(result.requiredProviders[1], {
      localName: "random",
      version: "~> 3.0",
    });
  });

  it("accepts module as an array of maps", () => {
    const result = parseTerraformConfig(
      JSON.stringify({ module: [{ a: { source: "a/b/c" } }] }),
      { json: true },
    );
    assert.strictEqual(result.moduleCalls[0].name, "a");
  });

  it("returns an error for invalid JSON", () => {
    const result = parseTerraformConfig("{ not json", { json: true });
    assert.deepStrictEqual(result.moduleCalls, []);
    assert.strictEqual(result.errors.length, 1);
  });
});

describe("terraformConfigFileSet", () => {
  it("splits primary and override files, sorted", () => {
    const set = terraformConfigFileSet([
      "versions.tf",
      "main.tf",
      "extra_override.tf",
      "override.tf.json",
      "readme.md",
    ]);
    assert.deepStrictEqual(set.primary, ["main.tf", "versions.tf"]);
    assert.deepStrictEqual(set.overrides, [
      "extra_override.tf",
      "override.tf.json",
    ]);
  });

  it("drops .tf files shadowed by .tofu files", () => {
    const set = terraformConfigFileSet([
      "main.tf",
      "main.tofu",
      "other.tf",
      "extra.tf.json",
      "extra.tofu.json",
      "kept.tf.json",
    ]);
    assert.deepStrictEqual(set.primary, [
      "extra.tofu.json",
      "kept.tf.json",
      "main.tofu",
      "other.tf",
    ]);
  });

  it("keeps .tf files when no .tofu file exists", () => {
    const set = terraformConfigFileSet(["main.tf", "other.tf.json"]);
    assert.deepStrictEqual(set.primary, ["main.tf", "other.tf.json"]);
  });
});

describe("isTerraformOverrideFile", () => {
  it("recognises the documented override names", () => {
    for (const name of [
      "override.tf",
      "override.tf.json",
      "override.tofu",
      "extra_override.tf",
      "extra_override.tofu.json",
      "dir/override.tf",
    ]) {
      assert.ok(isTerraformOverrideFile(name), name);
    }
    for (const name of [
      "main.tf",
      "overrides.tf",
      "override.md",
      "override",
      "x_override.json",
    ]) {
      assert.ok(!isTerraformOverrideFile(name), name);
    }
  });
});

describe("mergeTerraformConfigs", () => {
  const parse = (text) => parseTerraformConfig(text);

  it("keeps the first primary definition and reports duplicates", () => {
    const merged = mergeTerraformConfigs([
      {
        file: "a.tf",
        override: false,
        result: parse('module "m" { source = "a/b/c" }'),
      },
      {
        file: "b.tf",
        override: false,
        result: parse('module "m" { source = "d/e/f" }'),
      },
    ]);
    assert.strictEqual(merged.moduleCalls.length, 1);
    assert.strictEqual(merged.moduleCalls[0].source, "a/b/c");
    assert.strictEqual(merged.moduleCalls[0].file, "a.tf");
    assert.ok(merged.errors.some((e) => e.includes("duplicate module call")));
  });

  it("replaces only the attributes an override sets", () => {
    const merged = mergeTerraformConfigs([
      {
        file: "extra.tf",
        override: false,
        result: parse(
          'module "b" {\n  source = "cloudposse/label/null"\n  version = "0.25.0"\n}',
        ),
      },
      {
        file: "extra_override.tf",
        override: true,
        result: parse('module "b" {\n  version = "0.24.1"\n}'),
      },
    ]);
    const call = merged.moduleCalls[0];
    assert.strictEqual(call.source, "cloudposse/label/null");
    assert.strictEqual(call.version, "0.24.1");
    assert.strictEqual(call.versionFile, "extra_override.tf");
    assert.strictEqual(call.file, "extra.tf");
  });

  it("replaces provider entries whole and unions required_version", () => {
    const merged = mergeTerraformConfigs([
      {
        file: "main.tf",
        override: false,
        result: parse(
          [
            "terraform {",
            '  required_version = ">= 1.5"',
            "  required_providers {",
            '    aws = { source = "hashicorp/aws", version = ">= 5.0" }',
            '    random = { source = "hashicorp/random" }',
            "  }",
            "}",
          ].join("\n"),
        ),
      },
      {
        file: "override.tf",
        override: true,
        result: parse(
          [
            "terraform {",
            '  required_version = "~> 1.9"',
            "  required_providers {",
            '    aws = { source = "hashicorp/aws", version = "5.80.0" }',
            "  }",
            "}",
          ].join("\n"),
        ),
      },
    ]);
    assert.deepStrictEqual(merged.requiredVersions, ["~> 1.9"]);
    const aws = merged.requiredProviders.find((p) => p.localName === "aws");
    assert.strictEqual(aws.version, "5.80.0");
    assert.strictEqual(aws.file, "override.tf");
    const random = merged.requiredProviders.find(
      (p) => p.localName === "random",
    );
    assert.strictEqual(random.file, "main.tf");
  });
});

describe("robustness", () => {
  // Deterministic LCG so failures reproduce.
  let seed = 0x2f6e2b1;
  const nextRandom = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  it("terminates on pseudo-random inputs without throwing", () => {
    const alphabet = [
      ...'{}[]()"#/*<<-$%\\n=',
      "a",
      "m",
      "o",
      "d",
      "u",
      "l",
      "e",
      " ",
      "v",
      "x",
    ];
    for (let n = 0; n < 1000; n++) {
      const size = 1 + Math.floor(nextRandom() * 200);
      let input = "";
      for (let c = 0; c < size; c++) {
        input += alphabet[Math.floor(nextRandom() * alphabet.length)];
      }
      const started = process.hrtime.bigint();
      const result = parseTerraformConfig(input);
      const micros = Number(process.hrtime.bigint() - started) / 1000;
      assert.ok(micros < 50000, `input ${n} took ${micros}µs`);
      assert.ok(Array.isArray(result.moduleCalls));
    }
  });

  it("parses a ~2MB config with 10000 module blocks in under 2s", () => {
    const block = [
      'module "m" {',
      '  source = "terraform-aws-modules/vpc/aws"',
      '  version = "~> 5.1"',
      '  description = "virtual private cloud with managed nat gateways for the production network"',
      '  tags = { env = "test", note = "}{" }',
      "}",
    ].join("\n");
    const parts = ['terraform {\n  required_version = ">= 1.6"\n}'];
    for (let n = 0; n < 10000; n++) {
      parts.push(block.replace('"m"', `"m${n}"`));
    }
    const text = parts.join("\n");
    assert.ok(text.length > 1_900_000, `size ${text.length}`);
    const started = Date.now();
    const result = parseTerraformConfig(text);
    const elapsed = Date.now() - started;
    assert.strictEqual(result.moduleCalls.length, 10000);
    assert.ok(elapsed < 2000, `took ${elapsed}ms`);
  });
});
