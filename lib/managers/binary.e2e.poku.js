import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, it } from "poku";

const managersDir = path.dirname(fileURLToPath(import.meta.url));
const cdxgenRoot = path.resolve(managersDir, "../..");
function getPrebuiltBinary(toolName) {
  const envVarName = toolName === "trivy" ? "TRIVY_CMD" : "TRUSTINSPECTOR_CMD";
  if (process.env[envVarName]) {
    return process.env[envVarName];
  }
  const platform = process.platform === "win32" ? "windows" : process.platform;
  let arch = process.arch;
  if (arch === "x64") arch = "amd64";
  const ext = platform === "windows" ? ".exe" : "";
  const searchDirs = [
    path.join(cdxgenRoot, "node_modules"),
    path.join(process.cwd(), "node_modules"),
  ];
  for (const dir of searchDirs) {
    const pkgDir = path.join(
      dir,
      `@cdxgen/cdxgen-plugins-bin-${process.platform}-${process.arch}`,
    );
    const binaryPath = path.join(
      pkgDir,
      "plugins",
      toolName,
      `${toolName}-cdxgen-${platform}-${arch}${ext}`,
    );
    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  }
  return undefined;
}

const nerdctlPath =
  process.env.CDXGEN_NERDCTL_PATH ||
  path.join(homedir(), ".rd", "bin", "nerdctl");

function quoteForShell(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function exportRootfsWithNerdctl(image, options = {}) {
  const rootfsDir = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-e2e-"));
  const shellScript = [
    "set -euo pipefail",
    ...(options.skipPull
      ? []
      : [
          `${quoteForShell(nerdctlPath)} pull ${quoteForShell(image)} >/dev/null`,
        ]),
    `cid=$(${quoteForShell(nerdctlPath)} create ${quoteForShell(image)})`,
    `trap '${quoteForShell(nerdctlPath)} rm -f "$cid" >/dev/null 2>&1 || true' EXIT`,
    `${quoteForShell(nerdctlPath)} export "$cid" | tar -xf - -C ${quoteForShell(rootfsDir)}`,
    `${quoteForShell(nerdctlPath)} rm -f "$cid" >/dev/null 2>&1 || true`,
  ].join("\n");
  runCommand("bash", ["-c", shellScript]);
  return rootfsDir;
}

function buildImageWithNerdctl(tag, dockerfileContents) {
  const buildContextDir = mkdtempSync(path.join(tmpdir(), "cdxgen-image-e2e-"));
  writeFileSync(path.join(buildContextDir, "Dockerfile"), dockerfileContents);
  runCommand(nerdctlPath, ["build", "-t", tag, buildContextDir]);
  return buildContextDir;
}

function createTrustInspectorPluginsDir() {
  const pluginsDir = mkdtempSync(path.join(tmpdir(), "cdxgen-empty-plugins-"));
  writeFileSync(
    path.join(pluginsDir, "plugins-manifest.json"),
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
  );
  return pluginsDir;
}

async function importBinaryModule() {
  return import(
    `${pathToFileURL(path.join(managersDir, "binary.js")).href}?e2e=${Date.now()}`
  );
}

function setTemporaryEnv(overrides) {
  const previousEnv = {};
  for (const [name, value] of Object.entries(overrides)) {
    previousEnv[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
      continue;
    }
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[name];
        continue;
      }
      process.env[name] = value;
    }
  };
}

function extractSrcFiles(components) {
  return new Set(
    (components || [])
      .flatMap((component) => component.properties || [])
      .filter((property) => property.name === "SrcFile")
      .map((property) => property.value),
  );
}

const canRunE2E =
  Boolean(getPrebuiltBinary("trivy")) &&
  existsSync(nerdctlPath) &&
  process.env.RUNNING_IN_SAFER_EXEC_SANDBOX !== "true";

await it("getOSPackages() end-to-end on alpine rootfs creates owned file components without duplicate unpackaged binaries", async () => {
  if (!canRunE2E) {
    return;
  }
  const trivyBinary = getPrebuiltBinary("trivy");
  const rootfsDir = exportRootfsWithNerdctl("docker.io/library/alpine:3.20");
  const emptyPluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-empty-plugins-"),
  );
  const restoreEnv = setTemporaryEnv({
    CDXGEN_PLUGINS_DIR: emptyPluginsDir,
    TRIVY_CMD: trivyBinary,
  });
  try {
    const { getOSPackages } = await importBinaryModule();
    const result = await getOSPackages(rootfsDir, {
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ],
    });

    assert.ok(result.osPackages.length > 0);
    assert.ok(result.osPackageFiles.length > 0);
    assert.ok(
      result.dependenciesList.some(
        (dependency) =>
          dependency.ref &&
          Array.isArray(dependency.provides) &&
          dependency.provides.length > 0,
      ),
    );
    assert.ok(
      result.osPackages.some((component) =>
        (component.properties || []).some((property) =>
          property.name.endsWith("Capability"),
        ),
      ),
    );

    const packagedFilePaths = extractSrcFiles(result.osPackageFiles);
    for (const component of result.executables.concat(result.sharedLibs)) {
      const srcFile = (component.properties || []).find(
        (property) => property.name === "SrcFile",
      )?.value;
      assert.strictEqual(packagedFilePaths.has(srcFile), false);
    }
  } finally {
    restoreEnv();
    rmSync(emptyPluginsDir, { recursive: true, force: true });
    rmSync(rootfsDir, { recursive: true, force: true });
  }
});

await it("getOSPackages() end-to-end on debian rootfs surfaces dpkg capabilities", async () => {
  if (!canRunE2E) {
    return;
  }
  const trivyBinary = getPrebuiltBinary("trivy");
  const trustInspectorBinary = getPrebuiltBinary("trustinspector");
  const rootfsDir = exportRootfsWithNerdctl("docker.io/library/debian:12-slim");
  const emptyPluginsDir = createTrustInspectorPluginsDir();
  const restoreEnv = setTemporaryEnv({
    CDXGEN_PLUGINS_DIR: emptyPluginsDir,
    TRIVY_CMD: trivyBinary,
    TRUSTINSPECTOR_CMD: trustInspectorBinary,
  });
  try {
    const { getOSPackages } = await importBinaryModule();
    const result = await getOSPackages(rootfsDir, {
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ],
    });

    assert.ok(result.osPackages.length > 0);
    assert.ok(
      result.osPackages.some((component) =>
        (component.properties || []).some((property) =>
          property.name.endsWith("Capability"),
        ),
      ),
    );
    assert.ok(
      result.osPackages.some(
        (component) =>
          component.supplier?.name ||
          component.manufacturer?.name ||
          (component.authors || []).length,
      ),
    );
    assert.ok(
      result.osPackages.some(
        (component) =>
          component.type === "data" &&
          (component.properties || []).some(
            (property) =>
              property.name === "cdx:os:repo:type" &&
              (property.value === "apt-source" ||
                property.value === "ppa-source"),
          ),
      ),
    );
    assert.ok(
      result.osPackages.some(
        (component) =>
          component.type === "cryptographic-asset" &&
          component.cryptoProperties?.assetType === "related-crypto-material" &&
          component.cryptoProperties?.relatedCryptoMaterialProperties?.type ===
            "public-key",
      ),
    );
    assert.ok(result.tools.some((tool) => tool.name === "trustinspector"));
    assert.ok(
      result.osPackages.some(
        (component) =>
          component.type === "cryptographic-asset" &&
          (component.properties || []).some(
            (property) =>
              property.name === "cdx:crypto:sourceType" &&
              property.value === "repository-keyring",
          ),
      ),
    );
  } finally {
    restoreEnv();
    rmSync(emptyPluginsDir, { recursive: true, force: true });
    rmSync(rootfsDir, { recursive: true, force: true });
  }
});

await it("getOSPackages() end-to-end on ubuntu rootfs with ca-certificates emits certificate crypto assets", async () => {
  if (!canRunE2E) {
    return;
  }
  const trivyBinary = getPrebuiltBinary("trivy");
  const trustInspectorBinary = getPrebuiltBinary("trustinspector");
  const emptyPluginsDir = createTrustInspectorPluginsDir();
  const imageTag = `cdxgen-e2e-cert-${Date.now()}`;
  const buildContextDir = buildImageWithNerdctl(
    imageTag,
    [
      "FROM docker.io/library/ubuntu:24.04",
      "RUN apt-get update && \\",
      "  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates && \\",
      "  rm -rf /var/lib/apt/lists/*",
    ].join("\n"),
  );
  const rootfsDir = exportRootfsWithNerdctl(imageTag, { skipPull: true });
  const restoreEnv = setTemporaryEnv({
    CDXGEN_PLUGINS_DIR: emptyPluginsDir,
    TRIVY_CMD: trivyBinary,
    TRUSTINSPECTOR_CMD: trustInspectorBinary,
  });
  try {
    const { getOSPackages } = await importBinaryModule();
    const result = await getOSPackages(rootfsDir, {
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ],
    });

    const certificateAssets = result.osPackages.filter(
      (component) =>
        component.type === "cryptographic-asset" &&
        component.cryptoProperties?.assetType === "certificate",
    );
    assert.ok(certificateAssets.length > 0);
    assert.ok(result.tools.some((tool) => tool.name === "trustinspector"));
    assert.ok(
      certificateAssets.some(
        (component) =>
          (component.properties || []).some(
            (property) => property.name === "SrcFile",
          ) && component.cryptoProperties?.certificateProperties?.subjectName,
      ),
    );
    assert.ok(
      certificateAssets.some(
        (component) =>
          component.cryptoProperties?.certificateProperties
            ?.certificateFormat === "X.509",
      ),
    );
  } finally {
    restoreEnv();
    spawnSync(nerdctlPath, ["rmi", "-f", imageTag], {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
    });
    rmSync(buildContextDir, { recursive: true, force: true });
    rmSync(emptyPluginsDir, { recursive: true, force: true });
    rmSync(rootfsDir, { recursive: true, force: true });
  }
});
