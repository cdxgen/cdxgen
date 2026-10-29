import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Purl } from "@cdxgen/cdx-purl";
import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import {
  collectExecutables,
  collectSharedLibs,
} from "../inventory/osPackageResolver.js";

function testDataPath(name) {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "test",
    "data",
    name,
  );
}

function createStubbedPluginRuntime() {
  let platform = process.platform;
  let extn = "";
  if (platform === "win32") {
    platform = "windows";
    extn = ".exe";
  }

  let arch = process.arch;
  if (arch === "x64") {
    arch = "amd64";
  } else if (arch === "ppc64") {
    arch = "ppc64le";
  } else if (arch === "x32") {
    arch = "386";
  }

  const pluginsDir = process.env.CDXGEN_PLUGINS_DIR || "";
  const pluginManifestFile =
    pluginsDir && existsSync(path.join(pluginsDir, "plugins-manifest.json"))
      ? path.join(pluginsDir, "plugins-manifest.json")
      : undefined;

  return {
    arch,
    extn,
    extraNMBinPath: undefined,
    platform,
    pluginManifestFile,
    pluginVersion: "1.0.0",
    pluginsBinSuffix: "",
    pluginsDir,
  };
}

function resolveStubbedPluginBinary(toolName, pluginRuntime) {
  const envCommandNames = {
    "cargo-auditable": "CARGO_AUDITABLE_CMD",
    dosai: "DOSAI_CMD",
    osquery: "OSQUERY_CMD",
    sourcekitten: "SOURCEKITTEN_CMD",
    trivy: "TRIVY_CMD",
    trustinspector: "TRUSTINSPECTOR_CMD",
  };
  const envCommandName = envCommandNames[toolName];
  if (envCommandName && process.env[envCommandName]) {
    return process.env[envCommandName];
  }
  if (!pluginRuntime?.pluginsDir) {
    return undefined;
  }
  if (!existsSync(path.join(pluginRuntime.pluginsDir, toolName))) {
    return undefined;
  }
  switch (toolName) {
    case "trivy":
      return path.join(
        pluginRuntime.pluginsDir,
        "trivy",
        `trivy-cdxgen-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
      );
    case "osquery": {
      const expectedPath = path.join(
        pluginRuntime.pluginsDir,
        "osquery",
        `osqueryi-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
      );
      return pluginRuntime.platform === "darwin"
        ? `${expectedPath}.app/Contents/MacOS/osqueryd`
        : expectedPath;
    }
    case "trustinspector":
      return path.join(
        pluginRuntime.pluginsDir,
        "trustinspector",
        `trustinspector-cdxgen-${pluginRuntime.platform}-${pluginRuntime.arch}${pluginRuntime.extn}`,
      );
    default:
      return undefined;
  }
}

async function loadBinaryModule({
  pluginsOverrides,
  utilsOverrides,
  moduleOverrides,
} = {}) {
  const shared = { ...utilsOverrides };
  return esmock("./binary.js", {
    ...moduleOverrides,
    "../inventory/plugins.js": {
      resolveCdxgenPlugins: sinon
        .stub()
        .callsFake(() => createStubbedPluginRuntime()),
      resolvePluginBinary: sinon
        .stub()
        .callsFake((toolName, pluginRuntime = createStubbedPluginRuntime()) =>
          resolveStubbedPluginBinary(toolName, pluginRuntime),
        ),
      setPluginsPathEnv: sinon
        .stub()
        .callsFake((pluginRuntime) => pluginRuntime),
      ...pluginsOverrides,
    },
    "../inventory/spdx.js": {
      adjustLicenseInformation: sinon.stub(),
      findLicenseId: sinon.stub(),
      isSpdxLicenseExpression: sinon.stub().returns(false),
      ...shared,
    },
    "../inventory/evidenceUtils.js": {
      attachIdentityTools: sinon.stub(),
      extractToolRefs: sinon.stub().returns([]),
      ...shared,
    },
    "../inventory/osPackageResolver.js": {
      collectExecutables: sinon.stub().returns([]),
      collectSharedLibs: sinon.stub().returns([]),
      ...shared,
    },
    "../core/env.js": {
      extractPathEnv: sinon.stub().returns([]),
      ...shared,
    },
    "../core/paths.js": {
      isValidDriveRoot: sinon
        .stub()
        .callsFake((root) => /^[A-Za-z]:\\$/.test(root)),
      ...shared,
    },
    "../core/activity.js": {
      DEBUG_MODE: false,
      hasDangerousUnicode: sinon.stub().returns(false),
      isDryRun: false,
      recordActivity: sinon.stub(),
      recordSymlinkResolution: sinon.stub(),
      ...shared,
    },
    "../core/fs.js": {
      getTmpDir: sinon.stub().returns("/tmp"),
      multiChecksumFile: sinon.stub(),
      safeExistsSync: sinon.stub().returns(false),
      safeMkdirSync: sinon.stub(),
      safeMkdtempSync: sinon.stub().returns("/tmp/trivy-cdxgen-test"),
      safeRmSync: sinon.stub(),
      safeSpawnSync: sinon
        .stub()
        .returns({ status: 1, stdout: "", stderr: "" }),
      ...shared,
    },
    "./containerutils.js": {
      getDirs: sinon.stub().returns([]),
    },
  });
}

function loadPluginToolsInSubprocess(
  pluginsDir,
  toolNames = ["trustinspector"],
) {
  const binaryModuleUrl = new URL("./binary.js", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { getPluginToolComponents } from ${JSON.stringify(binaryModuleUrl.href)}; console.log(JSON.stringify(getPluginToolComponents(${JSON.stringify(toolNames)})));`,
    ],
    {
      cwd: path.dirname(fileURLToPath(binaryModuleUrl)),
      encoding: "utf-8",
      env: {
        ...process.env,
        CDXGEN_PLUGINS_DIR: pluginsDir,
      },
    },
  );
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim() || "[]");
}

it("executeOsQuery() reports a blocked dry-run activity", async () => {
  const recordActivity = sinon.stub();
  const { executeOsQuery } = await loadBinaryModule({
    utilsOverrides: {
      isDryRun: true,
      recordActivity,
    },
  });
  const result = executeOsQuery("select * from processes");
  assert.strictEqual(result, undefined);
  sinon.assert.calledWithMatch(recordActivity, {
    kind: "osquery",
    status: "blocked",
    target: "select * from processes",
  });
});

it("executeOsQuery() uses osquery shell mode with the persistent database disabled", async () => {
  const safeSpawnSync = sinon
    .stub()
    .returns({ status: 0, stdout: '[{"ok":"1"}]', stderr: "" });
  const previousOsqueryCmd = process.env.OSQUERY_CMD;
  process.env.OSQUERY_CMD = "/tmp/osqueryd";
  try {
    const { executeOsQuery } = await loadBinaryModule({
      utilsOverrides: {
        safeSpawnSync,
      },
    });
    const result = executeOsQuery("select 1 as ok");
    assert.deepStrictEqual(result, [{ ok: "1" }]);
    assert.ok(safeSpawnSync.callCount >= 1);
    assert.strictEqual(safeSpawnSync.lastCall.args[0], "/tmp/osqueryd");
    const args = safeSpawnSync.lastCall.args[1];
    assert.ok(args.includes("--S"));
    assert.ok(args.includes("--disable_database"));
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("select 1 as ok;"));
    if (process.platform === "darwin") {
      assert.ok(args.includes("--allow_unsafe"));
      assert.ok(args.includes("--disable_logging"));
      assert.ok(args.includes("--disable_events"));
    }
  } finally {
    if (previousOsqueryCmd === undefined) {
      delete process.env.OSQUERY_CMD;
    } else {
      process.env.OSQUERY_CMD = previousOsqueryCmd;
    }
  }
});

it("getOSPackages() does not misclassify non-launchpad URLs as PPAs", async () => {
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-ppa-check-"));
  try {
    mkdirSync(path.join(rootfs, "etc", "apt", "sources.list.d"), {
      recursive: true,
    });
    writeFileSync(
      path.join(rootfs, "etc", "apt", "sources.list.d", "example.list"),
      [
        "deb https://example.com/redirect/ppa.launchpad.net/ondrej/php ubuntu main",
      ].join("\n"),
    );
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables: sinon.stub().returns([]),
        collectSharedLibs: sinon.stub().returns([]),
        extractPathEnv: sinon.stub().returns([]),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeSpawnSync: sinon
          .stub()
          .returns({ status: 0, stdout: "", stderr: "" }),
      },
    });
    const result = await getOSPackages(rootfs, { Env: [] });
    const repoComponent = result.osPackages.find((component) =>
      component.properties?.some(
        (property) => property.name === "cdx:os:repo:url",
      ),
    );
    assert.ok(repoComponent);
    assert.ok(
      repoComponent.properties?.some(
        (property) =>
          property.name === "cdx:os:repo:type" &&
          property.value === "apt-source",
      ),
    );
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
  }
});

it("getOSPackages() skips trustinspector rootfs execution for dangerous paths", async () => {
  const pluginsDir = mkdtempSync(path.join(tmpdir(), "cdxgen-plugins-trust-"));
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  const previousTrustInspectorCmd = process.env.TRUSTINSPECTOR_CMD;
  const safeSpawnSync = sinon.stub().callsFake((command) => {
    if (command === "ldd") {
      return { status: 1, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  try {
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.0",
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    process.env.TRUSTINSPECTOR_CMD = "/tmp/trustinspector";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables: sinon.stub().returns([]),
        collectSharedLibs: sinon.stub().returns([]),
        extractPathEnv: sinon.stub().returns([]),
        hasDangerousUnicode: sinon
          .stub()
          .callsFake((value) => `${value || ""}`.includes("\u202e")),
        safeExistsSync: sinon.stub().returns(false),
        safeSpawnSync,
      },
    });
    await getOSPackages("/tmp/rootfs\u202e", { Env: [] });
    assert.ok(
      safeSpawnSync
        .getCalls()
        .every(
          (call) =>
            call.args[0] !== "/tmp/trustinspector" ||
            call.args[1]?.[0] !== "rootfs",
        ),
    );
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    if (previousTrustInspectorCmd === undefined) {
      delete process.env.TRUSTINSPECTOR_CMD;
    } else {
      process.env.TRUSTINSPECTOR_CMD = previousTrustInspectorCmd;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

it("getOSPackages() runs trivy only as a rootfs scan of an existing path", async () => {
  const trivyCmd = path.join(tmpdir(), "trivy-cdxgen-test");
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-"));
  const trivyTempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-trivy-"));
  const missingRootfs = path.join(rootfs, "missing");
  const warn = sinon.stub(console, "warn");
  const trivyCalls = (safeSpawnSync) =>
    safeSpawnSync.getCalls().filter((call) => call.args[0] === trivyCmd);
  // Resolve trivy through a stub rather than TRIVY_CMD: tests in this file
  // run concurrently and others set and restore that variable.
  const loadWithStubs = (safeSpawnSync) =>
    loadBinaryModule({
      pluginsOverrides: {
        resolvePluginBinary: sinon
          .stub()
          .callsFake((toolName) =>
            toolName === "trivy" ? trivyCmd : undefined,
          ),
      },
      utilsOverrides: {
        collectExecutables: sinon.stub().returns([]),
        collectSharedLibs: sinon.stub().returns([]),
        extractPathEnv: sinon.stub().returns([]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync,
      },
    });
  const spawnStub = () =>
    sinon.stub().callsFake((command) => {
      if (command === "ldd") {
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
  try {
    // A missing root filesystem used to fall through to `trivy image`, which
    // trivy-cdxgen does not provide. It must skip trivy and say why.
    const missingSpawn = spawnStub();
    const missing = await loadWithStubs(missingSpawn);
    await missing.getOSPackages(missingRootfs, { Env: [] });
    assert.strictEqual(trivyCalls(missingSpawn).length, 0);
    assert.ok(
      warn.getCalls().some((call) => `${call.args[0]}`.includes(missingRootfs)),
    );

    const presentSpawn = spawnStub();
    const present = await loadWithStubs(presentSpawn);
    await present.getOSPackages(rootfs, { Env: [] });
    const calls = trivyCalls(presentSpawn);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].args[1][0], "rootfs");
    assert.strictEqual(calls[0].args[1].at(-1), rootfs);
    assert.ok(!calls[0].args[1].includes("image"));
  } finally {
    warn.restore();
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
  }
});

it("getOSPackages() skips trustinspector rootfs execution for non-directory targets", async () => {
  const pluginsDir = mkdtempSync(path.join(tmpdir(), "cdxgen-plugins-trust-"));
  const rootfsFile = path.join(pluginsDir, "not-a-rootfs.txt");
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  const previousTrustInspectorCmd = process.env.TRUSTINSPECTOR_CMD;
  const safeSpawnSync = sinon.stub().callsFake((command) => {
    if (command === "ldd") {
      return { status: 1, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  try {
    writeFileSync(rootfsFile, "not a directory\n");
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.0",
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    process.env.TRUSTINSPECTOR_CMD = "/tmp/trustinspector";
    const safeExistsSync = sinon
      .stub()
      .callsFake((targetPath) => targetPath === rootfsFile);
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables: sinon.stub().returns([]),
        collectSharedLibs: sinon.stub().returns([]),
        extractPathEnv: sinon.stub().returns([]),
        safeExistsSync,
        safeSpawnSync,
      },
    });
    await getOSPackages(rootfsFile, { Env: [] });
    assert.ok(
      safeSpawnSync
        .getCalls()
        .every(
          (call) =>
            call.args[0] !== "/tmp/trustinspector" ||
            call.args[1]?.[0] !== "rootfs",
        ),
    );
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    if (previousTrustInspectorCmd === undefined) {
      delete process.env.TRUSTINSPECTOR_CMD;
    } else {
      process.env.TRUSTINSPECTOR_CMD = previousTrustInspectorCmd;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

it("getOSPackages() preserves a valid symlinked rootfs path for trustinspector", async () => {
  if (process.platform === "win32") {
    return;
  }
  const pluginsDir = mkdtempSync(path.join(tmpdir(), "cdxgen-plugins-trust-"));
  const realRootfsDir = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-real-"));
  const rootfsLink = path.join(pluginsDir, "rootfs-link");
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  const previousTrustInspectorCmd = process.env.TRUSTINSPECTOR_CMD;
  const safeSpawnSync = sinon.stub().callsFake((command, args) => {
    if (command === "ldd") {
      return { status: 1, stdout: "", stderr: "" };
    }
    if (command === "/tmp/trustinspector" && args?.[0] === "rootfs") {
      return {
        status: 0,
        stdout: JSON.stringify({ materials: [] }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  try {
    mkdirSync(path.join(realRootfsDir, "etc"), { recursive: true });
    writeFileSync(
      path.join(realRootfsDir, "etc", "os-release"),
      'ID="debian"\nVERSION_ID="12"\n',
    );
    symlinkSync(realRootfsDir, rootfsLink);
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.0",
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    process.env.TRUSTINSPECTOR_CMD = "/tmp/trustinspector";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables: sinon.stub().returns([]),
        collectSharedLibs: sinon.stub().returns([]),
        extractPathEnv: sinon.stub().returns([]),
        safeExistsSync: sinon
          .stub()
          .callsFake((targetPath) => existsSync(targetPath)),
        safeSpawnSync,
      },
    });
    await getOSPackages(rootfsLink, { Env: [] });
    assert.ok(
      safeSpawnSync.calledWith(
        "/tmp/trustinspector",
        sinon.match(
          (args) => args?.[0] === "rootfs" && args?.[1] === rootfsLink,
        ),
      ),
    );
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    if (previousTrustInspectorCmd === undefined) {
      delete process.env.TRUSTINSPECTOR_CMD;
    } else {
      process.env.TRUSTINSPECTOR_CMD = previousTrustInspectorCmd;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
    rmSync(realRootfsDir, { recursive: true, force: true });
  }
});

it("getPluginToolComponents() reads precise tool metadata from the plugins manifest", async () => {
  const pluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-plugins-manifest-"),
  );
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  try {
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.0",
              purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
              "bom-ref":
                "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
              hashes: [{ alg: "SHA-256", content: "a".repeat(64) }],
            },
          },
        ],
      }),
    );
    const tools = loadPluginToolsInSubprocess(pluginsDir);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "trustinspector");
    assert.strictEqual(tools[0].version, "2.1.0");
    assert.match(tools[0].purl, /trustinspector-cdxgen/);
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

it("getPluginToolComponents() sanitizes manifest tool metadata before use", async () => {
  const pluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-plugins-manifest-sanitize-"),
  );
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  try {
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              name: "trustinspector",
              version: "2.1.0",
              purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
              "bom-ref":
                "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
              properties: [
                { name: "cdx:tool:origin", value: "plugins-manifest" },
                { name: "", value: "ignored" },
                { name: 1, value: "ignored" },
              ],
              externalReferences: [
                { type: "vcs", url: "https://example.com/trustinspector" },
                { type: "distribution", url: "" },
              ],
              hashes: [
                { alg: "SHA-256", content: "a".repeat(64) },
                { alg: "", content: "ignored" },
              ],
              nested: { should: "not-survive" },
            },
          },
        ],
      }),
    );
    const tools = loadPluginToolsInSubprocess(pluginsDir);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "trustinspector");
    assert.strictEqual(tools[0].nested, undefined);
    assert.strictEqual({}.polluted, undefined);
    assert.deepStrictEqual(tools[0].properties, [
      { name: "cdx:tool:origin", value: "plugins-manifest" },
    ]);
    assert.deepStrictEqual(tools[0].externalReferences, [
      { type: "vcs", url: "https://example.com/trustinspector" },
    ]);
    assert.deepStrictEqual(tools[0].hashes, [
      { alg: "SHA-256", content: "a".repeat(64) },
    ]);
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

it("getPluginToolComponents() ignores oversized plugins manifests", async () => {
  const pluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-plugins-manifest-large-"),
  );
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  try {
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      `${JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              name: "trustinspector",
              "bom-ref": "pkg:generic/trustinspector@2.1.0",
            },
          },
        ],
      })}${" ".repeat(1024 * 1024)}`,
    );
    assert.deepStrictEqual(loadPluginToolsInSubprocess(pluginsDir), []);
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

it("getOSPackages() returns empty collections and reports a blocked dry-run activity", async () => {
  const recordActivity = sinon.stub();
  const { getOSPackages } = await loadBinaryModule({
    utilsOverrides: {
      isDryRun: true,
      recordActivity,
    },
  });
  const result = await getOSPackages("/tmp/rootfs", {});
  assert.deepStrictEqual(result.osPackages, []);
  assert.deepStrictEqual(result.dependenciesList, []);
  assert.deepStrictEqual(result.binPaths, []);
  assert.deepStrictEqual(Array.from(result.allTypes), []);
  assert.deepStrictEqual(result.tools, []);
  sinon.assert.calledWithMatch(recordActivity, {
    kind: "container",
    status: "blocked",
    target: "/tmp/rootfs",
  });
});

it("getOSPackages() records the rpm type and distro for rewritten bottlerocket purls", async () => {
  // The bottlerocket rewrite used to hand back a non-empty group, which
  // skipped getOSPackages' os-release block: allTypes (the
  // oci:image:componentTypes property) came out as ["bottlerocket"], or
  // empty when no package carried an epoch, instead of the rpm type and the
  // distro every other rpm distro reports.
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-"));
  const trivyTempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-trivy-"));
  const bomJsonFile = path.join(trivyTempDir, "trivy-bom.json");
  const purl =
    "pkg:bottlerocket/glibc@2.40-1.1749612015.1e5b9b3a.br1?arch=x86_64&distro=bottlerocket-1.34.0";
  try {
    mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    writeFileSync(
      path.join(rootfs, "etc", "os-release"),
      "ID=bottlerocket\nVERSION_ID=1.34.0\n",
    );
    writeFileSync(
      bomJsonFile,
      JSON.stringify({
        metadata: { tools: [] },
        components: [
          { "bom-ref": decodeURIComponent(purl), name: "glibc", purl },
        ],
        dependencies: [],
      }),
    );
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon
          .stub()
          .returns({ status: 0, stdout: "", stderr: "" }),
      },
    });
    const result = await getOSPackages(rootfs, { Env: [] });
    assert.strictEqual(result.osPackages.length, 1);
    const pkg = result.osPackages[0];
    assert.ok(pkg.purl.startsWith("pkg:rpm/bottlerocket/glibc@"), pkg.purl);
    assert.strictEqual(pkg.group, "bottlerocket");
    const types = Array.from(result.allTypes);
    assert.ok(types.includes("rpm"), types.join(","));
    assert.ok(types.includes("bottlerocket-1.34.0"), types.join(","));
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
    delete process.env.TRIVY_CMD;
  }
});

it("getOSPackages() creates package-owned file components and services from Trivy properties", async () => {
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-"));
  const trivyTempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-trivy-"));
  const bomJsonFile = path.join(trivyTempDir, "trivy-bom.json");
  const packagePurl = "pkg:apk/alpine/demo@1.0-r0?distro=alpine-3.20";
  const packageRef = decodeURIComponent(packagePurl);
  const collectExecutables = sinon.stub().returns([]);
  const collectSharedLibs = sinon.stub().returns([]);
  try {
    mkdirSync(path.join(rootfs, "usr", "bin"), { recursive: true });
    mkdirSync(path.join(rootfs, "usr", "lib"), { recursive: true });
    mkdirSync(path.join(rootfs, "etc", "init.d"), { recursive: true });
    mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    writeFileSync(path.join(rootfs, "usr", "bin", "demo"), "#!/bin/sh\n", {
      mode: 0o644,
    });
    writeFileSync(path.join(rootfs, "usr", "lib", "libdemo.so.1"), "binary", {
      mode: 0o644,
    });
    writeFileSync(
      path.join(rootfs, "etc", "init.d", "demosvc"),
      [
        "#!/bin/sh",
        "### BEGIN INIT INFO",
        "# Provides: demosvc",
        "# Short-Description: Demo service",
        "### END INIT INFO",
        "/usr/bin/demo start",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(rootfs, "etc", "os-release"),
      "ID=alpine\nVERSION_ID=3.20.0\n",
    );
    writeFileSync(
      bomJsonFile,
      JSON.stringify({
        metadata: { tools: [] },
        components: [
          {
            "bom-ref": packageRef,
            name: "demo",
            purl: packagePurl,
            properties: [
              { name: "aquasecurity:trivy:PkgID", value: "demo@1.0-r0" },
              { name: "aquasecurity:trivy:PkgType", value: "apk" },
              { name: "aquasecurity:trivy:Capability", value: "cmd:demo" },
              {
                name: "aquasecurity:trivy:CapabilityCount",
                value: "1",
              },
              {
                name: "aquasecurity:trivy:InstalledCommand",
                value: "demo",
              },
              {
                name: "aquasecurity:trivy:InstalledCommandCount",
                value: "1",
              },
              {
                name: "aquasecurity:trivy:InstalledCommandPath",
                value: "/usr/bin/demo",
              },
              {
                name: "aquasecurity:trivy:InstalledFileCount",
                value: "3",
              },
              {
                name: "aquasecurity:trivy:InstalledFile",
                value: "/usr/bin/demo",
              },
              {
                name: "aquasecurity:trivy:InstalledFile",
                value: "/usr/lib/libdemo.so.1",
              },
              {
                name: "aquasecurity:trivy:InstalledFile",
                value: "/etc/init.d/demosvc",
              },
              {
                name: "aquasecurity:trivy:PackageVendor",
                value: "Demo Vendor",
              },
            ],
            supplier: { name: "Demo Maintainers <demo@example.test>" },
          },
        ],
        dependencies: [],
      }),
    );
    const originalTrivyCmd = process.env.TRIVY_CMD;
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables,
        collectSharedLibs,
        extractPathEnv: sinon.stub().returns(["/usr/bin"]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        multiChecksumFile: sinon.stub().resolves({
          md5: "a".repeat(32),
          sha1: "b".repeat(40),
        }),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon.stub().callsFake((command) => {
          if (command === "ldd") {
            return { status: 1, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }),
      },
    });
    const result = await getOSPackages(rootfs, { Env: ["PATH=/usr/bin"] });
    process.env.TRIVY_CMD = originalTrivyCmd;

    assert.strictEqual(result.osPackages.length, 1);
    assert.strictEqual(result.osPackageFiles.length, 3);
    assert.strictEqual(result.services.length, 1);
    assert.strictEqual(result.services[0].name, "demosvc");
    assert.ok(
      result.osPackages[0].properties.some(
        (prop) => prop.name.endsWith("Capability") && prop.value === "cmd:demo",
      ),
    );
    assert.deepStrictEqual(result.osPackages[0].supplier, {
      name: "Demo Maintainers <demo@example.test>",
    });
    assert.deepStrictEqual(result.osPackages[0].manufacturer, {
      name: "Demo Vendor",
    });
    assert.deepStrictEqual(result.osPackages[0].authors, [
      { name: "Demo Maintainers", email: "demo@example.test" },
    ]);
    assert.ok(
      !(result.osPackages[0].properties || []).some((prop) =>
        prop.name.endsWith("PackageVendor"),
      ),
    );
    assert.ok(
      result.osPackageFiles.some(
        (component) =>
          component.properties.some(
            (prop) =>
              prop.name === "internal:SrcFile" &&
              prop.value === "/usr/bin/demo",
          ) &&
          component.properties.some(
            (prop) =>
              prop.name === "internal:is_executable" && prop.value === "true",
          ),
      ),
    );
    assert.ok(
      result.dependenciesList.some(
        (dependency) =>
          Array.isArray(dependency.provides) && dependency.provides.length >= 3,
      ),
    );
    assert.ok(
      result.dependenciesList.some(
        (dependency) =>
          dependency.ref === result.services[0]["bom-ref"] &&
          Array.isArray(dependency.dependsOn) &&
          dependency.dependsOn.length > 0,
      ),
    );
    sinon.assert.calledWithMatch(
      collectExecutables,
      rootfs,
      ["/usr/bin"],
      ["/etc/init.d/demosvc", "/usr/bin/demo", "/usr/lib/libdemo.so.1"],
    );
    sinon.assert.calledWithMatch(
      collectSharedLibs,
      rootfs,
      sinon.match.array,
      "/etc/ld.so.conf",
      "/etc/ld.so.conf.d/*.conf",
      ["/etc/init.d/demosvc", "/usr/bin/demo", "/usr/lib/libdemo.so.1"],
    );
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
    delete process.env.TRIVY_CMD;
  }
});

it("getOSPackages() omits setuid metadata from package-owned file components", async () => {
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-setuid-"));
  const trivyTempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-trivy-setuid-"));
  const bomJsonFile = path.join(trivyTempDir, "trivy-bom.json");
  const packagePurl = "pkg:apk/alpine/demo@1.0-r0?distro=alpine-3.20";
  const packageRef = decodeURIComponent(packagePurl);
  const originalTrivyCmd = process.env.TRIVY_CMD;
  try {
    mkdirSync(path.join(rootfs, "usr", "bin"), { recursive: true });
    mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    writeFileSync(path.join(rootfs, "usr", "bin", "demo"), "#!/bin/sh\n", {
      mode: 0o4755,
    });
    writeFileSync(
      path.join(rootfs, "etc", "os-release"),
      "ID=alpine\nVERSION_ID=3.20.0\n",
    );
    writeFileSync(
      bomJsonFile,
      JSON.stringify({
        metadata: { tools: [] },
        components: [
          {
            "bom-ref": packageRef,
            name: "demo",
            purl: packagePurl,
            properties: [
              { name: "aquasecurity:trivy:PkgID", value: "demo@1.0-r0" },
              { name: "aquasecurity:trivy:PkgType", value: "apk" },
              {
                name: "aquasecurity:trivy:InstalledFile",
                value: "/usr/bin/demo",
              },
              {
                name: "aquasecurity:trivy:InstalledCommandPath",
                value: "/usr/bin/demo",
              },
            ],
          },
        ],
        dependencies: [],
      }),
    );
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables: sinon.stub().returns([]),
        collectSharedLibs: sinon.stub().returns([]),
        extractPathEnv: sinon.stub().returns(["/usr/bin"]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        multiChecksumFile: sinon.stub().resolves({
          md5: "a".repeat(32),
          sha1: "b".repeat(40),
        }),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon.stub().callsFake((command) => {
          if (command === "ldd") {
            return { status: 1, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }),
      },
    });
    const result = await getOSPackages(rootfs, { Env: ["PATH=/usr/bin"] });
    process.env.TRIVY_CMD = originalTrivyCmd;

    const fileComponent = result.osPackageFiles.find((component) =>
      component.properties.some(
        (prop) =>
          prop.name === "internal:SrcFile" && prop.value === "/usr/bin/demo",
      ),
    );
    assert.ok(fileComponent);
    assert.ok(
      !fileComponent.properties.some(
        (prop) => prop.name === "internal:has_setuid",
      ),
    );
  } finally {
    if (originalTrivyCmd === undefined) {
      delete process.env.TRIVY_CMD;
    } else {
      process.env.TRIVY_CMD = originalTrivyCmd;
    }
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
  }
});

it("getOSPackages() preserves conflicting native origin fields and retains fallback trust properties", async () => {
  const rootfs = mkdtempSync(
    path.join(tmpdir(), "cdxgen-rootfs-native-conflict-"),
  );
  const trivyTempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-trivy-native-conflict-"),
  );
  const bomJsonFile = path.join(trivyTempDir, "trivy-bom.json");
  const packagePurl = "pkg:apk/alpine/demo@1.0-r0?distro=alpine-3.20";
  const packageRef = decodeURIComponent(packagePurl);
  try {
    mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    writeFileSync(
      path.join(rootfs, "etc", "os-release"),
      "ID=alpine\nVERSION_ID=3.20.0\n",
      { encoding: "utf-8" },
    );
    writeFileSync(
      bomJsonFile,
      JSON.stringify({
        metadata: { tools: [] },
        components: [
          {
            "bom-ref": packageRef,
            name: "demo",
            purl: packagePurl,
            supplier: { name: "Existing Supplier" },
            manufacturer: { name: "Existing Manufacturer" },
            authors: [
              { name: "Existing Author", email: "author@example.test" },
            ],
            properties: [
              { name: "aquasecurity:trivy:PkgID", value: "demo@1.0-r0" },
              { name: "aquasecurity:trivy:PkgType", value: "apk" },
              {
                name: "aquasecurity:trivy:PackageMaintainer",
                value: "Demo Maintainers <demo@example.test>",
              },
              {
                name: "aquasecurity:trivy:PackageVendor",
                value: "Demo Vendor",
              },
            ],
          },
        ],
        dependencies: [],
      }),
    );
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        extractPathEnv: sinon.stub().returns([]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon.stub().callsFake((command) => {
          if (command === "ldd") {
            return { status: 1, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }),
      },
    });

    const result = await getOSPackages(rootfs, {});
    assert.strictEqual(result.osPackages.length, 1);
    assert.deepStrictEqual(result.osPackages[0].supplier, {
      name: "Existing Supplier",
    });
    assert.deepStrictEqual(result.osPackages[0].manufacturer, {
      name: "Existing Manufacturer",
    });
    assert.deepStrictEqual(result.osPackages[0].authors, [
      { name: "Existing Author", email: "author@example.test" },
    ]);
    assert.ok(
      (result.osPackages[0].properties || []).some(
        (prop) =>
          prop.name.endsWith("PackageMaintainer") &&
          prop.value === "Demo Maintainers <demo@example.test>",
      ),
    );
    assert.ok(
      (result.osPackages[0].properties || []).some(
        (prop) =>
          prop.name.endsWith("PackageVendor") && prop.value === "Demo Vendor",
      ),
    );
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
    delete process.env.TRIVY_CMD;
  }
});

it("getOSPackages() keeps the vendor and release channel of apk-tools 3.x packages", async () => {
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-alpaquita-"));
  const trivyTempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-trivy-alpaquita-"),
  );
  const bomJsonFile = path.join(trivyTempDir, "trivy-bom.json");
  // Recorded trivy-cdxgen output for an Alpaquita Linux rootfs, whose apk-tools
  // 3.x database lives at var/lib/apk/db/installed.
  const trivyBom = JSON.parse(
    readFileSync(testDataPath("bom-alpaquita-trivy.json"), "utf-8"),
  );
  const packagePurl =
    "pkg:apk/alpaquita/apk-tools@3.0.7-r1?arch=aarch64&distro=alpaquita-stream";
  try {
    mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    mkdirSync(path.join(rootfs, "var", "lib", "apk", "db"), {
      recursive: true,
    });
    writeFileSync(
      path.join(rootfs, "etc", "os-release"),
      "ID=alpaquita\nID_LIKE=alpine\nVERSION_ID=stream\n",
      { encoding: "utf-8" },
    );
    writeFileSync(path.join(rootfs, "etc", "alpaquita-release"), "stream\n");
    writeFileSync(
      path.join(rootfs, "var", "lib", "apk", "db", "installed"),
      readFileSync(testDataPath("alpaquita-installed"), "utf-8"),
    );
    writeFileSync(bomJsonFile, JSON.stringify(trivyBom));
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        extractPathEnv: sinon.stub().returns([]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon
          .stub()
          .returns({ status: 0, stdout: "", stderr: "" }),
      },
    });

    const result = await getOSPackages(rootfs, {});
    const apkTools = result.osPackages.find((pkg) => pkg.name === "apk-tools");
    assert.strictEqual(apkTools.purl, packagePurl);
    assert.strictEqual(apkTools.group, "alpaquita");
    assert.ok(Array.from(result.allTypes).includes("apk"));
    // Every apk-tools 3.x package keeps the alpaquita vendor and the release
    // channel it was installed from — stream is rolling while 23 and 25 are
    // LTS, each with its own apk repository and package versions. Alpaquita has
    // no VERSION_CODENAME, so no distro_name is stamped, and the musl/glibc
    // variant travels as a property rather than in the channel qualifier.
    for (const pkg of result.osPackages.filter((pkg) =>
      pkg.purl?.startsWith("pkg:apk/"),
    )) {
      assert.ok(pkg.purl.startsWith("pkg:apk/alpaquita/"));
      assert.ok(pkg.purl.includes("distro=alpaquita-stream"));
      assert.ok(!pkg.purl.includes("distro_name"));
      const qualifiers = Purl.parse(pkg.purl).qualifiers || {};
      assert.strictEqual(qualifiers.distro, "alpaquita-stream");
      assert.deepStrictEqual(Object.keys(qualifiers).sort(), [
        "arch",
        "distro",
      ]);
    }
    assert.ok(
      apkTools.properties.some(
        (prop) => prop.name.endsWith("PackageLibc") && prop.value === "musl",
      ),
    );
    // The dependency edges trivy derived from the apk provides graph survive.
    const apkToolsDeps = result.dependenciesList.find(
      (dep) => dep.ref === packagePurl,
    );
    assert.deepStrictEqual(apkToolsDeps.dependsOn, [
      "pkg:apk/alpaquita/libapk@3.0.7-r1?arch=aarch64&distro=alpaquita-stream",
      "pkg:apk/alpaquita/musl-perf@1.2.6-r2?arch=aarch64&distro=alpaquita-stream",
    ]);
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
    delete process.env.TRIVY_CMD;
  }
});

it("getOSPackages() inventories rootfs repository sources and trusted keys without Trivy package data", async () => {
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-repos-"));
  const pluginsDir = mkdtempSync(path.join(tmpdir(), "cdxgen-plugins-rootfs-"));
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  const previousTrustInspectorCmd = process.env.TRUSTINSPECTOR_CMD;
  try {
    mkdirSync(path.join(rootfs, "etc", "apt", "sources.list.d"), {
      recursive: true,
    });
    mkdirSync(path.join(rootfs, "usr", "share", "keyrings"), {
      recursive: true,
    });
    mkdirSync(path.join(rootfs, "etc", "yum.repos.d"), { recursive: true });
    mkdirSync(path.join(rootfs, "etc", "pki", "rpm-gpg"), {
      recursive: true,
    });
    writeFileSync(
      path.join(rootfs, "etc", "apt", "sources.list.d", "ondrej-php.list"),
      "deb [signed-by=/usr/share/keyrings/ondrej-php.gpg] https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble main\n",
    );
    writeFileSync(
      path.join(rootfs, "usr", "share", "keyrings", "ondrej-php.gpg"),
      "fake-apt-key",
    );
    writeFileSync(
      path.join(rootfs, "etc", "yum.repos.d", "custom.repo"),
      [
        "[custom]",
        "name=Custom Repo",
        "baseurl=https://packages.example.test/rpm/$basearch",
        "enabled=1",
        "gpgcheck=1",
        "gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-test",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(rootfs, "etc", "pki", "rpm-gpg", "RPM-GPG-KEY-test"),
      "fake-rpm-key",
    );
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.0",
              purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
              "bom-ref":
                "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    process.env.TRUSTINSPECTOR_CMD = "/tmp/trustinspector";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables: sinon.stub().returns([]),
        collectSharedLibs: sinon.stub().returns([]),
        extractPathEnv: sinon.stub().returns([]),
        multiChecksumFile: sinon
          .stub()
          .callsFake(async (_algorithms, filePath) => ({
            sha1: filePath.includes("ondrej") ? "1".repeat(40) : "2".repeat(40),
            sha256: filePath.includes("ondrej")
              ? "a".repeat(64)
              : "b".repeat(64),
          })),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeSpawnSync: sinon.stub().callsFake((command, args) => {
          if (command === "ldd") {
            return { status: 1, stdout: "", stderr: "" };
          }
          if (command === "/tmp/trustinspector" && args[0] === "rootfs") {
            return {
              status: 0,
              stdout: JSON.stringify({
                materials: [
                  {
                    kind: "public-key",
                    path: "/usr/share/keyrings/ondrej-php.gpg",
                    name: "ondrej-php.gpg",
                    trustDomain: "apt",
                    sourceType: "repository-keyring",
                    fileExtension: "gpg",
                    sha1: "1".repeat(40),
                    sha256: "a".repeat(64),
                    keyId: "ABCDEF1234567890",
                    algorithm: "RSA",
                    keyStrength: 4096,
                    fingerprint: "F".repeat(40),
                    userIds: ["Ondrej Surý <ondrej@example.test>"],
                    properties: [
                      {
                        name: "cdx:crypto:sourceType",
                        value: "repository-keyring",
                      },
                    ],
                  },
                  {
                    kind: "certificate",
                    path: "/etc/ssl/certs/demo-root.crt",
                    name: "demo-root",
                    trustDomain: "ca-store",
                    sourceType: "ca-store",
                    fileExtension: "crt",
                    sha1: "3".repeat(40),
                    sha256: "c".repeat(64),
                    algorithm: "RSA",
                    keyStrength: 2048,
                    createdAt: "2024-01-01T00:00:00Z",
                    expiresAt: "2034-01-01T00:00:00Z",
                    fingerprint: "D".repeat(64),
                    subject: "CN=demo-root,O=Example Org",
                    issuer: "CN=demo-root,O=Example Org",
                    serial: "42",
                    format: "X.509",
                    properties: [{ name: "cdx:crypto:isCA", value: "true" }],
                  },
                ],
              }),
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        }),
      },
    });
    const result = await getOSPackages(rootfs, { Env: [] });

    const cryptoComponents = result.osPackages.filter(
      (component) => component.type === "cryptographic-asset",
    );
    const ppaComponent = result.osPackages.find(
      (component) =>
        component.type === "data" &&
        component.properties?.some(
          (property) =>
            property.name === "cdx:os:repo:type" &&
            property.value === "ppa-source",
        ),
    );
    const yumComponent = result.osPackages.find(
      (component) =>
        component.type === "data" &&
        component.properties?.some(
          (property) =>
            property.name === "cdx:os:repo:type" &&
            property.value === "yum-source",
        ),
    );
    const ppaKeyRef = cryptoComponents.find((component) =>
      component.properties?.some(
        (property) =>
          property.name === "internal:SrcFile" &&
          property.value === "/usr/share/keyrings/ondrej-php.gpg",
      ),
    )?.["bom-ref"];
    const yumKeyRef = cryptoComponents.find((component) =>
      component.properties?.some(
        (property) =>
          property.name === "internal:SrcFile" &&
          property.value === "/etc/pki/rpm-gpg/RPM-GPG-KEY-test",
      ),
    )?.["bom-ref"];

    assert.strictEqual(cryptoComponents.length, 3);
    assert.ok(
      cryptoComponents.some(
        (component) =>
          component.cryptoProperties?.assetType === "related-crypto-material" &&
          component.cryptoProperties?.relatedCryptoMaterialProperties?.type ===
            "public-key",
      ),
    );
    assert.ok(
      cryptoComponents.some(
        (component) =>
          component.cryptoProperties?.assetType === "certificate" &&
          component.properties?.some(
            (property) =>
              property.name === "cdx:crypto:trustDomain" &&
              property.value === "ca-store",
          ),
      ),
    );
    assert.ok(
      cryptoComponents.some((component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:crypto:keyId" &&
            property.value === "ABCDEF1234567890",
        ),
      ),
    );
    assert.ok(ppaComponent);
    assert.ok(yumComponent);
    assert.ok(ppaKeyRef);
    assert.ok(yumKeyRef);
    assert.ok(
      result.dependenciesList.some(
        (dependency) =>
          dependency.ref === ppaComponent["bom-ref"] &&
          Array.isArray(dependency.dependsOn) &&
          dependency.dependsOn.includes(ppaKeyRef),
      ),
    );
    assert.ok(
      result.dependenciesList.some(
        (dependency) =>
          dependency.ref === yumComponent["bom-ref"] &&
          Array.isArray(dependency.dependsOn) &&
          dependency.dependsOn.includes(yumKeyRef),
      ),
    );
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    if (previousTrustInspectorCmd === undefined) {
      delete process.env.TRUSTINSPECTOR_CMD;
    } else {
      process.env.TRUSTINSPECTOR_CMD = previousTrustInspectorCmd;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
    rmSync(rootfs, { recursive: true, force: true });
  }
});

it("enrichOSComponentsWithTrustData() merges path inspections and host findings", async () => {
  if (!["darwin", "win32"].includes(process.platform)) {
    return;
  }
  const pluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-plugins-hosttrust-"),
  );
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  const previousTrustInspectorCmd = process.env.TRUSTINSPECTOR_CMD;
  const inspectedPath =
    process.platform === "win32"
      ? "C:\\Demo\\demo.exe"
      : "/Applications/Demo.app";
  const expectedProperty =
    process.platform === "win32"
      ? { name: "cdx:windows:authenticode:status", value: "Valid" }
      : { name: "cdx:darwin:codesign:teamIdentifier", value: "ABCDE12345" };
  const hostFinding =
    process.platform === "win32"
      ? {
          kind: "windows-wdac-status",
          name: "wdac-active-policies",
          version: "1",
          description: "active policies",
          properties: [
            {
              name: "cdx:windows:wdac:activePolicyCount",
              value: "1",
            },
          ],
        }
      : {
          kind: "darwin-gatekeeper-status",
          name: "gatekeeper-system-policy",
          version: "enabled",
          description: "assessments enabled",
          properties: [
            {
              name: "cdx:darwin:gatekeeper:status",
              value: "enabled",
            },
          ],
        };
  try {
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.0",
              purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
              "bom-ref":
                "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    process.env.TRUSTINSPECTOR_CMD = "/tmp/trustinspector";
    const { enrichOSComponentsWithTrustData } = await loadBinaryModule({
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeSpawnSync: sinon.stub().callsFake((command, args) => {
          if (command === "ldd") {
            return { status: 1, stdout: "", stderr: "" };
          }
          if (command === "/tmp/trustinspector" && args[0] === "paths") {
            return {
              status: 0,
              stdout: JSON.stringify({
                inspections: [
                  {
                    path: inspectedPath,
                    properties: [expectedProperty],
                  },
                ],
              }),
              stderr: "",
            };
          }
          if (command === "/tmp/trustinspector" && args[0] === "host") {
            return {
              status: 0,
              stdout: JSON.stringify({ hostFindings: [hostFinding] }),
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        }),
      },
    });
    const result = enrichOSComponentsWithTrustData([
      {
        type: "application",
        name: "Demo",
        "bom-ref": "app-demo",
        properties: [{ name: "path", value: inspectedPath }],
      },
    ]);
    assert.ok(
      result.components[0].properties.some(
        (property) =>
          property.name === expectedProperty.name &&
          property.value === expectedProperty.value,
      ),
    );
    assert.ok(
      result.components.some(
        (component) =>
          component.type === "data" && component.name === hostFinding.name,
      ),
    );
    assert.strictEqual(result.tools.length, 1);
    assert.strictEqual(result.tools[0].name, "trustinspector");
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    if (previousTrustInspectorCmd === undefined) {
      delete process.env.TRUSTINSPECTOR_CMD;
    } else {
      process.env.TRUSTINSPECTOR_CMD = previousTrustInspectorCmd;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

it("enrichOSComponentsWithTrustData() skips macOS plist paths for notarization checks", async () => {
  if (process.platform !== "darwin") {
    return;
  }
  const pluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-plugins-hosttrust-plist-"),
  );
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  const previousTrustInspectorCmd = process.env.TRUSTINSPECTOR_CMD;
  const safeSpawnSync = sinon.stub().callsFake((command, args) => {
    if (command === "ldd") {
      return { status: 1, stdout: "", stderr: "" };
    }
    if (command === "/tmp/trustinspector" && args[0] === "paths") {
      assert.deepStrictEqual(args, [
        "paths",
        "/Library/PrivilegedHelperTools/demo-helper",
      ]);
      return {
        status: 0,
        stdout: JSON.stringify({
          inspections: [
            {
              path: "/Library/PrivilegedHelperTools/demo-helper",
              properties: [
                {
                  name: "cdx:darwin:notarization:assessment",
                  value: "accepted",
                },
              ],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (command === "/tmp/trustinspector" && args[0] === "host") {
      return {
        status: 0,
        stdout: JSON.stringify({ hostFindings: [] }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  try {
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.1",
              purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.1",
              "bom-ref":
                "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.1",
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    process.env.TRUSTINSPECTOR_CMD = "/tmp/trustinspector";
    const { enrichOSComponentsWithTrustData } = await loadBinaryModule({
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeSpawnSync,
      },
    });
    const result = enrichOSComponentsWithTrustData([
      {
        type: "application",
        name: "demo-helper",
        "bom-ref":
          "pkg:swid/demo-helper#/Library/LaunchDaemons/org.nixos.nix-daemon.plist",
        properties: [
          {
            name: "path",
            value: "/Library/LaunchDaemons/org.nixos.nix-daemon.plist",
          },
          {
            name: "program",
            value: "/Library/PrivilegedHelperTools/demo-helper",
          },
        ],
      },
    ]);
    assert.ok(
      result.components[0].properties.some(
        (property) =>
          property.name === "cdx:darwin:notarization:assessment" &&
          property.value === "accepted",
      ),
    );
    const trustInspectorPathCalls = safeSpawnSync
      .getCalls()
      .filter(
        (call) =>
          call.args[0] === "/tmp/trustinspector" &&
          call.args[1]?.[0] === "paths",
      );
    assert.strictEqual(trustInspectorPathCalls.length, 1);
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    if (previousTrustInspectorCmd === undefined) {
      delete process.env.TRUSTINSPECTOR_CMD;
    } else {
      process.env.TRUSTINSPECTOR_CMD = previousTrustInspectorCmd;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

it("enrichOSComponentsWithTrustData() skips generic macOS app inventory paths", async () => {
  if (process.platform !== "darwin") {
    return;
  }
  const pluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-plugins-hosttrust-apps-"),
  );
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  const previousTrustInspectorCmd = process.env.TRUSTINSPECTOR_CMD;
  const safeSpawnSync = sinon.stub().callsFake((command, args) => {
    if (command === "ldd") {
      return { status: 1, stdout: "", stderr: "" };
    }
    if (command === "/tmp/trustinspector" && args[0] === "paths") {
      assert.deepStrictEqual(args, ["paths", "/Applications/Live.app"]);
      return {
        status: 0,
        stdout: JSON.stringify({
          inspections: [
            {
              path: "/Applications/Live.app",
              properties: [
                {
                  name: "cdx:darwin:notarization:assessment",
                  value: "accepted",
                },
              ],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (command === "/tmp/trustinspector" && args[0] === "host") {
      return {
        status: 0,
        stdout: JSON.stringify({ hostFindings: [] }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  try {
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.1",
              purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.1",
              "bom-ref":
                "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.1",
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    process.env.TRUSTINSPECTOR_CMD = "/tmp/trustinspector";
    const { enrichOSComponentsWithTrustData } = await loadBinaryModule({
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeSpawnSync,
      },
    });
    const result = enrichOSComponentsWithTrustData([
      {
        type: "application",
        name: "Installed",
        "bom-ref": "app-installed",
        properties: [
          { name: "cdx:osquery:category", value: "apps" },
          { name: "bundle_path", value: "/Applications/Installed.app" },
        ],
      },
      {
        type: "application",
        name: "Live",
        "bom-ref": "app-live",
        properties: [
          { name: "cdx:osquery:category", value: "running_apps" },
          { name: "bundle_path", value: "/Applications/Live.app" },
        ],
      },
      {
        type: "application",
        name: "Finder",
        "bom-ref": "app-finder",
        properties: [
          { name: "cdx:osquery:category", value: "running_apps" },
          { name: "bundle_path", value: "/System/Applications/Finder.app" },
        ],
      },
    ]);
    assert.ok(
      !result.components[0].properties.some(
        (property) => property.name === "cdx:darwin:notarization:assessment",
      ),
    );
    assert.ok(
      result.components[1].properties.some(
        (property) =>
          property.name === "cdx:darwin:notarization:assessment" &&
          property.value === "accepted",
      ),
    );
    assert.ok(
      !result.components[2].properties.some(
        (property) => property.name === "cdx:darwin:notarization:assessment",
      ),
    );
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    if (previousTrustInspectorCmd === undefined) {
      delete process.env.TRUSTINSPECTOR_CMD;
    } else {
      process.env.TRUSTINSPECTOR_CMD = previousTrustInspectorCmd;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

it("enrichOSComponentsWithTrustData() batches trustinspector path requests", async () => {
  if (!["darwin", "win32"].includes(process.platform)) {
    return;
  }
  const pluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-plugins-hosttrust-batch-"),
  );
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  const previousTrustInspectorCmd = process.env.TRUSTINSPECTOR_CMD;
  const pathPrefix =
    process.platform === "win32" ? "C:\\Demo\\app" : "/Applications/App";
  const safeSpawnSync = sinon.stub().callsFake((command, args) => {
    if (command === "ldd") {
      return { status: 1, stdout: "", stderr: "" };
    }
    if (command === "/tmp/trustinspector" && args[0] === "paths") {
      return {
        status: 0,
        stdout: JSON.stringify({
          inspections: args.slice(1).map((inspectedPath) => ({
            path: inspectedPath,
            properties: [
              {
                name:
                  process.platform === "win32"
                    ? "cdx:windows:authenticode:status"
                    : "cdx:darwin:notarization:assessment",
                value: process.platform === "win32" ? "Valid" : "accepted",
              },
            ],
          })),
        }),
        stderr: "",
      };
    }
    if (command === "/tmp/trustinspector" && args[0] === "host") {
      return {
        status: 0,
        stdout: JSON.stringify({ hostFindings: [] }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  try {
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.1",
              purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.1",
              "bom-ref":
                "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.1",
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    process.env.TRUSTINSPECTOR_CMD = "/tmp/trustinspector";
    const { enrichOSComponentsWithTrustData } = await loadBinaryModule({
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeSpawnSync,
      },
    });
    const components = Array.from({ length: 205 }, (_, index) => ({
      type: "application",
      name: `App ${index}`,
      "bom-ref": `app-${index}`,
      properties: [
        {
          name: "path",
          value:
            process.platform === "win32"
              ? `${pathPrefix}${index}.exe`
              : `${pathPrefix}${index}.app`,
        },
      ],
    }));
    const result = enrichOSComponentsWithTrustData(components);
    const pathInvocations = safeSpawnSync
      .getCalls()
      .filter(
        (call) =>
          call.args[0] === "/tmp/trustinspector" &&
          call.args[1]?.[0] === "paths",
      );
    assert.strictEqual(pathInvocations.length, 2);
    assert.strictEqual(pathInvocations[0].args[1].length, 201);
    assert.strictEqual(pathInvocations[1].args[1].length, 6);
    assert.ok(
      result.components.every((component) =>
        component.properties.some(
          (property) =>
            property.name ===
            (process.platform === "win32"
              ? "cdx:windows:authenticode:status"
              : "cdx:darwin:notarization:assessment"),
        ),
      ),
    );
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    if (previousTrustInspectorCmd === undefined) {
      delete process.env.TRUSTINSPECTOR_CMD;
    } else {
      process.env.TRUSTINSPECTOR_CMD = previousTrustInspectorCmd;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

it("canonicaliseOsPackageNamespace() canonicalises azure linux spellings emitted by trivy", async () => {
  const { canonicaliseOsPackageNamespace } = await loadBinaryModule();
  const cases = [
    {
      title: "azurelinux namespace and qualifier (azure linux 3.0)",
      input:
        "pkg:rpm/azurelinux/openssl@1.10.0-1.azl3?arch=aarch64&distro=azurelinux-3.0",
      expected:
        "pkg:rpm/azure-linux/openssl@1.10.0-1.azl3?arch=aarch64&distro=azure-linux-3.0",
    },
    {
      title: "cbl-mariner namespace and qualifier (mariner 2.0)",
      input:
        "pkg:rpm/cbl-mariner/bash@5.1.8-4.cm2?arch=aarch64&distro=cbl-mariner-2.0",
      expected:
        "pkg:rpm/azure-linux/bash@5.1.8-4.cm2?arch=aarch64&distro=azure-linux-2.0",
    },
    {
      title: "mariner namespace and qualifier",
      input: "pkg:rpm/mariner/bash@5.1.8-4.cm2?arch=aarch64&distro=mariner-2.0",
      expected:
        "pkg:rpm/azure-linux/bash@5.1.8-4.cm2?arch=aarch64&distro=azure-linux-2.0",
    },
    {
      title: "qualifier spelling disagreeing with the namespace",
      input:
        "pkg:rpm/cbl-mariner/bash@5.1.8-4.cm2?arch=aarch64&distro=mariner-2.0",
      expected:
        "pkg:rpm/azure-linux/bash@5.1.8-4.cm2?arch=aarch64&distro=azure-linux-2.0",
    },
    {
      title: "already canonical namespace with a stale qualifier spelling",
      input:
        "pkg:rpm/azure-linux/bash@5.1.8-4.cm2?arch=aarch64&distro=mariner-2.0",
      expected:
        "pkg:rpm/azure-linux/bash@5.1.8-4.cm2?arch=aarch64&distro=azure-linux-2.0",
    },
    {
      title: "alma alias keeps working",
      input: "pkg:rpm/alma/bash@1.0-1.el9?distro=alma-9.8",
      expected: "pkg:rpm/almalinux/bash@1.0-1.el9?distro=almalinux-9.8",
    },
  ];
  for (const testCase of cases) {
    const comp = {
      "bom-ref": decodeURIComponent(testCase.input),
      group: "",
      name: testCase.input.split("/").pop().split("@")[0].split("?")[0],
      purl: testCase.input,
    };
    const purlObj = Purl.parse(comp.purl);
    purlObj.qualifiers = purlObj.qualifiers || {};
    const group = canonicaliseOsPackageNamespace(comp, purlObj, comp.name, "");
    assert.strictEqual(comp.purl, testCase.expected, testCase.title);
    assert.strictEqual(comp["bom-ref"], decodeURIComponent(testCase.expected));
    assert.ok(comp.group.length > 0, testCase.title);
    assert.strictEqual(group, comp.group, testCase.title);
  }
});

it("canonicaliseOsPackageNamespace() aligns the distro qualifier with the namespace vendor", async () => {
  const { canonicaliseOsPackageNamespace } = await loadBinaryModule();
  // One release, one qualifier: trivy stamps oracle-9.8/redhat-9.8 while
  // os-release stamps ol-9.8/rhel-9.8, and an image came out carrying both.
  const aligned = [
    [
      "pkg:rpm/oracle/glibc@2.34-60.0.0.el9?arch=aarch64&distro=ol-9.8",
      "pkg:rpm/oracle/glibc@2.34-60.0.0.el9?arch=aarch64&distro=oracle-9.8",
    ],
    [
      "pkg:rpm/redhat/bash@5.1.8-9.el9?arch=x86_64&distro=rhel-9.8",
      "pkg:rpm/redhat/bash@5.1.8-9.el9?arch=x86_64&distro=redhat-9.8",
    ],
    [
      "pkg:rpm/amazon/setup@2.13.7-3.amzn2023?arch=noarch&distro=amzn-2023",
      "pkg:rpm/amazon/setup@2.13.7-3.amzn2023?arch=noarch&distro=amazon-2023",
    ],
  ];
  for (const [input, expected] of aligned) {
    const comp = {
      "bom-ref": decodeURIComponent(input),
      group: "",
      name: input.split("/").pop().split("@")[0].split("?")[0],
      purl: input,
    };
    const purlObj = Purl.parse(input);
    purlObj.qualifiers = purlObj.qualifiers || {};
    canonicaliseOsPackageNamespace(comp, purlObj, comp.name, "");
    assert.strictEqual(comp.purl, expected);
    assert.strictEqual(comp["bom-ref"], decodeURIComponent(expected));
  }
});

it("canonicaliseOsPackageNamespace() rewrites trivy's non-spec bottlerocket purl type", async () => {
  const { canonicaliseOsPackageNamespace } = await loadBinaryModule();
  // trivy's own purl test (pkg/purl/purl_test.go, "bottlerocket package")
  // emits this exact shape for a Bottlerocket host: an invented
  // `bottlerocket` purl type with arch/epoch/distro qualifiers. The purl
  // spec has no such type, so the rewrite produces the form cdxgen's
  // os-release path already uses for Bottlerocket hosts — type rpm,
  // namespace bottlerocket — keeping every qualifier (the distro value is
  // trivy's bottlerocket-<VERSION_ID>).
  const input =
    "pkg:bottlerocket/glibc@2.40?arch=x86_64&epoch=1&distro=bottlerocket-1.34.0";
  const expected =
    "pkg:rpm/bottlerocket/glibc@2.40?arch=x86_64&distro=bottlerocket-1.34.0&epoch=1";
  const comp = {
    "bom-ref": decodeURIComponent(input),
    group: "",
    name: "glibc",
    purl: input,
  };
  const purlObj = Purl.parse(input);
  purlObj.qualifiers = purlObj.qualifiers || {};
  const group = canonicaliseOsPackageNamespace(comp, purlObj, comp.name, "");
  assert.strictEqual(comp.purl, expected);
  assert.strictEqual(comp["bom-ref"], decodeURIComponent(expected));
  // The caller's group comes back unchanged, as for any rpm distro without
  // an alias, so getOSPackages runs its os-release block (allTypes).
  assert.strictEqual(group, "");
  assert.strictEqual(comp.group, "bottlerocket");
  const reparsed = Purl.parse(comp.purl);
  assert.strictEqual(reparsed.type, "rpm");
  assert.strictEqual(reparsed.namespace, "bottlerocket");
  assert.strictEqual(reparsed.name, "glibc");
  // A version-release bound from a real advisory survives the rewrite too
  // (BRSA-01e8lgtafne6: kernel-6.12 6.12.46-1.1759181406.38bb0b03.br1).
  const realInput =
    "pkg:bottlerocket/kernel-6.12@6.12.46-1.1759181406.38bb0b03.br1?arch=x86_64&distro=bottlerocket-1.34.0";
  const realComp = {
    "bom-ref": decodeURIComponent(realInput),
    group: "",
    name: "kernel-6.12",
    purl: realInput,
  };
  const realPurlObj = Purl.parse(realInput);
  realPurlObj.qualifiers = realPurlObj.qualifiers || {};
  canonicaliseOsPackageNamespace(realComp, realPurlObj, realComp.name, "");
  assert.strictEqual(
    realComp.purl,
    "pkg:rpm/bottlerocket/kernel-6.12@6.12.46-1.1759181406.38bb0b03.br1?arch=x86_64&distro=bottlerocket-1.34.0",
  );
  // npm-style packages and unknown types stay untouched.
  const npm = "pkg:npm/lodash@4.17.21";
  const npmComp = { "bom-ref": npm, group: "", name: "lodash", purl: npm };
  const npmPurlObj = Purl.parse(npm);
  canonicaliseOsPackageNamespace(npmComp, npmPurlObj, npmComp.name, "");
  assert.strictEqual(npmComp.purl, npm);
});

it("canonicaliseOsPackageNamespace() leaves SUSE and deb spellings untouched", async () => {
  const { canonicaliseOsPackageNamespace } = await loadBinaryModule();
  // SUSE qualifiers carry the release channel consumers match on, so they are
  // deliberately outside the qualifier alias map.
  const untouched = [
    "pkg:rpm/suse/bash@4.4-150400.27.6.1?arch=aarch64&distro=sles-15.6",
    "pkg:rpm/opensuse/bash@4.4-23.1?arch=x86_64&distro=opensuse-leap-15.6",
    "pkg:rpm/opensuse/bash@5.3-1?arch=x86_64&distro=opensuse-tumbleweed-20260806",
    "pkg:deb/ubuntu/demo@1.0?distro=jammy-22.04",
  ];
  for (const purl of untouched) {
    const comp = {
      "bom-ref": decodeURIComponent(purl),
      group: "",
      name: purl.split("/").pop().split("@")[0].split("?")[0],
      purl,
    };
    const purlObj = Purl.parse(purl);
    purlObj.qualifiers = purlObj.qualifiers || {};
    const group = canonicaliseOsPackageNamespace(comp, purlObj, comp.name, "");
    assert.strictEqual(comp.purl, purl);
    assert.strictEqual(comp["bom-ref"], decodeURIComponent(purl));
    assert.strictEqual(group, "");
  }
});

it("dropRedundantSourceComponents() keeps the installed package, not its shadow", async () => {
  const { dropRedundantSourceComponents } = await loadBinaryModule();
  const installedPurl =
    "pkg:rpm/azure-linux/expat@2.6.4-4.cm2?arch=aarch64&distro=azure-linux-2.0";
  const shadowFirst = {
    "bom-ref": decodeURIComponent(installedPurl),
    name: "expat",
    version: "2.6.4-4.cm2",
    purl: installedPurl,
    tags: ["source"],
    evidence: { identity: [{ field: "purl", confidence: 0 }] },
  };
  const installed = {
    "bom-ref": decodeURIComponent(installedPurl),
    name: "expat",
    version: "2.6.4-4.cm2",
    purl: installedPurl,
    tags: ["xml"],
    properties: [{ name: "aquasecurity:trivy:InstalledCommand", value: "x" }],
  };
  // A shadow for a source package that is NOT installed must survive.
  const survivingShadow = {
    "bom-ref": "pkg:rpm/azure-linux/nghttp2@1.46.0-2.cm2?arch=aarch64",
    name: "nghttp2",
    version: "1.46.0-2.cm2",
    purl: "pkg:rpm/azure-linux/nghttp2@1.46.0-2.cm2?arch=aarch64",
    tags: ["source"],
  };
  // Shadow listed BEFORE the installed component: trimComponents() would keep
  // the shadow and report an installed package with confidence 0.
  const pkgList = [shadowFirst, installed, survivingShadow];
  dropRedundantSourceComponents(pkgList);
  assert.strictEqual(pkgList.length, 2);
  assert.deepStrictEqual(pkgList[0].tags, ["xml"]);
  assert.ok(pkgList[0].properties?.length);
  assert.strictEqual(pkgList[1].name, "nghttp2");
  // Order-independent: same outcome when the shadow is listed after.
  const reordered = [installed, shadowFirst, survivingShadow];
  dropRedundantSourceComponents(reordered);
  assert.strictEqual(reordered.length, 2);
  assert.deepStrictEqual(reordered[0].tags, ["xml"]);
  // No list, empty list and shadow-only lists are left alone.
  assert.strictEqual(dropRedundantSourceComponents(undefined), undefined);
  const shadowsOnly = [shadowFirst];
  dropRedundantSourceComponents(shadowsOnly);
  assert.strictEqual(shadowsOnly.length, 1);
});

it("repairOsComponentPurl() replaces a distro qualifier that breaks purl parsing", async () => {
  const { repairOsComponentPurl } = await loadBinaryModule();
  // trivy's Amazon Linux qualifier: spaces and parens that Purl.parse rejects,
  // which today discards the entire SBOM at schema validation.
  const broken =
    "pkg:rpm/amazon/setup@2.13.7-3.amzn2023.0.2?arch=noarch&distro=amazon-2023.12.20260727+%28Amazon+Linux%29";
  const comp = { "bom-ref": broken, name: "setup", purl: broken };
  repairOsComponentPurl(comp, "amazon-2023");
  assert.strictEqual(
    comp.purl,
    "pkg:rpm/amazon/setup@2.13.7-3.amzn2023.0.2?arch=noarch&distro=amazon-2023",
  );
  assert.strictEqual(comp["bom-ref"], decodeURIComponent(comp.purl));
  assert.doesNotThrow(() => Purl.parse(comp.purl));

  // With no usable replacement the qualifier is dropped rather than left
  // invalid — one lost hint beats one lost document.
  const orphan = { "bom-ref": broken, name: "setup", purl: broken };
  repairOsComponentPurl(orphan, undefined);
  assert.strictEqual(
    orphan.purl,
    "pkg:rpm/amazon/setup@2.13.7-3.amzn2023.0.2?arch=noarch",
  );
  assert.doesNotThrow(() => Purl.parse(orphan.purl));

  // Clean qualifiers, encoded-but-clean values and purls without one are
  // left exactly as they are.
  for (const purl of [
    "pkg:rpm/oracle/glibc@2.34?arch=aarch64&distro=oracle-9.8",
    "pkg:rpm/suse/bash@4.4?distro=sles-15.6",
    "pkg:npm/lodash@4.17.21",
  ]) {
    const untouched = { "bom-ref": purl, name: "x", purl };
    repairOsComponentPurl(untouched, "amazon-2023");
    assert.strictEqual(untouched.purl, purl);
  }
});

it("retrieveDependencies keeps trivy edges whose refs leave + unescaped", async () => {
  const { retrieveDependencies } = await loadBinaryModule();
  const comp = {
    name: "libstdc++6",
    purl: "pkg:rpm/sles/libstdc%2B%2B6@14.2.0%2Bgit10526-150000.1.6.1?arch=x86_64&distro=sles-15.5",
    "bom-ref":
      "pkg:rpm/sles/libstdc++6@14.2.0+git10526-150000.1.6.1?arch=x86_64&distro=sles-15.5",
  };
  const trivyRef =
    "pkg:rpm/sles/libstdc%2B%2B6@14.2.0+git10526-150000.1.6.1?arch=x86_64&distro=sles-15.5";
  const deps = retrieveDependencies(
    {
      [trivyRef]: [
        "pkg:rpm/sles/glibc@2.31+git1-150000.1?arch=x86_64&distro=sles-15.5",
      ],
    },
    trivyRef,
    comp,
  );
  assert.deepStrictEqual(deps, {
    ref: comp["bom-ref"],
    dependsOn: [
      "pkg:rpm/sles/glibc@2.31+git1-150000.1?arch=x86_64&distro=sles-15.5",
    ],
  });
});

it("parseOrganizationalContact keeps only addresses the schema accepts", async () => {
  const { parseOrganizationalContact } = await loadBinaryModule();
  assert.deepStrictEqual(
    parseOrganizationalContact("Demo Maintainers <demo@example.test>"),
    { name: "Demo Maintainers", email: "demo@example.test" },
  );
  // organizationalContact.email is an idn-email; `a@b@c` and a trailing dot
  // would fail BOM validation, so only the name survives.
  assert.deepStrictEqual(parseOrganizationalContact("Ops <ops@team@example>"), {
    name: "Ops",
  });
  assert.deepStrictEqual(parseOrganizationalContact("Ops <ops@example.com.>"), {
    name: "Ops",
  });
  assert.deepStrictEqual(parseOrganizationalContact("Debian QA Group"), {
    name: "Debian QA Group",
  });
  assert.strictEqual(parseOrganizationalContact("  "), undefined);
});

it("getOSPackages() records unpackaged PHP runtimes and skips package-owned files", async () => {
  // Synthetic rootfs and trivy BOM generated here: every file below is built
  // by this test, and the markers stand in for a source-built PHP install.
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-php-rootfs-"));
  const trivyTempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-php-trivy-"));
  const bomJsonFile = path.join(trivyTempDir, "trivy-bom.json");
  const packagePurl =
    "pkg:deb/debian/php8.2-cli@8.2.29-1?arch=amd64&distro=debian-12";
  const packageRef = decodeURIComponent(packagePurl);
  const marker = (version) => `X-Powered-By: PHP/${version}\0`;
  // A Windows host names rootfs files with its own separator: /usr\local\bin.
  const sourceOf = (component) =>
    component.properties
      ?.find((prop) => prop.name === "internal:SrcFile")
      ?.value?.replaceAll("\\", "/");
  const phpProps = (component) =>
    Object.fromEntries(
      (component.properties || [])
        .filter((prop) => prop.name.startsWith("cdx:php:"))
        .map((prop) => [prop.name, prop.value]),
    );

  try {
    for (const dir of [
      "usr/local/bin",
      "usr/local/sbin",
      "usr/lib/apache2/modules",
      "usr/bin",
      "etc",
    ]) {
      mkdirSync(path.join(rootfs, dir), { recursive: true });
    }
    writeFileSync(
      path.join(rootfs, "usr/local/bin/php"),
      Buffer.from(marker("8.4.26")),
    );
    writeFileSync(
      path.join(rootfs, "usr/local/sbin/php-fpm"),
      Buffer.from(marker("8.4.26")),
    );
    writeFileSync(
      path.join(rootfs, "usr/lib/apache2/modules/libphp.so"),
      Buffer.from(marker("8.4.26")),
    );
    // A pre-release: its CPE puts the suffix in the update field.
    writeFileSync(
      path.join(rootfs, "usr/local/bin/php8.6"),
      Buffer.from(marker("8.6.0RC3")),
    );
    // A non-PHP executable and a package-owned PHP that must not be probed.
    writeFileSync(path.join(rootfs, "usr/local/bin/tool"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    writeFileSync(
      path.join(rootfs, "usr/bin/php8.2"),
      Buffer.from(marker("8.2.29")),
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(rootfs, "etc/os-release"),
      "ID=debian\nVERSION_ID=12\nVERSION_CODENAME=bookworm\n",
    );
    writeFileSync(
      bomJsonFile,
      JSON.stringify({
        metadata: { tools: [] },
        components: [
          {
            "bom-ref": packageRef,
            name: "php8.2-cli",
            purl: packagePurl,
            properties: [
              {
                name: "aquasecurity:trivy:PkgID",
                value: "php8.2-cli@8.2.29-1",
              },
              { name: "aquasecurity:trivy:PkgType", value: "deb" },
              {
                name: "aquasecurity:trivy:InstalledFile",
                value: "/usr/bin/php8.2",
              },
              { name: "aquasecurity:trivy:InstalledFileCount", value: "1" },
            ],
          },
        ],
        dependencies: [],
      }),
    );
    const originalTrivyCmd = process.env.TRIVY_CMD;
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables,
        collectSharedLibs,
        extractPathEnv: sinon
          .stub()
          .returns(["/usr/local/bin", "/usr/local/sbin", "/usr/bin"]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        multiChecksumFile: sinon.stub().resolves({
          md5: "a".repeat(32),
          sha1: "b".repeat(40),
        }),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon.stub().callsFake((command) => {
          if (command === "ldd") {
            return { status: 1, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }),
      },
    });
    const result = await getOSPackages(rootfs, {
      Env: ["PATH=/usr/local/bin:/usr/local/sbin:/usr/bin"],
    });
    process.env.TRIVY_CMD = originalTrivyCmd;

    const cli = result.executables.find(
      (component) => sourceOf(component) === "/usr/local/bin/php",
    );
    const fpm = result.executables.find(
      (component) => sourceOf(component) === "/usr/local/sbin/php-fpm",
    );
    const libphp = result.sharedLibs.find(
      (component) =>
        sourceOf(component) === "/usr/lib/apache2/modules/libphp.so",
    );
    const php86 = result.executables.find(
      (component) => sourceOf(component) === "/usr/local/bin/php8.6",
    );
    assert.deepStrictEqual(phpProps(cli), {
      "cdx:php:buildVersion": "8.4.26",
      "cdx:php:buildVersionSource": "binary",
      "cdx:php:sapi": "cli",
    });
    assert.deepStrictEqual(phpProps(php86), {
      "cdx:php:buildVersion": "8.6.0RC3",
      "cdx:php:buildVersionSource": "binary",
      "cdx:php:sapi": "cli",
    });
    assert.deepStrictEqual(phpProps(fpm), {
      "cdx:php:buildVersion": "8.4.26",
      "cdx:php:buildVersionSource": "binary",
      "cdx:php:sapi": "fpm",
    });
    assert.deepStrictEqual(phpProps(libphp), {
      "cdx:php:buildVersion": "8.4.26",
      "cdx:php:buildVersionSource": "binary",
      "cdx:php:sapi": "libphp",
    });
    assert.ok(
      libphp.properties.some(
        (prop) =>
          prop.name === "internal:is_shared_library" && prop.value === "true",
      ),
    );

    // The package-owned executable is excluded from the probe.
    const ownedPhp = result.osPackageFiles.find(
      (component) => sourceOf(component) === "/usr/bin/php8.2",
    );
    assert.deepStrictEqual(phpProps(ownedPhp), {});
    assert.ok(
      !result.osPackages.some((component) => component.version === "8.2.29"),
      "the package-owned 8.2.29 build must not become a PHP runtime",
    );

    // A non-PHP executable is untouched.
    const tool = result.executables.find(
      (component) => sourceOf(component) === "/usr/local/bin/tool",
    );
    assert.deepStrictEqual(phpProps(tool), {});

    // One platform component per distinct version, with a matchable CPE.
    const runtimes = result.osPackages.filter(
      (component) => component.type === "platform",
    );
    assert.strictEqual(runtimes.length, 2);
    assert.deepStrictEqual(
      runtimes.find((component) => component.version === "8.4.26"),
      {
        "bom-ref": "pkg:generic/php@8.4.26",
        type: "platform",
        name: "php",
        version: "8.4.26",
        purl: "pkg:generic/php@8.4.26",
        cpe: "cpe:2.3:a:php:php:8.4.26:*:*:*:*:*:*:*",
      },
    );
    // NVD puts a pre-release suffix in the CPE update field.
    assert.deepStrictEqual(
      runtimes.find((component) => component.version === "8.6.0RC3"),
      {
        "bom-ref": "pkg:generic/php@8.6.0RC3",
        type: "platform",
        name: "php",
        version: "8.6.0RC3",
        purl: "pkg:generic/php@8.6.0RC3",
        cpe: "cpe:2.3:a:php:php:8.6.0:rc3:*:*:*:*:*:*",
      },
    );
    for (const component of [cli, fpm, libphp]) {
      assert.ok(
        result.dependenciesList.some(
          (dependency) =>
            dependency.ref === component["bom-ref"] &&
            dependency.dependsOn.includes("pkg:generic/php@8.4.26"),
        ),
        `${component["bom-ref"]} links to the PHP runtime`,
      );
    }
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
    delete process.env.TRIVY_CMD;
  }
});

it("getOSPackages() records unpackaged Node.js and .NET runtimes and the Brotli decoders compiled into native files", async () => {
  // Synthetic rootfs and trivy BOM built here. The decoder strings are the
  // error-name layouts of real builds: upstream C 1.1+ (`_ERROR_FORMAT_*`),
  // Debian's 1.0.9 and .NET's bare names, and the fix's BLOCK_SWITCH name.
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-brotli-rootfs-"));
  const trivyTempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-brotli-trivy-"));
  const bomJsonFile = path.join(trivyTempDir, "trivy-bom.json");
  const packagePurl =
    "pkg:deb/debian/libbrotli1@1.0.9-2%2Bb6?arch=amd64&distro=debian-12";
  const packageRef = decodeURIComponent(packagePurl);
  const unpatched =
    "\0_ERROR_FORMAT_EXUBERANT_NIBBLE\0_ERROR_FORMAT_RESERVED\0";
  const patched = `${unpatched}_ERROR_FORMAT_BLOCK_SWITCH\0`;
  const nodeBinary = (version, decoder) =>
    Buffer.from(
      `https://nodejs.org/download/release/v${version}/node-v${version}-headers.tar.gz\0node.js/v${version}\0${decoder}`,
      "latin1",
    );
  const sourceOf = (component) =>
    component.properties
      ?.find((prop) => prop.name === "internal:SrcFile")
      ?.value?.replaceAll("\\", "/");
  const props = (component, prefix) =>
    Object.fromEntries(
      (component?.properties || [])
        .filter((prop) => prop.name.startsWith(prefix))
        .map((prop) => [prop.name, prop.value]),
    );
  const put = (relativePath, content) => {
    mkdirSync(path.join(rootfs, path.dirname(relativePath)), {
      recursive: true,
    });
    writeFileSync(path.join(rootfs, relativePath), content, { mode: 0o755 });
  };
  try {
    put("usr/local/bin/node", nodeBinary("24.22.0", unpatched));
    put("opt/node22/bin/node", nodeBinary("22.23.4", patched));
    put("usr/local/bin/tool", "#!/bin/sh\n");
    // An unpackaged brotli command: its file component is pkg:generic/brotli,
    // which the shared decoder component must not collide with.
    put("usr/local/bin/brotli", unpatched);
    put(
      "usr/local/lib/python3.12/site-packages/_brotli.cpython-312-x86_64-linux-gnu.so",
      unpatched,
    );
    put(
      "usr/local/lib/python3.12/site-packages/numpy/_core.cpython-312-x86_64-linux-gnu.so",
      "no decoder here",
    );
    put(
      "usr/local/lib/php/extensions/no-debug-non-zts-20230831/brotli.so",
      unpatched,
    );
    put("usr/local/bundle/gems/brotli-0.8.0/lib/brotli/brotli.so", unpatched);
    put(
      "usr/share/dotnet/shared/Microsoft.NETCore.App/8.0.32/libSystem.IO.Compression.Native.so",
      "\0EXUBERANT_NIBBLE\0RESERVED\0",
    );
    put(
      "usr/share/dotnet/shared/Microsoft.NETCore.App/8.0.32/Microsoft.NETCore.App.deps.json",
      readFileSync(
        testDataPath("brotli-exposure/dotnet/Microsoft.NETCore.App.deps.json"),
      ),
    );
    // Owned by libbrotli1: identified by its package, never probed.
    put("usr/lib/x86_64-linux-gnu/libbrotlidec.so.1.0.9", unpatched);
    put(
      "etc/os-release",
      "ID=debian\nVERSION_ID=12\nVERSION_CODENAME=bookworm\n",
    );
    writeFileSync(
      bomJsonFile,
      JSON.stringify({
        metadata: { tools: [] },
        components: [
          {
            "bom-ref": packageRef,
            name: "libbrotli1",
            purl: packagePurl,
            properties: [
              {
                name: "aquasecurity:trivy:PkgID",
                value: "libbrotli1@1.0.9-2+b6",
              },
              { name: "aquasecurity:trivy:PkgType", value: "deb" },
              {
                name: "aquasecurity:trivy:InstalledFile",
                value: "/usr/lib/x86_64-linux-gnu/libbrotlidec.so.1.0.9",
              },
              { name: "aquasecurity:trivy:InstalledFileCount", value: "1" },
            ],
          },
        ],
        dependencies: [],
      }),
    );
    const originalTrivyCmd = process.env.TRIVY_CMD;
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables,
        collectSharedLibs,
        extractPathEnv: sinon
          .stub()
          .returns(["/usr/local/bin", "/opt/node22/bin"]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        multiChecksumFile: sinon.stub().resolves({
          md5: "a".repeat(32),
          sha1: "b".repeat(40),
        }),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon.stub().callsFake((command) => {
          if (command === "ldd") {
            return { status: 1, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }),
      },
    });
    const result = await getOSPackages(rootfs, {
      Env: ["PATH=/usr/local/bin:/opt/node22/bin"],
    });
    process.env.TRIVY_CMD = originalTrivyCmd;

    const allFiles = [
      ...result.executables,
      ...result.sharedLibs,
      ...result.nativeExtensionFiles,
      ...result.osPackageFiles,
    ];
    const fileAt = (source) =>
      allFiles.find((component) => sourceOf(component) === source);

    // One platform component per Node.js version, with its CPE.
    const nodeRuntimes = result.osPackages.filter((component) =>
      component.purl?.startsWith("pkg:generic/node@"),
    );
    assert.deepStrictEqual(
      nodeRuntimes.map((component) => [component.purl, component.cpe]).sort(),
      [
        [
          "pkg:generic/node@22.23.4",
          "cpe:2.3:a:nodejs:node.js:22.23.4:*:*:*:*:*:*:*",
        ],
        [
          "pkg:generic/node@24.22.0",
          "cpe:2.3:a:nodejs:node.js:24.22.0:*:*:*:*:*:*:*",
        ],
      ],
    );
    const node24 = fileAt("/usr/local/bin/node");
    assert.deepStrictEqual(props(node24, "cdx:node:"), {
      "cdx:node:buildVersion": "24.22.0",
      "cdx:node:buildVersionSource": "release-url",
      "cdx:node:releaseChannel": "release",
    });
    assert.deepStrictEqual(props(node24, "cdx:brotli:"), {
      "cdx:brotli:c:blockSwitchFix": "false",
      "cdx:brotli:c:evidence": "error-names",
    });
    assert.strictEqual(
      props(fileAt("/opt/node22/bin/node"), "cdx:brotli:")[
        "cdx:brotli:c:blockSwitchFix"
      ],
      "true",
    );
    assert.ok(
      result.dependenciesList.some(
        (dependency) =>
          dependency.ref === node24["bom-ref"] &&
          dependency.dependsOn.includes("pkg:generic/node@24.22.0"),
      ),
      "the node binary links to its runtime",
    );

    // The .NET runtime, named by its runtime pack.
    const dotnet = result.osPackages.find((component) =>
      component.purl?.startsWith("pkg:nuget/Microsoft.NETCore.App.Runtime."),
    );
    assert.strictEqual(
      dotnet?.purl,
      "pkg:nuget/Microsoft.NETCore.App.Runtime.linux-arm64@8.0.32",
    );

    // Extension modules become file components only when they hold a
    // decoder, each with its path so two brotli.so files stay apart.
    const php = fileAt(
      "/usr/local/lib/php/extensions/no-debug-non-zts-20230831/brotli.so",
    );
    const ruby = fileAt(
      "/usr/local/bundle/gems/brotli-0.8.0/lib/brotli/brotli.so",
    );
    assert.strictEqual(
      php?.purl,
      "pkg:generic/brotli.so#usr/local/lib/php/extensions/no-debug-non-zts-20230831/brotli.so",
    );
    assert.strictEqual(
      ruby?.purl,
      "pkg:generic/brotli.so#usr/local/bundle/gems/brotli-0.8.0/lib/brotli/brotli.so",
    );
    for (const component of [
      php,
      ruby,
      fileAt(
        "/usr/local/lib/python3.12/site-packages/_brotli.cpython-312-x86_64-linux-gnu.so",
      ),
      fileAt(
        "/usr/share/dotnet/shared/Microsoft.NETCore.App/8.0.32/libSystem.IO.Compression.Native.so",
      ),
    ]) {
      assert.deepStrictEqual(props(component, "cdx:brotli:"), {
        "cdx:brotli:c:blockSwitchFix": "false",
        "cdx:brotli:c:evidence": "error-names",
      });
    }
    assert.strictEqual(
      fileAt(
        "/usr/local/lib/python3.12/site-packages/numpy/_core.cpython-312-x86_64-linux-gnu.so",
      ),
      undefined,
      "an extension without a decoder does not grow the BOM",
    );
    // Extension modules are reported apart from sharedLibs, so the
    // unpackaged-library count is what the loader's directories hold.
    assert.ok(
      !result.sharedLibs.some((component) =>
        sourceOf(component)?.includes("site-packages"),
      ),
    );
    const brotliCli = fileAt("/usr/local/bin/brotli");
    assert.strictEqual(brotliCli?.purl, "pkg:generic/brotli");
    assert.strictEqual(
      props(brotliCli, "cdx:brotli:")["cdx:brotli:c:blockSwitchFix"],
      "false",
    );
    assert.deepStrictEqual(
      props(fileAt("/usr/local/bin/tool"), "cdx:brotli:"),
      {},
    );
    assert.deepStrictEqual(
      props(
        fileAt("/usr/lib/x86_64-linux-gnu/libbrotlidec.so.1.0.9"),
        "cdx:brotli:",
      ),
      {},
      "a package-owned library is left to its package",
    );

    // One brotli component that every embedding file depends on.
    const brotli = result.osPackages.find(
      (component) =>
        component["bom-ref"] ===
        "pkg:generic/brotli?vcs_url=git+https://github.com/google/brotli",
    );
    assert.deepStrictEqual(props(brotli, "cdx:brotli:"), {
      "cdx:brotli:embeddedCopies": "7",
      "cdx:brotli:unknownCopies": "0",
      "cdx:brotli:unpatchedCopies": "6",
    });
    assert.strictEqual(
      result.dependenciesList.filter((dependency) =>
        dependency.dependsOn?.includes(
          "pkg:generic/brotli?vcs_url=git+https://github.com/google/brotli",
        ),
      ).length,
      7,
    );
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
    delete process.env.TRIVY_CMD;
  }
});

it("getOSPackages() records a degradation when the Brotli probe reaches its cap", async () => {
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-brotli-cap-"));
  const trivyTempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-brotli-cap-t-"));
  const unpatched = "\0_ERROR_FORMAT_EXUBERANT_NIBBLE\0";
  const put = (relativePath, content) => {
    mkdirSync(path.join(rootfs, path.dirname(relativePath)), {
      recursive: true,
    });
    writeFileSync(path.join(rootfs, relativePath), content, { mode: 0o755 });
  };
  const brotliDecoder = await import("../inventory/brotliDecoder.js");
  const recordDegradation = sinon.stub();
  try {
    put("usr/local/bin/one", unpatched);
    put("usr/local/bin/two", unpatched);
    put(
      "usr/local/lib/python3.12/site-packages/_brotli.cpython-312-x86_64-linux-gnu.so",
      unpatched,
    );
    put(
      "usr/local/lib/python3.12/site-packages/_cffi.cpython-312-x86_64-linux-gnu.so",
      unpatched,
    );
    writeFileSync(
      path.join(trivyTempDir, "trivy-bom.json"),
      JSON.stringify({ metadata: { tools: [] }, components: [] }),
    );
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      moduleOverrides: {
        "../inventory/brotliDecoder.js": {
          ...brotliDecoder,
          MAX_BROTLI_PROBES: 1,
        },
        "../core/buildLedger.js": { recordDegradation },
      },
      utilsOverrides: {
        collectExecutables,
        collectSharedLibs,
        extractPathEnv: sinon.stub().returns(["/usr/local/bin"]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        multiChecksumFile: sinon.stub().resolves({
          md5: "a".repeat(32),
          sha1: "b".repeat(40),
        }),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon
          .stub()
          .returns({ status: 1, stdout: "", stderr: "" }),
      },
    });
    const result = await getOSPackages(rootfs, {
      Env: ["PATH=/usr/local/bin"],
    });
    const capped = recordDegradation
      .getCalls()
      .filter((call) => call.args[0] === "binary.brotli-probe.capped");
    assert.strictEqual(capped.length, 1);
    assert.match(
      capped[0].args[1].detail,
      /left 1 executable\(s\) or librar\(ies\) and 1 extension module\(s\) unread/,
    );
    // What was read is still reported.
    assert.strictEqual(
      [...result.executables, ...result.nativeExtensionFiles].filter(
        (component) =>
          component.properties?.some(
            (prop) => prop.name === "cdx:brotli:c:blockSwitchFix",
          ),
      ).length,
      2,
    );
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
    delete process.env.TRIVY_CMD;
  }
});

it("getOSPackages() probes at most 64 PHP-named files per scan", async () => {
  // Synthetic rootfs built here: 65 PHP-named files with the same marker.
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-php-cap-"));
  const trivyTempDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-php-cap-trivy-"),
  );
  const marker = (version) => `X-Powered-By: PHP/${version}\0`;
  try {
    mkdirSync(path.join(rootfs, "usr/local/bin"), { recursive: true });
    mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    for (let i = 0; i <= 64; i++) {
      writeFileSync(
        path.join(rootfs, `usr/local/bin/php${i}`),
        Buffer.from(marker("8.4.26")),
      );
    }
    writeFileSync(
      path.join(rootfs, "etc/os-release"),
      "ID=alpine\nVERSION_ID=3.24.0\n",
    );
    const originalTrivyCmd = process.env.TRIVY_CMD;
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables,
        collectSharedLibs,
        extractPathEnv: sinon.stub().returns(["/usr/local/bin"]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        multiChecksumFile: sinon.stub().resolves({
          md5: "a".repeat(32),
          sha1: "b".repeat(40),
        }),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon
          .stub()
          .returns({ status: 0, stdout: "", stderr: "" }),
      },
    });
    const result = await getOSPackages(rootfs, {
      Env: ["PATH=/usr/local/bin"],
    });
    process.env.TRIVY_CMD = originalTrivyCmd;

    const probed = result.executables.filter((component) =>
      (component.properties || []).some(
        (prop) => prop.name === "cdx:php:buildVersion",
      ),
    );
    assert.strictEqual(probed.length, 64);
    assert.strictEqual(
      result.osPackages.filter((component) => component.type === "platform")
        .length,
      1,
      "one runtime for the single version",
    );
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
    delete process.env.TRIVY_CMD;
  }
});

// A synthetic rootfs, and the trivy BOM that says which package owns which of
// its files. Every file is built here: the markers stand in for the
// X-Powered-By string a compiled PHP carries. Tests of one file run
// concurrently, so trivy is named through the plugin stub and not through
// TRIVY_CMD, which every test of the process would share.
async function scanPhpRootfs({
  files,
  packages,
  osRelease,
  binPaths = ["/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/usr/sbin"],
}) {
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-php-owned-"));
  const trivyTempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-php-owned-t-"));
  try {
    for (const [file, version] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(rootfs, file)), { recursive: true });
      writeFileSync(
        path.join(rootfs, file),
        Buffer.from(`X-Powered-By: PHP/${version}\0`),
      );
    }
    mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    writeFileSync(path.join(rootfs, "etc/os-release"), osRelease);
    writeFileSync(
      path.join(trivyTempDir, "trivy-bom.json"),
      JSON.stringify({
        metadata: { tools: [] },
        components: packages.map(({ purl, name, pkgType, installedFiles }) => ({
          "bom-ref": decodeURIComponent(purl),
          name,
          purl,
          properties: [
            { name: "aquasecurity:trivy:PkgType", value: pkgType },
            ...installedFiles.map((value) => ({
              name: "aquasecurity:trivy:InstalledFile",
              value,
            })),
            {
              name: "aquasecurity:trivy:InstalledFileCount",
              value: `${installedFiles.length}`,
            },
          ],
        })),
        dependencies: [],
      }),
    );
    const { getOSPackages } = await loadBinaryModule({
      pluginsOverrides: {
        resolvePluginBinary: sinon
          .stub()
          .callsFake((tool) =>
            tool === "trivy" ? "/usr/bin/true" : undefined,
          ),
      },
      utilsOverrides: {
        collectExecutables,
        collectSharedLibs,
        extractPathEnv: sinon.stub().returns(binPaths),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        multiChecksumFile: sinon.stub().resolves({
          md5: "a".repeat(32),
          sha1: "b".repeat(40),
        }),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon.stub().callsFake((command) => ({
          status: command === "ldd" ? 1 : 0,
          stdout: "",
          stderr: "",
        })),
      },
    });
    return await getOSPackages(rootfs, {
      Env: [`PATH=${binPaths.join(":")}`],
    });
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
  }
}

// A Windows host names rootfs files with its own separator: /usr\local\bin.
const phpSourceOf = (component) =>
  component.properties
    ?.find((prop) => prop.name === "internal:SrcFile")
    ?.value?.replaceAll("\\", "/");
const allPhpComponents = (result) => [
  ...result.osPackages,
  ...result.osPackageFiles,
  ...result.executables,
  ...result.sharedLibs,
];

it("getOSPackages() leaves PHP that a package owns to its package, whichever manager owns it", async () => {
  const cases = [
    {
      manager: "dpkg",
      osRelease: "ID=debian\nVERSION_ID=12\nVERSION_CODENAME=bookworm\n",
      version: "8.2.35",
      pkgType: "debian",
      purl: "pkg:deb/debian/php8.2-cli@8.2.35-1~deb12u1?arch=amd64&distro=debian-12",
      name: "php8.2-cli",
      files: [
        "/usr/bin/php8.2",
        "/usr/sbin/php-fpm8.2",
        "/usr/lib/apache2/modules/libphp8.2.so",
      ],
    },
    {
      manager: "apk",
      osRelease: "ID=alpine\nVERSION_ID=3.23.7\n",
      version: "8.4.27",
      pkgType: "alpine",
      purl: "pkg:apk/alpine/php84@8.4.27-r0?arch=x86_64&distro=alpine-3.23.7",
      name: "php84",
      files: ["/usr/bin/php84", "/usr/sbin/php-fpm84"],
    },
    {
      manager: "rpm",
      osRelease: 'ID="almalinux"\nVERSION_ID="9.8"\n',
      version: "8.0.30",
      pkgType: "alma",
      purl: "pkg:rpm/almalinux/php-cli@8.0.30-8.el9?arch=x86_64&distro=almalinux-9.8",
      name: "php-cli",
      files: [
        "/usr/bin/php",
        "/usr/bin/phpdbg",
        "/usr/sbin/php-fpm",
        "/usr/lib64/httpd/modules/libphp.so",
      ],
    },
  ];
  for (const testCase of cases) {
    const result = await scanPhpRootfs({
      osRelease: testCase.osRelease,
      files: Object.fromEntries(
        testCase.files.map((file) => [file.slice(1), testCase.version]),
      ),
      packages: [
        {
          purl: testCase.purl,
          name: testCase.name,
          pkgType: testCase.pkgType,
          installedFiles: testCase.files,
        },
      ],
    });
    const label = testCase.manager;
    // The package is PHP's identity, as the OS inventory already emits it.
    assert.ok(
      result.osPackages.some(
        (component) =>
          component.name === testCase.name &&
          component.purl.startsWith(testCase.purl.split("?")[0]),
      ),
      `${label}: the package component is kept`,
    );
    assert.deepStrictEqual(
      result.osPackages.filter(
        (component) =>
          component.type === "platform" ||
          component.purl?.startsWith("pkg:generic/php@"),
      ),
      [],
      `${label}: no generic PHP runtime for package-owned PHP`,
    );
    assert.deepStrictEqual(
      allPhpComponents(result).flatMap((component) =>
        (component.properties || []).filter((prop) =>
          prop.name.startsWith("cdx:php:"),
        ),
      ),
      [],
      `${label}: no cdx:php properties on package-owned PHP`,
    );
    assert.ok(
      result.dependenciesList.every(
        (dependency) =>
          !dependency.ref.startsWith("pkg:generic/php@") &&
          !(dependency.dependsOn || []).some((ref) =>
            ref.startsWith("pkg:generic/php@"),
          ),
      ),
      `${label}: no edge to a generic PHP runtime`,
    );
    // Owned files are the package's, not unpackaged executables or libraries.
    assert.deepStrictEqual(
      [...result.executables, ...result.sharedLibs].map(phpSourceOf),
      [],
      `${label}: nothing is left unpackaged`,
    );
    assert.deepStrictEqual(
      result.osPackageFiles.map(phpSourceOf).sort(),
      [...testCase.files].sort(),
      `${label}: the owned files are listed as the package's`,
    );
  }
});

it("getOSPackages() leaves a PHP in a Nix store to Nix, though Trivy lists no Nix package", async () => {
  // Nix-built images put store directories on the PATH, so the store binary is
  // an executable the scan finds directly.
  const result = await scanPhpRootfs({
    osRelease: "ID=debian\nVERSION_ID=12\n",
    files: {
      "nix/store/0abc-php-8.4.27/bin/php": "8.4.27",
      "usr/local/sbin/php-fpm": "8.3.30",
    },
    binPaths: ["/nix/store/0abc-php-8.4.27/bin", "/usr/local/sbin"],
    packages: [],
  });
  // Only the source build in /usr/local/sbin is nobody's.
  assert.deepStrictEqual(
    result.osPackages
      .filter((component) => component.type === "platform")
      .map((component) => component.purl),
    ["pkg:generic/php@8.3.30"],
  );
  assert.deepStrictEqual(
    allPhpComponents(result)
      .filter((component) =>
        (component.properties || []).some(
          (prop) => prop.name === "cdx:php:buildVersion",
        ),
      )
      .map(phpSourceOf),
    ["/usr/local/sbin/php-fpm"],
  );
});

it("getOSPackages() keeps a source-built PHP next to a package-owned one apart", async () => {
  const result = await scanPhpRootfs({
    osRelease: "ID=debian\nVERSION_ID=12\n",
    files: {
      "usr/bin/php8.2": "8.2.35",
      "usr/local/bin/php": "8.4.27",
      "usr/local/sbin/php-fpm": "8.4.27",
    },
    packages: [
      {
        purl: "pkg:deb/debian/php8.2-cli@8.2.35-1~deb12u1?arch=amd64&distro=debian-12",
        name: "php8.2-cli",
        pkgType: "debian",
        installedFiles: ["/usr/bin/php8.2"],
      },
    ],
  });
  // Only the files no package owns are read and identified.
  assert.deepStrictEqual(
    result.osPackages
      .filter((component) => component.type === "platform")
      .map((component) => [component.purl, component.version]),
    [["pkg:generic/php@8.4.27", "8.4.27"]],
  );
  assert.deepStrictEqual(
    result.executables
      .filter((component) =>
        component.properties.some((prop) => prop.name === "cdx:php:sapi"),
      )
      .map(phpSourceOf)
      .sort(),
    ["/usr/local/bin/php", "/usr/local/sbin/php-fpm"],
  );
  const owned = result.osPackageFiles.find(
    (component) => phpSourceOf(component) === "/usr/bin/php8.2",
  );
  assert.ok(owned);
  assert.deepStrictEqual(
    (owned.properties || []).filter((prop) => prop.name.startsWith("cdx:php:")),
    [],
  );
});

// ---------------------------------------------------------------------------
// OBOM and container scan agree on the purl of a package.
//
// `cdxgen -t docker <image>` and `obom` run inside that image must name a
// package the same way. Each case below gives the container scan the trivy
// output recorded from a real image (the fixtures in test/data), and gives the
// OBOM builder the rows osquery, or the apk reader, returned for the same
// image, against the os-release of that image.
// ---------------------------------------------------------------------------
const PARITY_CASES = [
  {
    title: "Ubuntu 24.04 (deb)",
    osRelease: readFileSync(testDataPath("os-release-ubuntu"), "utf-8"),
    trivyBom: "bom-ubuntu-trivy.json",
    category: "deb_packages",
    queryObj: { purlType: "deb", query: "select * from deb_packages;" },
    rows: "osquery-deb-ubuntu.json",
    purlPrefix: "pkg:deb/",
    expected: {
      bsdutils:
        "pkg:deb/ubuntu/bsdutils@1:2.39.3-9ubuntu6.6?arch=amd64&distro=ubuntu-24.04&distro_name=noble&epoch=1",
      "php-common":
        "pkg:deb/ubuntu/php-common@2:93ubuntu2?arch=all&distro=ubuntu-24.04&distro_name=noble&epoch=2",
      libc6:
        "pkg:deb/ubuntu/libc6@2.39-0ubuntu8.9?arch=amd64&distro=ubuntu-24.04&distro_name=noble",
      "libstdc++6":
        "pkg:deb/ubuntu/libstdc%2B%2B6@14.2.0-4ubuntu2~24.04.1?arch=amd64&distro=ubuntu-24.04&distro_name=noble",
    },
  },
  {
    title: "AlmaLinux 9.8 (rpm)",
    osRelease: readFileSync(testDataPath("os-release-almalinux"), "utf-8"),
    trivyBom: "bom-almalinux-trivy.json",
    category: "rpm_packages",
    queryObj: { purlType: "rpm", query: "select * from rpm_packages;" },
    rows: "osquery-rpm-almalinux.json",
    purlPrefix: "pkg:rpm/",
    expected: {
      "openssl-libs":
        "pkg:rpm/almalinux/openssl-libs@1:3.5.8-1.el9_8?arch=x86_64&distro=almalinux-9.8&epoch=1",
      tar: "pkg:rpm/almalinux/tar@2:1.34-13.el9_8?arch=x86_64&distro=almalinux-9.8&epoch=2",
      acl: "pkg:rpm/almalinux/acl@2.4.0-1.el9_8?arch=x86_64&distro=almalinux-9.8",
    },
  },
  {
    title: "Alpine 3.24 (apk)",
    osRelease: readFileSync(testDataPath("os-release-alpine"), "utf-8"),
    trivyBom: "bom-alpine-trivy.json",
    category: "apk_packages",
    apkDatabase: "apk-installed-alpine",
    apkLocation: path.join("lib", "apk", "db", "installed"),
    purlPrefix: "pkg:apk/",
    expected: {
      php84:
        "pkg:apk/alpine/php84@8.4.27-r0?arch=x86_64&distro=alpine-3.24.3&distro_name=alpine-3.24",
    },
  },
  {
    title: "Wolfi (apk, apk-tools 2)",
    osRelease: readFileSync(testDataPath("os-release-wolfi"), "utf-8"),
    trivyBom: "bom-wolfi-trivy.json",
    category: "apk_packages",
    apkDatabase: "apk-installed-wolfi",
    apkLocation: path.join("lib", "apk", "db", "installed"),
    purlPrefix: "pkg:apk/",
    expected: {
      "wolfi-baselayout":
        "pkg:apk/wolfi/wolfi-baselayout@20230201-r30?arch=x86_64&distro=wolfi-20230201",
    },
  },
  {
    title: "Alpaquita (apk, apk-tools 3, database under /var/lib)",
    osRelease: "ID=alpaquita\nID_LIKE=alpine\nVERSION_ID=stream\n",
    trivyBom: "bom-alpaquita-trivy.json",
    category: "apk_packages",
    apkDatabase: "alpaquita-installed",
    apkLocation: path.join("var", "lib", "apk", "db", "installed"),
    purlPrefix: "pkg:apk/",
    expected: {
      "apk-tools":
        "pkg:apk/alpaquita/apk-tools@3.0.7-r1?arch=aarch64&distro=alpaquita-stream",
    },
  },
];

// The packages `getOSPackages` makes of a trivy rootfs scan, as it makes them
// for a container image: binary packages only, the source packages it adds
// for vulnerability matching left out.
async function containerScanPackages(rootfs, trivyBomName, purlPrefix) {
  const trivyTempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-trivy-parity-"));
  try {
    writeFileSync(
      path.join(trivyTempDir, "trivy-bom.json"),
      readFileSync(testDataPath(trivyBomName)),
    );
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        extractPathEnv: sinon.stub().returns([]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon
          .stub()
          .returns({ status: 0, stdout: "", stderr: "" }),
      },
    });
    const result = await getOSPackages(rootfs, {});
    return new Map(
      result.osPackages
        .filter(
          (pkg) =>
            pkg.purl?.startsWith(purlPrefix) && !pkg.tags?.includes("source"),
        )
        .map((pkg) => [pkg.name, pkg]),
    );
  } finally {
    rmSync(trivyTempDir, { recursive: true, force: true });
    delete process.env.TRIVY_CMD;
  }
}

// The components the OBOM builds on a host whose os-release is the rootfs's.
async function obomPackages(rootfs, testCase) {
  const { getDistroInfo } = await import("../inventory/osinfo.js");
  const evidenceUtils = await esmock(
    "../inventory/evidenceUtils.js",
    {},
    {
      "../inventory/osinfo.js": { getDistroInfo: () => getDistroInfo(rootfs) },
    },
  );
  let components;
  if (testCase.apkDatabase) {
    const { readApkInstalledDb } = await import(
      "../inventory/apkInstalledDb.js"
    );
    const { state, packages } = readApkInstalledDb({
      rootPath: rootfs,
      platform: "linux",
    });
    assert.strictEqual(state, "ok", `${testCase.title}: the apk database`);
    components = evidenceUtils.convertApkPackages(packages);
  } else {
    components = evidenceUtils.convertOSQueryResults(
      testCase.category,
      testCase.queryObj,
      JSON.parse(readFileSync(testDataPath(testCase.rows), "utf-8")),
    );
  }
  return new Map(components.map((component) => [component.name, component]));
}

function buildParityRootfs(testCase) {
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-parity-"));
  mkdirSync(path.join(rootfs, "etc"), { recursive: true });
  writeFileSync(path.join(rootfs, "etc", "os-release"), testCase.osRelease);
  if (testCase.apkDatabase) {
    const location = path.join(rootfs, testCase.apkLocation);
    mkdirSync(path.dirname(location), { recursive: true });
    writeFileSync(
      location,
      readFileSync(testDataPath(testCase.apkDatabase), "utf-8"),
    );
  }
  return rootfs;
}

it("getOSPackages() leaves the architecture out of the purl of a package that has none", async () => {
  // trivy writes arch=None for an rpm key record such as gpg-pubkey.
  const almalinux = PARITY_CASES.find((c) => c.title.startsWith("AlmaLinux"));
  const rawTrivy = JSON.parse(
    readFileSync(testDataPath(almalinux.trivyBom), "utf-8"),
  ).components.find((c) => c.name === "gpg-pubkey");
  assert.ok(rawTrivy.purl.includes("arch=None"), rawTrivy.purl);
  const rootfs = buildParityRootfs(almalinux);
  try {
    const container = await containerScanPackages(
      rootfs,
      almalinux.trivyBom,
      almalinux.purlPrefix,
    );
    const key = container.get("gpg-pubkey");
    assert.strictEqual(
      key.purl,
      "pkg:rpm/almalinux/gpg-pubkey@b86b3716-61e69f29?distro=almalinux-9.8",
    );
    assert.strictEqual(key["bom-ref"], decodeURIComponent(key.purl));
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
  }
});

for (const testCase of PARITY_CASES) {
  it(`names every package of ${testCase.title} the same in an OBOM and a container scan`, async () => {
    const rootfs = buildParityRootfs(testCase);
    try {
      const container = await containerScanPackages(
        rootfs,
        testCase.trivyBom,
        testCase.purlPrefix,
      );
      const obom = await obomPackages(rootfs, testCase);
      assert.ok(container.size > 0, "the container scan found packages");
      // The OBOM sees every package the recorded container scan saw.
      for (const [name, containerPackage] of container) {
        const obomPackage = obom.get(name);
        assert.ok(obomPackage, `${name} is in the OBOM`);
        assert.strictEqual(obomPackage.purl, containerPackage.purl, name);
        assert.strictEqual(
          obomPackage["bom-ref"],
          containerPackage["bom-ref"],
          name,
        );
        assert.strictEqual(obomPackage.version, containerPackage.version, name);
      }
      if (!testCase.apkDatabase) {
        // The rows were picked as the same packages as the trivy fixture.
        assert.strictEqual(obom.size, container.size);
      }
    } finally {
      rmSync(rootfs, { recursive: true, force: true });
    }
  });

  it(`keeps the container scan's purls of ${testCase.title} as they are`, async () => {
    const rootfs = buildParityRootfs(testCase);
    try {
      const container = await containerScanPackages(
        rootfs,
        testCase.trivyBom,
        testCase.purlPrefix,
      );
      for (const [name, purl] of Object.entries(testCase.expected)) {
        assert.strictEqual(container.get(name)?.purl, purl, name);
      }
    } finally {
      rmSync(rootfs, { recursive: true, force: true });
    }
  });
}

it("dropRedundantSourceComponents() matches a source shadow whatever arch it names", async () => {
  const { dropRedundantSourceComponents } = await loadBinaryModule();
  const installed = {
    name: "ruby3.2",
    version: "3.2.3-1ubuntu0.24.04.8",
    purl: "pkg:deb/ubuntu/ruby3.2@3.2.3-1ubuntu0.24.04.8?arch=arm64&distro=ubuntu-24.04",
  };
  // The shadow made from ruby3.2-doc, whose source package is ruby3.2
  const shadow = {
    name: "ruby3.2",
    version: "3.2.3-1ubuntu0.24.04.8",
    purl: "pkg:deb/ubuntu/ruby3.2@3.2.3-1ubuntu0.24.04.8?arch=source&distro=ubuntu-24.04",
    tags: ["source"],
  };
  const otherSource = {
    name: "ruby-defaults",
    version: "1:3.2~ubuntu1",
    purl: "pkg:deb/ubuntu/ruby-defaults@1:3.2~ubuntu1?arch=source&distro=ubuntu-24.04&epoch=1",
    tags: ["source"],
  };
  const pkgList = [shadow, installed, otherSource];
  dropRedundantSourceComponents(pkgList);
  assert.deepStrictEqual(
    pkgList.map((comp) => comp.purl),
    [installed.purl, otherSource.purl],
  );
});
