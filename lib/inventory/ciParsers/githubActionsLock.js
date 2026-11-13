// Reader for the GitHub Actions workflow dependency lockfile written by
// `gh actions-lock` (`.github/workflows/actions.lock`).
//
// The lockfile is a small YAML document describing the pinned action
// dependency graph of a repository's workflows. Three schema versions are
// published: v0.0.1 carries `OWNER/REPO@REF:ALGO-HEX` pin keys and resolves
// refs through `tag`/`branch` entry fields; v0.0.2 moved the ref into the
// entry and shortened the pin keys to `OWNER/REPO@REF`; v0.0.3 added an
// optional per-entry `hostname` for pins bound to github.com or a GHE.com
// data-residency tenant. Older files are normalised to the v0.0.2 shape so
// callers see one key format.
//
// This module only reads and validates the lockfile. Joining the entries to
// the components found by the workflow parser happens elsewhere, so the
// return value stays free of CycloneDX concepts. The reader never throws:
// every problem is reported as a warning and collapses the result to the
// empty shape.

import { statSync } from "node:fs";

import { DEBUG_MODE } from "../../core/activity.js";
import { safeExistsSync, safeReadFileSync } from "../../core/fs.js";
import { thoughtLog } from "../../core/logger.js";
import { parse as parseYaml } from "../../core/yaml.js";
import { scanTextForHiddenUnicode } from "../unicodeScan.js";

/**
 * Maximum accepted lockfile size. `gh actions-lock` writes files that stay
 * far below this; anything larger is treated as corrupt rather than parsed.
 * @type {number}
 */
export const MAX_ACTIONS_LOCKFILE_BYTES = 1024 * 1024;

const SUPPORTED_VERSIONS = new Set(["v0.0.1", "v0.0.2", "v0.0.3"]);

const TOP_LEVEL_FIELDS = new Set(["version", "workflows", "dependencies"]);

const ENTRY_FIELDS_V0_0_1 = new Set([
  "tag",
  "branch",
  "commit",
  "owner_id",
  "repo_id",
  "uses",
]);

const ENTRY_FIELDS_V0_0_2 = new Set([
  "ref",
  "commit",
  "owner_id",
  "repo_id",
  "uses",
]);

const ENTRY_FIELDS_V0_0_3 = new Set([...ENTRY_FIELDS_V0_0_2, "hostname"]);

const SHA1_HEX_LENGTH = 40;
const SHA256_HEX_LENGTH = 64;
const HEX_DIGEST_PATTERN = /^[a-f0-9]+$/;
const GHE_HOSTNAME_SUFFIX = ".ghe.com";
// One label of a GHE.com tenant host: lowercase letters, digits and inner
// hyphens, 1 to 63 characters long.
const GHE_HOSTNAME_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DRIVE_ROOT_PATTERN = /^[A-Za-z]:/;
const YAML_ERROR_LINE_PATTERN = /at line (\d+)/;
const ALIAS_DISABLED_MARKER = "Alias resolution is disabled";
const MAX_WARNING_DETAIL_LENGTH = 200;
const MAX_CYCLE_NODES_IN_WARNING = 5;

/**
 * One resolved action entry of the lockfile, normalised to the v0.0.2 shape.
 *
 * @typedef {Object} ActionsLockDependency
 * @property {string} owner Owner name, lower case.
 * @property {string} repo Repository name, lower case.
 * @property {string} ref Ref the commit was resolved from, with its case
 *   preserved. For a v0.0.1 entry this is the tag, else the branch. It can
 *   differ from the ref in the pin key: the key keeps the ref the workflow
 *   wrote (for example `v4`) while this field records the resolved one (for
 *   example `v4.3.1`).
 * @property {string} hashAlgo "sha1" or "sha256".
 * @property {string} commit Hex digest without the algorithm prefix.
 * @property {number} ownerId Numeric id of the action's owner.
 * @property {number} repoId Numeric id of the action's repository.
 * @property {string|undefined} hostname Set only when the entry records one
 *   (v0.0.3); undefined means the home host.
 * @property {string[]} uses Normalised pin keys of the direct dependencies;
 *   empty for leaf actions.
 */

/**
 * Parsed lockfile, or the empty shape when the file is unreadable or invalid.
 *
 * @typedef {Object} ActionsLockfile
 * @property {string|null} version Version as written in the file; null for an
 *   empty result.
 * @property {string|undefined} sourceVersion Set only when an older version
 *   was normalised.
 * @property {Object<string, string[]>} workflows Map of repository-relative
 *   workflow path (always with "/" separators) to its flat pin list.
 * @property {Object<string, ActionsLockDependency>} dependencies Map of
 *   normalised pin key to the resolved entry.
 * @property {string[]} warnings Human-readable problems found while reading.
 */

/**
 * Raised internally when the lockfile content is invalid. Never escapes the
 * module; the caller converts it into the empty result plus warnings.
 */
class ActionsLockParseAbort extends Error {
  constructor(message) {
    super(message);
    this.name = "ActionsLockParseAbort";
  }
}

function recordWarning(context, message) {
  const label = context.filePath || "actions lockfile";
  const text = `${label}: ${message}`;
  context.warnings.push(text);
  thoughtLog(`actions lockfile warning: ${text}`);
  if (DEBUG_MODE) {
    console.warn(`cdxgen: actions lockfile issue: ${text}`);
  }
}

function fail(context, message) {
  recordWarning(context, message);
  throw new ActionsLockParseAbort(message);
}

function truncateForWarning(text) {
  const singleLine = String(text).split("\n")[0];
  if (singleLine.length <= MAX_WARNING_DETAIL_LENGTH) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_WARNING_DETAIL_LENGTH)}...`;
}

function emptyLockResult(warnings) {
  return {
    version: null,
    sourceVersion: undefined,
    workflows: {},
    dependencies: {},
    warnings,
  };
}

function isLowerHexOfLength(text, length) {
  return text.length === length && HEX_DIGEST_PATTERN.test(text);
}

/**
 * Validate an algo-prefixed commit digest such as `sha1-<40 hex>`.
 *
 * @param {unknown} commit Candidate value
 * @returns {boolean} Whether the value is a well-formed digest
 */
function isValidCommitDigest(commit) {
  if (typeof commit !== "string") {
    return false;
  }
  if (commit.startsWith("sha1-")) {
    return isLowerHexOfLength(commit.slice(5), SHA1_HEX_LENGTH);
  }
  if (commit.startsWith("sha256-")) {
    return isLowerHexOfLength(commit.slice(7), SHA256_HEX_LENGTH);
  }
  return false;
}

/**
 * Validate a v0.0.3 `hostname`: `github.com` or a lowercase
 * `<tenant>.ghe.com` name.
 *
 * @param {unknown} hostname Candidate value
 * @returns {boolean} Whether the value is an accepted host name
 */
function isValidHostname(hostname) {
  if (hostname === "github.com") {
    return true;
  }
  if (typeof hostname !== "string" || !hostname.endsWith(GHE_HOSTNAME_SUFFIX)) {
    return false;
  }
  const label = hostname.slice(0, -GHE_HOSTNAME_SUFFIX.length);
  return GHE_HOSTNAME_LABEL_PATTERN.test(label);
}

/**
 * Split a pin key into owner, repo and ref. Only the shape is checked here;
 * the v0.0.1 digest suffix is handled by the caller.
 *
 * @param {unknown} pinKey Candidate pin key
 * @param {boolean} isV0_0_1 Whether the file uses v0.0.1 keys
 * @returns {{ owner: string, repo: string, ref: string }|undefined} Parts, or
 *   undefined when the key is not a valid pin
 */
function splitPinKey(pinKey, isV0_0_1) {
  if (typeof pinKey !== "string") {
    return undefined;
  }
  const atIndex = pinKey.indexOf("@");
  if (atIndex <= 0) {
    return undefined;
  }
  const ownerRepo = pinKey.slice(0, atIndex);
  const rest = pinKey.slice(atIndex + 1);
  if (!rest.length) {
    return undefined;
  }
  const slashIndex = ownerRepo.indexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  // A second slash is a sub-action path such as actions/cache/save@v4.
  if (ownerRepo.indexOf("/", slashIndex + 1) !== -1) {
    return undefined;
  }
  if (ownerRepo.includes(":")) {
    return undefined;
  }
  // A second "@" means the ref itself contains "@".
  if (rest.includes("@")) {
    return undefined;
  }
  // Only v0.0.1 keys carry the `:ALGO-HEX` suffix; everywhere else a colon
  // cannot appear in the ref.
  if (!isV0_0_1 && rest.includes(":")) {
    return undefined;
  }
  const owner = ownerRepo.slice(0, slashIndex).toLowerCase();
  const repo = ownerRepo.slice(slashIndex + 1).toLowerCase();
  if (!owner.length || !repo.length) {
    return undefined;
  }
  return { owner, repo, ref: rest };
}

/**
 * Split the ref part of a v0.0.1 pin into the ref and the digest suffix.
 *
 * @param {string} refWithSuffix Text after the "@" of a v0.0.1 pin key
 * @returns {{ ref: string, digest: string }|undefined} Parts, or undefined
 *   when the digest suffix is missing
 */
function splitV0_0_1Ref(refWithSuffix) {
  const colonIndex = refWithSuffix.indexOf(":");
  if (colonIndex <= 0) {
    return undefined;
  }
  const ref = refWithSuffix.slice(0, colonIndex);
  const digest = refWithSuffix.slice(colonIndex + 1);
  if (!ref.length) {
    return undefined;
  }
  return { ref, digest };
}

/**
 * Parse a pin key as written in the file into its normalised v0.0.2 form,
 * failing with a warning when the key is malformed.
 *
 * @param {unknown} rawPin Pin key as written in the file
 * @param {boolean} isV0_0_1 Whether the file uses v0.0.1 keys
 * @param {Object} context Warning context
 * @param {string} where Where the key was found, for the warning
 * @returns {{ owner: string, repo: string, key: string, keyDigest: string|undefined }}
 *   Lower-cased owner and repository, the normalised key, and the v0.0.1
 *   digest suffix when there is one
 */
function parsePinKey(rawPin, isV0_0_1, context, where) {
  const pin = splitPinKey(rawPin, isV0_0_1);
  if (!pin) {
    fail(
      context,
      `invalid pin key '${truncateForWarning(rawPin)}' in ${where}`,
    );
  }
  let ref = pin.ref;
  let keyDigest;
  if (isV0_0_1) {
    const split = splitV0_0_1Ref(pin.ref);
    if (!split) {
      fail(
        context,
        `pin key '${truncateForWarning(rawPin)}' in ${where} lacks a sha1- or sha256- digest suffix`,
      );
    }
    ref = split.ref;
    keyDigest = split.digest;
  }
  return {
    owner: pin.owner,
    repo: pin.repo,
    key: `${pin.owner}/${pin.repo}@${ref}`,
    keyDigest,
  };
}

function fullCommitOf(entry) {
  return `${entry.hashAlgo}-${entry.commit}`;
}

/**
 * Resolve one pin reference found in a workflow list or a uses list: parse
 * the key, normalise it to the v0.0.2 shape, and require that the referenced
 * entry exists with a matching v0.0.1 digest.
 *
 * @param {string} rawPin Pin key as written in the file
 * @param {Map<string, Object>} entries Normalised dependency entries
 * @param {boolean} isV0_0_1 Whether the file uses v0.0.1 keys
 * @param {Object} context Warning context
 * @param {string} where Where the reference was found, for the warning
 * @returns {string} Normalised pin key
 */
function normalisePinReference(rawPin, entries, isV0_0_1, context, where) {
  const { key: normalisedKey, keyDigest } = parsePinKey(
    rawPin,
    isV0_0_1,
    context,
    where,
  );
  const entry = entries.get(normalisedKey);
  if (!entry) {
    fail(
      context,
      `pin '${normalisedKey}' referenced in ${where} is not defined in dependencies`,
    );
  }
  if (keyDigest && keyDigest !== fullCommitOf(entry)) {
    fail(
      context,
      `pin key '${normalisedKey}' in ${where} carries digest '${keyDigest}' but the entry commits to '${fullCommitOf(entry)}'`,
    );
  }
  return normalisedKey;
}

/**
 * Validate the `dependencies` mapping and normalise every entry to the
 * v0.0.2 shape. The uses lists are kept raw here because they may reference
 * entries that have not been seen yet.
 *
 * @param {Object} doc Parsed lockfile document
 * @param {string} version Lockfile version as written
 * @param {Object} context Warning context
 * @returns {Map<string, Object>} Normalised entries by pin key
 */
function parseDependencyEntries(doc, version, context) {
  const entries = new Map();
  const raw = doc.dependencies;
  if (raw === undefined) {
    return entries;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(context, "dependencies must be a mapping of pin keys");
  }
  const isV0_0_1 = version === "v0.0.1";
  const allowedFields = isV0_0_1
    ? ENTRY_FIELDS_V0_0_1
    : version === "v0.0.2"
      ? ENTRY_FIELDS_V0_0_2
      : ENTRY_FIELDS_V0_0_3;
  for (const rawKey of Object.keys(raw)) {
    const pin = parsePinKey(rawKey, isV0_0_1, context, "dependencies");
    const normalisedKey = pin.key;
    const keyDigest = pin.keyDigest;
    if (entries.has(normalisedKey)) {
      fail(
        context,
        isV0_0_1
          ? `dependencies contains two entries that normalise to the same pin key '${normalisedKey}' (the keys differ only in owner or repository case, or in the digest suffix)`
          : `dependencies contains two entries that normalise to the same pin key '${normalisedKey}' (the keys differ only in owner or repository case)`,
      );
    }
    const entry = raw[rawKey];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(context, `entry '${normalisedKey}' must be a mapping`);
    }
    for (const fieldName of Object.keys(entry)) {
      if (!allowedFields.has(fieldName)) {
        fail(
          context,
          `unknown field '${fieldName}' in entry '${normalisedKey}'`,
        );
      }
    }
    const commit = entry.commit;
    if (commit === undefined) {
      fail(context, `entry '${normalisedKey}' is missing the commit field`);
    }
    if (!isValidCommitDigest(commit)) {
      fail(
        context,
        `entry '${normalisedKey}' has a malformed commit digest (expected sha1- with ${SHA1_HEX_LENGTH} or sha256- with ${SHA256_HEX_LENGTH} lowercase hex characters)`,
      );
    }
    if (keyDigest && keyDigest !== commit) {
      fail(
        context,
        `pin key '${normalisedKey}' carries digest '${keyDigest}' but the entry commits to '${commit}'`,
      );
    }
    const ownerId = entry.owner_id;
    const repoId = entry.repo_id;
    if (!Number.isInteger(ownerId) || ownerId < 1) {
      fail(
        context,
        `entry '${normalisedKey}' needs a positive integer owner_id`,
      );
    }
    if (!Number.isInteger(repoId) || repoId < 1) {
      fail(
        context,
        `entry '${normalisedKey}' needs a positive integer repo_id`,
      );
    }
    let entryRef;
    if (isV0_0_1) {
      const tag = entry.tag;
      const branch = entry.branch;
      if (tag !== undefined && (typeof tag !== "string" || !tag.length)) {
        fail(context, `entry '${normalisedKey}' has a non-string tag`);
      }
      if (
        branch !== undefined &&
        (typeof branch !== "string" || !branch.length)
      ) {
        fail(context, `entry '${normalisedKey}' has a non-string branch`);
      }
      if (tag === undefined && branch === undefined) {
        fail(
          context,
          `entry '${normalisedKey}' needs a tag or a branch to resolve its ref`,
        );
      }
      entryRef = tag !== undefined ? tag : branch;
    } else {
      const refField = entry.ref;
      if (refField === undefined) {
        fail(context, `entry '${normalisedKey}' is missing the ref field`);
      }
      if (typeof refField !== "string" || !refField.length) {
        fail(context, `entry '${normalisedKey}' needs a non-empty ref string`);
      }
      entryRef = refField;
    }
    let hostname;
    if (version === "v0.0.3" && entry.hostname !== undefined) {
      if (!isValidHostname(entry.hostname)) {
        fail(
          context,
          `entry '${normalisedKey}' has an invalid hostname '${truncateForWarning(entry.hostname)}' (expected github.com or a lowercase <tenant>.ghe.com name)`,
        );
      }
      hostname = entry.hostname;
    }
    const rawUses = entry.uses;
    if (rawUses !== undefined && !Array.isArray(rawUses)) {
      fail(
        context,
        `entry '${normalisedKey}' has a uses list that is not an array`,
      );
    }
    entries.set(normalisedKey, {
      owner: pin.owner,
      repo: pin.repo,
      ref: entryRef,
      hashAlgo: commit.startsWith("sha256-") ? "sha256" : "sha1",
      commit: commit.slice(commit.indexOf("-") + 1),
      ownerId,
      repoId,
      hostname,
      rawUses: rawUses || [],
    });
  }
  return entries;
}

/**
 * Resolve the uses lists of every entry into normalised pin keys.
 *
 * @param {Map<string, Object>} entries Normalised dependency entries
 * @param {boolean} isV0_0_1 Whether the file uses v0.0.1 keys
 * @param {Object} context Warning context
 * @returns {Map<string, string[]>} Normalised direct edges by pin key
 */
function resolveUsesEdges(entries, isV0_0_1, context) {
  const usesMap = new Map();
  for (const [key, entry] of entries) {
    const edges = entry.rawUses.map((rawPin) =>
      normalisePinReference(
        rawPin,
        entries,
        isV0_0_1,
        context,
        `the uses list of '${key}'`,
      ),
    );
    usesMap.set(key, edges);
  }
  return usesMap;
}

/**
 * Find a cycle in the uses graph with an iterative depth-first walk, so a
 * deep graph cannot overflow the call stack. Returns the cycle as a list of
 * pin keys ending where it started, or undefined when the graph is acyclic.
 *
 * @param {Map<string, string[]>} usesMap Normalised direct edges by pin key
 * @returns {string[]|undefined} The cycle, or undefined
 */
function findUsesCycle(usesMap) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const key of usesMap.keys()) {
    color.set(key, WHITE);
  }
  for (const start of usesMap.keys()) {
    if (color.get(start) !== WHITE) {
      continue;
    }
    color.set(start, GRAY);
    const stack = [[start, 0]];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edges = usesMap.get(frame[0]);
      if (frame[1] >= edges.length) {
        color.set(frame[0], BLACK);
        stack.pop();
        continue;
      }
      const next = edges[frame[1]];
      frame[1] += 1;
      const nextColor = color.get(next);
      if (nextColor === GRAY) {
        const path = stack.map((frameEntry) => frameEntry[0]);
        return path.slice(path.indexOf(next)).concat(next);
      }
      if (nextColor === WHITE) {
        color.set(next, GRAY);
        stack.push([next, 0]);
      }
    }
  }
  return undefined;
}

/**
 * Validate one workflow path key and return the form stored in the result.
 * Backslash separators are normalised so Windows-built keys round-trip with
 * "/" on every platform; absolute paths, "." and ".." segments are rejected,
 * so every stored key is in the canonical repository-relative form. The
 * comparison stays case-sensitive, like git paths.
 *
 * @param {string} rawPath Workflow path as written in the file
 * @param {Object} context Warning context
 * @returns {string} Repository-relative path with "/" separators
 */
function normaliseWorkflowPath(rawPath, context) {
  if (typeof rawPath !== "string" || !rawPath.length) {
    fail(context, "workflows contains an empty path key");
  }
  const normalised = rawPath.split("\\").join("/");
  if (!normalised.length) {
    fail(context, "workflows contains an empty path key");
  }
  if (normalised.startsWith("/") || DRIVE_ROOT_PATTERN.test(normalised)) {
    fail(context, `workflow path '${truncateForWarning(rawPath)}' is absolute`);
  }
  const segments = normalised.split("/");
  if (segments.some((segment) => !segment.length)) {
    fail(
      context,
      `workflow path '${truncateForWarning(rawPath)}' has an empty path segment`,
    );
  }
  if (segments.includes("..")) {
    fail(
      context,
      `workflow path '${truncateForWarning(rawPath)}' escapes the repository with a '..' segment`,
    );
  }
  if (segments.includes(".")) {
    fail(
      context,
      `workflow path '${truncateForWarning(rawPath)}' has a '.' segment; keys must be plain repository-relative paths`,
    );
  }
  return normalised;
}

/**
 * Validate the `workflows` mapping and resolve its pin lists to normalised
 * keys that must exist in dependencies.
 *
 * @param {Object} doc Parsed lockfile document
 * @param {Map<string, Object>} entries Normalised dependency entries
 * @param {boolean} isV0_0_1 Whether the file uses v0.0.1 keys
 * @param {Object} context Warning context
 * @returns {Object<string, string[]>} Workflow paths mapped to pin key lists
 */
function resolveWorkflows(doc, entries, isV0_0_1, context) {
  const workflows = {};
  const raw = doc.workflows;
  if (raw === undefined) {
    return workflows;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(context, "workflows must be a mapping of workflow paths to pin lists");
  }
  for (const rawPath of Object.keys(raw)) {
    const storedPath = normaliseWorkflowPath(rawPath, context);
    if (Object.hasOwn(workflows, storedPath)) {
      fail(
        context,
        `workflows contains two keys that normalise to the same path '${storedPath}'`,
      );
    }
    const pinList = raw[rawPath];
    if (!Array.isArray(pinList)) {
      fail(
        context,
        `workflow '${storedPath}' has a pin list that is not an array`,
      );
    }
    const normalisedList = pinList.map((rawPin, index) => {
      if (typeof rawPin !== "string") {
        fail(
          context,
          `workflow '${storedPath}' has a non-string pin at position ${index}`,
        );
      }
      return normalisePinReference(
        rawPin,
        entries,
        isV0_0_1,
        context,
        `the pin list of '${storedPath}'`,
      );
    });
    // Workflow paths come from the lockfile, so a path could collide with a
    // JS object name such as __proto__; defineProperty keeps it a plain key.
    Object.defineProperty(workflows, storedPath, {
      value: normalisedList,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return workflows;
}

function failYaml(context, error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (error?.code === "DUPLICATE_KEY") {
    const lineMatch = YAML_ERROR_LINE_PATTERN.exec(message);
    fail(
      context,
      `duplicate mapping key${lineMatch ? ` at line ${lineMatch[1]}` : ""}`,
    );
  }
  if (message.includes(ALIAS_DISABLED_MARKER)) {
    fail(context, "YAML aliases are not allowed in the lockfile");
  }
  fail(context, `invalid YAML (${truncateForWarning(message)})`);
}

/**
 * Parse an actions lockfile from its text content.
 *
 * Every problem, including a file that cannot be parsed at all, is reported
 * as a warning and collapses the result to the empty shape; the function
 * never throws.
 *
 * @param {string} text Lockfile content
 * @param {string} [filePath] Path the content came from, used in warnings
 * @returns {ActionsLockfile} Parsed lockfile, or the empty shape
 */
export function parseActionsLockfileString(text, filePath) {
  const warnings = [];
  const context = { filePath, warnings };
  try {
    if (typeof text !== "string") {
      fail(context, "the lockfile content is not text");
    }
    const unicodeScan = scanTextForHiddenUnicode(text, { syntax: "yaml" });
    if (unicodeScan.hasHiddenUnicode) {
      recordWarning(
        context,
        `hidden Unicode characters found at line(s) ${unicodeScan.lineNumbers.join(", ")} (${unicodeScan.codePoints.join(", ")})`,
      );
    }
    let doc;
    try {
      // Aliases are banned outright: a document is a few hundred flat lines,
      // so there is nothing an alias could legitimately expand to.
      doc = parseYaml(text, { maxAliasCount: 0 });
    } catch (error) {
      failYaml(context, error);
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      fail(
        context,
        doc === null
          ? "the lockfile is empty"
          : "the lockfile must be a YAML mapping",
      );
    }
    const version = doc.version;
    if (version === undefined) {
      fail(context, "missing the required version field");
    }
    if (typeof version !== "string" || !SUPPORTED_VERSIONS.has(version)) {
      fail(
        context,
        `unsupported lockfile version '${truncateForWarning(version)}'; supported versions are v0.0.1, v0.0.2 and v0.0.3`,
      );
    }
    for (const key of Object.keys(doc)) {
      if (!TOP_LEVEL_FIELDS.has(key)) {
        fail(context, `unknown top-level field '${key}'`);
      }
    }
    const isV0_0_1 = version === "v0.0.1";
    const entries = parseDependencyEntries(doc, version, context);
    const usesMap = resolveUsesEdges(entries, isV0_0_1, context);
    const cycle = findUsesCycle(usesMap);
    if (cycle) {
      // A crafted file can close a cycle over thousands of entries; keep the
      // warning to the first few hops instead of the whole walk.
      const cyclePath =
        cycle.length > MAX_CYCLE_NODES_IN_WARNING
          ? `${cycle.slice(0, MAX_CYCLE_NODES_IN_WARNING).join(" -> ")} -> ...`
          : cycle.join(" -> ");
      fail(context, `uses cycle detected: ${cyclePath}`);
    }
    const workflows = resolveWorkflows(doc, entries, isV0_0_1, context);
    const dependencies = {};
    for (const [key, entry] of entries) {
      dependencies[key] = {
        owner: entry.owner,
        repo: entry.repo,
        ref: entry.ref,
        hashAlgo: entry.hashAlgo,
        commit: entry.commit,
        ownerId: entry.ownerId,
        repoId: entry.repoId,
        hostname: entry.hostname,
        uses: usesMap.get(key) || [],
      };
    }
    return {
      version,
      sourceVersion: isV0_0_1 ? "v0.0.1" : undefined,
      workflows,
      dependencies,
      warnings,
    };
  } catch (error) {
    if (!(error instanceof ActionsLockParseAbort)) {
      recordWarning(
        context,
        `unexpected failure while parsing the lockfile (${error?.name || "Error"})`,
      );
    }
    return emptyLockResult(warnings);
  }
}

/**
 * Read and parse an actions lockfile such as
 * `.github/workflows/actions.lock`.
 *
 * The file is size-checked before it is read, and every problem is reported
 * as a warning and collapses the result to the empty shape; the function
 * never throws.
 *
 * @param {string} filePath Path to the lockfile
 * @returns {ActionsLockfile} Parsed lockfile, or the empty shape
 */
export function parseActionsLockfile(filePath) {
  const warnings = [];
  const context = { filePath, warnings };
  if (!safeExistsSync(filePath)) {
    recordWarning(context, "the lockfile does not exist");
    return emptyLockResult(warnings);
  }
  let stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    recordWarning(
      context,
      `the lockfile could not be inspected (${error?.name || "Error"})`,
    );
    return emptyLockResult(warnings);
  }
  if (!stats.isFile()) {
    recordWarning(context, "the lockfile path is not a regular file");
    return emptyLockResult(warnings);
  }
  if (stats.size > MAX_ACTIONS_LOCKFILE_BYTES) {
    recordWarning(
      context,
      `the lockfile is ${stats.size} bytes, larger than the limit of ${MAX_ACTIONS_LOCKFILE_BYTES} bytes`,
    );
    return emptyLockResult(warnings);
  }
  const text = safeReadFileSync(filePath, "utf-8");
  if (typeof text !== "string") {
    recordWarning(context, "the lockfile could not be read");
    return emptyLockResult(warnings);
  }
  return parseActionsLockfileString(text, filePath);
}
