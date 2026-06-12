import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { describe, it } from "poku";

const binPath = join(process.cwd(), "bin", "tracebom.js");

describe("tracebom CLI", () => {
  it("--help exits 0 and output contains cmd", async () => {
    const { status, stdout, stderr } = await execNode([binPath, "--help"]);
    assert.strictEqual(status, 0);
    const output = stdout + stderr;
    assert.ok(output.toLowerCase().includes("cmd"));
  });

  it("--version exits 0", async () => {
    const { status } = await execNode([binPath, "--version"]);
    assert.strictEqual(status, 0);
  });

  it('--cmd "echo hello" produces a BOM file', async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-test.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    const bom = JSON.parse(readFileSync(tmpFile, "utf-8"));
    assert.strictEqual(bom.bomFormat, "CycloneDX");
    // Components may be empty when SaferExec is unavailable — graceful fallback
    unlinkSync(tmpFile);
  });

  it("custom sandbox options are accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-sandbox.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo test",
      "--max-memory",
      "256",
      "--max-processes",
      "32",
      "--timeout",
      "30000",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--print outputs Bom to stdout", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-print.json");
    const { status, stdout } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--print",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("bomFormat"));
    assert.ok(stdout.includes("CycloneDX"));
    if (existsSync(tmpFile)) {
      unlinkSync(tmpFile);
    }
  });

  it("--trace-period is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-period.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--trace-period",
      "5",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    const bom = JSON.parse(readFileSync(tmpFile, "utf-8"));
    assert.strictEqual(bom.bomFormat, "CycloneDX");
    unlinkSync(tmpFile);
  });

  it("--trace-http-urls is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-urls.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--trace-http-urls",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--trace-crypto is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-crypto.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--trace-crypto",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  it("--max-cpu is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-cpu.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--max-cpu",
      "0.5",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--allow-envs is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-envs.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--allow-envs",
      "PATH,HOME",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--allow-hidden is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-hidden.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--allow-hidden",
      "false",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--allow-listen is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-listen.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--allow-listen",
      "0.0.0.0,127.0.0.1:8080",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--crypto-probe-mode is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-probemode.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--crypto-probe-mode",
      "operations",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--strict is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-strict.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--strict",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--diff is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-diff.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--diff",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--allow-host is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-allowhost.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--allow-host",
      "example.com,api.example.com",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--allow-port is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-allowport.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--allow-port",
      "443,8443",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--block-fork is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-blockfork.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--block-fork",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--trace-exec is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-traceexec.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--trace-exec",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("--allow-exec is accepted", async () => {
    const tmpFile = join(process.cwd(), "tmp-tracebom-allowexec.json");
    const { status } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--allow-exec",
      "node,npm",
      "--output",
      tmpFile,
    ]);
    assert.strictEqual(status, 0);
    assert.ok(existsSync(tmpFile));
    unlinkSync(tmpFile);
  });

  it("traces pnpm install in a temp directory and produces a valid BOM", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdxgen-pnpm-test-"));
    const tmpFile = path.join(tempDir, "bom.json");

    try {
      // Copy minimum configuration files to trigger pnpm execution context
      fs.copyFileSync(
        path.join(process.cwd(), "package.json"),
        path.join(tempDir, "package.json"),
      );
      if (fs.existsSync(path.join(process.cwd(), "pnpm-lock.yaml"))) {
        fs.copyFileSync(
          path.join(process.cwd(), "pnpm-lock.yaml"),
          path.join(tempDir, "pnpm-lock.yaml"),
        );
      }
      if (fs.existsSync(path.join(process.cwd(), "pnpm-workspace.yaml"))) {
        fs.copyFileSync(
          path.join(process.cwd(), "pnpm-workspace.yaml"),
          path.join(tempDir, "pnpm-workspace.yaml"),
        );
      }

      // Exec tracebom with pnpm install
      const { status, stderr, stdout } = await execNode([
        binPath,
        "--cmd",
        "pnpm install --prod",
        "--working-dir",
        tempDir,
        "--output",
        tmpFile,
      ]);

      assert.strictEqual(
        status,
        0,
        `pnpm install trace failed: ${stderr}\nStdout: ${stdout}`,
      );
      assert.ok(fs.existsSync(tmpFile), "BOM output file should exist");
      const bom = JSON.parse(fs.readFileSync(tmpFile, "utf-8"));
      assert.strictEqual(bom.bomFormat, "CycloneDX");
      assert.ok(
        Array.isArray(bom.components),
        "BOM components should be an array",
      );
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

function execNode(args) {
  return new Promise((resolve) => {
    const chunks = [];
    const errChunks = [];
    const child = spawn(process.argv0, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errChunks.push(chunk));
    child.on("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(chunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
      });
    });
    child.on("error", (err) => {
      resolve({ status: 1, stdout: "", stderr: err.message });
    });
  });
}
