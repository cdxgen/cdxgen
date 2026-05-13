import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

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

describe("host-merged audit rules", () => {
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
});
