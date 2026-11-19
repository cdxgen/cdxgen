/**
 * Build ledger: an opt-in, worker-safe recorder of structured build-adequacy
 * events.
 *
 * Producers record what a run did to its build environment — the tool versions
 * a project expected, the tools that were actually found, the commands that
 * failed, the fallback code paths that were taken — and the post-generation
 * reflection turns those events into a fidelity verdict. The recorder follows
 * the shape of `activity.js` but stays a separate stream: activity records
 * describe security-relevant side effects consumed by the secure-mode
 * machinery, while ledger events describe environment adequacy consumed by the
 * introspection report.
 *
 * Two facts about workers shape the design:
 *
 * 1. A worker thread gets its own instance of this module, so events recorded
 *    inside a worker are invisible to the main thread's in-memory buffer.
 *    When `CDXGEN_INTROSPECT_LEDGER` is set, every instance appends its events
 *    to the same JSONL sidecar through an `O_APPEND` descriptor (only the main
 *    thread truncates, at open), which makes the sidecar the only complete
 *    record of a multi-worker run. Consumers must therefore prefer the sidecar
 *    when it exists and fall back to `getLedgerEvents()` only when it does not.
 * 2. Every write reaches the descriptor synchronously at record time, so a
 *    lost tail is impossible; the descriptor is released when the process
 *    exits (`closeLogStreams` closes every shared writer) or earlier through
 *    {@link closeLedger}.
 *
 * Values that could carry credentials are scrubbed before they are stored or
 * written: `command`, `path`, `detail`, `causeDetail` and `outputExcerpt` pass
 * through sensitive-assignment redaction plus the BOM property sanitizer, so a
 * leaked token can never reach a report file that agents upload.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isSensitiveEnvironmentVariableName,
  readEnvironmentVariable,
} from "./activity.js";
import { safeReadFileSync } from "./fs.js";
import { thoughtLog } from "./logger.js";
import { dirNameStr } from "./paths.js";
import { sanitizeBomPropertyValue } from "./propertySanitizer.js";
import { registerRunReset } from "./runState.js";
import { openSyncFileWriter } from "./syncFileWriter.js";

/** Longest command-output excerpt an event keeps, taken from the tail: build
 * tools print the banner first and the error last. */
const OUTPUT_EXCERPT_LIMIT = 2000;

/** Slots an excerpt-bearing event charges against the in-memory event cap. */
const EXCERPT_EVENT_WEIGHT = 2;

/**
 * A structured build-adequacy event.
 *
 * @typedef {Object} LedgerEvent
 * @property {string}  kind        One of LEDGER_EVENT_KINDS.
 * @property {string}  ecosystem   Canonical project type ("java", "npm", "python", …).
 * @property {string}  [tool]      Tool identity ("maven", "gradle", "swift", "dotnet").
 * @property {string}  [wanted]    Version or version range the project asked for.
 * @property {string}  [found]     Version actually resolved, or undefined when absent.
 * @property {string}  [source]    How `found` was determined ("PATH", "wrapper", "sdkman", "env").
 * @property {string}  [path]      Absolute path of the resolved tool or the file that was read.
 * @property {string}  [command]   Command line, already redacted.
 * @property {number}  [exitCode]
 * @property {string}  [detail]    One sentence, present tense, no remediation text.
 * @property {string}  [causeDetail] Short diagnosed cause of a failure ("gradle cannot run on Java 21"), when the producer derived one.
 * @property {string}  [outputExcerpt] Redacted, at most the last 2000 characters of the failed command's combined stdout and stderr, with interior newlines preserved. Suppressed entirely by `CDXGEN_INTROSPECT_NO_OUTPUT`.
 * @property {string}  [remediationId] Key into the remediation catalog (Deliverable 06).
 * @property {string}  [impact]    One of LEDGER_EVENT_IMPACTS.
 * @property {string}  timestamp   ISO 8601.
 */

/**
 * The closed set of event kinds. `kind` is validated against this object: a
 * kind that is not listed is dropped (with a think-log note) rather than
 * recorded, so a producer bug can never fail a customer's SBOM run. Adding a
 * kind here is a schema change; consumers must tolerate unknown kinds by
 * ignoring them.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const LEDGER_EVENT_KINDS = Object.freeze({
  TOOL_EXPECTED: "tool.expected",
  TOOL_RESOLVED: "tool.resolved",
  TOOL_MISSING: "tool.missing",
  TOOL_MISMATCH: "tool.mismatch",
  COMMAND_ATTEMPTED: "command.attempted",
  COMMAND_FAILED: "command.failed",
  FALLBACK_ENGAGED: "fallback.engaged",
  EVIDENCE_DEGRADED: "evidence.degraded",
  LIFECYCLE_CLAIMED: "lifecycle.claimed",
});

const KNOWN_LEDGER_EVENT_KINDS = new Set(Object.values(LEDGER_EVENT_KINDS));

/**
 * The closed set of `impact` values, describing what a degraded outcome costs
 * the fidelity of the generated BOM.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const LEDGER_EVENT_IMPACTS = Object.freeze({
  TRANSITIVE_DEPS: "transitive-deps",
  VERSIONS: "versions",
  INTEGRITY: "integrity",
  LICENSES: "licenses",
  COMPONENTS: "components",
  NONE: "none",
});

/**
 * Reserved `ecosystem` value for events that describe the recorder itself
 * rather than a project ecosystem, such as the truncation marker. Consumers
 * that group events by ecosystem must treat it as a global observation instead
 * of creating an ecosystem entry for it.
 *
 * @type {string}
 */
export const LEDGER_TOOL_ECOSYSTEM = "cdxgen";

/** Default cap on the in-memory event buffer. */
const DEFAULT_MAX_LEDGER_EVENTS = 10000;
/** Smallest usable cap: below this the keep-first-half/keep-last-half split degenerates. */
const MIN_MAX_LEDGER_EVENTS = 10;
/** Largest accepted cap; a larger value would be a memory hazard rather than a configuration. */
const MAX_MAX_LEDGER_EVENTS = 1000000;

/**
 * Module-load snapshot of the build-introspection environment: `CDXGEN_INTROSPECT`
 * is `true`/`1`, or `CDXGEN_INTROSPECT_LEDGER` names a sidecar file. Library
 * callers that configure introspection before importing this module can read
 * it directly; the CLI enables introspection after argument parsing, so every
 * internal gate reads {@link isLedgerEnabled}, which resolves the same
 * environment on each call.
 *
 * @type {boolean}
 */
export const LEDGER_ENABLED =
  ["true", "1"].includes(readEnvironmentVariable("CDXGEN_INTROSPECT")) ||
  Boolean(readEnvironmentVariable("CDXGEN_INTROSPECT_LEDGER"));

/**
 * True when build-introspection recording is enabled for this run: the same
 * environment as {@link LEDGER_ENABLED}, read live. The CLI turns
 * introspection on after argument parsing by setting `CDXGEN_INTROSPECT`, so
 * a module-load snapshot would miss every event recorded after that point;
 * the environment only ever flips in that one direction during a run.
 *
 * @returns {boolean} True when events should be recorded.
 */
/**
 * Whether build introspection is enabled for this run. The flag decides when
 * it was given; otherwise the environment speaks, which is how a run that
 * enabled introspection through a profile reaches the recorders.
 *
 * @param {Object} [options] CLI options.
 * @returns {boolean} True when the run records and reports a verdict.
 */
export function isIntrospectionEnabled(options) {
  if (typeof options?.introspect === "boolean") {
    return options.introspect;
  }
  return ["true", "1"].includes(readEnvironmentVariable("CDXGEN_INTROSPECT"));
}

export function isLedgerEnabled() {
  return (
    ["true", "1"].includes(readEnvironmentVariable("CDXGEN_INTROSPECT")) ||
    Boolean(readEnvironmentVariable("CDXGEN_INTROSPECT_LEDGER"))
  );
}

/**
 * Resolve the in-memory event cap from `CDXGEN_INTROSPECT_MAX_EVENTS`.
 * Non-numeric values fall back to the default; the accepted range is clamped.
 *
 * @param {string|undefined} rawValue Raw environment variable value.
 * @returns {number} Effective event cap.
 */
function resolveMaxLedgerEvents(rawValue) {
  if (rawValue === undefined || rawValue === "") {
    return DEFAULT_MAX_LEDGER_EVENTS;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed)) {
    return DEFAULT_MAX_LEDGER_EVENTS;
  }
  return Math.min(
    Math.max(parsed, MIN_MAX_LEDGER_EVENTS),
    MAX_MAX_LEDGER_EVENTS,
  );
}

const MAX_LEDGER_EVENTS = resolveMaxLedgerEvents(
  readEnvironmentVariable("CDXGEN_INTROSPECT_MAX_EVENTS"),
);
/** Number of leading events never evicted once truncation begins. */
const LEDGER_HEAD_KEEP = Math.floor(MAX_LEDGER_EVENTS / 2);

// The sidecar writer opens lazily on the first recorded event rather than at
// module load, because the CLI can name a sidecar (its own automatic temp
// sidecar or the user's) only after argument parsing. The first open still
// truncates once on the main thread, and every worker instance appends to the
// same path. A path that cannot be opened leaves the writer null and the run
// in-memory-only; JSONL lines are never allowed to spill into the diagnostic
// stream.
const LEDGER_WRITER_UNRESOLVED = Symbol("unresolved");
let ledgerFileWriter = LEDGER_WRITER_UNRESOLVED;

/**
 * Resolve (once) and return the sidecar writer for this thread, or null when
 * no sidecar is configured or the path could not be opened.
 *
 * @returns {Writable|null} The sidecar writer, or null.
 */
function resolveLedgerWriter() {
  if (ledgerFileWriter === LEDGER_WRITER_UNRESOLVED) {
    const ledgerFilePath = readEnvironmentVariable("CDXGEN_INTROSPECT_LEDGER");
    ledgerFileWriter = ledgerFilePath
      ? openSyncFileWriter(ledgerFilePath, null)
      : null;
  }
  return ledgerFileWriter || null;
}

const ledgerEvents = [];
let truncationRecorded = false;
let ledgerFileClosed = false;

/**
 * Credential-name fragments that make a compound name sensitive even when no
 * underscore separates the parts (`PGPASSWORD`, `registryToken`).
 *
 * @type {RegExp}
 */
const COMPOUND_CREDENTIAL_NAME_PATTERN =
  /(?:token|secret|pass(?:word)?|passwd|credential)/i;

/** Short flags whose value is a credential in build-tool command lines. */
const SENSITIVE_SHORT_FLAGS = new Set(["-p"]);

/**
 * Test whether an assignment name (the part before `=` in a command argument)
 * looks like a credential carrier. Leading flag dashes are stripped and every
 * word separator is normalised to the underscore the existing sensitive-name
 * pattern expects: that pattern is written for environment variables, while
 * build-tool properties separate their words with hyphens, dots or colons
 * (`--repo-auth=…`, `-Drepo.auth=…`, `-p:ApiKey=…`) or by case
 * (`-PrepoAuth=…`). A leading JVM-style property letter (`-Dpassword=…`) is
 * also tried, and a compound name whose parts run together (`PGPASSWORD=…`)
 * is caught by the fragment pattern.
 *
 * @param {string} name Assignment name as it appeared in the command.
 * @returns {boolean} True when the name matches the sensitive-name pattern.
 */
function isSensitiveAssignmentName(name) {
  const normalisedName = name.replace(/^-+/, "").replace(/[^A-Za-z0-9]+/g, "_");
  const wordSplitName = normalisedName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2");
  return (
    isSensitiveEnvironmentVariableName(normalisedName) ||
    isSensitiveEnvironmentVariableName(normalisedName.slice(1)) ||
    isSensitiveEnvironmentVariableName(wordSplitName) ||
    COMPOUND_CREDENTIAL_NAME_PATTERN.test(normalisedName)
  );
}

/**
 * Replace the value of every credential-bearing argument with a `[redacted]`
 * marker, preserving all other arguments and whitespace. Both spellings are
 * covered: the assignment form (`--password=x`, `-Dpassword=x`, `PGPASSWORD=x`)
 * redacts within the token itself, and the space-separated flag form
 * (`--password x`, `-p x`, `--registry-token x`) redacts the token that
 * follows the flag.
 *
 * The assignment branch keeps everything after `=` as the value, so a value
 * that runs into trailing punctuation (`FOO=bar)`) loses the punctuation with
 * the value; that is the pre-existing shape of this redactor and is not
 * widened here.
 *
 * @param {string} text Command line or path to scrub.
 * @returns {string} Text with sensitive assignment and flag values replaced.
 */
function redactSensitiveAssignments(text) {
  const pieces = text.split(/(\s+)/);
  for (let index = 0; index < pieces.length; index += 2) {
    const piece = pieces[index];
    const separator = piece.indexOf("=");
    if (separator > 0) {
      if (isSensitiveAssignmentName(piece.slice(0, separator))) {
        pieces[index] = `${piece.slice(0, separator)}=[redacted]`;
      }
      continue;
    }
    if (
      (piece.startsWith("--") && isSensitiveAssignmentName(piece)) ||
      SENSITIVE_SHORT_FLAGS.has(piece)
    ) {
      const valueIndex = index + 2;
      if (pieces[valueIndex] !== undefined) {
        pieces[valueIndex] = "[redacted]";
      }
    }
  }
  return pieces.join("");
}

/**
 * Credential-bearing headers whose value is a credential, echoed by verbose
 * HTTP clients and CI logs. The value runs to the end of the line because a
 * scheme word (`Basic`, `Bearer`) and the token behind it are one value. The
 * header name survives so the output stays diagnosable.
 *
 * @type {RegExp}
 */
const AUTHORIZATION_HEADER_PATTERN =
  /((?:x-)?(?:proxy-)?authorization|cookie)(\s*:\s*)(("[^"]*"|'[^']*')|[^\r\n]*)/giu;

/**
 * A value of any length behind a strong credential name and an unambiguous
 * `:` or `=` separator. A bare name followed only by whitespace stays out of
 * this pattern: prose like "the password is unknown" would otherwise lose
 * words without losing the secret behind them. The rest of the name is bounded
 * to stay linear: an open-ended run is walked again from every credential word
 * inside it, which is quadratic on text such as `passpasspass…`.
 *
 * @type {RegExp}
 */
const CREDENTIAL_NAMED_VALUE_PATTERN =
  /((?:token|secret|pass(?:word)?|passwd|passphrase|credential)[a-z0-9_-]{0,64}\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/giu;

/**
 * A token-shaped run of 32 or more characters beside a credential name, with
 * `:`, `=` or whitespace as the separator. The length floor keeps checksums,
 * digests and base64 artifacts that are not beside a credential name intact.
 * The rest of the name is bounded for the same reason as above.
 *
 * @type {RegExp}
 */
const CREDENTIAL_ADJACENT_VALUE_PATTERN =
  /((?:api[-_]?key|access[-_]?key|secret[-_]?key|key|token|secret|pass(?:word)?|passwd|credential)[a-z0-9_-]{0,64}(?:\s*[=:]\s*|\s+))("[^"\s]{32,}"|'[^'\s]{32,}'|[a-z0-9._~+/=-]{32,})/giu;

/** Placeholder replacing the user's home directory in free-text fields. */
const HOME_DIR_PLACEHOLDER = "~";

/** The user's home directory, resolved once; empty when it names no usable directory. */
let cachedHomeDir;

/**
 * The user's home directory, resolved once, or an empty string when the
 * platform answers with a root-equivalent path that must not be rewritten.
 *
 * @returns {string} Home directory path, or an empty string.
 */
function homeDirPath() {
  if (cachedHomeDir === undefined) {
    let home = "";
    try {
      home = homedir() || "";
    } catch {
      home = "";
    }
    cachedHomeDir = home === "/" || home === "\\" ? "" : home;
  }
  return cachedHomeDir;
}

/**
 * Replace every occurrence of the user's home directory with `~`, so build
 * output that names absolute paths under it stops identifying the machine.
 *
 * @param {string} text Free text of untrusted origin.
 * @returns {string} Text with the home directory path rewritten.
 */
function redactHomeDirectory(text) {
  const home = homeDirPath();
  if (!home || !text.includes(home)) {
    return text;
  }
  return text.split(home).join(HOME_DIR_PLACEHOLDER);
}

/**
 * Scrub a free-text ledger field: home paths first, sensitive assignment and
 * flag values next, credential-bearing headers and adjacent token runs, then
 * the BOM property sanitizer for URL userinfo/query strings and known
 * credential shapes. This is the one redactor every introspection free-text
 * field goes through, in the ledger and in both reports.
 *
 * @param {string} fieldName Ledger field being redacted.
 * @param {string} value Raw field value.
 * @returns {string} Redacted field value.
 */
function redactLedgerText(fieldName, value) {
  // The BOM property sanitizer runs first: it strips URL userinfo and query
  // strings, so the assignment redactor below never meets a query parameter
  // and cannot leave a redaction marker inside a URL.
  let redacted = sanitizeBomPropertyValue(
    fieldName,
    redactHomeDirectory(String(value)),
  );
  redacted = redactSensitiveAssignments(redacted);
  redacted = redacted.replace(
    AUTHORIZATION_HEADER_PATTERN,
    (_match, header, separator) => `${header}${separator}[redacted]`,
  );
  redacted = redacted.replace(
    CREDENTIAL_NAMED_VALUE_PATTERN,
    (_match, prefix) => `${prefix}[redacted]`,
  );
  redacted = redacted.replace(
    CREDENTIAL_ADJACENT_VALUE_PATTERN,
    (_match, prefix) => `${prefix}[redacted]`,
  );
  return redacted;
}

/**
 * Redact a free-text introspection value with the ledger's own redactor. Both
 * report renderers run their free text through this function so a field can
 * never be redacted differently in the ledger, the JSON report and the
 * markdown report.
 *
 * @param {string|undefined} value Free text of untrusted origin.
 * @returns {string|undefined} Redacted text.
 */
export function redactIntrospectionText(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return redactLedgerText("detail", `${value}`);
}

/**
 * Combined stdout and stderr of a spawned command, as the raw material of an
 * output excerpt. Producers that already hold a spawn result call this so the
 * recorder, not the producer, owns truncation and redaction.
 *
 * @param {Object|undefined} spawnResult A spawnSync-style result.
 * @returns {string|undefined} The combined output, or undefined when the command produced none.
 */
export function commandOutputText(spawnResult) {
  if (!spawnResult) {
    return undefined;
  }
  const stdout = spawnResult.stdout ? spawnResult.stdout.toString() : "";
  const stderr = spawnResult.stderr ? spawnResult.stderr.toString() : "";
  const combined = stdout || stderr ? `${stdout}\n${stderr}` : "";
  return combined.trim() ? combined : undefined;
}

/**
 * The tail of a command output, bounded to the excerpt limit. Interior
 * newlines are the signal a reader diagnoses from, so only the edges are
 * trimmed.
 *
 * @param {string} rawOutput Combined command output.
 * @returns {string} At most the last OUTPUT_EXCERPT_LIMIT characters.
 */
function tailExcerpt(rawOutput) {
  const trimmed = rawOutput.trim();
  return trimmed.length > OUTPUT_EXCERPT_LIMIT
    ? trimmed.slice(-OUTPUT_EXCERPT_LIMIT)
    : trimmed;
}

/**
 * Whether another excerpt-bearing event fits inside the event cap. Such an
 * event charges a second slot, so a run that fills its cap with excerpts
 * starts dropping excerpts while every event still lands — a truncated
 * ledger poisons the whole verdict, a missing excerpt degrades one entry.
 *
 * @returns {boolean} True when the excerpt may be stored.
 */
function hasExcerptHeadroom() {
  return ledgerEvents.length + EXCERPT_EVENT_WEIGHT <= MAX_LEDGER_EVENTS;
}

/**
 * Whether the run opted out of carrying tool output at all. `true`/`1` match
 * the CDXGEN_INTROSPECT convention; read live so a run can set the variable
 * after the modules load.
 *
 * @returns {boolean} True when output excerpts must not be recorded.
 */
function outputSuppressed() {
  return ["true", "1"].includes(
    readEnvironmentVariable("CDXGEN_INTROSPECT_NO_OUTPUT"),
  );
}

/**
 * Assemble a stored event from a kind and the producer's fields. Optional
 * fields are kept in schema order and omitted when absent; every stored value
 * is a plain string or number so the JSONL sidecar stays schema-stable.
 *
 * @param {string} kind Validated event kind.
 * @param {Partial<LedgerEvent>} fields Producer-supplied fields.
 * @returns {LedgerEvent} Event ready to store and append to the sidecar.
 */
function buildLedgerEvent(kind, fields) {
  const event = /** @type {LedgerEvent} */ ({ kind });
  event.ecosystem = fields.ecosystem;
  if (fields.tool) {
    event.tool = String(fields.tool);
  }
  if (fields.wanted) {
    event.wanted = String(fields.wanted);
  }
  if (fields.found) {
    event.found = String(fields.found);
  }
  if (fields.source) {
    event.source = String(fields.source);
  }
  if (fields.path) {
    event.path = redactLedgerText("path", fields.path);
  }
  if (fields.command) {
    event.command = redactLedgerText("command", fields.command);
  }
  if (typeof fields.exitCode === "number") {
    event.exitCode = fields.exitCode;
  }
  if (fields.detail) {
    event.detail = redactLedgerText("detail", fields.detail);
  }
  if (fields.causeDetail) {
    event.causeDetail = redactLedgerText("causeDetail", fields.causeDetail);
  }
  if (
    fields.outputExcerpt &&
    `${fields.outputExcerpt}`.trim() &&
    !outputSuppressed() &&
    hasExcerptHeadroom()
  ) {
    event.outputExcerpt = redactLedgerText(
      "outputExcerpt",
      tailExcerpt(`${fields.outputExcerpt}`),
    );
  }
  if (fields.remediationId) {
    event.remediationId = String(fields.remediationId);
  }
  if (fields.impact) {
    event.impact = String(fields.impact);
  }
  event.timestamp = new Date().toISOString();
  return event;
}

/**
 * Append one event to the JSONL sidecar. Failures are swallowed: the sidecar
 * is an observation channel and must never abort BOM generation, and the
 * in-memory buffer still holds the event.
 *
 * @param {LedgerEvent} event Event to append.
 * @returns {void}
 */
function persistLedgerEvent(event) {
  const writer = resolveLedgerWriter();
  if (!writer || ledgerFileClosed) {
    return;
  }
  try {
    writer.write(`${JSON.stringify(event)}\n`);
  } catch {
    // The sidecar is best-effort; the in-memory buffer keeps the event.
  }
}

/**
 * Store an event in the in-memory buffer and persist it. Once the buffer
 * reaches its cap, the first half stays pinned, a single truncation marker is
 * inserted after it, and the tail slides forward one event at a time; the
 * sidecar, when enabled, keeps every event.
 *
 * @param {LedgerEvent} event Event to store.
 * @returns {LedgerEvent} The stored event.
 */
function appendLedgerEvent(event) {
  if (ledgerEvents.length >= MAX_LEDGER_EVENTS) {
    if (!truncationRecorded) {
      truncationRecorded = true;
      // The marker describes the recorder, not the ecosystem whose event
      // happened to reach the cap, so it carries the reserved tool ecosystem.
      const marker = buildLedgerEvent(LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED, {
        ecosystem: LEDGER_TOOL_ECOSYSTEM,
        detail: `The in-memory build ledger reached its cap of ${MAX_LEDGER_EVENTS} events and now keeps only the earliest ${LEDGER_HEAD_KEEP} and the most recent events; the JSONL sidecar, when enabled, retains every event.`,
      });
      ledgerEvents.splice(LEDGER_HEAD_KEEP, 0, marker);
      persistLedgerEvent(marker);
    }
    ledgerEvents.splice(
      LEDGER_HEAD_KEEP + 1,
      ledgerEvents.length + 1 - MAX_LEDGER_EVENTS,
    );
  }
  ledgerEvents.push(event);
  persistLedgerEvent(event);
  return event;
}

/**
 * Record one build-adequacy event. Returns immediately after a single boolean
 * test when introspection is disabled, so producers may pass plain values
 * without gating the call themselves.
 *
 * Events with a kind outside LEDGER_EVENT_KINDS, or without a non-empty
 * `ecosystem`, are dropped with a think-log note instead of throwing: the
 * ledger is instrumentation, and a producer bug must never fail an SBOM run.
 *
 * @param {string} kind Event kind; one of LEDGER_EVENT_KINDS.
 * @param {Partial<LedgerEvent>} [fields] Event fields; `command`, `path`, `detail`, `causeDetail` and `outputExcerpt` are redacted before storage, and `outputExcerpt` is additionally bounded to its tail.
 * @returns {LedgerEvent|undefined} The stored event, or undefined when recording is disabled or the event was dropped.
 */
export function recordLedgerEvent(kind, fields = {}) {
  if (!isLedgerEnabled()) {
    return undefined;
  }
  if (!KNOWN_LEDGER_EVENT_KINDS.has(kind)) {
    thoughtLog(
      `Dropping a build ledger event with unknown kind ${kind}; expected one of ${Object.values(LEDGER_EVENT_KINDS).join(", ")}.`,
    );
    return undefined;
  }
  if (typeof fields?.ecosystem !== "string" || !fields.ecosystem) {
    thoughtLog(
      `Dropping a ${kind} build ledger event without a non-empty ecosystem.`,
    );
    return undefined;
  }
  return appendLedgerEvent(buildLedgerEvent(kind, fields));
}

/**
 * Remediation catalog loaded from `data/remediations.json`, mapping every
 * known `remediationId` to its ecosystem, default event kind and default
 * impact. The ids are a public contract matched by agents, so the catalog file
 * and the ids referenced by producers must stay in lock-step; a poku test
 * asserts the two sets are equal.
 *
 * Loaded lazily on the first {@link recordDegradation} call so a disabled run
 * pays no file read and a missing or unreadable file degrades to a null
 * catalog instead of failing module load.
 *
 * @type {Record<string, {ecosystem: string, kind: string, impact: string, title: string}>|null|undefined}
 */
let remediationCatalog;

/**
 * Load (once) the remediation catalog from `data/remediations.json`.
 *
 * @returns {Record<string, {ecosystem: string, kind: string, impact: string, title: string}>|null} Catalog keyed by id, or null when it cannot be read.
 */
function loadRemediationCatalog() {
  if (remediationCatalog !== undefined) {
    return remediationCatalog;
  }
  try {
    remediationCatalog = JSON.parse(
      readFileSync(join(dirNameStr, "data", "remediations.json"), "utf-8"),
    );
  } catch {
    // The catalog is a data file shipped with cdxgen; its absence means ids
    // cannot be resolved and degradation events would carry no kind.
    remediationCatalog = null;
  }
  return remediationCatalog;
}

/**
 * Resolve the event kind for a remediation id from the catalog.
 *
 * @param {string} remediationId Remediation id to look up.
 * @returns {string|undefined} Default event kind, or undefined when the id is unknown or the catalog is unavailable.
 */
export function remediationKindFor(remediationId) {
  return loadRemediationCatalog()?.[remediationId]?.kind;
}

/**
 * The full remediation catalog, for consumers that need the extended entry
 * fields (target tier, actions, verify clause) rather than a single resolved
 * kind. Returns the cached parsed catalog; null when the data file is
 * missing or unreadable.
 *
 * @returns {Record<string, Object>|null} Catalog keyed by remediation id, or null when unavailable.
 */
export function getRemediationCatalog() {
  return loadRemediationCatalog();
}

/**
 * Record a degraded outcome together with the remediation that would restore
 * the lost evidence. The kind and the remediationId come from the catalog
 * entry for `remediationId`, so a site only supplies the facts it observed;
 * `ecosystem` and `impact` are required from the caller because only the site
 * knows which scanned ecosystem paid the cost and how much. A site whose
 * degradation differs in kind from the catalog default (a command that threw
 * rather than a fallback that engaged) may pass an explicit `kind` in fields.
 *
 * Events for unknown ids are dropped with a think-log note: an id outside the
 * catalog is a producer bug and the catalog is the contract.
 *
 * @param {string} remediationId Key into data/remediations.json.
 * @param {Partial<LedgerEvent> & {kind?: string}} fields Event fields; `ecosystem` and `impact` are required, `kind` overrides the catalog default.
 * @returns {LedgerEvent|undefined} The stored event, or undefined when recording is disabled or the event was dropped.
 */
export function recordDegradation(remediationId, fields = {}) {
  if (!isLedgerEnabled()) {
    return undefined;
  }
  const kind = fields.kind || remediationKindFor(remediationId);
  if (!kind) {
    thoughtLog(
      `Dropping a degradation event for unknown remediationId ${remediationId}; add it to data/remediations.json.`,
    );
    return undefined;
  }
  const { kind: _kindOverride, ...rest } = fields;
  return recordLedgerEvent(kind, {
    ...rest,
    remediationId,
  });
}

/**
 * Snapshot of the events recorded by this thread. Each event and the array
 * itself are frozen, so a consumer cannot mutate the recorder's state.
 * In a multi-worker run this buffer is this thread's view only; the JSONL
 * sidecar is the complete record.
 *
 * @returns {LedgerEvent[]} Frozen array of frozen events.
 */
export function getLedgerEvents() {
  return Object.freeze(
    ledgerEvents.map((event) => Object.freeze({ ...event })),
  );
}

/**
 * Clear the in-memory buffer and the truncation state. Intended for tests; a
 * production run never resets its own ledger, and a process that performs
 * several has it emptied between them by the run reset below. The sidecar
 * file is append-only and is not touched.
 *
 * @returns {void}
 */
export function resetLedgerEvents() {
  ledgerEvents.length = 0;
  truncationRecorded = false;
}

// A process that performs more than one run, such as the server, must not
// judge a run by the events of an earlier one. The reflection prefers the
// sidecar, so the sidecar has to start empty as well as the buffer: opening
// the path again on the main thread truncates it, as the first open did.
registerRunReset("core:build-ledger", () => {
  resetLedgerEvents();
  if (ledgerFileClosed) {
    return;
  }
  if (ledgerFileWriter !== LEDGER_WRITER_UNRESOLVED) {
    ledgerFileWriter?.closeSync();
    ledgerFileWriter = LEDGER_WRITER_UNRESOLVED;
  }
  if (readEnvironmentVariable("CDXGEN_INTROSPECT_LEDGER")) {
    resolveLedgerWriter();
  }
});

/**
 * Parse a JSONL sidecar produced by `CDXGEN_INTROSPECT_LEDGER` back into
 * events. Blank lines and lines that fail to parse — a torn final line from an
 * interrupted run is expected — are skipped. Prefer this over the in-memory
 * buffer whenever the sidecar exists: worker threads append to the same file,
 * so it is the only complete record of a multi-worker run.
 *
 * @param {string} ledgerPath Path to the JSONL sidecar.
 * @returns {LedgerEvent[]} Frozen array of frozen events, empty when the file is missing or unreadable.
 */
export function loadLedgerFile(ledgerPath) {
  const content = safeReadFileSync(ledgerPath, "utf-8");
  if (typeof content !== "string" || !content.length) {
    return Object.freeze([]);
  }
  const events = [];
  for (const line of content.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmedLine);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      events.push(Object.freeze(parsed));
    }
  }
  return Object.freeze(events);
}

/**
 * Close the sidecar descriptor held by this thread. Idempotent; further
 * events stay in memory only. The descriptor is also released when the
 * process exits through `closeLogStreams`.
 *
 * @returns {void}
 */
export function closeLedger() {
  if (ledgerFileClosed) {
    return;
  }
  ledgerFileClosed = true;
  // A writer that was never resolved means no event reached the sidecar, so
  // there is no descriptor to release and no file was created.
  if (ledgerFileWriter !== LEDGER_WRITER_UNRESOLVED) {
    ledgerFileWriter?.closeSync();
  }
}
