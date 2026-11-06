import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { parse as loadYaml } from "yaml";

import { safeExistsSync } from "../core/fs.js";
import { sanitizeBomPropertyValue } from "../core/propertySanitizer.js";
import {
  kiroPermissionSummaryEntries,
  summarizeKiroPermissions,
} from "../parsers/kiroPermissions.js";
import { isAgentSkillSpecValid } from "./agentSkillSpec.js";
import { summarizeAgentToolList } from "./agentToolNames.js";
import { parseJsonLike } from "./jsonLike.js";
import {
  credentialIndicatorsForText,
  sanitizeMcpRefToken,
} from "./mcpDiscovery.js";
import { scanTextForHiddenUnicode } from "./unicodeScan.js";

const COMMUNITY_AI_PATTERNS = [
  "opencode.json",
  "**/opencode.json",
  "opencode.jsonc",
  "**/opencode.jsonc",
  ".opencode/agents/*.md",
  "**/.opencode/agents/*.md",
  ".nanocoder/agents/*.md",
  "**/.nanocoder/agents/*.md",
  ".opencode/{tool,tools}/*.{js,ts,mjs,cjs}",
  "**/.opencode/{tool,tools}/*.{js,ts,mjs,cjs}",
  ".opencode/{skill,skills}/*/SKILL.md",
  "**/.opencode/{skill,skills}/*/SKILL.md",
  ".claude/skills/*/SKILL.md",
  "**/.claude/skills/*/SKILL.md",
  ".agents/skills/*/SKILL.md",
  "**/.agents/skills/*/SKILL.md",
  ".codex/skills/*/SKILL.md",
  "**/.codex/skills/*/SKILL.md",
  "skills/*/SKILL.md",
  "**/skills/*/SKILL.md",
  ".claude-plugin/plugin.json",
  "**/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "**/.claude-plugin/marketplace.json",
  ".claude/agents/*.md",
  "**/.claude/agents/*.md",
  ".claude/commands/**/*.md",
  "**/.claude/commands/**/*.md",
  ".cursor/rules/*.{md,mdc}",
  "**/.cursor/rules/*.{md,mdc}",
  ".windsurf/rules/**/*.md",
  "**/.windsurf/rules/**/*.md",
  ".gemini/{commands,skills}/**/*.md",
  "**/.gemini/{commands,skills}/**/*.md",
  ".roo/{commands,skills}/**/*.md",
  "**/.roo/{commands,skills}/**/*.md",
  ".nanocoder/commands/**/*.md",
  "**/.nanocoder/commands/**/*.md",
  ".nanocoder/skills/**/*.md",
  "**/.nanocoder/skills/**/*.md",
  ".kiro/steering/**/*.md",
  "**/.kiro/steering/**/*.md",
  ".kiro/specs/**/*.md",
  "**/.kiro/specs/**/*.md",
  ".kiro/skills/*/SKILL.md",
  "**/.kiro/skills/*/SKILL.md",
  ".kiro/agents/*.json",
  "**/.kiro/agents/*.json",
  ".kiro/agents/*.md",
  "**/.kiro/agents/*.md",
  ".kiro/settings/permissions.yaml",
  "**/.kiro/settings/permissions.yaml",
  ".kiro/settings/cli.json",
  "**/.kiro/settings/cli.json",
  ".kiro/hooks/*.{json,sh,bash,zsh,ps1}",
  "**/.kiro/hooks/*.{json,sh,bash,zsh,ps1}",
  ".kiro/workflows/*.{yaml,yml,json}",
  "**/.kiro/workflows/*.{yaml,yml,json}",
  // Kiro keeps the same content outside .kiro in repositories that install
  // its CLI configuration at a project root (steering documents, settings,
  // and hooks). Only the settings files are matched as candidates; the
  // steering and hook files are picked up from the validated Kiro root in
  // parse(), so a plain docs steering/ folder never matches anything.
  "settings/permissions.yaml",
  "**/settings/permissions.yaml",
  "settings/cli.json",
  "**/settings/cli.json",
  "langgraph.json",
  "**/langgraph.json",
  "agents.py",
  "**/agents.py",
  "tasks.py",
  "**/tasks.py",
  "config/agents.yaml",
  "**/config/agents.yaml",
  "config/tasks.yaml",
  "**/config/tasks.yaml",
  "config/tools.yaml",
  "**/config/tools.yaml",
];

function addUniqueProperty(properties, name, value) {
  const sanitizedValue = sanitizeBomPropertyValue(name, value);
  if (
    sanitizedValue === undefined ||
    sanitizedValue === null ||
    sanitizedValue === ""
  ) {
    return;
  }
  if (
    properties.some(
      (prop) => prop.name === name && prop.value === String(sanitizedValue),
    )
  ) {
    return;
  }
  properties.push({ name, value: String(sanitizedValue) });
}

function normalizeFilePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function syntaxForFile(filePath) {
  const extension = extname(filePath).toLowerCase();
  if ([".json", ".jsonc"].includes(extension)) {
    return "json";
  }
  if ([".yaml", ".yml"].includes(extension)) {
    return "yaml";
  }
  if ([".md", ".markdown"].includes(extension)) {
    return "markdown";
  }
  return "text";
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/u);
  if (!match) {
    return { body: raw.trim(), metadata: {} };
  }
  let metadata = {};
  try {
    metadata = loadYaml(match[1]) || {};
  } catch {
    metadata = {};
  }
  return { body: match[2].trim(), metadata };
}

function parseYamlSafe(raw) {
  try {
    const doc = loadYaml(raw);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

function parseJsonLikeSafe(raw) {
  try {
    const value = parseJsonLike(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a parsed permissions document holds at least one rule entry that
 * names both a capability and an effect, the shape that sets a Kiro V3
 * permission file apart from any other settings/permissions.yaml.
 *
 * @param {Object} doc Parsed YAML document
 * @returns {boolean} True when the document looks like Kiro permission rules
 */
function hasKiroPermissionRulesShape(doc) {
  return (
    Array.isArray(doc?.rules) &&
    doc.rules.some(
      (rule) =>
        rule !== null &&
        typeof rule === "object" &&
        Object.hasOwn(rule, "capability") &&
        Object.hasOwn(rule, "effect"),
    )
  );
}

/**
 * Whether a parsed cli.json carries at least one `chat.`-prefixed key, the
 * shape only the Kiro CLI writes to its settings file.
 *
 * @param {Object|undefined} settings Parsed cli.json content
 * @returns {boolean} True when a chat-prefixed key is present
 */
function hasKiroChatKeys(settings) {
  return (
    Boolean(settings) &&
    Object.keys(settings).some((key) => key.startsWith("chat."))
  );
}

/**
 * Decide whether a directory is a Kiro configuration root of the layout that
 * keeps steering, settings, and hooks at the project root instead of under
 * .kiro. The check reads the two settings files directly, so a directory that
 * merely contains a docs steering/ folder never qualifies.
 *
 * @param {string} rootDir Candidate root directory
 * @returns {boolean} True when the directory holds Kiro settings
 */
function isKiroConfigurationRoot(rootDir) {
  const permissionsFile = join(rootDir, "settings", "permissions.yaml");
  if (
    safeExistsSync(permissionsFile) &&
    hasKiroPermissionRulesShape(
      parseYamlSafe(readFileSync(permissionsFile, "utf-8")),
    )
  ) {
    return true;
  }
  const cliFile = join(rootDir, "settings", "cli.json");
  return (
    safeExistsSync(cliFile) &&
    hasKiroChatKeys(parseJsonLikeSafe(readFileSync(cliFile, "utf-8")))
  );
}

/**
 * List the files directly inside a directory, or an empty list when the
 * directory is missing or unreadable.
 *
 * @param {string} dirPath Directory to list
 * @returns {string[]} File names
 */
function listFileNames(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Whether a lower-cased path sits in a named directory either at the start of
 * a root-relative path or after a separator, so both `steering/x.md` and
 * `<root>/steering/x.md` match while `my-steering/x.md` does not.
 *
 * @param {string} lowerPath Normalized lower-cased path
 * @param {string} dirName Directory name
 * @returns {boolean} True when the path is inside the named directory
 */
function inNamedDir(lowerPath, dirName) {
  return (
    lowerPath.startsWith(`${dirName}/`) || lowerPath.includes(`/${dirName}/`)
  );
}

function frameworkForFile(filePath, raw = "") {
  const lowerPath = normalizeFilePath(filePath).toLowerCase();
  if (
    lowerPath.includes("/.opencode/") ||
    lowerPath.endsWith("opencode.json") ||
    lowerPath.endsWith("opencode.jsonc")
  ) {
    return "opencode";
  }
  if (lowerPath.includes("/.nanocoder/") || lowerPath.endsWith(".mcp.json")) {
    return "nanocoder";
  }
  if (lowerPath.includes("/.kiro/")) {
    return "kiro";
  }
  // Kiro keeps its configuration outside .kiro in some repositories. The
  // settings files below only name the framework when their content matches
  // the Kiro shapes, so a plain settings folder stays community-ai.
  if (
    lowerPath.endsWith("/settings/permissions.yaml") &&
    hasKiroPermissionRulesShape(parseYamlSafe(raw))
  ) {
    return "kiro";
  }
  if (
    lowerPath.endsWith("/settings/cli.json") &&
    hasKiroChatKeys(parseJsonLikeSafe(raw))
  ) {
    return "kiro";
  }
  if (lowerPath.includes("/.cursor/rules/")) {
    return "cursor";
  }
  if (lowerPath.includes("/.windsurf/rules/")) {
    return "windsurf";
  }
  if (lowerPath.includes("/.gemini/")) {
    return "gemini";
  }
  if (lowerPath.includes("/.roo/")) {
    return "roo";
  }
  if (lowerPath.endsWith("langgraph.json")) {
    return "langgraph";
  }
  if (
    lowerPath.endsWith("agents.py") ||
    lowerPath.endsWith("tasks.py") ||
    lowerPath.includes("/config/agents.yaml") ||
    lowerPath.includes("/config/tasks.yaml") ||
    lowerPath.includes("/config/tools.yaml") ||
    /\bcrewai\b/u.test(raw)
  ) {
    return "crewai";
  }
  if (lowerPath.includes("/.claude/skills/")) {
    return "claude-compatible";
  }
  if (lowerPath.includes("/.claude-plugin/")) {
    return "claude-plugin";
  }
  if (lowerPath.includes("/.claude/agents/")) {
    return "claude-subagent";
  }
  if (lowerPath.includes("/.claude/commands/")) {
    return "claude-command";
  }
  if (lowerPath.includes("/.codex/skills/")) {
    return "codex";
  }
  if (lowerPath.includes("/.agents/skills/")) {
    return "agent-compatible";
  }
  if (/(?:^|\/)skills\/[^/]+\/skill\.md$/u.test(lowerPath)) {
    return "agent-skills";
  }
  return "community-ai";
}

function baseProperties(filePath, framework, kind) {
  return [
    { name: "internal:SrcFile", value: filePath },
    { name: "cdx:file:kind", value: kind },
    { name: "cdx:agent:inventorySource", value: "community-config" },
    { name: "cdx:agent:framework", value: framework },
  ];
}

function createComponent(
  filePath,
  framework,
  kind,
  name,
  type = "application",
) {
  return {
    "bom-ref": `urn:component:${framework}:${kind}:${sanitizeMcpRefToken(name)}:${sanitizeMcpRefToken(basename(filePath))}`,
    name,
    properties: baseProperties(filePath, framework, kind),
    type,
    version: type === "file" ? undefined : "configured",
  };
}

function createService(filePath, framework, kind, name, properties = []) {
  return {
    "bom-ref": `urn:service:${framework}:${kind}:${sanitizeMcpRefToken(name)}`,
    group: framework,
    name,
    properties: baseProperties(filePath, framework, kind).concat(properties),
    version: "configured",
  };
}

function maybeAddFileSignals(properties, filePath, raw) {
  const hiddenUnicodeScan = scanTextForHiddenUnicode(raw, {
    syntax: syntaxForFile(filePath),
  });
  if (hiddenUnicodeScan.hasHiddenUnicode) {
    addUniqueProperty(properties, "cdx:file:hasHiddenUnicode", "true");
    addUniqueProperty(
      properties,
      "cdx:file:hiddenUnicodeCodePoints",
      hiddenUnicodeScan.codePoints.join(","),
    );
    addUniqueProperty(
      properties,
      "cdx:file:hiddenUnicodeLineNumbers",
      hiddenUnicodeScan.lineNumbers.join(","),
    );
  }
  const credentialIndicators = credentialIndicatorsForText(raw);
  if (credentialIndicators.length) {
    addUniqueProperty(properties, "cdx:agent:credentialExposure", "true");
    addUniqueProperty(
      properties,
      "cdx:agent:credentialRiskIndicators",
      credentialIndicators.join(","),
    );
  }
}

function parseSkillFile(filePath, raw) {
  const framework = frameworkForFile(filePath, raw);
  const { metadata } = parseFrontmatter(raw);
  if (!metadata?.name && !metadata?.description) {
    return [];
  }
  const component = createComponent(
    filePath,
    framework,
    "skill-file",
    metadata?.name || basename(dirname(filePath)),
    "file",
  );
  addUniqueProperty(component.properties, "cdx:skill:name", metadata?.name);
  addUniqueProperty(
    component.properties,
    "cdx:skill:description",
    metadata?.description,
  );
  addUniqueProperty(
    component.properties,
    "cdx:skill:license",
    metadata?.license,
  );
  addUniqueProperty(
    component.properties,
    "cdx:skill:compatibility",
    metadata?.compatibility,
  );
  if (metadata?.metadata && typeof metadata.metadata === "object") {
    addUniqueProperty(
      component.properties,
      "cdx:skill:metadata",
      metadata.metadata,
    );
  }
  // Record whether the frontmatter satisfies the open Agent Skills constraints
  // as a single reviewer-friendly boolean rather than copying the raw values
  // twice.
  addUniqueProperty(
    component.properties,
    "cdx:skill:specValid",
    isAgentSkillSpecValid(metadata) ? "true" : "false",
  );
  const skillDir = dirname(filePath);
  for (const [subdir, property] of [
    ["scripts", "cdx:skill:hasScripts"],
    ["references", "cdx:skill:hasReferences"],
    ["assets", "cdx:skill:hasAssets"],
  ]) {
    if (safeExistsSync(join(skillDir, subdir))) {
      addUniqueProperty(component.properties, property, "true");
    }
  }
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

/**
 * Parse a Claude Code plugin manifest (`.claude-plugin/plugin.json`) into a
 * single application component describing the plugin.
 *
 * @param {string} filePath Manifest path
 * @param {string} raw File contents
 * @returns {Object[]} Component list (one plugin component or empty)
 */
function parsePluginManifest(filePath, raw) {
  let manifest;
  try {
    manifest = parseJsonLike(raw);
  } catch {
    return [];
  }
  if (!manifest?.name) {
    return [];
  }
  const component = createComponent(
    filePath,
    "claude-plugin",
    "agent-plugin",
    manifest.name,
  );
  if (manifest.version) {
    component.version = String(manifest.version);
  }
  addUniqueProperty(
    component.properties,
    "cdx:plugin:description",
    manifest.description,
  );
  addUniqueProperty(
    component.properties,
    "cdx:plugin:author",
    typeof manifest.author === "string"
      ? manifest.author
      : manifest.author?.name,
  );
  for (const [key, property] of [
    ["commands", "cdx:plugin:commandCount"],
    ["agents", "cdx:plugin:agentCount"],
    ["skills", "cdx:plugin:skillCount"],
    ["hooks", "cdx:plugin:hookCount"],
    ["mcpServers", "cdx:plugin:mcpServerCount"],
  ]) {
    const value = manifest[key];
    if (Array.isArray(value)) {
      addUniqueProperty(component.properties, property, String(value.length));
    } else if (value && typeof value === "object") {
      addUniqueProperty(
        component.properties,
        property,
        String(Object.keys(value).length),
      );
    }
  }
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

/**
 * Parse a Claude Code plugin marketplace file
 * (`.claude-plugin/marketplace.json`) into one component per listed plugin.
 *
 * @param {string} filePath Marketplace path
 * @param {string} raw File contents
 * @returns {Object[]} Component list
 */
function parsePluginMarketplace(filePath, raw) {
  let marketplace;
  try {
    marketplace = parseJsonLike(raw);
  } catch {
    return [];
  }
  const plugins = Array.isArray(marketplace?.plugins)
    ? marketplace.plugins
    : [];
  const components = [];
  for (const plugin of plugins) {
    const name = plugin?.name || plugin?.source;
    if (!name) {
      continue;
    }
    const component = createComponent(
      filePath,
      "claude-plugin",
      "agent-plugin-listing",
      String(name),
    );
    addUniqueProperty(
      component.properties,
      "cdx:plugin:description",
      plugin.description,
    );
    addUniqueProperty(
      component.properties,
      "cdx:plugin:source",
      typeof plugin.source === "string" ? plugin.source : undefined,
    );
    components.push(component);
  }
  return components;
}

/**
 * Parse a Claude Code subagent definition (`.claude/agents/*.md`) into an
 * agent-definition component using its markdown frontmatter.
 *
 * @param {string} filePath Subagent markdown path
 * @param {string} raw File contents
 * @returns {Object[]} Component list
 */
function parseClaudeSubagent(filePath, raw) {
  const { metadata } = parseFrontmatter(raw);
  const name = metadata?.name || basename(filePath, extname(filePath));
  const component = createComponent(
    filePath,
    "claude-subagent",
    "agent-definition",
    name,
  );
  addUniqueProperty(component.properties, "cdx:agent:role", "claude-subagent");
  addUniqueProperty(
    component.properties,
    "cdx:agent:description",
    metadata?.description,
  );
  addUniqueProperty(component.properties, "cdx:agent:model", metadata?.model);
  addUniqueProperty(
    component.properties,
    "cdx:agent:tools",
    summarizeAgentToolList(metadata?.tools),
  );
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

function parseAgentMarkdown(filePath, raw) {
  const framework = frameworkForFile(filePath, raw);
  const { metadata } = parseFrontmatter(raw);
  if (!metadata?.description && !metadata?.name) {
    return [];
  }
  const component = createComponent(
    filePath,
    framework,
    "agent-definition",
    metadata?.name || basename(filePath, extname(filePath)),
  );
  addUniqueProperty(
    component.properties,
    "cdx:agent:description",
    metadata?.description,
  );
  addUniqueProperty(component.properties, "cdx:agent:mode", metadata?.mode);
  addUniqueProperty(component.properties, "cdx:agent:model", metadata?.model);
  addUniqueProperty(
    component.properties,
    "cdx:agent:providerOverride",
    metadata?.provider,
  );
  if (Array.isArray(metadata?.tools)) {
    addUniqueProperty(
      component.properties,
      "cdx:agent:tools",
      summarizeAgentToolList(metadata.tools),
    );
  }
  if (Array.isArray(metadata?.disallowedTools)) {
    addUniqueProperty(
      component.properties,
      "cdx:agent:disallowedTools",
      summarizeAgentToolList(metadata.disallowedTools),
    );
  }
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

/**
 * Add the summarized V3 permission posture of a Kiro agent or settings
 * document to a component property list, using the `cdx:agent:` namespace of
 * the project scan.
 *
 * @param {Object[]} properties Component property list to extend
 * @param {Object} permissionDoc Parsed `permissions` object or YAML document
 */
function addKiroPermissionProperties(properties, permissionDoc) {
  for (const [suffix, value] of Object.entries(
    kiroPermissionSummaryEntries(summarizeKiroPermissions(permissionDoc)),
  )) {
    addUniqueProperty(properties, `cdx:agent:${suffix}`, value);
  }
}

/**
 * Parse a Kiro V3 agent definition (`.kiro/agents/*.json`) into an
 * agent-definition component. Only the name, the model, redacted counts of
 * MCP servers and tools, the permission posture, and the integer upgrade
 * revision are recorded; the prompt, resource values, toolsSettings, and the
 * upgrade fingerprint or source are never copied.
 *
 * @param {string} filePath Agent definition path
 * @param {string} raw File contents
 * @returns {Object[]} Component list (one agent component or empty)
 */
function parseKiroAgentJson(filePath, raw) {
  if (basename(filePath).toLowerCase().endsWith(".example")) {
    return [];
  }
  const agent = parseJsonLikeSafe(raw);
  if (!agent || typeof agent.name !== "string" || !agent.name.trim()) {
    return [];
  }
  const component = createComponent(
    filePath,
    frameworkForFile(filePath, raw),
    "agent-definition",
    agent.name,
  );
  addUniqueProperty(component.properties, "cdx:agent:role", "kiro-agent");
  if (typeof agent.model === "string") {
    addUniqueProperty(component.properties, "cdx:agent:model", agent.model);
  }
  if (agent.mcpServers && typeof agent.mcpServers === "object") {
    addUniqueProperty(
      component.properties,
      "cdx:agent:mcpServerCount",
      Object.keys(agent.mcpServers).length,
    );
  }
  if (Array.isArray(agent.tools)) {
    addUniqueProperty(
      component.properties,
      "cdx:agent:toolCount",
      agent.tools.length,
    );
  }
  if (Array.isArray(agent.allowedTools)) {
    addUniqueProperty(
      component.properties,
      "cdx:agent:allowedToolCount",
      agent.allowedTools.length,
    );
  }
  if (agent.permissions && typeof agent.permissions === "object") {
    addKiroPermissionProperties(component.properties, agent.permissions);
  }
  if (Number.isInteger(agent.kiroUpgrade?.revision)) {
    addUniqueProperty(
      component.properties,
      "cdx:agent:upgradeRevision",
      agent.kiroUpgrade.revision,
    );
  }
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

/**
 * Parse a Kiro permission policy (`permissions.yaml`) into a file component
 * carrying the summarized rule posture. Match patterns and other rule text
 * are never copied.
 *
 * @param {string} filePath Permissions file path
 * @param {string} raw File contents
 * @returns {Object[]} Component list
 */
function parseKiroPermissionPolicy(filePath, raw, framework) {
  const component = createComponent(
    filePath,
    framework || frameworkForFile(filePath, raw),
    "permission-policy",
    basename(filePath),
    "file",
  );
  addKiroPermissionProperties(component.properties, parseYamlSafe(raw));
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

// Hook triggers and action types of the Kiro hook schema shared by the CLI
// and the IDE, kept as allowlisted enums so a manifest never contributes free
// text. Matcher values, command strings, and prompts are never emitted.
const KIRO_HOOK_EVENTS = new Map(
  [
    "PostFileCreate",
    "PostFileDelete",
    "PostFileSave",
    "PostTaskExec",
    "PostToolUse",
    "PreTaskExec",
    "PreToolUse",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ].map((event) => [event.toLowerCase(), event]),
);
const KIRO_HOOK_ACTION_TYPES = new Map(
  ["agent", "command"].map((actionType) => [
    actionType.toLowerCase(),
    actionType,
  ]),
);

/**
 * Parse a Kiro hook file (`.kiro/hooks/*.json` and hook scripts) into a file
 * component. JSON manifests contribute the allowlisted lifecycle events,
 * allowlisted action types, and a hook count; scripts contribute the file
 * signals only.
 *
 * @param {string} filePath Hook file path
 * @param {string} raw File contents
 * @returns {Object[]} Component list
 */
function parseKiroHookFile(filePath, raw, framework) {
  const component = createComponent(
    filePath,
    framework || frameworkForFile(filePath, raw),
    "hook-file",
    basename(filePath),
    "file",
  );
  if (basename(filePath).toLowerCase().endsWith(".json")) {
    const manifest = parseJsonLikeSafe(raw);
    const hooks = Array.isArray(manifest?.hooks)
      ? manifest.hooks.filter(
          (hook) => hook !== null && typeof hook === "object",
        )
      : [];
    addUniqueProperty(
      component.properties,
      "cdx:agent:hookCount",
      hooks.length,
    );
    const events = new Set();
    const actionTypes = new Set();
    for (const hook of hooks) {
      if (typeof hook.trigger === "string") {
        const event = KIRO_HOOK_EVENTS.get(hook.trigger.toLowerCase());
        if (event) {
          events.add(event);
        }
      }
      if (typeof hook.action?.type === "string") {
        const actionType = KIRO_HOOK_ACTION_TYPES.get(
          hook.action.type.toLowerCase(),
        );
        if (actionType) {
          actionTypes.add(actionType);
        }
      }
    }
    addUniqueProperty(
      component.properties,
      "cdx:agent:hookEvents",
      [...events].sort().join(","),
    );
    addUniqueProperty(
      component.properties,
      "cdx:agent:hookActionTypes",
      [...actionTypes].sort().join(","),
    );
  }
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

/**
 * Parse a Kiro workflow file (`.kiro/workflows/*`) into a file component.
 * Workflow contents are never copied.
 *
 * @param {string} filePath Workflow file path
 * @param {string} raw File contents
 * @returns {Object[]} Component list
 */
function parseKiroWorkflowFile(filePath, raw, framework) {
  const component = createComponent(
    filePath,
    framework || frameworkForFile(filePath, raw),
    "workflow-file",
    basename(filePath),
    "file",
  );
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

/**
 * Parse a Kiro CLI settings file (`settings/cli.json`) into a file component.
 * Only the default agent name and a count of boolean feature flags are
 * recorded; every other value stays out of the BOM.
 *
 * @param {string} filePath Settings file path
 * @param {string} raw File contents
 * @returns {Object[]} Component list
 */
function parseKiroSettings(filePath, raw, framework) {
  const settings = parseJsonLikeSafe(raw);
  if (!settings) {
    return [];
  }
  const component = createComponent(
    filePath,
    framework || frameworkForFile(filePath, raw),
    "settings",
    basename(filePath),
    "file",
  );
  if (typeof settings["chat.defaultAgent"] === "string") {
    addUniqueProperty(
      component.properties,
      "cdx:agent:defaultAgent",
      settings["chat.defaultAgent"],
    );
  }
  const booleanFlagCount = Object.keys(settings).filter(
    (key) => typeof settings[key] === "boolean",
  ).length;
  if (booleanFlagCount) {
    addUniqueProperty(
      component.properties,
      "cdx:agent:booleanFeatureFlagCount",
      booleanFlagCount,
    );
  }
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

/**
 * Route one Kiro file (under `.kiro` or in a validated Kiro configuration
 * root) to its parser. Files outside these shapes return no components. A
 * validated configuration root names its framework explicitly, because the
 * individual file content of a steering or hook document cannot identify it.
 *
 * @param {string} filePath File path
 * @param {string} raw File contents
 * @param {string} [framework] Framework override for validated root files
 * @returns {Object[]} Component list
 */
function parseKiroLayoutFile(filePath, raw, framework) {
  const resolvedFramework = framework || frameworkForFile(filePath, raw);
  const lowerPath = normalizeFilePath(filePath).toLowerCase();
  if (lowerPath.endsWith("/skill.md")) {
    return parseSkillFile(filePath, raw);
  }
  if (lowerPath.endsWith(".json") && inNamedDir(lowerPath, "agents")) {
    return parseKiroAgentJson(filePath, raw);
  }
  if (inNamedDir(lowerPath, "agents")) {
    return parseAgentMarkdown(filePath, raw);
  }
  if (lowerPath.endsWith(".md") && inNamedDir(lowerPath, "specs")) {
    return parseInstructionMarkdown(
      filePath,
      raw,
      "agent-spec",
      resolvedFramework,
    );
  }
  if (lowerPath.endsWith(".md") && inNamedDir(lowerPath, "steering")) {
    return parseInstructionMarkdown(
      filePath,
      raw,
      undefined,
      resolvedFramework,
    );
  }
  if (lowerPath.endsWith("/permissions.yaml")) {
    return parseKiroPermissionPolicy(filePath, raw, resolvedFramework);
  }
  if (lowerPath.endsWith("/cli.json")) {
    return parseKiroSettings(filePath, raw, resolvedFramework);
  }
  if (inNamedDir(lowerPath, "hooks")) {
    return parseKiroHookFile(filePath, raw, resolvedFramework);
  }
  if (inNamedDir(lowerPath, "workflows")) {
    return parseKiroWorkflowFile(filePath, raw, resolvedFramework);
  }
  return [];
}

/**
 * Pick up the steering, settings, and hook files of a validated Kiro
 * configuration root. Files the parser already received are skipped, so a
 * settings file claimed by its own glob is never parsed twice.
 *
 * @param {string} rootDir Validated Kiro configuration root
 * @param {Set<string>} inputKeys Lower-cased paths already being parsed
 * @param {Object[]} components Component list to append to
 */
function expandKiroConfigurationRoot(rootDir, inputKeys, components) {
  const candidates = [
    ...listFileNames(join(rootDir, "settings")).map((name) =>
      join(rootDir, "settings", name),
    ),
    ...listFileNames(join(rootDir, "steering")).map((name) =>
      join(rootDir, "steering", name),
    ),
    ...listFileNames(join(rootDir, "hooks")).map((name) =>
      join(rootDir, "hooks", name),
    ),
  ];
  for (const candidate of candidates) {
    const lowerCandidate = normalizeFilePath(candidate).toLowerCase();
    if (inputKeys.has(lowerCandidate)) {
      continue;
    }
    const isLayoutFile =
      lowerCandidate.endsWith("/settings/permissions.yaml") ||
      lowerCandidate.endsWith("/settings/cli.json") ||
      (lowerCandidate.endsWith(".md") &&
        inNamedDir(lowerCandidate, "steering")) ||
      (lowerCandidate.endsWith(".json") && inNamedDir(lowerCandidate, "hooks"));
    if (!isLayoutFile) {
      continue;
    }
    let raw;
    try {
      raw = readFileSync(candidate, "utf-8");
    } catch {
      continue;
    }
    components.push(...parseKiroLayoutFile(candidate, raw, "kiro"));
  }
}

function parseNanocoderCommand(filePath, raw) {
  const { metadata } = parseFrontmatter(raw);
  const component = createComponent(
    filePath,
    "nanocoder",
    "custom-command",
    basename(filePath, extname(filePath)),
  );
  addUniqueProperty(
    component.properties,
    "cdx:tool:description",
    metadata?.description,
  );
  addUniqueProperty(
    component.properties,
    "cdx:tool:category",
    metadata?.category,
  );
  addUniqueProperty(component.properties, "cdx:tool:author", metadata?.author);
  addUniqueProperty(
    component.properties,
    "cdx:tool:version",
    metadata?.version,
  );
  if (Array.isArray(metadata?.aliases)) {
    addUniqueProperty(
      component.properties,
      "cdx:tool:aliases",
      metadata.aliases.join(","),
    );
  }
  if (Array.isArray(metadata?.tags)) {
    addUniqueProperty(
      component.properties,
      "cdx:tool:tags",
      metadata.tags.join(","),
    );
  }
  if (Array.isArray(metadata?.triggers)) {
    addUniqueProperty(
      component.properties,
      "cdx:tool:triggers",
      metadata.triggers.join(","),
    );
  }
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

function parseInstructionMarkdown(filePath, raw, kindOverride, framework) {
  const resolvedFramework = framework || frameworkForFile(filePath, raw);
  const { body, metadata } = parseFrontmatter(raw);
  const lowerPath = normalizeFilePath(filePath).toLowerCase();
  const headingMatch = body.match(/^#\s+(.+)$/mu);
  const name =
    metadata?.name ||
    headingMatch?.[1]?.trim() ||
    basename(filePath, extname(filePath));
  if (!name || !body.trim()) {
    return [];
  }
  const kind =
    kindOverride ||
    (lowerPath.includes("/commands/")
      ? "custom-command"
      : lowerPath.includes("/skills/")
        ? "skill-file"
        : "agent-instructions");
  const component = createComponent(
    filePath,
    resolvedFramework,
    kind,
    name,
    "file",
  );
  addUniqueProperty(
    component.properties,
    "cdx:agent:description",
    metadata?.description ||
      body
        .replace(/^#.*$/mu, "")
        .trim()
        .split(/\n{2,}/u)[0],
  );
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
}

function parseOpencodeTools(filePath, raw) {
  if (!/\btool\s*\(/u.test(raw)) {
    return [];
  }
  const components = [];
  const baseName = basename(filePath, extname(filePath));
  const exportMatches = [
    ...raw.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*tool\s*\(/gu),
  ];
  if (!exportMatches.length && /export\s+default\s+tool\s*\(/u.test(raw)) {
    const component = createComponent(
      filePath,
      "opencode",
      "custom-tool",
      baseName,
    );
    const descriptionMatch = raw.match(/description:\s*["'`](.+?)["'`]/u);
    addUniqueProperty(
      component.properties,
      "cdx:tool:description",
      descriptionMatch?.[1],
    );
    maybeAddFileSignals(component.properties, filePath, raw);
    components.push(component);
    return components;
  }
  for (const [index, match] of exportMatches.entries()) {
    const nextIndex =
      index < exportMatches.length - 1
        ? exportMatches[index + 1].index
        : raw.length;
    const block = raw.slice(match.index, nextIndex);
    const component = createComponent(
      filePath,
      "opencode",
      "custom-tool",
      `${baseName}_${match[1]}`,
    );
    const descriptionMatch = block.match(/description:\s*["'`](.+?)["'`]/u);
    addUniqueProperty(
      component.properties,
      "cdx:tool:description",
      descriptionMatch?.[1],
    );
    maybeAddFileSignals(component.properties, filePath, block);
    components.push(component);
  }
  return components;
}

function parseOpencodeConfig(filePath, raw) {
  let config;
  try {
    config = parseJsonLike(raw);
  } catch {
    return [];
  }
  const components = [];
  for (const [agentName, agentConfig] of Object.entries(config?.agent || {})) {
    const component = createComponent(
      filePath,
      "opencode",
      "agent-config",
      agentName,
    );
    addUniqueProperty(
      component.properties,
      "cdx:agent:description",
      agentConfig?.description,
    );
    addUniqueProperty(
      component.properties,
      "cdx:agent:mode",
      agentConfig?.mode,
    );
    addUniqueProperty(
      component.properties,
      "cdx:agent:model",
      agentConfig?.model,
    );
    if (agentConfig?.permission) {
      addUniqueProperty(
        component.properties,
        "cdx:agent:permission",
        agentConfig.permission,
      );
    }
    components.push(component);
  }
  return components;
}

function parseLanggraphConfig(filePath, raw) {
  let config;
  try {
    config = parseJsonLike(raw);
  } catch {
    return { components: [], services: [] };
  }
  const components = [];
  const services = [];
  for (const [graphName, graphRef] of Object.entries(config?.graphs || {})) {
    const component = createComponent(
      filePath,
      "langgraph",
      "graph-definition",
      graphName,
    );
    addUniqueProperty(
      component.properties,
      "cdx:agent:role",
      "langgraph-graph",
    );
    addUniqueProperty(
      component.properties,
      "cdx:langgraph:graphEntryPoint",
      graphRef,
    );
    addUniqueProperty(
      component.properties,
      "cdx:langgraph:envFile",
      config?.env,
    );
    if (Array.isArray(config?.dependencies)) {
      addUniqueProperty(
        component.properties,
        "cdx:langgraph:dependencies",
        config.dependencies.join(","),
      );
    }
    maybeAddFileSignals(component.properties, filePath, raw);
    components.push(component);
    services.push(
      createService(filePath, "langgraph", "graph-service", graphName, [
        { name: "cdx:agent:inventorySource", value: "community-config" },
        { name: "cdx:agent:framework", value: "langgraph" },
        { name: "cdx:agent:role", value: "langgraph-graph" },
        { name: "cdx:langgraph:graphEntryPoint", value: String(graphRef) },
      ]),
    );
  }
  return { components, services };
}

function parseCrewAiYaml(filePath, raw) {
  let config;
  try {
    config = loadYaml(raw);
  } catch {
    return [];
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }
  const kind = filePath.toLowerCase().includes("tasks.yaml")
    ? "crew-task"
    : filePath.toLowerCase().includes("tools.yaml")
      ? "crew-tool"
      : "crew-agent";
  const components = [];
  for (const [entryName, entryConfig] of Object.entries(config)) {
    if (!entryConfig || typeof entryConfig !== "object") {
      continue;
    }
    const component = createComponent(filePath, "crewai", kind, entryName);
    addUniqueProperty(component.properties, "cdx:agent:role", kind);
    addUniqueProperty(
      component.properties,
      "cdx:crewai:role",
      entryConfig?.role,
    );
    addUniqueProperty(
      component.properties,
      "cdx:crewai:goal",
      entryConfig?.goal,
    );
    addUniqueProperty(
      component.properties,
      "cdx:crewai:backstory",
      entryConfig?.backstory,
    );
    addUniqueProperty(
      component.properties,
      "cdx:crewai:expectedOutput",
      entryConfig?.expected_output,
    );
    if (Array.isArray(entryConfig?.tools)) {
      addUniqueProperty(
        component.properties,
        "cdx:crewai:tools",
        entryConfig.tools.join(","),
      );
    }
    if (entryConfig?.agent) {
      addUniqueProperty(
        component.properties,
        "cdx:crewai:assignedAgent",
        entryConfig.agent,
      );
    }
    maybeAddFileSignals(component.properties, filePath, raw);
    components.push(component);
  }
  return components;
}

// Keyword arguments of a CrewAI Agent(...) or Task(...) call that cdxgen
// records, with the property each one becomes.
const CREWAI_TEXT_ARGUMENTS = [
  ["role", "cdx:crewai:role"],
  ["goal", "cdx:crewai:goal"],
  ["backstory", "cdx:crewai:backstory"],
  ["description", "cdx:crewai:description"],
  ["expected_output", "cdx:crewai:expectedOutput"],
];

function isPythonBlank(character) {
  return (
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\f" ||
    character === "\n"
  );
}

function isPythonNameCharacter(character) {
  return (
    character !== undefined &&
    ((character >= "a" && character <= "z") ||
      (character >= "A" && character <= "Z") ||
      (character >= "0" && character <= "9") ||
      character === "_")
  );
}

/**
 * Find the end of the Python string literal whose opening quote is at
 * `index`. A single-quoted literal also ends at a newline, where Python
 * would reject it.
 *
 * @param {string} text Python source
 * @param {number} index offset of the opening quote
 * @param {number} limit offset the literal may not reach past
 * @returns {{contentStart: number, contentEnd: number, end: number}} offsets
 *   of the literal's content and of the first character after it
 */
function pythonStringSpan(text, index, limit) {
  const quote = text[index];
  const delimiter = text.startsWith(quote.repeat(3), index)
    ? quote.repeat(3)
    : quote;
  const contentStart = index + delimiter.length;
  let cursor = contentStart;
  while (cursor < limit) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (delimiter.length === 1 && text[cursor] === "\n") {
      return { contentEnd: cursor, contentStart, end: cursor };
    }
    if (text.startsWith(delimiter, cursor)) {
      return {
        contentEnd: cursor,
        contentStart,
        end: cursor + delimiter.length,
      };
    }
    cursor += 1;
  }
  return { contentEnd: limit, contentStart, end: limit };
}

/**
 * Split Python source into logical lines: a statement together with the
 * lines it continues onto inside brackets, a triple-quoted string or after a
 * backslash. Blank and comment-only lines are left out. Each character is
 * read once, so the cost is linear in the size of the source.
 *
 * @param {string} raw Python source
 * @returns {{start: number, end: number, indent: number}[]} offsets of each
 *   logical line's first non-blank character and of its end, and the width
 *   of its indentation
 */
function pythonLogicalLines(raw) {
  const lines = [];
  let depth = 0;
  let current;
  let cursor = 0;
  while (cursor < raw.length) {
    if (!current) {
      let indent = 0;
      while (raw[cursor] === " " || raw[cursor] === "\t") {
        indent += 1;
        cursor += 1;
      }
      const first = raw[cursor];
      if (first === undefined) {
        break;
      }
      if (first === "\n" || first === "\r" || first === "#") {
        const newline = raw.indexOf("\n", cursor);
        cursor = newline === -1 ? raw.length : newline + 1;
        continue;
      }
      current = { end: raw.length, indent, start: cursor };
      depth = 0;
    }
    const character = raw[cursor];
    if (character === '"' || character === "'") {
      cursor = pythonStringSpan(raw, cursor, raw.length).end;
      continue;
    }
    if (character === "#") {
      const newline = raw.indexOf("\n", cursor);
      cursor = newline === -1 ? raw.length : newline;
      continue;
    }
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
    } else if (character === "\n" && depth === 0) {
      current.end = cursor;
      lines.push(current);
      current = undefined;
    }
    cursor += 1;
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function skipPythonSpaces(raw, cursor, end) {
  let position = cursor;
  while (position < end && (raw[position] === " " || raw[position] === "\t")) {
    position += 1;
  }
  return position;
}

/**
 * Read the function name from a logical line that starts with `def name(`
 * or `async def name(`.
 *
 * @param {string} raw Python source
 * @param {{start: number, end: number}} line logical line
 * @returns {string|undefined} function name
 */
function pythonFunctionName(raw, line) {
  let cursor = line.start;
  if (raw.startsWith("async", cursor) && isPythonBlank(raw[cursor + 5])) {
    cursor = skipPythonSpaces(raw, cursor + 5, line.end);
  }
  if (!raw.startsWith("def", cursor) || !isPythonBlank(raw[cursor + 3])) {
    return undefined;
  }
  cursor = skipPythonSpaces(raw, cursor + 3, line.end);
  const nameStart = cursor;
  while (cursor < line.end && isPythonNameCharacter(raw[cursor])) {
    cursor += 1;
  }
  if (cursor === nameStart) {
    return undefined;
  }
  const name = raw.slice(nameStart, cursor);
  cursor = skipPythonSpaces(raw, cursor, line.end);
  return raw[cursor] === "(" ? name : undefined;
}

/**
 * Find the opening parenthesis of `return <constructor>(` at the start of a
 * logical line.
 *
 * @param {string} raw Python source
 * @param {{start: number, end: number}} line logical line
 * @param {string} constructorName Agent or Task
 * @returns {number} offset of the parenthesis, or -1
 */
function returnedCallStart(raw, line, constructorName) {
  if (!raw.startsWith("return", line.start)) {
    return -1;
  }
  let cursor = line.start + 6;
  if (!isPythonBlank(raw[cursor])) {
    return -1;
  }
  cursor = skipPythonSpaces(raw, cursor, line.end);
  if (!raw.startsWith(constructorName, cursor)) {
    return -1;
  }
  cursor = skipPythonSpaces(raw, cursor + constructorName.length, line.end);
  return raw[cursor] === "(" ? cursor : -1;
}

/**
 * Read the arguments of a call, from just after its opening parenthesis to
 * the matching closing one, or to `limit` when it never closes.
 *
 * @param {string} raw Python source
 * @param {number} openParen offset of the opening parenthesis
 * @param {number} limit end of the logical line holding the call
 * @returns {string} argument text
 */
function pythonCallArguments(raw, openParen, limit) {
  let depth = 1;
  let cursor = openParen + 1;
  while (cursor < limit) {
    const character = raw[cursor];
    if (character === '"' || character === "'") {
      cursor = pythonStringSpan(raw, cursor, limit).end;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(openParen + 1, cursor);
      }
    }
    cursor += 1;
  }
  return raw.slice(openParen + 1, limit);
}

/**
 * Split text on the commas that are outside brackets and strings.
 *
 * @param {string} text argument or list text
 * @returns {string[]} trimmed, non-empty parts
 */
function splitPythonTopLevel(text) {
  const parts = [];
  let depth = 0;
  let partStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      cursor = pythonStringSpan(text, cursor, text.length).end;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
    } else if (character === "," && depth === 0) {
      parts.push(text.slice(partStart, cursor));
      partStart = cursor + 1;
    }
    cursor += 1;
  }
  parts.push(text.slice(partStart));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Map each `name=value` keyword argument of a call to its value text.
 *
 * @param {string} argumentText text between the call's parentheses
 * @returns {Map<string, string>} keyword argument values, first one wins
 */
function pythonKeywordArguments(argumentText) {
  const keywordArguments = new Map();
  for (const argument of splitPythonTopLevel(argumentText)) {
    const equals = argument.indexOf("=");
    if (equals <= 0 || argument[equals + 1] === "=") {
      continue;
    }
    const name = argument.slice(0, equals).trim();
    if (
      !name ||
      ![...name].every(isPythonNameCharacter) ||
      keywordArguments.has(name)
    ) {
      continue;
    }
    keywordArguments.set(name, argument.slice(equals + 1).trim());
  }
  return keywordArguments;
}

function unwrapPythonCall(value, prefixes) {
  for (const prefix of prefixes) {
    if (value.startsWith(prefix) && value.endsWith(")")) {
      return value.slice(prefix.length, -1).trim();
    }
  }
  return value;
}

/**
 * Read the text of a keyword argument whose value is a string literal, a run
 * of adjacent literals, or either of those inside parentheses or
 * `dedent(...)`. Other values, such as names or calls, give undefined.
 *
 * @param {string|undefined} value keyword argument value text
 * @returns {string|undefined} literal text with whitespace collapsed
 */
function pythonStringValue(value) {
  if (!value) {
    return undefined;
  }
  let text = unwrapPythonCall(value, ["textwrap.dedent(", "dedent("]);
  if (text.startsWith("(") && text.endsWith(")")) {
    text = text.slice(1, -1).trim();
  }
  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (cursor < text.length && isPythonBlank(text[cursor])) {
      cursor += 1;
    }
    let quoteAt = cursor;
    while (quoteAt - cursor < 2 && "rRbBuUfF".includes(text[quoteAt] || "-")) {
      quoteAt += 1;
    }
    if (text[quoteAt] !== '"' && text[quoteAt] !== "'") {
      break;
    }
    const isRaw = text.slice(cursor, quoteAt).toLowerCase().includes("r");
    const span = pythonStringSpan(text, quoteAt, text.length);
    const content = text.slice(span.contentStart, span.contentEnd);
    parts.push(
      isRaw
        ? content
        : content.replace(/\\(.)/gsu, (_match, escaped) =>
            escaped === "n" || escaped === "t" || escaped === "r"
              ? " "
              : escaped,
          ),
    );
    cursor = span.end;
  }
  const joined = parts.join("").replace(/\s+/gu, " ").trim();
  return joined || undefined;
}

/**
 * Read a list literal of tools as a comma-separated string.
 *
 * @param {string|undefined} value keyword argument value text
 * @returns {string|undefined} tool expressions without whitespace
 */
function pythonListValue(value) {
  if (!value?.startsWith("[") || !value.endsWith("]")) {
    return undefined;
  }
  const items = splitPythonTopLevel(value.slice(1, -1)).map((item) =>
    item.replace(/\s+/gu, ""),
  );
  return items.length ? items.join(",") : undefined;
}

/**
 * Find the functions in a CrewAI Python module that return an Agent or a
 * Task, with the arguments of that call. A function's body is the run of
 * logical lines indented deeper than its `def`, and the first matching
 * return statement in it belongs to the innermost function. The source is
 * read in one pass and each call's arguments only within their own logical
 * line, so crafted input cannot make the work grow faster than its size.
 *
 * @param {string} raw Python source
 * @param {string} constructorName Agent or Task
 * @returns {{name: string, argumentText: string}[]} returned calls in order
 */
function crewAiReturnedCalls(raw, constructorName) {
  const openFunctions = [];
  const calls = [];
  for (const line of pythonLogicalLines(raw)) {
    while (openFunctions.length && openFunctions.at(-1).indent >= line.indent) {
      openFunctions.pop();
    }
    const functionName = pythonFunctionName(raw, line);
    if (functionName) {
      openFunctions.push({
        indent: line.indent,
        name: functionName,
        returned: false,
      });
      continue;
    }
    const innermost = openFunctions.at(-1);
    if (!innermost || innermost.returned) {
      continue;
    }
    const openParen = returnedCallStart(raw, line, constructorName);
    if (openParen === -1) {
      continue;
    }
    innermost.returned = true;
    calls.push({
      argumentText: pythonCallArguments(raw, openParen, line.end),
      name: innermost.name,
    });
  }
  return calls;
}

function parseCrewAiPython(filePath, raw) {
  if (!/\bfrom\s+crewai\s+import\s+(Agent|Task)\b/u.test(raw)) {
    return [];
  }
  const isTaskFile = /\bfrom\s+crewai\s+import\s+Task\b/u.test(raw);
  const constructorName = isTaskFile ? "Task" : "Agent";
  const kind = isTaskFile ? "crew-task" : "crew-agent";
  const components = [];
  for (const call of crewAiReturnedCalls(raw, constructorName)) {
    const component = createComponent(filePath, "crewai", kind, call.name);
    addUniqueProperty(component.properties, "cdx:agent:role", kind);
    const keywordArguments = pythonKeywordArguments(call.argumentText);
    for (const [argumentName, propertyName] of CREWAI_TEXT_ARGUMENTS) {
      addUniqueProperty(
        component.properties,
        propertyName,
        pythonStringValue(keywordArguments.get(argumentName)),
      );
    }
    addUniqueProperty(
      component.properties,
      "cdx:crewai:tools",
      pythonListValue(keywordArguments.get("tools")),
    );
    maybeAddFileSignals(component.properties, filePath, call.argumentText);
    components.push(component);
  }
  return components;
}

/**
 * Parser object for community AI assistant configuration files.
 *
 * Dispatches matched files (opencode/langgraph configs, agent/skill/rule
 * markdown, crewai python/yaml definitions, and similar) to dedicated
 * parsers and collects the resulting components and services.
 *
 * @type {Object}
 * @property {string} id Unique parser identifier ("community-ai-config")
 * @property {string[]} patterns File path patterns this parser handles
 * @property {Function} parse Parse matched files into components and services
 */
export const communityAiConfigParser = {
  id: "community-ai-config",
  patterns: COMMUNITY_AI_PATTERNS,
  parse(files, _options = {}) {
    const components = [];
    const services = [];
    const inputKeys = new Set(
      (files || []).map((filePath) =>
        normalizeFilePath(filePath).toLowerCase(),
      ),
    );
    const expandedKiroRoots = new Set();
    for (const filePath of [...new Set(files || [])]) {
      let raw;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const lowerPath = normalizeFilePath(filePath).toLowerCase();
      // Kiro files under .kiro are all handled by the Kiro parsers, so the
      // generic community branches below never see them.
      if (lowerPath.includes("/.kiro/")) {
        components.push(...parseKiroLayoutFile(filePath, raw));
        continue;
      }
      // A settings file outside .kiro is a Kiro configuration root candidate.
      // The root is validated against the Kiro content shapes, and only a
      // validated root contributes its steering, settings, and hook files.
      if (
        lowerPath.endsWith("/settings/permissions.yaml") ||
        lowerPath.endsWith("/settings/cli.json")
      ) {
        const rootDir = dirname(dirname(filePath));
        const rootKey = normalizeFilePath(rootDir).toLowerCase();
        if (isKiroConfigurationRoot(rootDir)) {
          components.push(...parseKiroLayoutFile(filePath, raw));
          if (!expandedKiroRoots.has(rootKey)) {
            expandedKiroRoots.add(rootKey);
            expandKiroConfigurationRoot(rootDir, inputKeys, components);
          }
        }
        continue;
      }
      if (
        lowerPath.endsWith("opencode.json") ||
        lowerPath.endsWith("opencode.jsonc")
      ) {
        components.push(...parseOpencodeConfig(filePath, raw));
        continue;
      }
      if (lowerPath.endsWith("langgraph.json")) {
        const parsed = parseLanggraphConfig(filePath, raw);
        components.push(...parsed.components);
        services.push(...parsed.services);
        continue;
      }
      if (
        lowerPath.includes("/.opencode/agents/") ||
        lowerPath.includes("/.nanocoder/agents/")
      ) {
        components.push(...parseAgentMarkdown(filePath, raw));
        continue;
      }
      if (lowerPath.endsWith("/.claude-plugin/plugin.json")) {
        components.push(...parsePluginManifest(filePath, raw));
        continue;
      }
      if (lowerPath.endsWith("/.claude-plugin/marketplace.json")) {
        components.push(...parsePluginMarketplace(filePath, raw));
        continue;
      }
      if (lowerPath.includes("/.claude/agents/")) {
        components.push(...parseClaudeSubagent(filePath, raw));
        continue;
      }
      if (lowerPath.includes("/.claude/commands/")) {
        components.push(...parseInstructionMarkdown(filePath, raw));
        continue;
      }
      if (
        lowerPath.includes("/.opencode/skills/") ||
        lowerPath.includes("/.claude/skills/") ||
        lowerPath.includes("/.agents/skills/") ||
        lowerPath.includes("/.codex/skills/") ||
        lowerPath.endsWith("/skill.md")
      ) {
        components.push(...parseSkillFile(filePath, raw));
        continue;
      }
      if (
        lowerPath.includes("/.cursor/rules/") ||
        lowerPath.includes("/.windsurf/rules/") ||
        lowerPath.includes("/.gemini/commands/") ||
        lowerPath.includes("/.gemini/skills/") ||
        lowerPath.includes("/.roo/commands/") ||
        lowerPath.includes("/.roo/skills/") ||
        lowerPath.includes("/.nanocoder/skills/")
      ) {
        components.push(...parseInstructionMarkdown(filePath, raw));
        continue;
      }
      if (
        lowerPath.includes("/.opencode/tools/") ||
        lowerPath.includes("/.opencode/tool/")
      ) {
        components.push(...parseOpencodeTools(filePath, raw));
        continue;
      }
      if (lowerPath.includes("/.nanocoder/commands/")) {
        components.push(...parseNanocoderCommand(filePath, raw));
        continue;
      }
      if (lowerPath.endsWith("agents.py") || lowerPath.endsWith("tasks.py")) {
        components.push(...parseCrewAiPython(filePath, raw));
        continue;
      }
      if (
        lowerPath.includes("/config/agents.yaml") ||
        lowerPath.includes("/config/tasks.yaml") ||
        lowerPath.includes("/config/tools.yaml")
      ) {
        components.push(...parseCrewAiYaml(filePath, raw));
      }
    }
    return { components, services };
  },
};
