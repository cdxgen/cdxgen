/**
 * Live-region CLI UI controller.
 *
 * Layer 0: imports nothing outside `lib/core`. The mechanism is a single live
 * region: a block of lines rewritten in place by rewinding only by the previous
 * frame's height. The block never ends with a newline until `stop()`, so every
 * update is a single `write` and a crashed process can never leave a torn frame
 * on screen.
 *
 * The UX layer on top is the phase model: `ui.phase(label)` returns a handle
 * whose `detail`/`progress`/`succeed`/`fail`/`skip` calls drive the region. In
 * non-interactive mode the same calls emit at most one plain line per state
 * transition, so callers never branch on `ui.interactive`.
 */

import process from "node:process";
import { formatWithOptions, inspect } from "node:util";

import { readEnvironmentVariable } from "./activity.js";
import { diagnosticStream, TRACE_MODE, traceLog } from "./logger.js";
import { stringWidth, stripAnsi } from "./text.js";

// Frame interval, and the floor on how often detail/progress updates redraw.
// Updates arriving faster than this are coalesced by the refresh timer.
const REFRESH_MS = 80;

// Glyph sets. Unicode support is a separate capability from color: a redirected
// UTF-8 log file takes the glyphs happily, while a legacy Windows console
// renders them as boxes whether or not it does color.
const GLYPHS = {
  unicode: {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    ellipsis: "…",
    succeeded: "✔",
    failed: "✖",
    skipped: "→",
  },
  ascii: {
    // The frames lib/audit/progress.js used before this module existed.
    frames: ["-", "\\", "|", "/"],
    ellipsis: "...",
    succeeded: "+",
    failed: "x",
    skipped: "~",
  },
};

// Semantic colors — only emitted when `color` is true.
const COLOR = {
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
};

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[2K";
const CURSOR_UP_CLEAR = "\x1b[1A\x1b[2K";

const LEVEL_SILENT = 0;
const LEVEL_NORMAL = 1;
const LEVEL_VERBOSE = 2;
const LEVEL_DEBUG = 3;

const LEVEL_NAMES = new Map([
  ["silent", LEVEL_SILENT],
  ["quiet", LEVEL_SILENT],
  ["error", LEVEL_SILENT],
  ["normal", LEVEL_NORMAL],
  ["info", LEVEL_NORMAL],
  ["warn", LEVEL_NORMAL],
  ["verbose", LEVEL_VERBOSE],
  ["debug", LEVEL_DEBUG],
]);

// Phase status → the color and log level its committed line uses. The marker
// glyph comes from the resolved glyph set.
const PHASE_OUTCOMES = {
  succeeded: { color: COLOR.green, level: "info" },
  failed: { color: COLOR.red, level: "error" },
  skipped: { color: COLOR.yellow, level: "warn" },
};

/**
 * Resolve a capability snapshot for the live region. Re-runs cleanly when given
 * `overrides` (used by tests with a fake stream and a captive env object).
 *
 * `FORCE_COLOR` non-empty wins over `isatty()`; `TERM` in {dumb, unknown}
 * forces non-interactive; `NO_COLOR` non-empty disables color but not the live
 * region; `CDXGEN_NO_PROGRESS` and `CI=true` disable the live region. A worker
 * thread needs no special case: its stdio is a pipe, so `isTTY` is undefined.
 *
 * @param {object} [overrides] Overrides for stream, env, and resolved flags
 * @returns {{stream: object, interactive: boolean, color: boolean, unicode: boolean, glyphs: object, columns: () => number, rows: () => number}} Capability snapshot
 */
export function detectCapabilities(overrides = {}) {
  // `CDXGEN_LOG_STREAM=stdout` is the documented escape hatch for callers that
  // scraped v12's stdout. Resolving the destination here rather than pinning
  // stderr is what makes it apply to the region, the banners and the tables
  // instead of only to the thought and trace logs.
  const stream = overrides.stream || diagnosticStream;
  const env = overrides.env;
  const read = (name) => (env ? env[name] : readEnvironmentVariable(name));
  const isSet = (name) => {
    const value = read(name);
    return value !== undefined && value !== null && value !== "";
  };
  const term = `${read("TERM") || ""}`.toLowerCase();
  const isDumbTerm = term === "dumb" || term === "unknown";
  const ci = `${read("CI") || ""}`.toLowerCase() === "true";
  const noProgressEnv = `${read("CDXGEN_NO_PROGRESS") || ""}`.toLowerCase();
  const noProgress =
    overrides.noProgress === true ||
    noProgressEnv === "true" ||
    noProgressEnv === "1";
  const interactive =
    overrides.interactive !== undefined
      ? !!overrides.interactive
      : stream?.isTTY === true && !isDumbTerm && !ci && !noProgress;
  const color =
    overrides.color !== undefined
      ? !!overrides.color
      : isSet("FORCE_COLOR") || (interactive && !isSet("NO_COLOR"));
  // Legacy Windows consoles draw braille and box-drawing glyphs as boxes.
  // Windows Terminal and VS Code advertise themselves, and every other platform
  // is assumed UTF-8 capable. CDXGEN_UNICODE overrides the guess either way.
  const unicodeEnv = `${read("CDXGEN_UNICODE") || ""}`.toLowerCase();
  let unicode;
  if (overrides.unicode !== undefined) {
    unicode = !!overrides.unicode;
  } else if (unicodeEnv === "true" || unicodeEnv === "1") {
    unicode = true;
  } else if (unicodeEnv === "false" || unicodeEnv === "0") {
    unicode = false;
  } else {
    unicode =
      process.platform !== "win32" ||
      isSet("WT_SESSION") ||
      read("TERM_PROGRAM") === "vscode";
  }
  return {
    stream,
    interactive,
    color,
    unicode,
    glyphs: unicode ? GLYPHS.unicode : GLYPHS.ascii,
    // Read per frame so a terminal resize self-corrects on the next tick.
    columns: () => (Number(stream?.columns) > 0 ? Number(stream.columns) : 80),
    rows: () => (Number(stream?.rows) > 0 ? Number(stream.rows) : 25),
  };
}

/**
 * Resolve the verbosity level. Existing debug env vars win over the flag so no
 * user's CI breaks.
 *
 * @param {number|string} [explicit] Flag-derived level
 * @returns {number} Level in 0..3
 */
function resolveLevel(explicit) {
  const named = LEVEL_NAMES.get(
    `${readEnvironmentVariable("CDXGEN_LOG_LEVEL") || ""}`.toLowerCase(),
  );
  if (named !== undefined) {
    return named;
  }
  if (
    readEnvironmentVariable("CDXGEN_DEBUG_MODE") === "debug" ||
    readEnvironmentVariable("SCAN_DEBUG_MODE") === "debug"
  ) {
    return LEVEL_DEBUG;
  }
  if (explicit === undefined || explicit === null) {
    return LEVEL_NORMAL;
  }
  const numeric = Number(explicit);
  if (!Number.isFinite(numeric)) {
    return LEVEL_NAMES.get(`${explicit}`.toLowerCase()) ?? LEVEL_NORMAL;
  }
  return Math.max(LEVEL_SILENT, Math.min(LEVEL_DEBUG, Math.round(numeric)));
}

/**
 * Resolve the log serialization format. The env var wins over the flag.
 *
 * @param {string} [explicit] Flag-derived format
 * @returns {("text"|"json")} Resolved format
 */
function resolveFormat(explicit) {
  const fromEnv =
    `${readEnvironmentVariable("CDXGEN_LOG_FORMAT") || ""}`.toLowerCase();
  if (fromEnv === "json" || fromEnv === "text") {
    return fromEnv;
  }
  return `${explicit || ""}`.toLowerCase() === "json" ? "json" : "text";
}

/**
 * Select a spinner frame from elapsed wall-clock time, so the animation runs at
 * the right rate however often refresh fires and re-rendering during a print
 * never advances it.
 *
 * @param {number} startedAt Phase start timestamp
 * @param {number} now Current timestamp
 * @param {string[]} frames Frame set
 * @returns {string} The frame for this instant
 */
function spinnerFrame(startedAt, now, frames) {
  const elapsed = Math.max(0, now - startedAt);
  return frames[Math.floor(elapsed / REFRESH_MS) % frames.length];
}

/**
 * Render a determinate progress bar.
 *
 * @param {number} done Completed units
 * @param {number} total Total units
 * @param {number} width Total bar width including brackets
 * @returns {string} Rendered bar, or "" when total is not positive
 */
function renderBar(done, total, width) {
  const safeTotal = Number(total) || 0;
  if (safeTotal <= 0) {
    return "";
  }
  const safeDone = Math.max(0, Math.min(safeTotal, Number(done) || 0));
  const innerWidth = Math.max(4, width - 2);
  const filled = Math.round((safeDone / safeTotal) * innerWidth);
  return `[${"#".repeat(filled)}${"-".repeat(innerWidth - filled)}] ${safeDone}/${safeTotal}`;
}

/**
 * Truncate from the left, keeping the tail.
 *
 * Phase detail is usually a path, where the distinguishing part is the end. Two
 * hundred files under one long temp directory all truncate to the same prefix,
 * which tells the reader nothing about what is in flight.
 *
 * @param {string} text Input text
 * @param {number} maxWidth Maximum display width
 * @param {string} ellipsis Marker for the elided head
 * @returns {string} Text fitting within maxWidth
 */
function truncateHead(text, maxWidth, ellipsis) {
  if (stringWidth(text) <= maxWidth) {
    return text;
  }
  const budget = maxWidth - stringWidth(ellipsis);
  const chars = [...text];
  let width = 0;
  let start = chars.length;
  while (start > 0) {
    const charWidth = stringWidth(chars[start - 1]);
    if (width + charWidth > budget) {
      break;
    }
    width += charWidth;
    start -= 1;
  }
  return `${ellipsis}${chars.slice(start).join("")}`;
}

/**
 * Format console-style arguments into a single line.
 *
 * @param {unknown[]} args Arguments
 * @returns {string} Formatted line
 */
function formatArgs(args) {
  if (args.length === 0) {
    return "";
  }
  return args
    .map((arg) =>
      typeof arg === "string"
        ? arg
        : inspect(arg, {
            colors: false,
            breakLength: Number.POSITIVE_INFINITY,
          }),
    )
    .join(" ");
}

/**
 * Create a live-region controller.
 *
 * @param {object} [options] Controller options
 * @param {object} [options.stream] Writable stream (default: the diagnostic stream, stderr unless `CDXGEN_LOG_STREAM=stdout`)
 * @param {number|string} [options.level] Verbosity ladder 0..3
 * @param {("text"|"json")} [options.format] Log serialization format
 * @param {boolean} [options.noProgress] Force-disable the live region
 * @param {boolean} [options.color] Force color on or off
 * @param {boolean} [options.interactive] Force the live region on or off
 * @param {() => number} [options.now] Clock, injectable for tests
 * @returns {object} Controller
 */
export function createUi(options = {}) {
  let caps = detectCapabilities(options);
  let level = resolveLevel(options.level);
  let format = resolveFormat(options.format);
  const now = typeof options.now === "function" ? options.now : Date.now;

  // JSON log format disables the live region entirely: NDJSON to stderr only.
  const isLive = () => caps.interactive && format !== "json";

  /** @type {object[]} Phases currently running, in start order. */
  const running = [];
  let lastHeight = 0;
  let lastRenderAt = 0;
  let dirty = false;
  let stopped = false;
  let interval = null;
  let cursorHidden = false;
  let signalsInstalled = false;

  function write(chunk) {
    const stream = caps.stream;
    if (!chunk || typeof stream?.write !== "function") {
      return;
    }
    try {
      stream.write(chunk);
    } catch (err) {
      // A consumer that closed the pipe (`| head`) must not produce a stack.
      if (err?.code !== "EPIPE") {
        throw err;
      }
    }
  }

  function rewind() {
    if (lastHeight <= 0) {
      return "";
    }
    // The cursor sits on the block's last line, so move up height-1 times.
    return `${CLEAR_LINE}${CURSOR_UP_CLEAR.repeat(lastHeight - 1)}`;
  }

  function renderPhaseRow(phase, at) {
    const { frames, ellipsis } = caps.glyphs;
    let row = `${spinnerFrame(phase.startedAt, at, frames)} ${phase.label}`;
    if (phase.total > 0) {
      const barWidth = Math.min(
        20,
        Math.max(6, caps.columns() - stringWidth(row) - 16),
      );
      row += ` ${renderBar(phase.done, phase.total, barWidth)}`;
    }
    if (phase.detailText) {
      const separator = caps.unicode ? " — " : " - ";
      const remaining = Math.max(
        8,
        caps.columns() - stringWidth(row) - stringWidth(separator),
      );
      row += `${separator}${truncateHead(phase.detailText, remaining, ellipsis)}`;
    }
    return row;
  }

  /**
   * Build the current frame, clamped to the terminal height. Clamping is not
   * cosmetic: a frame taller than the screen scrolls the terminal, after which
   * the rewind count under-shoots and smears output for the rest of the run.
   *
   * @returns {{body: string, height: number}} Frame body and its line count
   */
  function buildFrame() {
    if (!isLive() || running.length === 0) {
      return { body: "", height: 0 };
    }
    const at = now();
    const lines = running.map((phase) => renderPhaseRow(phase, at));
    const maxLines = Math.max(1, caps.rows() - 1);
    if (lines.length <= maxLines) {
      return { body: lines.join("\n"), height: lines.length };
    }
    const kept = lines.slice(0, Math.max(1, maxLines - 1));
    kept.push(`${caps.glyphs.ellipsis} and ${lines.length - kept.length} more`);
    return { body: kept.join("\n"), height: kept.length };
  }

  function render() {
    if (!isLive()) {
      return;
    }
    const { body, height } = buildFrame();
    write(rewind() + body);
    lastHeight = height;
    lastRenderAt = now();
    dirty = false;
  }

  /**
   * Request a redraw. State transitions render at once; detail and progress
   * updates are coalesced to one frame per REFRESH_MS, so a caller reporting
   * per-file progress in a tight loop costs one write per frame, not per file.
   *
   * @param {boolean} [force] Render immediately regardless of the throttle
   */
  function requestRender(force = false) {
    if (!isLive()) {
      return;
    }
    dirty = true;
    if (force || now() - lastRenderAt >= REFRESH_MS) {
      render();
    }
  }

  function tick() {
    if (dirty || running.length > 0) {
      render();
    }
  }

  function startTimer() {
    if (interval || stopped || !isLive()) {
      return;
    }
    if (!cursorHidden) {
      write(HIDE_CURSOR);
      cursorHidden = true;
    }
    // unref() so a forgotten stop() can never hold the process open.
    interval = setInterval(tick, REFRESH_MS);
    interval.unref?.();
    installSignalHandlers();
  }

  function stopTimer() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  function showCursor() {
    if (cursorHidden) {
      write(SHOW_CURSOR);
      cursorHidden = false;
    }
  }

  function onExit() {
    stopTimer();
    showCursor();
  }

  /**
   * Restore the terminal and then let the signal do what it would have done.
   * Registering a listener suppresses Node's default terminate-on-SIGINT, so
   * the signal has to be re-raised or Ctrl-C would stop killing long scans.
   *
   * @param {NodeJS.Signals} signal The received signal
   */
  function onSignal(signal) {
    removeSignalHandlers();
    stopTimer();
    showCursor();
    process.kill(process.pid, signal);
  }

  function installSignalHandlers() {
    if (signalsInstalled) {
      return;
    }
    signalsInstalled = true;
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("exit", onExit);
  }

  function removeSignalHandlers() {
    if (!signalsInstalled) {
      return;
    }
    signalsInstalled = false;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", onExit);
  }

  /**
   * Print a line above the live region. The line becomes permanent scrollback
   * and the region is redrawn below it, in exactly one `write` so a frame is
   * never left torn.
   *
   * @param {string} text Line to print, without a trailing newline
   */
  function print(text) {
    const line = `${text ?? ""}`;
    if (!isLive()) {
      write(`${line}\n`);
      return;
    }
    const { body, height } = buildFrame();
    write(`${rewind()}${line}\n${body}`);
    lastHeight = height;
    lastRenderAt = now();
    dirty = false;
  }

  /**
   * Emit one leveled record: NDJSON when the json format is selected, otherwise
   * a line through the live-region-aware print path.
   *
   * @param {string} levelName Record level
   * @param {string} message Message text
   */
  function writeLine(levelName, message) {
    if (format === "json") {
      write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: levelName,
          msg: message,
        })}\n`,
      );
      return;
    }
    print(message);
  }

  /**
   * Pause the live region, run `fn`, then redraw. Used when a spawned process
   * must own the terminal.
   *
   * @param {() => any} fn Work to run with the region cleared
   * @returns {any} Result of `fn`
   */
  function pause(fn) {
    if (!isLive()) {
      return fn();
    }
    write(rewind());
    lastHeight = 0;
    try {
      return fn();
    } finally {
      render();
    }
  }

  /**
   * Mirror a phase transition onto the trace stream.
   *
   * The live region is a terminal affordance, so a piped consumer such as the
   * cdxui terminal UI would otherwise have to scrape formatted lines to learn
   * what cdxgen is doing. Emitting the phase model structurally lets it render
   * its own progress. `progress` transitions are throttled to the frame
   * interval so a per-file loop costs one event per frame, not one per file.
   *
   * @param {object} handle Phase handle
   * @param {string} state One of started, progress, succeeded, failed, skipped
   */
  function tracePhase(handle, state) {
    if (!TRACE_MODE) {
      return;
    }
    const at = now();
    if (state === "progress") {
      if (at - (handle.tracedAt || 0) < REFRESH_MS) {
        return;
      }
      handle.tracedAt = at;
    }
    traceLog("phase", {
      phase: handle.label,
      state,
      detail: handle.detailText ?? undefined,
      note: handle.note ?? undefined,
      done: handle.total > 0 ? handle.done : undefined,
      total: handle.total > 0 ? handle.total : undefined,
      elapsedMs: at - handle.startedAt,
    });
  }

  function commitPhase(phase) {
    const outcome = PHASE_OUTCOMES[phase.status] || PHASE_OUTCOMES.succeeded;
    const glyph = caps.glyphs[phase.status] || caps.glyphs.succeeded;
    const elapsed = `${((now() - phase.startedAt) / 1000).toFixed(1)}s`;
    const parts = [
      phase.label,
      phase.note,
      caps.color ? COLOR.dim(elapsed) : elapsed,
    ];
    const marker = caps.color ? outcome.color(glyph) : glyph;
    const message = `${marker} ${parts.filter(Boolean).join("  ")}`;
    writeLine(outcome.level, caps.color ? message : stripAnsi(message));
  }

  /**
   * Begin a named phase.
   *
   * @param {string} label Phase label
   * @returns {object} Phase handle
   */
  function phase(label) {
    const handle = {
      label: label || "working",
      detailText: null,
      done: 0,
      total: 0,
      status: "running",
      startedAt: now(),
      note: null,
      committed: false,
      tracedAt: 0,

      /**
       * Replace the trailing detail text on this phase's row.
       *
       * @param {string} text Detail text
       * @returns {object} This handle
       */
      detail(text) {
        if (!this.committed) {
          this.detailText = text ? `${text}` : null;
          tracePhase(this, "progress");
          requestRender();
        }
        return this;
      },

      /**
       * Switch this phase's row to a progress bar.
       *
       * @param {number} done Completed units
       * @param {number} total Total units
       * @returns {object} This handle
       */
      progress(done, total) {
        if (!this.committed) {
          this.done = Number(done) || 0;
          this.total = Number(total) || 0;
          tracePhase(this, "progress");
          requestRender();
        }
        return this;
      },

      /**
       * Commit this phase as succeeded.
       *
       * @param {string} [summary] One-line outcome summary
       */
      succeed(summary) {
        finish(this, "succeeded", summary);
      },

      /**
       * Commit this phase as failed.
       *
       * @param {Error|string} [err] Failure cause
       */
      fail(err) {
        finish(
          this,
          "failed",
          err instanceof Error ? err.message : `${err ?? "failed"}`,
        );
      },

      /**
       * Commit this phase as skipped.
       *
       * @param {string} [reason] Why the phase was skipped
       */
      skip(reason) {
        finish(this, "skipped", reason || "skipped");
      },
    };
    running.push(handle);
    tracePhase(handle, "started");
    startTimer();
    requestRender(true);
    return handle;
  }

  function finish(handle, status, note) {
    if (handle.committed) {
      return;
    }
    handle.committed = true;
    handle.status = status;
    handle.note = note ? `${note}` : null;
    tracePhase(handle, status);
    const index = running.indexOf(handle);
    if (index >= 0) {
      running.splice(index, 1);
    }
    if (running.length === 0 && isLive()) {
      // Clear the region so the committed line is not drawn over a stale frame.
      write(rewind());
      lastHeight = 0;
    }
    if (level >= LEVEL_NORMAL || status === "failed") {
      commitPhase(handle);
    }
    if (running.length === 0) {
      stopTimer();
    } else {
      requestRender(true);
    }
  }

  /**
   * Stop the controller: halt the timer, commit the final frame, restore the
   * cursor, and detach signal handlers. Safe to call more than once.
   */
  function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    stopTimer();
    if (isLive()) {
      // The final frame is committed with the one newline the region owes.
      const { body } = buildFrame();
      write(body ? `${rewind()}${body}\n` : rewind());
      lastHeight = 0;
    }
    showCursor();
    removeSignalHandlers();
  }

  /**
   * Re-resolve capabilities, level, and format. Used by the CLI once flags are
   * parsed, and by the server to force non-interactive NDJSON.
   *
   * @param {object} [next] Same shape as the constructor options
   */
  function configure(next = {}) {
    caps = detectCapabilities({ ...next, stream: next.stream || caps.stream });
    if (next.level !== undefined) {
      level = resolveLevel(next.level);
    }
    if (next.format !== undefined) {
      format = resolveFormat(next.format);
    }
    if (!isLive()) {
      stopTimer();
      showCursor();
    }
  }

  const logApi = {
    /**
     * Log an error. Always emitted, at every level.
     *
     * @param {...unknown} args Message parts
     */
    error(...args) {
      writeLine("error", formatArgs(args));
    },
    /**
     * Log a warning.
     *
     * @param {...unknown} args Message parts
     */
    warn(...args) {
      if (level >= LEVEL_NORMAL) {
        writeLine("warn", formatArgs(args));
      }
    },
    /**
     * Log an informational message.
     *
     * @param {...unknown} args Message parts
     */
    info(...args) {
      if (level >= LEVEL_NORMAL) {
        writeLine("info", formatArgs(args));
      }
    },
    /**
     * Log a debug message. Shown from verbosity level 2.
     *
     * @param {...unknown} args Message parts
     */
    debug(...args) {
      if (level >= LEVEL_VERBOSE) {
        writeLine("debug", formatArgs(args));
      }
    },
  };

  return {
    print,
    writeLine,
    phase,
    pause,
    stop,
    configure,
    log: logApi,
    get interactive() {
      return isLive();
    },
    get color() {
      return caps.color;
    },
    get level() {
      return level;
    },
    get format() {
      return format;
    },
    get stream() {
      return caps.stream;
    },
  };
}

/**
 * Process-wide default live-region UI controller instance. Library code imports
 * this directly; the CLI reconfigures it once flags are parsed.
 *
 * @type {Object}
 */
export const ui = createUi({});

/**
 * Convenience facade exposing leveled log methods (`error`, `warn`, `info`,
 * `debug`) that delegate to the default controller instance.
 *
 * @type {Object}
 */
export const log = {
  /**
   * Log an error through the default controller.
   *
   * @param {...unknown} args Message parts
   */
  error: (...args) => ui.log.error(...args),
  /**
   * Log a warning through the default controller.
   *
   * @param {...unknown} args Message parts
   */
  warn: (...args) => ui.log.warn(...args),
  /**
   * Log an informational message through the default controller.
   *
   * @param {...unknown} args Message parts
   */
  info: (...args) => ui.log.info(...args),
  /**
   * Log a debug message through the default controller.
   *
   * @param {...unknown} args Message parts
   */
  debug: (...args) => ui.log.debug(...args),
};

// Minimum verbosity level for each shimmed console method.
const CONSOLE_ROUTES = {
  log: { level: LEVEL_NORMAL, name: "info" },
  info: { level: LEVEL_NORMAL, name: "info" },
  warn: { level: LEVEL_NORMAL, name: "warn" },
  error: { level: LEVEL_SILENT, name: "error" },
  debug: { level: LEVEL_VERBOSE, name: "debug" },
  trace: { level: LEVEL_DEBUG, name: "trace" },
};

let originalConsole = null;

/**
 * Install a global `console` shim routing `log`/`info`/`warn`/`error`/`debug`/
 * `trace` through the controller. This converts every existing `console.*` call
 * site to land on the diagnostic stream above the live region without editing
 * any of them. Unknown members delegate to the real console.
 *
 * @param {object} [uiInstance] Controller to route through
 * @returns {() => void} Function that restores the original console
 */
export function installConsoleShim(uiInstance = ui) {
  if (originalConsole !== null) {
    return restoreConsole;
  }
  originalConsole = globalThis.console;
  const overrides = {};
  for (const [method, route] of Object.entries(CONSOLE_ROUTES)) {
    overrides[method] = (...args) => {
      if (uiInstance.level < route.level) {
        return;
      }
      const formatted = formatWithOptions(
        { colors: uiInstance.color },
        ...args,
      );
      // Streams without color (pipes, CI, NO_COLOR) stay free of escape bytes
      // so the diagnostic stream is grep-safe.
      uiInstance.writeLine(
        route.name,
        uiInstance.color ? formatted : stripAnsi(formatted),
      );
    };
  }
  globalThis.console = new Proxy(originalConsole, {
    get(target, prop, receiver) {
      return Object.hasOwn(overrides, prop)
        ? overrides[prop]
        : Reflect.get(target, prop, receiver);
    },
  });
  return restoreConsole;
}

/**
 * Restore the console captured by {@link installConsoleShim}. Safe to call when
 * no shim is installed.
 */
export function restoreConsole() {
  if (originalConsole !== null) {
    globalThis.console = originalConsole;
    originalConsole = null;
  }
}
