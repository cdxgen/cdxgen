import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, it } from "poku";

const managersDir = path.dirname(fileURLToPath(import.meta.url));
const cdxgenRoot = path.resolve(managersDir, "../..");
const pluginsRepoRoot = [
  path.resolve(cdxgenRoot, ".."),
  path.resolve(cdxgenRoot, "../cdxgen-plugins-bin"),
  path.resolve(process.cwd(), ".."),
  path.resolve(process.cwd(), "../cdxgen-plugins-bin"),
].find((candidate) =>
  existsSync(path.join(candidate, "thirdparty", "trivy", "main.go")),
);
const trivySourceDir = pluginsRepoRoot
  ? path.join(pluginsRepoRoot, "thirdparty", "trivy")
  : undefined;
const nerdctlPath =
  process.env.CDXGEN_NERDCTL_PATH || "/Users/prabhu/.rd/bin/nerdctl";

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

function buildTrivyBinary() {
  const outputDir = mkdtempSync(path.join(tmpdir(), "trivy-cdxgen-bin-"));
  const outputPath = path.join(outputDir, "trivy-cdxgen-test");
  runCommand(
    "bash",
    ["-lc", `GOEXPERIMENT=jsonv2 go build -o ${quoteForShell(outputPath)}`],
    {
      cwd: trivySourceDir,
      env: process.env,
    },
  );
  return outputPath;
}

function exportRootfsWithNerdctl(image) {
  const rootfsDir = mkdtempSync(path.join(tmpdir(), "cdxgen-rootfs-e2e-"));
  const shellScript = [
    "set -euo pipefail",
    `${quoteForShell(nerdctlPath)} pull ${quoteForShell(image)} >/dev/null`,
    `cid=$(${quoteForShell(nerdctlPath)} create ${quoteForShell(image)})`,
    `trap '${quoteForShell(nerdctlPath)} rm -f "$cid" >/dev/null 2>&1 || true' EXIT`,
    `${quoteForShell(nerdctlPath)} export "$cid" | tar -xf - -C ${quoteForShell(rootfsDir)}`,
    `${quoteForShell(nerdctlPath)} rm -f "$cid" >/dev/null 2>&1 || true`,
  ].join("\n");
  runCommand("bash", ["-lc", shellScript]);
  return rootfsDir;
}

async function importBinaryModule() {
  return import(
    `${pathToFileURL(path.join(managersDir, "binary.js")).href}?e2e=${Date.now()}`
  );
}

function extractSrcFiles(components) {
  return new Set(
    (components || [])
      .flatMap((component) => component.properties || [])
      .filter((property) => property.name === "SrcFile")
      .map((property) => property.value),
  );
}

const canRunE2E = Boolean(pluginsRepoRoot) && existsSync(nerdctlPath);

await it("getOSPackages() end-to-end on alpine rootfs creates owned file components without duplicate unpackaged binaries", async () => {
  if (!canRunE2E) {
    return;
  }
  const trivyBinary = buildTrivyBinary();
  const rootfsDir = exportRootfsWithNerdctl("docker.io/library/alpine:3.20");
  const emptyPluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-empty-plugins-"),
  );
  const previousTrivyCmd = process.env.TRIVY_CMD;
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  try {
    process.env.CDXGEN_PLUGINS_DIR = emptyPluginsDir;
    process.env.TRIVY_CMD = trivyBinary;
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
    if (previousTrivyCmd) {
      process.env.TRIVY_CMD = previousTrivyCmd;
    } else {
      delete process.env.TRIVY_CMD;
    }
    if (previousPluginsDir) {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    } else {
      delete process.env.CDXGEN_PLUGINS_DIR;
    }
    rmSync(emptyPluginsDir, { recursive: true, force: true });
    rmSync(path.dirname(trivyBinary), { recursive: true, force: true });
    rmSync(rootfsDir, { recursive: true, force: true });
  }
});

await it("getOSPackages() end-to-end on debian rootfs surfaces dpkg capabilities", async () => {
  if (!canRunE2E) {
    return;
  }
  const trivyBinary = buildTrivyBinary();
  const rootfsDir = exportRootfsWithNerdctl("docker.io/library/debian:12-slim");
  const emptyPluginsDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-empty-plugins-"),
  );
  const previousTrivyCmd = process.env.TRIVY_CMD;
  const previousPluginsDir = process.env.CDXGEN_PLUGINS_DIR;
  try {
    process.env.CDXGEN_PLUGINS_DIR = emptyPluginsDir;
    process.env.TRIVY_CMD = trivyBinary;
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
  } finally {
    if (previousTrivyCmd) {
      process.env.TRIVY_CMD = previousTrivyCmd;
    } else {
      delete process.env.TRIVY_CMD;
    }
    if (previousPluginsDir) {
      process.env.CDXGEN_PLUGINS_DIR = previousPluginsDir;
    } else {
      delete process.env.CDXGEN_PLUGINS_DIR;
    }
    rmSync(emptyPluginsDir, { recursive: true, force: true });
    rmSync(path.dirname(trivyBinary), { recursive: true, force: true });
    rmSync(rootfsDir, { recursive: true, force: true });
  }
});
