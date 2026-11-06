import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, it } from "poku";

import { toPortablePath } from "./bomTestHelpers.poku.js";
import { createNodejsBom } from "./jsBom.js";

// The fixture's lock file installs ms twice: 2.1.3 hoisted for the root, which
// src/index.js uses, and 2.0.0 under the workspace member packages/legacy,
// which packages/legacy/index.js uses. debug 2.6.9 needs ms 2.0.0 as well, so
// a third copy sits under node_modules/debug. The development dependency
// humanize-ms brings ms 0.6.2, which no file of the project loads.
const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "npm-version-resolution-repotest",
);

const { bomJson } = await createNodejsBom(fixtureDir, {
  installDeps: false,
  multiProject: false,
  specVersion: 1.7,
});

const componentOf = (purl) =>
  bomJson.components.find((comp) => comp.purl === purl);

const occurrencesOf = (purl) =>
  (componentOf(purl)?.evidence?.occurrences || [])
    .map((o) => `${toPortablePath(o.location)}#${o.line}`)
    .sort();

await it("credits each file's import of ms to the copy that file loads", () => {
  assert.deepStrictEqual(occurrencesOf("pkg:npm/ms@2.1.3"), ["src/index.js#2"]);
  assert.deepStrictEqual(occurrencesOf("pkg:npm/ms@2.0.0"), [
    "packages/legacy/index.js#1",
  ]);
  assert.deepStrictEqual(occurrencesOf("pkg:npm/debug@2.6.9"), [
    "src/index.js#1",
  ]);
});

await it("keeps both ms versions required, each through its own user", () => {
  assert.strictEqual(componentOf("pkg:npm/ms@2.1.3")?.scope, "required");
  assert.strictEqual(componentOf("pkg:npm/ms@2.0.0")?.scope, "required");
});

await it("does not promote a copy no project file loads", () => {
  const unused = componentOf("pkg:npm/ms@0.6.2");
  assert.ok(unused, "expected the copy under humanize-ms");
  assert.strictEqual(unused.scope, "optional");
  assert.strictEqual(unused.evidence?.occurrences, undefined);
});

await it("writes no version-resolution bookkeeping into the BOM", () => {
  const text = JSON.stringify(bomJson);
  assert.ok(!text.includes("_npmImportsResolveElsewhere"));
  assert.ok(!text.includes("internal:LocalNodeModulesPath"));
});
