import { assert, describe, it } from "poku";

import {
  formatHbomHardwareClassSummary,
  getHbomCommandDiagnosticSummary,
  getHbomHardwareClassCounts,
  getHbomSummary,
  isHbomLikeBom,
} from "./hbomAnalysis.js";

describe("hbomAnalysis helpers", () => {
  const hbomFixture = {
    metadata: {
      component: {
        name: "demo-host",
        type: "device",
        manufacturer: { name: "Example Corp" },
        properties: [
          { name: "cdx:hbom:platform", value: "linux" },
          { name: "cdx:hbom:architecture", value: "amd64" },
          { name: "cdx:hbom:identifierPolicy", value: "redacted-by-default" },
        ],
      },
    },
    components: [
      {
        name: "eth0",
        properties: [
          { name: "cdx:hbom:hardwareClass", value: "network-interface" },
        ],
      },
      {
        name: "wlan0",
        properties: [
          { name: "cdx:hbom:hardwareClass", value: "network-interface" },
        ],
      },
      {
        name: "nvme0",
        properties: [{ name: "cdx:hbom:hardwareClass", value: "storage" }],
      },
      {
        name: "BAT0",
        properties: [{ name: "cdx:hbom:hardwareClass", value: "power" }],
      },
    ],
    properties: [
      { name: "cdx:hbom:collectorProfile", value: "linux-amd64-v1" },
      { name: "cdx:hbom:targetPlatform", value: "linux" },
      { name: "cdx:hbom:targetArchitecture", value: "amd64" },
      { name: "cdx:hbom:evidence:commandCount", value: "2" },
      {
        name: "cdx:hbom:evidence:command",
        value: "lscpu-json|cpu-memory|/usr/bin/lscpu -J",
      },
      {
        name: "cdx:hbom:evidence:command",
        value: "ip-link-json|network|/usr/sbin/ip -j link",
      },
      { name: "cdx:hbom:evidence:commandDiagnosticCount", value: "2" },
      {
        name: "cdx:hbom:evidence:commandDiagnostic",
        value: JSON.stringify({
          command: "lsusb",
          id: "lsusb",
          installHint:
            "Command not found: install the Linux package providing lsusb (commonly `usbutils`).",
          issue: "missing-command",
          message: "lsusb failed with missing-command",
        }),
      },
      {
        name: "cdx:hbom:evidence:commandDiagnostic",
        value: JSON.stringify({
          command: "drm_info",
          id: "drm-info-json",
          issue: "permission-denied",
          message: "drm_info failed with permission-denied",
          privilegeHint:
            "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.",
        }),
      },
      { name: "cdx:hbom:evidence:fileCount", value: "1" },
      { name: "cdx:hbom:evidence:file", value: "/etc/os-release" },
    ],
  };

  it("detects HBOMs from document and component properties", () => {
    assert.strictEqual(isHbomLikeBom(hbomFixture), true);
    assert.strictEqual(
      isHbomLikeBom({ metadata: { component: { type: "application" } } }),
      false,
    );
  });

  it("summarizes hardware classes and evidence", () => {
    assert.deepStrictEqual(getHbomHardwareClassCounts(hbomFixture.components), [
      { hardwareClass: "network-interface", count: 2 },
      { hardwareClass: "power", count: 1 },
      { hardwareClass: "storage", count: 1 },
    ]);
    assert.strictEqual(
      formatHbomHardwareClassSummary(
        getHbomHardwareClassCounts(hbomFixture.components),
      ),
      "network-interface (2), power (1), storage (1)",
    );

    assert.deepStrictEqual(getHbomCommandDiagnosticSummary(hbomFixture), {
      actionableDiagnosticCount: 2,
      commandDiagnosticCount: 2,
      commandDiagnostics: [
        {
          command: "lsusb",
          id: "lsusb",
          installHint:
            "Command not found: install the Linux package providing lsusb (commonly `usbutils`).",
          issue: "missing-command",
          message: "lsusb failed with missing-command",
        },
        {
          command: "drm_info",
          id: "drm-info-json",
          issue: "permission-denied",
          message: "drm_info failed with permission-denied",
          privilegeHint:
            "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.",
        },
      ],
      commandErrorCount: 0,
      commandErrorIds: [],
      diagnosticIssues: ["missing-command", "permission-denied"],
      installHintCount: 1,
      installHints: [
        "Command not found: install the Linux package providing lsusb (commonly `usbutils`).",
      ],
      missingCommandCount: 1,
      missingCommandIds: ["lsusb"],
      missingCommands: ["lsusb"],
      partialSupportCount: 0,
      partialSupportIds: [],
      permissionDeniedCommands: ["drm_info"],
      permissionDeniedCount: 1,
      permissionDeniedIds: ["drm-info-json"],
      privilegeHintCount: 1,
      privilegeHints: [
        "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.",
      ],
      requiresPrivilegedEnrichment: true,
      timeoutIds: [],
      timeoutCount: 0,
    });

    assert.deepStrictEqual(getHbomSummary(hbomFixture), {
      actionableDiagnosticCount: 2,
      architecture: "amd64",
      collectorProfile: "linux-amd64-v1",
      commandDiagnosticCount: 2,
      commandDiagnostics: [
        {
          command: "lsusb",
          id: "lsusb",
          installHint:
            "Command not found: install the Linux package providing lsusb (commonly `usbutils`).",
          issue: "missing-command",
          message: "lsusb failed with missing-command",
        },
        {
          command: "drm_info",
          id: "drm-info-json",
          issue: "permission-denied",
          message: "drm_info failed with permission-denied",
          privilegeHint:
            "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.",
        },
      ],
      commandErrorCount: 0,
      commandErrorIds: [],
      componentCount: 4,
      diagnosticIssues: ["missing-command", "permission-denied"],
      evidenceCommandCount: 2,
      evidenceCommands: [
        "lscpu-json|cpu-memory|/usr/bin/lscpu -J",
        "ip-link-json|network|/usr/sbin/ip -j link",
      ],
      evidenceFileCount: 1,
      evidenceFiles: ["/etc/os-release"],
      hardwareClassCount: 3,
      hardwareClassCounts: [
        { hardwareClass: "network-interface", count: 2 },
        { hardwareClass: "power", count: 1 },
        { hardwareClass: "storage", count: 1 },
      ],
      identifierPolicy: "redacted-by-default",
      installHintCount: 1,
      installHints: [
        "Command not found: install the Linux package providing lsusb (commonly `usbutils`).",
      ],
      manufacturer: "Example Corp",
      metadataName: "demo-host",
      metadataType: "device",
      missingCommandCount: 1,
      missingCommandIds: ["lsusb"],
      missingCommands: ["lsusb"],
      partialSupportCount: 0,
      partialSupportIds: [],
      platform: "linux",
      permissionDeniedCommands: ["drm_info"],
      permissionDeniedCount: 1,
      permissionDeniedIds: ["drm-info-json"],
      privilegeHintCount: 1,
      privilegeHints: [
        "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.",
      ],
      requiresPrivilegedEnrichment: true,
      timeoutIds: [],
      timeoutCount: 0,
      topHardwareClasses: [
        { hardwareClass: "network-interface", count: 2 },
        { hardwareClass: "power", count: 1 },
        { hardwareClass: "storage", count: 1 },
      ],
    });
  });
});
