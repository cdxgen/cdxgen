import process from "node:process";

import { readEnvironmentVariable } from "../core/activity.js";
import { escapeControlCharacters } from "../core/text.js";
import { createUi } from "../core/ui.js";

/**
 * Build a human-readable label for an audit target.
 *
 * @param {object} target audit target
 * @returns {string} formatted target label
 */
export function formatTargetLabel(target) {
  const namespacePrefix = target?.namespace ? `${target.namespace}/` : "";
  const versionSuffix = target?.version ? `@${target.version}` : "";
  // Names come from the BOM, so control characters are written as escapes.
  return escapeControlCharacters(
    `${target?.type || "pkg"}:${namespacePrefix}${target?.name || "unknown"}${versionSuffix}`,
  );
}

/**
 * Decide if interactive progress should be shown.
 *
 * @param {object} [options] progress options
 * @returns {boolean} true when spinner-style progress is appropriate
 */
export function shouldRenderProgress(options = {}) {
  if (options.enabled === false) {
    return false;
  }
  const stream = options.stream || process.stderr;
  if (!stream?.isTTY) {
    return false;
  }
  return readEnvironmentVariable("CI") !== "true";
}

/**
 * Create a dependency-free progress renderer for cdx-audit.
 *
 * Progress is always written to stderr so JSON/stdout reports remain clean.
 * The renderer delegates the live region to `lib/core/ui.js`: an interactive
 * run shows a single spinner phase whose detail line tracks the current
 * target, while a non-interactive run commits one plain line per state
 * transition.
 *
 * @param {object} [options] progress options
 * @returns {{ onProgress: Function, stop: Function }} progress controller
 */
export function createProgressTracker(options = {}) {
  const stream = options.stream || process.stderr;
  const enabled = shouldRenderProgress({
    enabled: options.enabled,
    stream,
  });
  const uiCtrl = createUi({
    stream,
    interactive: enabled,
    color: false,
    level: 1,
  });
  let phase = null;

  return {
    onProgress(event) {
      const total = event?.total || event?.summary?.totalTargets || 0;
      if (event?.type === "run:info") {
        uiCtrl.print(event.message);
        return;
      }
      if (event?.type === "run:start") {
        // The announcement is a log line in every mode; the phase carries the
        // per-target detail, which only a live region can show.
        uiCtrl.print(`Preparing predictive audit for ${total} package(s)...`);
        phase = uiCtrl.phase(`Auditing ${total} package(s)`);
        return;
      }
      if (event?.type === "target:start") {
        phase?.detail(
          `[${event.index}/${event.total}] ${event.label} — resolving source`,
        );
        return;
      }
      if (event?.type === "target:stage") {
        phase?.detail(
          `[${event.index}/${event.total}] ${event.label} — ${event.stage}`,
        );
        return;
      }
      if (event?.type === "target:finish") {
        const finalSeverity = event?.result?.assessment?.severity || "none";
        const finalStatus =
          event?.result?.status === "audited"
            ? finalSeverity.toUpperCase()
            : event?.result?.status?.toUpperCase() || "DONE";
        uiCtrl.print(
          `[${event.index}/${event.total}] done ${event.label} — ${finalStatus}`,
        );
        return;
      }
      if (event?.type === "run:finish") {
        const summary = event.summary || {};
        // Commit the phase first so the run summary is the last line standing.
        phase?.succeed(`${summary.scannedTargets || 0} audited`);
        phase = null;
        uiCtrl.print(
          `Completed predictive audit: ${summary.scannedTargets || 0}/${summary.totalTargets || 0} scanned, ${summary.erroredTargets || 0} errored, ${summary.skippedTargets || 0} skipped.`,
        );
      }
    },
    stop() {
      phase?.succeed("interrupted");
      phase = null;
      uiCtrl.stop();
    },
  };
}
