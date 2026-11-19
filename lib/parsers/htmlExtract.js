// Reads two fields out of a pkg.go.dev page: the licence heading and the
// repository link.
//
// This is deliberately not a general HTML parser or CSS selector engine. It
// locates a container element by tag plus class or id, honours nesting by
// counting open and close tags of that name, and reads one field out of the
// matching slice. Two fields is the entire requirement; a general engine would
// be a maintenance liability with no second caller.
//
// The input is a third-party web page, so every entry point degrades to "" or
// undefined on malformed or truncated input and never throws. Returning
// nothing is always preferable to returning text borrowed from a neighbouring
// element: a wrong licence lands in a BOM and is indistinguishable from a
// correct one.

// HTML void elements never have a closing tag and must not affect nesting depth.
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// Named entities that realistically occur in SPDX licence names and repository
// URLs. Unknown sequences are left untouched rather than guessed.
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  trade: "\u2122",
};

/**
 * Decode named (`&amp;`) and numeric (`&#39;` / `&#x27;`) HTML entities.
 * Unrecognised sequences are returned verbatim so licence text is never mangled.
 *
 * @param {string} str Text that may contain entity references.
 * @returns {string} Decoded text.
 */
export function decodeEntities(str) {
  if (typeof str !== "string" || !str.includes("&")) {
    return str;
  }
  let out = "";
  let i = 0;
  while (i < str.length) {
    const amp = str.indexOf("&", i);
    if (amp < 0) {
      out += str.slice(i);
      break;
    }
    out += str.slice(i, amp);
    // No reference is longer than 32 characters, so only that window is
    // searched: an unbounded indexOf rescans the rest of the input for every
    // bare "&", which is quadratic on a run of them.
    const offset = str.slice(amp + 1, amp + 33).indexOf(";");
    if (offset < 0) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const semi = amp + 1 + offset;
    const body = str.slice(amp + 1, semi);
    if (body.length === 0) {
      out += "&";
      i = amp + 1;
      continue;
    }
    if (body[0] === "#") {
      let code;
      if (body[1] === "x" || body[1] === "X") {
        code =
          body.length > 2 ? Number.parseInt(body.slice(2), 16) : Number.NaN;
      } else {
        code = Number.parseInt(body.slice(1), 10);
      }
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) {
        out += str.slice(amp, semi + 1);
      } else {
        try {
          out += String.fromCodePoint(code);
        } catch {
          out += str.slice(amp, semi + 1);
        }
      }
    } else {
      const decoded = NAMED_ENTITIES[body];
      out += decoded !== undefined ? decoded : str.slice(amp, semi + 1);
    }
    i = semi + 1;
  }
  return out;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);

/**
 * Find the index of the `>` that closes the tag starting at `lt`, honouring
 * quotes so an attribute value containing `>` does not truncate the scan.
 *
 * @param {string} html Source text.
 * @param {number} lt Index of the opening `<`.
 * @returns {number} Index of the closing `>`, or -1 when truncated.
 */
function findTagEnd(html, lt) {
  let i = lt + 1;
  let quote = null;
  while (i < html.length) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
    i++;
  }
  return -1;
}

const NAME_CHARS = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_:",
);

/**
 * Parse a raw tag (including the surrounding `<...>`) into its structural parts.
 *
 * @param {string} raw Tag text such as `<section class="x">` or `</section>`.
 * @returns {{name: string, close: boolean, attrs: Object}|null} Parsed tag, or
 *   null for comments, declarations and anything without a tag name.
 */
function scanTag(raw) {
  if (raw.length < 2 || raw[0] !== "<") {
    return null;
  }
  const body = raw.slice(1, -1);
  if (body.length === 0 || body[0] === "!" || body[0] === "?") {
    return null;
  }
  let close = false;
  let s = body;
  if (s[0] === "/") {
    close = true;
    let k = 1;
    while (k < s.length && WHITESPACE.has(s[k])) {
      k++;
    }
    s = s.slice(k);
  }
  if (s.length === 0) {
    return null;
  }
  let n = 0;
  while (n < s.length && NAME_CHARS.has(s[n])) {
    n++;
  }
  if (n === 0) {
    return null;
  }
  const name = s.slice(0, n).toLowerCase();
  const rest = s.slice(n);
  const attrs = close ? {} : parseAttrs(rest);
  return { name, close, attrs };
}

/**
 * Parse attribute text (the portion after the tag name) into a plain object.
 * Values are entity-decoded, so callers see the attribute as authored.
 *
 * @param {string} str Attribute portion of a tag.
 * @returns {Object} Map of lower-cased attribute name to decoded value.
 */
function parseAttrs(str) {
  const attrs = {};
  let i = 0;
  const n = str.length;
  while (i < n) {
    while (
      i < n &&
      (WHITESPACE.has(str[i]) || str[i] === "/" || str[i] === ",")
    ) {
      i++;
    }
    if (i >= n) {
      break;
    }
    const nameStart = i;
    while (
      i < n &&
      str[i] !== "=" &&
      !WHITESPACE.has(str[i]) &&
      str[i] !== "/" &&
      str[i] !== ">"
    ) {
      i++;
    }
    const name = str.slice(nameStart, i).toLowerCase();
    while (i < n && WHITESPACE.has(str[i])) {
      i++;
    }
    let value = "";
    let hasValue = false;
    if (i < n && str[i] === "=") {
      hasValue = true;
      i++;
      while (i < n && WHITESPACE.has(str[i])) {
        i++;
      }
      if (i < n && (str[i] === '"' || str[i] === "'")) {
        const quote = str[i];
        i++;
        const vStart = i;
        while (i < n && str[i] !== quote) {
          i++;
        }
        value = decodeEntities(str.slice(vStart, i));
        if (i < n) {
          i++;
        }
      } else {
        const vStart = i;
        while (i < n && !WHITESPACE.has(str[i]) && str[i] !== ">") {
          i++;
        }
        value = decodeEntities(str.slice(vStart, i));
      }
    }
    if (name.length > 0) {
      attrs[name] = hasValue ? value : "";
    }
  }
  return attrs;
}

/**
 * Whole-token, whitespace-delimited class match. `class="License Foo"` matches
 * "License"; `class="Licensed"` does not.
 *
 * @param {Object} attrs Parsed attributes.
 * @param {string} className Class token to match.
 * @returns {boolean}
 */
function classMatches(attrs, className) {
  const c = attrs.class;
  if (typeof c !== "string") {
    return false;
  }
  for (let i = 0; i < c.length; ) {
    while (i < c.length && WHITESPACE.has(c[i])) {
      i++;
    }
    const start = i;
    while (i < c.length && !WHITESPACE.has(c[i])) {
      i++;
    }
    if (i > start && c.slice(start, i) === className) {
      return true;
    }
  }
  return false;
}

/**
 * Advance past an HTML comment if one starts at `lt`.
 *
 * @param {string} html Source text.
 * @param {number} lt Candidate `<` index.
 * @returns {number} Index just past the comment, or -1 if `lt` is not a comment.
 */
function skipComment(html, lt) {
  if (!html.startsWith("<!--", lt)) {
    return -1;
  }
  const end = html.indexOf("-->", lt + 4);
  return end < 0 ? html.length : end + 3;
}

/**
 * Find the matching close tag for an element of `tagName` whose content starts
 * at `start`, counting opens/closes of that name so nested same-name elements do
 * not prematurely close the candidate.
 *
 * @param {string} html Source text.
 * @param {number} start Index just after the opening tag.
 * @param {string} tagName Lower-case tag name to match.
 * @returns {{found: boolean, closeStart?: number, closeEnd?: number}}
 */
function findMatchingClose(html, start, tagName) {
  let depth = 1;
  let j = start;
  while (j < html.length && depth > 0) {
    const lt = html.indexOf("<", j);
    if (lt < 0) {
      break;
    }
    const next = skipComment(html, lt);
    if (next >= 0) {
      j = next;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt < 0) {
      break;
    }
    const info = scanTag(html.slice(lt, gt + 1));
    j = gt + 1;
    if (!info || info.name !== tagName) {
      continue;
    }
    if (info.close) {
      depth--;
      if (depth === 0) {
        return { found: true, closeStart: lt, closeEnd: gt + 1 };
      }
    } else if (!VOID_TAGS.has(tagName)) {
      depth++;
    }
  }
  return { found: false };
}

/**
 * Find every top-level element of `tagName` whose attributes satisfy `predicate`,
 * honouring nesting. Each result carries the raw inner HTML between its open and
 * close tags (empty for void/self-closing elements; the remainder of the document
 * when the close tag is missing).
 *
 * @param {string} html Source text.
 * @param {string} tagName Tag to locate (case-insensitive).
 * @param {(attrs: Object) => boolean} predicate Attribute filter.
 * @returns {{inner: string, attrs: Object}[]}
 */
function findElements(html, tagName, predicate) {
  const lower = tagName.toLowerCase();
  const results = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      break;
    }
    const next = skipComment(html, lt);
    if (next >= 0) {
      i = next;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt < 0) {
      break;
    }
    const info = scanTag(html.slice(lt, gt + 1));
    i = gt + 1;
    if (!info || info.close || info.name !== lower) {
      continue;
    }
    if (!predicate(info.attrs)) {
      continue;
    }
    if (VOID_TAGS.has(lower)) {
      results.push({ inner: "", attrs: info.attrs });
      continue;
    }
    const close = findMatchingClose(html, gt + 1, lower);
    if (close.found) {
      results.push({
        inner: html.slice(gt + 1, close.closeStart),
        attrs: info.attrs,
      });
      i = close.closeEnd;
    } else {
      results.push({ inner: html.slice(gt + 1), attrs: info.attrs });
      i = html.length;
    }
  }
  return results;
}

/**
 * Find the first element (of any tag) whose name and attributes satisfy `predicate`.
 *
 * @param {string} html Source text.
 * @param {(el: {name: string, attrs: Object}) => boolean} predicate Filter.
 * @returns {{inner: string, attrs: Object}|null}
 */
function findFirstElement(html, predicate) {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      break;
    }
    const next = skipComment(html, lt);
    if (next >= 0) {
      i = next;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt < 0) {
      break;
    }
    const info = scanTag(html.slice(lt, gt + 1));
    i = gt + 1;
    if (!info || info.close) {
      continue;
    }
    if (!predicate({ name: info.name, attrs: info.attrs })) {
      continue;
    }
    if (VOID_TAGS.has(info.name)) {
      return { inner: "", attrs: info.attrs };
    }
    const close = findMatchingClose(html, gt + 1, info.name);
    if (close.found) {
      return { inner: html.slice(gt + 1, close.closeStart), attrs: info.attrs };
    }
    return { inner: html.slice(gt + 1), attrs: info.attrs };
  }
  return null;
}

/**
 * Find the direct child elements of `childTag` within an element's inner HTML.
 * A child is "direct" only when it sits at relative depth 0; descendants nested
 * inside other elements are skipped, mirroring the `>` combinator.
 *
 * @param {string} inner Inner HTML of the parent element.
 * @param {string} childTag Tag to locate (case-insensitive).
 * @returns {{inner: string, attrs: Object}[]}
 */
function findDirectChildren(inner, childTag) {
  const lower = childTag.toLowerCase();
  const results = [];
  let i = 0;
  let depth = 0;
  while (i < inner.length) {
    const lt = inner.indexOf("<", i);
    if (lt < 0) {
      break;
    }
    const next = skipComment(inner, lt);
    if (next >= 0) {
      i = next;
      continue;
    }
    const gt = findTagEnd(inner, lt);
    if (gt < 0) {
      break;
    }
    const info = scanTag(inner.slice(lt, gt + 1));
    i = gt + 1;
    if (!info) {
      continue;
    }
    if (info.close) {
      if (depth > 0) {
        depth--;
      }
      continue;
    }
    if (depth === 0 && info.name === lower) {
      if (VOID_TAGS.has(lower)) {
        results.push({ inner: "", attrs: info.attrs });
      } else {
        const close = findMatchingClose(inner, gt + 1, lower);
        if (close.found) {
          results.push({
            inner: inner.slice(gt + 1, close.closeStart),
            attrs: info.attrs,
          });
          i = close.closeEnd;
        } else {
          results.push({ inner: inner.slice(gt + 1), attrs: info.attrs });
          i = inner.length;
        }
      }
      continue;
    }
    if (!VOID_TAGS.has(info.name)) {
      depth++;
    }
  }
  return results;
}

/**
 * Concatenate all text within a slice, stripping tags and decoding entities.
 * Whitespace is preserved verbatim; callers trim where appropriate.
 *
 * @param {string} html Source slice.
 * @returns {string}
 */
function textContent(html) {
  if (typeof html !== "string" || html.length === 0) {
    return "";
  }
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += decodeEntities(html.slice(i));
      break;
    }
    if (lt > i) {
      out += decodeEntities(html.slice(i, lt));
    }
    const next = skipComment(html, lt);
    if (next >= 0) {
      i = next;
      continue;
    }
    const gt = findTagEnd(html, lt);
    if (gt < 0) {
      break;
    }
    i = gt + 1;
  }
  return out;
}

/**
 * Extract the licence heading from a pkg.go.dev page.
 *
 * Current markup puts the licence in `<section class="License"><h2>`, and
 * several licences arrive as one comma-separated heading — `Apache-2.0, MIT`
 * for gopkg.in/yaml.v3 — which the caller splits on ", ". Older markup used a
 * container with `id="LICENSE"`; that path is tried first and costs one scan.
 *
 * Should a page ever carry several licence sections, their headings are joined
 * with ", " so they split into separate licences rather than fusing into one
 * nonsense identifier.
 *
 * @param {string} html Raw pkg.go.dev HTML.
 * @returns {string} Trimmed licence text, or "" when nothing matches.
 */
export function extractLicenseText(html) {
  if (typeof html !== "string" || html.length === 0) {
    return "";
  }
  const licenseEl = findFirstElement(html, (el) => el.attrs.id === "LICENSE");
  if (licenseEl) {
    const headings = findDirectChildren(licenseEl.inner, "h2");
    if (headings.length) {
      const text = headings.map((h) => textContent(h.inner)).join("");
      if (text.trim() !== "") {
        return text.trim();
      }
    }
  }
  const sections = findElements(html, "section", (a) =>
    classMatches(a, "License"),
  );
  const headings = [];
  for (const section of sections) {
    for (const heading of findDirectChildren(section.inner, "h2")) {
      const text = textContent(heading.inner).trim();
      if (text !== "") {
        headings.push(text);
      }
    }
  }
  return headings.join(", ");
}

/**
 * Extract the repository URL from a pkg.go.dev page: the decoded `href` of the
 * first direct anchor inside `div.UnitMeta-repo`. Anchors nested deeper in the
 * container are links to other things, so only a direct child counts.
 *
 * @param {string} html Raw pkg.go.dev HTML.
 * @returns {string|undefined}
 */
export function extractRepoUrl(html) {
  if (typeof html !== "string" || html.length === 0) {
    return undefined;
  }
  const container = findFirstElement(
    html,
    (el) => el.name === "div" && classMatches(el.attrs, "UnitMeta-repo"),
  );
  if (!container) {
    return undefined;
  }
  const anchors = findDirectChildren(container.inner, "a");
  if (anchors.length === 0) {
    return undefined;
  }
  return anchors[0].attrs.href;
}
