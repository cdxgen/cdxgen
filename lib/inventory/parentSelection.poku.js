import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { manifestDepth, orderParentCandidates } from "./parentSelection.js";

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "parent-select-"));
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "{}");
  }
  return root;
}

describe("manifestDepth()", () => {
  it("is 0 at the root, the shallowest depth below it, Infinity otherwise", () => {
    const root = tree([
      "CMakeLists.txt",
      "tools/ui/client/package.json",
      "dev_tools/pylibs/pyproject.toml",
      "src/app/App.csproj",
    ]);
    try {
      assert.strictEqual(manifestDepth(root, "generic"), 0);
      assert.strictEqual(manifestDepth(root, "npm"), 3);
      assert.strictEqual(manifestDepth(root, "pypi"), 2);
      assert.strictEqual(manifestDepth(root, "nuget"), 2);
      assert.strictEqual(
        manifestDepth(root, "cargo"),
        Number.POSITIVE_INFINITY,
      );
      assert.strictEqual(
        manifestDepth(root, "unknown"),
        Number.POSITIVE_INFINITY,
      );
      assert.strictEqual(
        manifestDepth(join(root, "missing"), "npm"),
        Number.POSITIVE_INFINITY,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("orderParentCandidates()", () => {
  const npm = { name: "client", purl: "pkg:npm/client@1.0.0" };
  const py = { name: "tools", purl: "pkg:pypi/tools@latest" };
  const cmake = { name: "compiler", purl: "pkg:generic/compiler" };
  const maven = { name: "svc", purl: "pkg:maven/acme/svc@1.0" };

  it("puts the project whose manifest is at the root first", () => {
    const root = tree([
      "CMakeLists.txt",
      "tools/ui/client/package.json",
      "dev_tools/pylibs/pyproject.toml",
    ]);
    try {
      assert.deepStrictEqual(
        orderParentCandidates([npm, py, cmake], [root]).map((c) => c.name),
        ["compiler", "tools", "client"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the scan order for equally deep manifests and unknown ecosystems", () => {
    const root = tree(["package.json", "pom.xml"]);
    try {
      const unknown = { name: "x", purl: "pkg:oci/x@sha256:abc" };
      assert.deepStrictEqual(
        orderParentCandidates(
          [npm, maven, unknown, { name: "nopurl" }],
          [root],
        ).map((c) => c.name),
        ["client", "svc", "x", "nopurl"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the shallowest depth across several scan roots", () => {
    const a = tree(["web/package.json"]);
    const b = tree(["pom.xml"]);
    try {
      assert.deepStrictEqual(
        orderParentCandidates([npm, maven], [a, b]).map((c) => c.name),
        ["svc", "client"],
      );
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
