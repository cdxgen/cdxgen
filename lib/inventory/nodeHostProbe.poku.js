import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { probeHostNode } from "./nodeHostProbe.js";

// Every file below is built by these tests: the strings stand in for the
// release URL and decoder error names an official Node.js binary carries.
const UNPATCHED = "\0_ERROR_FORMAT_EXUBERANT_NIBBLE\0";
const PATCHED = `${UNPATCHED}_ERROR_FORMAT_BLOCK_SWITCH\0`;

function nodeBinary(version, decoder = UNPATCHED) {
  return Buffer.from(
    `https://nodejs.org/download/release/v${version}/node-v${version}-headers.tar.gz\0node.js/v${version}\0${decoder}`,
    "latin1",
  );
}

function put(root, file, content) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content, { mode: 0o755 });
}

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-nodehost-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const versionOf = (component) =>
  component.properties?.find((p) => p.name === "cdx:node:buildVersion")?.value;

describe("probeHostNode()", () => {
  it("finds tarball and version-manager installs and their decoders", () =>
    withRoot((root) => {
      put(root, "usr/local/bin/node", nodeBinary("24.22.0"));
      put(root, "opt/node-v22/bin/node", nodeBinary("22.23.4", PATCHED));
      put(
        root,
        "home/dev/.nvm/versions/node/v20.20.2/bin/node",
        nodeBinary("20.20.2"),
      );
      put(
        root,
        "root/.local/share/fnm/node-versions/v26.12.1/installation/bin/node",
        nodeBinary("26.12.1", PATCHED),
      );
      put(
        root,
        "home/dev/.volta/tools/image/node/24.22.1/bin/node",
        nodeBinary("24.22.1", PATCHED),
      );
      // Not node: never a candidate.
      put(root, "usr/local/bin/nodemon", nodeBinary("24.22.0"));
      const { components } = probeHostNode({
        rootPath: root,
        platform: "linux",
      });
      const files = components.filter((c) => c.type === "file");
      assert.deepStrictEqual(files.map(versionOf).sort(), [
        "20.20.2",
        "22.23.4",
        "24.22.0",
        "24.22.1",
        "26.12.1",
      ]);
      // Files are named by where they are: a host holds several node binaries.
      assert.ok(
        files.some(
          (c) =>
            c.purl ===
            "pkg:generic/node#home/dev/.nvm/versions/node/v20.20.2/bin/node",
        ),
      );
      const runtimes = components.filter((c) => c.type === "platform");
      assert.strictEqual(runtimes.length, 5);
      const brotli = components.find((c) => c.purl === "pkg:generic/brotli");
      assert.deepStrictEqual(
        brotli.properties.map((p) => [p.name, p.value]),
        [
          ["cdx:brotli:embeddedCopies", "5"],
          ["cdx:brotli:unpatchedCopies", "2"],
        ],
      );
    }));

  it("leaves a package-owned or Homebrew Node.js to its package", () =>
    withRoot((root) => {
      put(root, "usr/local/bin/node", nodeBinary("24.22.0"));
      put(root, "var/lib/dpkg/info/nodejs.list", "/usr/local/bin/node\n");
      put(
        root,
        "opt/homebrew/Cellar/node/26.11.1/bin/node",
        nodeBinary("26.11.1"),
      );
      mkdirSync(join(root, "opt/homebrew/bin"), { recursive: true });
      try {
        symlinkSync(
          join(root, "opt/homebrew/Cellar/node/26.11.1/bin/node"),
          join(root, "opt/homebrew/bin/node"),
        );
      } catch (err) {
        if (err.code !== "EPERM") {
          throw err;
        }
      }
      assert.deepStrictEqual(
        probeHostNode({ rootPath: root, platform: "darwin" }).components,
        [],
      );
      assert.deepStrictEqual(
        probeHostNode({ rootPath: root, platform: "linux" }).components,
        [],
      );
    }));

  it("skips a binary without a version marker", () =>
    withRoot((root) => {
      put(root, "usr/local/bin/node", '#!/bin/sh\nexec real-node "$@"\n');
      assert.deepStrictEqual(
        probeHostNode({ rootPath: root, platform: "linux" }).components,
        [],
      );
    }));

  it("is blocked in dry-run mode", async () => {
    const recordActivity = sinon.stub();
    const { probeHostNode: mocked } = await esmock("./nodeHostProbe.js", {
      "../core/activity.js": { isDryRun: true, recordActivity },
    });
    await withRoot((root) => {
      put(root, "usr/local/bin/node", nodeBinary("24.22.0"));
      assert.deepStrictEqual(mocked({ rootPath: root, platform: "linux" }), {
        components: [],
        dependencies: [],
      });
    });
    sinon.assert.calledWithMatch(recordActivity, {
      capability: "node-host-probe",
      status: "blocked",
    });
  });
});
