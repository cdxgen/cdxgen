import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { parse, parseAllDocuments } from "./yaml.js";

// Lines the yaml package would quote in a warning about the unknown tag.
const TAGGED = [
  "trigger: [main]",
  "variables:",
  "  feed: !x https://ci-bot:hunter2@pkgs.example.com/npm/",
  "  tools:",
  "##vso[task.prependpath]/tmp/evil",
  '    !x "a"',
  '  status: !x "\x1b[1A\x1b[2Kdone\x1b[0m"',
].join("\n");

async function collectWarnings(fn) {
  const warnings = [];
  const listener = (w) => warnings.push(w);
  process.on("warning", listener);
  try {
    fn();
    // process.emitWarning() delivers on a later tick.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", listener);
  }
  return warnings;
}

describe("yaml wrappers", () => {
  it("parse() emits no warning for unresolved tags", async () => {
    let parsed;
    const warnings = await collectWarnings(() => {
      parsed = parse(TAGGED);
    });
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(parsed.trigger, ["main"]);
    assert.strictEqual(
      parsed.variables.feed,
      "https://ci-bot:hunter2@pkgs.example.com/npm/",
    );
  });

  it("parse() still throws on a syntax error", () => {
    assert.throws(() => parse("a: [1, 2"));
  });

  it("parse() keeps the caller's other options", () => {
    assert.throws(() => parse("a: 1\na: 2", { uniqueKeys: true }));
    assert.deepStrictEqual(parse("a: 1\na: 2", { uniqueKeys: false }), {
      a: 2,
    });
  });

  it("documents from parseAllDocuments() stay quiet in toJS()", async () => {
    const docs = parseAllDocuments(
      `${TAGGED}\n---\n? [secret, hunter2]\n: 1\n`,
    );
    assert.strictEqual(docs.length, 2);
    const values = [];
    const warnings = await collectWarnings(() => {
      for (const doc of docs) {
        assert.strictEqual(doc.errors.length, 0);
        values.push(doc.toJS());
      }
    });
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(values[1], { "[ secret, hunter2 ]": 1 });
  });

  it("is the only module under bin and lib that imports yaml", () => {
    const repoRoot = join(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "..",
    );
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "third-party") {
            walk(full);
          }
          continue;
        }
        if (!entry.name.endsWith(".js") || entry.name.endsWith(".poku.js")) {
          continue;
        }
        const rel = relative(repoRoot, full).split("\\").join("/");
        if (rel === "lib/core/yaml.js") {
          continue;
        }
        if (/from\s+["']yaml["']/.test(readFileSync(full, "utf-8"))) {
          offenders.push(rel);
        }
      }
    };
    walk(join(repoRoot, "bin"));
    walk(join(repoRoot, "lib"));
    assert.deepStrictEqual(offenders, []);
  });
});
