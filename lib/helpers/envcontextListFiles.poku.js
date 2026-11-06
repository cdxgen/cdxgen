import { join } from "node:path";

import { assert, it } from "poku";

import { listFiles } from "./envcontext.js";

it("listFiles() lists only the scanned directory of a larger repository", () => {
  const fixtureDir = join(
    import.meta.dirname,
    "..",
    "..",
    "test",
    "data",
    "go-dataflow-repotest",
  );
  const names = listFiles(fixtureDir)
    .map((file) => file.name)
    .sort();
  assert.deepStrictEqual(names, ["go.mod", "go.sum", "main.go"]);
});
