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

import {
  getRecordedActivities,
  resetRecordedActivities,
  setDryRunMode,
} from "../../helpers/utils.js";
import {
  cleanupEnv,
  cleanupTmpDir,
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

it("exclude-type mcp removes inventory artifacts but retains MCP SDK packages", () => {
  const bomJson = {
    components: [
      {
        "bom-ref": "pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0",
        name: "@modelcontextprotocol/server-filesystem",
        purl: "pkg:npm/%40modelcontextprotocol/server-filesystem@1.0.0",
      },
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

it("postProcess adds formulation exactly once when includeFormulation is true", () => {
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
  const result = postProcess(bomNSData, options);
  assert.ok(
    Array.isArray(result.bomJson.formulation),
    "formulation must be an array",
  );
  assert.ok(
    result.bomJson.formulation.length > 0,
    "formulation must have at least one entry",
  );
});

it("postProcess does not add formulation when includeFormulation is false", () => {
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
  const result = postProcess(bomNSData, options);
  assert.strictEqual(
    result.bomJson.formulation,
    undefined,
    "formulation must not be added when disabled",
  );
});

it("postProcess preserves existing formulation and does not overwrite it", () => {
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
  const result = postProcess(bomNSData, options);
  assert.strictEqual(
    result.bomJson.formulation[0]["bom-ref"],
    "already-present",
    "existing formulation must not be overwritten",
  );
});

it("postProcess passes formulationList from bomNSData into the formulation section", () => {
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
  const result = postProcess(bomNSData, options);
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

it("postProcess downgrades certificate crypto properties for spec version 1.6", () => {
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
      dependencies: [],
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
  const result = postProcess(bomNSData, { specVersion: 1.6 });
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

it("postProcess removes remaining 1.7-only fields from metadata, components, and formulation inventories for spec version 1.6", () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [
        {
          type: "library",
          name: "demo-lib",
          version: "1.0.0",
          isExternal: true,
          patentAssertions: [{ patentNumber: "US-123" }],
          versionRange: "vers:npm/>=1.0.0|<2.0.0",
        },
      ],
      dependencies: [],
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

  const result = postProcess(bomNSData, { specVersion: 1.6 });
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

it("postProcess removes remaining 1.6-only fields from metadata, components, and formulation inventories for spec version 1.5", () => {
  const bomNSData = {
    bomJson: {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      components: [
        {
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
      dependencies: [],
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
    },
  };

  const result = postProcess(bomNSData, { specVersion: 1.5 });
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
});

it("postProcess removes unsupported evidence occurrence details for spec version 1.5", () => {
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
  const result = postProcess(bomNSData, { specVersion: 1.5 });

  assert.deepStrictEqual(result.bomJson.components[0].evidence.occurrences, [
    {
      location: "source/microservices/lib/deviceTypeManager.js",
    },
  ]);
});

it("postProcess merges formulation-discovered MCP config services into bomJson.services", () => {
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
    const result = postProcess(bomNSData, options, tmpDir);
    assert.ok(
      result.bomJson.services?.some(
        (service) =>
          service.name === "gateway" &&
          service.properties?.some(
            (property) =>
              property.name === "cdx:mcp:inventorySource" &&
              property.value === "config-file",
          ),
      ),
      "expected config-discovered MCP service to be merged into bomJson.services",
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("postProcess labels formulation execute activities with the Formulation type", () => {
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
    postProcess(bomNSData, options, "/home/runner/work/cdxgen/cdxgen");
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

it("postProcess attaches releaseNotes to cdxgen metadata tool component", () => {
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
              group: "@cyclonedx",
              name: "cdxgen",
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
  const result = postProcess(bomNSData, options);
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

it("postProcess refreshes unpackaged native file inventory counts from the final BOM", () => {
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

  const result = postProcess(bomNSData, { specVersion: 1.7 });
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

it("postProcess fails for weak TLP when sensitive property values are present", () => {
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
  assert.throws(
    () => postProcess(bomNSData, { failOnError: true, specVersion: 1.7 }),
    /TLP classification 'CLEAR'/,
  );
});

it("postProcess allows sensitive property values when TLP is strong", () => {
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
  const result = postProcess(bomNSData, {
    failOnError: true,
    specVersion: 1.7,
  });
  assert.strictEqual(
    result.bomJson.metadata.distributionConstraints.tlp,
    "RED",
  );
});

it("postProcess does not enforce TLP validation when no TLP is set", () => {
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
  const result = postProcess(bomNSData, {
    failOnError: true,
    specVersion: 1.7,
  });
  assert.strictEqual(
    result.bomJson.metadata.distributionConstraints,
    undefined,
  );
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
