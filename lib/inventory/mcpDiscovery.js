const PROVIDER_TEXT_PATTERNS = [
  ["anthropic", /\banthropic\b|claude/i],
  ["openai", /\bopenai\b|\bgpt-[a-z0-9-]+\b|\bo[13]\b/i],
  ["google", /\bgemini\b|google(?:\s+ai)?/i],
  ["mistral", /\bmistral\b/i],
  ["deepseek", /\bdeepseek\b/i],
  ["ollama", /\bollama\b/i],
  ["groq", /\bgroq\b/i],
  ["xai", /\bgrok\b|\bx\.ai\b/i],
  ["openrouter", /\bopenrouter\b/i],
  // "bedrock" alone is also a WordPress stack and a Minecraft edition, so
  // require AWS context before attributing it to Amazon Bedrock.
  ["aws-bedrock", /\b(?:aws|amazon)[\s-]?bedrock\b|\bbedrock[\s-]?runtime\b/i],
  ["cerebras", /\bcerebras\b/i],
  // Drop the bare "kimi" alias (a common given name); keep the distinctive
  // "moonshot" vendor token.
  ["moonshot", /\bmoonshot\b/i],
  ["zhipu", /\bzhipu\b|\bglm-[0-9]/i],
  ["qwen", /\bqwen\b|\bdashscope\b/i],
];

const INLINE_CREDENTIAL_PATTERNS = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["bearer-token", /\bbearer\s+[a-z0-9._-]{16,}\b/iu],
  ["generic-secret", /\b(?:sk|rk|pk)_[a-z0-9_-]{8,}\b/iu],
  ["github-token", /\bgh[pousr]_[a-z0-9]{20,}\b/iu],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{20,}\b/u],
];

// A token keeps at most 128 characters, so only this much of the input is
// normalized. NFKC reorders runs of combining marks in time that grows with
// the square of the run, and scanned files supply the names.
const MAX_REF_TOKEN_INPUT_LENGTH = 256;

/**
 * Normalize a string into a safe MCP reference token.
 *
 * Reads the first 256 characters, NFKC-normalizes, lowercases, collapses
 * separator runs, strips leading and trailing punctuation, and truncates to
 * 128 characters, falling back to `unknown` for empty or dot-only results.
 *
 * @param {string} value Raw token value
 * @returns {string} Sanitized reference token
 */
export function sanitizeMcpRefToken(value) {
  const input = String(value || "")
    .slice(0, MAX_REF_TOKEN_INPUT_LENGTH)
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  const normalized = input
    .replaceAll(/[/\\:]/gu, "-")
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/[._-]{2,}/gu, "-")
    .replaceAll(/^\.+|\.+$/gu, "")
    .replaceAll(/^[._-]+|[._-]+$/gu, "");
  if (!normalized || normalized === "." || normalized === "..") {
    return "unknown";
  }
  return normalized.slice(0, 128);
}

/**
 * Determine whether a hostname is local: `localhost`, loopback, link-local, or a private address range.
 *
 * @param {string} hostname Hostname or IP address
 * @returns {boolean} `true` when the host resolves to a local or private address
 */
export function isLocalHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (
    !normalized ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  ) {
    return true;
  }
  if (
    normalized.startsWith("10.") ||
    normalized.startsWith("127.") ||
    normalized.startsWith("169.254.") ||
    normalized.startsWith("192.168.")
  ) {
    return true;
  }
  const octets = normalized.split(".");
  if (
    octets.length === 4 &&
    octets[0] === "172" &&
    Number(octets[1]) >= 16 &&
    Number(octets[1]) <= 31
  ) {
    return true;
  }
  return false;
}

/**
 * Return the AI provider names whose detection patterns match the given text.
 *
 * @param {string} text Text to scan
 * @returns {string[]} Matching provider names (e.g. `anthropic`, `openai`)
 */
export function providerNamesForText(text) {
  return [
    ...new Set(
      PROVIDER_TEXT_PATTERNS.flatMap(([name, pattern]) =>
        pattern.test(text) ? [name] : [],
      ),
    ),
  ];
}

/**
 * Return the credential-indicator names whose patterns match the given text.
 *
 * @param {string} text Text to scan
 * @returns {string[]} Matching indicator names (e.g. `github-token`, `bearer-token`)
 */
export function credentialIndicatorsForText(text) {
  return [
    ...new Set(
      INLINE_CREDENTIAL_PATTERNS.flatMap(([name, pattern]) =>
        pattern.test(text) ? [name] : [],
      ),
    ),
  ];
}
