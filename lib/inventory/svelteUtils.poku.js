import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "poku";

import {
  extractSvelteScriptLanguages,
  extractSvelteStyleReferences,
  findSvelteRunes,
  getSvelteTemplateParser,
  isSvelteKitVirtualModuleSpecifier,
  maskSvelteScripts,
  parseSvelteConfigSource,
  primeSvelteParser,
  SVELTE_KIT_VIRTUAL_MODULE_PREFIXES,
} from "./svelteUtils.js";

const fixturePath = (relativePath) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

const countNewlines = (value) => (value.match(/\n/g) || []).length;

describe("maskSvelteScripts()", () => {
  it("keeps script bodies at their original offsets and length", () => {
    const source = [
      "<script>",
      'import dayjs from "dayjs";',
      "let name = $state('x');",
      "</script>",
      "",
      "<h1>hello {name}</h1>",
      "{#if name}",
      "  <p>{dayjs().format()}</p>",
      "{/if}",
    ].join("\n");
    const masked = maskSvelteScripts(source);
    assert.strictEqual(masked.length, source.length);
    assert.strictEqual(countNewlines(masked), countNewlines(source));
    // Script bytes survive verbatim.
    assert.ok(masked.includes('import dayjs from "dayjs";'));
    // Markup is blanked, not removed.
    assert.ok(!masked.includes("<h1>"));
    assert.ok(!masked.includes("{#if"));
    // Offsets are preserved: masked and source agree byte for byte inside
    // the script body.
    assert.strictEqual(
      masked.indexOf('import dayjs from "dayjs";'),
      source.indexOf('import dayjs from "dayjs";'),
    );
  });

  it("handles a script block appearing after the markup", () => {
    const source = [
      "<p>lead</p>",
      "",
      "<script>",
      'import { nanoid } from "nanoid";',
      "</script>",
    ].join("\n");
    const masked = maskSvelteScripts(source);
    assert.strictEqual(masked.length, source.length);
    assert.ok(masked.includes('import { nanoid } from "nanoid";'));
    assert.ok(!masked.includes("<p>lead</p>"));
  });

  it("handles multiple script blocks including module scripts", () => {
    const source = [
      '<script module lang="ts">',
      "export const prerender = true;",
      "</script>",
      "",
      "<script>",
      'import { page } from "$app/stores";',
      "</script>",
      "",
      "<slot />",
    ].join("\n");
    const masked = maskSvelteScripts(source);
    assert.strictEqual(masked.length, source.length);
    assert.ok(masked.includes("export const prerender = true;"));
    assert.ok(masked.includes('import { page } from "$app/stores";'));
    assert.ok(!masked.includes("<slot />"));
    assert.ok(!masked.includes("<script"));
  });

  it("handles context module scripts with arbitrary attribute order", () => {
    const source = [
      '<script lang="ts" context="module">',
      "export const value = 1;",
      "</script>",
      "<p>{value}</p>",
    ].join("\n");
    const masked = maskSvelteScripts(source);
    assert.strictEqual(masked.length, source.length);
    assert.ok(masked.includes("export const value = 1;"));
  });

  it("preserves CRLF line endings", () => {
    const source =
      '<h1>a</h1>\r\n<script lang="ts">\r\nimport x from "zod";\r\n</script>\r\n<p>b</p>';
    const masked = maskSvelteScripts(source);
    assert.strictEqual(masked.length, source.length);
    assert.strictEqual(
      (masked.match(/\r\n/g) || []).length,
      (source.match(/\r\n/g) || []).length,
    );
    assert.ok(masked.includes('import x from "zod";'));
    assert.ok(!masked.includes("<h1>"));
  });

  it("treats self-closing script tags as empty blocks", () => {
    const source = '<script src="x.js" />\nimport b from "zod";';
    const masked = maskSvelteScripts(source);
    assert.strictEqual(masked.length, source.length);
    assert.ok(!masked.includes("import b"));
    assert.ok(!masked.includes("<script"));
  });

  it("keeps the leading statements of an unterminated script block", () => {
    const source = 'markup\n<script>\nimport a from "dayjs";\n<div>{a}</div>';
    const masked = maskSvelteScripts(source);
    assert.strictEqual(masked.length, source.length);
    assert.ok(masked.includes('import a from "dayjs";'));
  });

  it("returns a blank same-length buffer for markup-only components", () => {
    const source = "<h1>hello</h1>\n<p>world</p>";
    const masked = maskSvelteScripts(source);
    assert.strictEqual(masked.length, source.length);
    assert.strictEqual(masked.trim(), "");
  });

  it("does not treat lookalike tags as script blocks", () => {
    const source = '<scripted attr="1">nope</scripted>\n<p>x</p>';
    const masked = maskSvelteScripts(source);
    assert.strictEqual(masked.trim(), "");
  });

  it("returns safe output for malformed input", () => {
    assert.strictEqual(maskSvelteScripts(""), "");
    assert.strictEqual(maskSvelteScripts(undefined).length, 0);
    const broken = "<script><script>";
    const maskedBroken = maskSvelteScripts(broken);
    assert.strictEqual(maskedBroken.length, broken.length);
  });

  it("handles a quoted attribute value containing '>' and '/'", () => {
    const source = [
      '<script data-note="a > b / c">',
      'import x from "zod";',
      "</script>",
    ].join("\n");
    const masked = maskSvelteScripts(source);
    assert.ok(masked.includes('import x from "zod";'));
    assert.strictEqual(masked.length, source.length);
  });
});

describe("extractSvelteScriptLanguages()", () => {
  it("collects lowercased lang values across script blocks", () => {
    const source = [
      '<script module lang="TS">',
      "export const a = 1;",
      "</script>",
      '<script lang="ts">',
      "let b = $state(0);",
      "</script>",
      "<script>",
      "let c = 1;",
      "</script>",
    ].join("\n");
    assert.deepStrictEqual(extractSvelteScriptLanguages(source), ["ts", "ts"]);
  });

  it("returns an empty array when no lang attribute is present", () => {
    assert.deepStrictEqual(
      extractSvelteScriptLanguages("<script>let a = 1;</script>"),
      [],
    );
  });
});

describe("extractSvelteStyleReferences()", () => {
  it("extracts the style lang and @use package references with offsets", () => {
    const source = [
      "<script>",
      'import dayjs from "dayjs";',
      "</script>",
      "",
      '<style lang="scss">',
      '  @use "bulma/sass/utilities" as utils;',
      "  .row {",
      "    color: utils.$primary;",
      "  }",
      "</style>",
    ].join("\n");
    const blocks = extractSvelteStyleReferences(source);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].lang, "scss");
    assert.strictEqual(blocks[0].references.length, 1);
    assert.strictEqual(
      blocks[0].references[0].reference,
      "bulma/sass/utilities",
    );
    // The absolute index points at the @use rule: line 5 (1-based), so the
    // reference is on the 6th line.
    assert.strictEqual(
      source.slice(blocks[0].references[0].index).startsWith("@use"),
      true,
    );
  });

  it("ignores url() references that are not package-like and relative imports", () => {
    const source = [
      "<style>",
      "  .a {",
      '    background: url("./local.png");',
      "  }",
      '  @use "sass:math";',
      '  @import "./partial.scss";',
      "</style>",
    ].join("\n");
    const blocks = extractSvelteStyleReferences(source);
    // sass:math is a built-in module, ./partial.scss is local: neither is a
    // package reference, and the url() guard filters the local asset.
    assert.deepStrictEqual(blocks[0].references, []);
  });

  it("keeps package-like url() references", () => {
    const source = '<style>.a { background: url("~bulma/img.png"); }</style>';
    const blocks = extractSvelteStyleReferences(source);
    assert.strictEqual(blocks[0].references.length, 1);
    assert.strictEqual(blocks[0].references[0].reference, "~bulma/img.png");
  });

  it("returns an empty array for components without style blocks", () => {
    assert.deepStrictEqual(extractSvelteStyleReferences("<p>x</p>"), []);
  });
});

describe("findSvelteRunes()", () => {
  it("finds runes in script blocks only by default", () => {
    const source = [
      "<script>",
      "let count = $state(0);",
      "let doubled = $derived(count * 2);",
      "$effect(() => console.log(count));",
      "</script>",
      "",
      "<p>{$state}</p>",
    ].join("\n");
    const runes = findSvelteRunes(source);
    assert.deepStrictEqual(runes.map((rune) => rune.rune).sort(), [
      "$derived",
      "$effect",
      "$state",
    ]);
    // Offsets point inside the script block.
    for (const rune of runes) {
      assert.ok(source.slice(rune.index).startsWith(rune.rune));
    }
  });

  it("detects typed and member rune forms", () => {
    const source = [
      '<script lang="ts">',
      "let items = $state<string[]>([]);",
      "let raw = $state.raw(0);",
      "let { initial } = $props();",
      "</script>",
    ].join("\n");
    const runes = findSvelteRunes(source).map((rune) => rune.rune);
    assert.ok(runes.includes("$state"));
    assert.ok(runes.includes("$props"));
  });

  it("scans the whole file when scriptBlocksOnly is false", () => {
    const moduleSource = [
      "export function createCounter(initial = 0) {",
      "  let count = $state(initial);",
      "  return { count };",
      "}",
    ].join("\n");
    const runes = findSvelteRunes(moduleSource, false);
    assert.strictEqual(runes.length, 1);
    assert.strictEqual(runes[0].rune, "$state");
    // Script-block scanning finds nothing in a plain module.
    assert.deepStrictEqual(findSvelteRunes(moduleSource, true), []);
  });

  it("does not match identifiers that only start like a rune", () => {
    const source = "<script>let stateHistory = 1; let $stateful = 2;</script>";
    assert.deepStrictEqual(findSvelteRunes(source), []);
  });
});

describe("parseSvelteConfigSource()", () => {
  it("extracts the string-form adapter, aliases, and extensions", () => {
    const source = [
      'import adapter from "@sveltejs/adapter-auto";',
      "/** @type {import('@sveltejs/kit').Config} */",
      "const config = {",
      "  kit: {",
      '    adapter: "netlify",',
      "    alias: {",
      "      $lib: 'src/lib',",
      "      '$components': 'src/components',",
      "    },",
      "  },",
      "  extensions: ['.svelte', '.svx'],",
      "};",
      "export default config;",
    ].join("\n");
    const facts = parseSvelteConfigSource(source);
    assert.strictEqual(facts.adapterName, "netlify");
    assert.strictEqual(facts.aliases.$lib, "src/lib");
    assert.strictEqual(facts.aliases.$components, "src/components");
    assert.deepStrictEqual(facts.extensions, [".svelte", ".svx"]);
  });

  it("returns empty facts for sources without kit configuration", () => {
    const facts = parseSvelteConfigSource("export default {};");
    assert.strictEqual(facts.adapterName, undefined);
    assert.deepStrictEqual(facts.aliases, {});
    assert.deepStrictEqual(facts.extensions, []);
  });

  it("reads each region up to the first closing delimiter", () => {
    const facts = parseSvelteConfigSource(
      "alias: { $a: 'src/a', b: resolve({}), $c: 'src/c' }, extensions: ['.svelte', ...(md ? ['.md'] : [])]",
    );
    assert.deepStrictEqual(facts.aliases, { $a: "src/a" });
    assert.deepStrictEqual(facts.extensions, [".svelte", ".md"]);
  });

  it("reads alias keys as whole identifiers and skips keys without a value", () => {
    const facts = parseSvelteConfigSource(
      "export default { kit: { alias: { shorthand, $lib_2: './src/lib', \"@ui\": 'src/ui' 'src/x' } } };",
    );
    assert.deepStrictEqual(facts.aliases, {
      $lib_2: "./src/lib",
      "@ui": "src/ui",
    });
  });

  it("reads the first alias and extensions blocks and ignores unclosed ones", () => {
    const facts = parseSvelteConfigSource(
      "alias: { a: 'one' }, alias: { b: 'two' }, extensions: ['.svelte'], extensions: ['.svx']",
    );
    assert.deepStrictEqual(facts.aliases, { a: "one" });
    assert.deepStrictEqual(facts.extensions, [".svelte"]);
    const unclosed = parseSvelteConfigSource(
      "alias: { a: 'one', extensions: ['.svelte'",
    );
    assert.deepStrictEqual(unclosed.aliases, {});
    assert.deepStrictEqual(unclosed.extensions, []);
  });

  it("parses crafted configs in time proportional to their size", () => {
    // A pattern whose work grows with the square of its input needs seconds
    // for each of these, and a linear one milliseconds, so the bound leaves
    // room for slow runners.
    const inputs = {
      "an alias key without a value": `export default { kit: { alias: {${"a".repeat(60000)}} } };`,
      "alias blocks that never close": "alias:{".repeat(30000),
      "extension lists that never close": "extensions:[".repeat(30000),
    };
    for (const [shape, source] of Object.entries(inputs)) {
      const started = performance.now();
      const facts = parseSvelteConfigSource(source);
      const elapsed = performance.now() - started;
      assert.deepStrictEqual(facts.aliases, {});
      assert.deepStrictEqual(facts.extensions, []);
      assert.ok(
        elapsed < 1500,
        `${shape} (${source.length} bytes) took ${Math.round(elapsed)} ms`,
      );
    }
  });
});

describe("SvelteKit virtual module helpers", () => {
  it("classifies virtual module specifiers", () => {
    for (const specifier of [
      "$app/stores",
      "$app/navigation",
      "$app/environment",
      "$env/static/public",
      "$env/dynamic/private",
      "$service-worker",
    ]) {
      assert.ok(
        isSvelteKitVirtualModuleSpecifier(specifier),
        `${specifier} should be virtual`,
      );
    }
    assert.strictEqual(
      isSvelteKitVirtualModuleSpecifier("$lib/Chart.svelte"),
      false,
    );
    assert.strictEqual(isSvelteKitVirtualModuleSpecifier("svelte"), false);
    assert.deepStrictEqual(SVELTE_KIT_VIRTUAL_MODULE_PREFIXES, [
      "$app",
      "$env",
      "$service-worker",
    ]);
  });
});

describe("optional template parser handle", () => {
  it("primeSvelteParser() resolves to a handle or null without throwing", async () => {
    const handle = await primeSvelteParser();
    // In the development environment the optional package is installed, so
    // the handle is an object exposing parseSvelteFile; in slim installs it
    // is null. Both are acceptable — the accessor must agree either way.
    if (handle) {
      assert.strictEqual(typeof handle.parseSvelteFile, "function");
    } else {
      assert.strictEqual(handle, null);
    }
    assert.strictEqual(getSvelteTemplateParser(), handle);
  });
});

describe("committed fixture sources", () => {
  it("masks the svelte-repotest page component without moving offsets", () => {
    const source = readFileSync(
      fixturePath("../../test/data/svelte-repotest/src/routes/+page.svelte"),
      "utf-8",
    );
    const masked = maskSvelteScripts(source);
    assert.strictEqual(masked.length, source.length);
    assert.strictEqual(countNewlines(masked), countNewlines(source));
    assert.ok(masked.includes('import dayjs from "dayjs";'));
    assert.ok(masked.includes("$state<string[]>"));
    assert.ok(!masked.includes("{#each"));
    assert.ok(!masked.includes("{@html"));
  });

  it("extracts the scss style reference from the svelte-repotest page", () => {
    const source = readFileSync(
      fixturePath("../../test/data/svelte-repotest/src/routes/+page.svelte"),
      "utf-8",
    );
    const blocks = extractSvelteStyleReferences(source);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].lang, "scss");
    assert.deepStrictEqual(
      blocks[0].references.map((reference) => reference.reference),
      ["bulma/sass/utilities"],
    );
  });

  it("finds runes in the rune-only store module", () => {
    const source = readFileSync(
      fixturePath("../../test/data/svelte-precision/store.svelte.ts"),
      "utf-8",
    );
    const runes = findSvelteRunes(source, false).map((rune) => rune.rune);
    assert.ok(runes.includes("$state"));
  });
});
