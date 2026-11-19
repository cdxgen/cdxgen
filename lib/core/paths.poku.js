import { assert, describe, it } from "poku";

import { stripTrailingSlashes } from "./paths.js";

describe("stripTrailingSlashes()", () => {
  it("removes the slashes a string ends with and no others", () => {
    assert.strictEqual(stripTrailingSlashes("packages/web"), "packages/web");
    assert.strictEqual(stripTrailingSlashes("packages/web/"), "packages/web");
    assert.strictEqual(stripTrailingSlashes("packages/web///"), "packages/web");
    assert.strictEqual(
      stripTrailingSlashes("//packages//web"),
      "//packages//web",
    );
    assert.strictEqual(
      stripTrailingSlashes("packages\\web\\"),
      "packages\\web\\",
    );
    assert.strictEqual(stripTrailingSlashes("///"), "");
    assert.strictEqual(stripTrailingSlashes(""), "");
  });

  it("takes time linear in a run of slashes, wherever the run is", () => {
    const run = "/".repeat(100000);
    const started = performance.now();
    assert.strictEqual(stripTrailingSlashes(`${run}web`), `${run}web`);
    assert.strictEqual(stripTrailingSlashes(`web${run}`), "web");
    assert.strictEqual(stripTrailingSlashes(`web${run}web`), `web${run}web`);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1500, `took ${Math.round(elapsed)} ms`);
  });
});
