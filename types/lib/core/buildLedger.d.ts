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
export type LedgerEvent = {
    /**
     * One of LEDGER_EVENT_KINDS.
     */
    kind: string;
    /**
     * Canonical project type ("java", "npm", "python", …).
     */
    ecosystem: string;
    /**
     * Tool identity ("maven", "gradle", "swift", "dotnet").
     */
    tool?: string;
    /**
     * Version or version range the project asked for.
     */
    wanted?: string;
    /**
     * Version actually resolved, or undefined when absent.
     */
    found?: string;
    /**
     * How `found` was determined ("PATH", "wrapper", "sdkman", "env").
     */
    source?: string;
    /**
     * Absolute path of the resolved tool or the file that was read.
     */
    path?: string;
    /**
     * Command line, already redacted.
     */
    command?: string;
    exitCode?: number;
    /**
     * One sentence, present tense, no remediation text.
     */
    detail?: string;
    /**
     * Short diagnosed cause of a failure ("gradle cannot run on Java 21"), when the producer derived one.
     */
    causeDetail?: string;
    /**
     * Redacted, at most the last 2000 characters of the failed command's combined stdout and stderr, with interior newlines preserved. Suppressed entirely by `CDXGEN_INTROSPECT_NO_OUTPUT`.
     */
    outputExcerpt?: string;
    /**
     * Key into the remediation catalog (Deliverable 06).
     */
    remediationId?: string;
    /**
     * One of LEDGER_EVENT_IMPACTS.
     */
    impact?: string;
    /**
     * ISO 8601.
     */
    timestamp: string;
};
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
export declare const LEDGER_EVENT_KINDS: Readonly<Record<string, string>>;
/**
 * The closed set of `impact` values, describing what a degraded outcome costs
 * the fidelity of the generated BOM.
 *
 * @type {Readonly<Record<string, string>>}
 */
export declare const LEDGER_EVENT_IMPACTS: Readonly<Record<string, string>>;
/**
 * Reserved `ecosystem` value for events that describe the recorder itself
 * rather than a project ecosystem, such as the truncation marker. Consumers
 * that group events by ecosystem must treat it as a global observation instead
 * of creating an ecosystem entry for it.
 *
 * @type {string}
 */
export declare const LEDGER_TOOL_ECOSYSTEM: string;
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
export declare const LEDGER_ENABLED: boolean;
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
export declare function isIntrospectionEnabled(options?: Object): boolean;
export declare function isLedgerEnabled(): boolean;
/**
 * Redact a free-text introspection value with the ledger's own redactor. Both
 * report renderers run their free text through this function so a field can
 * never be redacted differently in the ledger, the JSON report and the
 * markdown report.
 *
 * @param {string|undefined} value Free text of untrusted origin.
 * @returns {string|undefined} Redacted text.
 */
export declare function redactIntrospectionText(value: string | undefined): string | undefined;
/**
 * Combined stdout and stderr of a spawned command, as the raw material of an
 * output excerpt. Producers that already hold a spawn result call this so the
 * recorder, not the producer, owns truncation and redaction.
 *
 * @param {Object|undefined} spawnResult A spawnSync-style result.
 * @returns {string|undefined} The combined output, or undefined when the command produced none.
 */
export declare function commandOutputText(spawnResult: Object | undefined): string | undefined;
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
export declare function recordLedgerEvent(kind: string, fields?: Partial<LedgerEvent>): LedgerEvent | undefined;
/**
 * Resolve the event kind for a remediation id from the catalog.
 *
 * @param {string} remediationId Remediation id to look up.
 * @returns {string|undefined} Default event kind, or undefined when the id is unknown or the catalog is unavailable.
 */
export declare function remediationKindFor(remediationId: string): string | undefined;
/**
 * The full remediation catalog, for consumers that need the extended entry
 * fields (target tier, actions, verify clause) rather than a single resolved
 * kind. Returns the cached parsed catalog; null when the data file is
 * missing or unreadable.
 *
 * @returns {Record<string, Object>|null} Catalog keyed by remediation id, or null when unavailable.
 */
export declare function getRemediationCatalog(): Record<string, Object> | null;
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
export declare function recordDegradation(remediationId: string, fields?: Partial<LedgerEvent> & {
    kind?: string;
}): LedgerEvent | undefined;
/**
 * Snapshot of the events recorded by this thread. Each event and the array
 * itself are frozen, so a consumer cannot mutate the recorder's state.
 * In a multi-worker run this buffer is this thread's view only; the JSONL
 * sidecar is the complete record.
 *
 * @returns {LedgerEvent[]} Frozen array of frozen events.
 */
export declare function getLedgerEvents(): LedgerEvent[];
/**
 * Clear the in-memory buffer and the truncation state. Intended for tests; a
 * production run never resets its own ledger, and a process that performs
 * several has it emptied between them by the run reset below. The sidecar
 * file is append-only and is not touched.
 *
 * @returns {void}
 */
export declare function resetLedgerEvents(): void;
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
export declare function loadLedgerFile(ledgerPath: string): LedgerEvent[];
/**
 * Close the sidecar descriptor held by this thread. Idempotent; further
 * events stay in memory only. The descriptor is also released when the
 * process exits through `closeLogStreams`.
 *
 * @returns {void}
 */
export declare function closeLedger(): void;
//# sourceMappingURL=buildLedger.d.ts.map