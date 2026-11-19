import process from "node:process";

import { assert, describe, it } from "poku";

import { createUi, detectCapabilities } from "./ui.js";

/**
 * Build a fake stream that records every write, so assertions can be exact
 * about the escape sequences emitted.
 *
 * @param {object} [options] Stream shape
 * @returns {object} Fake stream with a `writes` array
 */
function createStream({ isTTY = true, columns = 80, rows = 25 } = {}) {
  const writes = [];
  return {
    isTTY,
    columns,
    rows,
    writes,
    write(chunk) {
      writes.push(chunk);
    },
    get text() {
      return writes.join("");
    },
  };
}

/**
 * A controllable clock, so throttling and spinner timing are deterministic.
 *
 * @param {number} [startAt] Initial timestamp
 * @returns {{now: () => number, advance: (ms: number) => void}} Clock
 */
function createClock(startAt = 1_000) {
  let current = startAt;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

const ESC = String.fromCharCode(27);
const REWIND = `\r${ESC}[2K`;
// Built from ESC rather than written as a literal so the pattern carries no
// control character of its own.
const ANSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9?]*[A-Za-z]`, "g");

const stripRewind = (text) =>
  text.startsWith(REWIND) ? text.slice(REWIND.length) : text;

const isPrintableAscii = (text) =>
  [...text].every((char) => {
    const code = char.codePointAt(0);
    return char === "\n" || (code >= 0x20 && code <= 0x7e);
  });

function countOccurrences(haystack, needle) {
  return needle ? haystack.split(needle).length - 1 : 0;
}

/**
 * Reduce raw stream output to the lines a terminal would be left showing.
 *
 * Only newline-terminated content survives; within a line, a carriage return
 * discards everything before it, which is how the live region overwrites its
 * transient frames.
 *
 * @param {string} text Raw stream output
 * @returns {string[]} Committed lines
 */
function committedLines(text) {
  const lines = text.split("\n");
  // The trailing fragment was never terminated, so the terminal is still on it.
  lines.pop();
  return lines
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .map((line) => line.replace(ANSI_SEQUENCE, "").trim())
    .filter(Boolean);
}

/**
 * Build an interactive controller over a fake stream and clock.
 *
 * @param {object} [options] Overrides
 * @returns {object} `{ ui, stream, clock }`
 */
function liveUi(options = {}) {
  const stream = createStream(options.stream);
  const clock = createClock();
  const ui = createUi({
    stream,
    interactive: true,
    color: false,
    unicode: true,
    level: 1,
    now: clock.now,
    ...options.ui,
  });
  return { ui, stream, clock };
}

describe("ui live region", () => {
  it("first frame has no rewind prefix; the next emits height-1 cursor-ups", () => {
    const { ui, stream, clock } = liveUi();
    const a = ui.phase("Alpha");
    const firstFrame = stream.writes.find((chunk) => chunk.includes("Alpha"));
    assert.ok(!firstFrame.includes("\x1b[1A"));

    ui.phase("Beta");
    // Two rows are live, so the next rewind moves up exactly once.
    stream.writes.length = 0;
    clock.advance(100);
    a.detail("tick");
    assert.strictEqual(
      countOccurrences(stream.text, "\x1b[1A\x1b[2K"),
      1,
      stream.text,
    );
    ui.stop();
  });

  it("never terminates a frame with a newline until stop()", () => {
    const { ui, stream } = liveUi();
    const p = ui.phase("Working");
    p.detail("x");
    p.progress(1, 3);
    for (const chunk of stream.writes) {
      if (chunk === "\x1b[?25l") {
        continue;
      }
      assert.ok(
        !chunk.endsWith("\n"),
        `chunk ended with a newline: ${JSON.stringify(chunk)}`,
      );
    }
    stream.writes.length = 0;
    ui.stop();
    assert.ok(stream.text.includes("\n"));
  });

  it("print() during an active region is one write of rewind+line+frame", () => {
    const { ui, stream } = liveUi();
    ui.phase("Active");
    stream.writes.length = 0;
    ui.print("resolved 412 packages");
    assert.strictEqual(stream.writes.length, 1);
    assert.ok(stream.writes[0].includes("resolved 412 packages\n"));
    assert.ok(stream.writes[0].includes("Active"));
    ui.stop();
  });

  it("print() writes control characters in a line as text", () => {
    const { ui, stream } = liveUi();
    stream.writes.length = 0;
    ui.print("a\r\x1b[1A\x1b[2Kforged\x1b[8m");
    assert.ok(!stream.text.includes("\r"));
    assert.ok(!stream.text.includes("\x1b[1A"));
    assert.ok(!stream.text.includes("\x1b[2K"));
    assert.ok(stream.text.includes("a\\u000d\\u001b[1A\\u001b[2Kforged"));
    assert.ok(stream.text.includes("\x1b[8m\x1b[0m"));
    ui.stop();
  });

  it("log.* goes through the live region rather than tearing it", () => {
    const { ui, stream } = liveUi();
    ui.phase("Active");
    stream.writes.length = 0;
    ui.log.info("a log line");
    assert.strictEqual(stream.writes.length, 1);
    const emitted = stream.writes[0];
    assert.ok(emitted.startsWith("\r\x1b[2K"), "log.* skipped the rewind");
    assert.ok(emitted.includes("a log line\n"));
    assert.ok(emitted.includes("Active"), "log.* did not redraw the frame");
    ui.stop();
  });

  it("clamps a frame taller than the terminal and rewinds by the clamped height", () => {
    const rows = 6;
    const { ui, stream, clock } = liveUi({ stream: { rows } });
    const handles = [];
    for (let i = 0; i < 12; i += 1) {
      handles.push(ui.phase(`phase-${i}`));
    }
    stream.writes.length = 0;
    clock.advance(100);
    handles[0].detail("tick");
    const frame = stream.writes.filter((c) => c.includes("phase-")).pop();
    const body = stripRewind(frame);
    const lines = body.split("\n");
    assert.ok(
      lines.length <= rows - 1,
      `frame had ${lines.length} lines, expected <= ${rows - 1}`,
    );
    assert.ok(body.includes("… and 8 more"), body);

    stream.writes.length = 0;
    clock.advance(100);
    handles[1].detail("tock");
    assert.ok(
      countOccurrences(stream.text, "\x1b[1A\x1b[2K") <= rows - 2,
      "rewind exceeded the clamped height",
    );
    ui.stop();
  });

  it("coalesces detail updates to one frame per refresh interval", () => {
    const { ui, stream, clock } = liveUi();
    const p = ui.phase("Scanning");
    stream.writes.length = 0;
    // A tight per-file loop within one interval must not cost a write per file.
    for (let i = 0; i < 100; i += 1) {
      p.detail(`file-${i}`);
    }
    assert.strictEqual(stream.writes.length, 0, "detail() was not throttled");
    clock.advance(100);
    p.detail("file-100");
    assert.strictEqual(stream.writes.length, 1);
    ui.stop();
  });

  it("emits no ANSI escape byte when not interactive", () => {
    const stream = createStream({ isTTY: false });
    const ui = createUi({
      stream,
      interactive: false,
      color: false,
      level: 1,
    });
    const p = ui.phase("Quiet");
    p.detail("ignored when not interactive");
    p.progress(1, 2);
    p.succeed("done");
    ui.print("a log line");
    ui.log.warn("a warning");
    ui.stop();
    assert.ok(!stream.text.includes("\x1b"), stream.text);
    assert.ok(stream.text.includes("Quiet"));
  });

  it("honours TERM=dumb, CI, NO_COLOR, FORCE_COLOR and --no-progress", () => {
    const tty = { isTTY: true, columns: 80, rows: 25 };
    const caps = (env, extra) =>
      detectCapabilities({ stream: tty, env, ...extra });
    assert.strictEqual(caps({ TERM: "dumb" }).interactive, false);
    assert.strictEqual(caps({ TERM: "unknown" }).interactive, false);
    assert.strictEqual(caps({ CI: "true" }).interactive, false);
    assert.strictEqual(caps({ CDXGEN_NO_PROGRESS: "true" }).interactive, false);
    assert.strictEqual(caps({}, { noProgress: true }).interactive, false);
    // NO_COLOR disables color but not the live region.
    assert.strictEqual(caps({ NO_COLOR: "1" }).color, false);
    assert.strictEqual(caps({ NO_COLOR: "1" }).interactive, true);
    assert.strictEqual(caps({ FORCE_COLOR: "1" }).color, true);
    // An empty value is not "set", per the force-color convention.
    assert.strictEqual(caps({ FORCE_COLOR: "" }).color, true);
    assert.strictEqual(caps({ NO_COLOR: "" }).color, true);
    // A non-TTY stream is never interactive.
    assert.strictEqual(
      detectCapabilities({ stream: { isTTY: false }, env: {} }).interactive,
      false,
    );
  });

  it("falls back to ASCII glyphs when unicode is unavailable", () => {
    const tty = { isTTY: true, columns: 80, rows: 25 };
    // Unicode is independent of color and of interactivity: a redirected UTF-8
    // log file takes the glyphs, a legacy Windows console does not.
    assert.strictEqual(
      detectCapabilities({ stream: tty, env: {}, unicode: false }).glyphs
        .succeeded,
      "+",
    );
    assert.strictEqual(
      detectCapabilities({ stream: tty, env: { CDXGEN_UNICODE: "false" } })
        .unicode,
      false,
    );
    assert.strictEqual(
      detectCapabilities({ stream: tty, env: { CDXGEN_UNICODE: "true" } })
        .unicode,
      true,
    );

    const stream = createStream({ isTTY: false });
    const ui = createUi({
      stream,
      interactive: false,
      color: false,
      unicode: false,
      level: 1,
    });
    ui.phase("Generating BOM").succeed("3 components");
    ui.phase("Signing").fail("no key");
    ui.phase("Uploading").skip("not configured");
    const lines = committedLines(stream.text);
    assert.match(lines[0], /^\+ Generating BOM/);
    assert.match(lines[1], /^x Signing/);
    assert.match(lines[2], /^~ Uploading/);
    // Nothing outside printable ASCII may reach a console that cannot show it.
    assert.ok(isPrintableAscii(stream.text), JSON.stringify(stream.text));
  });

  it("falls back to 80x25 when the stream reports no size", () => {
    const caps = detectCapabilities({ stream: { isTTY: true }, env: {} });
    assert.strictEqual(caps.columns(), 80);
    assert.strictEqual(caps.rows(), 25);
  });

  it("selects the spinner frame from elapsed time, not from call count", () => {
    const { ui, stream, clock } = liveUi();
    const p = ui.phase("Steady");
    const spinnerOf = (text) => stripRewind(text).charAt(0);

    stream.writes.length = 0;
    clock.advance(100);
    p.detail("a");
    const first = spinnerOf(stream.text);

    // Re-rendering without advancing the clock must not advance the animation.
    stream.writes.length = 0;
    ui.print("interleaved log");
    assert.ok(stream.text.includes("Steady"));
    const redrawn = stream.text.slice(stream.text.indexOf("\n") + 1).charAt(0);
    assert.strictEqual(redrawn, first);
    ui.stop();
  });

  it("restores the cursor on stop()", () => {
    const { ui, stream } = liveUi({ ui: { color: true } });
    ui.phase("ThenStop");
    stream.writes.length = 0;
    ui.stop();
    assert.ok(stream.text.includes("\x1b[?25h"));
  });

  it("registers one set of signal handlers no matter how many phases run", () => {
    const counts = () => ({
      exit: process.listenerCount("exit"),
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    });
    const before = counts();
    const { ui } = liveUi();
    for (let i = 0; i < 15; i += 1) {
      ui.phase(`p${i}`).succeed("ok");
    }
    const during = counts();
    assert.ok(
      during.exit - before.exit <= 1 &&
        during.sigint - before.sigint <= 1 &&
        during.sigterm - before.sigterm <= 1,
      `signal handlers leaked: ${JSON.stringify({ before, during })}`,
    );
    ui.stop();
    assert.deepStrictEqual(counts(), before, "stop() left handlers attached");
  });

  it("truncates phase detail from the left so the path tail stays visible", () => {
    const { ui, stream, clock } = liveUi({ stream: { columns: 40 } });
    const p = ui.phase("Scanning");
    stream.writes.length = 0;
    clock.advance(100);
    p.detail("/a/very/long/temp/directory/prefix/pkg/lodash/package.json");
    const row = stripRewind(stream.text);
    // The distinguishing tail survives; the uninformative prefix is elided.
    assert.ok(row.includes("package.json"), row);
    assert.ok(row.includes("…"), row);
    assert.ok(!row.includes("/a/very/long/temp"), row);
    ui.stop();
  });

  it("renders at any terminal width without throwing", () => {
    for (const columns of [1, 20, 200]) {
      const { ui } = liveUi({ stream: { columns } });
      const p = ui.phase("NarrowOrWide");
      assert.doesNotThrow(() => p.detail("d".repeat(200)));
      assert.doesNotThrow(() => p.progress(3, 9));
      p.succeed("");
      ui.stop();
    }
  });

  it("swallows EPIPE from a closed consumer", () => {
    const ui = createUi({
      stream: {
        isTTY: true,
        columns: 80,
        rows: 25,
        write() {
          const err = new Error("broken pipe");
          err.code = "EPIPE";
          throw err;
        },
      },
      interactive: true,
      color: false,
      unicode: true,
      level: 1,
    });
    assert.doesNotThrow(() => ui.print("hello"));
    assert.doesNotThrow(() => ui.phase("Anything").succeed("ok"));
    assert.doesNotThrow(() => ui.stop());
  });

  it("propagates a write error that is not EPIPE", () => {
    const ui = createUi({
      stream: {
        isTTY: false,
        write() {
          throw new Error("disk full");
        },
      },
      interactive: false,
      unicode: true,
      level: 1,
    });
    assert.throws(() => ui.print("hello"), /disk full/);
  });
});

describe("ui phases", () => {
  it("commits one line per phase with a marker and elapsed time", () => {
    const stream = createStream({ isTTY: false });
    const ui = createUi({
      stream,
      interactive: false,
      color: false,
      unicode: true,
      level: 1,
    });
    ui.phase("Generating BOM").succeed("412 components");
    ui.phase("Signing").fail(new Error("no key"));
    ui.phase("Uploading").skip("no server configured");
    const lines = stream.text.trim().split("\n");
    assert.strictEqual(lines.length, 3);
    assert.match(lines[0], /^✔ Generating BOM {2}412 components {2}\d+\.\ds$/);
    assert.match(lines[1], /^✖ Signing {2}no key {2}\d+\.\ds$/);
    assert.match(lines[2], /^→ Uploading {2}no server configured {2}\d+\.\ds$/);
  });

  it("commits a phase only once", () => {
    const stream = createStream({ isTTY: false });
    const ui = createUi({ stream, interactive: false, color: false, level: 1 });
    const p = ui.phase("Once");
    p.succeed("first");
    p.fail("second");
    p.skip("third");
    assert.strictEqual(stream.text.trim().split("\n").length, 1);
    assert.ok(stream.text.includes("first"));
  });

  it("keeps failures visible at quiet level but drops successes", () => {
    const stream = createStream({ isTTY: false });
    const ui = createUi({ stream, interactive: false, color: false, level: 0 });
    ui.phase("Quietly fine").succeed("ok");
    assert.strictEqual(stream.text, "");
    ui.phase("Quietly broken").fail("boom");
    assert.ok(stream.text.includes("Quietly broken"));
  });

  it("behaves identically whether or not the region is interactive", () => {
    const outcomes = [];
    for (const interactive of [true, false]) {
      const stream = createStream({ isTTY: interactive });
      const ui = createUi({
        stream,
        interactive,
        color: false,
        unicode: true,
        level: 1,
        now: createClock().now,
      });
      const p = ui.phase("Same");
      p.detail("detail");
      p.progress(1, 2);
      p.succeed("done");
      ui.stop();
      // What a terminal is left showing must not depend on whether the region
      // animated: transient frames are erased, the committed line is not.
      outcomes.push(committedLines(stream.text));
    }
    assert.deepStrictEqual(outcomes[0], outcomes[1]);
    assert.deepStrictEqual(outcomes[0], ["✔ Same  done  0.0s"]);
  });

  it("pause() clears the region, runs the callback, and redraws", () => {
    const { ui, stream } = liveUi();
    ui.phase("Held");
    stream.writes.length = 0;
    const result = ui.pause(() => "returned");
    assert.strictEqual(result, "returned");
    assert.ok(stream.text.includes("Held"), "region was not redrawn");
  });

  it("pause() redraws even when the callback throws", () => {
    const { ui, stream } = liveUi();
    ui.phase("Held");
    stream.writes.length = 0;
    assert.throws(() => {
      ui.pause(() => {
        throw new Error("inner");
      });
    }, /inner/);
    assert.ok(stream.text.includes("Held"));
  });
});

describe("ui log format", () => {
  it("json format emits NDJSON and no control sequences", () => {
    const stream = createStream({ isTTY: true });
    const ui = createUi({
      stream,
      interactive: true,
      color: true,
      level: 1,
      format: "json",
    });
    assert.strictEqual(ui.interactive, false, "json must disable the region");
    ui.log.info("hello");
    ui.phase("Generating BOM").succeed("3 components");
    ui.stop();
    assert.ok(!stream.text.includes("\x1b"));
    const records = stream.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].level, "info");
    assert.strictEqual(records[0].msg, "hello");
    assert.strictEqual(records[1].level, "info");
    assert.ok(records[1].msg.includes("Generating BOM"));
    assert.ok(Date.parse(records[1].ts) > 0);
  });

  it("configure() switching to non-interactive stops the region", () => {
    const { ui, stream } = liveUi();
    ui.phase("Running");
    assert.strictEqual(ui.interactive, true);
    stream.writes.length = 0;
    ui.configure({ interactive: false, color: false });
    assert.strictEqual(ui.interactive, false);
    assert.strictEqual(ui.color, false);
    // The cursor is restored as part of giving up the terminal.
    assert.ok(stream.text.includes("\x1b[?25h"));
    ui.stop();
  });
});
