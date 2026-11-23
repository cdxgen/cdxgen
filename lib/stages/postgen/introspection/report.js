/**
 * Renderers over a completed reflection document and its scoring document.
 *
 * Every function here is pure: the reflection and scoring documents are the
 * only evidence inputs, nothing reads the filesystem, the ledger, or the BOM
 * again, and nothing writes a file. The caller owns serialization and printing,
 * which is what makes these renderable against a committed fixture without a
 * temporary directory.
 *
 * The markdown report is written for a human reading it in a terminal pager, a
 * CI log, or a pull-request comment: plain GitHub-flavoured markdown, no HTML,
 * no emoji, and a verdict line that carries the right impression on its own.
 * The JSON report is written for the remediation loop: a versioned contract
 * with stable key order and no content that churns between identical runs, so
 * an agent can diff consecutive reports to detect progress. Free text is
 * redacted again here even though the ledger already sanitized it, because
 * this report is the artifact most likely to be pasted into a chat window.
 */

import { redactIntrospectionText } from "../../../core/buildLedger.js";
import { SEVERITY_ORDER } from "../../../core/severity.js";
import { TIER_LADDER } from "./score.js";

/**
 * Version of the JSON report contract. Additive fields bump the minor version;
 * removals or semantic changes bump the major version.
 *
 * @type {string}
 */
export const INTROSPECTION_REPORT_SCHEMA_VERSION = "1.1";

/** Longest free-text span kept whole inside a markdown table cell before an
 * explicit ellipsis marker is appended. */
const CELL_LIMIT = 80;

/** Longest rule-finding prose kept whole in the evidence section. */
const PROSE_LIMIT = 200;

/** Marker appended by the cell and prose truncators. */
const ELLIPSIS = "…";

/**
 * One-line theme for a tier, phrased as what the reader is missing. Rendered
 * in the verdict line, so a reader who stops there still knows what is wrong.
 *
 * @type {Readonly<Record<string, string>>}
 */
const TIER_THEMES = Object.freeze({
  lockfile:
    "the SBOM for {ecosystems} captures pinned versions but not a fully resolved dependency graph",
  manifest: "the SBOM is missing transitive dependencies for {ecosystems}",
  heuristic:
    "components for {ecosystems} were inferred from build artifacts rather than a manifest",
  absent: "no components were produced for {ecosystems}",
});

/**
 * Degradation-impact phrase used as the "why" of a ledger-derived remediation.
 *
 * @type {Readonly<Record<string, string>>}
 */
const IMPACT_WHY = Object.freeze({
  "transitive-deps": "transitive dependency evidence was lost",
  versions: "version precision was lost",
  integrity: "integrity evidence was lost",
  components: "component coverage was lost",
  licenses: "license data was lost",
  none: "evidence was degraded without a measurable component cost",
});

/** Action kinds whose command is a real, copy-pasteable shell command. */
const COMMAND_KINDS = new Set(["install", "build", "container"]);

/**
 * Redact a free-text value before it reaches a report. The ledger already
 * sanitized its own fields; this is the report-side assertion of the same
 * guarantee over every string the renderers emit, through the very same
 * redactor the ledger uses — never a second, weaker one.
 *
 * @param {string|undefined} value Free text of untrusted origin.
 * @returns {string|undefined} Redacted text.
 */
function redacted(value) {
  return redactIntrospectionText(value);
}

/**
 * Sort a copy of a list by one or more string accessors, so no renderer
 * iterates an array whose order depends on how the input was assembled.
 *
 * @param {Object[]} values Array to sort.
 * @param {((value: Object) => string)[]} accessors Ordered sort keys.
 * @returns {Object[]} Sorted copy.
 */
function sortedBy(values, ...accessors) {
  return [...(Array.isArray(values) ? values : [])].sort((a, b) => {
    for (const accessor of accessors) {
      const order = `${accessor(a) || ""}`.localeCompare(
        `${accessor(b) || ""}`,
      );
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  });
}

/**
 * The final path segment of a POSIX or Windows path, used to shorten marker
 * paths in report prose where the directory prefix adds nothing.
 *
 * @param {string} value Opaque path.
 * @returns {string} Basename.
 */
function basenameOf(value) {
  const text = `${value ?? ""}`;
  const slashIndex = text.lastIndexOf("/");
  const backslashIndex = text.lastIndexOf("\\");
  return text.slice(Math.max(slashIndex, backslashIndex) + 1);
}

/**
 * Scored rows in ecosystem order, independent of how the scoring document was
 * assembled.
 *
 * @param {Object} scored Scoring document from scoreReflection.
 * @returns {Object[]} Scored ecosystem rows sorted by name.
 */
function scoredRows(scored) {
  return sortedBy(scored?.ecosystems, (row) => row?.ecosystem);
}

/**
 * Derive the overall tier and confidence labels from the scored rows.
 *
 * The scoring document publishes a number only. Both labels the reports
 * publish are the *worst* among the scored rows: one unhealthy ecosystem must
 * not disappear behind a healthy average, and no report may claim more
 * confidence than its least-corroborated row. A reflection with no scored
 * rows carries no verdict at all, so both labels are null.
 *
 * @param {Object} scored Scoring document from scoreReflection.
 * @returns {{tier: string|null, confidence: string|null}} Worst tier and confidence among the scored rows.
 */
export function overallAssessment(scored) {
  let tier = null;
  let tierRank = -1;
  let confidence = null;
  let confidenceRank = Number.POSITIVE_INFINITY;
  for (const row of scoredRows(scored)) {
    const rank = TIER_LADDER.indexOf(row?.tier);
    if (rank > tierRank) {
      tierRank = rank;
      tier = row?.tier;
    }
    const rankOfConfidence = SEVERITY_ORDER[row?.confidence];
    if (
      typeof rankOfConfidence === "number" &&
      rankOfConfidence < confidenceRank
    ) {
      confidenceRank = rankOfConfidence;
      confidence = row?.confidence;
    }
  }
  return { tier, confidence };
}

/**
 * Escape and bound a value for use inside a markdown table cell: pipes and
 * the backslash that escapes them are both escaped so the table cannot break
 * and a Windows path renders as written, newlines collapse, and long values end
 * with an explicit ellipsis marker rather than being silently cut.
 *
 * @param {string|undefined} value Cell text.
 * @param {number} [limit] Length kept whole before truncation.
 * @returns {string} Cell-safe text.
 */
function mdCell(value, limit = CELL_LIMIT) {
  let text = `${value ?? ""}`.replace(/\r?\n/g, " ").replace(/[\\|]/g, "\\$&");
  if (text.length > limit) {
    text = `${text.slice(0, limit - 1)}${ELLIPSIS}`;
  }
  return text;
}

/**
 * Escape and bound prose for a markdown list item. Unlike table cells the
 * pipe needs no escaping, but long prose is cut at the same explicit marker.
 *
 * @param {string|undefined} value Prose text.
 * @param {number} [limit] Length kept whole before truncation.
 * @returns {string} List-safe text.
 */
function mdProse(value, limit = PROSE_LIMIT) {
  let text = `${value ?? ""}`.replace(/\r?\n/g, " ");
  if (text.length > limit) {
    text = `${text.slice(0, limit - 1)}${ELLIPSIS}`;
  }
  return redacted(text) ?? "";
}

/**
 * One shell-safe command line for a fenced block: newlines collapse and the
 * value is redacted, but the line is never truncated because a cut command is
 * not copy-pasteable.
 *
 * @param {string|undefined} value Command text.
 * @returns {string} Block-safe command line.
 */
function codeLine(value) {
  return `${redacted(value) ?? ""}`.replace(/\r?\n/g, " ").trim();
}

/**
 * A fenced code block whose fence is longer than any backtick run inside the
 * content, so build output that itself contains fenced blocks cannot close
 * the fence early. Interior newlines survive; the content is redacted as a
 * whole so a multi-line value is treated exactly as the ledger treated it.
 *
 * @param {string} info Fence info string.
 * @param {string|undefined} content Block content.
 * @returns {string[]} The block's lines.
 */
function fencedBlock(info, content) {
  const text = `${redacted(content) ?? ""}`;
  let longestRun = 0;
  for (const match of text.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [`${fence}${info}`, ...text.split("\n"), fence];
}

/**
 * The evidence lines of one remediation's failure facts: the failed
 * command with its exit code, the recorded cause, and — for a declared
 * command that arrived with a foreign BOM's formulation — the command named
 * as a hypothesis, in phrasing that can never read as something that ran.
 *
 * @param {Object} entry Remediation entry.
 * @returns {string[]} Evidence lines, empty when the entry carries none.
 */
function evidenceLines(entry) {
  const evidence = entry?.evidence;
  if (!evidence) {
    return [];
  }
  const lines = [];
  if (evidence.failedCommand) {
    const exitCode =
      typeof evidence.exitCode === "number"
        ? ` (exit code ${evidence.exitCode})`
        : "";
    lines.push(`- Failed: \`${codeLine(evidence.failedCommand)}\`${exitCode}`);
  }
  if (evidence.attemptedCommand) {
    lines.push(
      `- Declared by the BOM's formulation, not observed to have run: \`${codeLine(evidence.attemptedCommand)}\``,
    );
  }
  if (evidence.cause) {
    lines.push(`- Cause: ${mdProse(evidence.cause)}`);
  }
  return lines;
}

/**
 * The output excerpt block of one remediation, rendered below the command
 * blocks: reference material a reader diagnoses from, never a step to run.
 *
 * @param {Object} entry Remediation entry.
 * @returns {string[]} Block lines, empty when the run recorded no excerpt.
 */
function excerptLines(entry) {
  const excerpt = entry?.evidence?.outputExcerpt;
  if (!excerpt) {
    return [];
  }
  return [
    "Failed command output (bounded to its last 2000 characters, redacted):",
    "",
    ...fencedBlock("text", excerpt),
    "",
  ];
}

/**
 * An option value as a list of non-empty strings.
 *
 * @param {string|string[]|undefined} value Option value.
 * @returns {string[]} The strings.
 */
function asList(value) {
  return (Array.isArray(value) ? value : [value]).filter(
    (item) => typeof item === "string" && item.length,
  );
}

/**
 * Double-quote a value so a glob such as `test/**` reaches cdxgen as written
 * in both a POSIX shell and cmd.exe, which share the report's command blocks.
 *
 * @param {string} value Value to quote.
 * @returns {string} The quoted value.
 */
function shellQuote(value) {
  return `"${value.replace(/["$`]/g, "\\$&")}"`;
}

/**
 * Rebuild the cdxgen invocation a report describes. The same shape backs the
 * Reproduce section and the re-scan commands proposed to the reader, so every
 * command block in the report can be pasted verbatim.
 *
 * @param {Object} reflection Reflection document.
 * @param {Object} options CLI options.
 * @param {boolean} [options.installDeps] Whether the invocation installs dependencies.
 * @param {string} [options.output] BOM output path.
 * @param {string|string[]} [options.exclude] Exclude glob patterns of the scan.
 * @param {string|string[]} [options.excludeType] Project types left out of the scan.
 * @returns {string} The invocation.
 */
function cdxgenInvocation(reflection, options) {
  const parts = ["cdxgen"];
  const projectTypes = Array.isArray(reflection?.projectTypes)
    ? reflection.projectTypes
    : [];
  if (projectTypes.length) {
    parts.push("-t", projectTypes.join(","));
  }
  parts.push(
    options?.installDeps === false ? "--no-install-deps" : "--install-deps",
  );
  for (const type of asList(options?.excludeType)) {
    parts.push("--exclude-type", shellQuote(type));
  }
  for (const pattern of asList(options?.exclude)) {
    parts.push("--exclude", shellQuote(pattern));
  }
  if (options?.output) {
    parts.push("-o", `${options.output}`);
  }
  if (reflection?.projectPath) {
    parts.push(`${reflection.projectPath}`);
  }
  return parts.join(" ");
}

/**
 * The facts of the scanned BOM the report correlates itself with. Absent
 * facts are dropped rather than emitted as nulls, so consumers can detect
 * what the caller actually knew.
 *
 * @param {Object} reflection Reflection document.
 * @param {Object} options CLI options.
 * @returns {Object|undefined} The bom section.
 */
function bomSection(reflection, options) {
  const section = {};
  if (reflection?.bom?.serialNumber) {
    section.serialNumber = reflection.bom.serialNumber;
  }
  if (Number.isFinite(reflection?.bom?.componentCount)) {
    section.componentCount = reflection.bom.componentCount;
  }
  if (options?.output) {
    section.path = `${options.output}`;
  }
  return Object.keys(section).length ? section : undefined;
}

/**
 * The CI gate result. The gate exists only when the caller configured a
 * threshold; without one there is nothing to publish.
 *
 * @param {Object} scored Scoring document.
 * @param {Object} options CLI options.
 * @returns {Object|undefined} The gate section.
 */
function gateSection(scored, options) {
  const threshold = options?.introspectFailBelow;
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
    return undefined;
  }
  const score =
    typeof scored?.overallScore === "number" ? scored.overallScore : 100;
  return { threshold, passed: score >= threshold };
}

/**
 * Tool fact entries in a fixed key order with their free-text fields redacted:
 * a wanted or found value is whatever the project's own configuration declared,
 * so it reaches the report through the same guarantee as every other string.
 *
 * @param {Object[]} entries Sorted tool entries.
 * @returns {Object[]} The JSON tool entries.
 */
function toolEntriesJson(entries) {
  return entries.map((entry) => ({
    tool: entry?.tool,
    source: entry?.source,
    wanted: redacted(entry?.wanted),
    found: redacted(entry?.found),
    path: redacted(entry?.path),
  }));
}

/**
 * One JSON ecosystem row: the scoring facts joined with the reflection row's
 * tier reasons and tool facts, built in a fixed key order so consecutive
 * reports diff cleanly.
 *
 * @param {Object} row Scored ecosystem row.
 * @param {Object|undefined} reflectionRow Matching reflection row.
 * @returns {Object} The JSON ecosystem entry.
 */
function ecosystemJson(row, reflectionRow) {
  const source = reflectionRow || {};
  return {
    ecosystem: row?.ecosystem,
    state: row?.state,
    tier: row?.tier,
    ceilingTier: row?.ceilingTier,
    score: row?.score,
    confidence: row?.confidence,
    componentCount: row?.componentCount,
    dependencyEdgeCount: row?.dependencyEdgeCount,
    tierReasons: sortedBy(
      source?.tierReasons,
      (reason) => (reason?.determining ? "" : "1"),
      (reason) => reason?.source,
      (reason) => reason?.id,
    ).map((reason) => ({
      source: reason?.source,
      id: reason?.id,
      detail: redacted(reason?.detail),
      determining: reason?.determining === true,
    })),
    tools: {
      expected: toolEntriesJson(
        sortedBy(
          source?.toolsExpected,
          (entry) => entry?.tool,
          (entry) => entry?.source,
          (entry) => entry?.wanted,
        ),
      ),
      resolved: toolEntriesJson(
        sortedBy(
          source?.toolsResolved,
          (entry) => entry?.tool,
          (entry) => entry?.source,
          (entry) => entry?.found,
        ),
      ),
      missing: toolEntriesJson(
        sortedBy(
          source?.toolsMissing,
          (entry) => entry?.tool,
          (entry) => entry?.source,
          (entry) => entry?.wanted,
        ),
      ),
      mismatched: toolEntriesJson(
        sortedBy(
          source?.toolsMismatched,
          (entry) => entry?.tool,
          (entry) => entry?.wanted,
        ),
      ),
    },
  };
}

/**
 * The evidence block of one JSON remediation record: the failure facts the
 * run recorded, rebuilt in a fixed key order with the free text re-redacted.
 * Absent fields are omitted, never null, and the whole block is omitted when
 * the run recorded no failure facts — rule-derived entries carry none.
 *
 * @param {Object|undefined} evidence Evidence facts from the scoring entry.
 * @returns {Object|undefined} The JSON evidence block.
 */
function evidenceJson(evidence) {
  if (!evidence || typeof evidence !== "object") {
    return undefined;
  }
  const block = {};
  if (evidence.failedCommand) {
    block.failedCommand = redacted(evidence.failedCommand);
  }
  if (evidence.attemptedCommand) {
    block.attemptedCommand = redacted(evidence.attemptedCommand);
  }
  if (evidence.attemptedCommandSource) {
    block.attemptedCommandSource = evidence.attemptedCommandSource;
  }
  if (typeof evidence.exitCode === "number") {
    block.exitCode = evidence.exitCode;
  }
  if (evidence.cause) {
    block.cause = redacted(evidence.cause);
  }
  if (evidence.outputExcerpt) {
    block.outputExcerpt = redacted(evidence.outputExcerpt);
  }
  return Object.keys(block).length ? block : undefined;
}

/**
 * One JSON remediation record: the scoring document's entry rebuilt in a
 * fixed key order with free text re-redacted.
 *
 * @param {Object} entry Ranked remediation entry.
 * @returns {Object} The JSON remediation record.
 */
function remediationJson(entry) {
  return {
    remediationId: entry?.remediationId,
    source: entry?.source,
    ecosystem: entry?.ecosystem,
    confidence: entry?.confidence,
    severity: entry?.severity,
    summary: redacted(entry?.summary),
    guidance: entry?.guidance ? redacted(entry.guidance) : undefined,
    impact: entry?.impact,
    targetTier: entry?.targetTier,
    currentScore: entry?.currentScore,
    projectedScore: entry?.projectedScore,
    expectedGain: entry?.expectedGain,
    evidenceCount: entry?.evidenceCount,
    evidence: evidenceJson(entry?.evidence),
    subsumes: Array.isArray(entry?.subsumes) ? entry.subsumes : undefined,
    // Actions keep the catalog's authored sequence — install, then build,
    // then re-run — because the order is the recipe the loop follows.
    actions: (Array.isArray(entry?.actions) ? entry.actions : []).map(
      (action) => ({
        kind: action?.kind,
        tool: action?.tool,
        via: action?.via,
        image: action?.image,
        shapedBy: action?.shapedBy ? redacted(action.shapedBy) : undefined,
        versionFrom: action?.versionFrom,
        versionSource: action?.versionSource
          ? redacted(action.versionSource)
          : undefined,
        versionSourceMissing:
          action?.versionSourceMissing === true ? true : undefined,
        command: redacted(action?.command),
        windows: redacted(action?.windows),
        windowsReason: action?.windowsReason
          ? redacted(action.windowsReason)
          : undefined,
      }),
    ),
    verify: entry?.verify
      ? {
          rules: entry.verify.rules
            ? [...entry.verify.rules].sort()
            : undefined,
          expectTier: entry.verify.expectTier,
          eventsCleared: entry.verify.eventsCleared
            ? [...entry.verify.eventsCleared].sort()
            : undefined,
        }
      : undefined,
    docs: entry?.docs,
    blocked: entry?.blocked === true,
    blockedReason: entry?.blockedReason
      ? redacted(entry.blockedReason)
      : undefined,
  };
}

/**
 * Build the JSON report document, the remediation loop's contract.
 *
 * @param {Object} reflection Reflection document from reflectOnRun.
 * @param {Object} scored Scoring document from scoreReflection.
 * @param {Object} [options] CLI options that name the run's outputs.
 * @param {string} [options.output] Path the BOM was written to.
 * @param {number} [options.introspectFailBelow] CI gate threshold, when configured.
 * @returns {Object} The report document; serializing it is the caller's job.
 */
export function buildIntrospectionJson(reflection, scored, options = {}) {
  const assessment = overallAssessment(scored);
  const rowsByEcosystem = new Map(
    (Array.isArray(reflection?.ecosystems) ? reflection.ecosystems : []).map(
      (row) => [row?.ecosystem, row],
    ),
  );
  return {
    schemaVersion: INTROSPECTION_REPORT_SCHEMA_VERSION,
    runId: reflection?.runId,
    inputsFingerprint: reflection?.inputsFingerprint
      ? `sha256:${reflection.inputsFingerprint}`
      : undefined,
    generatedAt: reflection?.generatedAt,
    cdxgen: {
      version: reflection?.cdxgenVersion,
      runtime: {
        name: reflection?.runtime?.name,
        version: reflection?.runtime?.version,
      },
    },
    bom: bomSection(reflection, options),
    ledger: {
      source: reflection?.ledgerSource,
      complete: reflection?.ledgerComplete !== false,
      eventCount: reflection?.ledgerEventCount ?? 0,
      truncated: reflection?.ledgerComplete === false,
    },
    overall: {
      score: scored?.overallScore,
      tier: assessment.tier,
      confidence: assessment.confidence,
    },
    ecosystems: scoredRows(scored).map((row) =>
      ecosystemJson(row, rowsByEcosystem.get(row?.ecosystem)),
    ),
    coverageGaps: sortedBy(scored?.unsupported, (gap) => gap?.ecosystem).map(
      (gap) => ({
        ecosystem: gap?.ecosystem,
        // Marker basenames only: the report carries no absolute paths beyond
        // the BOM path and the resolved tool paths.
        markers: (Array.isArray(gap?.markersOnDisk)
          ? gap.markersOnDisk
          : []
        ).map((marker) => basenameOf(marker)),
      }),
    ),
    remediation: (Array.isArray(scored?.remediations)
      ? scored.remediations
      : []
    ).map(remediationJson),
    observations: sortedBy(
      reflection?.observations,
      (observation) => observation?.kind,
      (observation) => observation?.ecosystem,
      (observation) => observation?.tool,
      (observation) => observation?.remediationId,
    ).map((observation) => ({
      kind: observation?.kind,
      ecosystem: observation?.ecosystem,
      tool: observation?.tool,
      remediationId: observation?.remediationId,
      impact: observation?.impact,
      detail: redacted(observation?.detail),
      command: redacted(observation?.command),
      exitCode:
        typeof observation?.exitCode === "number"
          ? observation.exitCode
          : undefined,
      causeDetail: redacted(observation?.causeDetail),
      outputExcerpt: redacted(observation?.outputExcerpt),
    })),
    gate: gateSection(scored, options),
  };
}

/**
 * The verdict line: badge (tier and score) plus one sentence carrying the
 * impression a reader must take away even if they stop reading there.
 *
 * At-ceiling rows are successes and never name a theme: a manifest-tier helm
 * chart already holds the best fidelity its ecosystem permits, so accusing it
 * of missing transitive dependencies would misinform the one-line reader.
 * Unsupported-only runs put the coverage gap on cdxgen's side of the ledger.
 *
 * @param {Object} _reflection Reflection document (unused; the verdict reads the scoring).
 * @param {Object} scored Scoring document.
 * @returns {string} The verdict line.
 */
function verdictLine(_reflection, scored) {
  const { tier } = overallAssessment(scored);
  const rows = scoredRows(scored);
  const score = scored?.overallScore ?? 100;
  const remediations = Array.isArray(scored?.remediations)
    ? scored.remediations
    : [];
  const gaps = Array.isArray(scored?.unsupported) ? scored.unsupported : [];
  const concernRows = rows.filter((row) => row?.state !== "at-ceiling");
  const sentence = (() => {
    if (remediations.length) {
      const worstRank = concernRows.reduce(
        (worst, row) =>
          Math.max(worst, TIER_LADDER.indexOf(row?.tier ?? "absent")),
        -1,
      );
      const names = concernRows
        .filter(
          (row) => TIER_LADDER.indexOf(row?.tier ?? "absent") === worstRank,
        )
        .map((row) => row?.ecosystem)
        .filter(Boolean);
      const theme =
        TIER_THEMES[TIER_LADDER[worstRank]] ||
        `the SBOM fidelity tier for {ecosystems} is ${TIER_LADDER[worstRank] || "unknown"}`;
      return `${theme.replace("{ecosystems}", names.join(", "))}; ${remediations.length} remediation(s) proposed`;
    }
    const absentNames = concernRows
      .filter((row) => row?.state === "absent")
      .map((row) => row?.ecosystem)
      .filter(Boolean);
    if (absentNames.length) {
      return TIER_THEMES.absent.replace("{ecosystems}", absentNames.join(", "));
    }
    if (concernRows.length) {
      return "no remediations are pending; the SBOM reflects everything this environment can resolve";
    }
    const gapNames = gaps.map((gap) => gap?.ecosystem).filter(Boolean);
    if (gapNames.length) {
      return `cdxgen cannot parse ${gapNames.join(", ")} yet — a coverage gap in cdxgen, not a defect in your project`;
    }
    return "every scanned ecosystem is at its best achievable fidelity; nothing needs fixing";
  })();
  const tierLabel = tier ?? "ungraded";
  return `Overall: ${tierLabel} (${score}/100) — ${sentence}.`;
}

/**
 * Warnings about the report itself: the conditions under which its own
 * verdicts deserve suspicion. Rendered above the findings, never at the
 * bottom.
 *
 * @param {Object} reflection Reflection document.
 * @param {Object} scored Scoring document.
 * @returns {string[]} Warning sentences.
 */
function reportWarnings(reflection, scored) {
  const warnings = [];
  if (reflection?.ledgerSource === "none") {
    warnings.push(
      "No build ledger was available (this BOM was audited without a cdxgen run), so verdicts rest on BOM structure alone.",
    );
  }
  if (
    reflection?.formulation?.origin === "foreign" &&
    Array.isArray(reflection?.formulation?.tools) &&
    reflection.formulation.tools.length
  ) {
    warnings.push(
      "The BOM's formulation records the toolchain and CI commands of the machine that generated it, not this one; remediations derived from it describe that environment and its confidence is capped at medium.",
    );
  }
  if (reflection?.ledgerComplete === false) {
    warnings.push(
      "The build ledger was truncated before the run finished, so findings may be incomplete; re-run with CDXGEN_INTROSPECT_LEDGER set to capture every event.",
    );
  }
  const observations = Array.isArray(reflection?.observations)
    ? reflection.observations
    : [];
  if (
    observations.some(
      (observation) => observation?.kind === "ledger.memory-only",
    )
  ) {
    warnings.push(
      "The ledger was read from this thread's memory, so worker-thread events are missing; set CDXGEN_INTROSPECT_LEDGER to capture them in a sidecar.",
    );
  }
  const lostImages = observations.filter(
    (observation) =>
      observation?.kind === "evidence.degraded" &&
      observation?.ecosystem === "container" &&
      observation?.impact === "components",
  );
  if (lostImages.length) {
    warnings.push(
      `${lostImages.length} container image(s) named by the scanned manifests could not be pulled or exported, so their packages are not in the BOM and the verdict does not cover them.`,
    );
  }
  const lowRows = scoredRows(scored).filter((row) => row?.confidence === "low");
  if (
    lowRows.length &&
    reflection?.ledgerSource !== "none" &&
    reflection?.ledgerComplete !== false
  ) {
    const names = lowRows.map((row) => row?.ecosystem).join(", ");
    warnings.push(
      `The verdict for ${names} rests on marker detection alone (low confidence); a ledger sidecar would corroborate it.`,
    );
  }
  return warnings;
}

/**
 * A rendered markdown table from header and row cells.
 *
 * @param {string[]} header Header cells.
 * @param {string[][]} rows Body rows of cells.
 * @returns {string[]} Table lines.
 */
function markdownTable(header, rows) {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ];
}

/**
 * The per-ecosystem table: ecosystem, tier, score, components, edges,
 * confidence. At-ceiling rows are successes and read as such.
 *
 * @param {Object[]} rows Scored rows.
 * @returns {string[]} Table lines.
 */
function ecosystemTable(rows) {
  return markdownTable(
    ["ecosystem", "tier", "score", "components", "edges", "confidence"],
    rows.map((row) => [
      mdCell(row?.ecosystem),
      mdCell(row?.tier),
      mdCell(row?.score),
      mdCell(row?.componentCount),
      mdCell(row?.dependencyEdgeCount),
      mdCell(row?.confidence),
    ]),
  );
}

/**
 * The tool-facts table for one ecosystem: one row per tool joining what was
 * expected, resolved, missing and mismatched during the run.
 *
 * @param {Object} reflectionRow Reflection row.
 * @returns {string[]} Table lines, empty when the run recorded no tool facts.
 */
function toolFactsTable(reflectionRow) {
  const byTool = new Map();
  const rowFor = (tool) => {
    let row = byTool.get(tool);
    if (!row) {
      row = { expected: [], resolved: [], missing: [], mismatched: [] };
      byTool.set(tool, row);
    }
    return row;
  };
  for (const entry of reflectionRow?.toolsExpected || []) {
    rowFor(entry?.tool).expected.push(`${entry?.wanted} (${entry?.source})`);
  }
  for (const entry of reflectionRow?.toolsResolved || []) {
    rowFor(entry?.tool).resolved.push(
      `${entry?.found || "present"} (${entry?.source})`,
    );
  }
  for (const entry of reflectionRow?.toolsMissing || []) {
    rowFor(entry?.tool).missing.push(`yes (${entry?.source})`);
  }
  for (const entry of reflectionRow?.toolsMismatched || []) {
    rowFor(entry?.tool).mismatched.push(
      `wanted ${entry?.wanted}, found ${entry?.found}`,
    );
  }
  if (!byTool.size) {
    return [];
  }
  return markdownTable(
    ["tool", "expected", "resolved", "missing", "mismatched"],
    sortedBy([...byTool.entries()], (entry) => entry[0]).map(
      ([tool, facts]) => [
        mdCell(tool),
        mdCell(facts.expected.sort().join("; ")),
        mdCell(facts.resolved.sort().join("; ")),
        mdCell(facts.missing.sort().join("; ")),
        mdCell(facts.mismatched.sort().join("; ")),
      ],
    ),
  );
}

/**
 * The verification sentence of a remediation, composed from whatever checks
 * its verify clause carries.
 *
 * @param {Object} verify Verify clause.
 * @returns {string} The sentence, or an empty string when nothing is checkable.
 */
function verifySentence(verify) {
  const parts = [];
  const rules = Array.isArray(verify?.rules) ? verify.rules : [];
  if (rules.length) {
    parts.push(
      `${rules.map((rule) => `\`${rule}\``).join(", ")} no longer fire${rules.length === 1 ? "s" : ""}`,
    );
  }
  if (verify?.expectTier) {
    parts.push(`the tier reaches \`${verify.expectTier}\``);
  }
  const events = Array.isArray(verify?.eventsCleared)
    ? verify.eventsCleared
    : [];
  if (events.length) {
    parts.push(
      `no further \`${events.join("`, `")}\` event${events.length === 1 ? " is" : "s are"} recorded`,
    );
  }
  if (!parts.length) {
    return "";
  }
  return `Confirm ${parts.join(" and ")}.`;
}

/**
 * The command blocks and notes of one remediation. POSIX and Windows variants
 * live in separate fenced blocks; prose-only actions and the re-run reminder
 * become notes, because pasting prose into a shell helps nobody.
 *
 * @param {Object} entry Remediation entry.
 * @param {Object} reflection Reflection document.
 * @param {Object} options CLI options.
 * @returns {string[]} Block and note lines.
 */
function commandBlocks(entry, reflection, options) {
  const lines = [];
  const actions = Array.isArray(entry?.actions) ? entry.actions : [];
  const posix = [];
  const windows = [];
  const windowsComments = [];
  const notes = [];
  let hasCommands = false;
  for (const action of actions) {
    // The provenance of a substituted version — and the explicit absence of
    // one — belongs next to the command blocks, or an unsubstituted
    // `{{version}}` reads like a template bug rather than a question to ask.
    if (action?.versionSourceMissing) {
      notes.push(
        `no version for \`${action?.tool}\` was recorded by this run, so \`{{version}}\` is left unsubstituted — ask the user which version to install; never invent one`,
      );
    } else if (action?.versionSource) {
      notes.push(
        `${action?.tool} version ${mdProse(action.versionSource)} (${action.versionFrom})`,
      );
    }
    if (action?.shapedBy) {
      notes.push(
        `the command was shaped for this project (${mdProse(action.shapedBy)})`,
      );
    }
    if (!COMMAND_KINDS.has(action?.kind) || !action?.command) {
      if (action?.kind === "rerun") {
        notes.push(
          "Re-run the cdxgen invocation from the Reproduce section to confirm the fix.",
        );
      } else if (action?.command) {
        notes.push(`${action.kind}: ${mdProse(action.command)}`);
      }
      continue;
    }
    hasCommands = true;
    posix.push(codeLine(action.command));
    if (typeof action.windows === "string") {
      windows.push(codeLine(action.windows));
    } else if (action.windows === null) {
      windowsComments.push(
        `# no Windows equivalent: ${mdProse(action.windowsReason || "unspecified")}`,
      );
      windows.push(null);
    } else {
      windows.push(codeLine(action.command));
    }
  }
  if (!hasCommands && entry?.source === "rule") {
    // A rule-derived remediation has no catalog actions; the report proposes
    // the re-scan in which cdxgen itself drives the ecosystem's resolver, the
    // same fix the rule's mitigation names, so the reader always has a
    // pasteable first step.
    const invocation = cdxgenInvocation(reflection, {
      ...options,
      installDeps: true,
    });
    posix.push(codeLine(invocation));
    windows.push(codeLine(invocation));
    hasCommands = true;
  }
  if (hasCommands) {
    lines.push("POSIX:", "", "```sh", ...posix, "```", "");
    const windowsLines = windows.map((line) =>
      line === null ? windowsComments.shift() : line,
    );
    lines.push("Windows:", "", "```bat", ...windowsLines, "```", "");
  }
  if (notes.length) {
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * One numbered remediation section.
 *
 * @param {number} number Section number in ranked order.
 * @param {Object} entry Remediation entry.
 * @param {Object} reflection Reflection document.
 * @param {Object} options CLI options.
 * @returns {string[]} Section lines.
 */
function remediationSection(number, entry, reflection, options) {
  const lines = [];
  const why = entry?.guidance
    ? mdProse(entry.guidance)
    : `${
        IMPACT_WHY[entry?.impact] ||
        "recorded events degraded the build evidence"
      } (${entry?.evidenceCount || 1} event${(entry?.evidenceCount || 1) === 1 ? "" : "s"}).`;
  lines.push(
    `### ${number}. ${mdProse(entry?.summary || entry?.remediationId)}`,
    "",
  );
  lines.push(
    `- Remediation: \`${entry?.remediationId}\` (source: ${entry?.source}) — ecosystem: \`${entry?.ecosystem}\`, confidence: ${entry?.confidence}`,
  );
  lines.push(`- Why: ${why}`);
  lines.push(...evidenceLines(entry));
  lines.push(
    `- Score: ${entry?.currentScore} → ${entry?.projectedScore} (tier \`${entry?.targetTier}\`); expected overall gain: +${Number(entry?.expectedGain ?? 0).toFixed(2)}`,
  );
  const subsumes = Array.isArray(entry?.subsumes) ? entry.subsumes : [];
  if (subsumes.length) {
    lines.push(
      `- Also resolves: ${subsumes.map((rule) => `\`${rule}\``).join(", ")}`,
    );
  }
  const verify = verifySentence(entry?.verify);
  if (verify) {
    lines.push(`- ${verify}`);
  }
  if (entry?.docs) {
    lines.push(`- Docs: ${entry.docs}`);
  }
  lines.push("");
  lines.push(...commandBlocks(entry, reflection, options));
  lines.push(...excerptLines(entry));
  return lines;
}

/**
 * Render the markdown report.
 *
 * @param {Object} reflection Reflection document from reflectOnRun.
 * @param {Object} scored Scoring document from scoreReflection.
 * @param {Object} [options] CLI options that name the run's outputs.
 * @param {string} [options.output] Path the BOM was written to.
 * @param {boolean} [options.installDeps] Whether the run installs dependencies.
 * @returns {string} The complete markdown report.
 */
export function renderIntrospectionMarkdown(reflection, scored, options = {}) {
  const lines = [];
  const rows = scoredRows(scored);
  const remediations = Array.isArray(scored?.remediations)
    ? scored.remediations
    : [];
  const actionable = remediations.filter((entry) => entry?.blocked !== true);
  const blocked = remediations.filter((entry) => entry?.blocked === true);
  const gaps = sortedBy(scored?.unsupported, (gap) => gap?.ecosystem);
  const reflectionRows = new Map(
    (Array.isArray(reflection?.ecosystems) ? reflection.ecosystems : []).map(
      (row) => [row?.ecosystem, row],
    ),
  );

  lines.push("# cdxgen build introspection", "");
  lines.push(verdictLine(reflection, scored), "");

  const warnings = reportWarnings(reflection, scored);
  if (warnings.length) {
    lines.push("## Warnings about this report", "");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  if (rows.length) {
    lines.push("## Ecosystems", "");
    lines.push(...ecosystemTable(rows), "");
  }

  if (gaps.length) {
    lines.push("## cdxgen coverage gaps", "");
    lines.push(
      "The following ecosystems have markers on disk but no cdxgen project type yet, so nothing was parsed. This is a gap in cdxgen's ecosystem coverage, not a problem with your project; it belongs on cdxgen's backlog.",
      "",
    );
    for (const gap of gaps) {
      const markers = (
        Array.isArray(gap?.markersOnDisk) ? gap.markersOnDisk : []
      )
        .map((marker) => `\`${mdCell(basenameOf(marker))}\``)
        .join(", ");
      lines.push(
        `- \`${mdCell(gap?.ecosystem)}\`${markers ? ` — markers: ${markers}` : ""}`,
      );
    }
    lines.push("");
  }

  if (actionable.length) {
    lines.push("## What to fix", "");
    lines.push("Ranked by expected score gain.", "");
    for (const [index, entry] of actionable.entries()) {
      lines.push(...remediationSection(index + 1, entry, reflection, options));
    }
  }

  if (blocked.length) {
    lines.push("## Cannot be fixed from this environment", "");
    lines.push(
      "These remediations would help, but a constraint of this run blocks them. Lift the constraint and they become actionable.",
      "",
    );
    for (const [index, entry] of blocked.entries()) {
      lines.push(
        ...remediationSection(
          actionable.length + index + 1,
          entry,
          reflection,
          options,
        ),
      );
      lines.push(
        `- Blocked: ${mdProse(entry?.blockedReason || "reason not recorded")}`,
        "",
      );
    }
  }

  const evidenceRows = rows.filter((row) => reflectionRows.get(row?.ecosystem));
  if (evidenceRows.length || (reflection?.globalFindings || []).length) {
    lines.push("## Evidence", "");
    for (const row of evidenceRows) {
      const reflectionRow = reflectionRows.get(row?.ecosystem);
      lines.push(`### ${mdCell(row?.ecosystem)}`, "");
      const toolLines = toolFactsTable(reflectionRow);
      if (toolLines.length) {
        lines.push("Tools:", "", ...toolLines, "");
      }
      const findings = sortedBy(
        reflectionRow?.findings,
        (finding) => finding?.ruleId,
        (finding) => finding?.message,
      );
      if (findings.length) {
        if (row?.state === "at-ceiling") {
          lines.push(
            "Rule findings (informational — this ecosystem already parses at its best achievable fidelity, so no action is proposed):",
            "",
          );
        } else {
          lines.push("Rule findings:", "");
        }
        for (const finding of findings) {
          lines.push(
            `- **${mdCell(finding?.ruleId)}** (${mdCell(finding?.severity)}): ${mdProse(finding?.message)}`,
          );
        }
        lines.push("");
      }
    }
    const globalFindings = sortedBy(
      reflection?.globalFindings,
      (finding) => finding?.ruleId,
      (finding) => finding?.message,
    );
    if (globalFindings.length) {
      lines.push("### global", "");
      lines.push("Findings that could not be attributed to one ecosystem:", "");
      for (const finding of globalFindings) {
        lines.push(
          `- **${mdCell(finding?.ruleId)}** (${mdCell(finding?.severity)}): ${mdProse(finding?.message)}`,
        );
      }
      lines.push("");
    }
  }

  lines.push("## Reproduce", "");
  lines.push(
    "```sh",
    codeLine(cdxgenInvocation(reflection, options)),
    "```",
    "",
  );
  const facts = [];
  if (reflection?.cdxgenVersion) {
    facts.push(
      `cdxgen version: \`${reflection.cdxgenVersion}\`; runtime: ${reflection?.runtime?.name || "unknown"} ${reflection?.runtime?.version || ""}`.trimEnd(),
    );
  }
  if (reflection?.inputsFingerprint) {
    facts.push(
      `Inputs fingerprint: \`sha256:${reflection.inputsFingerprint}\``,
    );
  }
  for (const fact of facts) {
    lines.push(`- ${fact}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the console summary: a handful of diagnostic lines carrying the
 * verdict, the remediation counts, and the paths the reports were written
 * to. The full report never goes to the console.
 *
 * @param {Object} scored Scoring document from scoreReflection.
 * @param {Object} [options] CLI options naming the report outputs.
 * @param {string} [options.introspectReport] Path of the markdown report.
 * @param {string} [options.introspectJson] Path of the JSON report.
 * @returns {string} Newline-terminated lines for the diagnostic stream.
 */
export function renderIntrospectionConsole(scored, options = {}) {
  const { tier, confidence } = overallAssessment(scored);
  const remediations = Array.isArray(scored?.remediations)
    ? scored.remediations
    : [];
  const blocked = remediations.filter(
    (entry) => entry?.blocked === true,
  ).length;
  const gaps = Array.isArray(scored?.unsupported)
    ? scored.unsupported.length
    : 0;
  const lines = [
    `Build introspection: overall ${tier ?? "ungraded"} (${scored?.overallScore ?? 100}/100), confidence ${confidence ?? "n/a"}`,
  ];
  const counts = [`${remediations.length} remediation(s) ranked`];
  if (blocked) {
    counts.push(`${blocked} blocked`);
  }
  if (gaps) {
    counts.push(`${gaps} coverage gap(s)`);
  }
  lines.push(`Build introspection: ${counts.join(", ")}`);
  if (options?.introspectReport) {
    lines.push(
      `Build introspection: markdown report: ${options.introspectReport}`,
    );
  }
  if (options?.introspectJson) {
    lines.push(`Build introspection: json report: ${options.introspectJson}`);
  }
  return `${lines.join("\n")}\n`;
}
