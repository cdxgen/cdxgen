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
