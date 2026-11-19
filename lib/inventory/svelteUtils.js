// Svelte single-file component segmentation and SvelteKit framework facts.
//
// A `.svelte` file keeps its module specifiers in exactly two places: the
// `<script>` / `<script module>` blocks and the `@use` / `@import` / `url()`
// rules of its `<style>` blocks — the markup contributes none. That lets this
// module recover every piece of import evidence that scope assignment depends
// on without requiring `svelte/compiler`:
//
//   * `maskSvelteScripts` builds a position-preserving buffer of just the
//     script bodies, so the regular Babel parse (tier 1) sees absolute
//     offsets and true line numbers.
//   * When the optional `@appthreat/atom-parsetools` package is installed,
//     its `parseSvelteFile` additionally parses the template into JSX nodes
//     (tier 2). The handle below is feature-detected, never version-compared,
//     and silently falls back to tier 1 when absent.
//
// Block discovery is done by scanning for tag boundaries with a small
// attribute tokenizer rather than one large backtracking regex.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { thoughtLog } from "../core/logger.js";
import {
  isPackageStyleUrlReference,
  STYLE_PACKAGE_REFERENCE_PATTERNS,
} from "./stylePackageRefs.js";

const isTagWhitespace = (ch) =>
  ch === " " ||
  ch === "\t" ||
  ch === "\n" ||
  ch === "\r" ||
  ch === "\f" ||
  ch === "\v";

const blankRegion = (source, start, end) =>
  source.slice(start, end).replace(/[^\r\n]/g, " ");

/**
 * Locate every `<tagName ...> ... </tagName>` block in the source.
 *
 * The scanner matches the opening tag case-insensitively, tokenizes its
 * attributes (quoted values may safely contain `>` and `/`), honours
 * self-closing tags, and treats an unterminated block as extending to the
 * end of the file so the leading statements of a truncated component are
 * still recoverable.
 *
 * @param {string} source Document to scan.
 * @param {string} tagName Lowercase tag name such as "script" or "style".
 * @returns {Array<{start: number, contentStart: number, contentEnd: number, end: number, selfClosing: boolean, attributes: Object<string, string|true>}>}
 */
const scanTagBlocks = (source, tagName) => {
  const blocks = [];
  const lowerSource = source.toLowerCase();
  const openNeedle = `<${tagName}`;
  const closeNeedle = `</${tagName}`;
  let cursor = 0;
  while (cursor < source.length) {
    const openIndex = lowerSource.indexOf(openNeedle, cursor);
    if (openIndex === -1) {
      break;
    }
    const afterName = openIndex + openNeedle.length;
    const nextChar = source[afterName];
    if (
      nextChar !== undefined &&
      nextChar !== ">" &&
      nextChar !== "/" &&
      !isTagWhitespace(nextChar)
    ) {
      // `<scripted>` is a different tag; keep scanning after its name.
      cursor = afterName;
      continue;
    }
    const attributes = {};
    let selfClosing = false;
    let openTagEnd = -1;
    let index = afterName;
    while (index < source.length) {
      const ch = source[index];
      if (isTagWhitespace(ch)) {
        index += 1;
        continue;
      }
      if (ch === ">") {
        openTagEnd = index + 1;
        break;
      }
      if (ch === "/") {
        if (source[index + 1] === ">") {
          selfClosing = true;
          openTagEnd = index + 2;
          break;
        }
        index += 1;
        continue;
      }
      let nameEnd = index;
      while (nameEnd < source.length) {
        const nameChar = source[nameEnd];
        if (
          isTagWhitespace(nameChar) ||
          nameChar === "=" ||
          nameChar === ">" ||
          nameChar === "/"
        ) {
          break;
        }
        nameEnd += 1;
      }
      const attributeName = source.slice(index, nameEnd).toLowerCase();
      index = nameEnd;
      while (index < source.length && isTagWhitespace(source[index])) {
        index += 1;
      }
      if (source[index] !== "=") {
        if (attributeName) {
          attributes[attributeName] = true;
        }
        continue;
      }
      index += 1;
      while (index < source.length && isTagWhitespace(source[index])) {
        index += 1;
      }
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        const valueEnd = source.indexOf(quote, index + 1);
        if (valueEnd === -1) {
          if (attributeName) {
            attributes[attributeName] = source.slice(index + 1);
          }
          index = source.length;
        } else {
          if (attributeName) {
            attributes[attributeName] = source.slice(index + 1, valueEnd);
          }
          index = valueEnd + 1;
        }
      } else {
        let valueEnd = index;
        while (valueEnd < source.length) {
          const valueChar = source[valueEnd];
          if (isTagWhitespace(valueChar) || valueChar === ">") {
            break;
          }
          valueEnd += 1;
        }
        if (attributeName) {
          attributes[attributeName] = source.slice(index, valueEnd);
        }
        index = valueEnd;
      }
    }
    if (openTagEnd === -1) {
      // The opening tag itself never terminates; nothing is recoverable here.
      cursor = source.length;
      break;
    }
    if (selfClosing) {
      blocks.push({
        attributes,
        contentEnd: openTagEnd,
        contentStart: openTagEnd,
        end: openTagEnd,
        selfClosing,
        start: openIndex,
      });
      cursor = openTagEnd;
      continue;
    }
    let closeIndex = lowerSource.indexOf(closeNeedle, openTagEnd);
    while (
      closeIndex !== -1 &&
      source[closeIndex + closeNeedle.length] !== undefined &&
      source[closeIndex + closeNeedle.length] !== ">" &&
      !isTagWhitespace(source[closeIndex + closeNeedle.length])
    ) {
      closeIndex = lowerSource.indexOf(closeNeedle, closeIndex + 1);
    }
    if (closeIndex === -1) {
      blocks.push({
        attributes,
        contentEnd: source.length,
        contentStart: openTagEnd,
        end: source.length,
        selfClosing,
        start: openIndex,
      });
      cursor = source.length;
      continue;
    }
    let closeTagEnd = source.indexOf(">", closeIndex);
    closeTagEnd = closeTagEnd === -1 ? source.length : closeTagEnd + 1;
    blocks.push({
      attributes,
      contentEnd: closeIndex,
      contentStart: openTagEnd,
      end: closeTagEnd,
      selfClosing,
      start: openIndex,
    });
    cursor = closeTagEnd;
  }
  return blocks;
};

/**
 * Build a same-length masked buffer of a `.svelte` source where every byte
 * outside the `<script>` / `<script module>` / `<script context="module">`
 * bodies is replaced by a space (newlines preserved). Because nothing moves,
 * the Babel parse of the buffer yields statement offsets and `loc.line`
 * values that are true to the original file.
 *
 * Handles multiple script blocks, arbitrary attribute order, self-closing and
 * unterminated tags, CRLF input, and a script block appearing after the
 * markup.
 *
 * @param {string} source `.svelte` file content.
 * @returns {string} Same-length buffer containing only the script bodies.
 */
export const maskSvelteScripts = (source) => {
  const input = String(source || "");
  const blocks = scanTagBlocks(input, "script");
  let masked = "";
  let cursor = 0;
  for (const block of blocks) {
    if (block.contentStart > cursor) {
      masked += blankRegion(input, cursor, block.contentStart);
    }
    masked += input.slice(block.contentStart, block.contentEnd);
    cursor = block.contentEnd;
  }
  if (cursor < input.length) {
    masked += blankRegion(input, cursor, input.length);
  }
  return masked;
};

/**
 * The `lang` attribute values of the `<script>` blocks, lowercased.
 *
 * @param {string} source `.svelte` file content.
 * @returns {string[]}
 */
export const extractSvelteScriptLanguages = (source) =>
  scanTagBlocks(String(source || ""), "script")
    .map((block) => block.attributes.lang)
    .filter((lang) => typeof lang === "string" && lang)
    .map((lang) => lang.toLowerCase());

// URL-scheme-like references (e.g. the built-in `sass:math` module) and
// relative paths are not npm package references.
const styleReferenceSchemeRegex = /^[a-z][a-z0-9+.-]*:/i;

const isRelativeStyleReference = (reference) =>
  reference.startsWith("./") ||
  reference.startsWith("../") ||
  reference.startsWith("/");

const isPackageStyleReference = (reference) =>
  !styleReferenceSchemeRegex.test(reference) &&
  !isRelativeStyleReference(reference);

/**
 * Collect `<style>` block facts: the block's `lang` and the package
 * references found in its `@use` / `@import` / `@forward` / `url()` rules.
 * Reference offsets are absolute indices into the original source so callers
 * can derive line numbers.
 *
 * @param {string} source `.svelte` file content.
 * @returns {Array<{lang: string|undefined, start: number, references: Array<{reference: string, index: number}>}>}
 */
export const extractSvelteStyleReferences = (source) => {
  const input = String(source || "");
  const blocks = scanTagBlocks(input, "style");
  const results = [];
  for (const block of blocks) {
    const content = input.slice(block.contentStart, block.contentEnd);
    const references = [];
    for (const referencePattern of STYLE_PACKAGE_REFERENCE_PATTERNS) {
      referencePattern.lastIndex = 0;
      for (const match of content.matchAll(referencePattern)) {
        const reference = match[1];
        if (!reference || !isPackageStyleReference(reference)) {
          continue;
        }
        if (
          match[0]?.trim().startsWith("url") &&
          !isPackageStyleUrlReference(reference)
        ) {
          continue;
        }
        references.push({
          index: block.contentStart + (match.index || 0),
          reference,
        });
      }
    }
    const lang = block.attributes.lang;
    results.push({
      lang: typeof lang === "string" ? lang.toLowerCase() : undefined,
      references,
      start: block.start,
    });
  }
  return results;
};

/** Rune names that imply the `svelte` package even without an import. */
export const SVELTE_RUNE_NAMES = [
  "state",
  "derived",
  "effect",
  "props",
  "bindable",
  "inspect",
  "host",
];

// `(?=[(.<])` covers call form, member form (`$state.raw(...)`,
// `$effect.pre(...)`), and typed form (`$state<string[]>(...)`).
const runePatterns = SVELTE_RUNE_NAMES.map((name) => ({
  name,
  pattern: new RegExp(`\\$${name}(?=[(.<])`, "g"),
}));

/**
 * Find Svelte 5 rune usages (`$state`, `$derived`, `$effect`, ...). A
 * rune-only component may never `import` from `svelte`, yet it cannot compile
 * without the compiler, so rune usage is `svelte` evidence.
 *
 * @param {string} source `.svelte` content (script blocks scanned) or the
 *   full text of a `.svelte.js` / `.svelte.ts` module (pass
 *   `scriptBlocksOnly = false`).
 * @param {boolean} [scriptBlocksOnly=true] Scan only `<script>` block bodies.
 * @returns {Array<{rune: string, index: number}>} Absolute rune offsets.
 */
export const findSvelteRunes = (source, scriptBlocksOnly = true) => {
  const input = String(source || "");
  const regions = scriptBlocksOnly
    ? scanTagBlocks(input, "script")
    : [{ contentEnd: input.length, contentStart: 0 }];
  const runes = [];
  for (const region of regions) {
    const content = input.slice(region.contentStart, region.contentEnd);
    for (const runePattern of runePatterns) {
      runePattern.pattern.lastIndex = 0;
      for (const match of content.matchAll(runePattern.pattern)) {
        runes.push({
          index: region.contentStart + (match.index || 0),
          rune: `$${runePattern.name}`,
        });
      }
    }
  }
  return runes;
};

/** SvelteKit virtual module prefixes that resolve inside `@sveltejs/kit`. */
export const SVELTE_KIT_VIRTUAL_MODULE_PREFIXES = [
  "$app",
  "$env",
  "$service-worker",
];

/**
 * True for import specifiers provided by SvelteKit itself (`$app/stores`,
 * `$env/static/public`, `$service-worker`, ...).
 *
 * @param {string} specifier Import specifier.
 * @returns {boolean}
 */
export const isSvelteKitVirtualModuleSpecifier = (specifier) =>
  SVELTE_KIT_VIRTUAL_MODULE_PREFIXES.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
  );

/** The default SvelteKit `$lib` alias target. */
export const SVELTE_DEFAULT_LIB_ALIAS = "src/lib";

/**
 * Return the text between the first match of `opener` and the next `closer`.
 *
 * The opener is searched for once and the closer with a single `indexOf`, so
 * a source that repeats the opener without ever closing it is still read in
 * one pass. When the first opener is not closed, no later one is either.
 *
 * @param {string} input Source to search.
 * @param {RegExp} opener Pattern matching up to and including the opening bracket.
 * @param {string} closer Closing bracket.
 * @returns {string|undefined} The enclosed text, or undefined when either end is missing.
 */
const sliceBracketedRegion = (input, opener, closer) => {
  const openerMatch = opener.exec(input);
  if (!openerMatch) {
    return undefined;
  }
  const regionStart = openerMatch.index + openerMatch[0].length;
  const regionEnd = input.indexOf(closer, regionStart);
  return regionEnd === -1 ? undefined : input.slice(regionStart, regionEnd);
};

/**
 * Extract framework facts from a `svelte.config.*` source: the adapter named
 * in string form (`adapter: "netlify"`), the `kit.alias` entries, and the
 * `extensions` list. Adapter and preprocessor *imports* are collected by the
 * regular config-file parse once `svelte.config.*` stops being ignored; the
 * string adapter form has no import to recover, so it is extracted here.
 *
 * @param {string} source `svelte.config.*` file content.
 * @returns {{adapterName: string|undefined, aliases: Object<string, string>, extensions: string[]}}
 */
export const parseSvelteConfigSource = (source) => {
  const input = String(source || "");
  const facts = { adapterName: undefined, aliases: {}, extensions: [] };
  const adapterMatch = input.match(/\badapter\s*:\s*['"]([^'"]+)['"]/);
  if (adapterMatch) {
    facts.adapterName = adapterMatch[1];
  }
  const aliasRegion = sliceBracketedRegion(input, /\balias\s*:\s*\{/, "}");
  if (aliasRegion) {
    // A bare key may only start where an identifier starts. Without the
    // lookbehind a long identifier with no colon after it is retried from
    // each of its characters, which takes time quadratic in its length.
    for (const entryMatch of aliasRegion.matchAll(
      /(?:'([^']+)'|"([^"]+)"|(?<![$\w])([$\w]+))\s*:\s*['"]([^'"]+)['"]/g,
    )) {
      const aliasKey = entryMatch[1] ?? entryMatch[2] ?? entryMatch[3];
      if (aliasKey && entryMatch[4]) {
        facts.aliases[aliasKey] = entryMatch[4];
      }
    }
  }
  const extensionsRegion = sliceBracketedRegion(
    input,
    /\bextensions\s*:\s*\[/,
    "]",
  );
  if (extensionsRegion) {
    for (const extensionMatch of extensionsRegion.matchAll(
      /['"]([^'"]+)['"]/g,
    )) {
      if (extensionMatch[1]) {
        facts.extensions.push(extensionMatch[1]);
      }
    }
  }
  return facts;
};

/** `<style lang>` values that require a CSS preprocessor package. */
export const SVELTE_STYLE_LANG_PACKAGES = {
  less: "less",
  postcss: "postcss",
  sass: "sass",
  scss: "sass",
  stylus: "stylus",
};

/**
 * Executable names appearing in Svelte project npm scripts and the npm
 * packages that provide them. Used by the shared script-evidence walk so a
 * `svelte-kit sync` script marks `@sveltejs/kit` required on its own
 * evidence.
 */
export const SVELTE_SCRIPT_EXECUTABLE_PACKAGE_MAP = {
  "svelte-kit": "@sveltejs/kit",
  "svelte-check": "svelte-check",
  "svelte-package": "@sveltejs/package",
  vite: "vite",
  vitest: "vitest",
  playwright: "@playwright/test",
};

// ---------------------------------------------------------------------------
// Optional template parser (tier 2)
// ---------------------------------------------------------------------------

const SVELTE_TEMPLATE_PARSER_SPECIFIER =
  "@appthreat/atom-parsetools/svelteAst.js";

/**
 * Module-scoped handle for the optional Svelte template parser.
 * `undefined` = not attempted yet, `null` = unavailable, object = loaded.
 * Each worker thread resolves its own instance.
 */
let svelteTemplateParserHandle;

const acceptSvelteTemplateParser = (loadedModule) =>
  typeof loadedModule?.parseSvelteFile === "function" ? loadedModule : null;

/**
 * Synchronously resolve and load the optional template parser. `require()` of
 * an ESM file is synchronous on Node >= 22.12 whenever the module has no
 * top-level await, which `svelteAst.js` does not. This is the only priming
 * path available inside worker threads, where the parse runs synchronously.
 *
 * @returns {Object|null} The module namespace, or null when unavailable.
 */
const resolveSvelteTemplateParserSync = () => {
  try {
    const require = createRequire(import.meta.url);
    const modulePath = require.resolve(SVELTE_TEMPLATE_PARSER_SPECIFIER);
    return acceptSvelteTemplateParser(require(modulePath));
  } catch {
    return null;
  }
};

/**
 * Prime the module-scoped template-parser handle with a dynamic import,
 * which works on every supported runtime. Called before the parse fan-out so
 * the inline (small-project) path can use tier 2 on the main thread. Any
 * failure is silent at default verbosity: the optional package is absent
 * from the plain cdxgen binaries, and tier 1 already recovers all scope
 * evidence.
 *
 * @returns {Promise<Object|null>} The module namespace, or null when unavailable.
 */
export const primeSvelteParser = async () => {
  if (svelteTemplateParserHandle !== undefined) {
    return svelteTemplateParserHandle;
  }
  try {
    const require = createRequire(import.meta.url);
    const modulePath = require.resolve(SVELTE_TEMPLATE_PARSER_SPECIFIER);
    const loadedModule = await import(pathToFileURL(modulePath).href);
    svelteTemplateParserHandle = acceptSvelteTemplateParser(loadedModule);
  } catch {
    svelteTemplateParserHandle = null;
  }
  if (!svelteTemplateParserHandle) {
    thoughtLog(
      "Svelte template parser unavailable; using built-in script segmentation.",
    );
  }
  return svelteTemplateParserHandle;
};

/**
 * Synchronous accessor for the parse path: returns the primed handle, lazily
 * resolving it once when called before `primeSvelteParser`.
 *
 * @returns {Object|null} The module namespace, or null when unavailable.
 */
export const getSvelteTemplateParser = () => {
  if (svelteTemplateParserHandle === undefined) {
    svelteTemplateParserHandle = resolveSvelteTemplateParserSync();
  }
  return svelteTemplateParserHandle;
};
