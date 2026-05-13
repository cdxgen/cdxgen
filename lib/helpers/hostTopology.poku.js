import { assert, describe, it } from "poku";

import {
  applyHostInventoryTopology,
  getHostViewSummary,
  isMergedHostViewBom,
  mergeHostInventoryBoms,
} from "./hostTopology.js";

function makeProperty(name, value) {
  return { name, value };
}

function makeHbomComponent(name, hardwareClass, properties = []) {
  return {
    type: "device",
    name,
    properties: [
      makeProperty("cdx:hbom:hardwareClass", hardwareClass),
      ...properties,
    ],
  };
}

function makeOsqueryComponent(
  name,
  queryCategory,
  properties = [],
  extra = {},
) {
  return {
    type: extra.type || "data",
    name,
    version: extra.version || "",
    "bom-ref": extra.bomRef || `osquery:${queryCategory}:${name}`,
    properties: [
      makeProperty("cdx:osquery:category", queryCategory),
      ...properties,
    ],
  };
}

describe("host topology helpers", () => {
  it("adds strict HBOM topology dependencies for standalone hardware BOMs", () => {
    const bomJson = applyHostInventoryTopology({
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      metadata: {
        component: {
          name: "host-a",
          type: "device",
          properties: [
            makeProperty("cdx:hbom:platform", "linux"),
            makeProperty("cdx:hbom:architecture", "amd64"),
          ],
        },
      },
      components: [
        makeHbomComponent("wlp2s0", "network-interface", [
          makeProperty("cdx:hbom:driver", "iwlwifi"),
        ]),
        makeHbomComponent("CT1000P3PSSD8", "storage"),
      ],
      dependencies: [],
    });

    assert.ok(bomJson.metadata.component["bom-ref"]);
    assert.ok(bomJson.components.every((component) => component["bom-ref"]));
    assert.strictEqual(getHostViewSummary(bomJson).mode, "hbom-topology");
    assert.strictEqual(getHostViewSummary(bomJson).runtimeAnchorCount, 0);
    assert.strictEqual(
      bomJson.dependencies.find(
        (dependency) =>
          dependency.ref === bomJson.metadata.component["bom-ref"],
      )?.dependsOn?.length,
      2,
    );
  });

  it("merges OBOM runtime data and links hardware to runtime components without guesswork", () => {
    const hbomJson = {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      metadata: {
        component: {
          name: "host-b",
          type: "device",
          properties: [
            makeProperty("cdx:hbom:platform", "linux"),
            makeProperty("cdx:hbom:architecture", "amd64"),
            makeProperty("cdx:hbom:secureBootDbSha1", "db-cert-1"),
          ],
        },
      },
      components: [
        makeHbomComponent("enp1s0", "network-interface", [
          makeProperty("cdx:hbom:driver", "r8169"),
          makeProperty("cdx:hbom:speedMbps", "100"),
        ]),
        makeHbomComponent("CT1000P3PSSD8", "storage", [
          makeProperty("cdx:hbom:deviceNode", "/dev/nvme0n1"),
          makeProperty("cdx:hbom:mountPoint", "/home"),
        ]),
      ],
      dependencies: [],
      properties: [],
    };
    const obomData = {
      parentComponent: {
        type: "operating-system",
        name: "Ubuntu",
        version: "24.04",
        "bom-ref": "pkg:generic/ubuntu@24.04",
      },
      bomJson: {
        bomFormat: "CycloneDX",
        specVersion: "1.7",
        metadata: {
          tools: {
            components: [
              {
                type: "application",
                name: "osquery",
                version: "5.12.0",
                "bom-ref": "pkg:generic/osquery@5.12.0",
              },
            ],
          },
        },
        components: [
          makeOsqueryComponent("192.168.1.23", "interface_addresses", [
            makeProperty("interface", "enp1s0"),
            makeProperty("address", "192.168.1.23"),
          ]),
          makeOsqueryComponent("r8169", "kernel_modules", [], {
            type: "data",
          }),
          makeOsqueryComponent("iwlwifi", "kernel_modules", [], {
            type: "data",
          }),
          makeOsqueryComponent("/home", "mount_hardening", [
            makeProperty("device", "/dev/nvme0n1"),
            makeProperty("path", "/home"),
            makeProperty("flags", "rw,nosuid,nodev"),
          ]),
          makeOsqueryComponent("nvme-home", "logical_drives", [
            makeProperty("device_id", "/dev/nvme0n1"),
            makeProperty("description", "home"),
          ]),
          makeOsqueryComponent("db-cert", "secureboot_certificates", [
            makeProperty("sha1", "db-cert-1"),
            makeProperty("subject", "CN=Platform DB"),
          ]),
        ],
        dependencies: [
          {
            ref: "pkg:generic/ubuntu@24.04",
            dependsOn: [
              "osquery:interface_addresses:192.168.1.23",
              "osquery:kernel_modules:r8169",
            ],
          },
        ],
      },
    };

    const mergedBomJson = mergeHostInventoryBoms(hbomJson, obomData);
    const networkComponent = mergedBomJson.components.find(
      (component) => component.name === "enp1s0",
    );
    const networkDependency = mergedBomJson.dependencies.find(
      (dependency) => dependency.ref === networkComponent["bom-ref"],
    );
    const storageComponent = mergedBomJson.components.find(
      (component) => component.name === "CT1000P3PSSD8",
    );
    const storageDependency = mergedBomJson.dependencies.find(
      (dependency) => dependency.ref === storageComponent["bom-ref"],
    );
    const hostDependency = mergedBomJson.dependencies.find(
      (dependency) =>
        dependency.ref === mergedBomJson.metadata.component["bom-ref"],
    );
    const summary = getHostViewSummary(mergedBomJson);

    assert.strictEqual(isMergedHostViewBom(mergedBomJson), true);
    assert.ok(networkComponent["bom-ref"]);
    assert.ok(networkDependency);
    assert.deepStrictEqual(networkDependency.dependsOn, [
      "osquery:interface_addresses:192.168.1.23",
      "osquery:kernel_modules:r8169",
    ]);
    assert.deepStrictEqual(storageDependency.dependsOn, [
      "osquery:logical_drives:nvme-home",
      "osquery:mount_hardening:/home",
    ]);
    assert.ok(
      hostDependency.dependsOn.includes(
        "osquery:secureboot_certificates:db-cert",
      ),
    );
    assert.strictEqual(
      networkComponent.properties.find(
        (property) =>
          property.name === "cdx:hostview:interface_addresses:count",
      )?.value,
      "1",
    );
    assert.strictEqual(
      networkComponent.properties.find(
        (property) => property.name === "cdx:hostview:kernel_modules:count",
      )?.value,
      "1",
    );
    assert.strictEqual(
      storageComponent.properties.find(
        (property) => property.name === "cdx:hostview:mount_hardening:count",
      )?.value,
      "1",
    );
    assert.strictEqual(
      storageComponent.properties.find(
        (property) => property.name === "cdx:hostview:runtime-storage:count",
      )?.value,
      "1",
    );
    assert.strictEqual(
      mergedBomJson.metadata.component.properties.find(
        (property) =>
          property.name === "cdx:hostview:secureboot_certificates:count",
      )?.value,
      "1",
    );
    assert.strictEqual(summary.mode, "hbom-obom-merged");
    assert.strictEqual(summary.runtimeAnchorCount, 1);
    assert.strictEqual(summary.runtimeComponentCount, 6);
    assert.strictEqual(summary.topologyLinkCount, 5);
    assert.deepStrictEqual(summary.linkedRuntimeCategories, [
      "interface_addresses",
      "kernel_modules",
      "mount_hardening",
      "runtime-storage",
      "secureboot_certificates",
    ]);
  });

  it("links host trust metadata to secure boot certificates only when exact identifiers match", () => {
    const mergedBomJson = mergeHostInventoryBoms(
      {
        bomFormat: "CycloneDX",
        specVersion: "1.7",
        metadata: {
          component: {
            name: "host-trust",
            type: "device",
            properties: [
              makeProperty("cdx:hbom:platform", "linux"),
              makeProperty(
                "cdx:hbom:secureBootSubjectKeyId",
                "trust-anchor-42",
              ),
            ],
          },
        },
        components: [],
        dependencies: [],
        properties: [],
      },
      {
        bomJson: {
          bomFormat: "CycloneDX",
          specVersion: "1.7",
          metadata: {},
          components: [
            makeOsqueryComponent("db-anchor", "secureboot_certificates", [
              makeProperty("subject_key_id", "trust-anchor-42"),
              makeProperty("issuer", "CN=Firmware CA"),
            ]),
          ],
          dependencies: [],
          properties: [],
        },
      },
    );

    const hostDependency = mergedBomJson.dependencies.find(
      (dependency) =>
        dependency.ref === mergedBomJson.metadata.component["bom-ref"],
    );
    const summary = getHostViewSummary(mergedBomJson);

    assert.ok(hostDependency);
    assert.deepStrictEqual(hostDependency.dependsOn, [
      "osquery:secureboot_certificates:db-anchor",
    ]);
    assert.strictEqual(
      mergedBomJson.metadata.component.properties.find(
        (property) =>
          property.name === "cdx:hostview:secureboot_certificates:count",
      )?.value,
      "1",
    );
    assert.ok(
      summary.linkedRuntimeCategories.includes("secureboot_certificates"),
    );
    assert.strictEqual(summary.topologyLinkCount, 1);
  });

  it("does not create runtime links when there is no exact identifier match", () => {
    const hbomJson = {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      metadata: {
        component: {
          name: "host-c",
          type: "device",
          properties: [makeProperty("cdx:hbom:platform", "linux")],
        },
      },
      components: [
        makeHbomComponent("enp1s0", "network-interface", [
          makeProperty("cdx:hbom:driver", "r8169"),
        ]),
      ],
      dependencies: [],
      properties: [],
    };
    const obomData = {
      bomJson: {
        metadata: {},
        components: [
          makeOsqueryComponent("192.168.1.24", "interface_addresses", [
            makeProperty("interface", "eth9"),
          ]),
          makeOsqueryComponent("iwlwifi", "kernel_modules"),
        ],
        dependencies: [],
        properties: [],
      },
    };

    const mergedBomJson = mergeHostInventoryBoms(hbomJson, obomData);
    const networkComponent = mergedBomJson.components.find(
      (component) => component.name === "enp1s0",
    );
    const summary = getHostViewSummary(mergedBomJson);

    assert.strictEqual(
      mergedBomJson.dependencies.some(
        (dependency) => dependency.ref === networkComponent["bom-ref"],
      ),
      false,
    );
    assert.strictEqual(
      networkComponent.properties.some((property) =>
        property.name.startsWith("cdx:hostview:"),
      ),
      false,
    );
    assert.strictEqual(summary.topologyLinkCount, 0);
    assert.strictEqual(summary.linkedHardwareComponentCount, 0);
  });
});
