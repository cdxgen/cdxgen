import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let url = import.meta?.url;
if (url && !url.startsWith("file://")) {
  url = new URL(`file://${import.meta.url}`).toString();
}
const dirNameStr = url
  ? dirname(dirname(dirname(fileURLToPath(url))))
  : __dirname;

let spdxLicenseList = null;
let licenseDb = null;
let licenseAliases = null;
let licenseDeprecations = null;

function loadSpdxLicenseList() {
  if (!spdxLicenseList) {
    try {
      spdxLicenseList = JSON.parse(
        readFileSync(
          join(dirNameStr, "data", "spdx-license-list.json"),
          "utf-8",
        ),
      );
    } catch (_e) {
      spdxLicenseList = { licenses: {}, exceptions: {} };
    }
  }
  return spdxLicenseList;
}

function loadLicenseDb() {
  if (!licenseDb) {
    try {
      licenseDb = JSON.parse(
        readFileSync(join(dirNameStr, "data", "license-db.json"), "utf-8"),
      );
    } catch (_e) {
      licenseDb = {};
    }
  }
  return licenseDb;
}

function loadLicenseAliases() {
  if (!licenseAliases) {
    try {
      licenseAliases = JSON.parse(
        readFileSync(join(dirNameStr, "data", "license-aliases.json"), "utf-8"),
      );
    } catch (_e) {
      licenseAliases = {};
    }
  }
  return licenseAliases;
}

function loadLicenseDeprecations() {
  if (!licenseDeprecations) {
    try {
      licenseDeprecations = JSON.parse(
        readFileSync(
          join(dirNameStr, "data", "license-deprecations.json"),
          "utf-8",
        ),
      );
    } catch (_e) {
      licenseDeprecations = {};
    }
  }
  return licenseDeprecations;
}

// Memoized lowercase lookup maps to avoid O(n) linear scans on every operand.
let spdxLowerMap = null;
let spdxExcLowerMap = null;
let dbKeyLowerMap = null;

function getSpdxLowerMap() {
  if (!spdxLowerMap) {
    spdxLowerMap = new Map();
    for (const id of Object.keys(loadSpdxLicenseList().licenses)) {
      spdxLowerMap.set(id.toLowerCase(), id);
    }
  }
  return spdxLowerMap;
}

function getSpdxExcLowerMap() {
  if (!spdxExcLowerMap) {
    spdxExcLowerMap = new Map();
    for (const id of Object.keys(loadSpdxLicenseList().exceptions)) {
      spdxExcLowerMap.set(id.toLowerCase(), id);
    }
  }
  return spdxExcLowerMap;
}

function getDbKeyLowerMap() {
  if (!dbKeyLowerMap) {
    dbKeyLowerMap = new Map();
    const db = loadLicenseDb();
    for (const key of Object.keys(db)) {
      dbKeyLowerMap.set(key.toLowerCase(), db[key].spdx_license_key);
    }
  }
  return dbKeyLowerMap;
}

/**
 * Returns true if the identifier is a LicenseRef-/DocumentRef- style document
 * reference rather than an SPDX short identifier.
 *
 * @param {string} id Identifier
 * @returns {boolean}
 */
export function isLicenseRef(id) {
  if (!id) return false;
  const lower = id.toLowerCase();
  return lower.startsWith("licenseref-") || lower.startsWith("documentref-");
}

/**
 * Normalizes a key by lowercasing and removing non-alphanumeric characters.
 * Matches the key normalization in data generation.
 *
 * @returns {string} Normalized lookup key
 */
export function normalizeKey(name) {
  if (!name) return "";
  return name.toLowerCase().replace(/[^a-z0-9+]/g, "");
}

/**
 * Performs fuzzy correction on a license ID using aliases and direct case-insensitive lookups.
 *
 * @param {string} id License ID to correct
 * @returns {string|null} Corrected ID or null if not found
 */
export function correctLicenseId(id) {
  if (!id) return null;
  const aliases = loadLicenseAliases();
  const normalized = normalizeKey(id);
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  const lower = id.toLowerCase();
  // Try case-insensitive lookup in SPDX licenses & exceptions directly
  const spdxHit = getSpdxLowerMap().get(lower);
  if (spdxHit) {
    return spdxHit;
  }
  const excHit = getSpdxExcLowerMap().get(lower);
  if (excHit) {
    return excHit;
  }
  // Try case-insensitive lookup in license-db directly
  const dbHit = getDbKeyLowerMap().get(lower);
  if (dbHit) {
    return dbHit;
  }
  return null;
}

/**
 * Helper to get canonical ID
 * @private
 */
function getCanonicalId(id) {
  if (!id) return null;
  const lower = id.toLowerCase();
  const spdxHit = getSpdxLowerMap().get(lower);
  if (spdxHit) {
    return spdxHit;
  }
  const dbHit = getDbKeyLowerMap().get(lower);
  if (dbHit) {
    return dbHit;
  }
  return null;
}

/**
 * Tokenize a raw license expression string.
 *
 * @param {string} expr Expression
 * @returns {string[]} Tokens
 */
export function tokenize(expr) {
  if (!expr) return [];
  const regex = /\(|\)|AND\b|OR\b|WITH\b|[a-zA-Z0-9_:.#-]+\+?|\+/gi;
  const matches = expr.match(regex);
  if (!matches) return [];
  const tokens = [];
  for (const m of matches) {
    if (
      m === "(" ||
      m === ")" ||
      m === "+" ||
      m.toUpperCase() === "AND" ||
      m.toUpperCase() === "OR" ||
      m.toUpperCase() === "WITH"
    ) {
      tokens.push(m);
    } else if (m.endsWith("+")) {
      tokens.push(m.slice(0, -1));
      tokens.push("+");
    } else {
      tokens.push(m);
    }
  }
  return tokens;
}

/**
 * AST Node Parser
 */
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek() {
    return this.tokens[this.index];
  }

  next() {
    return this.tokens[this.index++];
  }

  parse() {
    const node = this.parseOr();
    if (this.index < this.tokens.length) {
      throw new Error(
        `Unexpected token at position ${this.index}: ${this.peek()}`,
      );
    }
    return node;
  }

  parseOr() {
    let node = this.parseAnd();
    while (this.peek() && this.peek().toUpperCase() === "OR") {
      this.next(); // consume OR
      const right = this.parseAnd();
      node = { type: "Or", left: node, right };
    }
    return node;
  }

  parseAnd() {
    let node = this.parseWith();
    while (this.peek() && this.peek().toUpperCase() === "AND") {
      this.next(); // consume AND
      const right = this.parseWith();
      node = { type: "And", left: node, right };
    }
    return node;
  }

  parseWith() {
    let node = this.parsePrimary();
    if (this.peek() && this.peek().toUpperCase() === "WITH") {
      this.next(); // consume WITH
      const exceptionToken = this.next();
      if (!exceptionToken) {
        throw new Error("Expected exception identifier after WITH");
      }
      const upper = exceptionToken.toUpperCase();
      if (
        upper === "AND" ||
        upper === "OR" ||
        upper === "WITH" ||
        exceptionToken === "(" ||
        exceptionToken === ")"
      ) {
        throw new Error(`Invalid exception identifier: ${exceptionToken}`);
      }
      if (node.type !== "License") {
        throw new Error("WITH operator can only apply to a license identifier");
      }
      node = { type: "With", license: node, exception: exceptionToken };
    }
    return node;
  }

  parsePrimary() {
    const token = this.peek();
    if (!token) {
      throw new Error("Unexpected end of expression");
    }
    if (token === "(") {
      this.next(); // consume (
      const node = this.parseOr();
      if (this.peek() !== ")") {
        throw new Error("Expected ')' to close parenthesis");
      }
      this.next(); // consume )
      return node;
    }
    const id = this.next();
    const upper = id.toUpperCase();
    if (upper === "AND" || upper === "OR" || upper === "WITH" || id === ")") {
      throw new Error(`Unexpected token: ${id}`);
    }
    let plus = false;
    if (this.peek() === "+") {
      this.next(); // consume +
      plus = true;
    }
    return { type: "License", id, plus };
  }
}

/**
 * Validates operands in the AST and gathers unknown IDs.
 *
 * @param {object} node AST Node
 * @param {string[]} unknown Gathers unknown IDs
 */
function validateAST(node, unknown) {
  if (node.type === "License") {
    const id = node.id;
    if (isLicenseRef(id)) {
      return;
    }
    const lower = id.toLowerCase();
    const isSpdx = getSpdxLowerMap().has(lower);
    const isInDb = getDbKeyLowerMap().has(lower);
    if (!isSpdx && !isInDb) {
      unknown.push(id);
    }
  } else if (node.type === "With") {
    validateAST(node.license, unknown);
    const exc = node.exception;
    if (isLicenseRef(exc)) {
      return;
    }
    const isSpdxException = getSpdxExcLowerMap().has(exc.toLowerCase());
    if (!isSpdxException) {
      unknown.push(exc);
    }
  } else if (node.type === "And" || node.type === "Or") {
    validateAST(node.left, unknown);
    validateAST(node.right, unknown);
  }
}

/**
 * Parses and validates an SPDX expression.
 *
 * @param {string} expr Raw expression string
 * @returns {object} Results: { valid: boolean, ast: object|null, unknown: string[] }
 */
export function parseSpdxExpression(expr) {
  if (!expr) {
    return { valid: false, ast: null, unknown: [] };
  }
  try {
    const tokens = tokenize(expr);
    const parser = new Parser(tokens);
    const ast = parser.parse();
    const unknown = [];
    validateAST(ast, unknown);
    return {
      valid: unknown.length === 0,
      ast,
      unknown,
    };
  } catch (_err) {
    return { valid: false, ast: null, unknown: [expr] };
  }
}

/**
 * Renders an AST node back to a normalized string.
 *
 * @param {object} node AST Node
 * @returns {string} Normalized string
 */
export function renderAST(node) {
  if (!node) return "";
  if (node.type === "License") {
    return node.id + (node.plus ? "+" : "");
  }
  if (node.type === "With") {
    return `${renderAST(node.license)} WITH ${node.exception}`;
  }
  if (node.type === "And") {
    let leftStr = renderAST(node.left);
    if (node.left.type === "Or") {
      leftStr = `(${leftStr})`;
    }
    let rightStr = renderAST(node.right);
    if (node.right.type === "Or") {
      rightStr = `(${rightStr})`;
    }
    return `${leftStr} AND ${rightStr}`;
  }
  if (node.type === "Or") {
    const leftStr = renderAST(node.left);
    const rightStr = renderAST(node.right);
    return `${leftStr} OR ${rightStr}`;
  }
  return "";
}

/**
 * Canonicalizes operand casing in the AST based on reference data.
 *
 * @param {object} node AST Node
 * @returns {object} Canonicalized AST Node
 */
export function canonicalizeAST(node) {
  if (!node) return null;
  if (node.type === "License") {
    const id = node.id;
    if (isLicenseRef(id)) {
      return node;
    }
    const canonical = getCanonicalId(id);
    return {
      type: "License",
      id: canonical || id,
      plus: node.plus,
    };
  }
  if (node.type === "With") {
    const canonicalLicense = canonicalizeAST(node.license);
    const exc = node.exception;
    let canonicalException = null;
    if (isLicenseRef(exc)) {
      canonicalException = exc;
    } else {
      canonicalException = getSpdxExcLowerMap().get(exc.toLowerCase()) || null;
    }
    return {
      type: "With",
      license: canonicalLicense,
      exception: canonicalException || exc,
    };
  }
  if (node.type === "And") {
    return {
      type: "And",
      left: canonicalizeAST(node.left),
      right: canonicalizeAST(node.right),
    };
  }
  if (node.type === "Or") {
    return {
      type: "Or",
      left: canonicalizeAST(node.left),
      right: canonicalizeAST(node.right),
    };
  }
  return node;
}

/**
 * Resolves deprecation replacements inside the AST recursively.
 *
 * @param {object} node AST Node
 * @returns {object} Upgraded AST Node
 */
export function upgradeDeprecatedAST(node) {
  if (!node) return null;
  if (node.type === "License") {
    const id = node.id;
    const deprecations = loadLicenseDeprecations();
    const norm = id.toLowerCase();
    let replacement = deprecations[id] || deprecations[norm];
    if (!replacement) {
      const canonical = getCanonicalId(id);
      if (canonical) {
        replacement = deprecations[canonical];
      }
    }
    if (replacement) {
      const parsed = parseSpdxExpression(replacement);
      if (parsed.valid && parsed.ast) {
        return upgradeDeprecatedAST(parsed.ast);
      }
    }
    return node;
  }
  if (node.type === "With") {
    return {
      type: "With",
      license: upgradeDeprecatedAST(node.license),
      exception: node.exception,
    };
  }
  if (node.type === "And") {
    return {
      type: "And",
      left: upgradeDeprecatedAST(node.left),
      right: upgradeDeprecatedAST(node.right),
    };
  }
  if (node.type === "Or") {
    return {
      type: "Or",
      left: upgradeDeprecatedAST(node.left),
      right: upgradeDeprecatedAST(node.right),
    };
  }
  return node;
}
