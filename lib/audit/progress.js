import process from "node:process";

const ASCII_FRAMES = ["-", "\\", "|", "/"];
const CLEAR_LINE = "\r\x1b[2K";

/**
 * Build a human-readable label for an audit target.
 *
 * @param {object} target audit target
 * @returns {string} formatted target label
 */
export function formatTargetLabel(target) {
  const namespacePrefix = target?.namespace ? `${target.namespace}/` : "";
  const versionSuffix = target?.version ? `@${target.version}` : "";
  return `${target?.type || "pkg"}:${namespacePrefix}${target?.name || "unknown"}${versionSuffix}`;
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
  return process.env.CI !== "true";
}

/**
 * Create a dependency-free progress renderer for cdx-audit.
 *
 * Progress is always written to stderr so JSON/stdout reports remain clean.
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
  let frameIndex = 0;
  let hasActiveLine = false;

  /**
   * Write a line or redraw the active line.
   *
   * @param {string} text output text
   * @param {boolean} persist whether to end the line permanently
   * @returns {void}
   */
  function render(text, persist = false) {
    if (!enabled) {
      if (persist) {
        stream.write(`${text}\n`);
      }
      return;
    }
    stream.write(`${CLEAR_LINE}${text}`);
    hasActiveLine = true;
    if (persist) {
      stream.write("\n");
      hasActiveLine = false;
    }
  }

  /**
   * Produce the next spinner frame.
   *
   * @returns {string} spinner frame
   */
  function nextFrame() {
    const frame = ASCII_FRAMES[frameIndex % ASCII_FRAMES.length];
    frameIndex += 1;
    return frame;
  }

  return {
    onProgress(event) {
      const total = event?.total || event?.summary?.totalTargets || 0;
      if (event?.type === "run:info") {
        render(event.message, true);
        return;
      }
      if (event?.type === "run:start") {
        render(
          `Preparing predictive audit for ${total} package(s)...`,
          !enabled,
        );
        return;
      }
      if (event?.type === "target:start") {
        render(
          `[${event.index}/${event.total}] ${nextFrame()} ${event.label} — resolving source`,
        );
        return;
      }
      if (event?.type === "target:stage") {
        render(
          `[${event.index}/${event.total}] ${nextFrame()} ${event.label} — ${event.stage}`,
        );
        return;
      }
      if (event?.type === "target:finish") {
        const finalSeverity = event?.result?.assessment?.severity || "none";
        const finalStatus =
          event?.result?.status === "audited"
            ? finalSeverity.toUpperCase()
            : event?.result?.status?.toUpperCase() || "DONE";
        render(
          `[${event.index}/${event.total}] done ${event.label} — ${finalStatus}`,
          true,
        );
        return;
      }
      if (event?.type === "run:finish") {
        const summary = event.summary || {};
        render(
          `Completed predictive audit: ${summary.scannedTargets || 0}/${summary.totalTargets || 0} scanned, ${summary.erroredTargets || 0} errored, ${summary.skippedTargets || 0} skipped.`,
          true,
        );
      }
    },
    stop() {
      if (enabled && hasActiveLine) {
        stream.write(CLEAR_LINE);
      }
    },
  };
}
