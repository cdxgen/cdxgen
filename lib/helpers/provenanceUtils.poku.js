import { assert, describe, it } from "poku";

import {
  getPropertyValue,
  getProvenanceComponents,
  getTrustedComponents,
  getTrustedPublishingComponentCounts,
  hasAnyPropertyValue,
  hasComponentRegistryProvenance,
  hasComponentRegistryProvenanceEvidence,
  hasComponentTrustedPublishing,
  hasRegistryProvenanceEvidenceProperties,
  hasTrustedPublishingProperties,
} from "./provenanceUtils.js";

describe("provenanceUtils", () => {
  const npmTrustedComponent = {
    name: "left-pad",
    properties: [
      {
        name: "cdx:npm:trustedPublishing",
        value: "true",
      },
    ],
  };
  const pypiProvenanceComponent = {
    name: "requests",
    properties: [
      {
        name: "cdx:pypi:provenanceUrl",
        value: "https://pypi.org/integrity/example",
      },
    ],
  };
  const cargoTrustedComponent = {
    name: "serde",
    properties: [
      {
        name: "cdx:cargo:trustedPublishing",
        value: "true",
      },
      {
        name: "cdx:cargo:provenanceUrl",
        value: "https://crates.io/provenance/serde/1.0.0",
      },
    ],
  };
  const plainComponent = {
    name: "lodash",
    properties: [],
  };

  it("detects trusted publishing and registry provenance metadata", () => {
    assert.strictEqual(
      hasComponentTrustedPublishing(npmTrustedComponent),
      true,
    );
    assert.strictEqual(
      hasComponentRegistryProvenance(pypiProvenanceComponent),
      true,
    );
    assert.strictEqual(
      hasComponentRegistryProvenanceEvidence(pypiProvenanceComponent),
      true,
    );
    assert.strictEqual(hasComponentRegistryProvenance(plainComponent), false);
  });

  it("filters trusted components and counts trusted publishing by ecosystem", () => {
    assert.deepStrictEqual(
      getTrustedComponents([
        plainComponent,
        npmTrustedComponent,
        cargoTrustedComponent,
        pypiProvenanceComponent,
      ]).map((component) => component.name),
      ["left-pad", "serde"],
    );
    assert.deepStrictEqual(
      getProvenanceComponents([
        plainComponent,
        npmTrustedComponent,
        cargoTrustedComponent,
        pypiProvenanceComponent,
      ]).map((component) => component.name),
      ["serde", "requests"],
    );
    assert.deepStrictEqual(
      getTrustedPublishingComponentCounts([
        npmTrustedComponent,
        {
          name: "urllib3",
          properties: [
            {
              name: "cdx:pypi:trustedPublishing",
              value: "true",
            },
          ],
        },
        cargoTrustedComponent,
        plainComponent,
      ]),
      {
        cargo: 1,
        npm: 1,
        pypi: 1,
        total: 3,
      },
    );
  });

  it("supports property-array checks used by display and audit code", () => {
    const properties = [
      {
        name: "cdx:npm:provenanceKeyId",
        value: "sigstore-key",
      },
      {
        name: "cdx:npm:trustedPublishing",
        value: "true",
      },
      {
        name: "cdx:cargo:artifactDigestSha256",
        value: "deadbeef",
      },
    ];
    assert.strictEqual(
      getPropertyValue(properties, "cdx:npm:provenanceKeyId"),
      "sigstore-key",
    );
    assert.strictEqual(
      hasAnyPropertyValue(properties, ["cdx:npm:provenanceKeyId"]),
      true,
    );
    assert.strictEqual(hasTrustedPublishingProperties(properties), true);
    assert.strictEqual(
      hasRegistryProvenanceEvidenceProperties(properties),
      true,
    );
  });

  it("counts total trusted publishing components once even with multiple registry flags", () => {
    assert.deepStrictEqual(
      getTrustedPublishingComponentCounts([
        {
          name: "dual-published",
          properties: [
            {
              name: "cdx:npm:trustedPublishing",
              value: "true",
            },
            {
              name: "cdx:pypi:trustedPublishing",
              value: "true",
            },
            {
              name: "cdx:cargo:trustedPublishing",
              value: "true",
            },
          ],
        },
      ]),
      {
        cargo: 1,
        npm: 1,
        pypi: 1,
        total: 1,
      },
    );
  });
});
