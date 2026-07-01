import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "poku";

import {
  createDaemonConnection,
  parseDaemonPrefixUrl,
} from "./dockerConnection.js";

// Windows cannot bind an HTTP server to an arbitrary unix domain socket path
// (listen fails with EACCES), so the socket-backed tests only run on POSIX.
const socketIt =
  process.platform === "win32"
    ? () => {
        // no-op: skip unix-socket server tests on Windows
      }
    : it;

/**
 * Start an HTTP server bound to a unix domain socket that mimics the tiny slice
 * of the Docker Engine API cdxgen uses (`_ping`, image inspect, image export).
 * This lets the undici unix-socket path be exercised on CI without a real
 * container runtime.
 *
 * @returns {Promise<{socketPath: string, prefixUrl: string, close: function(): Promise<void>}>}
 */
function startUnixDaemon() {
  const socketPath = join(tmpdir(), `cdxgen-docker-${randomUUID()}.sock`);
  const received = { registryAuth: undefined };
  const server = createServer((req, res) => {
    received.registryAuth = req.headers["x-registry-auth"];
    if (req.url === "/_ping") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("OK");
      return;
    }
    if (req.url === "/images/hello-world:latest/json") {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-seen-auth": req.headers["x-registry-auth"] || "",
      });
      res.end(
        JSON.stringify({ Id: "sha256:hello", RepoTags: ["hello:latest"] }),
      );
      return;
    }
    if (req.url === "/images/hello-world:latest/get") {
      res.writeHead(200, { "content-type": "application/x-tar" });
      res.end("tar-bytes");
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        prefixUrl: `http://unix:${socketPath}:`,
        received,
        close: () =>
          new Promise((res) => {
            server.close(() => {
              rmSync(socketPath, { force: true });
              res();
            });
          }),
      });
    });
  });
}

it("parseDaemonPrefixUrl() splits unix socket prefixes", () => {
  assert.deepStrictEqual(
    parseDaemonPrefixUrl("http://unix:/var/run/docker.sock:"),
    { socketPath: "/var/run/docker.sock", baseUrl: "http://localhost" },
  );
});

it("parseDaemonPrefixUrl() handles TCP prefixes", () => {
  assert.deepStrictEqual(parseDaemonPrefixUrl("http://localhost:2375"), {
    socketPath: undefined,
    baseUrl: "http://localhost:2375",
  });
});

socketIt("createDaemonConnection() talks to a unix socket daemon", async () => {
  const daemon = await startUnixDaemon();
  const conn = createDaemonConnection(daemon.prefixUrl);
  try {
    // Probe endpoint returns a Buffer for non-JSON requests.
    const ping = await conn.request("_ping", { method: "GET" });
    assert.ok(Buffer.isBuffer(ping));
    assert.strictEqual(ping.toString("utf-8"), "OK");

    // GET with responseType json returns the parsed inspect payload.
    const inspect = await conn.request("images/hello-world:latest/json", {
      responseType: "json",
    });
    assert.strictEqual(inspect.Id, "sha256:hello");
  } finally {
    await conn.close();
    await daemon.close();
  }
});

socketIt("createDaemonConnection() forwards default headers", async () => {
  const daemon = await startUnixDaemon();
  const conn = createDaemonConnection(daemon.prefixUrl, {
    "X-Registry-Auth": "token-123",
  });
  try {
    await conn.request("images/hello-world:latest/json", {
      responseType: "json",
    });
    // The default X-Registry-Auth header reaches the daemon.
    assert.strictEqual(daemon.received.registryAuth, "token-123");
  } finally {
    await conn.close();
    await daemon.close();
  }
});

socketIt("createDaemonConnection() streams response bodies", async () => {
  const daemon = await startUnixDaemon();
  const conn = createDaemonConnection(daemon.prefixUrl);
  try {
    const chunks = [];
    const readable = conn.stream("images/hello-world:latest/get");
    for await (const chunk of readable) {
      chunks.push(chunk);
    }
    assert.strictEqual(Buffer.concat(chunks).toString("utf-8"), "tar-bytes");
  } finally {
    await conn.close();
    await daemon.close();
  }
});

socketIt(
  "createDaemonConnection() throws on daemon error status codes",
  async () => {
    const daemon = await startUnixDaemon();
    const conn = createDaemonConnection(daemon.prefixUrl);
    try {
      await conn.request("missing/endpoint", { responseType: "json" });
      assert.fail("expected a daemon error to be thrown");
    } catch (err) {
      assert.strictEqual(err.statusCode, 404);
    } finally {
      await conn.close();
      await daemon.close();
    }
  },
);
