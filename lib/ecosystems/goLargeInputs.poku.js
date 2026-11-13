import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "poku";

import { parseGoModData, parseGoModGraph } from "./parsers-go.js";

// The Go parsers read text a scanned repository controls, so their cost must
// stay linear in it. Each test here is timed on its own: the parsers are
// async, and a test running beside them would count towards the time.

await it("parseGoModGraph looks up replace directives and direct requirements per edge in constant time", async () => {
  // Go accepts replace directives for modules nothing requires, and every
  // module's edge to the go toolchain is dropped, so a go.mod controls both
  // the number of edges and what each edge would be compared with.
  const count = 8000;
  const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-go-large-graph-"));
  try {
    const goModFile = join(tmpDir, "go.mod");
    const requires = Array.from(
      { length: count },
      (_, i) => `\texample.com/m${i} v1.0.${i}`,
    ).join("\n");
    const replaces = Array.from(
      { length: count },
      (_, i) => `\texample.com/unused${i} => ./u${i}`,
    ).join("\n");
    writeFileSync(
      goModFile,
      `module example.com/app\n\ngo 1.21\n\nrequire (\n${requires}\n)\n\nreplace (\n${replaces}\n)\n`,
    );
    const graph = [];
    for (let i = 0; i < count; i++) {
      graph.push(`example.com/app example.com/m${i}@v1.0.${i}`);
      graph.push(`example.com/m${i}@v1.0.${i} go@1.21`);
    }
    const started = performance.now();
    const retMap = await parseGoModGraph(
      graph.join("\n"),
      goModFile,
      {},
      [],
      {},
    );
    const elapsed = performance.now() - started;
    assert.strictEqual(retMap.pkgList.length, count);
    assert.strictEqual(
      retMap.dependenciesList.find(
        (dep) => dep.ref === "pkg:golang/example.com/app",
      ).dependsOn.length,
      count,
    );
    assert.ok(elapsed < 2500, `the graph took ${Math.round(elapsed)} ms`);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

await it("parseGoModData sorts crafted module paths in linear time", async () => {
  // Two module paths that differ only in a leading combining mark and go on
  // with the same run of U+0F71 and U+0334: collation of such strings costs
  // time cubic in their length, so the components are sorted by code unit.
  const tail = `${"\u0F71".repeat(1000)}${"\u0334".repeat(1000)}`;
  const started = performance.now();
  const retMap = await parseGoModData(
    `module example.com/app\n\ngo 1.21\n\nrequire (\n\t\u0301${tail} v1.0.0\n\t\u0300${tail} v1.0.0\n)\n`,
    {},
  );
  const elapsed = performance.now() - started;
  assert.deepStrictEqual(
    retMap.pkgList.map((component) => component.name),
    [`\u0300${tail}`, `\u0301${tail}`],
  );
  assert.ok(elapsed < 1000, `sorting took ${Math.round(elapsed)} ms`);
});
