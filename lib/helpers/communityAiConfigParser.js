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

function parseInstructionMarkdown(filePath, raw) {
  const framework = frameworkForFile(filePath, raw);
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
  const kind = lowerPath.includes("/commands/")
    ? "custom-command"
    : lowerPath.includes("/skills/")
      ? "skill-file"
      : "agent-instructions";
  const component = createComponent(filePath, framework, kind, name, "file");
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
        lowerPath.includes("/.agents/skills/")
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
