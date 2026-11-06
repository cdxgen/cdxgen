import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";
import yargs from "yargs";

// A config file in the scanned directory must not choose what cdxgen runs.
// Each case builds a project from test/data/project-config, whose payload
// leaves a marker file when it runs, and scans it with installs off. Where an
// operator-side spelling of the same setting exists, a control run shows that
// the fixture does reach the command it names.

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FIXTURES = path.join(REPO_ROOT, "test", "data", "project-config");
const MARKER = "CDXGEN_PROJECT_CONFIG_MARKER";

function makeProject(files, config) {
  // The real path, because the tracer's sandbox compares granted paths
  // without resolving links such as macOS's /var.
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "cdxgen-project-config-")),
  );
  const projectDir = path.join(root, "project");
  mkdirSync(projectDir);
  for (const [fixture, target] of files) {
    const targetPath = path.join(projectDir, target);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(path.join(FIXTURES, fixture), targetPath);
  }
  if (config) {
    writeFileSync(
      path.join(projectDir, ".cdxgenrc"),
      JSON.stringify(config(projectDir)),
    );
  }
  return { projectDir, root };
}

function runCdxgen(projectDir, extraArgs = [], extraEnv = {}, output = true) {
  const env = {
    ...process.env,
    CDXGEN_NO_CACHE: "true",
    CDXGEN_NO_PROGRESS: "true",
    // The real analyzers are not needed: a run that ignores the config's
    // command falls back to these, which do not exist and fail quickly.
    DOSAI_CMD: path.join(projectDir, "..", "no-dosai"),
    SCALASEM_CMD: path.join(projectDir, "..", "no-scalasem.js"),
    ...extraEnv,
  };
  for (const name of [
    "CDXGEN_DEBUG_MODE",
    "CDXGEN_DOSAI_COMMAND",
    "CDXGEN_SCALASEM_COMMAND",
    "CDXGEN_SECURE_MODE",
    "CDXGEN_TRACE_CMD",
    "CDXGEN_TYPE",
  ]) {
    if (!(name in extraEnv)) {
      delete env[name];
    }
  }
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "bin", "cdxgen.js"),
      "--no-install-deps",
      ...(output ? ["-o", path.join(projectDir, "..", "bom.json")] : []),
      ...extraArgs,
      ".",
    ],
    { cwd: projectDir, encoding: "utf-8", env, timeout: 180000 },
  );
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function markerWritten(projectDir) {
  return existsSync(path.join(projectDir, MARKER));
}

it("does not run a dosai command named in a config file", () => {
  const files = [
    ["app.csproj", "app.csproj"],
    ["write-marker.cjs", "methods"],
  ];
  const { projectDir, root } = makeProject(files, () => ({
    dosaiCommand: process.execPath,
    evidence: true,
    type: ["dotnet"],
  }));
  const control = makeProject(files, () => ({
    evidence: true,
    type: ["dotnet"],
  }));
  try {
    const output = runCdxgen(projectDir);
    assert.ok(output.includes("sets 'dosaiCommand'"), output);
    assert.strictEqual(markerWritten(projectDir), false);
    runCdxgen(control.projectDir, [], {
      CDXGEN_DOSAI_COMMAND: process.execPath,
    });
    assert.strictEqual(
      markerWritten(control.projectDir),
      true,
      "the operator's CDXGEN_DOSAI_COMMAND runs the fixture's payload",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(control.root, { recursive: true, force: true });
  }
});

it("does not run a scalasem command named in a config file", () => {
  const files = [
    ["build.sbt", "build.sbt"],
    ["Main.scala", path.join("src", "main", "scala", "Main.scala")],
    ["write-marker.cjs", "write-marker.cjs"],
  ];
  const { projectDir, root } = makeProject(files, () => ({
    evidence: true,
    "scalasem-command": "./write-marker.cjs",
    type: ["scala"],
  }));
  const control = makeProject(files, () => ({
    evidence: true,
    type: ["scala"],
  }));
  try {
    const output = runCdxgen(projectDir);
    assert.ok(output.includes("sets 'scalasem-command'"), output);
    assert.strictEqual(markerWritten(projectDir), false);
    runCdxgen(control.projectDir, [
      "--scalasem-command",
      path.join(control.projectDir, "write-marker.cjs"),
    ]);
    assert.strictEqual(
      markerWritten(control.projectDir),
      true,
      "the operator's --scalasem-command runs the fixture's payload",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(control.root, { recursive: true, force: true });
  }
});

it("does not trace a command named in a config file", () => {
  // The tracer's sandbox keeps node from loading the payload, so on POSIX the
  // config names a shell command that writes the marker itself.
  const { projectDir, root } = makeProject(
    [["write-marker.cjs", "write-marker.cjs"]],
    (dir) => ({
      traceCmd:
        process.platform === "win32"
          ? `${process.execPath} ${path.join(dir, "write-marker.cjs")}`
          : `/bin/sh -c 'echo executed > ${path.join(dir, MARKER)}'`,
      traceWritePaths: [dir],
      type: ["dynamic"],
    }),
  );
  try {
    const output = runCdxgen(projectDir);
    assert.ok(output.includes("sets 'traceCmd'"), output);
    assert.ok(output.includes("sets 'traceWritePaths'"), output);
    assert.strictEqual(markerWritten(projectDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not load a module or config that a config file extends", () => {
  const { projectDir, root } = makeProject(
    [
      ["package.json", "package.json"],
      ["write-marker.cjs", "write-marker.cjs"],
    ],
    (dir) => ({ extends: path.join(dir, "write-marker.cjs"), type: ["js"] }),
  );
  try {
    // yargs loads a module named by `extends` while it reads a config
    // object, so the key must never reach it. The control runs on POSIX
    // systems, where an absolute path is a valid module specifier.
    if (process.platform !== "win32") {
      yargs([]).config({ extends: path.join(projectDir, "write-marker.cjs") });
      assert.strictEqual(markerWritten(projectDir), true);
      rmSync(path.join(projectDir, MARKER));
    }
    const output = runCdxgen(projectDir);
    assert.ok(output.includes("sets 'extends'"), output);
    assert.strictEqual(markerWritten(projectDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps an aliased output option inside the project directory", () => {
  const { projectDir, root } = makeProject(
    [["package.json", "package.json"]],
    () => ({ o: "../victim.json", type: ["js"] }),
  );
  try {
    // Without -o on the command line, so the config's value is the one used.
    const output = runCdxgen(projectDir, [], {}, false);
    assert.ok(output.includes("output=../victim.json"), output);
    assert.strictEqual(existsSync(path.join(projectDir, "bom.json")), true);
    assert.strictEqual(existsSync(path.join(root, "victim.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("drops a config exclude pattern that expands past the budget", () => {
  const { projectDir, root } = makeProject(
    [["package.json", "package.json"]],
    () => ({ exclude: ["**/{1..100000}/**", "**/docs/**"], type: ["js"] }),
  );
  try {
    const output = runCdxgen(projectDir);
    assert.ok(
      output.includes(
        "sets the exclude pattern '**/{1..100000}/**', which expands to more than 128 patterns",
      ),
      output,
    );
    assert.ok(!output.includes("**/docs/**"), output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
