import { basename } from "node:path";

/**
 * Run-scoped registry of the external tools cdxgen actually executed, feeding
 * the `metadata.tools` section (issue #598). `safeSpawnSync` records the
 * command it is about to run, and the stages that already know a tool's
 * version - such as the JVM tool resolution in pregen - enrich the entry; no
 * process is ever spawned just to learn a version.
 *
 * The registry is filled in as the run progresses and read once per BOM when
 * the metadata section is assembled. A run that spawns nothing external keeps
 * it empty, which is what keeps such BOMs byte-identical to the previous
 * behaviour.
 *
 * @type {Map<string, {name: string, version: (string|undefined)}>}
 */
const EXECUTED_TOOLS = new Map();

/**
 * Interpreter and shell binaries that wrap the real work. They appear on
 * nearly every spawn, so recording them would drown the tools that actually
 * generated the BOM.
 *
 * @type {Set<string>}
 */
const WRAPPER_BASENAMES = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "node",
  "powershell",
  "powershell.exe",
  "pwsh",
  "sh",
  "zsh",
]);

/**
 * Strip a trailing Windows executable suffix from a binary name.
 *
 * @param {string} name Binary name
 * @returns {string} Name without a trailing `.exe`, `.bat`, or `.cmd`
 */
function trimWindowsSuffix(name) {
  for (const suffix of [".exe", ".bat", ".cmd"]) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/**
 * Record an external tool cdxgen executed. The first version seen wins unless
 * it was unknown, so an enriched probe never overwrites a concrete version
 * with `undefined` and a later concrete version fills an earlier gap.
 *
 * @param {string} name Tool name as invoked (a bare name or a path)
 * @param {string|undefined} version Version when cheaply known
 */
export function recordExecutedTool(name, version) {
  if (typeof name !== "string" || !name) {
    return;
  }
  const toolName = trimWindowsSuffix(basename(`${name}`.split("\\").join("/")));
  if (!toolName || WRAPPER_BASENAMES.has(toolName)) {
    return;
  }
  const key = toolName.toLowerCase();
  const existing = EXECUTED_TOOLS.get(key);
  if (!existing) {
    EXECUTED_TOOLS.set(key, {
      name: toolName,
      version: typeof version === "string" && version ? version : undefined,
    });
    return;
  }
  if (typeof version === "string" && version && !existing.version) {
    existing.version = version;
  }
}

/**
 * Snapshot of the tools recorded so far, sorted by name so the assembled
 * `metadata.tools` diff stays stable between runs.
 *
 * @returns {Array<{name: string, version: (string|undefined)}>} Sorted tool records
 */
export function getExecutedTools() {
  return [...EXECUTED_TOOLS.values()].sort((a, b) =>
    a.name === b.name
      ? 0
      : a.name.toLowerCase() < b.name.toLowerCase()
        ? -1
        : 1,
  );
}

/**
 * Clear the registry. Intended for tests; a production run never resets its
 * own registry.
 *
 * @returns {void}
 */
export function resetExecutedTools() {
  EXECUTED_TOOLS.clear();
}
