// PostToolUse hook for Write and Edit: when Claude changes a lockfile or a
// dependency manifest, remind it that any SBOM generated earlier in the
// session no longer matches the project. Off unless the user turns on the
// plugin's "lockfile_reminder" option. It reminds once per file per session,
// using a small marker file in the plugin's data directory.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXACT = new Set([
  "Cargo.lock",
  "Cargo.toml",
  "Gemfile",
  "Gemfile.lock",
  "Package.resolved",
  "Package.swift",
  "Pipfile",
  "Pipfile.lock",
  "build.gradle",
  "build.gradle.kts",
  "bun.lock",
  "bun.lockb",
  "composer.json",
  "composer.lock",
  "conan.lock",
  "conanfile.txt",
  "go.mod",
  "go.sum",
  "gradle.lockfile",
  "mix.lock",
  "package-lock.json",
  "package.json",
  "packages.lock.json",
  "pdm.lock",
  "pixi.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pom.xml",
  "pubspec.lock",
  "pubspec.yaml",
  "pyproject.toml",
  "uv.lock",
  "vcpkg.json",
  "yarn.lock",
]);
const PATTERNS = [/^requirements.*\.txt$/, /\.(?:cs|fs|vb)proj$/];

export function isDependencyFile(file) {
  const base = path.basename(file || "");
  return EXACT.has(base) || PATTERNS.some((re) => re.test(base));
}

export function enabled(env = process.env) {
  return ["true", "1"].includes(
    String(env.CLAUDE_PLUGIN_OPTION_LOCKFILE_REMINDER).toLowerCase(),
  );
}

// Returns true the first time a file is seen in a session.
function firstTime(dataDir, sessionId, file) {
  if (!dataDir || !sessionId) {
    return true;
  }
  const dir = path.join(dataDir, "stale-sbom");
  const marker = path.join(
    dir,
    `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`,
  );
  let seen = [];
  try {
    seen = JSON.parse(readFileSync(marker, "utf-8"));
  } catch {
    // first reminder of this session
  }
  if (seen.includes(file)) {
    return false;
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, JSON.stringify([...seen, file]));
  } catch {
    // a reminder too many is better than none
  }
  return true;
}

export function remind(input, env = process.env) {
  const file = input?.tool_input?.file_path;
  if (!enabled(env) || !isDependencyFile(file)) {
    return undefined;
  }
  if (!firstTime(env.CLAUDE_PLUGIN_DATA, input.session_id, file)) {
    return undefined;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `${path.basename(file)} changed, so any SBOM generated before this edit no longer matches the project. Mention this to the user when you finish, and offer to re-run cdxgen (dry run first).`,
    },
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf-8"));
  } catch {
    process.exit(0);
  }
  const result = remind(input);
  if (result) {
    process.stdout.write(JSON.stringify(result));
  }
}
