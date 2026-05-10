import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

async function loadBinaryModule({ utilsOverrides } = {}) {
  return esmock("./binary.js", {
    "../helpers/utils.js": {
      adjustLicenseInformation: sinon.stub(),
      attachIdentityTools: sinon.stub(),
      collectExecutables: sinon.stub().returns([]),
      collectSharedLibs: sinon.stub().returns([]),
      DEBUG_MODE: false,
      dirNameStr: "/tmp",
      extractPathEnv: sinon.stub().returns([]),
      extractToolRefs: sinon.stub().returns([]),
      findLicenseId: sinon.stub(),
      getTmpDir: sinon.stub().returns("/tmp"),
      isDryRun: false,
      isSpdxLicenseExpression: sinon.stub().returns(false),
      multiChecksumFile: sinon.stub(),
      recordActivity: sinon.stub(),
      recordSymlinkResolution: sinon.stub(),
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
    "./containerutils.js": {
      getDirs: sinon.stub().returns([]),
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

it("getOSPackages() creates package-owned file components and services from Trivy properties", async () => {
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-"));
  const trivyTempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-trivy-"));
  const bomJsonFile = path.join(trivyTempDir, "trivy-bom.json");
  const packagePurl = "pkg:apk/alpine/demo@1.0-r0?distro=alpine-3.20";
  const packageRef = decodeURIComponent(packagePurl);
  const collectExecutables = sinon.stub().returns([]);
  const collectSharedLibs = sinon.stub().returns([]);
  try {
    mkdirSync(path.join(rootfs, "usr", "bin"), { recursive: true });
    mkdirSync(path.join(rootfs, "usr", "lib"), { recursive: true });
    mkdirSync(path.join(rootfs, "etc", "init.d"), { recursive: true });
    mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    writeFileSync(path.join(rootfs, "usr", "bin", "demo"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    writeFileSync(path.join(rootfs, "usr", "lib", "libdemo.so.1"), "binary", {
      mode: 0o644,
    });
    writeFileSync(
      path.join(rootfs, "etc", "init.d", "demosvc"),
      [
        "#!/bin/sh",
        "### BEGIN INIT INFO",
        "# Provides: demosvc",
        "# Short-Description: Demo service",
        "### END INIT INFO",
        "/usr/bin/demo start",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(rootfs, "etc", "os-release"),
      "ID=alpine\nVERSION_ID=3.20.0\n",
    );
    writeFileSync(
      bomJsonFile,
      JSON.stringify({
        metadata: { tools: [] },
        components: [
          {
            "bom-ref": packageRef,
            name: "demo",
            purl: packagePurl,
            properties: [
              { name: "aquasecurity:trivy:PkgID", value: "demo@1.0-r0" },
              { name: "aquasecurity:trivy:PkgType", value: "apk" },
              { name: "aquasecurity:trivy:Capability", value: "cmd:demo" },
              {
                name: "aquasecurity:trivy:CapabilityCount",
                value: "1",
              },
              {
                name: "aquasecurity:trivy:InstalledCommand",
                value: "demo",
              },
              {
                name: "aquasecurity:trivy:InstalledCommandCount",
                value: "1",
              },
              {
                name: "aquasecurity:trivy:InstalledCommandPath",
                value: "/usr/bin/demo",
              },
              {
                name: "aquasecurity:trivy:InstalledFileCount",
                value: "3",
              },
              {
                name: "aquasecurity:trivy:InstalledFile",
                value: "/usr/bin/demo",
              },
              {
                name: "aquasecurity:trivy:InstalledFile",
                value: "/usr/lib/libdemo.so.1",
              },
              {
                name: "aquasecurity:trivy:InstalledFile",
                value: "/etc/init.d/demosvc",
              },
            ],
          },
        ],
        dependencies: [],
      }),
    );
    const originalTrivyCmd = process.env.TRIVY_CMD;
    process.env.TRIVY_CMD = "/usr/bin/true";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables,
        collectSharedLibs,
        extractPathEnv: sinon.stub().returns(["/usr/bin"]),
        getTmpDir: sinon.stub().returns(path.dirname(trivyTempDir)),
        multiChecksumFile: sinon.stub().resolves({
          md5: "a".repeat(32),
          sha1: "b".repeat(40),
        }),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeMkdtempSync: sinon.stub().returns(trivyTempDir),
        safeSpawnSync: sinon.stub().callsFake((command) => {
          if (command === "ldd") {
            return { status: 1, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }),
      },
    });
    const result = await getOSPackages(rootfs, { Env: ["PATH=/usr/bin"] });
    process.env.TRIVY_CMD = originalTrivyCmd;

    assert.strictEqual(result.osPackages.length, 1);
    assert.strictEqual(result.osPackageFiles.length, 3);
    assert.strictEqual(result.services.length, 1);
    assert.strictEqual(result.services[0].name, "demosvc");
    assert.ok(
      result.osPackages[0].properties.some(
        (prop) => prop.name.endsWith("Capability") && prop.value === "cmd:demo",
      ),
    );
    assert.ok(
      result.osPackageFiles.some(
        (component) =>
          component.properties.some(
            (prop) => prop.name === "SrcFile" && prop.value === "/usr/bin/demo",
          ) &&
          component.properties.some(
            (prop) =>
              prop.name === "internal:is_executable" && prop.value === "true",
          ),
      ),
    );
    assert.ok(
      result.dependenciesList.some(
        (dependency) =>
          Array.isArray(dependency.provides) && dependency.provides.length >= 3,
      ),
    );
    assert.ok(
      result.dependenciesList.some(
        (dependency) =>
          dependency.ref === result.services[0]["bom-ref"] &&
          Array.isArray(dependency.dependsOn) &&
          dependency.dependsOn.length > 0,
      ),
    );
    sinon.assert.calledWithMatch(
      collectExecutables,
      rootfs,
      ["/usr/bin"],
      ["/etc/init.d/demosvc", "/usr/bin/demo", "/usr/lib/libdemo.so.1"],
    );
    sinon.assert.calledWithMatch(
      collectSharedLibs,
      rootfs,
      sinon.match.array,
      "/etc/ld.so.conf",
      "/etc/ld.so.conf.d/*.conf",
      ["/etc/init.d/demosvc", "/usr/bin/demo", "/usr/lib/libdemo.so.1"],
    );
  } finally {
    rmSync(rootfs, { recursive: true, force: true });
    rmSync(trivyTempDir, { recursive: true, force: true });
    delete process.env.TRIVY_CMD;
  }
});
