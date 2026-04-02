import process from "node:process";

const SUSPICIOUS_NODE_OPTIONS_PATTERNS = [
  /--require/i,
  /--eval/i,
  /--import/i,
  /--loader/i,
  /--inspect/i,
];

const DANGEROUS_VARS = [
  "NODE_NO_WARNINGS",
  "NODE_PENDING_DEPRECATION",
  "UV_THREADPOOL_SIZE",
];

export function auditEnvironment(env = process.env) {
  const warnings = [];
  for (const varName of DANGEROUS_VARS) {
    if (env[varName]) {
      warnings.push(
        `Unset ${varName} before running cdxgen on untrusted repos.`,
      );
    }
  }
  for (const pattern of SUSPICIOUS_NODE_OPTIONS_PATTERNS) {
    if (pattern.test(env.NODE_OPTIONS)) {
      warnings.push(
        `NODE_OPTIONS contains code execution flag: ${pattern.toString()}.`,
      );
    }
  }
  return warnings;
}
