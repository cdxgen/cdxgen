import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  getLedgerEvents,
  LEDGER_EVENT_IMPACTS,
  LEDGER_EVENT_KINDS,
} from "../core/buildLedger.js";
import { isWin } from "../managers/docker.js";
import {
  collectComposerInfo,
  collectDotnetInfo,
  collectGccInfo,
  collectGoInfo,
  collectJavaInfo,
  collectNodeInfo,
  collectPhpInfo,
  collectPythonInfo,
  collectRustInfo,
  collectSwiftInfo,
  getBranch,
  getOriginUrl,
  isSdkmanAvailable,
  isSdkmanToolAvailable,
  listFiles,
  nodeComponentLinkage,
} from "./envcontext.js";

it("git tests", () => {
  assert.ok(getBranch());
  assert.ok(getOriginUrl());
  const files = listFiles();
  assert.ok(files.length > 10);
});

it("every toolchain collector answers with a platform component or nothing", () => {
  // Which toolchains a machine carries is not a property of cdxgen, so the
  // contract under test is the shape of the answer: a collector either
  // describes the tool it found or returns undefined, and never invents a
  // component for a tool that is absent.
  const collectors = [
    ["dotnet", collectDotnetInfo],
    ["python", collectPythonInfo],
    ["gcc", collectGccInfo],
    ["rustc", collectRustInfo],
    ["swift", collectSwiftInfo],
    ["java", collectJavaInfo],
    ["go", collectGoInfo],
    ["php", collectPhpInfo],
    ["composer", collectComposerInfo],
  ];
  for (const [name, collect] of collectors) {
    const info = collect();
    if (info === undefined) {
      continue;
    }
    assert.equal(info.type, "platform", `${name} must report a platform type`);
    assert.equal(info.name, name, `${name} must name itself`);
    assert.ok(
      typeof info.version === "string" && info.version.length > 0,
      `${name} must report a non-empty version`,
    );
  }
  // The runtime running this test is by definition present, so the node
  // collector is the one that must always answer.
  const nodeInfo = collectNodeInfo();
  assert.ok(nodeInfo, "the running runtime must be detected");
  assert.equal(nodeInfo.type, "platform");
  assert.ok(typeof nodeInfo.version === "string" && nodeInfo.version.length);
});

it("sdkman tests", () => {
  if (process.env?.SDKMAN_VERSION) {
    assert.deepStrictEqual(isSdkmanAvailable(), true);
    assert.deepStrictEqual(isSdkmanToolAvailable("java", "23.0.2-tem"), true);
    // Version identifiers are directory names; absent versions must report
    // unavailable without touching the network.
    assert.deepStrictEqual(
      isSdkmanToolAvailable("maven", "0.0.0-not-installed"),
      false,
    );
  }
});

it("installSdkmanTool rejects unsafe version tokens before spawning", async () => {
  const spawnCalls = [];
  const { installSdkmanTool: installWithMock } = await esmock(
    "./envcontext.js",
    {},
    {
      "../core/fs.js": {
        MAX_BUFFER: 104857600,
        getTmpDir: () => tmpdir(),
        safeExistsSync: () => false,
        safeSpawnSync: (...args) => {
          spawnCalls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    },
  );
  for (const unsafeVersion of [
    "3.9.9;rm -rf",
    "$(whoami)",
    "9.9\nrm",
    "3.9.9`id`",
    "",
  ]) {
    assert.deepStrictEqual(
      installWithMock("maven", unsafeVersion),
      false,
      `${unsafeVersion} must be rejected`,
    );
  }
  assert.ok(
    spawnCalls.length === 0,
    "no shell command may run for unsafe version tokens",
  );
});

it("installSdkmanTool passes validated versions to sdk install", async () => {
  const spawnCalls = [];
  const candidatesDir = mkdtempSync(join(tmpdir(), "cdxgen-sdkman-test-"));
  const previousCandidatesDir = process.env.SDKMAN_CANDIDATES_DIR;
  process.env.SDKMAN_CANDIDATES_DIR = candidatesDir;
  try {
    const { installSdkmanTool: installWithMock } = await esmock(
      "./envcontext.js",
      {},
      {
        "../core/fs.js": {
          MAX_BUFFER: 104857600,
          getTmpDir: () => tmpdir(),
          safeExistsSync: () => false,
          safeSpawnSync: (...args) => {
            spawnCalls.push(args);
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      },
    );
    if (!isWin) {
      assert.deepStrictEqual(installWithMock("maven", "3.9.9"), true);
      const shellCommand = `${spawnCalls[0][1].join(" ")}`;
      assert.ok(
        shellCommand.includes("sdk install maven 3.9.9"),
        `expected sdk install invocation, got: ${shellCommand}`,
      );
    }
  } finally {
    if (previousCandidatesDir === undefined) {
      delete process.env.SDKMAN_CANDIDATES_DIR;
    } else {
      process.env.SDKMAN_CANDIDATES_DIR = previousCandidatesDir;
    }
  }
});

it("version probes record tool.resolved ledger events", async () => {
  const ledgerEvents = [];
  const { collectGoInfo, collectJavaInfo, collectNodeInfo } = await esmock(
    "./envcontext.js",
    {},
    {
      "../core/buildLedger.js": {
        LEDGER_ENABLED: true,
        isLedgerEnabled: () => true,
        LEDGER_EVENT_KINDS,
        recordLedgerEvent: (kind, fields = {}) => {
          ledgerEvents.push({ kind, ...fields });
          return { kind, ...fields };
        },
      },
      "../core/fs.js": {
        MAX_BUFFER: 104857600,
        getTmpDir: () => tmpdir(),
        safeExistsSync: () => false,
        safeSpawnSync: (_cmd, args) => {
          if (args?.includes("--version") || args?.includes("version")) {
            return { status: 0, stdout: "tool version 1.2.3\n", stderr: "" };
          }
          return { status: 1, error: "not found", stdout: "", stderr: "" };
        },
      },
    },
  );
  const javaInfo = collectJavaInfo(tmpdir());
  assert.ok(javaInfo, "expected a java info object");
  const goInfo = collectGoInfo(tmpdir());
  assert.ok(goInfo, "expected a go info object");
  collectNodeInfo(tmpdir());
  const resolved = ledgerEvents.filter(
    (event) => event.kind === LEDGER_EVENT_KINDS.TOOL_RESOLVED,
  );
  assert.deepStrictEqual(
    resolved.map((event) => [event.ecosystem, event.tool, event.source]),
    [
      ["java", "java", "PATH"],
      ["go", "go", "PATH"],
      ["generic", "node", "runtime"],
      ["npm", "npm", "PATH"],
    ],
  );
  assert.strictEqual(resolved[0].found, "tool version 1.2.3");
});

it("a failed probe records tool.missing rather than degraded evidence", async () => {
  const ledgerEvents = [];
  const { collectJavaInfo } = await esmock(
    "./envcontext.js",
    {},
    {
      "../core/buildLedger.js": {
        LEDGER_ENABLED: true,
        isLedgerEnabled: () => true,
        LEDGER_EVENT_KINDS,
        recordLedgerEvent: (kind, fields = {}) => {
          ledgerEvents.push({ kind, ...fields });
          return { kind, ...fields };
        },
      },
      "../core/fs.js": {
        MAX_BUFFER: 104857600,
        getTmpDir: () => tmpdir(),
        safeExistsSync: () => false,
        safeSpawnSync: () => ({
          status: 1,
          error: "not found",
          stdout: "",
          stderr: "",
        }),
      },
    },
  );
  assert.strictEqual(collectJavaInfo(tmpdir()), undefined);
  assert.deepStrictEqual(
    ledgerEvents.map((event) => event.kind),
    [LEDGER_EVENT_KINDS.TOOL_MISSING],
  );
  assert.strictEqual(ledgerEvents[0].ecosystem, "java");
  assert.strictEqual(ledgerEvents[0].tool, "java");
  assert.strictEqual(ledgerEvents[0].source, "PATH");
});

it("a denied probe records evidence.degraded, never tool.missing", async () => {
  const ledgerEvents = [];
  const { collectJavaInfo } = await esmock(
    "./envcontext.js",
    {},
    {
      "./toolRequirements.js": {
        // Simulates what the real classifier reports under Deno with
        // restricted --allow-run, or under any other spawn restriction.
        describeSpawnRestriction: () =>
          "the Deno run permission is not granted for this command",
      },
      "../core/buildLedger.js": {
        LEDGER_ENABLED: true,
        isLedgerEnabled: () => true,
        LEDGER_EVENT_KINDS,
        recordLedgerEvent: (kind, fields = {}) => {
          ledgerEvents.push({ kind, ...fields });
          return { kind, ...fields };
        },
      },
      "../core/fs.js": {
        MAX_BUFFER: 104857600,
        getTmpDir: () => tmpdir(),
        safeExistsSync: () => false,
        safeSpawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
      },
    },
  );
  assert.strictEqual(collectJavaInfo(tmpdir()), undefined);
  assert.deepStrictEqual(
    ledgerEvents.map((event) => event.kind),
    [LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED],
  );
  assert.strictEqual(ledgerEvents[0].tool, "java");
  assert.match(ledgerEvents[0].detail, /could not run/);
});

it("a dry-run-denied probe records policy.dry-run with no impact", async () => {
  const ledgerEvents = [];
  const { collectJavaInfo } = await esmock(
    "./envcontext.js",
    {},
    {
      "./toolRequirements.js": {
        describeSpawnRestriction: () => "dry-run mode blocks command execution",
        classifySpawnRestriction: () => "dry-run",
      },
      "../core/buildLedger.js": {
        LEDGER_ENABLED: true,
        isLedgerEnabled: () => true,
        LEDGER_EVENT_KINDS,
        LEDGER_EVENT_IMPACTS,
        recordLedgerEvent: (kind, fields = {}) => {
          ledgerEvents.push({ kind, ...fields });
          return { kind, ...fields };
        },
      },
      "../core/fs.js": {
        MAX_BUFFER: 104857600,
        getTmpDir: () => tmpdir(),
        safeExistsSync: () => false,
        safeSpawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
      },
    },
  );
  assert.strictEqual(collectJavaInfo(tmpdir()), undefined);
  assert.strictEqual(ledgerEvents[0].remediationId, "policy.dry-run");
  assert.strictEqual(ledgerEvents[0].impact, LEDGER_EVENT_IMPACTS.NONE);
});

it("a secure-mode-denied probe records policy.secure-mode with versions impact", async () => {
  const ledgerEvents = [];
  const { collectJavaInfo } = await esmock(
    "./envcontext.js",
    {},
    {
      "./toolRequirements.js": {
        describeSpawnRestriction: () =>
          "secure mode denies child process execution",
        classifySpawnRestriction: () => "secure-mode",
      },
      "../core/buildLedger.js": {
        LEDGER_ENABLED: true,
        isLedgerEnabled: () => true,
        LEDGER_EVENT_KINDS,
        LEDGER_EVENT_IMPACTS,
        recordLedgerEvent: (kind, fields = {}) => {
          ledgerEvents.push({ kind, ...fields });
          return { kind, ...fields };
        },
      },
      "../core/fs.js": {
        MAX_BUFFER: 104857600,
        getTmpDir: () => tmpdir(),
        safeExistsSync: () => false,
        safeSpawnSync: () => ({ status: 1, stdout: "", stderr: "" }),
      },
    },
  );
  assert.strictEqual(collectJavaInfo(tmpdir()), undefined);
  assert.strictEqual(ledgerEvents[0].remediationId, "policy.secure-mode");
  assert.strictEqual(ledgerEvents[0].impact, LEDGER_EVENT_IMPACTS.VERSIONS);
});

it("ruby installs record command.attempted and command.failed", async () => {
  const ledgerEvents = [];
  const { installRubyVersion } = await esmock(
    "./envcontext.js",
    {},
    {
      "../core/buildLedger.js": {
        LEDGER_ENABLED: true,
        isLedgerEnabled: () => true,
        LEDGER_EVENT_KINDS,
        recordLedgerEvent: (kind, fields = {}) => {
          ledgerEvents.push({ kind, ...fields });
          return { kind, ...fields };
        },
      },
      "../core/fs.js": {
        MAX_BUFFER: 104857600,
        getTmpDir: () => tmpdir(),
        safeExistsSync: () => false,
        safeSpawnSync: () => ({
          status: 1,
          error: "install failed",
          stdout: "",
          stderr: "",
        }),
      },
    },
  );
  const consoleStub = sinon.stub(console, "log");
  try {
    const result = installRubyVersion("3.3.6", tmpdir());
    assert.strictEqual(result.status, false);
  } finally {
    consoleStub.restore();
  }
  assert.deepStrictEqual(
    ledgerEvents.map((event) => [event.kind, event.tool]),
    [
      [LEDGER_EVENT_KINDS.TOOL_MISSING, "ruby"],
      [LEDGER_EVENT_KINDS.COMMAND_ATTEMPTED, "rbenv"],
      [LEDGER_EVENT_KINDS.COMMAND_FAILED, "rbenv"],
    ],
  );
});

it("bundle installs record command.attempted and command.failed", async () => {
  const ledgerEvents = [];
  const { performBundleInstall } = await esmock(
    "./envcontext.js",
    {},
    {
      "../core/buildLedger.js": {
        LEDGER_ENABLED: true,
        isLedgerEnabled: () => true,
        LEDGER_EVENT_KINDS,
        recordLedgerEvent: (kind, fields = {}) => {
          ledgerEvents.push({ kind, ...fields });
          return { kind, ...fields };
        },
      },
      "../core/fs.js": {
        MAX_BUFFER: 104857600,
        getTmpDir: () => tmpdir(),
        safeExistsSync: () => false,
        safeSpawnSync: () => ({
          status: 1,
          error: "bundle failed",
          stdout: "",
          stderr: "",
        }),
      },
    },
  );
  const consoleStub = sinon.stub(console, "log");
  try {
    const result = performBundleInstall(tmpdir(), "3.3.6", "bundle", tmpdir());
    assert.strictEqual(result, false);
  } finally {
    consoleStub.restore();
  }
  assert.deepStrictEqual(
    ledgerEvents.map((event) => [event.kind, event.tool]),
    [
      [LEDGER_EVENT_KINDS.COMMAND_ATTEMPTED, "bundler"],
      [LEDGER_EVENT_KINDS.COMMAND_FAILED, "bundler"],
    ],
  );
});

it("envcontext ledger recording stays inert when introspection is disabled", async () => {
  const { collectGoInfo } = await import("./envcontext.js");
  collectGoInfo(tmpdir());
  collectRustInfo(tmpdir());
  assert.deepStrictEqual(getLedgerEvents(), []);
});

const PHP_BANNER = [
  "PHP 8.5.11 (cli) (built: Sep 22 2026 13:32:06) (NTS)",
  "Copyright (c) The PHP Group",
  "Zend Engine v4.5.11, Copyright (c) Zend Technologies",
].join("\n");
const COMPOSER_BANNER = [
  "Composer version 2.10.3 2026-08-27 13:34:23",
  "PHP version 8.5.11 (/opt/homebrew/Cellar/php/8.5.11_1/bin/php)",
  'Run the "diagnose" command to get more detailed diagnostics output.',
].join("\n");

// A command that answers only to the arguments the probe is meant to send, so
// a probe that sends others finds no version.
function writeFakeCommand(dir, name, expectedArgs, output) {
  const script = join(dir, name);
  writeFileSync(`${script}.out`, `${output}\n`);
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `if [ "$*" = "${expectedArgs.join(" ")}" ]; then`,
      '  cat "$0.out"',
      "else",
      '  echo "unexpected arguments: $*" >&2',
      "  exit 2",
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return script;
}

// The module under test with a recording ledger, the commands it runs named by
// `env`, and, when `spawn` is given, that function in place of a real process.
async function loadProbes({ env = {}, spawn, tmp = tmpdir() } = {}) {
  const ledgerEvents = [];
  const mocks = {
    "../core/buildLedger.js": {
      LEDGER_ENABLED: true,
      isLedgerEnabled: () => true,
      LEDGER_EVENT_KINDS,
      recordLedgerEvent: (kind, fields = {}) => {
        ledgerEvents.push({ kind, ...fields });
        return { kind, ...fields };
      },
    },
    "../core/env.js": env,
  };
  if (spawn) {
    mocks["../core/fs.js"] = {
      MAX_BUFFER: 104857600,
      getTmpDir: () => tmp,
      safeExistsSync: () => false,
      safeSpawnSync: spawn,
    };
  }
  const mod = await esmock("./envcontext.js", {}, mocks);
  return { ...mod, ledgerEvents };
}

const answer = (stdout) => () => ({ status: 0, stdout, stderr: "" });

it("collectPhpInfo records the version `php -n -v` prints, as a generic component", async () => {
  if (isWin) {
    console.log("skip: the fake command is a shell script");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-php-probe-"));
  try {
    const script = writeFakeCommand(dir, "fake-php", ["-n", "-v"], PHP_BANNER);
    const { collectPhpInfo: probe, ledgerEvents } = await loadProbes({
      env: { PHP_CMD: script },
    });
    // No bom-ref: formulation shares the document's refs with the inventory,
    // where an image scan can hold this same pkg:generic/php runtime.
    assert.deepStrictEqual(probe(dir), {
      type: "platform",
      name: "php",
      version: "8.5.11",
      purl: "pkg:generic/php@8.5.11",
      cpe: "cpe:2.3:a:php:php:8.5.11:*:*:*:*:*:*:*",
    });
    assert.deepStrictEqual(
      ledgerEvents.map((event) => [event.kind, event.tool, event.found]),
      [[LEDGER_EVENT_KINDS.TOOL_RESOLVED, "php", "8.5.11"]],
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

it("collectPhpInfo keeps the version clean and puts a pre-release in the CPE update field", async () => {
  const { collectPhpInfo: probe } = await loadProbes({
    spawn: answer("PHP 8.6.0RC3 (cli) (built: Oct 1 2026 10:00:00) (NTS)\n"),
  });
  const info = probe(tmpdir());
  assert.strictEqual(info.version, "8.6.0RC3");
  assert.strictEqual(info.purl, "pkg:generic/php@8.6.0RC3");
  assert.strictEqual(info.cpe, "cpe:2.3:a:php:php:8.6.0:rc3:*:*:*:*:*:*");
});

it("collectPhpInfo reads the Windows banner and its CRLF line ends", async () => {
  const { collectPhpInfo: probe } = await loadProbes({
    spawn: answer(
      "PHP 8.3.12 (cli) (built: Sep 24 2024 08:17:14) ( NTS Visual C++ 2019 x64 )\r\nCopyright (c) The PHP Group\r\n",
    ),
  });
  assert.strictEqual(probe(tmpdir()).version, "8.3.12");
});

it("collectPhpInfo carries no property the PHP-RCE audit rules would match", async () => {
  const { collectPhpInfo: probe } = await loadProbes({
    spawn: answer(`${PHP_BANNER}\n`),
  });
  // The PHP of the build host is not the runtime of what the BOM describes.
  const info = probe(tmpdir());
  assert.strictEqual(info.properties, undefined);
  assert.ok(!JSON.stringify(info).includes("cdx:php:"));
});

it("collectPhpInfo records a probe failure and no component for a garbled banner", async () => {
  for (const output of [
    "Segmentation fault",
    "PHP",
    "PHP 8.5 (cli)",
    "php 8.5.11 (cli)",
    "HipHop VM 4.1.0 (rel)",
    "PHP 8.5.11.1 (cli)",
    "PHP 8.4.27-",
    // Only the first line is read, so a banner after a foreign line is not
    // trusted either.
    'Warning: Module "gd" is already loaded\nPHP 8.5.11 (cli)',
  ]) {
    const { collectPhpInfo: probe, ledgerEvents } = await loadProbes({
      spawn: answer(output),
    });
    assert.strictEqual(probe(tmpdir()), undefined, output);
    assert.deepStrictEqual(
      ledgerEvents.map((event) => [event.kind, event.tool]),
      [[LEDGER_EVENT_KINDS.TOOL_MISSING, "php"]],
      output,
    );
    assert.match(ledgerEvents[0].detail, /did not print a PHP version banner/);
  }
});

it("collectPhpInfo keeps the version a distro build reports, without a CPE", async () => {
  for (const [banner, version, purl] of [
    [
      "PHP 8.1.2-1ubuntu2.14 (cli) (built: Jan 1 2025 00:00:00) ( NTS )",
      "8.1.2-1ubuntu2.14",
      "pkg:generic/php@8.1.2-1ubuntu2.14",
    ],
    [
      "PHP 8.3.12-1+ubuntu22.04.1+deb.sury.org+1 (cli) (built: Sep 27 2024)",
      "8.3.12-1+ubuntu22.04.1+deb.sury.org+1",
      "pkg:generic/php@8.3.12-1%2Bubuntu22.04.1%2Bdeb.sury.org%2B1",
    ],
  ]) {
    const { collectPhpInfo: probe, ledgerEvents } = await loadProbes({
      spawn: answer(`${banner}\n`),
    });
    // The distro backports fixes under the old upstream number, so an upstream
    // CPE would match advisories the build no longer has.
    assert.deepStrictEqual(
      probe(tmpdir()),
      { type: "platform", name: "php", version, purl },
      banner,
    );
    assert.deepStrictEqual(
      ledgerEvents.map((event) => [event.kind, event.tool, event.found]),
      [[LEDGER_EVENT_KINDS.TOOL_RESOLVED, "php", version]],
      banner,
    );
  }
});

it("collectPhpInfo records a missing command", async () => {
  const { collectPhpInfo: probe, ledgerEvents } = await loadProbes({
    spawn: () => ({ status: 1, error: "ENOENT", stdout: "", stderr: "" }),
  });
  assert.strictEqual(probe(tmpdir()), undefined);
  assert.deepStrictEqual(
    ledgerEvents.map((event) => [event.kind, event.ecosystem, event.tool]),
    [[LEDGER_EVENT_KINDS.TOOL_MISSING, "php", "php"]],
  );
});

it("collectComposerInfo records the version on the first line and never the PHP path", async () => {
  if (isWin) {
    console.log("skip: the fake command is a shell script");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-composer-probe-"));
  try {
    const script = writeFakeCommand(
      dir,
      "fake-composer",
      ["--version", "--no-plugins", "--no-scripts", "--no-interaction"],
      COMPOSER_BANNER,
    );
    const { collectComposerInfo: probe, ledgerEvents } = await loadProbes({
      env: { COMPOSER_CMD: script },
    });
    const info = probe(dir);
    assert.deepStrictEqual(info, {
      type: "platform",
      name: "composer",
      version: "2.10.3",
      purl: "pkg:generic/composer@2.10.3",
      cpe: "cpe:2.3:a:getcomposer:composer:2.10.3:*:*:*:*:*:*:*",
    });
    for (const recorded of [info, ledgerEvents]) {
      assert.ok(!JSON.stringify(recorded).includes("homebrew"));
      assert.ok(!JSON.stringify(recorded).includes("/bin/php"));
    }
    assert.deepStrictEqual(
      ledgerEvents.map((event) => [event.kind, event.tool, event.found]),
      [[LEDGER_EVENT_KINDS.TOOL_RESOLVED, "composer", "2.10.3"]],
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

it("collectComposerInfo finds the banner below deprecation notices and still skips the PHP path", async () => {
  const { collectComposerInfo: probe } = await loadProbes({
    spawn: answer(
      [
        "Deprecation Notice: Composer\\Util\\Platform::getEnv(): Implicitly marking parameter $name as nullable is deprecated in phar:///usr/local/bin/composer/src/Composer/Util/Platform.php:63",
        "Composer version 2.2.25 2024-12-11 11:57:47",
        "PHP version 8.5.11 (/opt/php/bin/php)",
      ].join("\n"),
    ),
  });
  const info = probe(tmpdir());
  assert.strictEqual(info.version, "2.2.25");
  assert.strictEqual(info.purl, "pkg:generic/composer@2.2.25");
  assert.ok(!JSON.stringify(info).includes("/opt/php"));
});

it("collectComposerInfo records a probe failure for a banner it cannot read and for a missing command", async () => {
  for (const output of [
    "Segmentation fault",
    "Composer version",
    "Composer version @package_version@ @release_date@",
    // Pre-release and snapshot builds carry no stable version to match.
    "Composer version 2.9.0-RC1 2026-01-01 00:00:00",
    "Composer version 2.8.0-dev+abc123 2026-01-01 00:00:00",
    // An error block echoes composer.json indented; that is not the banner.
    'In JsonFile.php line 344:\n  Composer version 9.9.9 2026-01-01 00:00:00\n  "./composer.json" does not contain valid JSON',
  ]) {
    const { collectComposerInfo: probe, ledgerEvents } = await loadProbes({
      spawn: answer(output),
    });
    assert.strictEqual(probe(tmpdir()), undefined, output);
    assert.deepStrictEqual(
      ledgerEvents.map((event) => [event.kind, event.tool]),
      [[LEDGER_EVENT_KINDS.TOOL_MISSING, "composer"]],
      output,
    );
  }
  const { collectComposerInfo: probe, ledgerEvents } = await loadProbes({
    spawn: () => ({ status: 127, error: "ENOENT", stdout: "", stderr: "" }),
  });
  assert.strictEqual(probe(tmpdir()), undefined);
  assert.strictEqual(ledgerEvents[0].kind, LEDGER_EVENT_KINDS.TOOL_MISSING);
});

it("collectEnvInfo probes php and composer in a temporary directory unless project tooling is allowed", async () => {
  const project = mkdtempSync(join(tmpdir(), "cdxgen-php-project-"));
  const scratch = mkdtempSync(join(tmpdir(), "cdxgen-php-scratch-"));
  try {
    const calls = [];
    const { collectEnvInfo: collect } = await loadProbes({
      tmp: scratch,
      spawn: (cmd, args, options) => {
        calls.push({ cmd, args, cwd: options?.cwd });
        if (cmd === "php") {
          return { status: 0, stdout: `${PHP_BANNER}\n`, stderr: "" };
        }
        if (cmd === "composer") {
          return { status: 0, stdout: `${COMPOSER_BANNER}\n`, stderr: "" };
        }
        return { status: 1, error: "ENOENT", stdout: "", stderr: "" };
      },
    });
    const phpProbes = () =>
      calls.filter((call) => call.cmd === "php" || call.cmd === "composer");

    // The scanned project must not choose the php or composer that runs.
    const gated = collect(project, { installDeps: false });
    assert.deepStrictEqual(
      phpProbes().map((call) => [call.cmd, call.cwd]),
      [
        ["php", scratch],
        ["composer", scratch],
      ],
    );
    assert.deepStrictEqual(
      gated
        .filter((c) => ["php", "composer"].includes(c.name))
        .map((c) => c.version),
      ["8.5.11", "2.10.3"],
    );
    assert.deepStrictEqual(phpProbes()[0].args, ["-n", "-v"]);
    assert.deepStrictEqual(phpProbes()[1].args, [
      "--version",
      "--no-plugins",
      "--no-scripts",
      "--no-interaction",
    ]);

    calls.length = 0;
    collect(project, { installDeps: true });
    assert.deepStrictEqual(
      phpProbes().map((call) => [call.cmd, call.cwd]),
      [
        ["php", project],
        ["composer", project],
      ],
    );
  } finally {
    rmSync(project, { force: true, recursive: true });
    rmSync(scratch, { force: true, recursive: true });
  }
});

it("nodeComponentLinkage() reads the node_shared_* configure variables", () => {
  const variables = {
    node_shared_brotli: true,
    node_shared_libuv: "true",
    node_shared_http_parser: false,
    node_shared_cares: false,
  };
  assert.strictEqual(nodeComponentLinkage("brotli", variables), "shared");
  assert.strictEqual(nodeComponentLinkage("uv", variables), "shared");
  assert.strictEqual(nodeComponentLinkage("llhttp", variables), "bundled");
  assert.strictEqual(nodeComponentLinkage("ares", variables), "bundled");
  assert.strictEqual(nodeComponentLinkage("v8", variables), undefined);
  assert.strictEqual(nodeComponentLinkage("brotli", {}), undefined);
});

it("collectNodeInfo() gives the runtime a matchable identity and its brotli state", () => {
  const nodeInfo = collectNodeInfo(process.cwd());
  if (nodeInfo.name !== "Node.js") {
    return;
  }
  assert.strictEqual(
    nodeInfo.purl,
    `pkg:generic/node@${process.versions.node}`,
  );
  assert.strictEqual(
    nodeInfo.cpe,
    `cpe:2.3:a:nodejs:node.js:${process.versions.node}:*:*:*:*:*:*:*`,
  );
  assert.strictEqual(
    nodeInfo["bom-ref"],
    undefined,
    "a toolchain has no bom-ref",
  );
  const brotli = nodeInfo.components?.find((c) => c.name === "brotli");
  if (brotli) {
    const linkage = brotli.properties?.find(
      (p) => p.name === "cdx:node:linkage",
    )?.value;
    assert.ok(["shared", "bundled"].includes(linkage));
    assert.ok(
      brotli.description.startsWith(
        linkage === "shared" ? "Linked by Node.js" : "Bundled with Node.js",
      ),
    );
  }
});

describe("Ruby toolchain probes", () => {
  // A command path that resolves nowhere, so the CPE decision does not depend
  // on which ruby the machine running the tests has on its PATH.
  const env = {
    RUBY_CMD: join(tmpdir(), "cdxgen-no-such-dir", "ruby"),
    GEM_CMD: "gem",
    BUNDLE_CMD: "bundle",
  };

  it("collectRubyInfo names the interpreter by version and keeps the banner", async () => {
    const banner = "ruby 3.3.6 (2024-11-05 revision 75015d4c1f) [x86_64-linux]";
    const { collectRubyInfo: probe, ledgerEvents } = await loadProbes({
      env,
      spawn: answer(`${banner}\n`),
    });
    assert.deepStrictEqual(probe(tmpdir()), {
      type: "platform",
      name: "ruby",
      version: "3.3.6",
      cpe: "cpe:2.3:a:ruby-lang:ruby:3.3.6:*:*:*:*:*:*:*",
      purl: "pkg:generic/ruby@3.3.6",
      description: banner,
      properties: [{ name: "cdx:ruby:platform", value: "x86_64-linux" }],
    });
    assert.deepStrictEqual(
      ledgerEvents.map((event) => [event.kind, event.tool]),
      [[LEDGER_EVENT_KINDS.TOOL_RESOLVED, "ruby"]],
    );
  });

  it("collectRubyInfo reads patchlevels, previews and other engines", async () => {
    for (const [banner, purl, cpe, properties] of [
      [
        "ruby 2.7.8p225 (2023-03-30 revision 1f4d455848) [x86_64-linux]",
        "pkg:generic/ruby@2.7.8",
        "cpe:2.3:a:ruby-lang:ruby:2.7.8:*:*:*:*:*:*:*",
        ["cdx:ruby:patchlevel=225", "cdx:ruby:platform=x86_64-linux"],
      ],
      [
        "ruby 3.4.0preview2 (2024-10-07 master 32c733f57b) +PRISM [arm64-darwin24]",
        "pkg:generic/ruby@3.4.0-preview2",
        "cpe:2.3:a:ruby-lang:ruby:3.4.0:preview2:*:*:*:*:*:*",
        ["cdx:ruby:platform=arm64-darwin24"],
      ],
      [
        "jruby 9.4.8.0 (3.1.4) 2024-07-02 4d41e55a67 OpenJDK 64-Bit Server VM 21.0.4+7-LTS on 21.0.4+7-LTS +jit [x86_64-linux]",
        "pkg:generic/jruby@9.4.8.0",
        "cpe:2.3:a:jruby:jruby:9.4.8.0:*:*:*:*:*:*:*",
        ["cdx:ruby:languageVersion=3.1.4"],
      ],
      [
        "truffleruby 24.1.0, like ruby 3.2.4, Oracle GraalVM Native [x86_64-linux]",
        "pkg:generic/truffleruby@24.1.0",
        undefined,
        ["cdx:ruby:languageVersion=3.2.4"],
      ],
    ]) {
      const { collectRubyInfo: probe } = await loadProbes({
        env,
        spawn: answer(banner),
      });
      const info = probe(tmpdir());
      assert.strictEqual(info.purl, purl, banner);
      assert.strictEqual(info.cpe, cpe, banner);
      assert.deepStrictEqual(
        info.properties.map((prop) => `${prop.name}=${prop.value}`),
        properties,
        banner,
      );
    }
  });

  it("collectRubyInfo records a failure for a garbled banner", async () => {
    for (const output of ["", "rbenv: ruby: command not found", "ruby 3.3"]) {
      const { collectRubyInfo: probe, ledgerEvents } = await loadProbes({
        env,
        spawn: answer(output),
      });
      assert.strictEqual(probe(tmpdir()), undefined, output);
      assert.deepStrictEqual(
        ledgerEvents.map((event) => [event.kind, event.tool]),
        [[LEDGER_EVENT_KINDS.TOOL_MISSING, "ruby"]],
        output,
      );
    }
  });

  it("isRubyVersionActive matches MRI by exact version", async () => {
    const { isRubyVersionActive } = await loadProbes({ env });
    assert.ok(isRubyVersionActive({ name: "ruby", version: "3.3.6" }, "3.3.6"));
    assert.ok(!isRubyVersionActive({ name: "ruby", version: "3.3.6" }, "3.3"));
    assert.ok(
      !isRubyVersionActive({ name: "jruby", version: "3.3.6" }, "3.3.6"),
    );
    assert.ok(!isRubyVersionActive(undefined, "3.3.6"));
  });

  it("isPackagedRubyPath leaves out the CPE of a packaged Ruby", async () => {
    const { isPackagedRubyPath } = await loadProbes({ env });
    for (const path of [
      "/usr/bin/ruby3.2",
      "/usr/lib/ruby/bin/ruby",
      "/nix/store/abc-ruby-3.3.6/bin/ruby",
    ]) {
      assert.ok(isWin || isPackagedRubyPath(path), path);
    }
    // Homebrew builds the upstream release and keeps the CPE, as in an OBOM
    for (const path of [
      "/opt/homebrew/Cellar/ruby/3.4.8/bin/ruby",
      "/usr/local/bin/ruby",
      "/home/dev/.rbenv/versions/3.3.6/bin/ruby",
      undefined,
    ]) {
      assert.ok(!isPackagedRubyPath(path), `${path}`);
    }
  });

  it("collects RubyGems and Bundler with their CPEs", async () => {
    const { collectRubyGemsInfo, collectBundlerInfo } = await loadProbes({
      env,
      spawn: (command) =>
        answer(
          command.includes("bundle") ? "Bundler version 2.5.22\n" : "3.5.22\n",
        )(),
    });
    assert.deepStrictEqual(collectRubyGemsInfo(tmpdir()), {
      type: "platform",
      name: "rubygems",
      version: "3.5.22",
      cpe: "cpe:2.3:a:rubygems:rubygems:3.5.22:*:*:*:*:*:*:*",
      purl: "pkg:generic/rubygems@3.5.22",
    });
    assert.deepStrictEqual(collectBundlerInfo(tmpdir()), {
      type: "platform",
      name: "bundler",
      version: "2.5.22",
      cpe: "cpe:2.3:a:bundler:bundler:2.5.22:*:*:*:*:*:*:*",
      purl: "pkg:gem/bundler@2.5.22",
    });
    // Bundler 2.6 prints the bare version
    const { collectBundlerInfo: bare } = await loadProbes({
      env,
      spawn: answer("2.6.9\n"),
    });
    assert.strictEqual(bare(tmpdir()).version, "2.6.9");
  });
});

describe("collectRubyInfo() through a version manager shim (#4645)", () => {
  const banner = "ruby 3.2.3 (2024-01-18 revision 52bb2ac0a6) [x86_64-linux]";
  const withShim = async (target) => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-ruby-shim-"));
    const shim = join(dir, ".rbenv", "shims", "ruby");
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, "#!/bin/sh\n");
    try {
      const calls = [];
      const { collectRubyInfo: probe } = await loadProbes({
        env: { RUBY_CMD: shim },
        spawn: (_command, args) => {
          calls.push(args);
          return {
            status: 0,
            stdout: args.includes("-e") ? target : `${banner}\n`,
            stderr: "",
          };
        },
      });
      return { info: probe(tmpdir()), calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it("keeps the CPE of the interpreter a shim runs", async () => {
    if (isWin) {
      return;
    }
    const { info, calls } = await withShim(
      "/home/dev/.rbenv/versions/3.2.3/bin/ruby",
    );
    assert.ok(calls.some((args) => args.includes("print RbConfig.ruby")));
    assert.strictEqual(
      info.cpe,
      "cpe:2.3:a:ruby-lang:ruby:3.2.3:*:*:*:*:*:*:*",
    );
  });
  it("drops it when the shim runs the distro's Ruby, or cannot say", async () => {
    if (isWin) {
      return;
    }
    assert.strictEqual(
      (await withShim("/usr/bin/ruby3.2")).info.cpe,
      undefined,
    );
    assert.strictEqual((await withShim("")).info.cpe, undefined);
  });
});
