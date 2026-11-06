/**
 * Declared coding-agent behaviour at CycloneDX 2.0 (cdxgen/cdxgen#4593).
 *
 * The source is the AI inventory the 1.x parsers already produce
 * (communityAiConfigParser: Kiro agents, Claude subagents and agent
 * definitions). Only real agent definitions count: a component with a
 * `cdx:agent:role`, or whose `cdx:file:kind` is `agent-definition` or
 * `claude-subagent`. Instruction files, specs, steering documents, agent
 * configs and plugins describe or configure agents but are not agents.
 * At 2.0 this module derives:
 *
 * - one party per agent component with a bom-ref
 *   (#/$defs/cyclonedx-party-2.0/$defs/party, role `agent`) whose `system`
 *   (#/$defs/cyclonedx-party-2.0/$defs/system) has kind `agent`, `ref` the
 *   agent component's refId, `label` its name and `permissions` the tool
 *   names its config allows. The allow list is split on the commas outside
 *   parentheses, and each entry is reduced to the tool name before any "("
 *   (`Bash(git status:*)` is `Bash`), so arguments, paths and commands
 *   never reach the BOM. Names that are not safe tool names are dropped
 *   (see lib/inventory/agentToolNames.js). The list is unique and sorted.
 *
 * - one blueprint (#/$defs/cyclonedx-blueprint-2.0/$defs/blueprint,
 *   modelTypes `behavioral`) whose actors reference the agent parties and
 *   whose behaviors.instances carry `acknowledgment: ["declared"]` and a
 *   `behavior` from data/behavior-taxonomy.schema.json:
 *   `ai:agent:invokesTool` when the agent declares tools or MCP servers, and
 *   `ai:agent:requestsUserApproval` when its permission policy has ask rules.
 *   The inventory records only how many MCP servers an agent's own config
 *   names, not which, so instances carry no `targets`: naming the project's
 *   MCP services would claim a binding no config makes.
 *
 * No free text from instruction, skill or MCP files is emitted. Business
 * objectives and use cases are free text, so they are out of scope, and so
 * is observed behaviour.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dirNameStr } from "../core/paths.js";
import { agentToolName, splitAllowList } from "./agentToolNames.js";

/** refId of the derived blueprint. */
export const AGENT_BLUEPRINT_REF_ID = "blueprint-declared-agents";
/** Prefix of every derived agent party refId. */
export const AGENT_PARTY_REF_ID_PREFIX = "party-agent-";

const AGENT_ROLE_PROPERTY = "cdx:agent:role";
const AGENT_DEFINITION_FILE_KINDS = new Set([
  "agent-definition",
  "claude-subagent",
]);
const BEHAVIOR_TAXONOMY = new Set(
  JSON.parse(
    readFileSync(
      join(dirNameStr, "data", "behavior-taxonomy.schema.json"),
      "utf-8",
    ),
  ).enum,
);
const propertyValue = (subject, name) =>
  (subject?.properties || []).find((entry) => entry?.name === name)?.value;

const propertyCount = (subject, name) => {
  const parsed = Number(propertyValue(subject, name));
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Is this internal-model component a real coding-agent definition?
 *
 * @param {object} component Internal-model component
 * @returns {boolean} True for a `cdx:agent:role` component or an
 *   agent-definition / claude-subagent file
 */
export function isDeclaredAgentComponent(component) {
  if (
    (component?.properties || []).some(
      (entry) => entry?.name === AGENT_ROLE_PROPERTY,
    )
  ) {
    return true;
  }
  return AGENT_DEFINITION_FILE_KINDS.has(
    propertyValue(component, "cdx:file:kind"),
  );
}

/**
 * The permissions of an agent: the tool names of `cdx:agent:tools` and the
 * scopes of `cdx:agent:permissionCapabilities`, each reduced to the name
 * before any "(", unique and sorted.
 *
 * @param {object} component Internal-model agent component
 * @returns {string[]} Permission names
 */
export function declaredAgentPermissions(component) {
  const names = [
    ...splitAllowList(propertyValue(component, "cdx:agent:tools")),
    ...splitAllowList(
      propertyValue(component, "cdx:agent:permissionCapabilities"),
    ),
  ]
    .map(agentToolName)
    .filter(Boolean);
  return [...new Set(names)].sort();
}

function agentInstances(agent, partyRefId) {
  const instances = [];
  const declaresTools =
    propertyCount(agent, "cdx:agent:toolCount") > 0 ||
    splitAllowList(propertyValue(agent, "cdx:agent:tools")).length > 0 ||
    propertyCount(agent, "cdx:agent:mcpServerCount") > 0;
  if (declaresTools) {
    instances.push({
      refId: `behavior-${partyRefId}-invokes-tool`,
      acknowledgment: ["declared"],
      behavior: "ai:agent:invokesTool",
      actors: [partyRefId],
    });
  }
  if (propertyCount(agent, "cdx:agent:permissionAskRuleCount") > 0) {
    instances.push({
      refId: `behavior-${partyRefId}-requests-approval`,
      acknowledgment: ["declared"],
      behavior: "ai:agent:requestsUserApproval",
      actors: [partyRefId],
    });
  }
  return instances.filter((instance) =>
    BEHAVIOR_TAXONOMY.has(instance.behavior),
  );
}

function agentParty(agent, partyRefId) {
  const system = { kind: "agent", ref: agent["bom-ref"] };
  if (typeof agent.name === "string" && agent.name.length) {
    system.label = agent.name;
  }
  const permissions = declaredAgentPermissions(agent);
  if (permissions.length) {
    system.permissions = permissions;
  }
  return { refId: partyRefId, roles: [{ role: "agent" }], system };
}

/**
 * Collect the 2.0 agent parties and the behavioral blueprint for the
 * declared agents of an internal-model BOM. Agents without a bom-ref are
 * skipped (their party could not point at them); parties are unique by
 * refId.
 *
 * @param {object} internalBom The 1.x-shaped internal model
 * @returns {{parties: object[], blueprint: object|undefined}}
 */
export function collectAgentBehaviour(internalBom) {
  const parties = [];
  const actors = [];
  const instances = [];
  const seen = new Set();
  for (const agent of internalBom?.components || []) {
    const bomRef = agent?.["bom-ref"];
    if (
      typeof bomRef !== "string" ||
      !bomRef.length ||
      !isDeclaredAgentComponent(agent)
    ) {
      continue;
    }
    const partyRefId = `${AGENT_PARTY_REF_ID_PREFIX}${bomRef}`;
    if (seen.has(partyRefId)) {
      continue;
    }
    seen.add(partyRefId);
    parties.push(agentParty(agent, partyRefId));
    actors.push({ refId: `actor-${partyRefId}`, party: { ref: partyRefId } });
    instances.push(...agentInstances(agent, partyRefId));
  }
  if (!instances.length) {
    return { parties, blueprint: undefined };
  }
  return {
    parties,
    blueprint: {
      refId: AGENT_BLUEPRINT_REF_ID,
      name: "Declared coding-agent behaviour",
      modelTypes: ["behavioral"],
      actors,
      behaviors: { instances },
    },
  };
}
