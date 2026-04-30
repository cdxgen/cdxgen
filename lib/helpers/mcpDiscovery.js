const PROVIDER_TEXT_PATTERNS = [
  ["anthropic", /\banthropic\b|claude/i],
  ["openai", /\bopenai\b|\bgpt-[a-z0-9-]+\b|\bo[13]\b/i],
  ["google", /\bgemini\b|google(?:\s+ai)?/i],
  ["mistral", /\bmistral\b/i],
  ["deepseek", /\bdeepseek\b/i],
  ["ollama", /\bollama\b/i],
  ["groq", /\bgroq\b/i],
];

const INLINE_CREDENTIAL_PATTERNS = [
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["bearer-token", /\bbearer\s+[a-z0-9._-]{16,}\b/iu],
  ["generic-secret", /\b(?:sk|rk|pk)_[a-z0-9_-]{8,}\b/iu],
  ["github-token", /\bgh[pousr]_[a-z0-9]{20,}\b/iu],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{20,}\b/u],
];

export function sanitizeMcpRefToken(value) {
  const input = String(value || "").toLowerCase();
  const tokens = [];
  let previousWasSeparator = false;
  for (const char of input) {
    const isAlphaNumeric =
      (char >= "a" && char <= "z") || (char >= "0" && char <= "9");
    const isAllowedPunctuation = [".", "_", "-"].includes(char);
    if (isAlphaNumeric || isAllowedPunctuation) {
      tokens.push(char);
      previousWasSeparator = false;
      continue;
    }
    if (!previousWasSeparator && tokens.length) {
      tokens.push("-");
      previousWasSeparator = true;
    }
  }
  while (tokens[0] === "-") {
    tokens.shift();
  }
  while (tokens[tokens.length - 1] === "-") {
    tokens.pop();
  }
  return tokens.join("") || "unknown";
}

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

export function providerNamesForText(text) {
  return [
    ...new Set(
      PROVIDER_TEXT_PATTERNS.flatMap(([name, pattern]) =>
        pattern.test(text) ? [name] : [],
      ),
    ),
  ];
}

export function credentialIndicatorsForText(text) {
  return [
    ...new Set(
      INLINE_CREDENTIAL_PATTERNS.flatMap(([name, pattern]) =>
        pattern.test(text) ? [name] : [],
      ),
    ),
  ];
}
