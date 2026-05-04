import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

async function loadBinaryModule({ utilsOverrides } = {}) {
  return esmock("./binary.js", {
    "../helpers/utils.js": {
      adjustLicenseInformation: sinon.stub(),
      collectExecutables: sinon.stub().returns([]),
      collectSharedLibs: sinon.stub().returns([]),
      DEBUG_MODE: false,
      dirNameStr: "/tmp",
      extractPathEnv: sinon.stub().returns([]),
      findLicenseId: sinon.stub(),
      getTmpDir: sinon.stub().returns("/tmp"),
      isDryRun: false,
      isSpdxLicenseExpression: sinon.stub().returns(false),
      multiChecksumFile: sinon.stub(),
      recordActivity: sinon.stub(),
      retrieveCdxgenPluginVersion: sinon.stub().returns("1.0.0"),
      safeExistsSync: sinon.stub().returns(false),
      safeMkdirSync: sinon.stub(),
      safeMkdtempSync: sinon.stub().returns("/tmp/trivy-cdxgen-test"),
      safeRmSync: sinon.stub(),
      safeSpawnSync: sinon
        .stub()
        .returns({ status: 1, stdout: "", stderr: "" }),
      ...utilsOverrides,
    },
  });
}

it("executeOsQuery() reports a blocked dry-run activity", async () => {
  const recordActivity = sinon.stub();
  const { executeOsQuery } = await loadBinaryModule({
    utilsOverrides: {
      isDryRun: true,
      recordActivity,
    },
  });
  const result = executeOsQuery("select * from processes");
  assert.strictEqual(result, undefined);
  sinon.assert.calledWithMatch(recordActivity, {
    kind: "osquery",
    status: "blocked",
    target: "select * from processes",
  });
});

it("getOSPackages() returns empty collections and reports a blocked dry-run activity", async () => {
  const recordActivity = sinon.stub();
  const { getOSPackages } = await loadBinaryModule({
    utilsOverrides: {
      isDryRun: true,
      recordActivity,
    },
  });
  const result = await getOSPackages("/tmp/rootfs", {});
  assert.deepStrictEqual(result.osPackages, []);
  assert.deepStrictEqual(result.dependenciesList, []);
  assert.deepStrictEqual(result.binPaths, []);
  assert.deepStrictEqual(Array.from(result.allTypes), []);
  assert.deepStrictEqual(result.tools, []);
  sinon.assert.calledWithMatch(recordActivity, {
    kind: "container",
    status: "blocked",
    target: "/tmp/rootfs",
  });
});
