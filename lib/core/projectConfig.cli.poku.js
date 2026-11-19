import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
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

function cdxgenInvocation(projectDir, extraArgs, extraEnv, output) {
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
    "CDXGEN_SERVER_URL",
    "CDXGEN_TRACE_CMD",
    "CDXGEN_TYPE",
  ]) {
    if (!(name in extraEnv)) {
      delete env[name];
    }
  }
  return {
    args: [
      path.join(REPO_ROOT, "bin", "cdxgen.js"),
      "--no-install-deps",
      ...(output ? ["-o", path.join(projectDir, "..", "bom.json")] : []),
      ...extraArgs,
      ".",
    ],
    options: { cwd: projectDir, encoding: "utf-8", env, timeout: 180000 },
  };
}

function runCdxgen(projectDir, extraArgs = [], extraEnv = {}, output = true) {
  const { args, options } = cdxgenInvocation(
    projectDir,
    extraArgs,
    extraEnv,
    output,
  );
  const result = spawnSync(process.execPath, args, options);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

// For the cases that answer cdxgen's requests from this process, which a
// synchronous run would keep from responding.
function runCdxgenAsync(projectDir, extraArgs = [], extraEnv = {}) {
  const { args, options } = cdxgenInvocation(
    projectDir,
    extraArgs,
    extraEnv,
    true,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", () => resolve(output));
  });
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
    type: ["dotnet"],
  }));
  const control = makeProject(files, () => ({
    type: ["dotnet"],
  }));
  try {
    // Evidence is an operator-only option, so every run turns it on itself.
    const output = runCdxgen(projectDir, ["--evidence"]);
    assert.ok(output.includes("sets 'dosaiCommand'"), output);
    assert.strictEqual(markerWritten(projectDir), false);
    runCdxgen(control.projectDir, ["--evidence"], {
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
    "scalasem-command": "./write-marker.cjs",
    type: ["scala"],
  }));
  const control = makeProject(files, () => ({
    type: ["scala"],
  }));
  try {
    const output = runCdxgen(projectDir, ["--evidence"]);
    assert.ok(output.includes("sets 'scalasem-command'"), output);
    assert.strictEqual(markerWritten(projectDir), false);
    runCdxgen(control.projectDir, [
      "--evidence",
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

it("loads BOM audit rules from the command line but not from a config file", () => {
  const rule = [
    "- id: CUSTOM-001",
    "  severity: low",
    "  category: custom",
    "  condition: \"components[name = 'no-such-component']\"",
    '  message: "never matches"',
    "",
  ].join("\n");
  const { projectDir, root } = makeProject(
    [["package.json", "package.json"]],
    () => ({
      "bom-audit": true,
      "bom-audit-rules-dir": "rules",
      type: ["js"],
    }),
  );
  try {
    mkdirSync(path.join(projectDir, "rules"));
    writeFileSync(path.join(projectDir, "rules", "custom.yaml"), rule);
    const debug = { CDXGEN_DEBUG_MODE: "debug" };
    const fromConfig = runCdxgen(projectDir, [], debug);
    assert.ok(fromConfig.includes("sets 'bom-audit-rules-dir'"), fromConfig);
    assert.ok(!fromConfig.includes("user rules from"), fromConfig);
    // The same directory is read when the operator names it.
    const fromCli = runCdxgen(
      projectDir,
      ["--bom-audit", "--bom-audit-rules-dir", "rules"],
      debug,
    );
    assert.ok(fromCli.includes("Loaded 1 user rules from"), fromCli);
    const fromEnv = runCdxgen(projectDir, ["--bom-audit"], {
      ...debug,
      CDXGEN_BOM_AUDIT_RULES_DIR: "rules",
    });
    assert.ok(fromEnv.includes("Loaded 1 user rules from"), fromEnv);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not open the terminal interface for a config file", () => {
  // The stand-in for cdxui is a shell script.
  if (process.platform === "win32") {
    return;
  }
  const files = [["package.json", "package.json"]];
  const { projectDir, root } = makeProject(files, () => ({
    tui: true,
    type: ["js"],
  }));
  const control = makeProject(files, () => ({ type: ["js"] }));
  // Like cdxui --generate, the stand-in runs the cdxgen it is handed. It
  // notes each time it is opened and gives up the third time, so a scan that
  // keeps reopening the interface still ends.
  const opened = (dir) => {
    try {
      return readFileSync(path.join(dir, "cdxui.log"), "utf-8").trim();
    } catch {
      return "";
    }
  };
  const standInEnv = (dir) => {
    const tool = path.join(dir, "cdxui");
    writeFileSync(
      tool,
      `#!/bin/sh\necho opened >> "$0.log"\n[ "$(grep -c opened "$0.log")" -lt 3 ] || exit 1\nIFS=$(printf '\\037')\nset -f\nexec $CDXGEN_CMD $CDXGEN_ARGS\n`,
    );
    chmodSync(tool, 0o755);
    return { CDXGEN_CMD: "", CDXUI_CMD: tool, CI: "" };
  };
  try {
    const output = runCdxgen(projectDir, [], standInEnv(root));
    assert.ok(output.includes("sets 'tui'"), output);
    assert.strictEqual(opened(root), "");
    assert.strictEqual(existsSync(path.join(root, "bom.json")), true);
    // The operator's CDXGEN_TUI opens the interface, and the cdxgen started
    // from it, which inherits the variable, does not open it again.
    runCdxgen(control.projectDir, [], {
      ...standInEnv(control.root),
      CDXGEN_TUI: "true",
    });
    assert.strictEqual(opened(control.root), "opened");
    assert.strictEqual(existsSync(path.join(control.root, "bom.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(control.root, { recursive: true, force: true });
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

it("does not follow a link and a parent segment out of the project directory", () => {
  const { projectDir, root } = makeProject(
    [["package.json", "package.json"]],
    () => ({ output: "out/../victim.json", type: ["js"] }),
  );
  try {
    mkdirSync(path.join(root, "outside", "deep"), { recursive: true });
    try {
      symlinkSync(
        path.join(root, "outside", "deep"),
        path.join(projectDir, "out"),
        "junction",
      );
    } catch (err) {
      console.log(`Skipping the symbolic link check: ${err.code}`);
      return;
    }
    // The file system opens out/../victim.json as outside/victim.json.
    const output = runCdxgen(projectDir, [], {}, false);
    assert.ok(output.includes("output=out/../victim.json"), output);
    assert.strictEqual(existsSync(path.join(projectDir, "bom.json")), true);
    assert.strictEqual(
      existsSync(path.join(root, "outside", "victim.json")),
      false,
    );
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

it("does not send the operator's API key to a server named in a config file", async () => {
  const received = [];
  const server = createServer((req, res) => {
    received.push(`${req.method} ${req.url} ${req.headers["x-api-key"]}`);
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const { projectDir, root } = makeProject(
    [["package.json", "package.json"]],
    () => ({ "server-url": serverUrl, type: ["js"] }),
  );
  const operatorEnv = { CDXGEN_API_KEY: "operator-api-key" };
  try {
    const output = await runCdxgenAsync(
      projectDir,
      ["--no-include-formulation"],
      operatorEnv,
    );
    assert.ok(output.includes("Ignoring 'server-url'"), output);
    assert.deepStrictEqual(received, []);
    await runCdxgenAsync(
      projectDir,
      ["--no-include-formulation", "--server-url", serverUrl],
      operatorEnv,
    );
    assert.deepStrictEqual(
      received,
      ["POST /api/v1/bom operator-api-key"],
      "a server the operator names receives the operator's key",
    );
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
