import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "poku";

import { CDXGEN_TOOL_GROUP, CDXGEN_TOOL_NAME } from "../../core/state.js";
import {
  getLicenses,
  getRecordedActivities,
  parsePkgJson,
  resetRecordedActivities,
  setDryRunMode,
} from "../../ecosystems/utils.js";
import { enrichComponentWithMcpMetadata } from "../../inventory/mcp.js";
import { validateBom } from "../../validator/bomValidator.js";
import {
  applyEvidenceBasedFilter,
  applyMetadata,
  cleanupEnv,
  cleanupTmpDir,
  extractBuildOnlyComponents,
  filterBom,
  postProcess,
} from "./postgen.js";

it("filter bom tests", () => {
  const bomJson = JSON.parse(
    readFileSync("./test/data/bom-postgen-test.json", "utf-8"),
  );
  let newBom = filterBom(bomJson, {});
  assert.deepStrictEqual(bomJson, newBom);
  assert.deepStrictEqual(newBom.components.length, 1060);
  newBom = filterBom(bomJson, { requiredOnly: true });
  for (const comp of newBom.components) {
    if (comp.scope && comp.scope !== "required") {
      throw new Error(`${comp.scope} is unexpected`);
    }
  }
  assert.deepStrictEqual(newBom.components.length, 345);
});

it("filter bom tests2", () => {
  const bomJson = JSON.parse(
    readFileSync("./test/data/bom-postgen-test2.json", "utf-8"),
  );
  let newBom = filterBom(bomJson, {});
  assert.deepStrictEqual(bomJson, newBom);
  assert.deepStrictEqual(newBom.components.length, 199);
  newBom = filterBom(bomJson, { requiredOnly: true });
  for (const comp of newBom.components) {
    if (comp.scope && comp.scope !== "required") {
      throw new Error(`${comp.scope} is unexpected`);
    }
  }
  assert.deepStrictEqual(newBom.components.length, 199);
  newBom = filterBom(bomJson, { filter: [""] });
  assert.deepStrictEqual(newBom.components.length, 199);
  newBom = filterBom(bomJson, { filter: ["apache"] });
  for (const comp of newBom.components) {
    if (comp.purl.includes("apache")) {
      throw new Error(`${comp.purl} is unexpected`);
    }
  }
  assert.deepStrictEqual(newBom.components.length, 158);
  newBom = filterBom(bomJson, { filter: ["apache", "json"] });
  for (const comp of newBom.components) {
    if (comp.purl.includes("apache") || comp.purl.includes("json")) {
      throw new Error(`${comp.purl} is unexpected`);
    }
  }
  assert.deepStrictEqual(newBom.components.length, 135);
  assert.deepStrictEqual(newBom.compositions, undefined);
  newBom = filterBom(bomJson, {
    only: ["org.springframework"],
    specVersion: 1.5,
    autoCompositions: true,
  });
  for (const comp of newBom.components) {
    if (!comp.purl.includes("org.springframework")) {
      throw new Error(`${comp.purl} is unexpected`);
    }
  }
  assert.deepStrictEqual(newBom.components.length, 29);
  assert.deepStrictEqual(newBom.compositions, [
    {
      aggregate: "incomplete_first_party_only",
      "bom-ref": "pkg:maven/sec/java-sec-code@1.0.0?type=jar",
    },
  ]);
});

it("filterBom requiredOnly drops excluded npm @types components", () => {
  const bomJson = {
    components: [
      {
        "bom-ref": "pkg:npm/react@19.2.6",
        name: "react",
        purl: "pkg:npm/react@19.2.6",
        type: "library",
      },
      {
        "bom-ref": "pkg:npm/@types/react@19.2.15",
        group: "@types",
        name: "react",
        purl: "pkg:npm/%40types/react@19.2.15",
        scope: "excluded",
        type: "library",
      },
    ],
    dependencies: [
      {
        ref: "pkg:npm/react@19.2.6",
        dependsOn: ["pkg:npm/@types/react@19.2.15"],
      },
      {
        ref: "pkg:npm/@types/react@19.2.15",
        dependsOn: [],
      },
    ],
  };

  const filteredBom = filterBom(bomJson, { requiredOnly: true });
  assert.deepStrictEqual(filteredBom.components.length, 1);
  assert.deepStrictEqual(
    filteredBom.components[0]["bom-ref"],
    "pkg:npm/react@19.2.6",
  );
  assert.deepStrictEqual(filteredBom.dependencies.length, 1);
  assert.deepStrictEqual(filteredBom.dependencies[0], {
    ref: "pkg:npm/react@19.2.6",
    dependsOn: [],
  });
});

it("exclude-type mcp removes inventory artifacts but retains MCP SDK packages", () => {
  const bomJson = {
    components: [
      // Enrich like the real pipeline so the SDK package carries cdx:mcp:*
      // (including cdx:mcp:role) — the metadata that caused the over-exclusion.
      enrichComponentWithMcpMetadata({
        "bom-ref": "pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0",
        name: "@modelcontextprotocol/server-filesystem",
        purl: "pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0",
        type: "library",
      }),
      {
        "bom-ref": "file:/repo/.vscode/mcp.json",
        name: "mcp.json",
        properties: [{ name: "cdx:file:kind", value: "mcp-config" }],
        type: "file",
      },
      {
        "bom-ref": "urn:mcp:tool:docs:search",
        name: "search",
        properties: [
          { name: "cdx:mcp:role", value: "tool" },
          {
            name: "cdx:mcp:serviceRef",
            value: "urn:service:mcp:docs:latest",
          },
        ],
        type: "application",
      },
    ],
    dependencies: [
      {
        dependsOn: ["urn:mcp:tool:docs:search"],
        ref: "urn:service:mcp:docs:latest",
      },
      {
        provides: ["urn:mcp:tool:docs:search"],
        ref: "pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0",
      },
    ],
    metadata: { properties: [] },
    services: [
      {
        "bom-ref": "urn:service:mcp:docs:latest",
        group: "mcp",
        name: "docs",
        properties: [{ name: "cdx:mcp:inventorySource", value: "config-file" }],
      },
    ],
  };

  const filteredBom = filterBom(bomJson, { excludeType: ["mcp"] });

  assert.deepStrictEqual(
    filteredBom.components.map((component) => component["bom-ref"]),
    ["pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0"],
  );
  assert.deepStrictEqual(filteredBom.services, []);
  assert.deepStrictEqual(filteredBom.dependencies, [
    {
      dependsOn: [],
      provides: [],
      ref: "pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0",
    },
  ]);
});

it("filterBom keeps only requested component types and prunes dependencies", () => {
  const bomJson = {
    components: [
      { "bom-ref": "app", name: "demo-app", type: "application" },
      { "bom-ref": "lib", name: "demo-lib", type: "library" },
      {
        "bom-ref": "crypto",
        name: "demo-key",
        type: "cryptographic-asset",
      },
      { "bom-ref": "framework", name: "demo-fw", type: "framework" },
    ],
    dependencies: [
      { ref: "app", dependsOn: ["lib", "crypto", "framework"] },
      { ref: "lib", dependsOn: ["crypto"] },
      { ref: "framework", dependsOn: ["lib"] },
    ],
    metadata: { component: { "bom-ref": "root", type: "application" } },
  };

  const filteredBom = filterBom(bomJson, {
    autoCompositions: true,
    componentType: ["library", "framework"],
    specVersion: 1.7,
  });

  assert.deepStrictEqual(
    filteredBom.components.map((component) => component["bom-ref"]),
    ["framework", "lib"],
  );
  assert.deepStrictEqual(filteredBom.dependencies, [
    { ref: "lib", dependsOn: [] },
    { ref: "framework", dependsOn: ["lib"] },
  ]);
  assert.deepStrictEqual(filteredBom.compositions, [
    { "bom-ref": "root", aggregate: "incomplete" },
  ]);
});

it("postProcess adds formulation exactly once when includeFormulation is true", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [],
      dependencies: [],
      metadata: { properties: [] },
    },
  };
  const options = { includeFormulation: true, specVersion: 1.5 };
  const result = await postProcess(bomNSData, options);
  assert.ok(
    Array.isArray(result.bomJson.formulation),
    "formulation must be an array",
  );
  assert.ok(
    result.bomJson.formulation.length > 0,
    "formulation must have at least one entry",
  );
});

it("postProcess does not add formulation when includeFormulation is false", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [],
      dependencies: [],
      metadata: { properties: [] },
    },
  };
  const options = { includeFormulation: false, specVersion: 1.5 };
  const result = await postProcess(bomNSData, options);
  assert.strictEqual(
    result.bomJson.formulation,
    undefined,
    "formulation must not be added when disabled",
  );
});

it("postProcess preserves existing formulation and does not overwrite it", async () => {
  const sentinel = [{ "bom-ref": "already-present" }];
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [],
      dependencies: [],
      metadata: { properties: [] },
      formulation: sentinel,
    },
  };
  const options = { includeFormulation: true, specVersion: 1.5 };
  const result = await postProcess(bomNSData, options);
  assert.strictEqual(
    result.bomJson.formulation[0]["bom-ref"],
    "already-present",
    "existing formulation must not be overwritten",
  );
});

it("postProcess passes formulationList from bomNSData into the formulation section", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [],
      dependencies: [],
      metadata: { properties: [] },
    },
    formulationList: [{ type: "library", name: "pixi-pkg", version: "1.0.0" }],
  };
  const options = { includeFormulation: true, specVersion: 1.5 };
  const result = await postProcess(bomNSData, options);
  assert.ok(
    Array.isArray(result.bomJson.formulation),
    "formulation must be present",
  );
  // The formulationList item should be reflected somewhere in the formulation components
  const allComponents = result.bomJson.formulation.flatMap(
    (f) => f.components ?? [],
  );
  assert.ok(
    allComponents.some((c) => c.name === "pixi-pkg"),
    "pixi-pkg from formulationList should appear in formulation components",
  );
});

it("postProcess does not move local Hugging Face AI inventory into formulation", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [],
      dependencies: [],
      metadata: { properties: [], tools: { components: [] } },
    },
  };
  const options = {
    includeFormulation: true,
    projectType: ["ai"],
    specVersion: 1.7,
  };
  const result = await postProcess(
    bomNSData,
    options,
    "./test/data/ai-huggingface/repos",
  );
  assert.ok(
    !result.bomJson.formulation
      .flatMap((formula) => formula.components || [])
      .some((component) => component.group === "HuggingFaceH4"),
    "expected Hugging Face inventory to remain outside formulation",
  );
});

it("postProcess finalizes CycloneDX 2.0-dev root fields and strips legacy fields", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      metadata: {
        manufacture: { name: "Legacy Factory" },
        component: "not-a-component-object",
        tools: [
          {
            author: "OWASP Foundation",
            name: "cdxgen",
            vendor: "OWASP Foundation",
            version: "12.4.0",
            components: [
              {
                author: "Nested Tool Author",
                modified: true,
                name: "cdxgen-plugin",
                type: "library",
              },
            ],
          },
        ],
      },
      components: [
        {
          author: "Jane Doe",
          modified: false,
          name: "demo-lib",
          type: "library",
          version: "1.0.0",
          components: [
            {
              author: "Nested Author",
              modified: true,
              name: "nested-lib",
              type: "library",
            },
          ],
        },
      ],
    },
  };

  const result = await postProcess(bomNSData, { specVersion: 2.0 });
  const [toolComponent] = result.bomJson.metadata.tools.components;
  const [component] = result.bomJson.components;

  assert.strictEqual(result.bomJson.specFormat, "CycloneDX");
  assert.strictEqual(result.bomJson.bomFormat, undefined);
  assert.strictEqual(result.bomJson.specVersion, "2.0");
  assert.strictEqual(result.bomJson.metadata.manufacture, undefined);
  assert.deepStrictEqual(result.bomJson.metadata.manufacturer, {
    name: "Legacy Factory",
  });
  assert.strictEqual(
    result.bomJson.metadata.component,
    "not-a-component-object",
  );
  assert.strictEqual(toolComponent.publisher, "OWASP Foundation");
  assert.deepStrictEqual(toolComponent.authors, [{ name: "OWASP Foundation" }]);
  assert.strictEqual(toolComponent.author, undefined);
  assert.deepStrictEqual(toolComponent.components[0].authors, [
    { name: "Nested Tool Author" },
  ]);
  assert.strictEqual(toolComponent.components[0].author, undefined);
  assert.strictEqual(toolComponent.components[0].modified, undefined);
  assert.deepStrictEqual(component.authors, [{ name: "Jane Doe" }]);
  assert.strictEqual(component.author, undefined);
  assert.strictEqual(component.modified, undefined);
  assert.deepStrictEqual(component.components[0].authors, [
    { name: "Nested Author" },
  ]);
  assert.strictEqual(component.components[0].author, undefined);
  assert.strictEqual(component.components[0].modified, undefined);
});

it("postProcess preserves malformed explicit specVersion values instead of coercing them to 1.7", async () => {
  const malformedBomResult = await postProcess(
    {
      bomJson: {
        bomFormat: "CycloneDX",
        specVersion: "2.0.1",
        components: [],
        dependencies: [],
        metadata: { properties: [] },
      },
    },
    {},
  );
  assert.strictEqual(malformedBomResult.bomJson.specVersion, "2.0.1");
  assert.strictEqual(malformedBomResult.bomJson.bomFormat, "CycloneDX");
  assert.strictEqual(malformedBomResult.bomJson.specFormat, undefined);

  const malformedOptionResult = await postProcess(
    {
      bomJson: {
        bomFormat: "CycloneDX",
        specVersion: "1.7",
        components: [],
        dependencies: [],
        metadata: { properties: [] },
      },
    },
    { specVersion: "2.0.1" },
  );
  assert.strictEqual(malformedOptionResult.bomJson.specVersion, "1.7");
  assert.strictEqual(malformedOptionResult.bomJson.bomFormat, "CycloneDX");
  assert.strictEqual(malformedOptionResult.bomJson.specFormat, undefined);
});

it("postProcess migrates CycloneDX 2.0 metadata manufacture and tool services without broad recursion", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      metadata: {
        manufacture: { name: "Component Factory" },
        component: {
          name: "demo-app",
          type: "application",
        },
        tools: {
          components: [],
          services: [
            {
              author: "Legacy Author",
              name: "scanner-service",
              vendor: "Scanner Vendor",
            },
          ],
        },
      },
      components: [],
      dependencies: [{ ref: "pkg:generic/demo@1.0.0", dependsOn: [] }],
      unrelatedInventory: {
        components: [
          {
            author: "Should Not Be Traversed",
            name: "not-a-component-list",
          },
        ],
      },
    },
  };

  const result = await postProcess(bomNSData, { specVersion: 2.0 });
  const [toolService] = result.bomJson.metadata.tools.services;

  assert.strictEqual(result.bomJson.metadata.manufacture, undefined);
  assert.deepStrictEqual(result.bomJson.metadata.component.manufacturer, {
    name: "Component Factory",
  });
  assert.deepStrictEqual(toolService.provider, { name: "Scanner Vendor" });
  assert.strictEqual(toolService.vendor, undefined);
  assert.strictEqual(toolService.author, undefined);
  assert.strictEqual(
    result.bomJson.unrelatedInventory.components[0].author,
    "Should Not Be Traversed",
  );
});

it("postProcess downgrades certificate crypto properties for spec version 1.6", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [
        {
          type: "cryptographic-asset",
          name: "demo-cert",
          cryptoProperties: {
            assetType: "certificate",
            certificateProperties: {
              serialNumber: "1234",
              subjectName: "CN=demo",
              issuerName: "CN=demo",
              notValidBefore: "2024-01-01T00:00:00.000Z",
              notValidAfter: "2034-01-01T00:00:00.000Z",
              certificateFormat: "X.509",
              certificateFileExtension: "crt",
              fingerprint: { alg: "SHA-1", content: "a".repeat(40) },
            },
          },
        },
      ],
      formulation: [
        {
          components: [
            {
              type: "cryptographic-asset",
              name: "formulation-cert",
              cryptoProperties: {
                assetType: "certificate",
                certificateProperties: {
                  serialNumber: "5678",
                  subjectName: "CN=formulation",
                  certificateFileExtension: "pem",
                  fingerprint: { alg: "SHA-1", content: "b".repeat(40) },
                },
              },
            },
          ],
        },
      ],
      metadata: {
        properties: [],
        tools: {
          components: [{ name: "cdxgen" }],
        },
      },
    },
  };
  const result = await postProcess(bomNSData, { specVersion: 1.6 });
  const componentCert =
    result.bomJson.components[0].cryptoProperties.certificateProperties;
  const formulationCert =
    result.bomJson.formulation[0].components[0].cryptoProperties
      .certificateProperties;

  assert.deepStrictEqual(componentCert, {
    subjectName: "CN=demo",
    issuerName: "CN=demo",
    notValidBefore: "2024-01-01T00:00:00.000Z",
    notValidAfter: "2034-01-01T00:00:00.000Z",
    certificateFormat: "X.509",
    certificateExtension: "crt",
  });
  assert.deepStrictEqual(formulationCert, {
    subjectName: "CN=formulation",
    certificateExtension: "pem",
  });
});

it("postProcess strips 1.7-only cryptoProperties.algorithmProperties fields when downgrading to 1.6", async () => {
  // `algorithmFamily` and `ellipticCurve` are CycloneDX 1.7 additions; the
  // deprecated free-text `curve` is retained at 1.6.
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [
        {
          type: "cryptographic-asset",
          name: "ecdsaWithSHA256",
          cryptoProperties: {
            assetType: "algorithm",
            oid: "1.2.840.10045.4.3.2",
            algorithmProperties: {
              primitive: "signature",
              algorithmFamily: "ECDSA",
              ellipticCurve: "nist/P-256",
              curve: "nist/P-256",
            },
          },
        },
      ],
      metadata: { tools: { components: [{ name: "cdxgen" }] } },
    },
  };
  const result = await postProcess(bomNSData, { specVersion: 1.6 });
  const algorithmProperties =
    result.bomJson.components[0].cryptoProperties.algorithmProperties;
  assert.strictEqual(algorithmProperties.algorithmFamily, undefined);
  assert.strictEqual(algorithmProperties.ellipticCurve, undefined);
  assert.strictEqual(algorithmProperties.primitive, "signature");
  assert.strictEqual(algorithmProperties.curve, "nist/P-256");
});

it("postProcess preserves 1.7 cryptoProperties.algorithmProperties at spec version 1.7", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [
        {
          type: "cryptographic-asset",
          name: "AES",
          cryptoProperties: {
            assetType: "algorithm",
            algorithmProperties: {
              primitive: "block-cipher",
              algorithmFamily: "AES",
            },
          },
        },
      ],
      metadata: { tools: { components: [{ name: "cdxgen" }] } },
    },
  };
  const result = await postProcess(bomNSData, { specVersion: 1.7 });
  const algorithmProperties =
    result.bomJson.components[0].cryptoProperties.algorithmProperties;
  assert.strictEqual(algorithmProperties.algorithmFamily, "AES");
  assert.strictEqual(algorithmProperties.primitive, "block-cipher");
});

it("postProcess removes component types unsupported by the target spec version", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [
        {
          "bom-ref": "crypto-key",
          type: "cryptographic-asset",
          name: "demo-key",
          cryptoProperties: {
            assetType: "related-crypto-material",
          },
        },
        { "bom-ref": "repo", type: "data", name: "apk repository" },
      ],
      dependencies: [
        { ref: "repo", dependsOn: ["crypto-key"] },
        { ref: "crypto-key", dependsOn: [] },
      ],
      formulation: [
        {
          components: [
            {
              "bom-ref": "formulation-crypto",
              type: "cryptographic-asset",
              name: "formulation-key",
            },
            {
              "bom-ref": "formulation-lib",
              type: "library",
              name: "formulation-lib",
            },
          ],
        },
      ],
      metadata: {
        properties: [],
        tools: {
          components: [
            { group: "@cyclonedx", name: "cdxgen", type: "application" },
          ],
        },
      },
    },
  };

  const result = await postProcess(bomNSData, { specVersion: 1.5 });

  assert.deepStrictEqual(
    result.bomJson.components.map((component) => component["bom-ref"]),
    ["repo"],
  );
  assert.deepStrictEqual(result.bomJson.dependencies, [
    { ref: "repo", dependsOn: [] },
  ]);
  assert.deepStrictEqual(
    result.bomJson.formulation[0].components.map(
      (component) => component["bom-ref"],
    ),
    ["formulation-lib"],
  );
});

it("postProcess does not add undefined definitions component collections while downgrading", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [
        { "bom-ref": "demo-lib", type: "library", name: "demo-lib" },
      ],
      definitions: {
        standards: [
          {
            "bom-ref": "standard-demo",
            name: "Demo Standard",
            version: "1.0",
          },
        ],
      },
      dependencies: [],
      metadata: {
        properties: [],
        tools: {
          components: [
            { group: "@cyclonedx", name: "cdxgen", type: "application" },
          ],
        },
      },
    },
  };

  const result = await postProcess(bomNSData, { specVersion: 1.6 });

  assert.strictEqual(
    Object.hasOwn(result.bomJson.definitions, "components"),
    false,
  );
  assert.deepStrictEqual(result.bomJson.definitions.standards, [
    {
      "bom-ref": "standard-demo",
      name: "Demo Standard",
      version: "1.0",
    },
  ]);
});

it("postProcess applies component-type filters after formulation is added", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [
        {
          "bom-ref": "pkg:generic/demo-lib@1.0.0",
          name: "demo-lib",
          type: "library",
        },
        {
          "bom-ref": "crypto/demo",
          name: "demo-crypto",
          type: "cryptographic-asset",
        },
      ],
      dependencies: [
        {
          ref: "pkg:generic/demo-lib@1.0.0",
          dependsOn: ["crypto/demo"],
        },
      ],
      metadata: {
        properties: [],
        tools: {
          components: [
            { group: "@cyclonedx", name: "cdxgen", type: "application" },
          ],
        },
      },
    },
    formulationList: [
      { type: "library", name: "formulation-lib", version: "1.0.0" },
      { type: "cryptographic-asset", name: "formulation-crypto" },
    ],
  };

  const result = await postProcess(bomNSData, {
    autoCompositions: true,
    componentType: ["library"],
    includeFormulation: true,
    specVersion: 1.7,
  });

  assert.deepStrictEqual(
    result.bomJson.components.map((component) => component.type),
    ["library"],
  );
  assert.ok(
    result.bomJson.formulation.every((formula) =>
      (formula.components || []).every(
        (component) => component.type === "library",
      ),
    ),
  );
  assert.ok(
    !result.bomJson.dependencies.some(
      (dependency) => dependency.ref === "crypto/demo",
    ),
  );
  assert.deepStrictEqual(
    result.bomJson.dependencies.filter((dependency) =>
      dependency.ref.startsWith("pkg:"),
    ),
    [{ ref: "pkg:generic/demo-lib@1.0.0", dependsOn: [] }],
  );
});

it("postProcess removes remaining 1.7-only fields from metadata, components, and formulation inventories for spec version 1.6", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [
        {
          "bom-ref": "demo-lib",
          type: "library",
          name: "demo-lib",
          version: "1.0.0",
          isExternal: true,
          patentAssertions: [{ patentNumber: "US-123" }],
          versionRange: "vers:npm/>=1.0.0|<2.0.0",
        },
      ],
      formulation: [
        {
          components: [
            {
              type: "library",
              name: "formulation-lib",
              version: "2.0.0",
              isExternal: true,
              versionRange: "vers:npm/>=2.0.0|<3.0.0",
            },
          ],
          services: [
            {
              name: "formulation-service",
              patentAssertions: [{ patentNumber: "US-456" }],
            },
          ],
        },
      ],
      metadata: {
        distributionConstraints: { tlp: "GREEN" },
        component: {
          type: "application",
          name: "demo-app",
          version: "1.0.0",
          isExternal: true,
          versionRange: "vers:npm/>=1.0.0|<2.0.0",
        },
        properties: [],
        tools: {
          components: [{ name: "cdxgen" }],
        },
      },
      services: [
        {
          name: "demo-service",
          patentAssertions: [{ patentNumber: "US-789" }],
        },
      ],
    },
  };

  const result = await postProcess(bomNSData, { specVersion: 1.6 });
  const rootComponent = result.bomJson.components[0];
  const formulationComponent = result.bomJson.formulation[0].components[0];
  const rootService = result.bomJson.services[0];
  const formulationService = result.bomJson.formulation[0].services[0];
  const metadataComponent = result.bomJson.metadata.component;

  assert.strictEqual(
    result.bomJson.metadata.distributionConstraints,
    undefined,
  );
  assert.strictEqual(rootComponent.isExternal, undefined);
  assert.strictEqual(rootComponent.patentAssertions, undefined);
  assert.strictEqual(rootComponent.versionRange, undefined);
  assert.strictEqual(formulationComponent.isExternal, undefined);
  assert.strictEqual(formulationComponent.versionRange, undefined);
  assert.strictEqual(rootService.patentAssertions, undefined);
  assert.strictEqual(formulationService.patentAssertions, undefined);
  assert.strictEqual(metadataComponent.isExternal, undefined);
  assert.strictEqual(metadataComponent.versionRange, undefined);
});

it("postProcess preserves user-supplied patentAssertions at spec version 1.7 (round-trip)", async () => {
  // cdxgen has no patent data source and never fabricates one, but a component
  // supplied by the user (e.g. via a parent component or merged BOM) must
  // round-trip at 1.7 and be stripped only on downgrade. See acceptance: the
  // downgrade side is covered by the 1.7-only-fields test above.
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [
        {
          "bom-ref": "pkg:npm/patented-lib@1.0.0",
          type: "library",
          name: "patented-lib",
          version: "1.0.0",
          patentAssertions: [
            { patentNumber: "US-12345678-B2", claim: "claim 1" },
          ],
        },
      ],
      metadata: { tools: { components: [{ name: "cdxgen" }] } },
    },
  };
  const result = await postProcess(bomNSData, { specVersion: 1.7 });
  assert.deepStrictEqual(result.bomJson.components[0].patentAssertions, [
    { patentNumber: "US-12345678-B2", claim: "claim 1" },
  ]);
});

it("postProcess strips root-level citations (a 1.7-only element) when downgrading to 1.6", async () => {
  // A citation carries a real attribution to the cdxgen tool component, so the
  // root-level `citations` array is genuinely populated before downgrade.
  const cdxgenRef = "pkg:npm/@cdxgen/cdxgen@1.0.0";
  const bomJsonWithCitations = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: {
      tools: { components: [{ name: "cdxgen", "bom-ref": cdxgenRef }] },
    },
    citations: [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        pointers: ["/components"],
        attributedTo: cdxgenRef,
      },
    ],
  };
  const result = await postProcess(
    { bomJson: bomJsonWithCitations },
    { specVersion: 1.6 },
  );
  // The 1.7-only root element must not survive a 1.6 downgrade, otherwise
  // downstream schema validation rejects the document.
  assert.strictEqual(result.bomJson.citations, undefined);
});

it("a 1.7-generate-then-downgrade-to-1.6 run is root-equivalent to a direct 1.6 generation", async () => {
  // Equivalence: post-processing the same BOM at 1.7 and at 1.6 must yield the
  // same set of root-level keys (modulo specVersion). This guards against a
  // 1.7-only root element leaking into a 1.6 document through any path.
  const baseBom = () => ({
    bomFormat: "CycloneDX",
    metadata: {
      tools: {
        components: [
          { name: "cdxgen", "bom-ref": "pkg:npm/@cdxgen/cdxgen@1.0.0" },
        ],
      },
    },
    components: [
      {
        type: "library",
        name: "demo",
        version: "1.0.0",
        "bom-ref": "pkg:npm/demo@1.0.0",
      },
    ],
  });
  const at17 = await postProcess(
    { bomJson: { ...baseBom(), specVersion: "1.7" } },
    { specVersion: 1.7 },
  );
  const downgraded = await postProcess(
    {
      bomJson: JSON.parse(JSON.stringify({ ...baseBom(), specVersion: "1.7" })),
    },
    { specVersion: 1.6 },
  );
  const direct16 = await postProcess(
    { bomJson: { ...baseBom(), specVersion: "1.6" } },
    { specVersion: 1.6 },
  );
  // At 1.7 citations is expected (inventory is attributed to cdxgen).
  assert.ok(Array.isArray(at17.bomJson.citations), "1.7 emits citations");
  // After downgrade, no 1.7-only root key remains.
  assert.strictEqual(downgraded.bomJson.citations, undefined);
  // The downgraded root keys must match a direct 1.6 generation exactly.
  assert.deepStrictEqual(
    Object.keys(downgraded.bomJson).sort(),
    Object.keys(direct16.bomJson).sort(),
  );
});

it("postProcess removes remaining 1.6-only fields from metadata, components, and formulation inventories for spec version 1.5", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [
        {
          "bom-ref": "demo-lib",
          type: "library",
          name: "demo-lib",
          version: "1.0.0",
          authors: [{ name: "Alice" }],
          manufacturer: { name: "Acme" },
          omniborId: ["gitoid:blob:sha1:abc"],
          swhid: ["swh:1:rev:def"],
          tags: ["demo"],
        },
      ],
      formulation: [
        {
          components: [
            {
              type: "library",
              name: "formulation-lib",
              version: "2.0.0",
              authors: [{ name: "Bob" }],
              manufacturer: { name: "Builder" },
              omniborId: ["gitoid:blob:sha1:ghi"],
              swhid: ["swh:1:dir:jkl"],
              tags: ["workflow"],
            },
          ],
          services: [
            {
              name: "formulation-service",
              tags: ["ci"],
            },
          ],
        },
      ],
      metadata: {
        manufacturer: { name: "BOM Factory" },
        component: {
          type: "application",
          name: "demo-app",
          version: "1.0.0",
          authors: [{ name: "Carol" }],
          manufacturer: { name: "Acme" },
          tags: ["root"],
        },
        properties: [],
      },
      services: [
        {
          name: "demo-service",
          tags: ["runtime"],
        },
      ],
      dependencies: [
        {
          ref: "demo-lib",
          dependsOn: [],
          provides: ["demo-service"],
        },
      ],
    },
  };

  const result = await postProcess(bomNSData, { specVersion: 1.5 });
  const rootComponent = result.bomJson.components[0];
  const formulationComponent = result.bomJson.formulation[0].components[0];
  const rootService = result.bomJson.services[0];
  const formulationService = result.bomJson.formulation[0].services[0];
  const metadataComponent = result.bomJson.metadata.component;

  assert.strictEqual(result.bomJson.metadata.manufacturer, undefined);
  assert.strictEqual(rootComponent.authors, undefined);
  assert.strictEqual(rootComponent.manufacturer, undefined);
  assert.strictEqual(rootComponent.omniborId, undefined);
  assert.strictEqual(rootComponent.swhid, undefined);
  assert.strictEqual(rootComponent.tags, undefined);
  assert.strictEqual(formulationComponent.authors, undefined);
  assert.strictEqual(formulationComponent.manufacturer, undefined);
  assert.strictEqual(formulationComponent.omniborId, undefined);
  assert.strictEqual(formulationComponent.swhid, undefined);
  assert.strictEqual(formulationComponent.tags, undefined);
  assert.strictEqual(rootService.tags, undefined);
  assert.strictEqual(formulationService.tags, undefined);
  assert.strictEqual(metadataComponent.authors, undefined);
  assert.strictEqual(metadataComponent.manufacturer, undefined);
  assert.strictEqual(metadataComponent.tags, undefined);
  assert.strictEqual(result.bomJson.dependencies[0].provides, undefined);
});

it("postProcess removes service evidence for CycloneDX 1.7 output", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      metadata: {
        properties: [],
      },
      services: [
        {
          "bom-ref": "urn:service:demo",
          name: "demo-service",
          evidence: {
            occurrences: [{ location: "src/demo.js", line: 10 }],
          },
        },
      ],
    },
  };

  const result = await postProcess(bomNSData, { specVersion: 1.7 });

  assert.strictEqual(result.bomJson.services[0].evidence, undefined);
});

it("postProcess removes unsupported evidence occurrence details for spec version 1.5", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [
        {
          type: "file",
          name: "deviceTypeManager.js",
          evidence: {
            occurrences: [
              {
                location: "source/microservices/lib/deviceTypeManager.js",
                line: 11,
                offset: 2,
                symbol: "deviceTypeManager",
                additionalContext: "source-import",
              },
            ],
          },
        },
      ],
      dependencies: [],
      metadata: { properties: [] },
    },
  };
  const result = await postProcess(bomNSData, { specVersion: 1.5 });

  assert.deepStrictEqual(result.bomJson.components[0].evidence.occurrences, [
    {
      location: "source/microservices/lib/deviceTypeManager.js",
    },
  ]);
});

it("postProcess strips license attributes unsupported by each spec version", async () => {
  // license.bom-ref, licensing and properties arrived in 1.5, acknowledgement in 1.6
  const expectedLicenseKeys = {
    1.4: ["name"],
    1.5: ["bom-ref", "name", "licensing", "properties"],
    1.6: ["bom-ref", "name", "acknowledgement", "licensing", "properties"],
    1.7: ["bom-ref", "name", "acknowledgement", "licensing", "properties"],
  };
  const expectedExpressionKeys = {
    1.4: ["expression"],
    1.5: ["expression", "bom-ref"],
    1.6: ["expression", "bom-ref", "acknowledgement"],
    1.7: ["expression", "bom-ref", "acknowledgement"],
  };

  for (const specVersion of [1.4, 1.5, 1.6, 1.7]) {
    const bomNSData = {
      bomJson: {
        bomFormat: "CycloneDX",
        specVersion: String(specVersion),
        metadata: {
          properties: [],
          component: {
            type: "application",
            name: "custom-license",
            version: "1.0.0",
            licenses: [
              {
                license: {
                  "bom-ref": "urn:license:custom",
                  name: "© My Company License",
                  acknowledgement: "declared",
                  licensing: { licenseTypes: ["other"] },
                  properties: [
                    { name: "cdx:license:category", value: "Unstated License" },
                  ],
                },
              },
            ],
          },
        },
        components: [
          {
            type: "library",
            name: "expression-pkg",
            version: "2.0.0",
            licenses: [
              {
                expression: "Apache-2.0 AND MIT",
                "bom-ref": "urn:license:expr",
                acknowledgement: "concluded",
              },
            ],
          },
        ],
        dependencies: [],
      },
    };

    const result = await postProcess(bomNSData, {
      licenseEnhance: false,
      specVersion,
    });

    assert.deepStrictEqual(
      Object.keys(result.bomJson.metadata.component.licenses[0].license),
      expectedLicenseKeys[specVersion],
      `Unexpected license keys for CycloneDX ${specVersion}`,
    );
    assert.deepStrictEqual(
      Object.keys(result.bomJson.components[0].licenses[0]),
      expectedExpressionKeys[specVersion],
      `Unexpected license expression keys for CycloneDX ${specVersion}`,
    );
  }
});

it("postProcess produces a schema-valid bom for a custom npm license across spec versions", async () => {
  const pkgList = await parsePkgJson("./test/data/custom-license/package.json");
  const parsedPkg = pkgList[0];
  assert.deepStrictEqual(getLicenses(parsedPkg), [
    { license: { name: "© My Company License" } },
  ]);

  // 1.4/1.5 are below the v13 spec floor. `lib/cli/cliOptions.js` already refuses
  // them as generation targets, and both validators now reject them, so asserting
  // `validateBom() === true` for those versions tests a combination cdxgen v13
  // cannot produce. (The strip-behaviour test above still covers 1.4/1.5, since
  // `postProcess` itself remains callable with any spec version.)
  for (const specVersion of [1.6, 1.7]) {
    const component = { ...parsedPkg, licenses: getLicenses(parsedPkg) };
    // evidence.identity is unrelated to this test and varies across spec versions
    delete component.license;
    delete component.evidence;
    const bomNSData = {
      bomJson: {
        bomFormat: "CycloneDX",
        specVersion: String(specVersion),
        version: 1,
        metadata: {
          timestamp: new Date().toISOString(),
          properties: [],
          component: { ...component, type: "application" },
        },
        components: [],
        dependencies: [],
      },
    };

    const result = await postProcess(bomNSData, { specVersion });
    const licenses = result.bomJson.metadata.component.licenses;

    assert.strictEqual(licenses.length, 1);
    assert.strictEqual(licenses[0].license.name, "© My Company License");
    if (specVersion < 1.5) {
      assert.strictEqual(licenses[0].license.properties, undefined);
    } else {
      // Enrichment properties are only representable from 1.5 onwards
      assert.ok(
        licenses[0].license.properties.some(
          (p) => p.name === "cdx:license:category",
        ),
      );
    }
    assert.strictEqual(
      await validateBom(result.bomJson),
      true,
      `Custom license bom must be valid for CycloneDX ${specVersion}`,
    );
  }
});

it("postProcess does not merge MCP config inventory discovered during formulation", async () => {
  const tmpDir = join(tmpdir(), `cdxgen-postgen-${Date.now()}`);
  mkdirSync(join(tmpDir, ".vscode"), { recursive: true });
  writeFileSync(
    join(tmpDir, ".vscode", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        gateway: {
          endpoint: "https://demo.ngrok-free.app/mcp",
          transport: "http",
        },
      },
    }),
  );
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [],
      dependencies: [],
      metadata: {
        properties: [],
        tools: {
          components: [
            { group: "@cyclonedx", name: "cdxgen", version: "test" },
          ],
        },
      },
    },
  };
  const options = { includeFormulation: true, specVersion: 1.7 };
  try {
    const result = await postProcess(bomNSData, options, tmpDir);
    assert.ok(
      !result.bomJson.services?.some(
        (service) =>
          service.name === "gateway" &&
          service.properties?.some(
            (property) =>
              property.name === "cdx:mcp:inventorySource" &&
              property.value === "config-file",
          ),
      ),
      "expected MCP config inventory to stay outside post-process formulation merges",
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("postProcess labels formulation execute activities with the Formulation type", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [],
      dependencies: [],
      metadata: { properties: [] },
    },
  };
  const options = { includeFormulation: true, specVersion: 1.5 };
  setDryRunMode(true);
  resetRecordedActivities();
  try {
    await postProcess(bomNSData, options, "/home/runner/work/cdxgen/cdxgen");
    const executeActivities = getRecordedActivities().filter(
      (activity) => activity.kind === "execute",
    );
    assert.ok(
      executeActivities.length > 0,
      "expected formulation generation to record execute activities in dry-run mode",
    );
    assert.ok(
      executeActivities.every(
        (activity) => activity.projectType === "Formulation",
      ),
      "formulation execute activities should be labeled with the Formulation type",
    );
  } finally {
    setDryRunMode(false);
    resetRecordedActivities();
  }
});

it("postProcess attaches releaseNotes to cdxgen metadata tool component", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [],
      dependencies: [],
      metadata: {
        tools: {
          components: [
            {
              // Derived from the same constants the producer uses. Hardcoding
              // "@cyclonedx" here is what let the v13 rename break
              // --release-notes silently: the fixture matched the stale
              // predicate, so the test passed while real BOMs did not.
              group: CDXGEN_TOOL_GROUP,
              name: CDXGEN_TOOL_NAME,
              version: "12.3.0",
              type: "application",
            },
          ],
        },
        properties: [],
      },
    },
  };
  const options = {
    includeReleaseNotes: true,
    releaseNotesCurrentTag: "v1.0.0",
    releaseNotesPreviousTag: "v0.9.0",
    specVersion: 1.7,
    failOnError: true,
  };
  const result = await postProcess(bomNSData, options);
  const cdxTool = result.bomJson.metadata.tools.components[0];
  assert.strictEqual(cdxTool.releaseNotes.title, "Release notes for v1.0.0");
  assert.strictEqual(
    cdxTool.releaseNotes.description,
    "Changes between v0.9.0 and v1.0.0.",
  );
  assert.ok(cdxTool.releaseNotes.timestamp);
  assert.deepStrictEqual(cdxTool.releaseNotes.tags, ["v1.0.0", "v0.9.0"]);
  assert.ok(Array.isArray(cdxTool.releaseNotes.resolves));
  for (const aresolve of cdxTool.releaseNotes.resolves) {
    assert.ok(aresolve.type);
    assert.ok(aresolve.id);
    assert.ok(aresolve.name);
    assert.ok(aresolve.description);
  }
});

it("postProcess refreshes unpackaged native file inventory counts from the final BOM", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [
        {
          name: "demo",
          type: "file",
          properties: [{ name: "internal:is_executable", value: "true" }],
        },
        {
          name: "libdemo.so",
          type: "file",
          properties: [{ name: "internal:is_shared_library", value: "true" }],
        },
      ],
      dependencies: [],
      metadata: {
        properties: [
          { name: "cdx:container:unpackagedExecutableCount", value: "0" },
          {
            name: "cdx:container:unpackagedSharedLibraryCount",
            value: "0",
          },
        ],
        tools: {
          components: [
            { group: "@cyclonedx", name: "cdxgen", version: "test" },
          ],
        },
      },
    },
  };

  const result = await postProcess(bomNSData, { specVersion: 1.7 });
  assert.deepStrictEqual(
    result.bomJson.metadata.properties.filter((property) =>
      property.name.startsWith("cdx:container:unpackaged"),
    ),
    [
      { name: "cdx:container:unpackagedExecutableCount", value: "1" },
      { name: "cdx:container:unpackagedSharedLibraryCount", value: "1" },
    ],
  );
});

it("postProcess fails for weak TLP when sensitive property values are present", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [
        {
          "bom-ref": "urn:service:mcp:gateway:latest",
          name: "gateway",
          properties: [
            {
              name: "cdx:mcp:configuredEndpoints",
              value:
                "https://user:pass@example.com/mcp?access_token=abc123456789",
            },
          ],
          type: "application",
        },
      ],
      dependencies: [],
      metadata: {
        distributionConstraints: { tlp: "CLEAR" },
        properties: [],
        tools: {
          components: [
            { group: "@cyclonedx", name: "cdxgen", version: "test" },
          ],
        },
      },
    },
  };
  assert.rejects(
    async () =>
      await postProcess(bomNSData, { failOnError: true, specVersion: 1.7 }),
    /TLP classification 'CLEAR'/,
  );
});

it("postProcess allows sensitive property values when TLP is strong", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [
        {
          "bom-ref": "urn:service:mcp:gateway:latest",
          name: "gateway",
          properties: [
            {
              name: "cdx:mcp:command",
              value: "Authorization: Bearer super-secret-token-value",
            },
          ],
          type: "application",
        },
      ],
      dependencies: [],
      metadata: {
        distributionConstraints: { tlp: "RED" },
        properties: [],
        tools: {
          components: [
            { group: "@cyclonedx", name: "cdxgen", version: "test" },
          ],
        },
      },
    },
  };
  const result = await postProcess(bomNSData, {
    failOnError: true,
    specVersion: 1.7,
  });
  assert.strictEqual(
    result.bomJson.metadata.distributionConstraints.tlp,
    "RED",
  );
});

it("postProcess does not enforce TLP validation when no TLP is set", async () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      components: [
        {
          "bom-ref": "urn:service:mcp:gateway:latest",
          name: "gateway",
          properties: [
            {
              name: "cdx:mcp:resourceUri",
              value: "https://user:pass@example.com/private#fragment",
            },
          ],
          type: "application",
        },
      ],
      dependencies: [],
      metadata: {
        properties: [],
        tools: {
          components: [
            { group: "@cyclonedx", name: "cdxgen", version: "test" },
          ],
        },
      },
    },
  };
  const result = await postProcess(bomNSData, {
    failOnError: true,
    specVersion: 1.7,
  });
  assert.strictEqual(
    result.bomJson.metadata.distributionConstraints,
    undefined,
  );
});

it("postProcess fails on prohibited licenses when failOnError is set", async () => {
  const makeBom = (licenseId) => ({
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [
        {
          "bom-ref": "pkg:npm/sample@1.0.0",
          purl: "pkg:npm/sample@1.0.0",
          name: "sample",
          type: "library",
          licenses: [{ license: { id: licenseId } }],
        },
      ],
      dependencies: [],
      metadata: {
        properties: [],
        tools: {
          components: [
            { group: "@cyclonedx", name: "cdxgen", version: "test" },
          ],
        },
      },
    },
  });
  const opts = {
    licensePolicy: join(process.cwd(), "contrib", "license-policy.yml"),
    licenseEnrich: true,
    failOnError: true,
    specVersion: 1.6,
  };

  // GPL-family license is prohibited by the bundled policy.
  assert.rejects(
    async () => await postProcess(makeBom("GPL-3.0-only"), opts),
    /License policy violation/,
  );

  // A permissive license passes without error.
  const result = await postProcess(makeBom("MIT"), opts);
  assert.strictEqual(result.bomJson.components[0].name, "sample");
});

it("cleanup helpers do not delete directories in dry-run mode", () => {
  const pipTarget = join(tmpdir(), `cdxgen-pip-${Date.now()}`);
  const tmpDir = join(tmpdir(), `cdxgen-tmp-${Date.now()}`);
  mkdirSync(pipTarget, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  process.env.PIP_TARGET = pipTarget;
  process.env.CDXGEN_TMP_DIR = tmpDir;
  setDryRunMode(true);
  try {
    cleanupEnv({});
    cleanupTmpDir();
    assert.ok(existsSync(pipTarget));
    assert.ok(existsSync(tmpDir));
  } finally {
    setDryRunMode(false);
    delete process.env.PIP_TARGET;
    delete process.env.CDXGEN_TMP_DIR;
    rmSync(pipTarget, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

it("filterBom technique keeps matching identity techniques and drops the rest", () => {
  const withTechnique = (name, technique) => ({
    "bom-ref": `pkg:pypi/${name}@1.0.0`,
    name,
    purl: `pkg:pypi/${name}@1.0.0`,
    type: "library",
    evidence: {
      identity: [{ field: "purl", methods: [{ technique, confidence: 0.8 }] }],
    },
  });
  // `filterBom` mutates the document it is handed, so each call needs its own.
  const makeBom = () => ({
    components: [
      withTechnique("kept", "manifest-analysis"),
      withTechnique("dropped", "binary-analysis"),
      // No evidence at all, so there is nothing to filter on.
      {
        "bom-ref": "pkg:pypi/noevidence@1.0.0",
        name: "noevidence",
        type: "library",
      },
    ],
    dependencies: [],
  });
  // Regression: this used to call the non-existent static `Set.intersection`
  // and threw for every `--technique` value other than `auto`.
  assert.deepStrictEqual(
    filterBom(makeBom(), { technique: ["manifest-analysis"] }).components.map(
      (c) => c.name,
    ),
    ["kept", "noevidence"],
  );
  // `auto` disables the filter entirely.
  assert.deepStrictEqual(
    filterBom(makeBom(), { technique: ["auto"] }).components.map((c) => c.name),
    ["kept", "dropped", "noevidence"],
  );
});

// ---------------------------------------------------------------------------
// Build introspection wiring
// ---------------------------------------------------------------------------

const INTROSPECTION_FIXTURE_BOM =
  "./test/repotests/python-smoke/expected/default.json";
const INTROSPECTION_TMP = join(tmpdir(), "cdxgen-postgen-introspect-");

function introspectionBomNSData() {
  return {
    bomJson: JSON.parse(readFileSync(INTROSPECTION_FIXTURE_BOM, "utf-8")),
  };
}

it("postProcess leaves the BOM byte-stable with introspection off", async () => {
  const original = JSON.stringify(introspectionBomNSData().bomJson);
  const result = await postProcess(introspectionBomNSData(), {
    specVersion: 1.6,
  });
  assert.strictEqual(result.reflection, undefined);
  const propertyNames = (result.bomJson.metadata?.properties || []).map(
    (property) => property.name,
  );
  assert.ok(
    !propertyNames.some((name) => name.startsWith("cdx:introspection:")),
    "no introspection property may appear without the opt-in",
  );
  // The reflection attaches no annotations either; whatever annotations exist
  // are the annotator's own.
  for (const annotation of result.bomJson.annotations || []) {
    assert.ok(
      !`${annotation.text}`.includes("cdx:introspection:"),
      "no introspection annotation may appear without the opt-in",
    );
  }
  assert.strictEqual(
    JSON.stringify(result.bomJson).includes("cdx:introspection:"),
    false,
  );
  assert.ok(original.length > 0);
});

it("postProcess carries the introspection verdict in the BOM with --introspect", async () => {
  const result = await postProcess(introspectionBomNSData(), {
    introspect: true,
    projectType: ["python"],
    specVersion: 1.6,
    output: join(INTROSPECTION_TMP, "annotate", "bom.json"),
  });
  assert.ok(result.reflection, "the reflection is attached");
  assert.ok(result.reflection.scoring, "the scoring is attached");
  const propertyNames = new Set(
    (result.bomJson.metadata?.properties || []).map(
      (property) => property.name,
    ),
  );
  for (const name of [
    "cdx:introspection:schemaVersion",
    "cdx:introspection:score",
    "cdx:introspection:ledgerComplete",
    "cdx:introspection:remediationCount",
  ]) {
    assert.ok(propertyNames.has(name), `metadata must carry ${name}`);
  }
  assert.ok(
    [...propertyNames].some((name) =>
      name.startsWith("cdx:introspection:ecosystem:python:"),
    ),
    "the graded dart row carries per-ecosystem properties",
  );
  const annotations = result.bomJson.annotations || [];
  assert.ok(
    annotations.some((annotation) =>
      `${annotation.text}`.includes("Build introspection: overall"),
    ),
    "a summary annotation is attached",
  );
  assert.strictEqual(await validateBom(result.bomJson), true);
  rmSync(join(INTROSPECTION_TMP, "annotate"), { recursive: true, force: true });
});

it("postProcess keeps the first verdict when an enriched BOM is re-processed", async () => {
  const options = {
    introspect: true,
    projectType: ["python"],
    specVersion: 1.6,
    output: join(INTROSPECTION_TMP, "reentry", "bom.json"),
  };
  const first = await postProcess(introspectionBomNSData(), options, "/tmp");
  const verdictOf = (bomJson) =>
    (bomJson.metadata?.properties || [])
      .filter((property) => property.name.startsWith("cdx:introspection:"))
      .map((property) => `${property.name}=${property.value}`)
      .sort()
      .join(",");
  const firstVerdict = verdictOf(first.bomJson);
  // Evidence collection re-processes the finished BOM through a fresh
  // wrapper and without the scanned path; that pass must not re-grade a
  // project it cannot see.
  const second = await postProcess({ bomJson: first.bomJson }, options);
  assert.strictEqual(verdictOf(second.bomJson), firstVerdict);
  assert.strictEqual(
    (second.bomJson.annotations || []).filter((annotation) =>
      `${annotation.text}`.includes("Build introspection: overall"),
    ).length,
    1,
    "exactly one summary annotation survives re-processing",
  );
  rmSync(join(INTROSPECTION_TMP, "reentry"), { recursive: true, force: true });
});

it("postProcess validates with introspection at spec versions 1.6 and 1.7", async () => {
  for (const specVersion of [1.6, 1.7]) {
    const result = await postProcess(introspectionBomNSData(), {
      introspect: true,
      projectType: ["python"],
      specVersion,
      introspectAnnotate: true,
      output: join(INTROSPECTION_TMP, `v${specVersion}`, "bom.json"),
    });
    assert.strictEqual(await validateBom(result.bomJson), true);
    rmSync(join(INTROSPECTION_TMP, `v${specVersion}`), {
      recursive: true,
      force: true,
    });
  }
});

it("postProcess keeps properties but skips annotations below CycloneDX 1.5", async () => {
  const result = await postProcess(introspectionBomNSData(), {
    introspect: true,
    projectType: ["python"],
    specVersion: 1.4,
    output: join(INTROSPECTION_TMP, "v14", "bom.json"),
  });
  const propertyNames = (result.bomJson.metadata?.properties || []).map(
    (property) => property.name,
  );
  assert.ok(
    propertyNames.includes("cdx:introspection:schemaVersion"),
    "the properties are version-independent",
  );
  for (const annotation of result.bomJson.annotations || []) {
    assert.ok(
      !`${annotation.text}`.includes("cdx:introspection:"),
      "annotations are not attached below CycloneDX 1.5",
    );
  }
  rmSync(join(INTROSPECTION_TMP, "v14"), { recursive: true, force: true });
});

it("postProcess writes the reports and decides the CI gate without enforcing it", async () => {
  const output = join(INTROSPECTION_TMP, "gate", "bom.json");
  const result = await postProcess(introspectionBomNSData(), {
    introspect: true,
    projectType: ["python"],
    specVersion: 1.6,
    introspectFailBelow: 70,
    output,
  });
  assert.ok(existsSync(`${output}.introspection.md`));
  assert.ok(existsSync(`${output}.introspection.json`));
  assert.ok(result.introspectionGate, "the gate decision rides on bomNSData");
  assert.strictEqual(result.introspectionGate.threshold, 70);
  assert.strictEqual(result.introspectionGate.passed, false);
  assert.strictEqual(typeof result.introspectionGate.score, "number");

  const json = JSON.parse(
    readFileSync(`${output}.introspection.json`, "utf-8"),
  );
  assert.deepEqual(json.gate, {
    threshold: 70,
    passed: false,
  });
  rmSync(join(INTROSPECTION_TMP, "gate"), { recursive: true, force: true });

  const passing = await postProcess(introspectionBomNSData(), {
    introspect: true,
    projectType: ["python"],
    specVersion: 1.6,
    introspectFailBelow: 10,
    output: join(INTROSPECTION_TMP, "gate-pass", "bom.json"),
  });
  assert.strictEqual(passing.introspectionGate.passed, true);
  rmSync(join(INTROSPECTION_TMP, "gate-pass"), {
    recursive: true,
    force: true,
  });
});

it("extractBuildOnlyComponents moves host-only components out of the assembly", () => {
  const buildBom = () => ({
    components: [
      { name: "app", "bom-ref": "pkg:cargo/app@0.1.0" },
      {
        name: "cc",
        "bom-ref": "pkg:cargo/cc@1.0.0",
        properties: [{ name: "cdx:cargo:hostOnly", value: "true" }],
      },
      {
        name: "libc",
        "bom-ref": "pkg:cargo/libc@0.2.0",
        properties: [{ name: "cdx:cargo:dependencyKind", value: "runtime" }],
      },
    ],
  });
  // The move does not wait for --include-formulation.
  const bomJson = buildBom();
  const moved = extractBuildOnlyComponents(bomJson, { specVersion: 1.6 });
  assert.deepStrictEqual(
    moved.map((comp) => comp.name),
    ["cc"],
  );
  assert.deepStrictEqual(
    bomJson.components.map((comp) => comp.name),
    ["app", "libc"],
  );
  // formulation is a 1.5+ section, so an older document keeps them.
  const oldSpecBom = buildBom();
  assert.deepStrictEqual(
    extractBuildOnlyComponents(oldSpecBom, { specVersion: 1.4 }),
    [],
  );
  assert.deepStrictEqual(oldSpecBom.components.length, 3);
});

it("applyEvidenceBasedFilter keeps an optional component the analyzers observed", () => {
  const bomJson = {
    components: [
      {
        name: "hex",
        "bom-ref": "pkg:cargo/hex@0.4.0",
        purl: "pkg:cargo/hex@0.4.0",
        scope: "optional",
        evidence: { occurrences: [{ location: "src/main.rs" }] },
      },
      {
        name: "itoa",
        "bom-ref": "pkg:cargo/itoa@1.0.0",
        purl: "pkg:cargo/itoa@1.0.0",
        scope: "optional",
      },
      {
        name: "libc",
        "bom-ref": "pkg:cargo/libc@0.2.0",
        purl: "pkg:cargo/libc@0.2.0",
        scope: "excluded",
        evidence: { occurrences: [{ location: "tests/it.rs" }] },
      },
    ],
  };
  const filtered = applyEvidenceBasedFilter(bomJson, {
    requiredOnly: true,
    evidence: true,
    specVersion: 1.6,
  });
  // The dev dependency keeps its scope: an occurrence in the tests is not
  // evidence that it ships.
  assert.deepStrictEqual(
    filtered.components.map((comp) => comp.name),
    ["hex"],
  );
  assert.deepStrictEqual(filtered.components[0].scope, "required");
  assert.ok(
    filtered.components[0].properties.some(
      (property) =>
        property.name === "cdx:evidence:usage" &&
        property.value === "occurrence",
    ),
  );
});

it("applyMetadata lists the metadata.component manifests as componentSrcFiles", () => {
  // A ruby project's gem is described by metadata.component, whose gemspec
  // sighting used to be invisible to cdx:bom:componentSrcFiles (discussion 4410)
  const bomJson = {
    specVersion: "1.7",
    components: [
      {
        type: "library",
        name: "logger",
        purl: "pkg:gem/logger@1.7.0",
        properties: [
          { name: "internal:SrcFile", value: "/project/Gemfile.lock" },
        ],
      },
    ],
    metadata: {
      component: {
        type: "library",
        name: "project-gem",
        purl: "pkg:gem/project-gem@0.8.1",
        properties: [
          { name: "internal:SrcFile", value: "/project/Gemfile.lock" },
          {
            name: "internal:SrcFile",
            value: "/project/project-gem.gemspec",
          },
        ],
      },
    },
  };
  applyMetadata(bomJson, { projectRoot: undefined });
  const srcFiles = bomJson.metadata.properties.find(
    (prop) => prop.name === "cdx:bom:componentSrcFiles",
  );
  assert.deepStrictEqual(
    srcFiles.value,
    "/project/Gemfile.lock\\n/project/project-gem.gemspec",
  );
});

it("applyMetadata makes the manifests of the project's modules relative", () => {
  // A Mill or sbt module is a sub-component of the project, and its manifest
  // path used to stay absolute, naming the directory of the machine it ran on.
  // Paths under the temporary directory are container layers, made relative
  // to it instead, so the project here is the working directory.
  const projectDir = process.cwd();
  const bomJson = {
    specVersion: "1.7",
    components: [],
    metadata: {
      component: {
        type: "application",
        name: "project",
        components: [
          {
            type: "application",
            name: "app",
            properties: [
              {
                name: "internal:SrcFile",
                value: join(projectDir, "out", "app", "deps.log"),
              },
            ],
            components: [
              {
                type: "application",
                name: "core",
                properties: [
                  {
                    name: "internal:SrcFile",
                    value: join(projectDir, "core", "build.sbt"),
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  };
  applyMetadata(bomJson, { filePath: projectDir });
  const app = bomJson.metadata.component.components[0];
  assert.strictEqual(app.properties[0].value, join("out", "app", "deps.log"));
  assert.strictEqual(
    app.components[0].properties[0].value,
    join("core", "build.sbt"),
  );
  const srcFiles = bomJson.metadata.properties.find(
    (prop) => prop.name === "cdx:bom:componentSrcFiles",
  );
  assert.deepStrictEqual(srcFiles.value.split("\\n").sort(), [
    join("core", "build.sbt"),
    join("out", "app", "deps.log"),
  ]);
});

it("applyMetadata accepts identity methods that name no file", () => {
  // `value` is optional in CycloneDX, and an attestation (the cdxgen plugins
  // manifest records one for each tool) has none.
  const bomJson = {
    specVersion: "1.7",
    components: [
      {
        type: "application",
        name: "trivy",
        purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trivy-cdxgen@v0.74.0",
        evidence: {
          identity: [
            {
              field: "purl",
              confidence: 1,
              methods: [{ technique: "attestation", confidence: 1 }],
            },
          ],
        },
      },
    ],
    metadata: {},
  };
  applyMetadata(bomJson, { projectRoot: undefined });
  assert.deepStrictEqual(bomJson.components[0].evidence.identity[0].methods, [
    { technique: "attestation", confidence: 1 },
  ]);
});

it("applyMetadata adds the custom metadata properties next to the discovered ones", () => {
  const bomJson = {
    specVersion: "1.7",
    components: [
      {
        type: "library",
        name: "logger",
        purl: "pkg:gem/logger@1.7.0",
        properties: [{ name: "internal:SrcFile", value: "Gemfile.lock" }],
      },
    ],
    metadata: {},
  };
  applyMetadata(bomJson, {
    metadataProperties: [
      { name: "org.project.name", value: "otel-mailer" },
      { name: "org.owner", value: "security-team" },
      // A name+value pair that already exists is not repeated
      { name: "org.owner", value: "security-team" },
      // Entries without a name or without a value are dropped
      { name: "", value: "dropped" },
      { name: "org.empty", value: undefined },
    ],
  });
  const names = bomJson.metadata.properties.map((prop) => prop.name);
  assert.deepStrictEqual(names, [
    "cdx:bom:componentTypes",
    "cdx:bom:componentSrcFiles",
    "org.project.name",
    "org.owner",
  ]);
  assert.deepStrictEqual(
    bomJson.metadata.properties.find((prop) => prop.name === "org.owner").value,
    "security-team",
  );
});

it("applyMetadata adds the custom metadata properties to a BOM without components", () => {
  const bomJson = { specVersion: "1.7", metadata: {} };
  applyMetadata(bomJson, {
    metadataProperties: [{ name: "org.owner", value: "security-team" }],
  });
  assert.deepStrictEqual(bomJson.metadata.properties, [
    { name: "org.owner", value: "security-team" },
  ]);
});

it("applyMetadata redacts credential-shaped custom property values", () => {
  const bomJson = {
    specVersion: "1.7",
    components: [],
    metadata: {},
  };
  applyMetadata(bomJson, {
    metadataProperties: [
      { name: "ci.token", value: "ghp_0123456789abcdefghijklmnopqrst" },
    ],
  });
  assert.deepStrictEqual(
    bomJson.metadata.properties.find((prop) => prop.name === "ci.token").value,
    "[redacted]",
  );
});
