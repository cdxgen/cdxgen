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
 *   names its config allows. A permission is reduced to the tool name before
 *   any "(" (`Bash(git status:*)` is `Bash`), so arguments, paths and
 *   commands never reach the BOM, and names that are not plain identifiers
 *   are dropped. The list is unique and sorted.
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
/** refId of the derived blueprint. */
export declare const AGENT_BLUEPRINT_REF_ID = "blueprint-declared-agents";
/** Prefix of every derived agent party refId. */
export declare const AGENT_PARTY_REF_ID_PREFIX = "party-agent-";
/**
 * Is this internal-model component a real coding-agent definition?
 *
 * @param {object} component Internal-model component
 * @returns {boolean} True for a `cdx:agent:role` component or an
 *   agent-definition / claude-subagent file
 */
export declare function isDeclaredAgentComponent(component: object): boolean;
/**
 * The permissions of an agent: the tool names of `cdx:agent:tools` and the
 * scopes of `cdx:agent:permissionCapabilities`, each reduced to the name
 * before any "(", unique and sorted.
 *
 * @param {object} component Internal-model agent component
 * @returns {string[]} Permission names
 */
export declare function declaredAgentPermissions(component: object): string[];
/**
 * Collect the 2.0 agent parties and the behavioral blueprint for the
 * declared agents of an internal-model BOM. Agents without a bom-ref are
 * skipped (their party could not point at them); parties are unique by
 * refId.
 *
 * @param {object} internalBom The 1.x-shaped internal model
 * @returns {{parties: object[], blueprint: object|undefined}}
 */
export declare function collectAgentBehaviour(internalBom: object): {
    parties: object[];
    blueprint: object | undefined;
};
//# sourceMappingURL=agentBlueprint.d.ts.map