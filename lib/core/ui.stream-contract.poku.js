import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, describe, it } from "poku";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const cdxgenBin = path.join(repoRoot, "bin", "cdxgen.js");
const fixture = path.join(repoRoot, "test", "data", "bun");

// Spawns `node bin/cdxgen.js ...` and returns { stdout, stderr }.
function runCdxgen(args, env = {}) {
  const result = spawnSync(process.execPath, [cdxgenBin, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    // Under CI=true cdxgen includes formulation by default, and the fixture
    // sits inside this repository, so the BOM carries the whole git tree and
    // easily passes the 1MB default buffer.
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

describe("stream contract (-o -)", () => {
  it("writes byte-identical valid JSON to stdout with zero non-JSON bytes", () => {
    const { stdout, stderr, status } = runCdxgen([
      "-t",
      "js",
      "-o",
      "-",
      "--no-recurse",
      "--no-validate",
      fixture,
    ]);
    assert.strictEqual(status, 0, `cdxgen exited ${status}`);
    // stdout must be exactly one JSON document: parseable, and starting with
    // the CycloneDX BOM marker.
    assert.ok(stdout.startsWith("{"), "stdout must begin with '{'");
    assert.ok(stdout.trimEnd().endsWith("}"), "stdout must end with '}'");
    let bom;
    assert.doesNotThrow(() => {
      bom = JSON.parse(stdout);
    }, "stdout must be valid JSON");
    assert.strictEqual(bom.bomFormat, "CycloneDX");
    // No human-readable diagnostics may leak onto the payload stream.
    assert.ok(
      !stderr.includes("bomFormat"),
      "BOM payload must not appear on stderr",
    );
  });

  it("keeps stdout empty when writing to a file (payload stream discipline)", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-stream-"));
    try {
      const { stdout } = runCdxgen([
        "-t",
        "js",
        "-o",
        path.join(tmpDir, "bom.json"),
        "--no-recurse",
        "--no-validate",
        fixture,
      ]);
      assert.strictEqual(stdout, "", `stdout must be empty, got: ${stdout}`);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("emits no ANSI escape bytes on stderr when piped (non-TTY)", () => {
    const { stderr } = runCdxgen(
      ["-t", "js", "-o", "-", "--no-recurse", "--no-validate", fixture],
      // FORCE_COLOR is an explicit opt-in that outranks the pipe detection, and
      // interactive shells (and CI runners with colour enabled) export it into
      // the test process. Clearing it is what makes this a genuine pipe.
      { CI: "true", FORCE_COLOR: "", NO_COLOR: "" },
    );
    assert.ok(
      !stderr.includes("\x1b"),
      "stderr must contain no ANSI escape bytes when piped",
    );
  });
});

// cdxgen ships for Deno and Bun as well as Node. The live region reaches for
// setInterval().unref(), process.off, and process.kill re-raising, none of which
// are guaranteed outside Node, so the frames each runtime produces are compared
// byte for byte.
const RUNTIME_PROBE = `
import { createUi } from "${pathToFileURL(path.join(repoRoot, "lib", "core", "ui.js")).href}";
const writes = [];
const stream = { isTTY: true, columns: 80, rows: 24, write: (c) => writes.push(c) };
let clock = 0;
const ui = createUi({
  stream, interactive: true, color: true, unicode: true, level: 1,
  now: () => (clock += 90),
});
const p = ui.phase("Runtime check");
p.detail("detail");
p.progress(2, 5);
p.succeed("ok");
ui.log.info("info line");
ui.stop();
process.stdout.write(JSON.stringify(writes));
`;

function runtimeAvailable(command) {
  return spawnSync(command, ["--version"], { encoding: "utf-8" }).status === 0;
}

describe("live region across runtimes", () => {
  const runtimes = [
    { name: "bun", buildArgs: (probePath) => [probePath] },
    {
      name: "deno",
      buildArgs: (probePath) => [
        "run",
        "-A",
        // The repo's deno.json maps the bare npm specifiers ui.js pulls in
        // transitively (undici), so it is loaded by absolute path. Local
        // node_modules management is off so deno resolves from its own
        // cache: with `nodeModulesDir: "auto"` from the config, deno
        // materializes its npm graph into node_modules/.deno — a graph that
        // diverges from the pnpm-managed install, since deno resolves
        // versions itself (the repo sets `"lock": false`) — and rewires the
        // root node_modules links mid-suite. On Windows that broke every
        // later resolver walk, traceRunner's platform payload for one.
        "--node-modules-dir=false",
        "--config",
        path.join(repoRoot, "deno.json"),
        probePath,
      ],
    },
  ].filter((runtime) => runtimeAvailable(runtime.name));

  it("produces frames identical to Node under every installed runtime", () => {
    if (runtimes.length === 0) {
      // Neither alternative runtime is installed; Node coverage still applies.
      return;
    }
    // The probe must live outside the repo: deno discovers the project root
    // from the entry module's location, not the cwd, so a probe inside the
    // repo makes deno manage the repo's install even with the flags above.
    // The probe imports ui.js through a file URL, so an empty temporary
    // directory is a home deno finds no project in.
    const probeDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-ui-probe-"));
    const probePath = path.join(probeDir, "cdxgen-ui-runtime-probe.mjs");
    writeFileSync(probePath, RUNTIME_PROBE);
    // The frames baseline must come from node itself. When poku runs this
    // file under deno (the deno-runtime CI job), process.execPath is the
    // deno binary, and a bare deno run of the probe — no config, no
    // node_modules management — cannot resolve ui.js's bare npm imports.
    const parentIsNode = !globalThis.Deno && !globalThis.Bun;
    const nodeBinary = parentIsNode ? process.execPath : "node";
    try {
      const baseline = spawnSync(nodeBinary, [probePath], {
        cwd: probeDir,
        encoding: "utf-8",
      });
      assert.strictEqual(baseline.status, 0, baseline.stderr);
      for (const runtime of runtimes) {
        const result = spawnSync(runtime.name, runtime.buildArgs(probePath), {
          cwd: probeDir,
          encoding: "utf-8",
        });
        assert.strictEqual(
          result.status,
          0,
          `${runtime.name} failed: ${result.stderr}`,
        );
        assert.strictEqual(
          result.stdout,
          baseline.stdout,
          `${runtime.name} rendered different frames than Node`,
        );
      }
    } finally {
      rmSync(probeDir, { force: true, recursive: true });
    }
  });
});
