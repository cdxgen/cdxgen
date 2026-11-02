#!/usr/bin/env node
// gen-agent-manifests.js — write the shared fields of every coding-agent
// manifest from package.json and contrib/agent-manifests.template.json.
//
// The version comes from package.json. The description, author, homepage,
// repository and keywords come from the template. Fields that only one client
// reads (for example `userConfig` in the Claude Code manifest) are left as
// they are in the file. Output is byte-stable: two-space indent, fixed key
// order and a trailing newline, so a second run changes nothing.
//
// Usage:
//   node contrib/gen-agent-manifests.js           // write the manifests
//   node contrib/gen-agent-manifests.js --check   // exit 1 and name the files that differ
//
// Exit codes:
//   0 — manifests written, or all up to date with --check
//   1 — --check found files that differ from the generated output
//   2 — internal error

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TEMPLATE = path.join(
  REPO_ROOT,
  "contrib",
  "agent-manifests.template.json",
);
export const AGENT_PLUGINS_SCHEMA_URL =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const PLUGIN_NAME = "cdxgen";

const readJson = (file) => JSON.parse(readFileSync(file, "utf-8"));

// Put the keys in `order` first, then any other keys in their existing order.
function withOrder(order, values, existing = {}) {
  const result = {};
  for (const key of order) {
    if (values[key] !== undefined) {
      result[key] = values[key];
    }
  }
  for (const [key, value] of Object.entries(existing)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }
  return result;
}

const readExisting = (file) => (existsSync(file) ? readJson(file) : {});

const PLUGIN_FIELDS = [
  "name",
  "description",
  "version",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
];

// Each target names the file it owns and builds its content from the shared
// fields and whatever is already in the file.
const TARGETS = [
  {
    file: "agent-plugin/.claude-plugin/plugin.json",
    build: (shared, existing) =>
      withOrder(PLUGIN_FIELDS, { name: PLUGIN_NAME, ...shared }, existing),
  },
  {
    // The Agent Plugins schema is closed, so nothing but the schema fields
    // is written.
    file: "agent-plugin/plugin.json",
    build: (shared) =>
      withOrder(["$schema", ...PLUGIN_FIELDS], {
        $schema: AGENT_PLUGINS_SCHEMA_URL,
        name: PLUGIN_NAME,
        ...shared,
      }),
  },
  {
    file: ".claude-plugin/marketplace.json",
    build: (shared, existing) => {
      const marketplace = structuredClone(existing);
      const entry = marketplace.plugins?.find((p) => p.name === PLUGIN_NAME);
      if (!entry) {
        throw new Error(
          `.claude-plugin/marketplace.json has no "${PLUGIN_NAME}" plugin`,
        );
      }
      // Assigning keeps each key where it already is in the entry.
      for (const key of ["description", "license", "homepage", "repository"]) {
        entry[key] = shared[key];
      }
      return marketplace;
    },
  },
];

function sharedFields() {
  const pkg = readJson(path.join(REPO_ROOT, "package.json"));
  const template = readJson(TEMPLATE);
  return {
    version: pkg.version,
    description: template.description,
    author: template.author,
    homepage: template.homepage,
    repository: template.repository,
    license: pkg.license,
    keywords: template.keywords,
  };
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Render every manifest and compare it with what is on disk.
 *
 * @returns {{file: string, content: string, current: string|undefined}[]}
 */
export function renderAll() {
  const shared = sharedFields();
  return TARGETS.map((target) => {
    const abs = path.join(REPO_ROOT, target.file);
    const content = serialize(target.build(shared, readExisting(abs)));
    const current = existsSync(abs) ? readFileSync(abs, "utf-8") : undefined;
    return { file: target.file, content, current };
  });
}

/**
 * @returns {string[]} The manifests whose committed content differs from the generated output.
 */
export function staleManifests() {
  return renderAll()
    .filter(({ content, current }) => content !== current)
    .map(({ file }) => file);
}

function main() {
  if (process.argv.includes("--check")) {
    const stale = staleManifests();
    if (stale.length) {
      console.error(
        "These manifests differ from the generated output; run `node contrib/gen-agent-manifests.js`:",
      );
      for (const file of stale) {
        console.error(`  ${file}`);
      }
      process.exitCode = 1;
    } else {
      console.log("Agent manifests are up to date.");
    }
    return;
  }
  for (const { file, content, current } of renderAll()) {
    if (content !== current) {
      writeFileSync(path.join(REPO_ROOT, file), content);
      console.log(`wrote ${file}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exitCode = 2;
  }
}
