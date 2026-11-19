import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { diagnosticStream } from "../core/logger.js";
import { createStream, table } from "./table.js";

const withStdoutTTY = (ttyValue, action) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    enumerable: true,
    value: ttyValue,
    writable: true,
  });
  try {
    action();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdout, "isTTY", descriptor);
    } else {
      delete process.stdout.isTTY;
    }
  }
};

describe("table()", () => {
  it("renders headers, rows, and borders", () => {
    const output = table(
      [
        ["Name", "Score"],
        ["alpha", "100"],
      ],
      {
        borderStyle: "ascii",
        columns: [{ width: 8 }, { width: 5, alignment: "right" }],
        header: { alignment: "center", content: "Report" },
      },
    );

    assert.ok(output.includes("Report"));
    assert.ok(output.includes("alpha"));
    assert.ok(output.includes("  100"));
    assert.ok(output.includes("+----------+-------+"));
  });

  it("wraps long words when wrapWord is enabled", () => {
    const output = table([["A", "supercalifragilistic"]], {
      borderStyle: "ascii",
      columns: [{ width: 2 }, { width: 6, wrapWord: true }],
    });

    assert.ok(output.includes("superc"));
    assert.ok(output.includes("alifra"));
  });

  it("preserves ANSI escape sequences while wrapping by characters", () => {
    const output = table([["\x1b[1;35mabcdef\x1b[0m"]], {
      borderStyle: "ascii",
      columns: [{ width: 4, wrapWord: true }],
    });

    // biome-ignore lint/complexity/useRegexLiterals: avoid control-character regex literal warnings for ANSI pattern.
    const ansiRegex = new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "g");
    const ansiMatches = output.match(ansiRegex) || [];
    // The wrapped first line closes the style the cell opened.
    assert.strictEqual(ansiMatches.length, 3);
    assert.ok(output.includes("abcd"));
    assert.ok(output.includes("ef"));
  });

  it("writes control characters in a cell as text and closes a style at the cell end", () => {
    const output = table(
      [
        ["a\r\x1b[1A\x1b[2K\x1b[8mhidden", "next"],
        ["ok", "row"],
      ],
      { borderStyle: "ascii", header: { content: "h\r\x1b[2Kdr" } },
    );
    assert.ok(!output.includes("\r"));
    assert.ok(!output.includes("\x1b[1A"));
    assert.ok(!output.includes("\x1b[2K"));
    assert.ok(output.includes("\\u000d\\u001b[1A\\u001b[2K"));
    // The conceal sequence is closed before the border that follows it.
    assert.ok(output.includes("\x1b[8mhidden"));
    const row = output.split("\n").find((line) => line.includes("hidden"));
    assert.ok(row.indexOf("\x1b[0m") > row.indexOf("\x1b[8m"));
    assert.ok(row.indexOf("\x1b[0m") < row.indexOf("next"));
  });

  it("keeps falsy values like 0 and false in cells", () => {
    const output = table([[0, false]], {
      borderStyle: "ascii",
      columns: [{ width: 3 }, { width: 5 }],
    });

    assert.ok(output.includes(" 0 "));
    assert.ok(output.includes("false"));
  });

  it("uses unicode borders in auto mode on tty when not in CI", () => {
    const originalCI = process.env.CI;
    delete process.env.CI;

    try {
      withStdoutTTY(true, () => {
        const output = table([["x"]], {
          borderStyle: "auto",
          columns: [{ width: 3 }],
        });
        assert.ok(output.includes("┌"));
        assert.ok(output.includes("│"));
      });
    } finally {
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
    }
  });

  it("uses ascii borders in auto mode when CI=true", () => {
    const originalCI = process.env.CI;
    process.env.CI = "true";

    try {
      withStdoutTTY(true, () => {
        const output = table([["x"]], {
          borderStyle: "auto",
          columns: [{ width: 3 }],
        });
        assert.ok(output.includes("+"));
        assert.ok(output.includes("|"));
        assert.ok(!output.includes("┌"));
      });
    } finally {
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
    }
  });

  it("uses TABLE_BORDER_STYLE=unicode from utils even when not tty", async () => {
    const { table: tableWithUnicode } = await esmock("./table.js", {
      "../core/env.js": { TABLE_BORDER_STYLE: "unicode" },
    });

    withStdoutTTY(false, () => {
      const output = tableWithUnicode([["x"]], {
        columns: [{ width: 3 }],
      });
      assert.ok(output.includes("┌"));
      assert.ok(output.includes("│"));
    });
  });

  it("falls back to auto-detect when TABLE_BORDER_STYLE is auto", async () => {
    const { table: tableWithAuto } = await esmock("./table.js", {
      "../core/env.js": { TABLE_BORDER_STYLE: "auto" },
    });
    const originalCI = process.env.CI;
    process.env.CI = "true";

    try {
      withStdoutTTY(true, () => {
        const output = tableWithAuto([["x"]], {
          columns: [{ width: 3 }],
        });
        assert.ok(output.includes("+"));
        assert.ok(output.includes("|"));
      });
    } finally {
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
    }
  });
});

describe("createStream()", () => {
  it("writes rows incrementally to the diagnostic stream and closes with a bottom border", () => {
    // A rendered table is human-readable output, so it must not land on stdout:
    // that stream carries the BOM document under `-o -`, and a table appended to
    // it produced a payload that would not parse.
    const writeStub = sinon.stub(diagnosticStream, "write");
    const stdoutStub = sinon.stub(process.stdout, "write");
    const stream = createStream({
      borderStyle: "unicode",
      columns: [{ width: 5 }, { width: 5 }],
    });

    stream.write(["h1", "h2"]);
    stream.write(["v1", "v2"]);
    stream.end();

    assert.ok(writeStub.callCount >= 3);
    assert.ok(writeStub.calledWithMatch("h1"));
    assert.ok(writeStub.calledWithMatch("v2"));
    const output = writeStub.args.map((args) => args[0]).join("");
    assert.ok(output.includes("├"));
    assert.ok(output.trimEnd().endsWith("┘"));
    writeStub.restore();
    assert.strictEqual(
      stdoutStub.callCount,
      0,
      "nothing may reach stdout: it carries the BOM payload",
    );
    stdoutStub.restore();
  });
});
