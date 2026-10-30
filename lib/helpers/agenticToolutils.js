import { readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { build } from "@cdxgen/cdx-purl";
import { parse as loadYaml } from "yaml";

import { DEBUG_MODE, readEnvironmentVariable } from "../core/activity.js";
import { readUserFileText } from "../core/boundedFile.js";
import { safeExistsSync } from "../core/fs.js";
import { isMac, isWin, redactHomePath } from "../core/paths.js";
import { parseToml } from "../core/toml.js";
import { findIdeProductInfo, IDE_PRODUCTS } from "./vsixutils.js";

export { redactHomePath };

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
 * An entry may also name `mcpConfigs`, the files and keys where the tool
 * lists its MCP servers, and `ide`, the IDE_PRODUCTS id of the editor the tool
 * ships in, whose installed version and extensions folder it then reports.
 *
 * @param {string} [home] Home directory to resolve the folders against
 * @returns {Array<{tool: string, name: string, dirs: string[], supportDirs?: string[], mcpConfigs?: Array<{file: string, key: string}>, ide?: string}>}
 *   One entry per known agentic CLI tool.
 */
export function getAgenticToolDirs(home = homedir()) {
  // These variables describe the current user, so another home, such as a
  // fixture or another user's home, uses the defaults.
  const ownHome = home === homedir();
  const appData =
    (ownHome && readEnvironmentVariable("APPDATA")) ||
    join(home, "AppData", "Roaming");
  const xdgConfigHome =
    (ownHome && readEnvironmentVariable("XDG_CONFIG_HOME")) ||
    join(home, ".config");
  const xdgDataHome =
    (ownHome && readEnvironmentVariable("XDG_DATA_HOME")) ||
    join(home, ".local", "share");

  return [
    {
      tool: "kiro-cli",
      name: "Kiro CLI",
      // The Kiro editor also creates ~/.kiro, so the CLI is recognised by the
      // files only the CLI writes there.
      dirs: [
        join(home, ".kiro", "settings", "cli.json"),
        join(home, ".kiro", "sessions", "cli"),
      ],
      homeDir: join(home, ".kiro"),
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
      // User-scope MCP servers live in ~/.claude.json, beside the folder.
      mcpConfigs: [{ file: join(home, ".claude.json"), key: "mcpServers" }],
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
      mcpConfigs: [{ file: "mcp.json", key: "mcpServers" }],
      ide: "cursor",
    },
    {
      tool: "windsurf",
      name: "Windsurf",
      dirs: [join(home, ".codeium", "windsurf")],
      mcpConfigs: [{ file: "mcp_config.json", key: "mcpServers" }],
      ide: "windsurf",
    },
    {
      tool: "devin-desktop",
      name: "Devin Desktop",
      dirs: [join(home, ".devin")],
      mcpConfigs: [
        {
          file: join(xdgConfigHome, "devin", "config.json"),
          key: "mcpServers",
        },
      ],
      ide: "devin-desktop",
    },
    {
      tool: "kiro",
      name: "Kiro",
      // Kiro and Kiro CLI share ~/.kiro; the IDE is told apart by its
      // extensions folder.
      dirs: [join(home, ".kiro", "extensions")],
      homeDir: join(home, ".kiro"),
      mcpConfigs: [{ file: join("settings", "mcp.json"), key: "mcpServers" }],
      ide: "kiro",
    },
    {
      tool: "trae",
      name: "Trae",
      dirs: [join(home, ".trae")],
      ide: "trae",
    },
    {
      tool: "antigravity",
      name: "Antigravity",
      dirs: [join(home, ".antigravity")],
      ide: "antigravity",
    },
    {
      tool: "antigravity-ide",
      name: "Antigravity IDE",
      dirs: [join(home, ".antigravity-ide")],
      ide: "antigravity-ide",
    },
    {
      tool: "qoder",
      name: "Qoder",
      dirs: [join(home, ".qoder")],
      ide: "qoder",
    },
    {
      tool: "void",
      name: "Void",
      dirs: [join(home, ".void-editor")],
      ide: "void",
    },
    {
      tool: "qwen-code",
      name: "Qwen Code",
      dirs: [join(home, ".qwen")],
      mcpConfigs: [{ file: "settings.json", key: "mcpServers" }],
    },
    {
      tool: "factory-droid",
      name: "Factory Droid",
      dirs: [join(home, ".factory")],
      mcpConfigs: [{ file: "mcp.json", key: "mcpServers" }],
    },
    {
      tool: "auggie",
      name: "Augment Auggie CLI",
      dirs: [join(home, ".augment")],
      mcpConfigs: [{ file: "settings.json", key: "mcpServers" }],
    },
    {
      tool: "continue",
      name: "Continue",
      dirs: [join(home, ".continue")],
    },
    {
      tool: "cline-cli",
      name: "Cline CLI",
      dirs: [join(home, ".cline")],
      mcpConfigs: [
        {
          file: join("data", "settings", "cline_mcp_settings.json"),
          key: "mcpServers",
        },
      ],
    },
    {
      tool: "claude-desktop",
      name: "Claude Desktop",
      dirs: isWin
        ? [join(appData, "Claude")]
        : isMac
          ? [join(home, "Library", "Application Support", "Claude")]
          : [join(xdgConfigHome, "Claude")],
      mcpConfigs: [{ file: "claude_desktop_config.json", key: "mcpServers" }],
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
      mcpConfigs: [
        { file: "settings.json", key: "amp.mcpServers" },
        { file: "settings.jsonc", key: "amp.mcpServers" },
      ],
    },
    {
      tool: "copilot-cli",
      name: "GitHub Copilot CLI",
      dirs: [join(home, ".copilot-cli"), join(home, ".copilot")],
      mcpConfigs: [{ file: "mcp-config.json", key: "mcpServers" }],
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
 * @param {string} [home] Home directory to resolve the folders against
 * @returns {Array<{tool: string, name: string, dir: string, supportDir?: string, mcpConfigs?: Object[], ide?: string}>}
 *   One entry per discovered tool, using the first existing directory.
 */
export function discoverAgenticTools(home = homedir()) {
  const found = [];
  for (const entry of getAgenticToolDirs(home)) {
    const marker = entry.dirs.find((candidate) => safeExistsSync(candidate));
    if (!marker) {
      continue;
    }
    const supportDir = (entry.supportDirs || []).find((candidate) =>
      safeExistsSync(candidate),
    );
    found.push({
      tool: entry.tool,
      name: entry.name,
      dir: entry.homeDir || marker,
      supportDir,
      mcpConfigs: entry.mcpConfigs,
      ide: entry.ide,
    });
  }
  return found;
}

// Largest tool configuration file read. ~/.claude.json keeps per-project state
// and grows with use, so the cap is generous; it only has to stop a FIFO, a
// device or a runaway file from stalling the scan or exhausting memory.
const MAX_CONFIG_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Read a tool configuration file only when it is a regular file of bounded
 * size. A FIFO or a device reads as undefined, and so does a symlink when the
 * scan runs as root.
 *
 * @param {string} filePath Absolute path
 * @returns {string|undefined} File text, or undefined
 */
function readConfigText(filePath) {
  return readUserFileText(filePath, MAX_CONFIG_FILE_BYTES);
}

function parseJsonFile(filePath) {
  try {
    return parseJsonLikeText(readConfigText(filePath));
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
/**
 * Read a semver-like version from the start of a release folder name such as
 * `2.1.278` or `0.137.0-aarch64-apple-darwin`.
 *
 * @param {string} name Folder name
 * @returns {string|undefined} The version, or undefined
 */
function versionFromReleaseName(name) {
  const match = /^v?(\d+\.\d+\.\d+)/u.exec(`${name || ""}`);
  return match ? match[1] : undefined;
}

/**
 * Follow a launcher symlink that points into a per-version folder, as the
 * native Claude Code and Codex installers do, and read the version from the
 * folder name.
 *
 * @param {string} linkPath Launcher or `current` symlink
 * @returns {string|undefined} The version, or undefined
 */
function versionFromReleaseLink(linkPath) {
  try {
    return versionFromReleaseName(basename(realpathSync(linkPath)));
  } catch {
    return undefined;
  }
}

function readToolVersion(tool, dir, supportDir) {
  if (tool === "claude-code") {
    const home = dirname(dir);
    const version =
      versionFromReleaseLink(join(home, ".local", "bin", "claude")) ||
      versionFromReleaseLink(join(home, ".claude", "local", "claude"));
    if (version) {
      return version;
    }
  }
  if (tool === "codex") {
    const version = versionFromReleaseLink(
      join(dir, "packages", "standalone", "current"),
    );
    if (version) {
      return version;
    }
  }
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
        const raw = (readConfigText(candidate) || "").trim();
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
    const config = parseToml(readConfigText(configPath) || "");
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
  const agentsDir = join(dir, "agents");
  if (safeExistsSync(agentsDir)) {
    signals.agentCount = countDirEntries(agentsDir, (name) =>
      name.endsWith(".md"),
    );
  }
  const rulesDir = join(dir, "rules");
  if (safeExistsSync(rulesDir)) {
    signals.ruleCount = countDirEntries(rulesDir, (name) =>
      /\.(md|mdc)$/u.test(name),
    );
  }
  for (const [skillsDir, key] of [
    [join(dir, "skills"), "skillCount"],
    [join(dir, "skills-cursor"), "bundledSkillCount"],
  ]) {
    if (safeExistsSync(skillsDir)) {
      signals[key] = countDirEntries(skillsDir);
    }
  }
  // The Cursor CLI keeps its tool permissions in cli-config.json. Only the
  // number of rules is recorded, not the commands or paths they name.
  const cliConfig = parseJsonFile(join(dir, "cli-config.json"));
  const permissions = cliConfig?.permissions;
  if (Array.isArray(permissions?.allow)) {
    signals.cliAllowRuleCount = permissions.allow.length;
  }
  if (Array.isArray(permissions?.deny)) {
    signals.cliDenyRuleCount = permissions.deny.length;
  }
  return signals;
}

function countGooseSignals(dir) {
  const signals = {};
  // Goose keeps its resolved extension set in config.yaml.
  try {
    const config = loadYaml(readConfigText(join(dir, "config.yaml")) || "");
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

function countClaudeDesktopSignals(dir) {
  const signals = {};
  // Desktop extensions (.mcpb/.dxt) each bundle an MCP server.
  const extensionsDir = join(dir, "Claude Extensions");
  if (safeExistsSync(extensionsDir)) {
    signals.extensionCount = countDirEntries(extensionsDir);
  }
  return signals;
}

/**
 * Count the MCP servers a tool lists across its configuration files. A server
 * named in two files is counted once.
 *
 * @param {string} dir Tool home directory, which relative files resolve against
 * @param {Array<{file: string, key: string}>} [mcpConfigs] Files and the key
 *   holding the server map. A key is looked up as written first, so a dotted
 *   key such as `amp.mcpServers` matches a literal property.
 * @returns {number|undefined} Number of servers, or undefined when no file
 *   defines any
 */
export function countConfiguredMcpServers(dir, mcpConfigs) {
  const names = new Set();
  let sawConfig = false;
  for (const { file, key } of mcpConfigs || []) {
    const config = parseJsonFile(isAbsolute(file) ? file : join(dir, file));
    if (!config || typeof config !== "object") {
      continue;
    }
    let servers = config[key];
    if (servers === undefined && key.includes(".")) {
      servers = key.split(".").reduce((value, part) => value?.[part], config);
    }
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      sawConfig = true;
      for (const name of Object.keys(servers)) {
        names.add(name);
      }
    }
  }
  return sawConfig ? names.size : undefined;
}

/**
 * Describe the editor an agentic tool ships in: its installed version and
 * how many extensions are in its extensions folder.
 *
 * @param {string} ideId Entry id from IDE_PRODUCTS
 * @param {string} home Home directory
 * @returns {{version?: string, installDir?: string, extensionCount?: number}}
 *   What could be read
 */
function describeAgenticIde(ideId, home) {
  const product = IDE_PRODUCTS.find((p) => p.id === ideId);
  if (!product) {
    return {};
  }
  const info = findIdeProductInfo({ id: ideId, kind: "desktop" }, home);
  const result = {};
  if (info?.version) {
    result.version = info.version;
  }
  if (info?.appDir) {
    result.installDir = info.appDir;
  }
  const extensionsDir = join(home, product.dataFolderName, "extensions");
  if (safeExistsSync(extensionsDir)) {
    result.extensionCount = countDirEntries(
      extensionsDir,
      (name) => !name.startsWith(".") && name !== "extensions.json",
    );
  }
  return result;
}

/**
 * Compute safe, redacted signal counts for a discovered tool. Only structural
 * counts and small enumerated values are returned; no credential, transcript,
 * or telemetry content is read.
 *
 * @param {string} tool Tool key
 * @param {string} dir Discovered tool home directory
 * @param {string} [supportDir] Optional platform support directory
 * @param {Array<{file: string, key: string}>} [mcpConfigs] Files that list
 *   the tool's MCP servers, used when the tool has no reader of its own
 * @param {string} [home] Home directory the tool was found in
 * @returns {Object} Map of signal name to count/boolean/small-string value
 */
export function collectToolSignals(
  tool,
  dir,
  supportDir,
  mcpConfigs,
  home = homedir(),
) {
  const signals = toolSpecificSignals(tool, dir, supportDir);
  if (signals.mcpServerCount === undefined) {
    const mcpServerCount = countConfiguredMcpServers(
      dir,
      mcpConfigs ||
        getAgenticToolDirs(home).find((entry) => entry.tool === tool)
          ?.mcpConfigs || [{ file: ".mcp.json", key: "mcpServers" }],
    );
    if (mcpServerCount !== undefined) {
      signals.mcpServerCount = mcpServerCount;
    }
  }
  return signals;
}

function toolSpecificSignals(tool, dir, supportDir) {
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
    case "claude-desktop":
      return countClaudeDesktopSignals(dir);
    case "goose":
      return countGooseSignals(dir);
    case "crush":
      return countCrushSignals(dir);
    default:
      return {};
  }
}

/**
 * Build a CycloneDX application component for one discovered agentic tool.
 *
 * @param {{tool: string, name: string, dir: string, supportDir?: string, mcpConfigs?: Object[], ide?: string}} entry
 *   Discovered tool entry
 * @param {string} [home] Home directory, used to find the tool's editor
 * @returns {Object} CycloneDX component
 */
export function componentForAgenticTool(entry, home = homedir()) {
  const { tool, name, dir, supportDir, mcpConfigs, ide } = entry;
  const ideInfo = ide ? describeAgenticIde(ide, home) : {};
  const version = readToolVersion(tool, dir, supportDir) || ideInfo.version;
  const purl = buildGenericPurl(tool, version);
  const properties = [
    { name: "internal:SrcFile", value: redactHomePath(dir, home) },
    { name: "cdx:agentic:tool", value: tool },
    { name: "cdx:agentic:home", value: redactHomePath(dir, home) },
    { name: "cdx:agentic:inventorySource", value: "host-scan" },
  ];
  if (supportDir) {
    properties.push({
      name: "cdx:agentic:supportDir",
      value: redactHomePath(supportDir, home),
    });
  }
  // ~/.cursor or ~/.codeium/windsurf can exist with only a CLI or a plugin
  // installed, so the editor is named only when it was found.
  const ideFound =
    Boolean(ide) &&
    (ideInfo.installDir !== undefined || ideInfo.extensionCount !== undefined);
  if (ideFound) {
    properties.push({ name: "cdx:agentic:ide", value: ide });
  }
  if (ideInfo.installDir) {
    properties.push({
      name: "cdx:agentic:ideInstallDir",
      value: redactHomePath(ideInfo.installDir, home),
    });
  }
  const signals = collectToolSignals(tool, dir, supportDir, mcpConfigs, home);
  if (ideInfo.extensionCount !== undefined) {
    signals.extensionCount = ideInfo.extensionCount;
  }
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
  component.description = ideFound
    ? `${name} AI editor discovered on the host`
    : `${name} agentic CLI tool discovered on the host`;
  if (ideFound) {
    component.tags.push("ai-ide");
  }
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
 * @param {string} [home] Home directory the tool was found in, for redaction
 * @returns {Object[]} Child components
 */
function parseKiroAgents(dir, parentRef, home = homedir()) {
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
        value: redactHomePath(join(agentsDir, file), home),
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
 * @param {string} [home] Home directory the tool was found in, for redaction
 * @returns {Object[]} Child components
 */
function parseZcodePlugins(dir, parentRef, home = homedir()) {
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
          { name: "internal:SrcFile", value: redactHomePath(full, home) },
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
 * @param {string} [home] Home directory the tool was found in, for redaction
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
 * @param {string} [home] Home directory the tool was found in, for redaction
 * @returns {Object[]} Child provider services
 */
function parseOpencodeProviders(dir, parentRef, home = homedir()) {
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
        { name: "internal:SrcFile", value: redactHomePath(usedPath, home) },
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
 * @param {string} [home] Home directory the tool was found in, for redaction
 * @returns {{components: Object[], services: Object[]}} Child inventory
 */
function collectToolChildren(tool, dir, parentRef, home = homedir()) {
  switch (tool) {
    case "kiro-cli":
      return {
        components: parseKiroAgents(dir, parentRef, home),
        services: [],
      };
    case "zcode":
      return {
        components: parseZcodePlugins(dir, parentRef, home),
        services: [],
      };
    case "opencode":
      return {
        components: [],
        services: parseOpencodeProviders(dir, parentRef, home),
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
 * home directories rather than a project tree.
 *
 * @param {Object} [options={}] Collection options
 * @param {string} [options.home] Home directory to scan, defaulting to the
 *   current user's
 * @returns {{components: Object[], services: Object[], dependencies: Object[]}} Discovered inventory
 */
export function collectAgenticTools(options = {}) {
  const components = [];
  const services = [];
  const dependencies = [];
  const home = options.home || homedir();
  for (const entry of discoverAgenticTools(home)) {
    try {
      const toolComponent = componentForAgenticTool(entry, home);
      components.push(toolComponent);
      const parentRef = toolComponent["bom-ref"];
      const children = collectToolChildren(
        entry.tool,
        entry.dir,
        parentRef,
        home,
      );
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
