import { readFileSync } from "node:fs";

import { tryBuildPurl } from "../inventory/purl.js";

/**
 * Zig `build.zig.zon` parser.
 *
 * `build.zig.zon` is ZON — Zig Object Notation — and it is not JSON. It uses
 * unquoted `.field = value` syntax, `.{}` anonymous struct literals, tuples
 * (positional struct fields), multiline string literals, character literals,
 * hex/underscore-separated numbers, and enum literals (`.foo`). A naive
 * `JSON.parse` with fixups cannot read it, so this module ships a real
 * tokenizer and recursive-descent parser.
 *
 * The grammar implemented here is the subset that appears in `build.zig.zon`:
 * anonymous struct literals, tuples, string literals (with the full Zig escape
 * set), multiline string literals, numbers, character literals, booleans,
 * `null`, enum literals, and `//` line comments — ZON is Zig syntax, and the
 * manifest `zig init` generates is largely comments.
 */

/**
 * Parse a Zig `build.zig.zon` file and return a package list and parent
 * component describing the project and its dependencies.
 *
 * Zig dependencies are content-addressed rather than versioned by tag, so a
 * fetched dependency's identity comes from its `.hash`. Two encodings are in
 * use: the pre-0.14 hex multihash, where a `1220` prefix denotes SHA-2-256
 * (codec `0x12`, 32-byte length `0x20`), and the 0.14+ form
 * `<name>-<version>-<base64 digest>`, which carries the dependency's declared
 * version. The multihash digest is emitted as a CycloneDX `hashes[]` entry
 * when the codec is recognised; the raw hash string is always kept as a
 * property so nothing is lost for encodings that cannot be decoded.
 *
 * `zig` is not a registered purl type, so dependencies use `pkg:generic/...`
 * with a `cdx:purl:proposedType=zig` property and a `download_url` qualifier
 * built from the `url`.
 *
 * @param {string} zonFile Path to `build.zig.zon`
 * @param {string} [sourceLabel] Path or label used in `internal:SrcFile`
 *   evidence. When omitted, `zonFile` is used. A manifest read from outside
 *   the scan root needs a label, so that its host path stays out of the BOM.
 * @returns {{ pkgList: object[], parentComponent: object }} parsed packages
 */
export function parseBuildZigZon(zonFile, sourceLabel = zonFile) {
  let content;
  try {
    content = readFileSync(zonFile, "utf-8");
  } catch (error) {
    console.warn(`Failed to read ${zonFile}: ${error.message}`);
    return { pkgList: [], parentComponent: {} };
  }
  return parseBuildZigZonContent(content, sourceLabel);
}

/**
 * Parse ZON content (already read from a file or extracted from an archive)
 * into a package list and parent component.
 *
 * The content-based entry point lets the resolver parse manifests read from
 * `.tar.gz` cache archives without writing them to a temp file.
 *
 * @param {string} content Raw ZON source
 * @param {string} [sourceLabel] Path or label used in `internal:SrcFile`
 *   evidence. When omitted, `"<zon-content>"` is used.
 * @returns {{ pkgList: object[], parentComponent: object }} parsed packages
 */
export function parseBuildZigZonContent(
  content,
  sourceLabel = "<zon-content>",
) {
  const pkgList = [];
  let parentComponent = {};

  let root;
  try {
    root = parseZon(content);
  } catch (error) {
    console.warn(`Failed to parse ZON content: ${error.message}`);
    return { pkgList, parentComponent };
  }

  if (!root || typeof root !== "object") {
    return { pkgList, parentComponent };
  }

  const name = typeof root.name === "string" ? root.name : undefined;
  const version = typeof root.version === "string" ? root.version : undefined;
  if (name) {
    parentComponent = {
      type: "application",
      name,
      ...(version ? { version } : {}),
      description: `Zig project: ${name}`,
      properties: [
        { name: "internal:SrcFile", value: sourceLabel },
        ...(version ? [{ name: "cdx:zig:version", value: version }] : []),
      ],
    };
    if (root.minimum_zig_version) {
      parentComponent.properties.push({
        name: "cdx:zig:minimum_zig_version",
        value: `${root.minimum_zig_version}`,
      });
    }
    if (root.fingerprint) {
      parentComponent.properties.push({
        name: "cdx:zig:fingerprint",
        value: `${root.fingerprint}`,
      });
    }
  }

  const dependencies = root.dependencies;
  if (
    dependencies &&
    typeof dependencies === "object" &&
    !Array.isArray(dependencies)
  ) {
    for (const [depName, depData] of Object.entries(dependencies)) {
      // Skip the parser's internal positional-tuple bucket.
      if (depName === "_positional") continue;
      if (!depData || typeof depData !== "object") continue;
      const pkg = buildZigPackage(depName, depData, sourceLabel);
      if (pkg) {
        pkgList.push(pkg);
      }
    }
  }

  return { pkgList, parentComponent };
}

/**
 * Build a component-like package record for a single Zig dependency.
 *
 * A dependency is either fetched (carries `.url` and `.hash`) or local
 * (carries `.path`). Both are scoped `required` — a path dependency is a build
 * input the package cannot be built without. Its local nature is recorded in
 * `cdx:zig:local` and `cdx:zig:path` instead, and it carries no `download_url`
 * because there is nothing to fetch.
 *
 * @param {string} depName Dependency name
 * @param {object} depData Parsed dependency struct
 * @param {string} zonFile Source file path for evidence
 * @returns {object|null} Package record, or null when the entry is unusable
 */
function buildZigPackage(depName, depData, zonFile) {
  const url = typeof depData.url === "string" ? depData.url : undefined;
  const hash = typeof depData.hash === "string" ? depData.hash : undefined;
  const depPath = typeof depData.path === "string" ? depData.path : undefined;
  const isLocal = !!depPath && !url;
  const isLazy = depData.lazy === true;

  const version = zigDepVersion(url, hash);
  const properties = [
    { name: "internal:SrcFile", value: zonFile },
    { name: "cdx:purl:proposedType", value: "zig" },
  ];
  if (url) {
    properties.push({ name: "cdx:zig:url", value: url });
  }
  if (depPath) {
    properties.push({ name: "cdx:zig:path", value: depPath });
  }
  if (hash) {
    properties.push({ name: "cdx:zig:hash", value: hash });
  }
  if (isLocal) {
    properties.push({ name: "cdx:zig:local", value: "true" });
  }
  if (isLazy) {
    properties.push({ name: "cdx:zig:lazy", value: "true" });
  }

  const qualifiers = {};
  if (url) {
    qualifiers.download_url = url;
  }

  const purl = tryBuildPurl({
    type: "generic",
    name: depName,
    version: version || undefined,
    qualifiers: Object.keys(qualifiers).length ? qualifiers : undefined,
  });

  const pkg = {
    name: depName,
    ...(version ? { version } : {}),
    type: "library",
    scope: isLazy ? "optional" : "required",
    properties,
    evidence: {
      identity: {
        field: "purl",
        confidence: 1.0,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1.0,
            value: zonFile,
          },
        ],
      },
    },
  };

  if (purl) {
    pkg.purl = purl;
    pkg["bom-ref"] = decodeURIComponent(purl);
  } else {
    pkg["bom-ref"] = `library:${depName}:${version || ""}`;
  }

  // A `.path` dependency is a directory, not a published artefact: it has no
  // url and no hash, so every local dependency of a given name would otherwise
  // share the versionless ref `pkg:generic/<name>`. Two sibling manifests each
  // declaring a `local_lib` would then collide on bom-ref and silently merge
  // their edges. The normalised relative path is what distinguishes them, so
  // it keys the ref while the purl stays a plain package identity.
  if (isLocal) {
    pkg["bom-ref"] = `library:${depName}:${normalizeZigPath(depPath)}`;
  }

  // Decode the multihash only when the codec is unambiguously SHA-2-256.
  // A mislabelled hashes.alg is worse than an absent hash, because downstream
  // tools verify fetched artefacts against it.
  const decoded = decodeZigHash(hash);
  if (decoded) {
    pkg.hashes = [{ alg: decoded.alg, content: decoded.content }];
  }

  return pkg;
}

/**
 * Normalise a `.path` dependency's relative path into a stable key.
 *
 * `./libs/local`, `libs/local` and `libs/local/` all name the same directory,
 * so they collapse to one form. Backslashes fold to forward slashes so a
 * manifest written on Windows keys the same as one written on POSIX.
 *
 * @param {string} depPath Raw `.path` value from the manifest
 * @returns {string} Normalised relative path
 */
function normalizeZigPath(depPath) {
  const segments = [];
  for (const segment of depPath.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === ".." && segments.length && segments.at(-1) !== "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/") || ".";
}

/**
 * Derive a version string for a Zig dependency from its URL or hash.
 *
 * Zig dependencies have no explicit version field; identity is the content
 * hash. When the URL points at a version tag we extract it so the purl is
 * readable; otherwise the short hash is the stable, content-addressed version.
 *
 * @param {string|undefined} url Fetch URL
 * @param {string|undefined} hash Multihash string
 * @returns {string|undefined} A version string, or undefined when neither is present
 */
function zigDepVersion(url, hash) {
  if (url) {
    const tagVersion = extractTagVersion(url);
    if (tagVersion) {
      return tagVersion;
    }
  }
  if (hash) {
    const packaged = parsePackageHash(hash);
    if (packaged?.version) {
      return packaged.version;
    }
    const decoded = decodeZigHash(hash);
    if (decoded) {
      return decoded.content.substring(0, 12);
    }
  }
  return undefined;
}

/**
 * Split a Zig 0.14+ package hash into its parts.
 *
 * Since 0.14 the `.hash` field is `<name>-<version>-<digest>`, where the
 * digest is base64 rather than the older `1220…` hex multihash. The version is
 * the dependency's own declared version, which is a better identifier than any
 * digest prefix, so it is preferred when present.
 *
 * @param {string|undefined} hash Hash field value
 * @returns {{name: string, version: string, digest: string}|null} parts, or null
 */
function parsePackageHash(hash) {
  if (typeof hash !== "string") {
    return null;
  }
  const match = hash.match(
    /^([A-Za-z_][A-Za-z0-9_]*)-(\d[^-]*)-([A-Za-z0-9_-]+)$/,
  );
  if (!match) {
    return null;
  }
  return { name: match[1], version: match[2], digest: match[3] };
}

/**
 * Extract a version-like token from a Zig fetch URL's tag segment.
 *
 * Recognises GitHub/GitLab archive URLs of the form
 * `.../archive/<refs/tags/>X.Y.Z.tar.gz` and bare trailing tag archives. Only
 * returns a value when the final segment looks like a version, so commit-hash
 * archives are left for the hash fallback.
 *
 * @param {string} url Fetch URL
 * @returns {string|undefined} Version token, or undefined
 */
function extractTagVersion(url) {
  const cleaned = url.split("?")[0].replace(/\.tar\.gz$|\.zip$|\.tgz$/i, "");
  const segments = cleaned.split("/");
  const last = segments[segments.length - 1];
  // Accept dotted version-ish tokens (0.14.0, v1.2.3, 2024.1). Reject pure
  // hex commit hashes, which the hash fallback handles.
  if (/^v?\d+(\.\d+)+/.test(last)) {
    return last.startsWith("v") ? last.slice(1) : last;
  }
  return undefined;
}

/**
 * Decode a Zig multihash string into an algorithm and digest.
 *
 * Zig's `.hash` is a multihash: the first byte is the hash codec and the
 * second is the digest length. Only `0x12` (SHA-2-256) with a 32-byte digest
 * is decoded, because that is what Zig emits and it maps to a CycloneDX
 * algorithm downstream tools can verify against.
 *
 * @param {string|undefined} hash Multihash hex string
 * @returns {{alg: string, content: string}|null} decoded hash, or null
 */
function decodeZigHash(hash) {
  if (!hash || typeof hash !== "string") {
    return null;
  }
  // Hex digits only; Zig hashes sometimes include the multihash bytes verbatim.
  const hex = hash.toLowerCase();
  if (hex.length < 4) {
    return null;
  }
  const codec = hex.substring(0, 2);
  const lengthByte = hex.substring(2, 4);
  if (codec === "12" && lengthByte === "20") {
    // 0x12 = sha2-256, 0x20 = 32 bytes (64 hex chars)
    const digest = hex.substring(4, 68);
    if (digest.length === 64) {
      return { alg: "SHA-256", content: digest };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ZON tokenizer
// ---------------------------------------------------------------------------

const SINGLE_CHAR_TOKENS = new Set(["{", "}", "[", "]", "(", ")", ",", "="]);

/**
 * Tokenize a ZON source string.
 *
 * The tokenizer is intentionally separate from the parser so each literal form
 * (string escapes, multiline strings, hex numbers, char literals) is handled
 * in one place and can be unit-tested in isolation.
 *
 * @param {string} src ZON source
 * @returns {Array<{type: string, value: *}>} tokens
 * @throws {Error} when the source contains a character that cannot begin a token
 */
export function tokenizeZon(src) {
  const tokens = [];
  let i = 0;
  const len = src.length;

  const isIdentStart = (c) => /[A-Za-z_]/.test(c);
  const isIdentPart = (c) => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c) => c >= "0" && c <= "9";

  while (i < len) {
    const c = src[i];

    // Whitespace
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }

    // Line comment. ZON is Zig syntax, so `//` runs to the end of the line.
    // The manifest `zig init` generates is mostly comments, which makes this
    // the common case rather than an edge case. Zig has no block comments.
    if (c === "/" && src[i + 1] === "/") {
      while (i < len && src[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Anonymous struct literal ".{"
    if (c === "." && src[i + 1] === "{") {
      tokens.push({ type: "STRUCT_START", value: ".{" });
      i += 2;
      continue;
    }

    // Field access / enum literal ".identifier" or ".@"quoted id""
    if (c === ".") {
      i++;
      if (src[i] === "@" && src[i + 1] === '"') {
        const str = readString(src, i + 1);
        tokens.push({ type: "DOT_IDENT", value: str.value });
        i = str.end;
      } else if (isIdentStart(src[i])) {
        let name = "";
        while (i < len && isIdentPart(src[i])) {
          name += src[i];
          i++;
        }
        tokens.push({ type: "DOT_IDENT", value: name });
      } else {
        throw new Error(`Unexpected "." at position ${i}`);
      }
      continue;
    }

    // Single-line string literal
    if (c === '"') {
      const str = readString(src, i);
      tokens.push({ type: "STRING", value: str.value });
      i = str.end;
      continue;
    }

    // Multiline string literal: lines beginning with "\\"
    if (c === "\\" && src[i + 1] === "\\") {
      const ml = readMultilineString(src, i);
      tokens.push({ type: "STRING", value: ml.value });
      i = ml.end;
      continue;
    }

    // Character / unicode code point literal
    if (c === "'") {
      const ch = readCharLiteral(src, i);
      tokens.push({ type: "STRING", value: ch.value });
      i = ch.end;
      continue;
    }

    // Number literal (integer or float, decimal or hex, with underscores)
    if (isDigit(c) || (c === "-" && isDigit(src[i + 1]))) {
      const num = readNumber(src, i);
      tokens.push({ type: "NUMBER", value: num.value });
      i = num.end;
      continue;
    }

    // Identifier / keyword
    if (isIdentStart(c)) {
      let name = "";
      while (i < len && isIdentPart(src[i])) {
        name += src[i];
        i++;
      }
      if (name === "true") {
        tokens.push({ type: "BOOL", value: true });
      } else if (name === "false") {
        tokens.push({ type: "BOOL", value: false });
      } else if (name === "null") {
        tokens.push({ type: "NULL", value: null });
      } else {
        // Other identifiers (e.g. "undefined") are passed through as plain
        // identifier tokens; the parser treats them as opaque values.
        tokens.push({ type: "IDENT", value: name });
      }
      continue;
    }

    // Built-in-style "@identifier" — treat the whole token as an identifier so
    // unusual manifests do not crash the parser, even though build.zig.zon
    // does not normally contain them.
    if (c === "@") {
      let name = "@";
      i++;
      while (i < len && isIdentPart(src[i])) {
        name += src[i];
        i++;
      }
      tokens.push({ type: "IDENT", value: name });
      continue;
    }

    if (SINGLE_CHAR_TOKENS.has(c)) {
      tokens.push({ type: c, value: c });
      i++;
      continue;
    }

    throw new Error(`Unexpected character "${c}" at position ${i}`);
  }

  return tokens;
}

/**
 * Read a double-quoted string literal starting at `start` (the opening quote),
 * applying Zig's escape sequences.
 *
 * @param {string} src Source
 * @param {number} start Index of the opening `"`
 * @returns {{value: string, end: number}} decoded string and index after the closing quote
 */
function readString(src, start) {
  let i = start + 1;
  let out = "";
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      return { value: out, end: i + 1 };
    }
    if (c === "\\") {
      i++;
      const esc = src[i];
      if (esc === "n") {
        out += "\n";
      } else if (esc === "r") {
        out += "\r";
      } else if (esc === "t") {
        out += "\t";
      } else if (esc === "\\") {
        out += "\\";
      } else if (esc === "'") {
        out += "'";
      } else if (esc === '"') {
        out += '"';
      } else if (esc === "x") {
        out += String.fromCharCode(
          Number.parseInt(src.substring(i + 1, i + 3), 16),
        );
        i += 2;
      } else if (esc === "u") {
        if (src[i + 1] !== "{") {
          throw new Error("Expected '{' after \\u");
        }
        const close = src.indexOf("}", i + 2);
        if (close === -1) {
          throw new Error("Unterminated \\u{...} escape");
        }
        const codePoint = Number.parseInt(src.substring(i + 2, close), 16);
        out += String.fromCodePoint(codePoint);
        i = close;
      } else {
        out += esc;
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  throw new Error("Unterminated string literal");
}

/**
 * Read a Zig multiline string literal. Each line beginning with `\\`
 * contributes its remainder; a newline separates consecutive `\\` lines.
 *
 * @param {string} src Source
 * @param {number} start Index of the first backslash
 * @returns {{value: string, end: number}} concatenated string and index past the last line
 */
function readMultilineString(src, start) {
  let i = start;
  const lines = [];
  while (i < src.length && src[i] === "\\" && src[i + 1] === "\\") {
    // Move past the two backslashes.
    i += 2;
    // Read to end of line.
    let lineEnd = src.indexOf("\n", i);
    if (lineEnd === -1) {
      lineEnd = src.length;
    }
    let line = src.substring(i, lineEnd);
    // Trim a trailing CR so CRLF files behave like LF ones.
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    lines.push(line);
    // Advance past the newline.
    i = lineEnd + 1 === src.length ? src.length : lineEnd + 1;
    // Skip blank lines between continuation markers? Zig requires the next
    // line to also begin with `\\` to continue; intervening whitespace-only
    // lines terminate the literal, so we do not skip here.
  }
  return { value: lines.join("\n"), end: i };
}

/**
 * Read a character literal `'…'`, returning its string value with escapes
 * applied. A char literal may encode a single byte or a unicode code point.
 *
 * @param {string} src Source
 * @param {number} start Index of the opening `'`
 * @returns {{value: string, end: number}} decoded character and index after the closing quote
 */
function readCharLiteral(src, start) {
  let i = start + 1;
  let value = "";
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      return { value, end: i + 1 };
    }
    if (c === "\\") {
      i++;
      const esc = src[i];
      if (esc === "n") {
        value += "\n";
      } else if (esc === "r") {
        value += "\r";
      } else if (esc === "t") {
        value += "\t";
      } else if (esc === "\\") {
        value += "\\";
      } else if (esc === "'") {
        value += "'";
      } else if (esc === '"') {
        value += '"';
      } else if (esc === "x") {
        value += String.fromCharCode(
          Number.parseInt(src.substring(i + 1, i + 3), 16),
        );
        i += 2;
      } else if (esc === "u") {
        if (src[i + 1] !== "{") {
          throw new Error("Expected '{' after \\u");
        }
        const close = src.indexOf("}", i + 2);
        if (close === -1) {
          throw new Error("Unterminated \\u{...} escape");
        }
        const codePoint = Number.parseInt(src.substring(i + 2, close), 16);
        value += String.fromCodePoint(codePoint);
        i = close;
      } else {
        value += esc;
      }
      i++;
    } else {
      value += c;
      i++;
    }
  }
  throw new Error("Unterminated character literal");
}

/**
 * Read a numeric literal: decimal integer, hex integer (`0x…`), or float, all
 * optionally containing `_` separators and a leading sign. The raw digits are
 * returned as a string so callers decide whether to treat them as a number.
 *
 * @param {string} src Source
 * @param {number} start Index of the first digit (or sign)
 * @returns {{value: string, end: number}} normalised number string and end index
 */
function readNumber(src, start) {
  let i = start;
  if (src[i] === "-") {
    i++;
  }
  if (src[i] === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
    i += 2;
    let digits = "";
    while (i < src.length && /[0-9a-fA-F_]/.test(src[i])) {
      digits += src[i];
      i++;
    }
    return {
      value: `${src[start] === "-" ? "-" : ""}0x${digits.replace(/_/g, "")}`,
      end: i,
    };
  }
  let digits = "";
  while (i < src.length && /[0-9_]/.test(src[i])) {
    digits += src[i];
    i++;
  }
  if (src[i] === "." && /[0-9]/.test(src[i + 1])) {
    digits += ".";
    i++;
    while (i < src.length && /[0-9_]/.test(src[i])) {
      digits += src[i];
      i++;
    }
  }
  // Exponent (e.g. 1e10).
  if (src[i] === "e" || src[i] === "E") {
    digits += src[i];
    i++;
    if (src[i] === "+" || src[i] === "-") {
      digits += src[i];
      i++;
    }
    while (i < src.length && /[0-9_]/.test(src[i])) {
      digits += src[i];
      i++;
    }
  }
  return {
    value: `${src[start] === "-" ? "-" : ""}${digits.replace(/_/g, "")}`,
    end: i,
  };
}

// ---------------------------------------------------------------------------
// ZON recursive-descent parser
// ---------------------------------------------------------------------------

/**
 * Parse a ZON source string into a JavaScript value.
 *
 * Structs become plain objects keyed by field name; tuple (positional) values
 * are collected under a `_positional` array. Enum literals (`.foo`) become the
 * bare identifier string.
 *
 * @param {string} src ZON source
 * @returns {*} parsed value
 */
export function parseZon(src) {
  const tokens = tokenizeZon(src);
  const parser = new ZonParser(tokens);
  const result = parser.parseValue();
  parser.expectEnd();
  return result;
}

/**
 * Recursive-descent parser over a token stream. Kept as a class so the parse
 * position is shared across the mutually recursive value/array/struct rules.
 */
class ZonParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  expect(type) {
    const tok = this.next();
    if (!tok || tok.type !== type) {
      throw new Error(
        `Expected ${type} but got ${tok ? tok.type : "end of input"}`,
      );
    }
    return tok;
  }

  expectEnd() {
    if (this.pos < this.tokens.length) {
      const tok = this.peek();
      throw new Error(`Unexpected trailing token ${tok.type}`);
    }
  }

  parseValue() {
    const tok = this.peek();
    if (!tok) {
      throw new Error("Unexpected end of input");
    }
    switch (tok.type) {
      case "STRUCT_START":
        return this.parseStruct();
      case "[":
        return this.parseArray();
      case "(": {
        // Parenthesised expression: unwrap to the inner value.
        this.next();
        const inner = this.parseValue();
        this.expect(")");
        return inner;
      }
      case "STRING":
        this.next();
        return tok.value;
      case "NUMBER":
        this.next();
        return tok.value;
      case "BOOL":
        this.next();
        return tok.value;
      case "NULL":
        this.next();
        return null;
      case "IDENT":
        // "undefined" and other bare identifiers pass through as strings.
        this.next();
        return tok.value;
      case "DOT_IDENT":
        // Enum literal `.foo` → bare identifier string.
        this.next();
        return tok.value;
      default:
        throw new Error(`Unexpected token ${tok.type}`);
    }
  }

  parseArray() {
    this.expect("[");
    const items = [];
    while (this.peek() && this.peek().type !== "]") {
      items.push(this.parseValue());
      if (this.peek() && this.peek().type === ",") {
        this.next();
      } else {
        break;
      }
    }
    this.expect("]");
    return items;
  }

  parseStruct() {
    this.expect("STRUCT_START");
    const result = { _positional: [] };
    while (this.peek() && this.peek().type !== "}") {
      const tok = this.peek();
      if (tok.type === "DOT_IDENT") {
        // Named field: .name = value
        this.next();
        this.expect("=");
        result[tok.value] = this.parseValue();
      } else {
        // Positional (tuple) element.
        result._positional.push(this.parseValue());
      }
      if (this.peek() && this.peek().type === ",") {
        this.next();
      } else {
        break;
      }
    }
    this.expect("}");
    return result;
  }
}
