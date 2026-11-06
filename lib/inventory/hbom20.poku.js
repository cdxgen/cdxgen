import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import { assertRefIntegrity } from "../../test/helpers/cyclonedx20RefIntegrity.js";
import { auditBom } from "../stages/postgen/auditBom.js";
import precompiled20 from "../validator/generated/validate-2.0.mjs";
import {
  loadBomForAnalysis,
  refreshRenderedBom,
  renderCycloneDx20,
  renderCycloneDx20WithReport,
} from "./cyclonedx20.js";
import {
  ensureSupportedHbomSpecVersion,
  normalizeHbomOptions,
  toInternalHbom,
} from "./hbom.js";
import { hardwareRenderContext, loadHardwareMapper } from "./hbomLoader.js";

// A 1.x-shaped HBOM in the shape cdx-hbom's collectors write: a device
// subject carrying the run's identifier policy, device components with
// cdx:hbom:* facts.
const sampleHbom = (policy = "raw-identifiers-enabled") => ({
  bomFormat: "CycloneDX",
  specVersion: "1.7",
  serialNumber: "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
  version: 1,
  metadata: {
    timestamp: "2026-01-01T00:00:00Z",
    component: {
      "bom-ref": "device:host",
      type: "device",
      name: "host",
      properties: [{ name: "cdx:hbom:identifierPolicy", value: policy }],
    },
    tools: {
      components: [{ type: "application", name: "cdx-hbom", version: "0.7.0" }],
    },
  },
  components: [
    {
      "bom-ref": "device:nic",
      type: "device",
      name: "nic",
      purl: "pkg:generic/acme/nic@1.0",
      manufacturer: { name: "Acme" },
      properties: [
        { name: "cdx:hbom:hardwareClass", value: "network-adapter" },
        { name: "cdx:hbom:serialNumber", value: "SN-123456" },
        { name: "cdx:hbom:pciClassCode", value: "0200" },
      ],
    },
    {
      "bom-ref": "pkg:npm/left-pad@1.3.0",
      type: "library",
      name: "left-pad",
      version: "1.3.0",
      purl: "pkg:npm/left-pad@1.3.0",
    },
  ],
  dependencies: [{ ref: "device:host", dependsOn: ["device:nic"] }],
});

/**
 * A stand-in for @cdxgen/cdx-hbom's toCdx20HardwareComponent with the same
 * contract: identifiers only with includeSensitiveIdentifiers, attributed to
 * options.partyRefId; classification codes; the manufacturer as a party.
 * It also returns members the renderer must not take: a string code and an
 * identifier group of an undeclared party.
 */
function fakeMapper(calls = []) {
  return (component, options) => {
    calls.push({ component, options });
    const value = (name) =>
      component.properties.find((property) => property.name === name)?.value;
    const mapped = { ...component };
    if (options.includeSensitiveIdentifiers && value("cdx:hbom:serialNumber")) {
      mapped.identifiers = [
        {
          party: options.partyRefId,
          identities: [
            { scheme: "serial-number", value: value("cdx:hbom:serialNumber") },
            { scheme: "serial-number", value: "" },
          ],
        },
        {
          party: "party-cdx-hbom",
          identities: [{ scheme: "serial-number", value: "SN-OTHER" }],
        },
      ];
    }
    if (value("cdx:hbom:hardwareClass")) {
      mapped.classification = {
        category: value("cdx:hbom:hardwareClass"),
        codes: [
          {
            standard: "PCI-SIG class code",
            value: value("cdx:hbom:pciClassCode"),
          },
          value("cdx:hbom:pciClassCode"),
        ],
      };
    }
    if (component.manufacturer?.name) {
      mapped.parties = [
        {
          roles: [{ role: "manufacturer" }],
          organization: { name: component.manufacturer.name },
        },
      ];
    }
    component.properties.push({ name: "mutated", value: "by the mapper" });
    return mapped;
  };
}

const hardwareOptions = {
  includeSensitiveIdentifiers: true,
  identifierPolicy: "raw-identifiers-enabled",
};

const nicOf = (bom20) =>
  bom20.inventories[0].components.find((c) => c.refId === "device:nic");

describe("HBOM spec versions (#4755)", () => {
  it("accepts 1.7 and 2.0 and rejects everything else", () => {
    ensureSupportedHbomSpecVersion("2.0");
    ensureSupportedHbomSpecVersion(1.7);
    assert.throws(
      () => ensureSupportedHbomSpecVersion("1.6"),
      /only CycloneDX 1\.7 and 2\.0/u,
    );
  });

  it("always asks the collector for 1.7", () => {
    assert.strictEqual(
      normalizeHbomOptions({ specVersion: "2.0" }).specVersion,
      "1.7",
    );
    assert.strictEqual(
      normalizeHbomOptions({ specVersion: 2 }).specVersion,
      "1.7",
    );
    assert.strictEqual(normalizeHbomOptions({}).specVersion, "1.7");
  });

  it("reads a 2.0 collector result into the 1.x model", () => {
    const bom17 = sampleHbom();
    assert.strictEqual(toInternalHbom(bom17), bom17);
    const internal = toInternalHbom(renderCycloneDx20(sampleHbom()));
    assert.strictEqual(internal.specVersion, "1.7");
    assert.strictEqual(internal.specFormat, undefined);
    assert.deepStrictEqual(
      internal.components.map((c) => [c["bom-ref"], c.properties?.length ?? 0]),
      [
        ["device:nic", 3],
        ["pkg:npm/left-pad@1.3.0", 0],
      ],
    );
    assert.strictEqual(internal.metadata.component["bom-ref"], "device:host");
  });

  it("requests 1.7 from cdx-hbom and keeps every component of a 2.0 answer", async () => {
    const requests = [];
    const { createHbomDocument } = await esmock("./hbom.js", {
      "./hbomLoader.js": {
        importHbomModule: async () => ({
          collectHardware: async (options) => {
            requests.push(options.specVersion);
            return renderCycloneDx20(sampleHbom());
          },
        }),
      },
    });
    const bomJson = await createHbomDocument({ specVersion: "2.0" });
    assert.deepStrictEqual(requests, ["1.7"]);
    assert.deepStrictEqual(
      bomJson.components.map((c) => c["bom-ref"]),
      ["device:nic", "pkg:npm/left-pad@1.3.0"],
    );
  });
});

describe("HBOM hardware mapping at 2.0 (#4755)", () => {
  it("appends mapped identifiers to the purl and keeps every cdx:hbom property", () => {
    const calls = [];
    const input = sampleHbom();
    const pristine = structuredClone(input);
    const { bomJson, report } = renderCycloneDx20WithReport(input, {
      hardwareMapper: fakeMapper(calls),
      hardwareOptions,
    });
    assert.ok(precompiled20(bomJson), "rendered HBOM validates");
    assertRefIntegrity(bomJson, "mapped HBOM");
    const nic = nicOf(bomJson);
    assert.deepStrictEqual(nic.identifiers, [
      {
        party: "party-cdxgen",
        identities: [
          { scheme: "purl", value: "pkg:generic/acme/nic@1.0" },
          { scheme: "serial-number", value: "SN-123456" },
        ],
      },
    ]);
    assert.deepStrictEqual(nic.classification, {
      category: "network-adapter",
      codes: [{ standard: "PCI-SIG class code", value: "0200" }],
    });
    assert.deepStrictEqual(nic.parties, [
      { roles: [{ role: "manufacturer" }], organization: { name: "Acme" } },
    ]);
    assert.deepStrictEqual(
      nic.properties.map((p) => p.name),
      [
        "cdx:hbom:hardwareClass",
        "cdx:hbom:serialNumber",
        "cdx:hbom:pciClassCode",
      ],
    );
    assert.deepStrictEqual(
      bomJson.definitions.parties.map((party) => party.refId),
      ["party-cdxgen"],
    );
    assert.strictEqual(
      report.drops["hardware classification code (not a taxonomyCode)"],
      1,
    );
    assert.strictEqual(
      report.drops["hardware identifier (undeclared party)"],
      1,
    );
    assert.strictEqual(
      report.drops["hardware identity (not a 2.0 identity)"],
      1,
    );
    // Only the hardware components (the subject and the NIC) are mapped,
    // each with the cdxgen party and the context's identifier options; the
    // mapper's writes never reach the input.
    assert.deepStrictEqual(
      calls.map((call) => [call.component["bom-ref"], call.options]),
      [
        ["device:nic", { ...hardwareOptions, partyRefId: "party-cdxgen" }],
        ["device:host", { ...hardwareOptions, partyRefId: "party-cdxgen" }],
      ],
    );
    assert.deepStrictEqual(input, pristine);
  });

  it("renders without a mapper, and the result depends only on the arguments", () => {
    const withMapper = renderCycloneDx20(sampleHbom(), {
      hardwareMapper: fakeMapper(),
      hardwareOptions,
    });
    const without = renderCycloneDx20(sampleHbom());
    const nic = nicOf(without);
    assert.deepStrictEqual(nic.identifiers, [
      {
        party: "party-cdxgen",
        identities: [{ scheme: "purl", value: "pkg:generic/acme/nic@1.0" }],
      },
    ]);
    assert.strictEqual(nic.classification, undefined);
    assert.ok(precompiled20(without));
    assert.notDeepStrictEqual(without, withMapper);
    assert.deepStrictEqual(renderCycloneDx20(sampleHbom()), without);
  });

  it("keeps the generic conversion when the mapper throws", () => {
    const { bomJson, report } = renderCycloneDx20WithReport(sampleHbom(), {
      hardwareMapper: () => {
        throw new Error("boom");
      },
    });
    assert.deepStrictEqual(bomJson, renderCycloneDx20(sampleHbom()));
    assert.strictEqual(report.drops["hardware mapping (mapper failed)"], 2);
  });

  it("re-renders with the render context postProcess kept", () => {
    const bomNSData = {
      internalBomJson: sampleHbom(),
      renderContext: { hardwareMapper: fakeMapper(), hardwareOptions },
    };
    refreshRenderedBom(bomNSData, { specVersion: "2.0" });
    assert.deepStrictEqual(
      nicOf(bomNSData.bomJson).classification.category,
      "network-adapter",
    );
  });
});

describe("hardwareRenderContext() and loadHardwareMapper() (#4755)", () => {
  const MAPPER_SOURCE = [
    "export function toCdx20HardwareComponent(component, options) {",
    "  return { ...component, classification: { category: options.partyRefId } };",
    "}",
  ].join("\n");

  const withCheckout = (mapperSource, run) => async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdx-hbom-checkout-"));
    try {
      mkdirSync(join(dir, "src", "common"), { recursive: true });
      writeFileSync(
        join(dir, "index.js"),
        "export const collectHardware = () => ({});\n",
      );
      if (mapperSource !== undefined) {
        writeFileSync(join(dir, "src", "common", "cdx20.js"), mapperSource);
      }
      await run({
        localModulePath: join(dir, "index.js"),
        localMapperPath: join(dir, "src", "common", "cdx20.js"),
        packageMapperSpecifier: "@cdxgen/cdx-hbom-absent/cdx20",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it(
    "loads the mapper from the cdx-hbom checkout importHbomModule uses",
    withCheckout(MAPPER_SOURCE, async (locations) => {
      const mapper = await loadHardwareMapper(locations);
      assert.deepStrictEqual(mapper({ name: "x" }, { partyRefId: "p" }), {
        name: "x",
        classification: { category: "p" },
      });
    }),
  );

  it(
    "gives null for a checkout without the ./cdx20 module",
    withCheckout(undefined, async (locations) => {
      assert.strictEqual(await loadHardwareMapper(locations), null);
    }),
  );

  it(
    "gives null for a module without toCdx20HardwareComponent",
    withCheckout("export const other = 1;\n", async (locations) => {
      assert.strictEqual(await loadHardwareMapper(locations), null);
    }),
  );

  it("gives null when the package has no ./cdx20 export", async () => {
    assert.strictEqual(
      await loadHardwareMapper({
        localModulePath: join(tmpdir(), "no-cdx-hbom-here", "index.js"),
        localMapperPath: join(tmpdir(), "no-cdx-hbom-here", "cdx20.js"),
        packageMapperSpecifier: "@cdxgen/cdx-hbom-absent/cdx20",
      }),
      null,
    );
  });

  it(
    "derives the identifier options from the recorded policy",
    withCheckout(MAPPER_SOURCE, async (locations) => {
      const raw = await hardwareRenderContext(sampleHbom(), locations);
      assert.strictEqual(typeof raw.hardwareMapper, "function");
      assert.deepStrictEqual(raw.hardwareOptions, hardwareOptions);
      const redacted = await hardwareRenderContext(
        sampleHbom("redacted-by-default"),
        locations,
      );
      assert.deepStrictEqual(redacted.hardwareOptions, {
        includeSensitiveIdentifiers: false,
        identifierPolicy: "redacted-by-default",
      });
      const software = sampleHbom();
      delete software.metadata.component.properties;
      software.components = software.components.slice(1);
      assert.deepStrictEqual(
        await hardwareRenderContext(software, locations),
        {},
      );
    }),
  );
});

describe("hbom audit parity between 1.7 and the 2.0 round trip (#4755)", () => {
  const makeHbomComponent = (name, hardwareClass, properties = []) => ({
    type: "device",
    name,
    "bom-ref": `urn:uuid:${hardwareClass}:${name}`,
    properties: [
      { name: "cdx:hbom:hardwareClass", value: hardwareClass },
      ...properties.map(([k, v]) => ({ name: k, value: v })),
    ],
  });
  const parityBom = {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    metadata: {
      timestamp: "2026-01-01T00:00:00Z",
      // A device subject without platform or durable identity (HBC-002).
      component: { "bom-ref": "device:host", type: "device", name: "host" },
      properties: [
        { name: "cdx:hbom:platform", value: "linux" },
        { name: "cdx:hbom:architecture", value: "amd64" },
      ],
    },
    components: [
      makeHbomComponent("LTE Modem", "modem", [
        ["cdx:hbom:imei", "490154203237518"],
      ]),
      makeHbomComponent("Main SSD", "storage", [
        ["cdx:hbom:serialNumber", "SERIAL-1"],
        // A failing SMART state (HBP-002).
        ["cdx:hbom:smartStatus", "Failing"],
      ]),
    ],
  };
  for (const pack of ["hbom-compliance", "hbom-performance", "hbom-security"]) {
    it(`finds the same ${pack} findings at 1.7 and through 2.0`, async () => {
      const findings17 = await auditBom(structuredClone(parityBom), {
        bomAuditCategories: pack,
      });
      assert.ok(findings17.length > 0, `${pack} finds something at 1.7`);
      const bom20 = renderCycloneDx20(structuredClone(parityBom), {
        hardwareMapper: fakeMapper(),
        hardwareOptions,
      });
      assert.ok(precompiled20(bom20));
      const { internalBom } = loadBomForAnalysis(bom20);
      const findings20 = await auditBom(internalBom, {
        bomAuditCategories: pack,
      });
      const signature = (finding) =>
        `${finding.ruleId}|${finding.severity}|${JSON.stringify(finding.location ?? finding.purl ?? null)}`;
      assert.deepStrictEqual(
        findings20.map(signature).sort(),
        findings17.map(signature).sort(),
      );
    });
  }
});
