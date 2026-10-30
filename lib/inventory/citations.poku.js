import { strict as assert, describe, it } from "poku";

import {
  attachCitations,
  buildInventoryCitation,
  collectToolBomRefs,
  createCitation,
  findCdxgenToolBomRef,
  mergeCitations,
} from "./citations.js";

describe("createCitation()", () => {
  it("builds a citation with pointers and attributedTo", () => {
    const citation = createCitation({
      pointers: ["/components/0/licenses/0"],
      attributedTo: "pkg:npm/@cdxgen/cdxgen@1.0.0",
      note: "resolved by cdxgen",
    });
    // The timestamp is left for attachCitations to fill from the document.
    assert.ok(!citation.timestamp);
    assert.deepStrictEqual(citation.pointers, ["/components/0/licenses/0"]);
    assert.strictEqual(citation.attributedTo, "pkg:npm/@cdxgen/cdxgen@1.0.0");
    assert.strictEqual(citation.note, "resolved by cdxgen");
    assert.ok(!citation.expressions);
    assert.ok(!citation.process);
  });

  it("builds a citation with expressions and process", () => {
    const citation = createCitation({
      expressions: ["$.components[*].licenses"],
      process: "urn:cdx:formula:1",
    });
    assert.deepStrictEqual(citation.expressions, ["$.components[*].licenses"]);
    assert.strictEqual(citation.process, "urn:cdx:formula:1");
    assert.ok(!citation.pointers);
    assert.ok(!citation.attributedTo);
  });

  it("returns null when neither pointers nor expressions is supplied", () => {
    assert.strictEqual(createCitation({ attributedTo: "ref" }), null);
  });

  it("returns null when both pointers and expressions are supplied", () => {
    assert.strictEqual(
      createCitation({
        pointers: ["/a"],
        expressions: ["$.a"],
        attributedTo: "ref",
      }),
      null,
    );
  });

  it("returns null when neither attributedTo nor process is supplied", () => {
    assert.strictEqual(createCitation({ pointers: ["/a"] }), null);
  });

  it("honours an explicit timestamp and bomRef", () => {
    const citation = createCitation({
      pointers: ["/a"],
      attributedTo: "ref",
      timestamp: "2026-01-01T00:00:00.000Z",
      bomRef: "citation:license:0",
    });
    assert.strictEqual(citation.timestamp, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(citation["bom-ref"], "citation:license:0");
  });
});

describe("mergeCitations()", () => {
  it("drops duplicate attributions to the same selector set", () => {
    const a = createCitation({
      pointers: ["/components/0"],
      attributedTo: "tool",
    });
    const b = createCitation({
      pointers: ["/components/0"],
      attributedTo: "tool",
      note: "duplicate",
    });
    assert.strictEqual(mergeCitations([a, b]).length, 1);
  });

  it("keeps citations that target different selectors", () => {
    const a = createCitation({
      pointers: ["/components/0"],
      attributedTo: "tool",
    });
    const b = createCitation({
      pointers: ["/components/1"],
      attributedTo: "tool",
    });
    assert.strictEqual(mergeCitations([a, b]).length, 2);
  });
});

describe("tool bom-ref helpers", () => {
  it("collects tool refs from the components-style tools object", () => {
    const bomJson = {
      metadata: {
        tools: {
          components: [
            { name: "cdxgen", "bom-ref": "pkg:npm/@cdxgen/cdxgen@1.0.0" },
            { name: "other", "bom-ref": "ref-other" },
          ],
        },
      },
    };
    assert.deepStrictEqual(collectToolBomRefs(bomJson), [
      "pkg:npm/@cdxgen/cdxgen@1.0.0",
      "ref-other",
    ]);
    assert.strictEqual(
      findCdxgenToolBomRef(bomJson),
      "pkg:npm/@cdxgen/cdxgen@1.0.0",
    );
  });

  it("collects tool refs from the legacy array-style tools", () => {
    const bomJson = {
      metadata: {
        tools: [{ "bom-ref": "pkg:npm/@cdxgen/cdxgen@1.0.0" }],
      },
    };
    assert.strictEqual(
      findCdxgenToolBomRef(bomJson),
      "pkg:npm/@cdxgen/cdxgen@1.0.0",
    );
  });
});

describe("buildInventoryCitation()", () => {
  it("attributes the component array to the cdxgen tool", () => {
    const bomJson = {
      metadata: {
        tools: {
          components: [
            { "bom-ref": "pkg:npm/@cdxgen/cdxgen@1.0.0", name: "cdxgen" },
          ],
        },
      },
    };
    const citation = buildInventoryCitation(bomJson);
    assert.ok(citation);
    assert.deepStrictEqual(citation.expressions, ["$.components"]);
    assert.strictEqual(citation.attributedTo, "pkg:npm/@cdxgen/cdxgen@1.0.0");
  });

  it("returns null when no cdxgen tool is referenced", () => {
    assert.strictEqual(buildInventoryCitation({ metadata: {} }), null);
  });
});

describe("attachCitations()", () => {
  it("attaches citations at spec version 1.7", () => {
    const bomJson = {
      specVersion: "1.7",
      metadata: {
        tools: {
          components: [
            { "bom-ref": "pkg:npm/@cdxgen/cdxgen@1.0.0", name: "cdxgen" },
          ],
        },
      },
    };
    const citation = createCitation({
      pointers: ["/components"],
      attributedTo: "pkg:npm/@cdxgen/cdxgen@1.0.0",
    });
    attachCitations(bomJson, [citation], { specVersion: 1.7 });
    assert.deepStrictEqual(bomJson.citations, [citation]);
  });

  it("timestamps citations from the document, not the clock", () => {
    const render = () => {
      const bomJson = {
        specVersion: "1.7",
        metadata: {
          timestamp: "2026-01-02T03:04:05.000Z",
          tools: {
            components: [
              { "bom-ref": "pkg:npm/@cdxgen/cdxgen@1.0.0", name: "cdxgen" },
            ],
          },
        },
      };
      attachCitations(
        bomJson,
        [
          createCitation({
            pointers: ["/components"],
            attributedTo: "pkg:npm/@cdxgen/cdxgen@1.0.0",
          }),
        ],
        { specVersion: 1.7 },
      );
      return bomJson.citations;
    };
    const first = render();
    const second = render();
    assert.strictEqual(first[0].timestamp, "2026-01-02T03:04:05.000Z");
    // Two renders of one document must agree, so the BOM stays reproducible.
    assert.deepStrictEqual(first, second);
  });

  it("does not attach citations below spec version 1.7", () => {
    const bomJson = { specVersion: "1.6" };
    const citation = createCitation({
      pointers: ["/components"],
      attributedTo: "pkg:npm/@cdxgen/cdxgen@1.0.0",
    });
    attachCitations(bomJson, [citation], { specVersion: 1.6 });
    assert.ok(!bomJson.citations);
  });
});
