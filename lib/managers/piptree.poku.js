import path from "node:path";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

it("getTreeWithPlugin() reports dry-run temp-dir, write, execute, and cleanup activity", async () => {
  const tempDir = path.join(path.sep, "tmp", "cdxgen-piptree-test");
  const pluginFile = path.join(tempDir, "piptree.py");
  const outputFile = path.join(tempDir, "piptree.json");
  const safeMkdtempSync = sinon.stub().returns(tempDir);
  const safeWriteSync = sinon.stub();
  const safeSpawnSync = sinon.stub().returns({
    error: new Error("dry run"),
    status: 1,
    stderr: "",
    stdout: "",
  });
  const safeRmSync = sinon.stub();
  const { getTreeWithPlugin } = await esmock("./piptree.js", {
    "../helpers/utils.js": {
      getTmpDir: sinon.stub().returns("/tmp"),
      safeExistsSync: sinon.stub().returns(false),
      safeMkdtempSync,
      safeRmSync,
      safeSpawnSync,
      safeWriteSync,
    },
  });

  const result = getTreeWithPlugin({}, "python3", "/repo");

  assert.deepStrictEqual(result, []);
  sinon.assert.calledOnce(safeMkdtempSync);
  sinon.assert.calledWithMatch(safeWriteSync, pluginFile, sinon.match.string);
  sinon.assert.calledWith(safeSpawnSync, "python3", [pluginFile, outputFile], {
    cwd: "/repo",
    env: {},
  });
  sinon.assert.calledWith(safeRmSync, tempDir, {
    force: true,
    recursive: true,
  });
});
