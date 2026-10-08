import { createServer } from "node:http";
import process from "node:process";

import { assert, it } from "poku";

// npm and JSR remember the documents a run fetched. A second lockfile, or a
// second pass over the same packages, must not batch them again: before, the
// prefetch never looked at the memo, so every pass asked again whenever the
// response cache had dropped the document. The response cache is emptied
// between the calls below so that only the memo can answer. JSR_API_URL is
// read when denoutils.js loads and CDXGEN_RS_DISABLE is process-wide, so this
// file holds one sequential test.

it("npm and JSR do not prefetch documents the run already holds", async () => {
  const previous = {
    JSR_API_URL: process.env.JSR_API_URL,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
  };
  const hits = [];
  const registry = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.startsWith("/jsr/")) {
      return res.end(
        JSON.stringify({ license: "MIT", description: "from jsr" }),
      );
    }
    res.end(
      JSON.stringify({
        description: "from the registry",
        versions: { "1.3.0": { license: "WTFPL" } },
      }),
    );
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${registry.address().port}`;
  process.env.JSR_API_URL = `${base}/jsr/`;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  try {
    const { clearHttpCache } = await import("../core/httpClient.js");
    const { resetRunState } = await import("../core/runState.js");
    const { getNpmMetadata } = await import("./ecosystems.js");
    const { getJsrMetadata } = await import("./denoutils.js");
    resetRunState();
    const npmPkg = () => ({ name: "left-pad", version: "1.3.0" });
    const jsrPkg = () => ({
      name: "std__path",
      version: "1.0.0",
      properties: [{ name: "cdx:deno:jsrKey", value: "@std/path@1.0.0" }],
    });

    const [first] = await getNpmMetadata([npmPkg()], `${base}/npm/`);
    await getJsrMetadata([jsrPkg()]);
    // Positive control: the first pass asks for every document.
    assert.deepStrictEqual(hits.sort(), [
      "/jsr/scopes/std/packages/path",
      "/jsr/scopes/std/packages/path/versions/1.0.0",
      "/npm/left-pad",
    ]);
    assert.strictEqual(first.license, "WTFPL");

    hits.length = 0;
    clearHttpCache();
    const [again] = await getNpmMetadata([npmPkg()], `${base}/npm/`);
    const [jsrAgain] = await getJsrMetadata([jsrPkg()]);
    assert.deepStrictEqual(
      hits,
      [],
      "a document the run already held was fetched again",
    );
    assert.strictEqual(again.license, "WTFPL");
    assert.strictEqual(jsrAgain.license, "MIT");
  } finally {
    await new Promise((resolve) => registry.close(resolve));
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
