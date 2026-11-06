import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  addHbomAnalysisProperties,
  ensureNoMixedHbomProjectTypes,
  ensureSupportedHbomSpecVersion,
  hasHbomProjectType,
  isHbomOnlyProjectTypes,
  normalizeHbomOptions,
} from "./hbom.js";
import { importHbomModule } from "./hbomLoader.js";
import { getPropertyValue } from "./inventoryStats.js";

describe("hbom helpers", () => {
  it("detects hbom project types and rejects mixed project selections", () => {
    assert.strictEqual(hasHbomProjectType(undefined), false);
    assert.strictEqual(hasHbomProjectType(["js"]), false);
    assert.strictEqual(hasHbomProjectType(["hbom"]), true);
    assert.strictEqual(hasHbomProjectType(["hardware"]), true);
    assert.strictEqual(isHbomOnlyProjectTypes(undefined), false);
    assert.strictEqual(isHbomOnlyProjectTypes(["hbom"]), true);
    assert.strictEqual(isHbomOnlyProjectTypes(["hardware"]), true);
    assert.strictEqual(isHbomOnlyProjectTypes(["hbom", "hardware"]), true);
    assert.strictEqual(isHbomOnlyProjectTypes(["hbom", "js"]), false);
    ensureNoMixedHbomProjectTypes(["hbom"]);
    ensureNoMixedHbomProjectTypes(["hardware"]);
    assert.throws(
      () => ensureNoMixedHbomProjectTypes(["hbom", "js"]),
      /cannot be mixed/u,
    );
  });

  it("allows 1.7 and 2.0 for hbom generation", () => {
    ensureSupportedHbomSpecVersion(undefined);
    ensureSupportedHbomSpecVersion(1.7);
    ensureSupportedHbomSpecVersion(2);
    ensureSupportedHbomSpecVersion("2.0");
    assert.throws(
      () => ensureSupportedHbomSpecVersion(1.6),
      /only CycloneDX 1\.7 and 2\.0/u,
    );
  });

  it("normalizes hbom collector options", () => {
    assert.deepStrictEqual(
      normalizeHbomOptions({
        arch: "arm64",
        noCommandEnrichment: true,
        platform: "darwin",
        plistEnrichment: true,
        privileged: true,
        sensitive: true,
        strict: true,
        timeout: "2500",
      }),
      {
        allowPartial: false,
        architecture: "arm64",
        dryRun: false,
        includeCommandEnrichment: false,
        includePlistEnrichment: true,
        includePrivilegedEnrichment: true,
        includeSensitiveIdentifiers: true,
        platform: "darwin",
        specVersion: "1.7",
        timeoutMs: 2500,
      },
    );
  });

  it("disables command enrichment for every spelling the CLIs produce", () => {
    // yargs negates `--no-command-enrichment` into `commandEnrichment: false`
    // and leaves `noCommandEnrichment` at its default, in cdxgen and in hbom.
    const enrichment = (options) =>
      normalizeHbomOptions(options).includeCommandEnrichment;
    assert.strictEqual(enrichment({}), true);
    assert.strictEqual(enrichment({ commandEnrichment: true }), true);
    assert.strictEqual(enrichment({ commandEnrichment: false }), false);
    assert.strictEqual(enrichment({ noCommandEnrichment: true }), false);
    assert.strictEqual(enrichment({ noCommandEnrichment: false }), true);
    assert.strictEqual(
      enrichment({ commandEnrichment: false, includeCommandEnrichment: true }),
      true,
    );
  });

  it("adds derived analysis properties for hbom command diagnostics", () => {
    const bomJson = addHbomAnalysisProperties({
      components: [],
      metadata: {
        component: {
          name: "demo-host",
          properties: [
            { name: "cdx:hbom:platform", value: "linux" },
            { name: "cdx:hbom:architecture", value: "amd64" },
          ],
          type: "device",
        },
      },
      properties: [
        { name: "cdx:hbom:evidence:commandDiagnosticCount", value: "2" },
        {
          name: "cdx:hbom:evidence:commandDiagnostic",
          value: JSON.stringify({
            command: "lsusb",
            installHint:
              "Command not found: install the Linux package providing lsusb (commonly `usbutils`).",
            issue: "missing-command",
          }),
        },
        {
          name: "cdx:hbom:evidence:commandDiagnostic",
          value: JSON.stringify({
            command: "drm_info",
            issue: "permission-denied",
            privilegeHint:
              "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.",
          }),
        },
      ],
    });

    assert.ok(
      bomJson.properties.some(
        (property) =>
          property.name === "cdx:hbom:analysis:commandDiagnosticCount" &&
          property.value === "2",
      ),
    );
    assert.ok(
      bomJson.properties.some(
        (property) =>
          property.name === "cdx:hbom:analysis:missingCommands" &&
          property.value === "lsusb",
      ),
    );
    assert.ok(
      bomJson.properties.some(
        (property) =>
          property.name === "cdx:hbom:analysis:missingCommandIds" &&
          property.value === "lsusb",
      ),
    );
    assert.ok(
      bomJson.properties.some(
        (property) =>
          property.name === "cdx:hbom:analysis:installHintCount" &&
          property.value === "1",
      ),
    );
    assert.ok(
      bomJson.properties.some(
        (property) =>
          property.name === "cdx:hbom:analysis:permissionDeniedCommands" &&
          property.value === "drm_info",
      ),
    );
    assert.ok(
      bomJson.properties.some(
        (property) =>
          property.name === "cdx:hbom:analysis:permissionDeniedIds" &&
          property.value === "drm_info",
      ),
    );
    assert.ok(
      bomJson.properties.some(
        (property) =>
          property.name === "cdx:hbom:analysis:privilegeHintCount" &&
          property.value === "1",
      ),
    );
    assert.ok(
      bomJson.properties.some(
        (property) =>
          property.name === "cdx:hbom:analysis:requiresPrivileged" &&
          property.value === "true",
      ),
    );
  });

  it("propagates native cdx-hbom dry-run trace activities into cdxgen", async () => {
    const recordActivity = sinon.stub();
    let collectorTrace;
    const { createHbomDocument } = await esmock("./hbom.js", {
      "../core/activity.js": { isDryRun: true, recordActivity },
      "./hbomLoader.js": {
        importHbomModule: sinon.stub().resolves({
          collectHardware: sinon.stub().callsFake(async (options) => {
            collectorTrace = options.trace;
            collectorTrace.activities.push({
              category: "cpu-memory",
              command: "/usr/sbin/sysctl",
              id: "sysctl-baseline",
              kind: "command",
              reason: "Dry run mode blocks HBOM command 'sysctl-baseline'.",
              status: "blocked",
              target: "/usr/sbin/sysctl -n hw.model",
            });
            collectorTrace.activities.push({
              kind: "file-read",
              status: "completed",
              target: "/etc/os-release",
            });
            return {
              bomFormat: "CycloneDX",
              components: [],
              dependencies: [],
              metadata: {
                timestamp: "2026-05-13T00:00:00.000Z",
                tools: {
                  components: [],
                },
              },
              specVersion: "1.7",
              version: 1,
            };
          }),
          createCollectorTrace: sinon
            .stub()
            .callsFake(() => ({ activities: [] })),
          getCollectorTrace: sinon.stub().callsFake(() => collectorTrace),
        }),
      },
    });

    const bomJson = await createHbomDocument({
      arch: "arm64",
      platform: "linux",
      specVersion: 1.7,
    });

    assert.strictEqual(recordActivity.callCount, 2);
    sinon.assert.calledWithMatch(recordActivity.firstCall, {
      commandId: "sysctl-baseline",
      kind: "execute",
      reason: sinon.match(/Dry run mode blocks HBOM command/u),
      status: "blocked",
      target: "/usr/sbin/sysctl -n hw.model",
    });
    sinon.assert.calledWithMatch(recordActivity.secondCall, {
      kind: "read",
      reason: undefined,
      status: "completed",
      target: "/etc/os-release",
    });
    assert.strictEqual(bomJson.bomFormat, "CycloneDX");
    assert.strictEqual(bomJson.specVersion, "1.7");
    assert.strictEqual(bomJson.version, 1);
    assert.deepStrictEqual(bomJson.components, []);
    assert.deepStrictEqual(bomJson.dependencies, []);
    assert.ok(typeof bomJson.metadata?.timestamp === "string");
    assert.deepStrictEqual(bomJson.metadata?.tools?.components, []);
  });

  it("returns a synthetic hbom document during dry-run mode when cdx-hbom lacks trace support", async () => {
    const recordActivity = sinon.stub();
    const { createHbomDocument } = await esmock("./hbom.js", {
      "../core/activity.js": { isDryRun: true, recordActivity },
      "./hbomLoader.js": {
        importHbomModule: sinon.stub().resolves({
          collectHardware: sinon.stub(),
        }),
      },
    });

    const bomJson = await createHbomDocument({
      arch: "arm64",
      platform: "linux",
      specVersion: 1.7,
    });

    sinon.assert.calledOnce(recordActivity);
    sinon.assert.calledWithMatch(recordActivity, {
      kind: "hbom",
      reason: sinon.match(/Dry run mode blocks HBOM collection/u),
      status: "blocked",
      target: "linux/arm64",
    });
    assert.strictEqual(bomJson.bomFormat, "CycloneDX");
    assert.strictEqual(bomJson.specVersion, "1.7");
  });

  it("blocks secure-mode live collection when the HBOM plan includes disallowed commands or paths", async () => {
    const collectHardware = sinon.stub().resolves({
      bomFormat: "CycloneDX",
      components: [],
      dependencies: [],
      metadata: {
        timestamp: "2026-05-13T00:00:00.000Z",
        tools: {
          components: [],
        },
      },
      specVersion: "1.7",
      version: 1,
    });
    let preflightTrace;
    collectHardware.onFirstCall().callsFake(async (options) => {
      preflightTrace = options.trace;
      preflightTrace.activities.push(
        {
          command: "/usr/sbin/system_profiler",
          id: "system-profiler-json",
          kind: "command",
          target: "/usr/sbin/system_profiler SPHardwareDataType -json",
        },
        {
          id: "plist-read",
          kind: "file-read",
          path: "/Library/Preferences/SystemConfiguration/preferences.plist",
          target: "/Library/Preferences/SystemConfiguration/preferences.plist",
        },
      );
      return {
        bomFormat: "CycloneDX",
        components: [],
        dependencies: [],
        metadata: {
          timestamp: "2026-05-13T00:00:00.000Z",
          tools: {
            components: [],
          },
        },
        specVersion: "1.7",
        version: 1,
      };
    });

    const recordActivity = sinon.stub();
    const { createHbomDocument: createSecureHbomDocument } = await esmock(
      "./hbom.js",
      {
        "./hbomLoader.js": {
          importHbomModule: sinon.stub().resolves({
            collectHardware,
            createCollectorTrace: sinon
              .stub()
              .callsFake(() => ({ activities: [] })),
            getCollectorTrace: sinon.stub().callsFake(() => preflightTrace),
          }),
        },
        "./source.js": {
          isAllowedPath: sinon.stub().returns(false),
        },
        "../core/activity.js": {
          isDryRun: false,
          isSecureMode: true,
          readEnvironmentVariable: sinon.stub().callsFake((name) => {
            if (name === "CDXGEN_ALLOWED_COMMANDS") {
              return "sysctl";
            }
            if (name === "CDXGEN_ALLOWED_PATHS") {
              return "/Users/example/allowed";
            }
            return undefined;
          }),
          recordActivity,
        },
      },
    );

    await assert.rejects(
      () =>
        createSecureHbomDocument({
          platform: "darwin",
          arch: "arm64",
          specVersion: 1.7,
        }),
      /Commands not allowed by CDXGEN_ALLOWED_COMMANDS:[\s\S]*\/usr\/sbin\/system_profiler[\s\S]*Paths not allowed by CDXGEN_ALLOWED_PATHS:[\s\S]*preferences\.plist/u,
    );
    sinon.assert.calledOnce(collectHardware);
    sinon.assert.calledTwice(recordActivity);
    sinon.assert.calledWithMatch(recordActivity.firstCall, {
      kind: "policy",
      policyType: "hbom-command-allowlist",
      status: "blocked",
      target: "/usr/sbin/system_profiler",
    });
    sinon.assert.calledWithMatch(recordActivity.secondCall, {
      kind: "policy",
      policyType: "hbom-path-allowlist",
      status: "blocked",
      target: "/Library/Preferences/SystemConfiguration/preferences.plist",
    });
  });

  it("skips secure-mode allowlist preflight when the caller explicitly requested dry-run mode", async () => {
    const collectHardware = sinon.stub().resolves({
      bomFormat: "CycloneDX",
      components: [],
      dependencies: [],
      metadata: {
        timestamp: "2026-05-13T00:00:00.000Z",
        tools: {
          components: [],
        },
      },
      specVersion: "1.7",
      version: 1,
    });
    const { createHbomDocument: createDryRunHbomDocument } = await esmock(
      "./hbom.js",
      {
        "./hbomLoader.js": {
          importHbomModule: sinon.stub().resolves({
            collectHardware,
            createCollectorTrace: sinon
              .stub()
              .callsFake(() => ({ activities: [] })),
          }),
        },
        "./source.js": {
          isAllowedPath: sinon.stub().returns(false),
        },
        "../core/activity.js": {
          isDryRun: true,
          isSecureMode: true,
          readEnvironmentVariable: sinon.stub().callsFake((name) => {
            if (name === "CDXGEN_ALLOWED_COMMANDS") {
              return "sysctl";
            }
            if (name === "CDXGEN_ALLOWED_PATHS") {
              return "/Users/example/allowed";
            }
            return undefined;
          }),
          recordActivity: sinon.stub(),
        },
      },
    );

    const bomJson = await createDryRunHbomDocument({
      platform: "darwin",
      arch: "arm64",
      specVersion: 1.7,
    });

    sinon.assert.calledOnce(collectHardware);
    assert.strictEqual(bomJson.bomFormat, "CycloneDX");
  });

  it("blocks secure-mode privileged Linux collection when the plan can retry with sudo but sudo is not allowlisted", async () => {
    const collectHardware = sinon.stub().resolves({
      bomFormat: "CycloneDX",
      components: [],
      dependencies: [],
      metadata: {
        timestamp: "2026-05-13T00:00:00.000Z",
        tools: {
          components: [],
        },
      },
      specVersion: "1.7",
      version: 1,
    });
    const recordActivity = sinon.stub();
    const { createHbomDocument: createSecureHbomDocument } = await esmock(
      "./hbom.js",
      {
        "./hbomLoader.js": {
          importHbomModule: sinon.stub().resolves({
            collectHardware,
            getCommandPlan: sinon.stub().returns([
              {
                args: ["-j"],
                command: "drm_info",
                id: "drm-info-json",
                sudoRetryOnPermissionDenied: true,
              },
            ]),
          }),
        },
        "./source.js": {
          isAllowedPath: sinon.stub().returns(true),
        },
        "../core/activity.js": {
          isDryRun: false,
          isSecureMode: true,
          readEnvironmentVariable: sinon.stub().callsFake((name) => {
            if (name === "CDXGEN_ALLOWED_COMMANDS") {
              return "drm_info";
            }
            return undefined;
          }),
          recordActivity,
        },
      },
    );

    await assert.rejects(
      () =>
        createSecureHbomDocument({
          arch: "amd64",
          platform: "linux",
          privileged: true,
          specVersion: 1.7,
        }),
      /Commands not allowed by CDXGEN_ALLOWED_COMMANDS:[\s\S]*- sudo — ids=drm-info-json:sudo-retry; targets=sudo -n drm_info -j/u,
    );
    sinon.assert.notCalled(collectHardware);
    sinon.assert.calledOnce(recordActivity);
    sinon.assert.calledWithMatch(recordActivity, {
      kind: "policy",
      policyType: "hbom-command-allowlist",
      status: "blocked",
      target: "sudo",
    });
  });
});

// These run against the real cdx-hbom command plans, which are pure data, so
// the Windows rows are exercised on every host operating system.
describe("hbom secure-mode preflight and dry-run on Windows", () => {
  const emptyHbomDocument = () => ({
    bomFormat: "CycloneDX",
    components: [],
    dependencies: [],
    metadata: {
      timestamp: "2026-10-20T00:00:00.000Z",
      tools: { components: [] },
    },
    specVersion: "1.7",
    version: 1,
  });

  // Overrides process.platform only for the awaited action, so cdx-hbom's
  // call-time platform checks see the requested host.
  async function withPlatform(platform, action) {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      ...descriptor,
      value: platform,
    });
    try {
      return await action();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  }

  async function createSecureFactory(allowedCommands) {
    const collectHardware = sinon.stub().resolves(emptyHbomDocument());
    const recordActivity = sinon.stub();
    const realHbomModule = await importHbomModule();
    const { createHbomDocument } = await esmock("./hbom.js", {
      "./hbomLoader.js": {
        importHbomModule: sinon
          .stub()
          .resolves({ ...realHbomModule, collectHardware }),
      },
      "./source.js": { isAllowedPath: sinon.stub().returns(true) },
      "../core/activity.js": {
        isDryRun: false,
        isSecureMode: true,
        readEnvironmentVariable: sinon
          .stub()
          .callsFake((name) =>
            name === "CDXGEN_ALLOWED_COMMANDS" ? allowedCommands : undefined,
          ),
        recordActivity,
      },
    });
    return { collectHardware, createHbomDocument, recordActivity };
  }

  it("blocks a Windows plan when powershell.exe is not allowlisted and keeps the scripts out of the message", async () => {
    const { collectHardware, createHbomDocument, recordActivity } =
      await createSecureFactory("git,sysctl");

    await assert.rejects(
      () =>
        createHbomDocument({
          arch: "amd64",
          platform: "windows",
          specVersion: 1.7,
        }),
      (error) => {
        assert.match(
          error.message,
          /Commands not allowed by CDXGEN_ALLOWED_COMMANDS:/u,
        );
        assert.match(
          error.message,
          /powershell\.exe \(basename: powershell\.exe\)/iu,
        );
        assert.match(
          error.message,
          /ids=windows-cim-platform,windows-cim-storage-network,windows-cim-display-media,windows-pnp-devices,windows-cim-trust,windows-cim-privileged;/u,
        );
        assert.match(error.message, /script sha256:[0-9a-f]{12}/u);
        assert.doesNotMatch(
          error.message,
          /SilentlyContinue|Get-CimInstance|ConvertTo-Json/u,
        );
        assert.ok(
          error.message.length < 4000,
          `the preflight error must stay readable, got ${error.message.length} characters`,
        );
        return true;
      },
    );
    sinon.assert.notCalled(collectHardware);
    sinon.assert.calledOnce(recordActivity);
    sinon.assert.calledWithMatch(recordActivity, {
      kind: "policy",
      policyType: "hbom-command-allowlist",
      status: "blocked",
      target: sinon.match(/powershell\.exe$/iu),
    });
  });

  it("lets Windows collection proceed when powershell.exe is allowlisted by name or by path", async () => {
    const plan = (await importHbomModule()).getCommandPlan({
      architecture: "amd64",
      platform: "windows",
    });
    const planned = plan[0].command;
    for (const allowlist of [
      "powershell.exe",
      "git, powershell.exe",
      planned,
    ]) {
      const { collectHardware, createHbomDocument, recordActivity } =
        await createSecureFactory(allowlist);
      const bomJson = await createHbomDocument({
        arch: "amd64",
        platform: "windows",
        specVersion: 1.7,
      });
      assert.strictEqual(bomJson.bomFormat, "CycloneDX", allowlist);
      sinon.assert.calledOnce(collectHardware);
      sinon.assert.notCalled(recordActivity);
    }
  });

  it("matches the Windows allowlist as strictly as cdx-hbom does when it spawns", async () => {
    // cdx-hbom compares case-sensitively at spawn time. A looser preflight
    // would let these through and then silently run nothing, so they block.
    const planned = (await importHbomModule()).getCommandPlan({
      architecture: "amd64",
      platform: "windows",
    })[0].command;
    for (const allowlist of [
      "PowerShell.EXE",
      "POWERSHELL.EXE",
      planned.toUpperCase(),
      planned.replace("powershell.exe", "pwsh.exe"),
    ]) {
      const { collectHardware, createHbomDocument } =
        await createSecureFactory(allowlist);
      await assert.rejects(
        () =>
          createHbomDocument({
            arch: "amd64",
            platform: "windows",
            specVersion: 1.7,
          }),
        /Commands not allowed by CDXGEN_ALLOWED_COMMANDS:/u,
        allowlist,
      );
      sinon.assert.notCalled(collectHardware);
    }
  });

  it("does not let --no-command-enrichment skip the check where commands still run", async () => {
    // Windows always runs windows-cim-platform and Darwin ignores the option.
    for (const [platform, arch, command] of [
      ["windows", "amd64", /powershell\.exe/iu],
      ["darwin", "arm64", /system_profiler/u],
    ]) {
      const { collectHardware, createHbomDocument } =
        await createSecureFactory("git");
      await assert.rejects(
        () =>
          createHbomDocument({
            arch,
            noCommandEnrichment: true,
            platform,
            specVersion: 1.7,
          }),
        command,
        platform,
      );
      sinon.assert.notCalled(collectHardware);
    }
  });

  it("exempts only a Linux collector that runs no command from the check", async () => {
    const lean = await createSecureFactory("git");
    await lean.createHbomDocument({
      arch: "amd64",
      noCommandEnrichment: true,
      platform: "linux",
      specVersion: 1.7,
    });
    sinon.assert.calledOnce(lean.collectHardware);

    // dmidecode runs outside the enrichment switch once privileged
    const privileged = await createSecureFactory("git");
    await assert.rejects(
      () =>
        privileged.createHbomDocument({
          arch: "amd64",
          noCommandEnrichment: true,
          platform: "linux",
          privileged: true,
          specVersion: 1.7,
        }),
      /dmidecode/u,
    );
    sinon.assert.notCalled(privileged.collectHardware);
  });

  it("targets the host platform when none is requested", async () => {
    const { collectHardware, createHbomDocument } =
      await createSecureFactory("git");
    await assert.rejects(
      () =>
        withPlatform("win32", () =>
          createHbomDocument({ arch: "amd64", specVersion: 1.7 }),
        ),
      /powershell\.exe/iu,
    );
    sinon.assert.notCalled(collectHardware);
  });

  async function dryRunWindows(extraOptions = {}) {
    const recordActivity = sinon.stub();
    const realHbomModule = await importHbomModule();
    const { createHbomDocument } = await esmock("./hbom.js", {
      "./hbomLoader.js": {
        importHbomModule: sinon.stub().resolves(realHbomModule),
      },
      "../core/activity.js": { isDryRun: true, recordActivity },
    });
    const bomJson = await withPlatform("win32", () =>
      createHbomDocument({
        arch: "amd64",
        platform: "windows",
        specVersion: 1.7,
        ...extraOptions,
      }),
    );
    const rows = recordActivity
      .getCalls()
      .map((call) => call.args[0])
      .filter((activity) => activity.kind === "execute");
    return { bomJson, rows };
  }

  it("reports a Windows dry-run as blocked command rows with digest targets and no diagnostics", async () => {
    const { bomJson, rows } = await dryRunWindows();

    assert.deepStrictEqual(
      rows.map((row) => row.commandId),
      [
        "windows-cim-platform",
        "windows-cim-storage-network",
        "windows-cim-display-media",
        "windows-pnp-devices",
        "windows-cim-trust",
      ],
    );
    for (const row of rows) {
      assert.strictEqual(row.status, "blocked", row.commandId);
      assert.match(row.reason, /Dry run mode blocks HBOM command/u);
      assert.match(
        row.target,
        /powershell\.exe -Command windows-[a-z-]+ script sha256:[0-9a-f]{12}$/iu,
      );
    }
    assert.strictEqual(
      getPropertyValue(bomJson, "cdx:hbom:targetPlatform"),
      "windows",
    );
    assert.ok(bomJson.components.length >= 1);
    for (const counter of [
      "commandDiagnosticCount",
      "commandErrorCount",
      "permissionDeniedCount",
      "partialSupportCount",
      "timeoutCount",
    ]) {
      assert.strictEqual(
        getPropertyValue(bomJson, `cdx:hbom:analysis:${counter}`),
        "0",
        counter,
      );
    }
  });

  it("adds the privileged batch to a Windows dry-run only on request and trims it with --no-command-enrichment", async () => {
    const privileged = await dryRunWindows({ privileged: true });
    assert.deepStrictEqual(
      privileged.rows.map((row) => row.commandId).slice(-1),
      ["windows-cim-privileged"],
    );
    assert.strictEqual(privileged.rows.length, 6);

    const lean = await dryRunWindows({ noCommandEnrichment: true });
    assert.deepStrictEqual(
      lean.rows.map((row) => row.commandId),
      ["windows-cim-platform"],
    );
  });
});
