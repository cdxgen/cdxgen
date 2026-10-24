import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  attachNodeBuild,
  createNodeRuntimeComponent,
  createNodeRuntimeInventory,
  isNodeBinaryName,
  nodeBuildProperties,
  nodeCpe,
  parseNodeVersion,
  readNodeBuildVersion,
} from "./nodeBuildInfo.js";

// The strings below are the ones the official Node.js 24.22.0 linux-arm64
// binary carries; the files around them are built by these tests.
function nodeBinary({ release, userAgent }) {
  const parts = [Buffer.alloc(256, 0x90)];
  if (release) {
    parts.push(
      Buffer.from(
        `https://nodejs.org/download/${release}-headers.tar.gz\0`,
        "latin1",
      ),
    );
  }
  if (userAgent) {
    parts.push(Buffer.from(`\0node.js/v${userAgent}\0`, "latin1"));
  }
  parts.push(Buffer.alloc(256, 0x90));
  return Buffer.concat(parts);
}

function withBinary(content, fn) {
  const work = mkdtempSync(join(tmpdir(), "cdxgen-nodebuild-"));
  try {
    const file = join(work, "node");
    writeFileSync(file, content);
    return fn(file, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("isNodeBinaryName()", () => {
  it("knows the names the runtime installs under", () => {
    for (const name of [
      "node",
      "nodejs",
      "node.exe",
      "/usr/local/bin/node",
      "C:\\Program Files\\nodejs\\node.exe",
    ]) {
      assert.ok(isNodeBinaryName(name), name);
    }
    for (const name of ["node-gyp", "nodemon", "node.js", "", undefined]) {
      assert.ok(!isNodeBinaryName(name), `${name}`);
    }
  });
});

describe("parseNodeVersion()", () => {
  it("accepts release, rc and nightly versions only", () => {
    for (const version of [
      "24.22.1",
      "25.0.0-rc.1",
      "26.0.0-nightly20260301abcdef0123",
    ]) {
      assert.strictEqual(parseNodeVersion(version), version);
    }
    for (const version of ["24.22", "v24.22.1", "24.22.1 ", "24.22.1-", ""]) {
      assert.strictEqual(parseNodeVersion(version), undefined, version);
    }
    assert.strictEqual(parseNodeVersion(`1.2.3-${"a".repeat(80)}`), undefined);
  });
});

describe("readNodeBuildVersion()", () => {
  it("reads a release build from its headers URL", () =>
    withBinary(
      nodeBinary({
        release: "release/v24.22.0/node-v24.22.0",
        userAgent: "24.22.0",
      }),
      (file, root) => {
        assert.deepStrictEqual(readNodeBuildVersion(file, root), {
          version: "24.22.0",
          source: "release-url",
          channel: "release",
        });
      },
    ));

  it("reads the release channel of a release candidate", () =>
    withBinary(
      nodeBinary({ release: "rc/v25.0.0-rc.1/node-v25.0.0-rc.1" }),
      (file) => {
        assert.deepStrictEqual(readNodeBuildVersion(file), {
          version: "25.0.0-rc.1",
          source: "release-url",
          channel: "rc",
        });
      },
    ));

  it("falls back to the version string of a build without release URLs", () =>
    withBinary(nodeBinary({ userAgent: "24.22.1" }), (file) => {
      assert.deepStrictEqual(readNodeBuildVersion(file), {
        version: "24.22.1",
        source: "binary",
      });
    }));

  it("trusts the binary's own version when the URL disagrees", () =>
    withBinary(
      nodeBinary({
        release: "release/v24.22.0/node-v24.22.0",
        userAgent: "24.22.1",
      }),
      (file) => {
        assert.deepStrictEqual(readNodeBuildVersion(file), {
          version: "24.22.1",
          source: "binary",
        });
      },
    ));

  it("ignores unknown channels and files without a marker", () => {
    withBinary(
      nodeBinary({ release: "evil/v24.22.0/node-v24.22.0" }),
      (file) => {
        assert.strictEqual(readNodeBuildVersion(file), undefined);
      },
    );
    withBinary(Buffer.from("not node at all"), (file) => {
      assert.strictEqual(readNodeBuildVersion(file), undefined);
    });
  });
});

describe("Node.js runtime components", () => {
  it("names the runtime with a matchable purl and CPE", () => {
    assert.deepStrictEqual(createNodeRuntimeComponent("24.22.0"), {
      type: "platform",
      name: "node",
      version: "24.22.0",
      cpe: "cpe:2.3:a:nodejs:node.js:24.22.0:*:*:*:*:*:*:*",
      purl: "pkg:generic/node@24.22.0",
      "bom-ref": "pkg:generic/node@24.22.0",
    });
    assert.strictEqual(
      nodeCpe("25.0.0-rc.1"),
      "cpe:2.3:a:nodejs:node.js:25.0.0:rc1:*:*:*:*:*:*",
    );
  });

  it("links each file to one runtime component per version", () => {
    const inventory = createNodeRuntimeInventory();
    const build = {
      version: "24.22.0",
      source: "release-url",
      channel: "release",
    };
    const first = { "bom-ref": "pkg:generic/node", properties: [] };
    const second = {
      "bom-ref": "pkg:generic/node#opt/n/bin/node",
      properties: [],
    };
    attachNodeBuild(inventory, first, build);
    attachNodeBuild(inventory, second, build);
    assert.strictEqual(inventory.runtimeComponents.length, 1);
    assert.deepStrictEqual(first.properties, nodeBuildProperties(build));
    assert.deepStrictEqual(
      inventory.dependencies.map((d) => [d.ref, d.dependsOn]),
      [
        ["pkg:generic/node@24.22.0", []],
        ["pkg:generic/node", ["pkg:generic/node@24.22.0"]],
        ["pkg:generic/node#opt/n/bin/node", ["pkg:generic/node@24.22.0"]],
      ],
    );
  });
});
