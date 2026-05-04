import { readFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

import { parse as loadYaml } from "yaml";

import { parseJsonLike } from "./jsonLike.js";
import {
  credentialIndicatorsForText,
  sanitizeMcpRefToken,
} from "./mcpDiscovery.js";
import { sanitizeBomPropertyValue } from "./propertySanitizer.js";
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
  ".nanocoder/commands/**/*.md",
  "**/.nanocoder/commands/**/*.md",
  ".nanocoder/skills/**/*.md",
  "**/.nanocoder/skills/**/*.md",
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
  if (lowerPath.includes("/.agents/skills/")) {
    return "agent-compatible";
  }
  return "community-ai";
}

function baseProperties(filePath, framework, kind) {
  return [
    { name: "SrcFile", value: filePath },
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
      metadata.tools.join(","),
    );
  }
  if (Array.isArray(metadata?.disallowedTools)) {
    addUniqueProperty(
      component.properties,
      "cdx:agent:disallowedTools",
      metadata.disallowedTools.join(","),
    );
  }
  maybeAddFileSignals(component.properties, filePath, raw);
  return [component];
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

function captureQuotedValue(block, key) {
  const patterns = [
    new RegExp(`${key}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`, "u"),
    new RegExp(`${key}\\s*=\\s*dedent\\([^\\n]*?["'\`]([\\s\\S]*?)["'\`]`, "u"),
  ];
  for (const pattern of patterns) {
    const match = block.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/\s+/gu, " ").trim();
    }
  }
  return undefined;
}

function parseCrewAiPython(filePath, raw) {
  if (!/\bfrom\s+crewai\s+import\s+(Agent|Task)\b/u.test(raw)) {
    return [];
  }
  const isTaskFile = /\bfrom\s+crewai\s+import\s+Task\b/u.test(raw);
  const constructorName = isTaskFile ? "Task" : "Agent";
  const matches = [
    ...raw.matchAll(
      new RegExp(
        `def\\s+([A-Za-z0-9_]+)\\s*\\([^)]*\\):[\\s\\S]*?return\\s+${constructorName}\\(([\\s\\S]*?)\\n\\s*\\)`,
        "gu",
      ),
    ),
  ];
  const components = [];
  for (const match of matches) {
    const component = createComponent(
      filePath,
      "crewai",
      isTaskFile ? "crew-task" : "crew-agent",
      match[1],
    );
    addUniqueProperty(
      component.properties,
      "cdx:agent:role",
      isTaskFile ? "crew-task" : "crew-agent",
    );
    addUniqueProperty(
      component.properties,
      "cdx:crewai:role",
      captureQuotedValue(match[2], "role"),
    );
    addUniqueProperty(
      component.properties,
      "cdx:crewai:goal",
      captureQuotedValue(match[2], "goal"),
    );
    addUniqueProperty(
      component.properties,
      "cdx:crewai:backstory",
      captureQuotedValue(match[2], "backstory"),
    );
    addUniqueProperty(
      component.properties,
      "cdx:crewai:description",
      captureQuotedValue(match[2], "description"),
    );
    addUniqueProperty(
      component.properties,
      "cdx:crewai:expectedOutput",
      captureQuotedValue(match[2], "expected_output"),
    );
    const toolsMatch = match[2].match(/tools\s*=\s*\[([^\]]+)\]/u);
    if (toolsMatch?.[1]) {
      addUniqueProperty(
        component.properties,
        "cdx:crewai:tools",
        toolsMatch[1].replace(/\s+/gu, ""),
      );
    }
    maybeAddFileSignals(component.properties, filePath, match[2]);
    components.push(component);
  }
  return components;
}

export const communityAiConfigParser = {
  id: "community-ai-config",
  patterns: COMMUNITY_AI_PATTERNS,
  parse(files, _options = {}) {
    const components = [];
    const services = [];
    for (const filePath of [...new Set(files || [])]) {
      let raw;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const lowerPath = normalizeFilePath(filePath).toLowerCase();
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
      if (
        lowerPath.includes("/.opencode/skills/") ||
        lowerPath.includes("/.claude/skills/") ||
        lowerPath.includes("/.agents/skills/") ||
        lowerPath.includes("/.nanocoder/skills/")
      ) {
        components.push(...parseSkillFile(filePath, raw));
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
