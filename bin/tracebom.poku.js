import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { describe, it } from "poku";

const binPath = join(process.cwd(), "bin", "tracebom.js");

describe("tracebom CLI", () => {
  it("--help exits 0 and output contains cmd", async () => {
    const { status, stdout } = await execNode([binPath, "--help"]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes("cmd"));
  });

  it("--version exits 0", async () => {
    const { status } = await execNode([binPath, "--version"]);
    assert.strictEqual(status, 0);
  });

  it('--cmd "echo hello" produces a BOM file', { timeout: 30000 }, async () => {
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

  it("custom sandbox options are accepted", { timeout: 30000 }, async () => {
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

  it("--print outputs Bom to stdout", { timeout: 30000 }, async () => {
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

  it("--trace-period is accepted", { timeout: 30000 }, async () => {
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

  it("--trace-http-urls is accepted", { timeout: 30000 }, async () => {
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
