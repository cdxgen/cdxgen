import process from "node:process";

import { assert, describe, it } from "poku";
import sinon from "sinon";

import { createStream, table } from "./table.js";

describe("table()", () => {
  it("renders headers, rows, and borders", () => {
    const output = table(
      [
        ["Name", "Score"],
        ["alpha", "100"],
      ],
      {
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
      columns: [{ width: 2 }, { width: 6, wrapWord: true }],
    });

    assert.ok(output.includes("superc"));
    assert.ok(output.includes("alifra"));
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
