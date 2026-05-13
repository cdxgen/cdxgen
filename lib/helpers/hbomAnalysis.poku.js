import { assert, describe, it } from "poku";

import {
  formatHbomHardwareClassSummary,
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

    assert.deepStrictEqual(getHbomSummary(hbomFixture), {
      architecture: "amd64",
      collectorProfile: "linux-amd64-v1",
      componentCount: 4,
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
      manufacturer: "Example Corp",
      metadataName: "demo-host",
      metadataType: "device",
      platform: "linux",
      topHardwareClasses: [
        { hardwareClass: "network-interface", count: 2 },
        { hardwareClass: "power", count: 1 },
        { hardwareClass: "storage", count: 1 },
      ],
    });
  });
});
