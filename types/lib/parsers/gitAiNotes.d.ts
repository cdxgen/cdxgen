/**
 * Tolerant parser for git-ai notes.
 *
 * Supports three shapes, all degrading gracefully (never throws):
 *  1. The real git-ai `authorship/*` schema: per-file attribution blocks
 *     followed by a `---` separator and a JSON metadata block carrying
 *     `sessions` (each with an `agent_id` describing the AI tool/model).
 *  2. A flat JSON object `{ agent, model, session, prompt, lines, ranges }`.
 *  3. Line-oriented `key: value` / `key = value` text.
 *
 * @param {string} raw Raw git note content
 * @returns {Object} Extracted fields { agent, model, session, prompt, lines, ranges, sessions, prompts, agents, models, aiAttributionCount }
 */
export function parseGitAiNote(raw: string): Object;
//# sourceMappingURL=gitAiNotes.d.ts.map