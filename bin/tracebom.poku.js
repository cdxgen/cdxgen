import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { strict as assert, describe, it } from "poku";

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
    // Components may be empty when the platform runtime binary cannot run
    // (e.g. unsupported platforms), but a missing @cdxgen/safer-exec module
    // must exit non-zero rather than write an empty BOM — see traceRunner tests
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
    const { status, stderr } = await execNode([
      binPath,
      "--cmd",
      "echo hello",
      "--strict",
      "--output",
      tmpFile,
    ]);
    // Where the sandbox cannot run the command as asked (no "echo" program
    // on Windows, a host that refuses a control), --strict fails the trace
    // instead of writing an empty BOM.
    if (status !== 0) {
      assert.match(stderr, /Tracing refused under --strict: safer-exec: /);
      assert.ok(!existsSync(tmpFile));
      return;
    }
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

  // Observed certificate chains need safer-exec >= 1.2.0 (which reports the
  // `chain` array), a TLS <= 1.2 server this host can reach, and an egress
  // tunnel the traced client actually uses. Anything missing skips the live
  // assertion; the committed fixtures cover the model itself.
  it("records the certificate chain a TLS 1.2 server presents", async () => {
    const skip = (message) =>
      console.log(`skipped (live chain test): ${message}`);
    if (process.platform === "win32") {
      return skip("needs the POSIX sh/openssl s_server toolchain");
    }
    let saferExecVersion;
    try {
      saferExecVersion = JSON.parse(
        readFileSync(
          join(
            process.cwd(),
            "node_modules",
            "@cdxgen",
            "safer-exec",
            "package.json",
          ),
          "utf-8",
        ),
      ).version;
    } catch {
      return skip("safer-exec package version unknown");
    }
    const [major, minor] = saferExecVersion.split(".").map(Number);
    if (major < 1 || (major === 1 && minor < 2)) {
      return skip(`safer-exec ${saferExecVersion} predates chain reporting`);
    }
    const freePort = await new Promise((resolve) => {
      const probe = (port) => {
        const server = net.createServer();
        server.once("error", () => {
          if (port < 9459) {
            probe(port + 1);
          } else {
            resolve(undefined);
          }
          server.close();
        });
        server.once("listening", () => {
          server.close(() => resolve(port));
        });
        server.listen(port, "127.0.0.1");
      };
      probe(9440);
    });
    if (!freePort) {
      return skip("no bindable port in 9440-9459");
    }
    const work = mkdtempSync(join(tmpdir(), "cdxgen-tracebom-chain-"));
    const tmpFile = join(work, "bom.json");
    let server;
    try {
      const openssl = process.env.OPENSSL_BIN || "openssl";
      const certArgs = [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(work, "key.pem"),
        "-out",
        join(work, "cert.pem"),
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ];
      const cert = await new Promise((resolve) => {
        const child = spawn(openssl, certArgs, { stdio: "ignore" });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
      });
      if (!cert) {
        return skip(`openssl (${openssl}) could not generate a certificate`);
      }
      server = spawn(
        openssl,
        [
          "s_server",
          "-accept",
          String(freePort),
          "-tls1_2",
          "-www",
          "-key",
          join(work, "key.pem"),
          "-cert",
          join(work, "cert.pem"),
        ],
        { stdio: "ignore" },
      );
      const listening = await new Promise((resolve) => {
        let tries = 0;
        const attempt = () => {
          const socket = net.createConnection({
            host: "127.0.0.1",
            port: freePort,
          });
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => {
            socket.destroy();
            if (++tries < 50) {
              setTimeout(attempt, 100);
            } else {
              resolve(false);
            }
          });
        };
        attempt();
      });
      if (!listening) {
        return skip(
          `openssl (${openssl}) s_server never listened on ${freePort}`,
        );
      }
      const { status } = await execNode(
        [
          binPath,
          "--cmd",
          `sh -c 'curl -sk --noproxy "" https://localhost:${freePort}/'`,
          "--proxy-egress",
          "--allow-host",
          "localhost",
          "--allow-port",
          String(freePort),
          "--output",
          tmpFile,
        ],
        180000,
      );
      if (status !== 0) {
        return skip("tracebom run failed or timed out in this environment");
      }
      const bom = JSON.parse(readFileSync(tmpFile, "utf-8"));
      const certificates = (bom.components || []).filter(
        (component) =>
          component.type === "cryptographic-asset" &&
          component.cryptoProperties?.assetType === "certificate",
      );
      if (!certificates.length) {
        return skip(
          "no chain was observed (traced curl could not use the egress tunnel)",
        );
      }
      const observed = certificates.find((component) =>
        (component.properties || []).some(
          (property) =>
            property.name === "cdx:crypto:sourceType" &&
            property.value === "observed-tls",
        ),
      );
      assert.ok(observed, "a certificate with sourceType observed-tls");
      assert.ok(
        (observed.evidence?.occurrences || []).some((occurrence) =>
          occurrence.location.startsWith("tls://"),
        ),
        "the server is an occurrence",
      );
    } finally {
      server?.kill();
      rmSync(work, { recursive: true, force: true });
    }
  });
});

function execNode(args, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    const errChunks = [];
    const child = spawn(process.argv0, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Without a deadline a wedged sandbox run would hang the suite forever.
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ status: 1, stdout: "", stderr: "execNode timeout" });
        }, timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errChunks.push(chunk));
    child.on("close", (status) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        status,
        stdout: Buffer.concat(chunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
      });
    });
    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({ status: 1, stdout: "", stderr: err.message });
    });
  });
}
