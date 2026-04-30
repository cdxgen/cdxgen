import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

it("getTreeWithPlugin() reports dry-run temp-dir, write, execute, and cleanup activity", async () => {
  const safeMkdtempSync = sinon.stub().returns("/tmp/cdxgen-piptree-test");
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
  sinon.assert.calledWithMatch(
    safeWriteSync,
    "/tmp/cdxgen-piptree-test/piptree.py",
    sinon.match.string,
  );
  sinon.assert.calledWith(
    safeSpawnSync,
    "python3",
    [
      "/tmp/cdxgen-piptree-test/piptree.py",
      "/tmp/cdxgen-piptree-test/piptree.json",
    ],
    {
      cwd: "/repo",
      env: {},
    },
  );
  sinon.assert.calledWith(safeRmSync, "/tmp/cdxgen-piptree-test", {
    force: true,
    recursive: true,
  });
});
