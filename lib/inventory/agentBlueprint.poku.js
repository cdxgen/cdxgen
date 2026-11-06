import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { assertRefIntegrity } from "../../test/helpers/cyclonedx20RefIntegrity.js";
import { createBom } from "../cli/index.js";
import { postProcess } from "../stages/postgen/postgen.js";
import precompiled20 from "../validator/generated/validate-2.0.mjs";
import {
  AGENT_BLUEPRINT_REF_ID,
  collectAgentBehaviour,
  declaredAgentPermissions,
  isDeclaredAgentComponent,
} from "./agentBlueprint.js";
import { readCycloneDx20, renderCycloneDx20 } from "./cyclonedx20.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURE = join(REPO_ROOT, "test", "data", "ai-agent-declared");
const AGENT_REF =
  "urn:component:claude-subagent:agent-definition:tooling:tooling.md";
const AGENT_PARTY = `party-agent-${AGENT_REF}`;

// Planted in the fixture's AGENTS.md, .claude/agents/tooling.md (body,
// frontmatter description and tools), .claude/skills/deploy/SKILL.md and
// mcp.json; no BOM may contain any.
const SECRET_CANARIES = [
  "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",
  "ghp_dddddddddddddddddddddddddddddddddddddd",
  "ghp_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "ghp_cccccccccccccccccccccccccccccccccccccc",
  "sk-abcdef0123456789abcdef0123456789abcdef01",
  "sk-live-abcdef0123456789",
  "token=ea4c1c2d3b",
  "Bearer eyJhbGciOi",
];
// Planted inside the parentheses of a tool permission in
// .claude/agents/tooling.md, after a comma. The 1.x `cdx:agent:tools`
// property keeps the permission text, so only the derived 2.0 sections
// (agent parties and blueprint) are checked for it.
const PERMISSION_ARGUMENT_CANARY = "hunter2canarysecret";
const FIXTURE_FILES = [
  "AGENTS.md",
  "mcp.json",
  join(".claude", "agents", "tooling.md"),
  join(".claude", "skills", "deploy", "SKILL.md"),
];

// `-t ai` runs the community agent parsers; `-t mcp` the MCP config parser,
// which reads the fixture's mcp.json. No install: the fixture has a
// package.json, and an install would write a lockfile into it.
async function generateBom(specVersion, fixture = FIXTURE) {
  const options = {
    projectType: ["ai", "mcp"],
    installDeps: false,
    specVersion,
  };
  const bomNSData = await createBom(fixture, options);
  return postProcess(bomNSData, options, fixture);
}

const EXPECTED_PARTY = {
  refId: AGENT_PARTY,
  roles: [{ role: "agent" }],
  system: {
    kind: "agent",
    ref: AGENT_REF,
    label: "tooling",
    permissions: ["Bash", "Grep", "Read"],
  },
};

const EXPECTED_BLUEPRINT = {
  refId: "blueprint-declared-agents",
  name: "Declared coding-agent behaviour",
  modelTypes: ["behavioral"],
  actors: [{ refId: `actor-${AGENT_PARTY}`, party: { ref: AGENT_PARTY } }],
  behaviors: {
    instances: [
      {
        refId: `behavior-${AGENT_PARTY}-invokes-tool`,
        acknowledgment: ["declared"],
        behavior: "ai:agent:invokesTool",
        actors: [AGENT_PARTY],
      },
    ],
  },
};

describe("declared coding-agent behaviour (#4593)", () => {
  it("declares the fixture's agent as a party with its tool names", async () => {
    const bom20 = (await generateBom("2.0")).bomJson;
    assert.ok(precompiled20(bom20), "the behaviour document validates");
    assertRefIntegrity(bom20, "ai-agent-declared");
    assert.deepStrictEqual(
      bom20.definitions.parties.filter(
        (party) => party.system?.kind === "agent",
      ),
      [EXPECTED_PARTY],
    );
    assert.deepStrictEqual(bom20.blueprints, [EXPECTED_BLUEPRINT]);
    const derivedText = JSON.stringify([
      bom20.definitions.parties,
      bom20.blueprints,
    ]);
    for (const canary of [PERMISSION_ARGUMENT_CANARY, ...SECRET_CANARIES]) {
      assert.ok(!derivedText.includes(canary), canary);
    }
    const taxonomy = JSON.parse(
      readFileSync(join("data", "behavior-taxonomy.schema.json"), "utf-8"),
    ).enum;
    for (const instance of bom20.blueprints[0].behaviors.instances) {
      assert.ok(taxonomy.includes(instance.behavior), instance.behavior);
    }
  });

  it("parses the MCP config and leaks no planted secret at 1.7 or 2.0", async () => {
    for (const file of FIXTURE_FILES) {
      assert.ok(existsSync(join(FIXTURE, file)), `fixture has ${file}`);
    }
    const planted = FIXTURE_FILES.map((file) =>
      readFileSync(join(FIXTURE, file), "utf-8"),
    ).join("\n");
    for (const canary of SECRET_CANARIES) {
      assert.ok(planted.includes(canary), `the fixture plants ${canary}`);
    }
    assert.ok(planted.includes(`admin,${PERMISSION_ARGUMENT_CANARY},`));
    for (const specVersion of ["1.7", "2.0"]) {
      const bomNSData = await generateBom(specVersion);
      const model = bomNSData.internalBomJson ?? bomNSData.bomJson;
      // The MCP server of mcp.json and the skill are in the BOM, so their
      // files were read.
      const fetch = model.services.find((service) => service.name === "fetch");
      assert.deepStrictEqual(fetch.endpoints, [
        "https://mcp.example.test/fetch",
      ]);
      assert.ok(
        model.components.some((component) => component.name === "deploy"),
      );
      const serialized = JSON.stringify(bomNSData.bomJson);
      for (const canary of SECRET_CANARIES) {
        assert.ok(
          !serialized.includes(canary),
          `${specVersion} output leaked ${canary.slice(0, 18)}…`,
        );
      }
    }
  });

  it("keeps the 1.7 output free of parties and blueprints", async () => {
    const bom17 = (await generateBom("1.7")).bomJson;
    assert.strictEqual(bom17.blueprints, undefined);
    assert.strictEqual(bom17.definitions?.parties, undefined);
  });

  it("declares no party for steering, spec, permission or hook files", async () => {
    const fixture = join(REPO_ROOT, "test", "data", "kiro-v3-project");
    const bom20 = (await generateBom("2.0", fixture)).bomJson;
    assert.ok(precompiled20(bom20));
    assertRefIntegrity(bom20, "kiro-v3-project");
    const agentParties = bom20.definitions.parties.filter(
      (party) => party.system?.kind === "agent",
    );
    assert.deepStrictEqual(agentParties, [
      {
        refId:
          "party-agent-urn:component:kiro:agent-definition:reviewer:reviewer.json",
        roles: [{ role: "agent" }],
        system: {
          kind: "agent",
          ref: "urn:component:kiro:agent-definition:reviewer:reviewer.json",
          label: "reviewer",
          permissions: ["all", "fs_write"],
        },
      },
    ]);
    assert.ok(!existsSync(join(fixture, "package-lock.json")));
  });
});

describe("agentBlueprint helpers", () => {
  const withKind = (kind) => ({
    "bom-ref": `file:${kind}`,
    properties: [{ name: "cdx:file:kind", value: kind }],
  });

  it("treats only agent roles and agent definitions as agents", () => {
    assert.ok(
      isDeclaredAgentComponent({
        properties: [{ name: "cdx:agent:role", value: "kiro-agent" }],
      }),
    );
    assert.ok(isDeclaredAgentComponent(withKind("agent-definition")));
    assert.ok(isDeclaredAgentComponent(withKind("claude-subagent")));
    for (const kind of [
      "agent-instructions",
      "agent-spec",
      "agent-config",
      "agent-plugin",
      "agent-plugin-listing",
      "agent-skills",
      "prompt-config-file",
    ]) {
      assert.ok(!isDeclaredAgentComponent(withKind(kind)), kind);
    }
  });

  it("reduces permissions to tool names, unique and sorted", () => {
    const permissions = declaredAgentPermissions({
      properties: [
        {
          name: "cdx:agent:tools",
          value:
            "Read, Grep, Bash(git status:*/), Bash(rm -rf /), mcp__github__create_issue, Write(~/.ssh/*), has space, ",
        },
        {
          name: "cdx:agent:permissionCapabilities",
          value: "all,fs_write,Read",
        },
      ],
    });
    assert.deepStrictEqual(permissions, [
      "Bash",
      "Grep",
      "Read",
      "Write",
      "all",
      "fs_write",
      "mcp__github__create_issue",
    ]);
  });

  it("splits only on commas outside parentheses", () => {
    const permissions = declaredAgentPermissions({
      properties: [
        {
          name: "cdx:agent:tools",
          value: "Bash(curl -u admin,hunter2secret,-X POST), Read",
        },
      ],
    });
    assert.deepStrictEqual(permissions, ["Bash", "Read"]);
  });

  it("drops names that look like credentials or use unsafe characters", () => {
    const permissions = declaredAgentPermissions({
      properties: [
        {
          name: "cdx:agent:tools",
          value: [
            "ghp_0123456789abcdefghij",
            "gho_abc",
            "github_pat_11ABCDEFG",
            "sk-proj-abc",
            "xoxb-123-456",
            "AKIAIOSFODNN7EXAMPLE",
            "a1b2c3d4e5f6a7b8c9d0e1f2a3b4",
            "@server/tool",
            "x".repeat(65),
            "mcp__github__*",
            "mcp__github__create_issue",
            "WebFetch",
            "fs_write",
          ].join(", "),
        },
      ],
    });
    assert.deepStrictEqual(permissions, [
      "@server/tool",
      "WebFetch",
      "fs_write",
      "mcp__github__*",
      "mcp__github__create_issue",
    ]);
  });

  it("asks for approval only with an approval gate, and names no targets", () => {
    const agent = (name, askRules) => ({
      "bom-ref": `agent:${name}`,
      name,
      properties: [
        { name: "cdx:agent:role", value: "claude-subagent" },
        { name: "cdx:agent:toolCount", value: "2" },
        { name: "cdx:agent:mcpServerCount", value: "1" },
        { name: "cdx:agent:permissionAskRuleCount", value: `${askRules}` },
      ],
    });
    const { blueprint } = collectAgentBehaviour({
      components: [agent("asker", 3), agent("quiet", 0)],
      services: [
        {
          "bom-ref": "urn:service:mcp:fetch:latest",
          name: "fetch",
          properties: [
            { name: "cdx:mcp:serviceType", value: "configured-server" },
          ],
        },
      ],
    });
    assert.deepStrictEqual(
      blueprint.behaviors.instances.map((instance) => [
        instance.actors[0],
        instance.behavior,
        instance.targets,
      ]),
      [
        ["party-agent-agent:asker", "ai:agent:invokesTool", undefined],
        ["party-agent-agent:asker", "ai:agent:requestsUserApproval", undefined],
        ["party-agent-agent:quiet", "ai:agent:invokesTool", undefined],
      ],
    );
  });

  it("skips agents without a bom-ref and declares each party once", () => {
    const tooling = {
      "bom-ref": "agent:one",
      name: "one",
      properties: [
        { name: "cdx:agent:role", value: "kiro-agent" },
        { name: "cdx:agent:toolCount", value: "1" },
      ],
    };
    const { "bom-ref": _ref, ...unreferenced } = tooling;
    const { parties, blueprint } = collectAgentBehaviour({
      components: [tooling, structuredClone(tooling), unreferenced],
    });
    assert.deepStrictEqual(
      parties.map((party) => party.refId),
      ["party-agent-agent:one"],
    );
    assert.strictEqual(blueprint.actors.length, 1);
  });
});

// cdxgen listed as the tool: the agent sections are derived only then.
const CDXGEN_TOOLS = Object.freeze({
  components: [
    {
      type: "application",
      name: "cdxgen",
      version: "12.9.1",
      "bom-ref": "pkg:npm/@cdxgen/cdxgen@12.9.1",
    },
  ],
});

describe("agent parties and blueprint after a 2.0 read (#4593)", () => {
  const model = (tools = CDXGEN_TOOLS) => ({
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    metadata: {
      ...(tools ? { tools: structuredClone(tools) } : {}),
      component: { "bom-ref": "app", type: "application", name: "app" },
    },
    components: [
      {
        "bom-ref": "agent:reviewer",
        type: "application",
        name: "reviewer",
        properties: [
          { name: "cdx:agent:role", value: "kiro-agent" },
          { name: "cdx:agent:toolCount", value: "1" },
          { name: "cdx:agent:permissionAskRuleCount", value: "1" },
        ],
      },
    ],
  });

  it("derives the agent sections only when cdxgen is a listed tool", () => {
    const listed = renderCycloneDx20(model());
    assert.strictEqual(listed.blueprints?.[0]?.refId, AGENT_BLUEPRINT_REF_ID);
    const foreignTools = {
      components: [
        {
          type: "application",
          name: "syft",
          version: "1.20.0",
          "bom-ref": "pkg:golang/github.com/anchore/syft@v1.20.0",
        },
      ],
    };
    for (const tools of [foreignTools, null]) {
      const rendered = renderCycloneDx20(model(tools));
      assert.strictEqual(rendered.blueprints, undefined);
      assert.ok(
        !(rendered.definitions?.parties || []).some(
          (party) => party.system?.kind === "agent",
        ),
      );
      assert.ok(precompiled20(rendered));
    }
  });

  it("reads its own parties and blueprint back without a loss or a duplicate", () => {
    const bom20 = renderCycloneDx20(model());
    assert.strictEqual(bom20.blueprints.length, 1);
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.deepStrictEqual(losses, []);
    assert.strictEqual(internalBom.cdx20Sections?.blueprints, undefined);
    assert.strictEqual(
      internalBom.cdx20Sections?.definitionsParties,
      undefined,
    );
    const again = renderCycloneDx20(internalBom);
    assert.deepStrictEqual(again, bom20);
    assertRefIntegrity(again, "agent round trip");
    assert.ok(precompiled20(again));
  });

  it("re-derives after an edit and keeps a foreign party and blueprint", () => {
    const bom20 = renderCycloneDx20(model());
    bom20.definitions = {
      ...bom20.definitions,
      parties: [
        {
          refId: "party-acme",
          roles: [{ role: "supplier" }],
          organization: { name: "Acme" },
        },
        ...(bom20.definitions?.parties || []),
      ],
    };
    bom20.blueprints.unshift({
      refId: "blueprint-foreign",
      name: "Foreign",
      modelTypes: ["behavioral"],
    });
    const { internalBom, losses } = readCycloneDx20(bom20);
    assert.deepStrictEqual(losses.map((loss) => loss.pointer).sort(), [
      "/blueprints",
      "/definitions/parties/0",
    ]);
    // The agent's approval gate goes away in the 1.x model.
    internalBom.components[0].properties =
      internalBom.components[0].properties.filter(
        (property) => property.name !== "cdx:agent:permissionAskRuleCount",
      );
    const rendered = renderCycloneDx20(internalBom);
    assert.deepStrictEqual(
      rendered.definitions.parties.map((party) => party.refId),
      ["party-acme", "party-agent-agent:reviewer"],
    );
    assert.deepStrictEqual(
      rendered.blueprints.map((blueprint) => [
        blueprint.refId,
        (blueprint.behaviors?.instances || []).map((i) => i.behavior),
      ]),
      [
        ["blueprint-foreign", []],
        ["blueprint-declared-agents", ["ai:agent:invokesTool"]],
      ],
    );
    assertRefIntegrity(rendered, "edited agent");
    assert.ok(precompiled20(rendered));
  });

  it("drops a carried agent party whose component is gone", () => {
    const stale = model();
    stale.components = [];
    stale.cdx20Sections = {
      definitionsParties: [
        {
          refId: "party-agent-agent:gone",
          roles: [{ role: "agent" }],
          system: { kind: "agent", ref: "agent:gone" },
        },
      ],
      blueprints: [
        {
          refId: "blueprint-declared-agents",
          name: "x",
          modelTypes: ["behavioral"],
        },
      ],
    };
    const rendered = renderCycloneDx20(stale);
    assert.strictEqual(rendered.blueprints, undefined);
    assert.strictEqual(rendered.definitions?.parties, undefined);
  });
});

describe("cdxgen end to end for the declared-agent fixture", () => {
  it("renders a valid 2.0 document through the CLI without installing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cdx20-agent-"));
    try {
      const output = join(cwd, "bom.json");
      const result = spawnSync(
        process.execPath,
        [
          join(REPO_ROOT, "bin", "cdxgen.js"),
          FIXTURE,
          "-t",
          "ai",
          "-t",
          "mcp",
          "--no-install-deps",
          "--spec-version",
          "2.0",
          "-o",
          output,
        ],
        {
          cwd,
          encoding: "utf-8",
          env: { ...process.env, CDXGEN_NO_CACHE: "true" },
        },
      );
      assert.strictEqual(result.status, 0, result.stderr?.slice(-300));
      const bom20 = JSON.parse(readFileSync(output, "utf-8"));
      assert.ok(precompiled20(bom20));
      assertRefIntegrity(bom20, "CLI ai-agent-declared");
      assert.deepStrictEqual(bom20.blueprints, [EXPECTED_BLUEPRINT]);
      const serialized = JSON.stringify(bom20);
      for (const canary of SECRET_CANARIES) {
        assert.ok(!serialized.includes(canary), canary);
      }
      assert.ok(!existsSync(join(FIXTURE, "package-lock.json")));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
