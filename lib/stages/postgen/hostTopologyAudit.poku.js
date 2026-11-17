import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { mergeHostInventoryBoms } from "../../inventory/hostTopology.js";
import {
  annotateJavaProcessOptions,
  linkJdkProcessRows,
} from "../../inventory/jdkHostProbe.js";
import {
  createJdkComponent,
  jdkIdentityFromRelease,
  parseJdkRelease,
} from "../../inventory/jdkIdentity.js";
import { evaluateRule, loadRules } from "./ruleEngine.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RULES_DIR = join(__dirname, "..", "..", "..", "data", "rules");

function makeProperty(name, value) {
  return { name, value };
}

function makeHostBom(
  components = [],
  metadataProperties = [],
  bomProperties = [],
) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    serialNumber: "urn:uuid:test-host-view",
    metadata: {
      tools: {
        components: [
          {
            type: "application",
            name: "cdxgen",
            version: "12.4.0",
            "bom-ref": "pkg:npm/%40cyclonedx/cdxgen@12.4.0",
          },
        ],
      },
      component: {
        name: "test-host",
        type: "device",
        "bom-ref": "urn:uuid:test-host",
        properties: metadataProperties.map(([k, v]) => makeProperty(k, v)),
      },
    },
    components,
    properties: bomProperties.map(([k, v]) => makeProperty(k, v)),
  };
}

function makeHbomComponent(name, hardwareClass, properties = []) {
  return {
    type: "device",
    name,
    "bom-ref": `urn:uuid:${hardwareClass}:${name}`,
    properties: [
      makeProperty("cdx:hbom:hardwareClass", hardwareClass),
      ...properties.map(([k, v]) => makeProperty(k, v)),
    ],
  };
}

function makeOsqueryComponent(name, queryCategory, properties = []) {
  return {
    type: "data",
    name,
    "bom-ref": `osquery:${queryCategory}:${name}`,
    properties: [
      makeProperty("cdx:osquery:category", queryCategory),
      ...properties.map(([k, v]) => makeProperty(k, v)),
    ],
  };
}

describe("host-topology audit rules", () => {
  it("detects weak wireless security when live runtime addresses confirm the link is active (HMX-002)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((candidate) => candidate.id === "HMX-002");
    assert.ok(rule, "HMX-002 should be present");

    const bom = makeHostBom(
      [
        makeHbomComponent("wlp2s0", "wireless-adapter", [
          ["cdx:hbom:securityMode", "open"],
          ["cdx:hostview:interface_addresses:count", "1"],
          ["cdx:hostview:linkedRuntimeCategory", "interface_addresses"],
        ]),
        makeOsqueryComponent("192.168.1.55", "interface_addresses", [
          ["interface", "wlp2s0"],
          ["address", "192.168.1.55"],
        ]),
      ],
      [["cdx:hbom:platform", "linux"]],
      [
        ["cdx:hostview:mode", "hbom-obom-merged"],
        ["cdx:hostview:topologyLinkCount", "1"],
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].ruleId, "HMX-002");
  });

  it("detects merged host inventories that still have zero strict topology links (HMX-003)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((candidate) => candidate.id === "HMX-003");
    assert.ok(rule, "HMX-003 should be present");

    const bom = makeHostBom(
      [makeHbomComponent("enp1s0", "network-interface")],
      [
        ["cdx:hbom:platform", "linux"],
        ["cdx:hostview:mode", "hbom-obom-merged"],
        ["cdx:hostview:hardwareComponentCount", "1"],
        ["cdx:hostview:runtimeComponentCount", "2"],
        ["cdx:hostview:topologyLinkCount", "0"],
      ],
      [
        ["cdx:hostview:mode", "hbom-obom-merged"],
        ["cdx:hostview:hardwareComponentCount", "1"],
        ["cdx:hostview:runtimeComponentCount", "2"],
        ["cdx:hostview:topologyLinkCount", "0"],
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].ruleId, "HMX-003");
  });

  it("detects degraded storage when explicit runtime mount evidence shows the device is in use (HMX-004)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((candidate) => candidate.id === "HMX-004");
    assert.ok(rule, "HMX-004 should be present");

    const bom = makeHostBom(
      [
        makeHbomComponent("nvme0", "storage", [
          ["cdx:hbom:smartStatus", "Failing"],
          ["cdx:hbom:wearPercentageUsed", "92"],
          ["cdx:hostview:mount_hardening:count", "1"],
          ["cdx:hostview:runtime-storage:count", "1"],
        ]),
        makeOsqueryComponent("/home", "mount_hardening", [
          ["device", "/dev/nvme0n1"],
          ["path", "/home"],
        ]),
      ],
      [["cdx:hbom:platform", "linux"]],
      [
        ["cdx:hostview:mode", "hbom-obom-merged"],
        ["cdx:hostview:topologyLinkCount", "2"],
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].ruleId, "HMX-004");
  });

  it("detects revoked secure boot trust anchors only after an explicit HBOM trust link exists (HMX-005)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((candidate) => candidate.id === "HMX-005");
    assert.ok(rule, "HMX-005 should be present");

    const bom = makeHostBom(
      [
        makeOsqueryComponent("dbx-entry", "secureboot_certificates", [
          ["revoked", "1"],
          ["sha1", "db-cert-1"],
          ["subject", "CN=Legacy Bootloader"],
        ]),
      ],
      [
        ["cdx:hbom:platform", "linux"],
        ["cdx:hostview:secureboot_certificates:count", "1"],
      ],
      [
        ["cdx:hostview:mode", "hbom-obom-merged"],
        ["cdx:hostview:secureboot_certificates:count", "1"],
        ["cdx:hostview:topologyLinkCount", "1"],
      ],
    );

    const findings = await evaluateRule(rule, bom);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].ruleId, "HMX-005");
  });

  // Real Windows captures; see test/data/hbom-windows/README.md.
  const loadWindowsFixture = (name) =>
    JSON.parse(
      readFileSync(
        new URL(`../../../test/data/hbom-windows/${name}`, import.meta.url),
        "utf8",
      ),
    );

  const mergeWindowsHostView = (runtimeComponents) => {
    const hbomJson = loadWindowsFixture("vm-parallels-elevated.json");
    // cdxgen assigns urn:cdxgen refs after the merge, so start from the
    // collector's output without them.
    for (const subject of [
      hbomJson.metadata.component,
      ...hbomJson.components,
    ]) {
      if (subject["bom-ref"]?.startsWith("urn:cdxgen:")) {
        delete subject["bom-ref"];
      }
    }
    return mergeHostInventoryBoms(hbomJson, {
      bomJson: { components: runtimeComponents, dependencies: [] },
    });
  };

  it("does not report a Windows host view whose C: volume links to its logical drive (HMX-003)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((candidate) => candidate.id === "HMX-003");
    assert.ok(rule, "HMX-003 should be present");

    const bom = mergeWindowsHostView(
      loadWindowsFixture("osquery-logical-drives.json").components,
    );

    assert.deepStrictEqual(await evaluateRule(rule, bom), []);
  });

  it("still reports a Windows host view when no runtime evidence matches a volume (HMX-003)", async () => {
    const rules = await loadRules(RULES_DIR);
    const rule = rules.find((candidate) => candidate.id === "HMX-003");
    assert.ok(rule, "HMX-003 should be present");

    // Not captured: a synthetic runtime component with no join key, to prove
    // the rule still fires when the Windows pack yields nothing to link.
    const bom = mergeWindowsHostView([
      makeOsqueryComponent("startup-item", "startup_items", [
        ["name", "OneDrive"],
      ]),
    ]);

    const findings = await evaluateRule(rule, bom);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].ruleId, "HMX-003");
  });
});

describe("Java4Shell host rules (HMX-006, HMX-007)", () => {
  const ICE_LAKE =
    "fpu, sse4_2, avx2, avx512f, avx512dq, avx512bw, avx512vl, avx512vbmi, bmi1, bmi2";
  const ZEN3 = "fpu, sse4_2, avx2, bmi1, bmi2, avx512f_absent_on_zen3";
  const ARM64 = "fp, asimd, evtstrm, aes, pmull, sha1, sha2, crc32, atomics";
  const processor = (features) =>
    makeHbomComponent(
      "CPU",
      "processor",
      features ? [["cdx:hbom:cpuFeatures", features]] : [],
    );
  const jdk = (release, home) =>
    createJdkComponent(jdkIdentityFromRelease(parseJdkRelease(release)), {
      home,
    });
  const TEMURIN_21 =
    'IMPLEMENTOR="Eclipse Adoptium"\nJAVA_RUNTIME_VERSION="21.0.9+10-LTS"\nJAVA_VERSION="21.0.9"\nJVM_VARIANT="Hotspot"\nOS_ARCH="x86_64"\n';
  const run = async (id, bom) => {
    const rules = await loadRules(RULES_DIR);
    return evaluateRule(
      rules.find((candidate) => candidate.id === id),
      bom,
    );
  };

  it("fires critical for an Ice Lake HBOM with an affected JDK", async () => {
    const bom = makeHostBom([
      processor(ICE_LAKE),
      jdk(TEMURIN_21, "/usr/lib/jvm/temurin-21"),
    ]);
    const findings = await run("HMX-006", bom);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, "critical");
    assert.strictEqual((await run("HMX-007", bom)).length, 0);
  });

  it("stays quiet for a Zen 3 HBOM without avx512vbmi", async () => {
    const bom = makeHostBom([
      processor(ZEN3),
      jdk(TEMURIN_21, "/usr/lib/jvm/temurin-21"),
    ]);
    assert.strictEqual((await run("HMX-006", bom)).length, 0);
    assert.strictEqual((await run("HMX-007", bom)).length, 0);
  });

  it("stays quiet for an arm64 HBOM", async () => {
    const bom = makeHostBom([
      processor(ARM64),
      jdk(TEMURIN_21, "/usr/lib/jvm/temurin-21"),
    ]);
    assert.strictEqual((await run("HMX-006", bom)).length, 0);
    assert.strictEqual((await run("HMX-007", bom)).length, 0);
  });

  it("raises the medium companion when the processor lists no features", async () => {
    const bom = makeHostBom([
      processor(undefined),
      jdk(TEMURIN_21, "/usr/lib/jvm/temurin-21"),
    ]);
    assert.strictEqual((await run("HMX-006", bom)).length, 0);
    const findings = await run("HMX-007", bom);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, "medium");
  });

  it("does not count OpenJ9, Semeru or a JDK before 17.0.6", async () => {
    const semeru = jdk(
      'IMPLEMENTOR="IBM Corporation"\nIMPLEMENTOR_VERSION="openj9-0.43"\nJAVA_VERSION="21.0.9"\nJVM_VARIANT="Openj9"\n',
      "/opt/semeru",
    );
    const old = jdk(
      'IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="17.0.5"\nJAVA_RUNTIME_VERSION="17.0.5+8"\n',
      "/opt/jdk17",
    );
    const bom = makeHostBom([processor(ICE_LAKE), semeru, old]);
    assert.strictEqual((await run("HMX-006", bom)).length, 0);
  });

  it("covers a bundled JDK found through a running process, until its options mitigate it", async () => {
    const home =
      "/home/appthreat/nexus/nexus-3.89.0-09/jdk/temurin_21.0.9_10_linux_x86_64";
    const nexusRow = (cmdline) => ({
      ...makeOsqueryComponent("java", "listening_ports", [
        ["path", `${home}/bin/java`],
        ["cmdline", cmdline],
        ["port", "8081"],
      ]),
      version: "0",
    });
    const merge = (row, bundled) =>
      mergeHostInventoryBoms(makeHostBom([processor(ICE_LAKE)]), {
        bomJson: { components: [row, bundled], dependencies: [] },
      });

    const exposedRow = nexusRow(
      `${home}/bin/java -Dnexus.password=s3cret -jar nexus.jar`,
    );
    const exposedJdk = jdk(TEMURIN_21, home);
    annotateJavaProcessOptions([exposedRow]);
    linkJdkProcessRows([exposedRow], [exposedJdk]);
    assert.strictEqual(exposedRow.version, "21.0.9");
    // The cmdline is osquery's own column; nothing cdxgen adds carries it
    assert.ok(
      !JSON.stringify(
        exposedRow.properties.filter((p) => p.name.startsWith("cdx:java")),
      ).includes("s3cret"),
    );
    assert.ok(
      !exposedRow.properties.some((p) =>
        p.name.startsWith("cdx:java:jvmOption"),
      ),
    );
    const findings = await run("HMX-006", merge(exposedRow, exposedJdk));
    assert.strictEqual(findings.length, 1);
    assert.match(findings[0].message, /temurin_21\.0\.9_10_linux_x86_64/);

    const safeRow = nexusRow(
      `JAVA_TOOL_OPTIONS=-XX:+IgnoreUnrecognizedVMOptions -XX:-UseBASE64Intrinsics ${home}/bin/java -jar nexus.jar`,
    );
    const safeJdk = jdk(TEMURIN_21, home);
    annotateJavaProcessOptions([safeRow]);
    linkJdkProcessRows([safeRow], [safeJdk]);
    assert.strictEqual(
      safeRow.properties.find(
        (p) => p.name === "cdx:java:jvmOption:UseBASE64Intrinsics",
      ).value,
      "false",
    );
    assert.strictEqual(
      safeJdk.properties.find(
        (p) => p.name === "cdx:java:base64IntrinsicExposure",
      ).value,
      "mitigated",
    );
    assert.strictEqual(
      (await run("HMX-006", merge(safeRow, safeJdk))).length,
      0,
    );
  });
});
