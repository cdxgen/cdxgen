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

it("executeOsQuery() uses osquery shell mode with the persistent database disabled", async () => {
  const safeSpawnSync = sinon
    .stub()
    .returns({ status: 0, stdout: '[{"ok":"1"}]', stderr: "" });
  const previousOsqueryCmd = process.env.OSQUERY_CMD;
  process.env.OSQUERY_CMD = "/tmp/osqueryd";
  try {
    const { executeOsQuery } = await loadBinaryModule({
      utilsOverrides: {
        safeSpawnSync,
      },
    });
    const result = executeOsQuery("select 1 as ok");
    assert.deepStrictEqual(result, [{ ok: "1" }]);
    assert.ok(safeSpawnSync.callCount >= 1);
    assert.strictEqual(safeSpawnSync.lastCall.args[0], "/tmp/osqueryd");
    const args = safeSpawnSync.lastCall.args[1];
    assert.ok(args.includes("--S"));
    assert.ok(args.includes("--disable_database"));
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("select 1 as ok;"));
    if (process.platform === "darwin") {
      assert.ok(args.includes("--allow_unsafe"));
      assert.ok(args.includes("--disable_logging"));
      assert.ok(args.includes("--disable_events"));
    }
  } finally {
    if (previousOsqueryCmd === undefined) {
      delete process.env.OSQUERY_CMD;
    } else {
      process.env.OSQUERY_CMD = previousOsqueryCmd;
    }
  }
});

it("getPluginToolComponents() reads precise tool metadata from the plugins manifest", async () => {
  const pluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-plugins-manifest-"),
  );
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  try {
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.0",
              purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
              "bom-ref":
                "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
              hashes: [{ alg: "SHA-256", content: "a".repeat(64) }],
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    const { getPluginToolComponents } = await loadBinaryModule({
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
      },
    });
    const tools = getPluginToolComponents(["trustinspector"]);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "trustinspector");
    assert.strictEqual(tools[0].version, "2.1.0");
    assert.match(tools[0].purl, /trustinspector-cdxgen/);
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
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

it("getOSPackages() inventories rootfs repository sources and trusted keys without Trivy package data", async () => {
  const rootfs = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-repos-"));
  const pluginsDir = mkdtempSync(path.join(tmpdir(), "cdxgen-plugins-rootfs-"));
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  const previousTrustInspectorCmd = process.env.TRUSTINSPECTOR_CMD;
  try {
    mkdirSync(path.join(rootfs, "etc", "apt", "sources.list.d"), {
      recursive: true,
    });
    mkdirSync(path.join(rootfs, "usr", "share", "keyrings"), {
      recursive: true,
    });
    mkdirSync(path.join(rootfs, "etc", "yum.repos.d"), { recursive: true });
    mkdirSync(path.join(rootfs, "etc", "pki", "rpm-gpg"), {
      recursive: true,
    });
    writeFileSync(
      path.join(rootfs, "etc", "apt", "sources.list.d", "ondrej-php.list"),
      "deb [signed-by=/usr/share/keyrings/ondrej-php.gpg] https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble main\n",
    );
    writeFileSync(
      path.join(rootfs, "usr", "share", "keyrings", "ondrej-php.gpg"),
      "fake-apt-key",
    );
    writeFileSync(
      path.join(rootfs, "etc", "yum.repos.d", "custom.repo"),
      [
        "[custom]",
        "name=Custom Repo",
        "baseurl=https://packages.example.test/rpm/$basearch",
        "enabled=1",
        "gpgcheck=1",
        "gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-test",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(rootfs, "etc", "pki", "rpm-gpg", "RPM-GPG-KEY-test"),
      "fake-rpm-key",
    );
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.0",
              purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
              "bom-ref":
                "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    process.env.TRUSTINSPECTOR_CMD = "/tmp/trustinspector";
    const { getOSPackages } = await loadBinaryModule({
      utilsOverrides: {
        collectExecutables: sinon.stub().returns([]),
        collectSharedLibs: sinon.stub().returns([]),
        extractPathEnv: sinon.stub().returns([]),
        multiChecksumFile: sinon
          .stub()
          .callsFake(async (_algorithms, filePath) => ({
            sha1: filePath.includes("ondrej") ? "1".repeat(40) : "2".repeat(40),
            sha256: filePath.includes("ondrej")
              ? "a".repeat(64)
              : "b".repeat(64),
          })),
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeSpawnSync: sinon.stub().callsFake((command, args) => {
          if (command === "ldd") {
            return { status: 1, stdout: "", stderr: "" };
          }
          if (command === "/tmp/trustinspector" && args[0] === "rootfs") {
            return {
              status: 0,
              stdout: JSON.stringify({
                materials: [
                  {
                    kind: "public-key",
                    path: "/usr/share/keyrings/ondrej-php.gpg",
                    name: "ondrej-php.gpg",
                    trustDomain: "apt",
                    sourceType: "repository-keyring",
                    fileExtension: "gpg",
                    sha1: "1".repeat(40),
                    sha256: "a".repeat(64),
                    keyId: "ABCDEF1234567890",
                    algorithm: "RSA",
                    keyStrength: 4096,
                    fingerprint: "F".repeat(40),
                    userIds: ["Ondrej Surý <ondrej@example.test>"],
                    properties: [
                      {
                        name: "cdx:crypto:sourceType",
                        value: "repository-keyring",
                      },
                    ],
                  },
                  {
                    kind: "certificate",
                    path: "/etc/ssl/certs/demo-root.crt",
                    name: "demo-root",
                    trustDomain: "ca-store",
                    sourceType: "ca-store",
                    fileExtension: "crt",
                    sha1: "3".repeat(40),
                    sha256: "c".repeat(64),
                    algorithm: "RSA",
                    keyStrength: 2048,
                    createdAt: "2024-01-01T00:00:00Z",
                    expiresAt: "2034-01-01T00:00:00Z",
                    fingerprint: "D".repeat(64),
                    subject: "CN=demo-root,O=Example Org",
                    issuer: "CN=demo-root,O=Example Org",
                    serial: "42",
                    format: "X.509",
                    properties: [{ name: "cdx:crypto:isCA", value: "true" }],
                  },
                ],
              }),
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        }),
      },
    });
    const result = await getOSPackages(rootfs, { Env: [] });

    const cryptoComponents = result.osPackages.filter(
      (component) => component.type === "cryptographic-asset",
    );
    const ppaComponent = result.osPackages.find(
      (component) =>
        component.type === "data" &&
        component.properties?.some(
          (property) =>
            property.name === "cdx:os:repo:type" &&
            property.value === "ppa-source",
        ),
    );
    const yumComponent = result.osPackages.find(
      (component) =>
        component.type === "data" &&
        component.properties?.some(
          (property) =>
            property.name === "cdx:os:repo:type" &&
            property.value === "yum-source",
        ),
    );
    const ppaKeyRef = cryptoComponents.find((component) =>
      component.properties?.some(
        (property) =>
          property.name === "SrcFile" &&
          property.value === "/usr/share/keyrings/ondrej-php.gpg",
      ),
    )?.["bom-ref"];
    const yumKeyRef = cryptoComponents.find((component) =>
      component.properties?.some(
        (property) =>
          property.name === "SrcFile" &&
          property.value === "/etc/pki/rpm-gpg/RPM-GPG-KEY-test",
      ),
    )?.["bom-ref"];

    assert.strictEqual(cryptoComponents.length, 3);
    assert.ok(
      cryptoComponents.some(
        (component) =>
          component.cryptoProperties?.assetType === "related-crypto-material" &&
          component.cryptoProperties?.relatedCryptoMaterialProperties?.type ===
            "public-key",
      ),
    );
    assert.ok(
      cryptoComponents.some(
        (component) =>
          component.cryptoProperties?.assetType === "certificate" &&
          component.properties?.some(
            (property) =>
              property.name === "cdx:crypto:trustDomain" &&
              property.value === "ca-store",
          ),
      ),
    );
    assert.ok(
      cryptoComponents.some((component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:crypto:keyId" &&
            property.value === "ABCDEF1234567890",
        ),
      ),
    );
    assert.ok(ppaComponent);
    assert.ok(yumComponent);
    assert.ok(ppaKeyRef);
    assert.ok(yumKeyRef);
    assert.ok(
      result.dependenciesList.some(
        (dependency) =>
          dependency.ref === ppaComponent["bom-ref"] &&
          Array.isArray(dependency.dependsOn) &&
          dependency.dependsOn.includes(ppaKeyRef),
      ),
    );
    assert.ok(
      result.dependenciesList.some(
        (dependency) =>
          dependency.ref === yumComponent["bom-ref"] &&
          Array.isArray(dependency.dependsOn) &&
          dependency.dependsOn.includes(yumKeyRef),
      ),
    );
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    if (previousTrustInspectorCmd === undefined) {
      delete process.env.TRUSTINSPECTOR_CMD;
    } else {
      process.env.TRUSTINSPECTOR_CMD = previousTrustInspectorCmd;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
    rmSync(rootfs, { recursive: true, force: true });
  }
});

it("enrichOSComponentsWithTrustData() merges path inspections and host findings", async () => {
  if (!["darwin", "win32"].includes(process.platform)) {
    return;
  }
  const pluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-plugins-hosttrust-"),
  );
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  const previousTrustInspectorCmd = process.env.TRUSTINSPECTOR_CMD;
  const inspectedPath =
    process.platform === "win32"
      ? "C:\\Demo\\demo.exe"
      : "/Applications/Demo.app";
  const expectedProperty =
    process.platform === "win32"
      ? { name: "cdx:windows:authenticode:status", value: "Valid" }
      : { name: "cdx:darwin:codesign:teamIdentifier", value: "ABCDE12345" };
  const hostFinding =
    process.platform === "win32"
      ? {
          kind: "windows-wdac-status",
          name: "wdac-active-policies",
          version: "1",
          description: "active policies",
          properties: [
            {
              name: "cdx:windows:wdac:activePolicyCount",
              value: "1",
            },
          ],
        }
      : {
          kind: "darwin-gatekeeper-status",
          name: "gatekeeper-system-policy",
          version: "enabled",
          description: "assessments enabled",
          properties: [
            {
              name: "cdx:darwin:gatekeeper:status",
              value: "enabled",
            },
          ],
        };
  try {
    writeFileSync(
      path.join(pluginsDir, "plugins-manifest.json"),
      JSON.stringify({
        plugins: [
          {
            name: "trustinspector",
            component: {
              type: "application",
              name: "trustinspector",
              version: "2.1.0",
              purl: "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
              "bom-ref":
                "pkg:generic/github.com/cdxgen/cdxgen-plugins-bin/trustinspector-cdxgen@2.1.0",
            },
          },
        ],
      }),
    );
    process.env.CDXGEN_PLUGINS_DIR = pluginsDir;
    process.env.TRUSTINSPECTOR_CMD = "/tmp/trustinspector";
    const { enrichOSComponentsWithTrustData } = await loadBinaryModule({
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => existsSync(filePath)),
        safeSpawnSync: sinon.stub().callsFake((command, args) => {
          if (command === "ldd") {
            return { status: 1, stdout: "", stderr: "" };
          }
          if (command === "/tmp/trustinspector" && args[0] === "paths") {
            return {
              status: 0,
              stdout: JSON.stringify({
                inspections: [
                  {
                    path: inspectedPath,
                    properties: [expectedProperty],
                  },
                ],
              }),
              stderr: "",
            };
          }
          if (command === "/tmp/trustinspector" && args[0] === "host") {
            return {
              status: 0,
              stdout: JSON.stringify({ hostFindings: [hostFinding] }),
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        }),
      },
    });
    const result = enrichOSComponentsWithTrustData([
      {
        type: "application",
        name: "Demo",
        "bom-ref": "app-demo",
        properties: [{ name: "path", value: inspectedPath }],
      },
    ]);
    assert.ok(
      result.components[0].properties.some(
        (property) =>
          property.name === expectedProperty.name &&
          property.value === expectedProperty.value,
      ),
    );
    assert.ok(
      result.components.some(
        (component) =>
          component.type === "data" && component.name === hostFinding.name,
      ),
    );
    assert.strictEqual(result.tools.length, 1);
    assert.strictEqual(result.tools[0].name, "trustinspector");
  } finally {
    if (previousPluginsDir === undefined) {
      delete process.env.CDXGEN_PLUGINS_DIR;
    } else {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    }
    if (previousTrustInspectorCmd === undefined) {
      delete process.env.TRUSTINSPECTOR_CMD;
    } else {
      process.env.TRUSTINSPECTOR_CMD = previousTrustInspectorCmd;
    }
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});
