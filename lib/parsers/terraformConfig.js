/**
 * Pure extractor for the Terraform / OpenTofu configuration files in one
 * directory: `*.tf`, `*.tf.json`, `*.tofu` and `*.tofu.json`.
 *
 * Only three things in a configuration matter for a BOM: the `module` blocks
 * (name, `source`, `version`), the `required_providers` entries inside the
 * `terraform` block, and `required_version`. Full HCL is a much larger
 * grammar, so this module scans characters directly — comments, quoted
 * strings with `${…}`/`%{…}` template sequences, heredocs, and
 * bracket-depth-aware attribute boundaries — and skips everything else with
 * balanced matching. It never throws and always terminates: every loop either
 * consumes input or stops at EOF.
 *
 * An expression counts as a literal only when it is exactly one quoted string
 * without template sequences; module inputs, provider configuration and
 * backend settings are never captured, let alone emitted.
 */

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_-]/;
const HEREDOC_MARKER = /[A-Za-z0-9_]/;

/**
 * Parse one configuration file.
 *
 * @param {string} text File contents
 * @param {Object} [options]
 * @param {boolean} [options.json] Parse as the JSON variant (`.tf.json`)
 * @returns {{ moduleCalls: object[], requiredProviders: object[], requiredVersions: string[], errors: string[] }}
 */
export function parseTerraformConfig(text, { json = false } = {}) {
  if (typeof text !== "string") {
    return {
      moduleCalls: [],
      requiredProviders: [],
      requiredVersions: [],
      errors: ["configuration input is not text"],
    };
  }
  return json ? parseJsonConfig(text) : parseNativeConfig(text);
}

/**
 * Parse native-syntax HCL.
 *
 * @param {string} text File contents
 * @returns {{ moduleCalls: object[], requiredProviders: object[], requiredVersions: string[], errors: string[] }}
 */
function parseNativeConfig(text) {
  const len = text.length;
  const errors = [];
  const moduleCalls = [];
  const requiredProviders = [];
  const requiredVersions = [];
  let i = 0;
  let line = 1;

  const error = (message) => {
    if (errors.length < 100) {
      errors.push(`${message} (line ${line})`);
    }
  };

  const skipSpacesTabs = () => {
    while (
      i < len &&
      (text[i] === " " || text[i] === "\t" || text[i] === "\r")
    ) {
      i++;
    }
  };

  const skipLineComment = () => {
    while (i < len && text[i] !== "\n") {
      i++;
    }
  };

  const skipBlockComment = () => {
    i += 2;
    while (i < len) {
      if (text[i] === "*" && text[i + 1] === "/") {
        i += 2;
        return;
      }
      if (text[i] === "\n") {
        line++;
      }
      i++;
    }
    error("unterminated block comment");
  };

  const skipWhitespace = () => {
    for (;;) {
      if (i >= len) {
        return;
      }
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r") {
        i++;
      } else if (c === "\n") {
        i++;
        line++;
      } else if (c === "#") {
        skipLineComment();
      } else if (c === "/" && text[i + 1] === "/") {
        skipLineComment();
      } else if (c === "/" && text[i + 1] === "*") {
        skipBlockComment();
      } else {
        return;
      }
    }
  };

  const readIdentifier = () => {
    if (i >= len || !IDENTIFIER_START.test(text[i])) {
      return null;
    }
    const start = i;
    i++;
    while (i < len && IDENTIFIER_PART.test(text[i])) {
      i++;
    }
    return text.slice(start, i);
  };

  /** Scan a template `${…}` or `%{…}` sequence, leaving `i` after its `}`. */
  const scanTemplate = () => {
    i += 2;
    let depth = 1;
    while (i < len) {
      const c = text[i];
      if (c === "{") {
        depth++;
        i++;
      } else if (c === "}") {
        depth--;
        i++;
        if (depth === 0) {
          return;
        }
      } else if (c === '"') {
        scanString();
      } else {
        if (c === "\n") {
          line++;
        }
        i++;
      }
    }
    error("unterminated template sequence");
  };

  /** Scan a quoted string at `i`, leaving `i` after the closing quote. */
  const scanString = () => {
    i++;
    const parts = [];
    let literal = true;
    while (i < len) {
      const c = text[i];
      if (c === '"') {
        i++;
        return { value: parts.join(""), literal };
      }
      if (c === "\n") {
        error("unterminated quoted string");
        return { value: parts.join(""), literal: false };
      }
      if (c === "\\") {
        const next = text[i + 1];
        if (next === undefined) {
          i++;
          error("unterminated quoted string");
          return { value: parts.join(""), literal: false };
        }
        i = scanEscape(parts, i);
        continue;
      }
      if (
        (c === "$" || c === "%") &&
        text[i + 1] === c &&
        text[i + 2] === "{"
      ) {
        // `$${` and `%%{` escape the template opener.
        parts.push(`${c}{`);
        i += 3;
        continue;
      }
      if ((c === "$" || c === "%") && text[i + 1] === "{") {
        const start = i;
        scanTemplate();
        parts.push(text.slice(start, i));
        literal = false;
        continue;
      }
      parts.push(c);
      i++;
    }
    error("unterminated quoted string");
    return { value: parts.join(""), literal: false };
  };

  /** Decode one `\x` escape into `parts`; returns the index after it. */
  const scanEscape = (parts, at) => {
    const next = text[at + 1];
    if (next === "n") {
      parts.push("\n");
      return at + 2;
    }
    if (next === "r") {
      parts.push("\r");
      return at + 2;
    }
    if (next === "t") {
      parts.push("\t");
      return at + 2;
    }
    if (next === "\\" || next === '"') {
      parts.push(next);
      return at + 2;
    }
    if (next === "u" || next === "U") {
      const digits = next === "u" ? 4 : 8;
      let value = 0;
      let end = at + 2;
      let count = 0;
      while (end < len && count < digits) {
        const code = text.charCodeAt(end);
        const nibble =
          code >= 48 && code <= 57
            ? code - 48
            : code >= 97 && code <= 102
              ? code - 87
              : code >= 65 && code <= 70
                ? code - 55
                : -1;
        if (nibble < 0) {
          break;
        }
        value = value * 16 + nibble;
        end++;
        count++;
      }
      if (count === digits) {
        // `\UFFFFFFFF` is well-formed hex but no code point; String.fromCodePoint
        // would throw and the whole file would be lost to the outer catch.
        if (value <= 0x10ffff) {
          parts.push(String.fromCodePoint(value));
        } else {
          error("invalid unicode escape");
        }
        return end;
      }
      error("invalid unicode escape");
      return Math.max(end, at + 2);
    }
    // Unknown escape: keep the character as written.
    parts.push(next);
    return at + 2;
  };

  /** Scan a heredoc `<<ID` / `<<-ID` including its body. */
  const scanHeredoc = () => {
    i += 2;
    if (i < len && text[i] === "-") {
      i++;
    }
    const start = i;
    while (i < len && HEREDOC_MARKER.test(text[i])) {
      i++;
    }
    const marker = text.slice(start, i);
    if (!marker) {
      error("heredoc without a marker");
      return;
    }
    skipSpacesTabs();
    if (i >= len) {
      error("unterminated heredoc");
      return;
    }
    if (text[i] !== "\n") {
      // Invalid opener: stop at the end of the line and let the caller
      // decide what the newline ends.
      error("heredoc marker not followed by a newline");
      skipLineComment();
      return;
    }
    i++;
    line++;
    // The body runs to the first line that is the marker alone. The newline
    // after that closing line is left unconsumed: it is the newline that ends
    // the attribute the heredoc belongs to, so a caller scanning an attribute
    // value at bracket depth zero must still see it. Consuming it made the
    // next attribute (a module's `source` or `version` written after a
    // `user_data = <<EOT` heredoc) part of this value, and lost it.
    while (i < len) {
      const lineEnd = text.indexOf("\n", i);
      const stop = lineEnd === -1 ? len : lineEnd;
      const body = text.slice(i, stop);
      if (body.trim() === marker) {
        i = stop;
        return;
      }
      i = lineEnd === -1 ? len : lineEnd + 1;
      if (lineEnd !== -1) {
        line++;
      }
    }
    error("unterminated heredoc");
  };

  const atHeredoc = () =>
    text[i] === "<" &&
    text[i + 1] === "<" &&
    (text[i + 2] === "-" || HEREDOC_MARKER.test(text[i + 2] || ""));

  /** Skip a `{…}` group, aware of strings, heredocs and comments. */
  const skipBraces = () => {
    let depth = 0;
    while (i < len) {
      const c = text[i];
      if (c === "{") {
        depth++;
        i++;
      } else if (c === "}") {
        depth--;
        i++;
        if (depth === 0) {
          return;
        }
      } else if (c === '"') {
        scanString();
      } else if (atHeredoc()) {
        scanHeredoc();
      } else if (c === "#") {
        skipLineComment();
      } else if (c === "/" && text[i + 1] === "/") {
        skipLineComment();
      } else if (c === "/" && text[i + 1] === "*") {
        skipBlockComment();
      } else {
        if (c === "\n") {
          line++;
        }
        i++;
      }
    }
    if (depth > 0) {
      error("unterminated block");
    }
  };

  /**
   * Skip spaces and comments that cannot hide the end of the statement,
   * starting at `at`. Returns the new index and the lines crossed.
   */
  const trailingSpacesAndComments = (at) => {
    let j = at;
    let lines = 0;
    for (;;) {
      while (
        j < len &&
        (text[j] === " " || text[j] === "\t" || text[j] === "\r")
      ) {
        j++;
      }
      if (j < len && text[j] === "#") {
        while (j < len && text[j] !== "\n") {
          j++;
        }
        break;
      }
      if (j < len && text[j] === "/" && text[j + 1] === "/") {
        while (j < len && text[j] !== "\n") {
          j++;
        }
        break;
      }
      if (j < len && text[j] === "/" && text[j + 1] === "*") {
        j += 2;
        let closed = false;
        while (j < len) {
          if (text[j] === "*" && text[j + 1] === "/") {
            j += 2;
            closed = true;
            break;
          }
          if (text[j] === "\n") {
            lines++;
          }
          j++;
        }
        if (!closed) {
          return { at: len, lines, unterminated: true };
        }
        continue;
      }
      break;
    }
    return { at: j, lines, unterminated: false };
  };

  /**
   * Scan one attribute value, stopping at the newline, `}` or comma that ends
   * it (without consuming that character).
   */
  const scanExpression = () => {
    skipWhitespace();
    if (i >= len) {
      error("missing expression");
      return { kind: "other" };
    }
    if (text[i] === '"') {
      const startLine = line;
      const scanned = scanString();
      const rest = trailingSpacesAndComments(i);
      const j = rest.at;
      if (
        rest.unterminated ||
        j >= len ||
        text[j] === "\n" ||
        text[j] === "}" ||
        text[j] === ","
      ) {
        line += rest.lines;
        i = j;
        return {
          kind: "string",
          value: scanned.value,
          literal: scanned.literal,
          line: startLine,
        };
      }
      // Content follows on the same line, so this is a larger expression;
      // keep scanning from just after the string.
    }
    let depth = 0;
    while (i < len) {
      const c = text[i];
      if (c === "\n") {
        if (depth === 0) {
          return { kind: "other" };
        }
        line++;
        i++;
      } else if (c === "(" || c === "[" || c === "{") {
        depth++;
        i++;
      } else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) {
          return { kind: "other" };
        }
        depth--;
        i++;
      } else if (c === '"') {
        scanString();
      } else if (atHeredoc()) {
        scanHeredoc();
      } else if (c === "#") {
        skipLineComment();
      } else if (c === "/" && text[i + 1] === "/") {
        skipLineComment();
      } else if (c === "/" && text[i + 1] === "*") {
        skipBlockComment();
      } else {
        i++;
      }
    }
    return { kind: "other" };
  };

  /** Recovery: move to the end of the current line. */
  const skipToNewline = () => {
    while (i < len && text[i] !== "\n") {
      i++;
    }
  };

  /**
   * Skip the remainder of a statement whose first identifier was consumed:
   * further labels, then either `{…}` or `= expression`.
   */
  const skipRestOfStatement = () => {
    for (;;) {
      skipSpacesTabs();
      if (i >= len) {
        return;
      }
      const c = text[i];
      if (c === '"') {
        scanString();
        continue;
      }
      if (c === "{") {
        skipBraces();
        return;
      }
      if (c === "=") {
        i++;
        scanExpression();
        return;
      }
      if (IDENTIFIER_START.test(c)) {
        readIdentifier();
        continue;
      }
      if (c === "\n") {
        return;
      }
      i++;
      return;
    }
  };

  const parseModuleBlock = (stmtLine) => {
    skipSpacesTabs();
    let name = null;
    if (i < len && text[i] === '"') {
      const label = scanString();
      if (label.literal) {
        name = label.value;
      }
    } else {
      name = readIdentifier();
    }
    if (!name) {
      error("module block without a usable label");
      skipToNewline();
      return;
    }
    skipSpacesTabs();
    if (text[i] !== "{") {
      error("module block without a body");
      skipToNewline();
      return;
    }
    i++;
    // `sourceLiteral`/`versionLiteral` are set only when the attribute was
    // seen, so a merge can tell "absent" from "present but non-literal".
    const call = { name, line: stmtLine };
    for (;;) {
      skipWhitespace();
      if (i >= len) {
        error("unterminated module block");
        break;
      }
      if (text[i] === "}") {
        i++;
        break;
      }
      const attrLine = line;
      const attr = readIdentifier();
      if (!attr) {
        error("unexpected character in module block");
        i++;
        continue;
      }
      skipSpacesTabs();
      if (text[i] === "=") {
        i++;
        const expr = scanExpression();
        if (attr === "source" || attr === "version") {
          const key = attr;
          if (expr.kind === "string") {
            call[`${key}Literal`] = expr.literal;
            call[`${key}Line`] = expr.line ?? attrLine;
            if (expr.literal) {
              call[key] = expr.value;
            } else {
              delete call[key];
            }
          } else if (expr.kind === "other") {
            call[`${key}Literal`] = false;
            call[`${key}Line`] = attrLine;
            delete call[key];
          }
        }
        continue;
      }
      if (text[i] === "{") {
        // Nested blocks never carry the call's own source or version.
        skipBraces();
        continue;
      }
      skipRestOfStatement();
    }
    moduleCalls.push(call);
  };

  const parseProviderObject = (entry) => {
    for (;;) {
      skipWhitespace();
      if (i >= len) {
        error("unterminated provider source object");
        return;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      let key = null;
      if (text[i] === '"') {
        const label = scanString();
        if (label.literal) {
          key = label.value;
        }
      } else {
        key = readIdentifier();
      }
      if (!key) {
        error("provider source object entry without a key");
        i++;
        continue;
      }
      skipSpacesTabs();
      const c = text[i];
      if (c !== "=" && c !== ":") {
        error("provider source object entry without a separator");
        skipToNewline();
        continue;
      }
      i++;
      skipWhitespace();
      if (i < len && text[i] === '"') {
        const value = scanString();
        if (value.literal && (key === "source" || key === "version")) {
          entry[key] = value.value;
        }
      } else {
        skipObjectValue();
      }
      skipSpacesTabs();
      if (text[i] === ",") {
        i++;
      }
    }
  };

  /** Skip an object element value up to its separating comma, newline or `}`. */
  const skipObjectValue = () => {
    let depth = 0;
    while (i < len) {
      const c = text[i];
      if (c === ",") {
        if (depth === 0) {
          return;
        }
        i++;
      } else if (c === "}") {
        if (depth === 0) {
          return;
        }
        depth--;
        i++;
      } else if (c === "\n") {
        if (depth === 0) {
          return;
        }
        line++;
        i++;
      } else if (c === "(" || c === "[" || c === "{") {
        depth++;
        i++;
      } else if (c === ")" || c === "]") {
        if (depth > 0) {
          depth--;
        }
        i++;
      } else if (c === '"') {
        scanString();
      } else if (atHeredoc()) {
        scanHeredoc();
      } else {
        i++;
      }
    }
    error("unterminated provider source object value");
  };

  const parseRequiredProvidersBody = () => {
    for (;;) {
      skipWhitespace();
      if (i >= len) {
        error("unterminated required_providers block");
        return;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      const attrLine = line;
      let localName = null;
      if (text[i] === '"') {
        const label = scanString();
        if (label.literal) {
          localName = label.value;
        }
      } else {
        localName = readIdentifier();
      }
      if (!localName) {
        error("required_providers entry without a name");
        i++;
        continue;
      }
      skipSpacesTabs();
      if (text[i] !== "=") {
        error("required_providers entry without a value");
        skipToNewline();
        continue;
      }
      i++;
      skipWhitespace();
      const entry = { localName, line: attrLine };
      if (i < len && text[i] === "{") {
        i++;
        parseProviderObject(entry);
      } else if (i < len && text[i] === '"') {
        // Legacy form: the string is the version constraint.
        const constraint = scanString();
        if (constraint.literal) {
          entry.version = constraint.value;
        }
      } else {
        scanExpression();
      }
      requiredProviders.push(entry);
    }
  };

  const parseTerraformBlock = () => {
    skipSpacesTabs();
    if (text[i] !== "{") {
      error("terraform block without a body");
      skipToNewline();
      return;
    }
    i++;
    for (;;) {
      skipWhitespace();
      if (i >= len) {
        error("unterminated terraform block");
        return;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      const ident = readIdentifier();
      if (!ident) {
        error("unexpected character in terraform block");
        i++;
        continue;
      }
      skipSpacesTabs();
      if (ident === "required_version" && text[i] === "=") {
        i++;
        const expr = scanExpression();
        if (expr.kind === "string" && expr.literal) {
          requiredVersions.push(expr.value);
        }
        continue;
      }
      if (ident === "required_providers" && text[i] === "{") {
        i++;
        parseRequiredProvidersBody();
        continue;
      }
      if (text[i] === "=") {
        i++;
        scanExpression();
        continue;
      }
      if (text[i] === "{") {
        skipBraces();
        continue;
      }
      skipRestOfStatement();
    }
  };

  try {
    for (;;) {
      skipWhitespace();
      if (i >= len) {
        break;
      }
      const stmtLine = line;
      const ident = readIdentifier();
      if (!ident) {
        error("unexpected character at top level");
        i++;
        continue;
      }
      if (ident === "module") {
        parseModuleBlock(stmtLine);
      } else if (ident === "terraform") {
        parseTerraformBlock();
      } else {
        skipRestOfStatement();
      }
    }
  } catch {
    errors.push("configuration scanning failed");
  }
  return { moduleCalls, requiredProviders, requiredVersions, errors };
}

/**
 * Whether a JSON configuration string carries an unescaped template opener.
 *
 * @param {string} value Candidate literal
 * @returns {boolean}
 */
function hasTemplate(value) {
  return value.includes("${") || value.includes("%{");
}

/**
 * Parse the JSON configuration variant.
 *
 * @param {string} text File contents
 * @returns {{ moduleCalls: object[], requiredProviders: object[], requiredVersions: string[], errors: string[] }}
 */
function parseJsonConfig(text) {
  const result = {
    moduleCalls: [],
    requiredProviders: [],
    requiredVersions: [],
    errors: [],
  };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    result.errors.push(`invalid JSON: ${err.message}`);
    return result;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return result;
  }
  const moduleMaps = Array.isArray(doc.module) ? doc.module : [doc.module];
  for (const map of moduleMaps) {
    if (!map || typeof map !== "object") {
      continue;
    }
    for (const [name, def] of Object.entries(map)) {
      if (name === "//" || !def || typeof def !== "object") {
        continue;
      }
      const call = { name };
      if (typeof def.source === "string") {
        call.sourceLiteral = !hasTemplate(def.source);
        if (call.sourceLiteral) {
          call.source = def.source;
        }
      }
      if (typeof def.version === "string") {
        call.versionLiteral = !hasTemplate(def.version);
        if (call.versionLiteral) {
          call.version = def.version;
        }
      }
      result.moduleCalls.push(call);
    }
  }
  const terraformBlocks = Array.isArray(doc.terraform)
    ? doc.terraform
    : [doc.terraform];
  for (const block of terraformBlocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (typeof block.required_version === "string") {
      if (!hasTemplate(block.required_version)) {
        result.requiredVersions.push(block.required_version);
      }
    }
    const providers = block.required_providers;
    if (!providers || typeof providers !== "object") {
      continue;
    }
    for (const [localName, def] of Object.entries(providers)) {
      if (localName === "//") {
        continue;
      }
      const entry = { localName };
      if (typeof def === "string") {
        if (!hasTemplate(def)) {
          entry.version = def;
        }
      } else if (def && typeof def === "object") {
        if (typeof def.source === "string" && !hasTemplate(def.source)) {
          entry.source = def.source;
        }
        if (typeof def.version === "string" && !hasTemplate(def.version)) {
          entry.version = def.version;
        }
      }
      result.requiredProviders.push(entry);
    }
  }
  return result;
}

const CONFIG_EXTENSIONS = [".tf.json", ".tofu.json", ".tf", ".tofu"];

const configExtension = (baseName) => {
  for (const ext of CONFIG_EXTENSIONS) {
    if (baseName.endsWith(ext)) {
      return ext;
    }
  }
  return null;
};

/**
 * Whether a file is a Terraform override file: base name `override` or ending
 * `_override`, with a `.tf`/`.tf.json`/`.tofu`/`.tofu.json` extension.
 *
 * @param {string} fileName File name (a bare name or a path)
 * @returns {boolean}
 */
export function isTerraformOverrideFile(fileName) {
  if (typeof fileName !== "string") {
    return false;
  }
  const baseName = fileName.split(/[\\/]/).pop() || "";
  const ext = configExtension(baseName);
  if (!ext) {
    return false;
  }
  const stem = baseName.slice(0, -ext.length);
  return stem === "override" || stem.endsWith("_override");
}

/**
 * Split one directory's configuration file names into primary and override
 * files, applying OpenTofu's `.tofu` precedence when any `.tofu` file exists.
 *
 * @param {string[]} fileNames File names within a single directory
 * @returns {{ primary: string[], overrides: string[] }} Sorted lists
 */
export function terraformConfigFileSet(fileNames) {
  const names = (fileNames || []).filter(
    (name) =>
      typeof name === "string" &&
      configExtension(name.split(/[\\/]/).pop() || ""),
  );
  const hasTofu = names.some(
    (name) => name.endsWith(".tofu") || name.endsWith(".tofu.json"),
  );
  // Stems that a `.tofu`/`.tofu.json` file replaces (`main.tofu` shadows
  // `main.tf`; `main.tofu.json` shadows `main.tf.json`).
  const shadowed = new Set();
  if (hasTofu) {
    for (const name of names) {
      const ext = configExtension(name.split(/[\\/]/).pop() || "");
      const stem = (name.split(/[\\/]/).pop() || "").slice(0, -ext.length);
      if (ext === ".tofu") {
        shadowed.add(`${stem}|.tf`);
      } else if (ext === ".tofu.json") {
        shadowed.add(`${stem}|.tf.json`);
      }
    }
  }
  const keep = (name) => {
    const baseName = name.split(/[\\/]/).pop() || "";
    const ext = configExtension(baseName);
    if (ext !== ".tf" && ext !== ".tf.json") {
      return true;
    }
    return !shadowed.has(`${baseName.slice(0, -ext.length)}|${ext}`);
  };
  const configNames = names.filter(keep);
  return {
    primary: configNames
      .filter(
        (name) => !isTerraformOverrideFile(name.split(/[\\/]/).pop() || ""),
      )
      .sort(),
    overrides: configNames
      .filter((name) =>
        isTerraformOverrideFile(name.split(/[\\/]/).pop() || ""),
      )
      .sort(),
  };
}

/**
 * Merge parsed configuration files (primary files first, then overrides, each
 * group in the given order).
 *
 * @param {{ file: string, override: boolean, result: object }[]} parsedFiles
 * @returns {{ moduleCalls: object[], requiredProviders: object[], requiredVersions: string[], errors: string[] }}
 */
export function mergeTerraformConfigs(parsedFiles) {
  const merged = {
    moduleCalls: [],
    requiredProviders: [],
    requiredVersions: [],
    errors: [],
  };
  const moduleByName = new Map();
  const providerByName = new Map();
  const entries = Array.isArray(parsedFiles) ? parsedFiles : [];
  const ordered = [
    ...entries.filter((entry) => !entry.override),
    ...entries.filter((entry) => entry.override),
  ];
  const primaryVersions = [];
  const overrideVersions = [];
  for (const { file, override, result } of ordered) {
    if (!result) {
      continue;
    }
    merged.errors.push(...result.errors);
    for (const version of result.requiredVersions || []) {
      (override ? overrideVersions : primaryVersions).push(version);
    }
    for (const call of result.moduleCalls || []) {
      const existing = moduleByName.get(call.name);
      if (!existing) {
        moduleByName.set(call.name, { ...call, file });
        continue;
      }
      if (override) {
        // Replace only the attributes the override sets, with their literal
        // flags and their provenance.
        if ("sourceLiteral" in call) {
          if (call.sourceLiteral) {
            existing.source = call.source;
          } else {
            delete existing.source;
          }
          existing.sourceLiteral = call.sourceLiteral;
          existing.sourceFile = file;
          existing.sourceLine = call.sourceLine;
        }
        if ("versionLiteral" in call) {
          if (call.versionLiteral) {
            existing.version = call.version;
          } else {
            delete existing.version;
          }
          existing.versionLiteral = call.versionLiteral;
          existing.versionFile = file;
          existing.versionLine = call.versionLine;
        }
        continue;
      }
      merged.errors.push(`duplicate module call '${call.name}'`);
    }
    for (const entry of result.requiredProviders || []) {
      const existing = providerByName.get(entry.localName);
      if (!existing) {
        providerByName.set(entry.localName, { ...entry, file });
        continue;
      }
      if (override) {
        providerByName.set(entry.localName, { ...entry, file });
      }
    }
  }
  merged.moduleCalls = [...moduleByName.values()];
  merged.requiredProviders = [...providerByName.values()];
  const versions = overrideVersions.length ? overrideVersions : primaryVersions;
  merged.requiredVersions = [...new Set(versions)];
  return merged;
}
