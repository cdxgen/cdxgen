import { assert, describe, it } from "poku";

import { parseCommand } from "./traceRunner.js";

describe("traceRunner", () => {
  it("parses simple command string", () => {
    const parsed = parseCommand("node app.js");
    assert.strictEqual(parsed.cmd, "node");
    assert.deepEqual(parsed.args, ["app.js"]);
  });

  it("parses command string with double quotes", () => {
    const parsed = parseCommand('node "my app.js" --arg1');
    assert.strictEqual(parsed.cmd, "node");
    assert.deepEqual(parsed.args, ["my app.js", "--arg1"]);
  });

  it("parses command string with single quotes", () => {
    const parsed = parseCommand("node 'my app.js' --arg1");
    assert.strictEqual(parsed.cmd, "node");
    assert.deepEqual(parsed.args, ["my app.js", "--arg1"]);
  });

  it("returns undefined cmd for empty string", () => {
    const parsed = parseCommand("");
    assert.strictEqual(parsed.cmd, undefined);
    assert.deepEqual(parsed.args, []);
  });

  it("handles multiple spaces between tokens", () => {
    const parsed = parseCommand("node    app.js   --verbose");
    assert.strictEqual(parsed.cmd, "node");
    assert.deepEqual(parsed.args, ["app.js", "--verbose"]);
  });

  it("handles argument with = sign", () => {
    const parsed = parseCommand("node --flag=value app.js");
    assert.strictEqual(parsed.cmd, "node");
    assert.deepEqual(parsed.args, ["--flag=value", "app.js"]);
  });
});
