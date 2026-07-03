/**
 * Tolerant parser for git-ai notes.
 *
 * Supports three shapes, all degrading gracefully (never throws):
 *  1. The real git-ai `authorship/*` schema: per-file attribution blocks
 *     followed by a `---` separator and a JSON metadata block carrying
 *     `sessions` (each with an `agent_id` describing the AI tool/model).
 *  2. A flat JSON object `{ agent, model, session, prompt, lines, ranges }`.
 *  3. Line-oriented `key: value` / `key = value` text.
 *
 * @param {string} raw Raw git note content
 * @returns {Object} Extracted fields { agent, model, session, prompt, lines, ranges, sessions, prompts, agents, models, aiAttributionCount }
 */
export function parseGitAiNote(raw) {
  const result = {
    agent: "",
    model: "",
    session: "",
    prompt: "",
    lines: [],
    ranges: [],
    sessions: {},
    prompts: {},
    agents: [],
    models: [],
    aiAttributionCount: 0,
  };

  if (!raw || typeof raw !== "string") {
    return result;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return result;
  }

  // git-ai `authorship/*` notes: optional per-file attribution section, then a
  // line that is exactly `---`, then a JSON metadata block. Detect and parse
  // this first because the note as a whole is not valid JSON.
  const authorship = tryParseAuthorshipNote(trimmed);
  if (authorship) {
    return authorship;
  }

  // Flat JSON note.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      if (parsed.agent) result.agent = String(parsed.agent);
      if (parsed.model) result.model = String(parsed.model);
      if (parsed.session) result.session = String(parsed.session);
      if (parsed.prompt) result.prompt = String(parsed.prompt);
      if (Array.isArray(parsed.lines)) {
        result.lines = parsed.lines;
      }
      if (Array.isArray(parsed.ranges)) {
        result.ranges = parsed.ranges;
      }
      result.aiAttributionCount = result.ranges.length + result.lines.length;
      return result;
    }
  } catch {
    // Ignore JSON error, fall back to line parsing
  }

  // Fallback: line-oriented text parsing
  for (const line of trimmed.split("\n")) {
    const lineTrim = line.trim();
    if (!lineTrim || lineTrim.startsWith("#")) {
      continue;
    }
    const match = lineTrim.match(/^([a-zA-Z0-9_-]+)\s*[:=]\s*(.*)$/);
    if (match) {
      const key = match[1].toLowerCase();
      const val = match[2].trim();
      if (key === "agent") result.agent = val;
      else if (key === "model") result.model = val;
      else if (key === "session") result.session = val;
      else if (key === "prompt") result.prompt = val;
      else if (key === "lines" || key === "ranges") {
        try {
          if (val.startsWith("[") && val.endsWith("]")) {
            result[key] = JSON.parse(val);
          } else {
            result[key] = val
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  result.aiAttributionCount = result.ranges.length + result.lines.length;

  return result;
}

/**
 * Parse a git-ai `authorship/*` note per the Git AI Standard v3.0.0. Returns
 * null if the note is not in that format so callers can fall back to other
 * parsers.
 *
 * The note is `<attestation-section>` + a line that is exactly `---` +
 * `<metadata JSON>`. Attestation entries are `  <key> <ranges>` where the key
 * routes by prefix (spec section 1.2.3.1):
 *   - `s_<hex>::t_<hex>` -> AI session; session id (before `::`) in `sessions`.
 *   - `h_<hex>`          -> KNOWN HUMAN (`humans`); NOT AI, ignored here.
 *   - `<16hex>` (no prefix) -> legacy AI session in `prompts`.
 *
 * @param {string} trimmed Trimmed raw note content
 * @returns {Object|null} Parsed fields, or null when not an authorship note
 */
function tryParseAuthorshipNote(trimmed) {
  // The divider is a line containing exactly `---`. Metadata-only notes (purely
  // human commits) start with `---`; bare JSON is accepted defensively.
  let attributionText = "";
  let jsonText = "";
  const sepMatch = trimmed.match(/(^|\n)---[ \t]*\r?\n/);
  if (sepMatch) {
    const idx = sepMatch.index + sepMatch[0].length;
    attributionText = trimmed.slice(0, sepMatch.index);
    jsonText = trimmed.slice(idx).trim();
  } else if (trimmed.startsWith("{")) {
    jsonText = trimmed;
  } else {
    return null;
  }

  let meta;
  try {
    meta = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (
    !meta ||
    typeof meta !== "object" ||
    typeof meta.schema_version !== "string" ||
    !meta.schema_version.startsWith("authorship")
  ) {
    return null;
  }

  const result = {
    agent: "",
    model: "",
    session: "",
    prompt: "",
    lines: [],
    ranges: [],
    sessions: {},
    prompts: {},
    agents: [],
    models: [],
    aiAttributionCount: 0,
  };

  const asObject = (value) => (value && typeof value === "object" ? value : {});
  const metaSessions = asObject(meta.sessions); // s_<hex> -> { agent_id, ... }
  const metaPrompts = asObject(meta.prompts); // legacy <16hex> -> { agent_id, ... }
  result.sessions = metaSessions;
  result.prompts = metaPrompts;

  // Collect all unique agent tool names and model names from sessions and
  // prompts. Also record the first AI agent as the primary attribution key.
  const agentSet = new Set();
  const modelSet = new Set();
  const collectAgent = (key, record) => {
    const agentObj = record?.agent_id;
    if (agentObj) {
      const tool = agentObj.tool ? String(agentObj.tool) : "";
      const model = agentObj.model ? String(agentObj.model) : "";
      if (tool || model) {
        if (tool) agentSet.add(tool);
        if (model) modelSet.add(model);
        if (!result.agent) {
          result.agent = tool;
          result.model = model;
          result.session = key;
        }
      }
    }
  };
  for (const [sid, sess] of Object.entries(metaSessions)) {
    collectAgent(sid, sess);
  }
  for (const [pid, prompt] of Object.entries(metaPrompts)) {
    collectAgent(pid, prompt);
  }
  result.agents = [...agentSet].sort();
  result.models = [...modelSet].sort();

  /**
   * Resolve an attestation key to whether it denotes AI authorship.
   * @param {string} key attestation key
   * @returns {boolean} true when the key maps to an AI session/prompt
   */
  const isAiKey = (key) => {
    if (key.startsWith("h_")) {
      return false; // known human
    }
    if (key.startsWith("s_")) {
      const sessionId = key.split("::")[0];
      return Object.hasOwn(metaSessions, sessionId);
    }
    // Legacy bare-hex key routes to prompts.
    return Object.hasOwn(metaPrompts, key);
  };

  // Attestation entries are indented `  <key> <ranges>`; ranges never contain
  // spaces. File-path lines (unindented) and anything else are ignored here.
  for (const rawLine of attributionText.split("\n")) {
    const attr = rawLine.match(/^\s+(\S+)[ \t]+(\S+)\s*$/);
    if (!attr || !isAiKey(attr[1])) {
      continue;
    }
    for (const part of attr[2].split(",")) {
      const token = part.trim();
      if (token) {
        result.ranges.push(token);
      }
    }
  }

  result.aiAttributionCount = result.ranges.length;

  return result;
}
