/**
 * Core collector for AI oversight. Orchestrates the collection of local git
 * signals, optionally enriches with forge (GitHub/GitLab) pull/merge request
 * review data, computes a transparent weighted rigor score, and emits
 * `cdx:ai:oversight:*` CycloneDX properties.
 *
 * When git-ai notes carry AI attribution data, the result also includes
 * `cdx:ai:codegen:gi:*` properties: model names, agent tool names, note/session
 * counts, and total AI-attributed entry counts.
 *
 * Honesty first: local git cannot observe pull-request reviews/approvals, so
 * review-dependent metrics (reviewCoverage, reviewLatencyVsSize, selfMergeRate,
 * verificationDebtRatio) are reported as `unavailable` unless a forge enricher
 * supplies authoritative data. This prevents a git-only scan from falsely
 * reporting "zero oversight".
 *
 * @param {string} dir Root directory of the repository
 * @param {Object} [options] Oversight evaluation options
 * @param {number} [options.gitMaxCount] Max commits to scan (defaults to 20)
 * @param {string} [options.gitAiNotesRef] Git notes ref (defaults to refs/notes/ai)
 * @returns {Promise<Object>} Oversight metrics, score, band, and properties
 */
export function collectAiOversight(dir: string, options?: {
    gitMaxCount?: number | undefined;
    gitAiNotesRef?: string | undefined;
}): Promise<Object>;
//# sourceMappingURL=aiOversightCollector.d.ts.map