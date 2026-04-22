import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

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
      "./utils.js": { TABLE_BORDER_STYLE: "unicode" },
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
      "./utils.js": { TABLE_BORDER_STYLE: "auto" },
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
  it("writes rows incrementally to stdout", () => {
    const writeStub = sinon.stub(process.stdout, "write");
    const stream = createStream({
      columns: [{ width: 5 }, { width: 5 }],
    });

    stream.write(["h1", "h2"]);
    stream.write(["v1", "v2"]);

    assert.ok(writeStub.callCount >= 3);
    assert.ok(writeStub.calledWithMatch("h1"));
    assert.ok(writeStub.calledWithMatch("v2"));
    writeStub.restore();
  });
});
