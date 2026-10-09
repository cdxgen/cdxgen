import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { build } from "@cdxgen/cdx-purl";
import { parse as loadYaml } from "yaml";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { safeExistsSync } from "../core/fs.js";
import { isMac, isWin } from "../core/paths.js";
import { parseToml } from "../core/toml.js";

/**
 * The purl type used for installed agentic CLI tools. These tools ship as
 * self-contained executables rather than as a resolvable source package, so a
 * `pkg:generic/...` identifier is the honest representation.
 */
export const AGENTIC_TOOL_PURL_TYPE = "generic";

// A stable namespace keeps these generic purls from colliding with unrelated
// `pkg:generic/<name>` components when BOMs are merged.
const AGENTIC_TOOL_PURL_NAMESPACE = "cdxgen-agentic";

/**
 * Build a namespaced `pkg:generic` purl for an agentic tool, returning
 * undefined when the coordinates cannot form a valid purl rather than throwing.
 *
 * @param {string} name Tool name
 * @param {string} [version] Tool version
 * @returns {string|undefined} Canonical purl string or undefined
 */
function buildGenericPurl(name, version) {
  try {
    return build({
      type: AGENTIC_TOOL_PURL_TYPE,
      namespace: AGENTIC_TOOL_PURL_NAMESPACE,
      name,
      version,
    });
  } catch (err) {
    if (err?.code?.startsWith("E_")) {
      return undefined;
    }
    throw err;
  }
}

/**
 * Rewrite an absolute path under the user's home directory to a `~`-relative
 * form so the emitted BOM does not carry the local username.
 *
 * @param {string} filePath Absolute path
 * @returns {string} Home-relative path when applicable, else the input
 */
export function redactHomePath(filePath) {
  const home = homedir();
  const value = String(filePath || "");
  if (!home || !value.startsWith(home)) {
    return value;
  }
  // Require a path boundary so a sibling home such as /Users/alice-backup is
  // not rewritten as if it sat under /Users/alice.
  const remainder = value.slice(home.length);
  if (remainder && !/^[/\\]/u.test(remainder)) {
    return value;
  }
  const rest = remainder.replace(/^[/\\]/u, "");
  return rest ? `~/${rest.replaceAll("\\", "/")}` : "~";
}

// Directory or file names inside a tool home that must never be read for their
// values. They hold credentials, transcripts, or telemetry. The scanner may
// count entries under some of these, but it does not open their contents.
const SENSITIVE_ENTRY_NAMES = new Set([
  "credentials.json",
  "credentials",
  "token.json",
  "tokens",
  "history.jsonl",
  "logs",
  "log",
  "sessions",
  "session-index",
  "cache",
  "crash",
  "telemetry",
  "certs",
]);

/**
 * Describe where each supported agentic CLI tool stores its per-user state.
 *
 * Each entry lists the tool key, a display name, and the candidate home
 * directories per platform (mirroring how `getIdeExtensionDirs` models IDE
 * extension locations). Only the current platform's directories plus
 * always-present dot-directories are included.
 *
 * @returns {Array<{tool: string, name: string, dirs: string[], supportDirs?: string[]}>}
 *   One entry per known agentic CLI tool.
 */
export function getAgenticToolDirs() {
  const home = homedir();
  const appData =
    readEnvironmentVariable("APPDATA") || join(home, "AppData", "Roaming");
  const xdgConfigHome =
    readEnvironmentVariable("XDG_CONFIG_HOME") || join(home, ".config");
  const xdgDataHome =
    readEnvironmentVariable("XDG_DATA_HOME") || join(home, ".local", "share");

  return [
    {
      tool: "kiro-cli",
      name: "Kiro CLI",
      dirs: [join(home, ".kiro")],
      supportDirs: isWin
        ? [join(appData, "kiro-cli")]
        : isMac
          ? [join(home, "Library", "Application Support", "kiro-cli")]
          : [join(xdgDataHome, "kiro-cli")],
    },
    {
      tool: "zcode",
      name: "zcode",
      dirs: [join(home, ".zcode")],
    },
    {
      tool: "opencode",
      name: "opencode",
      dirs: [
        join(xdgConfigHome, "opencode"),
        join(home, ".opencode"),
        join(xdgDataHome, "opencode"),
      ],
    },
    {
      tool: "claude-code",
      name: "Claude Code",
      dirs: [join(home, ".claude")],
    },
    {
      tool: "codex",
      name: "OpenAI Codex CLI",
      dirs: [join(home, ".codex")],
    },
    {
      tool: "gemini-cli",
      name: "Gemini CLI",
      dirs: [join(home, ".gemini")],
    },
    {
      tool: "amazon-q",
      name: "Amazon Q Developer CLI",
      dirs: [join(home, ".aws", "amazonq")],
    },
    {
      tool: "aider",
      name: "Aider",
      dirs: [join(home, ".aider")],
    },
    {
      tool: "cursor",
      name: "Cursor",
      dirs: [join(home, ".cursor")],
    },
    {
      tool: "windsurf",
      name: "Windsurf",
      dirs: [join(home, ".codeium", "windsurf")],
    },
    {
      tool: "goose",
      name: "Goose",
      dirs: [
        join(xdgConfigHome, "goose"),
        join(home, ".config", "goose"),
        ...(isWin ? [join(appData, "goose")] : []),
      ],
    },
    {
      tool: "amp",
      name: "Amp",
      dirs: [
        join(xdgConfigHome, "amp"),
        join(home, ".config", "amp"),
        ...(isWin ? [join(appData, "amp")] : []),
      ],
    },
    {
      tool: "copilot-cli",
      name: "GitHub Copilot CLI",
      dirs: [join(home, ".copilot-cli"), join(home, ".copilot")],
    },
    {
      tool: "crush",
      name: "Crush",
      dirs: [
        join(xdgConfigHome, "crush"),
        join(home, ".config", "crush"),
        ...(isWin ? [join(appData, "crush")] : []),
      ],
    },
  ];
}

/**
 * Discover which agentic CLI tools are installed for the current user by
 * checking their known home directories.
 *
 * @returns {Array<{tool: string, name: string, dir: string, supportDir?: string}>}
 *   One entry per discovered tool, using the first existing directory.
 */
export function discoverAgenticTools() {
  const found = [];
  for (const entry of getAgenticToolDirs()) {
    const dir = entry.dirs.find((candidate) => safeExistsSync(candidate));
    if (!dir) {
      continue;
    }
    const supportDir = (entry.supportDirs || []).find((candidate) =>
      safeExistsSync(candidate),
    );
    found.push({ tool: entry.tool, name: entry.name, dir, supportDir });
  }
  return found;
}

function parseJsonFile(filePath) {
  try {
    return parseJsonLikeText(readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Strip `//` line comments, block comments, and trailing commas from JSONC
 * text.
 *
 * The scan is character-wise and string-aware rather than regex-based: a
 * regex cannot tell a comment from the same characters inside a string value,
 * so `{"url": "https://x", "dir": "a//b"}` would be corrupted by one.
 *
 * @param {string} raw Raw JSONC text
 * @returns {string} Text that is valid JSON
 */
function stripJsonComments(raw) {
  const text = String(raw);
  let out = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        // Copy the escaped character verbatim so an escaped quote does not end
        // the string.
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  // Trailing commas are only ambiguous inside strings, which are gone by now.
  return out.replace(/,(\s*[}\]])/gu, "$1");
}

/**
 * Parse JSON or JSONC text, tolerating `//` and block comments and trailing
 * commas so opencode.jsonc and similar configs are read rather than silently
 * dropped. String contents are preserved.
 *
 * @param {string} raw Raw file text
 * @returns {*} Parsed value
 */
function parseJsonLikeText(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripJsonComments(raw));
  }
}

function countDirEntries(dirPath, filterFn) {
  try {
    return readdirSync(dirPath).filter((name) => {
      if (SENSITIVE_ENTRY_NAMES.has(name.toLowerCase())) {
        return false;
      }
      return filterFn ? filterFn(name) : true;
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Read a version string from a tool's own metadata files. No tool binary is
 * executed; only declarative files are read, so scanning stays side-effect
 * free. Returns undefined when no reliable version signal is available.
 *
 * @param {string} tool Tool key
 * @param {string} dir Discovered tool home directory
 * @param {string} [supportDir] Optional platform support directory
 * @returns {string|undefined} Version string when found
 */
function readToolVersion(tool, dir, supportDir) {
  const candidates = [];
  if (tool === "opencode") {
    // ~/.opencode/package.json pins the installed opencode plugin runtime,
    // which is a stable declarative proxy for the installed version.
    const pkg = parseJsonFile(join(dir, "package.json"));
    const pluginVersion = pkg?.dependencies?.["@opencode-ai/plugin"];
    if (typeof pluginVersion === "string") {
      const normalized = pluginVersion.replace(/^[^0-9]*/, "");
      if (normalized) {
        return normalized;
      }
    }
    if (typeof pkg?.version === "string" && pkg.version.trim()) {
      return pkg.version.trim();
    }
  }
  candidates.push(
    join(dir, "version.json"),
    join(dir, "version"),
    supportDir ? join(supportDir, "version.json") : undefined,
  );
  for (const candidate of candidates.filter(Boolean)) {
    if (!safeExistsSync(candidate)) {
      continue;
    }
    if (candidate.endsWith(".json")) {
      const parsed = parseJsonFile(candidate);
      const version =
        parsed?.version || parsed?.cliVersion || parsed?.appVersion;
      if (typeof version === "string" && version.trim()) {
        return version.trim();
      }
    } else {
      try {
        const raw = readFileSync(candidate, "utf-8").trim();
        if (/^v?\d+\.\d+/.test(raw)) {
          return raw.replace(/^v/, "");
        }
      } catch {
        // ignore unreadable version file
      }
    }
  }
  return undefined;
}

function countKiroSignals(dir, supportDir) {
  const signals = {};
  const agentsDir = join(dir, "agents");
  if (safeExistsSync(agentsDir)) {
    signals.agentCount = countDirEntries(
      agentsDir,
      (name) => name.endsWith(".json") && !name.endsWith(".example"),
    );
  }
  if (safeExistsSync(join(dir, "sessions"))) {
    signals.hasSessions = true;
  }
  const knowledgeDir = supportDir
    ? join(supportDir, "knowledge_bases")
    : undefined;
  if (knowledgeDir && safeExistsSync(knowledgeDir)) {
    signals.knowledgeBaseCount = countDirEntries(knowledgeDir);
  }
  const settings = parseJsonFile(join(dir, "settings", "cli.json"));
  if (settings && typeof settings["chat.defaultAgent"] === "string") {
    signals.defaultAgent = settings["chat.defaultAgent"];
  }
  return signals;
}

function countZcodeSignals(dir) {
  const signals = {};
  const cliConfig = parseJsonFile(join(dir, "cli", "config.json"));
  const enabled = cliConfig?.plugins?.enabledPlugins;
  if (enabled && typeof enabled === "object") {
    const names = Object.keys(enabled);
    signals.pluginCount = names.length;
    signals.enabledPluginCount = names.filter(
      (name) => enabled[name] === true,
    ).length;
  }
  const cacheDir = join(dir, "cli", "plugins", "cache");
  if (safeExistsSync(cacheDir)) {
    signals.cachedPluginRepoCount = countDirEntries(cacheDir);
  }
  return signals;
}

function countOpencodeSignals(dir) {
  const signals = {};
  const config =
    parseJsonFile(join(dir, "opencode.json")) ||
    parseJsonFile(join(dir, "opencode.jsonc"));
  if (config?.provider && typeof config.provider === "object") {
    signals.providerCount = Object.keys(config.provider).length;
  }
  if (typeof config?.model === "string") {
    signals.hasDefaultModel = true;
  }
  const pluginsDir = join(dir, "plugins");
  if (safeExistsSync(pluginsDir)) {
    signals.pluginCount = countDirEntries(pluginsDir, (name) =>
      /\.(ts|js|mjs|cjs)$/.test(name),
    );
  }
  return signals;
}

function countClaudeSignals(dir) {
  const signals = {};
  const agentsDir = join(dir, "agents");
  if (safeExistsSync(agentsDir)) {
    signals.agentCount = countDirEntries(agentsDir, (name) =>
      name.endsWith(".md"),
    );
  }
  const commandsDir = join(dir, "commands");
  if (safeExistsSync(commandsDir)) {
    signals.commandCount = countDirEntries(commandsDir, (name) =>
      name.endsWith(".md"),
    );
  }
  if (safeExistsSync(join(dir, "plugins"))) {
    signals.pluginCount = countDirEntries(join(dir, "plugins"));
  }
  const skillsDir = join(dir, "skills");
  if (safeExistsSync(skillsDir)) {
    signals.skillCount = countDirEntries(skillsDir);
  }
  return signals;
}

function countCodexSignals(dir) {
  const signals = {};
  const configPath = join(dir, "config.toml");
  if (!safeExistsSync(configPath)) {
    return signals;
  }
  try {
    const config = parseToml(readFileSync(configPath, "utf-8"));
    if (config?.mcp_servers && typeof config.mcp_servers === "object") {
      signals.mcpServerCount = Object.keys(config.mcp_servers).length;
    }
  } catch {
    // unreadable or invalid TOML
  }
  return signals;
}

function countCursorSignals(dir) {
  const signals = {};
  const mcpConfig = parseJsonFile(join(dir, "mcp.json"));
  if (mcpConfig?.mcpServers && typeof mcpConfig.mcpServers === "object") {
    signals.mcpServerCount = Object.keys(mcpConfig.mcpServers).length;
  }
  const agentsDir = join(dir, "agents");
  if (safeExistsSync(agentsDir)) {
    signals.agentCount = countDirEntries(agentsDir, (name) =>
      name.endsWith(".md"),
    );
  }
  return signals;
}

function countWindsurfSignals(dir) {
  const signals = {};
  const mcpConfig = parseJsonFile(join(dir, "mcp_config.json"));
  if (mcpConfig?.mcpServers && typeof mcpConfig.mcpServers === "object") {
    signals.mcpServerCount = Object.keys(mcpConfig.mcpServers).length;
  }
  return signals;
}

function countGooseSignals(dir) {
  const signals = {};
  // Goose keeps its resolved extension set in config.yaml.
  try {
    const config = loadYaml(readFileSync(join(dir, "config.yaml"), "utf-8"));
    if (Array.isArray(config?.extensions)) {
      signals.extensionCount = config.extensions.length;
    }
  } catch {
    // missing or unreadable config
  }
  return signals;
}

function countCrushSignals(dir) {
  const signals = {};
  const config = parseJsonFile(join(dir, "crush.json"));
  if (config?.mcp && typeof config.mcp === "object") {
    signals.mcpServerCount = Object.keys(config.mcp).length;
  }
  return signals;
}

function countGeminiSignals(dir) {
  const signals = {};
  const settings = parseJsonFile(join(dir, "settings.json"));
  if (settings?.mcpServers && typeof settings.mcpServers === "object") {
    signals.mcpServerCount = Object.keys(settings.mcpServers).length;
  }
  const commandsDir = join(dir, "commands");
  if (safeExistsSync(commandsDir)) {
    signals.commandCount = countDirEntries(commandsDir);
  }
  return signals;
}

/**
 * Compute safe, redacted signal counts for a discovered tool. Only structural
 * counts and small enumerated values are returned; no credential, transcript,
 * or telemetry content is read.
 *
 * @param {string} tool Tool key
 * @param {string} dir Discovered tool home directory
 * @param {string} [supportDir] Optional platform support directory
 * @returns {Object} Map of signal name to count/boolean/small-string value
 */
export function collectToolSignals(tool, dir, supportDir) {
  switch (tool) {
    case "kiro-cli":
      return countKiroSignals(dir, supportDir);
    case "zcode":
      return countZcodeSignals(dir);
    case "opencode":
      return countOpencodeSignals(dir);
    case "claude-code":
      return countClaudeSignals(dir);
    case "codex":
      return countCodexSignals(dir);
    case "gemini-cli":
      return countGeminiSignals(dir);
    case "cursor":
      return countCursorSignals(dir);
    case "windsurf":
      return countWindsurfSignals(dir);
    case "goose":
      return countGooseSignals(dir);
    case "crush":
      return countCrushSignals(dir);
    default: {
      // Generic fallback: count top-level, non-sensitive config entries.
      const signals = {};
      const mcpConfig = parseJsonFile(join(dir, ".mcp.json"));
      if (mcpConfig?.mcpServers) {
        signals.mcpServerCount = Object.keys(mcpConfig.mcpServers).length;
      }
      return signals;
    }
  }
}

/**
 * Build a CycloneDX application component for one discovered agentic tool.
 *
 * @param {{tool: string, name: string, dir: string, supportDir?: string}} entry
 *   Discovered tool entry
 * @returns {Object} CycloneDX component
 */
export function componentForAgenticTool(entry) {
  const { tool, name, dir, supportDir } = entry;
  const version = readToolVersion(tool, dir, supportDir);
  const purl = buildGenericPurl(tool, version);
  const properties = [
    { name: "internal:SrcFile", value: redactHomePath(dir) },
    { name: "cdx:agentic:tool", value: tool },
    { name: "cdx:agentic:home", value: redactHomePath(dir) },
    { name: "cdx:agentic:inventorySource", value: "host-scan" },
  ];
  if (supportDir) {
    properties.push({
      name: "cdx:agentic:supportDir",
      value: redactHomePath(supportDir),
    });
  }
  const signals = collectToolSignals(tool, dir, supportDir);
  for (const [key, value] of Object.entries(signals)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    properties.push({
      name: `cdx:agentic:${key}`,
      value: String(value),
    });
  }
  const component = {
    "bom-ref": purl || `urn:agentic:${tool}`,
    type: "application",
    // Use the human-friendly display name and a stable group so BOM viewers
    // read well; the machine key remains on cdx:agentic:tool.
    group: AGENTIC_TOOL_PURL_NAMESPACE,
    name,
    properties,
    tags: ["ai", "agentic-cli", tool],
  };
  if (version) {
    component.version = version;
  }
  if (purl) {
    component.purl = purl;
  }
  component.description = `${name} agentic CLI tool discovered on the host`;
  return component;
}

function childBomRef(parentRef, kind, id) {
  const safeId = String(id || "unknown").replaceAll(/[^a-zA-Z0-9._-]+/gu, "-");
  return `${parentRef}:${kind}:${safeId}`;
}

/**
 * Parse Kiro agent definitions (`~/.kiro/agents/*.json`) into components.
 *
 * Each agent contributes its name, model, and redacted counts of MCP servers,
 * tools, and allowed tools. Prompts and resource values are never copied.
 *
 * @param {string} dir Kiro home directory
 * @param {string} parentRef Parent tool bom-ref
 * @returns {Object[]} Child components
 */
function parseKiroAgents(dir, parentRef) {
  const agentsDir = join(dir, "agents");
  if (!safeExistsSync(agentsDir)) {
    return [];
  }
  const components = [];
  let files = [];
  try {
    files = readdirSync(agentsDir);
  } catch {
    return [];
  }
  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".example")) {
      continue;
    }
    const agent = parseJsonFile(join(agentsDir, file));
    if (!agent?.name) {
      continue;
    }
    const properties = [
      {
        name: "internal:SrcFile",
        value: redactHomePath(join(agentsDir, file)),
      },
      { name: "cdx:agentic:tool", value: "kiro-cli" },
      { name: "cdx:agentic:kind", value: "agent-definition" },
    ];
    if (typeof agent.model === "string") {
      properties.push({ name: "cdx:agentic:model", value: agent.model });
    }
    if (agent.mcpServers && typeof agent.mcpServers === "object") {
      properties.push({
        name: "cdx:agentic:mcpServerCount",
        value: String(Object.keys(agent.mcpServers).length),
      });
    }
    if (Array.isArray(agent.tools)) {
      properties.push({
        name: "cdx:agentic:toolCount",
        value: String(agent.tools.length),
      });
    }
    if (Array.isArray(agent.allowedTools)) {
      properties.push({
        name: "cdx:agentic:allowedToolCount",
        value: String(agent.allowedTools.length),
      });
    }
    components.push({
      "bom-ref": childBomRef(parentRef, "agent", agent.name),
      type: "application",
      name: String(agent.name),
      properties,
      tags: ["ai", "agent-definition", "kiro-cli"],
    });
  }
  return components;
}

/**
 * Parse cached zcode plugins
 * (`~/.zcode/cli/plugins/cache/<repo>/<plugin>/<version>/.zcode-plugin/plugin.json`)
 * into components.
 *
 * @param {string} dir zcode home directory
 * @param {string} parentRef Parent tool bom-ref
 * @returns {Object[]} Child components
 */
function parseZcodePlugins(dir, parentRef) {
  const cacheDir = join(dir, "cli", "plugins", "cache");
  if (!safeExistsSync(cacheDir)) {
    return [];
  }
  const components = [];
  const seen = new Set();
  const walk = (current, depth) => {
    if (depth > 5) {
      return;
    }
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of entries) {
      const full = join(current, dirent.name);
      if (dirent.isDirectory()) {
        walk(full, depth + 1);
      } else if (dirent.name === "plugin.json") {
        const plugin = parseJsonFile(full);
        if (!plugin?.name) {
          continue;
        }
        const key = `${plugin.name}@${plugin.version || "0"}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const purl = buildGenericPurl(
          `zcode-plugin-${plugin.name}`,
          typeof plugin.version === "string" ? plugin.version : undefined,
        );
        const properties = [
          { name: "internal:SrcFile", value: redactHomePath(full) },
          { name: "cdx:agentic:tool", value: "zcode" },
          { name: "cdx:agentic:kind", value: "plugin" },
        ];
        if (typeof plugin.license === "string") {
          properties.push({
            name: "cdx:agentic:license",
            value: plugin.license,
          });
        }
        if (plugin.mcpServers && typeof plugin.mcpServers === "object") {
          properties.push({
            name: "cdx:agentic:mcpServerCount",
            value: String(Object.keys(plugin.mcpServers).length),
          });
        }
        if (plugin.skills) {
          properties.push({ name: "cdx:agentic:hasSkills", value: "true" });
        }
        const component = {
          "bom-ref": childBomRef(
            parentRef,
            "plugin",
            `${plugin.name}-${plugin.version || ""}`,
          ),
          type: "application",
          name: String(plugin.name),
          properties,
          tags: ["ai", "agentic-plugin", "zcode"],
        };
        if (typeof plugin.version === "string") {
          component.version = plugin.version;
        }
        if (purl) {
          component.purl = purl;
        }
        components.push(component);
      }
    }
  };
  walk(cacheDir, 0);
  return components;
}

/**
 * Parse the opencode configuration (`opencode.json`) into provider service
 * references. Only provider identifiers and counts are recorded.
 *
 * @param {string} dir opencode home directory
 * @param {string} parentRef Parent tool bom-ref
 * @returns {Object[]} Child components
 */
/**
 * Parse the opencode configuration (`opencode.json` or `opencode.jsonc`) into
 * provider service references. Providers are emitted as CycloneDX services to
 * match how inference providers are modeled elsewhere in the AI inventory.
 * Only provider identifiers are recorded.
 *
 * @param {string} dir opencode home directory
 * @param {string} parentRef Parent tool bom-ref
 * @returns {Object[]} Child provider services
 */
function parseOpencodeProviders(dir, parentRef) {
  const jsonPath = join(dir, "opencode.json");
  const jsoncPath = join(dir, "opencode.jsonc");
  const usedPath = safeExistsSync(jsonPath) ? jsonPath : jsoncPath;
  const config = parseJsonFile(jsonPath) || parseJsonFile(jsoncPath);
  if (!config?.provider || typeof config.provider !== "object") {
    return [];
  }
  const services = [];
  for (const providerName of Object.keys(config.provider)) {
    services.push({
      "bom-ref": childBomRef(parentRef, "provider", providerName),
      group: providerName,
      name: providerName,
      properties: [
        { name: "internal:SrcFile", value: redactHomePath(usedPath) },
        { name: "cdx:agentic:tool", value: "opencode" },
        { name: "cdx:agentic:kind", value: "provider" },
        { name: "cdx:ai:kind", value: "inference-service" },
      ],
      tags: ["ai", "agentic-provider", "opencode"],
    });
  }
  return services;
}

/**
 * Parse the child components and services a tool defines.
 *
 * @param {string} tool Tool key
 * @param {string} dir Tool home directory
 * @param {string} parentRef Parent tool bom-ref
 * @returns {{components: Object[], services: Object[]}} Child inventory
 */
function collectToolChildren(tool, dir, parentRef) {
  switch (tool) {
    case "kiro-cli":
      return { components: parseKiroAgents(dir, parentRef), services: [] };
    case "zcode":
      return { components: parseZcodePlugins(dir, parentRef), services: [] };
    case "opencode":
      return {
        components: [],
        services: parseOpencodeProviders(dir, parentRef),
      };
    default:
      return { components: [], services: [] };
  }
}

/**
 * Discover installed agentic CLI tools on the current host and return CycloneDX
 * components describing each one, plus the child agents, plugins, and providers
 * they define and the dependency edges linking children to their tool.
 *
 * This host scan is unconditional: it does not consult scan filters such as
 * `--exclude` or profile/technique options, because it inventories fixed tool
 * home directories rather than a project tree. The `options` argument is
 * accepted for signature parity and is intentionally not used to alter results.
 *
 * @param {Object} [options={}] Collection options (accepted but not applied)
 * @returns {{components: Object[], services: Object[], dependencies: Object[]}} Discovered inventory
 */
export function collectAgenticTools(_options = {}) {
  const components = [];
  const services = [];
  const dependencies = [];
  for (const entry of discoverAgenticTools()) {
    try {
      const toolComponent = componentForAgenticTool(entry);
      components.push(toolComponent);
      const parentRef = toolComponent["bom-ref"];
      const children = collectToolChildren(entry.tool, entry.dir, parentRef);
      const childRefs = [];
      if (children.components.length) {
        components.push(...children.components);
        childRefs.push(...children.components.map((c) => c["bom-ref"]));
      }
      if (children.services.length) {
        services.push(...children.services);
        childRefs.push(...children.services.map((s) => s["bom-ref"]));
      }
      if (childRefs.length) {
        dependencies.push({
          ref: parentRef,
          dependsOn: childRefs.sort(),
        });
      }
    } catch (err) {
      if (DEBUG_MODE) {
        console.log(
          `Unable to describe agentic tool ${entry.tool}: ${err.message}`,
        );
      }
    }
  }
  return { components, services, dependencies };
}
