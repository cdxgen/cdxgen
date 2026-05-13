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

  it("enforces CycloneDX 1.7 for hbom generation", () => {
    ensureSupportedHbomSpecVersion(undefined);
    ensureSupportedHbomSpecVersion(1.7);
    assert.throws(
      () => ensureSupportedHbomSpecVersion(1.6),
      /only CycloneDX 1\.7/u,
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
        timeoutMs: 2500,
      },
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
      "./utils.js": {
        isDryRun: true,
        recordActivity,
      },
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
      "./utils.js": {
        isDryRun: true,
        recordActivity,
      },
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
        "./utils.js": {
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
        "./utils.js": {
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
        "./utils.js": {
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
