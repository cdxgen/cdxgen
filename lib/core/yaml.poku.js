import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import { MAX_ALIAS_NODES, parse, parseAllDocuments } from "./yaml.js";

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
    const docs = parseAllDocuments(`${TAGGED}\n---\nb: 2\n`);
    assert.strictEqual(docs.length, 2);
    const values = [];
    const warnings = await collectWarnings(() => {
      for (const doc of docs) {
        assert.strictEqual(doc.errors.length, 0);
        values.push(doc.toJS());
      }
    });
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(values[1], { b: 2 });
  });

  it("rejects a collection used as a mapping key without rendering it", () => {
    const nested = `x: ${"{".repeat(500)}${"}".repeat(500)}\n`;
    assert.throws(() => parse(nested), { code: "NON_STRING_KEY" });
    assert.throws(() => parse("? [a, b]\n: 1\n"), {
      code: "NON_STRING_KEY",
    });
    const [doc] = parseAllDocuments(nested);
    assert.ok(doc.errors.some((error) => error.code === "NON_STRING_KEY"));
    assert.strictEqual(doc.toJS(), null);
  });

  it("keeps the aliases of an ordinary document and bounds their number", () => {
    const defaults = "base: &base {a: 1}\njobs:\n  one: *base\n  two: *base\n";
    assert.deepStrictEqual(parse(defaults).jobs, {
      one: { a: 1 },
      two: { a: 1 },
    });
    const many = (count) =>
      `e: &e []\nl: [${Array(count).fill("*e").join(", ")}]\n`;
    assert.strictEqual(parse(many(MAX_ALIAS_NODES)).l.length, MAX_ALIAS_NODES);
    assert.throws(() => parse(many(MAX_ALIAS_NODES + 1)), /aliases/);
    const [doc] = parseAllDocuments(many(MAX_ALIAS_NODES + 1));
    assert.ok(doc.errors.length > 0);
    assert.strictEqual(doc.toJS(), null);
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
