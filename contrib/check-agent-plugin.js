#!/usr/bin/env node
// check-agent-plugin.js — structural checks for the coding-agent plugin in
// claude-plugin/ that `claude plugin validate` does not make.
//
// The plugin version is bumped by hand alongside package.json, deno.json,
// jsr.json and pyproject.toml, and has drifted before. Skills link to the
// shared reference/ files with relative paths that break silently when a file
// moves. Agent Skills clients other than Claude Code (Codex, Copilot, Cursor)
// reject a skill whose name does not match its directory or whose description
// is over the spec's 1024-character limit. The contributor skills in
// .agents/skills get the same skill checks.
//
// Usage:
//   node contrib/check-agent-plugin.js          // exit 1 on any problem
//   node contrib/check-agent-plugin.js --json
//
// Exit codes:
//   0 — no problems
//   1 — at least one problem
//   2 — internal error

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKETPLACE = path.join(REPO_ROOT, ".claude-plugin", "marketplace.json");

// https://agentskills.io/specification
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME = 64;
const MAX_DESCRIPTION = 1024;

// Markdown links whose target is a relative path, e.g. (../../reference/safety.md)
const RELATIVE_LINK = /\]\((\.{1,2}\/[^)#\s]+)(?:#[^)]*)?\)/g;

const readJson = (file) => JSON.parse(readFileSync(file, "utf-8"));

// Claude Code reads frontmatter leniently, but other Agent Skills clients use
// strict YAML parsers, so an unquoted ": " inside a description loses the skill
// there. Report parse errors rather than throwing.
function frontmatter(file) {
  const text = readFileSync(file, "utf-8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) {
    return { data: null, text };
  }
  try {
    return { data: parseYaml(match[1]) || {}, text };
  } catch (err) {
    return { data: null, text, error: err.message.split("\n")[0] };
  }
}

// Every file in the repository that carries the release version.
function releaseVersions(pluginManifest) {
  const pyproject = readFileSync(path.join(REPO_ROOT, "pyproject.toml"), "utf-8");
  return {
    "package.json": readJson(path.join(REPO_ROOT, "package.json")).version,
    "deno.json": readJson(path.join(REPO_ROOT, "deno.json")).version,
    "jsr.json": readJson(path.join(REPO_ROOT, "jsr.json")).version,
    "pyproject.toml": /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1],
    [path.relative(REPO_ROOT, pluginManifest)]: readJson(pluginManifest).version,
  };
}

function checkLinks(file, text, problems) {
  for (const match of text.matchAll(RELATIVE_LINK)) {
    if (!existsSync(path.resolve(path.dirname(file), match[1]))) {
      problems.push({
        file: path.relative(REPO_ROOT, file),
        problem: `link target not found: ${match[1]}`,
      });
    }
  }
}

function checkSkills(pluginRoot, problems) {
  const skillsDir = path.join(pluginRoot, "skills");
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(skillsDir, entry.name, "SKILL.md");
    const rel = path.relative(REPO_ROOT, file);
    if (!existsSync(file)) {
      problems.push({ file: rel, problem: "missing SKILL.md" });
      continue;
    }
    const { data, text, error } = frontmatter(file);
    if (!data) {
      problems.push({
        file: rel,
        problem: error ? `invalid YAML frontmatter: ${error}` : "missing YAML frontmatter",
      });
      continue;
    }
    if (data.name !== entry.name) {
      problems.push({
        file: rel,
        problem: `name "${data.name}" does not match its directory "${entry.name}"`,
      });
    }
    if (!SKILL_NAME.test(entry.name) || entry.name.length > MAX_SKILL_NAME) {
      problems.push({
        file: rel,
        problem: "name must be lowercase letters, digits and single hyphens, at most 64 characters",
      });
    }
    if (typeof data.description !== "string" || !data.description.trim()) {
      problems.push({ file: rel, problem: "missing description" });
    } else if (data.description.length > MAX_DESCRIPTION) {
      problems.push({
        file: rel,
        problem: `description is ${data.description.length} characters, over the ${MAX_DESCRIPTION} limit`,
      });
    }
    checkLinks(file, text, problems);
  }
}

function checkAgents(pluginRoot, problems) {
  const agentsDir = path.join(pluginRoot, "agents");
  if (!existsSync(agentsDir)) {
    return;
  }
  for (const entry of readdirSync(agentsDir)) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const file = path.join(agentsDir, entry);
    const rel = path.relative(REPO_ROOT, file);
    const { data, text, error } = frontmatter(file);
    if (error) {
      problems.push({ file: rel, problem: `invalid YAML frontmatter: ${error}` });
    } else if (!data?.name || !data?.description) {
      problems.push({ file: rel, problem: "agent needs a name and a description" });
    }
    checkLinks(file, text, problems);
  }
}

// Hook commands that name a script through ${CLAUDE_PLUGIN_ROOT} must point at
// a file that exists.
function checkHooks(pluginRoot, problems) {
  const hooksFile = path.join(pluginRoot, "hooks", "hooks.json");
  if (!existsSync(hooksFile)) {
    return;
  }
  const rel = path.relative(REPO_ROOT, hooksFile);
  const { hooks } = readJson(hooksFile);
  for (const groups of Object.values(hooks || {})) {
    for (const group of groups) {
      for (const handler of group.hooks || []) {
        for (const arg of [handler.command, ...(handler.args || [])]) {
          const script = /\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+)/.exec(arg || "")?.[1];
          if (script && !existsSync(path.join(pluginRoot, script))) {
            problems.push({ file: rel, problem: `hook script not found: ${script}` });
          }
        }
      }
    }
  }
}

function collectProblems() {
  const problems = [];
  const marketplace = readJson(MARKETPLACE);
  for (const plugin of marketplace.plugins) {
    const pluginRoot = path.resolve(path.dirname(MARKETPLACE), "..", plugin.source);
    const manifest = path.join(pluginRoot, ".claude-plugin", "plugin.json");
    if (!existsSync(manifest)) {
      problems.push({ file: plugin.source, problem: "plugin manifest not found" });
      continue;
    }
    if (readJson(manifest).name !== plugin.name) {
      problems.push({
        file: path.relative(REPO_ROOT, manifest),
        problem: `name does not match the marketplace entry "${plugin.name}"`,
      });
    }
    const versions = releaseVersions(manifest);
    if (new Set(Object.values(versions)).size !== 1) {
      problems.push({
        file: path.relative(REPO_ROOT, manifest),
        problem: `release versions differ: ${Object.entries(versions)
          .map(([f, v]) => `${f}=${v}`)
          .join(", ")}`,
      });
    }
    checkSkills(pluginRoot, problems);
    checkAgents(pluginRoot, problems);
    checkHooks(pluginRoot, problems);
  }
  // The contributor skills in .agents/skills follow the same spec.
  checkSkills(path.join(REPO_ROOT, ".agents"), problems);
  return problems;
}

function main() {
  const problems = collectProblems();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ problems, total: problems.length }, null, 2));
  } else if (problems.length) {
    console.error(`${problems.length} problem(s) in the agent plugin:`);
    for (const { file, problem } of problems) {
      console.error(`  ${file}: ${problem}`);
    }
  } else {
    console.log("Agent plugin checks passed.");
  }
  process.exitCode = problems.length ? 1 : 0;
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 2;
}
