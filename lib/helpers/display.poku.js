import { readFileSync } from "node:fs";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import {
  buildDependencyTreeLegendLines,
  buildDependencyTreeLines,
  printDependencyTree,
} from "./display.js";
import { REGISTRY_PROVENANCE_ICON } from "./provenanceUtils.js";

it("print tree test", () => {
  const bomJson = JSON.parse(
    readFileSync("./test/data/vuln-spring-1.5.bom.json", { encoding: "utf-8" }),
  );
  printDependencyTree(bomJson);
});

it("prints a provenance icon for registry-backed components", async () => {
  const rows = [];
  const consoleLogStub = sinon.stub(console, "log");
  try {
    const { printTable } = await esmock("./display.js", {
      "./table.js": {
        createStream: () => ({
          end() {
            // intentional no-op for stream stub
          },
          write(row) {
            rows.push(row);
          },
        }),
        table: sinon.stub().returns(""),
      },
      "./utils.js": {
        isSecureMode: false,
        safeExistsSync: sinon.stub(),
        toCamel: sinon.stub(),
      },
    });

    printTable(
      {
        components: [
          {
            group: "",
            name: "left-pad",
            properties: [
              {
                name: "cdx:npm:provenanceUrl",
                value:
                  "https://registry.npmjs.org/-/npm/v1/attestations/left-pad",
              },
            ],
            type: "library",
            version: "1.3.0",
          },
          {
            group: "",
            name: "lodash",
            properties: [],
            type: "library",
            version: "4.17.21",
          },
        ],
        dependencies: [],
      },
      undefined,
      undefined,
      "Found 1 trusted component.",
    );

    assert.strictEqual(rows[1][1], `${REGISTRY_PROVENANCE_ICON} left-pad`);
    assert.strictEqual(rows[2][1], "lodash");
    sinon.assert.calledWithExactly(
      consoleLogStub,
      "Found 1 trusted component.",
    );
    sinon.assert.calledWithExactly(
      consoleLogStub,
      `Legend: ${REGISTRY_PROVENANCE_ICON} = registry provenance or trusted publishing evidence`,
    );
    sinon.assert.calledWithExactly(
      consoleLogStub,
      `${REGISTRY_PROVENANCE_ICON} 1 component(s) include registry provenance or trusted publishing metadata.`,
    );
  } finally {
    consoleLogStub.restore();
  }
});

it("renders shared dependencies once while including dangling trees", () => {
  const treeLines = buildDependencyTreeLines([
    {
      ref: "pkg:root/a@1.0.0",
      dependsOn: ["pkg:shared/c@1.0.0"],
    },
    {
      ref: "pkg:root/b@1.0.0",
      dependsOn: ["pkg:shared/c@1.0.0"],
    },
    {
      ref: "pkg:shared/c@1.0.0",
      dependsOn: ["pkg:leaf/d@1.0.0"],
    },
    {
      ref: "pkg:cycle/e@1.0.0",
      dependsOn: ["pkg:cycle/f@1.0.0"],
    },
    {
      ref: "pkg:cycle/f@1.0.0",
      dependsOn: ["pkg:cycle/e@1.0.0"],
    },
  ]);

  assert.deepStrictEqual(treeLines, [
    "pkg:root/a@1.0.0",
    "└── pkg:shared/c@1.0.0",
    "    └── pkg:leaf/d@1.0.0",
    "pkg:root/b@1.0.0",
    "└── ⤴ pkg:shared/c@1.0.0",
    "pkg:cycle/e@1.0.0",
    "└── pkg:cycle/f@1.0.0",
    "    └── ↺ pkg:cycle/e@1.0.0",
  ]);
  assert.deepStrictEqual(buildDependencyTreeLegendLines(treeLines), [
    "Legend: ⤴ = already shown; ↺ = cycle",
  ]);
});

it("omits empty providers while marking shared provides with an icon", () => {
  const treeLines = buildDependencyTreeLines(
    [
      {
        ref: "pkg:npm/app@1.0.0",
        provides: ["crypto/aes", "crypto/sha256"],
      },
      {
        ref: "pkg:npm/helper@1.0.0",
        provides: ["crypto/sha256"],
      },
      {
        ref: "pkg:npm/unused@1.0.0",
      },
    ],
    "provides",
  );

  assert.deepStrictEqual(treeLines, [
    "pkg:npm/app@1.0.0",
    "├── crypto/aes",
    "└── crypto/sha256",
    "pkg:npm/helper@1.0.0",
    "└── ⤴ crypto/sha256",
  ]);
  assert.deepStrictEqual(buildDependencyTreeLegendLines(treeLines), [
    "Legend: ⤴ = already shown",
  ]);
});

it("returns no legend lines when the dependency tree has no markers", () => {
  assert.deepStrictEqual(
    buildDependencyTreeLegendLines([
      "pkg:root/a@1.0.0",
      "└── pkg:shared/c@1.0.0",
      "    └── pkg:leaf/d@1.0.0",
    ]),
    [],
  );
});
