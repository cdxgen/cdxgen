import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "poku";

import {
  OPERATOR_ONLY_OPTIONS,
  PROJECT_CONFIG_OPTION_ALIASES,
  PROJECT_CONFIG_OPTIONS,
  sanitizeProjectConfig,
} from "./projectConfig.js";

const projectDir = join("/tmp", "project");

it("keeps path options that stay inside the project directory", () => {
  const { config, rejected } = sanitizeProjectConfig(
    { "license-policy": "policy.yaml", output: "out/bom.json" },
    projectDir,
  );
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(config.output, "out/bom.json");
  assert.strictEqual(config["license-policy"], "policy.yaml");
});

it("rejects path options that escape the project directory", () => {
  const { config, rejected } = sanitizeProjectConfig(
    { output: "/home/victim/.ssh/config" },
    projectDir,
  );
  assert.strictEqual(config.output, undefined);
  assert.deepStrictEqual(rejected, ["output=/home/victim/.ssh/config"]);
});

it("rejects traversal out of the project directory", () => {
  const { config, rejected } = sanitizeProjectConfig(
    { "evinse-output": "../../etc/cdxgen.json" },
    projectDir,
  );
  assert.strictEqual(config["evinse-output"], undefined);
  assert.strictEqual(rejected.length, 1);
});

it("rejects the camelCase spelling of a path option", () => {
  const { config, rejected } = sanitizeProjectConfig(
    { depsSlicesFile: "/tmp/elsewhere.json" },
    projectDir,
  );
  assert.strictEqual(config.depsSlicesFile, undefined);
  assert.strictEqual(rejected.length, 1);
});

it("announces options that redirect data or widen execution", () => {
  const { announced, config } = sanitizeProjectConfig(
    { "install-deps": true, serverUrl: "https://attacker.example" },
    projectDir,
  );
  assert.ok(announced.includes("install-deps"));
  assert.ok(announced.includes("serverUrl"));
  // Announced options stay usable; only path escapes are dropped.
  assert.strictEqual(config["install-deps"], true);
});

it("tolerates a missing or non-object config", () => {
  assert.deepStrictEqual(
    sanitizeProjectConfig(undefined, projectDir).config,
    {},
  );
  assert.deepStrictEqual(sanitizeProjectConfig("nope", projectDir).config, {});
});

it("ignores keys that are not options a config file may set", () => {
  const { config, ignored } = sanitizeProjectConfig(
    {
      dosaiCommand: "/bin/sh",
      evidence: true,
      extends: "/proc/self/cwd/payload.js",
      golemCommand: "/bin/sh",
      rusiCommand: "/bin/sh",
      traceCmd: "/bin/sh -c id",
      traceWritePaths: ["/"],
      type: ["dotnet"],
    },
    projectDir,
  );
  assert.deepStrictEqual(ignored.sort(), [
    "dosaiCommand",
    "extends",
    "golemCommand",
    "rusiCommand",
    "traceCmd",
    "traceWritePaths",
  ]);
  assert.deepStrictEqual(config, { evidence: true, type: ["dotnet"] });
});

it("refuses options only the operator may set", () => {
  const { config, operatorOnly } = sanitizeProjectConfig(
    {
      "feature-flags": ["jvm-tool-setup"],
      print: true,
      server: true,
      serverHost: "0.0.0.0",
      "skip-dt-tls-check": true,
    },
    projectDir,
  );
  assert.deepStrictEqual(operatorOnly.sort(), [
    "feature-flags",
    "server",
    "serverHost",
    "skip-dt-tls-check",
  ]);
  assert.deepStrictEqual(config, { print: true });
});

it("accepts only the kebab-case and camelCase spellings of an option", () => {
  const { config, ignored } = sanitizeProjectConfig(
    { Output: "bom.json", projectName: "demo", project_name: "x" },
    projectDir,
  );
  assert.deepStrictEqual(ignored.sort(), ["Output", "project_name"]);
  assert.deepStrictEqual(config, { projectName: "demo" });
});

it("checks an alias as the option it names", () => {
  const escaped = sanitizeProjectConfig({ o: "../victim.json" }, projectDir);
  assert.strictEqual(escaped.config.output, undefined);
  assert.strictEqual(escaped.config.o, undefined);
  assert.deepStrictEqual(escaped.rejected, ["output=../victim.json"]);
  const kept = sanitizeProjectConfig(
    { o: "reports/bom.json", t: "java", "exclude-regex": ["**/test/**"] },
    projectDir,
  );
  assert.deepStrictEqual(kept.config, {
    exclude: ["**/test/**"],
    output: "reports/bom.json",
    type: "java",
  });
  assert.deepStrictEqual(
    sanitizeProjectConfig({ h: true }, projectDir).operatorOnly,
    ["h"],
  );
});

it("prefers a spelled-out option over its alias", () => {
  const { config } = sanitizeProjectConfig(
    { o: "alias.json", output: "named.json" },
    projectDir,
  );
  assert.deepStrictEqual(config, { output: "named.json" });
});

it("drops project types that inventory the host", () => {
  const mixed = sanitizeProjectConfig({ type: ["js", "os"] }, projectDir);
  assert.deepStrictEqual(mixed.config.type, ["js"]);
  assert.deepStrictEqual(mixed.hostScopeTypes, ["os"]);
  const commaSeparated = sanitizeProjectConfig(
    { type: "java,HBOM,maven-repo" },
    projectDir,
  );
  assert.deepStrictEqual(commaSeparated.config.type, ["java"]);
  assert.deepStrictEqual(commaSeparated.hostScopeTypes, ["HBOM", "maven-repo"]);
  const onlyHost = sanitizeProjectConfig({ t: "linux" }, projectDir);
  assert.strictEqual(onlyHost.config.type, undefined);
  assert.deepStrictEqual(onlyHost.hostScopeTypes, ["linux"]);
  const untouched = sanitizeProjectConfig({ type: "js" }, projectDir);
  assert.strictEqual(untouched.config.type, "js");
  assert.deepStrictEqual(untouched.hostScopeTypes, []);
});

it("confines every path option", () => {
  const { config, rejected } = sanitizeProjectConfig(
    {
      bomAuditRulesDir: "rules",
      "data-flow-slices-file": "/tmp/data-flow.json",
      "license-policy": "../policy.yaml",
      openapiSpecFile: "/etc/openapi.json",
      reachablesSlicesFile: "slices/reachables.json",
      "semantics-slices-file": "../../semantics.json",
    },
    projectDir,
  );
  assert.deepStrictEqual(Object.keys(config).sort(), [
    "bomAuditRulesDir",
    "reachablesSlicesFile",
  ]);
  assert.strictEqual(rejected.length, 4);
});

it("keeps a project file whose name starts with two dots", () => {
  const { config, rejected } = sanitizeProjectConfig(
    { output: "..bom.json" },
    projectDir,
  );
  assert.deepStrictEqual(rejected, []);
  assert.strictEqual(config.output, "..bom.json");
});

it("resolves symbolic links before confining path options", () => {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-config-links-"));
  try {
    const project = join(root, "project");
    const outside = join(root, "outside");
    mkdirSync(join(project, "real"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "victim.json"), "SENTINEL");
    try {
      symlinkSync(outside, join(project, "out"), "junction");
      symlinkSync(join(outside, "victim.json"), join(project, "bom.json"));
      symlinkSync(join(project, "real"), join(project, "inside"), "junction");
    } catch (err) {
      // Windows without the symlink privilege cannot create the file link,
      // and a checkout there cannot contain one either.
      console.log(`Skipping the symbolic link checks: ${err.code}`);
      return;
    }
    const { config, rejected } = sanitizeProjectConfig(
      {
        "evinse-output": "inside/evinse.json",
        output: "bom.json",
        "proto-bin-file": "out/bom.cdx",
        usagesSlicesFile: "out/new/usages.json",
      },
      project,
    );
    assert.deepStrictEqual(config, { "evinse-output": "inside/evinse.json" });
    assert.deepStrictEqual(
      rejected.map((entry) => entry.split("=")[0]).sort(),
      ["output", "proto-bin-file", "usagesSlicesFile"],
    );
    assert.strictEqual(
      readFileSync(join(outside, "victim.json"), "utf-8"),
      "SENTINEL",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("classifies every option bin/cdxgen.js declares", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "..", "bin", "cdxgen.js"),
    "utf-8",
  );
  const declared = [...source.matchAll(/\.option\("([a-z0-9-]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(declared.length > 50, "bin/cdxgen.js declares its options");
  // Each declared option is either settable from a config file or reserved
  // for the operator, so a new option needs a decision before it ships.
  assert.deepStrictEqual(
    declared.filter(
      (option) =>
        PROJECT_CONFIG_OPTIONS.has(option) ===
        OPERATOR_ONLY_OPTIONS.has(option),
    ),
    [],
  );
  assert.deepStrictEqual(
    [...PROJECT_CONFIG_OPTIONS, ...OPERATOR_ONLY_OPTIONS].filter(
      (option) => !declared.includes(option),
    ),
    [],
  );
  const declaredAliases = new Map();
  for (const match of source.matchAll(
    /\.option\("([a-z0-9-]+)", \{\s*alias: "([a-z-]+)"/g,
  )) {
    declaredAliases.set(match[2], match[1]);
  }
  assert.deepStrictEqual(
    [...declaredAliases].sort(),
    [...PROJECT_CONFIG_OPTION_ALIASES].sort(),
  );
});
