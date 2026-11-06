/**
 * Tool allow lists of coding-agent configurations, reduced to tool names.
 *
 * An allow list such as `Read, Bash(git status:*), Bash(curl -u user,secret)`
 * carries commands, paths and sometimes credentials inside its parentheses.
 * Only the tool name before any "(" is kept, so nothing an entry scopes its
 * tool to reaches a BOM. The list is split on the commas outside parentheses,
 * so the arguments of one entry never become entries of their own.
 *
 * A tool name is at most 64 characters of letters, digits and `_ - . : *`
 * (`Read`, `mcp__github__*`, `fs_write`), optionally in the `@server/tool`
 * form Kiro uses. A name that looks like a credential (a known token prefix
 * such as `ghp_` or `AKIA`, or a long run of letters and digits with no
 * separator) is dropped.
 */

const NAME_CHARACTERS = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:*-",
);
const NAME_SEPARATORS = new Set("._:*-/@");
const MAX_NAME_LENGTH = 64;
// Prefixes of GitHub, OpenAI and Anthropic, Slack and AWS access key ids.
const CREDENTIAL_PREFIXES = Object.freeze([
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "sk-",
  "xoxa-",
  "xoxb-",
  "xoxp-",
  "AKIA",
]);
// A tool name is a word or words joined by separators; a longer unbroken run
// of letters and digits that mixes both is treated as a token.
const MAX_UNSEPARATED_TOKEN_LENGTH = 24;

/**
 * Split an allow list on the commas outside parentheses. An array is taken
 * as already split.
 *
 * @param {string|string[]|undefined} value Allow list
 * @returns {string[]} Trimmed, non-empty entries
 */
export function splitAllowList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string")
      .flatMap((entry) => splitAllowList(entry));
  }
  const entries = [];
  let depth = 0;
  let current = "";
  for (const ch of `${value ?? ""}`) {
    if (ch === "(") {
      depth++;
    } else if (ch === ")" && depth > 0) {
      depth--;
    } else if (ch === "," && depth === 0) {
      entries.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  entries.push(current);
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

function looksLikeCredential(name) {
  if (CREDENTIAL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  const chars = [...name];
  return (
    name.length >= MAX_UNSEPARATED_TOKEN_LENGTH &&
    !chars.some((ch) => NAME_SEPARATORS.has(ch)) &&
    chars.some((ch) => ch >= "0" && ch <= "9") &&
    chars.some((ch) => ch.toLowerCase() !== ch.toUpperCase())
  );
}

function isNamePart(part) {
  return part.length > 0 && [...part].every((ch) => NAME_CHARACTERS.has(ch));
}

/**
 * The tool name of one allow-list entry, or undefined when it is not a safe
 * tool name.
 *
 * @param {string} entry Allow-list entry
 * @returns {string|undefined} Tool name
 */
export function agentToolName(entry) {
  const text = `${entry ?? ""}`;
  const parenthesis = text.indexOf("(");
  const name = (parenthesis >= 0 ? text.slice(0, parenthesis) : text).trim();
  if (!name.length || name.length > MAX_NAME_LENGTH) {
    return undefined;
  }
  const scoped = name.startsWith("@") ? name.slice(1).split("/") : [name];
  const shapeOk = name.startsWith("@")
    ? scoped.length === 2 && scoped.every(isNamePart)
    : isNamePart(name);
  if (!shapeOk || looksLikeCredential(name)) {
    return undefined;
  }
  return name;
}

/**
 * The unique, sorted tool names of an allow list.
 *
 * @param {string|string[]|undefined} value Allow list
 * @returns {string[]} Tool names
 */
export function agentToolNames(value) {
  return [
    ...new Set(splitAllowList(value).map(agentToolName).filter(Boolean)),
  ].sort();
}

/**
 * An allow list as cdxgen records it in `cdx:agent:tools` and
 * `cdx:agent:disallowedTools`: each entry reduced to its tool name, written
 * `Name(...)` when the entry scoped the tool with arguments, so a scoped
 * `Bash(git status:*)` stays distinguishable from an unrestricted `Bash`
 * without copying the scope. Unique, in the order the config lists them,
 * comma separated.
 *
 * @param {string|string[]|undefined} value Allow list
 * @returns {string|undefined} Summary, or undefined when nothing is left
 */
export function summarizeAgentToolList(value) {
  const summary = new Set();
  for (const entry of splitAllowList(value)) {
    const name = agentToolName(entry);
    if (name) {
      summary.add(entry.includes("(") ? `${name}(...)` : name);
    }
  }
  return summary.size ? [...summary].join(",") : undefined;
}
