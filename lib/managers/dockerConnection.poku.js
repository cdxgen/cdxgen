import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

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

// Larger than what undici and the socket buffer between them, so the daemon
// cannot finish the response unless somebody reads or discards it.
const LARGE_BODY_SIZE = 8 * 1024 * 1024;

/**
 * Settle like the given promise, or reject when it is still pending after five
 * seconds, so that a daemon connection that stays busy fails the test instead
 * of hanging it.
 *
 * @param {Promise<*>} promise Promise to wait for.
 * @returns {Promise<*>} The outcome of the promise.
 */
async function withDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the daemon connection is still busy")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Writable that fails on the first chunk, like an extraction running out of
 * disk space, or that reads everything.
 *
 * @param {Error} [error] Error to fail with.
 * @returns {Writable} The writable.
 */
const sink = (error) =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback(error);
    },
  });

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
  const received = { registryAuth: undefined, pendingPulls: [] };
  const server = createServer((req, res) => {
    received.registryAuth = req.headers["x-registry-auth"];
    if (req.url.startsWith("/images/create")) {
      // Keep the response open, like the daemon does while a pull is running.
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"status":"Downloading"}\n');
      received.pendingPulls.push(res);
      return;
    }
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
    if (req.url === "/images/large:latest/get") {
      res.writeHead(200, { "content-type": "application/x-tar" });
      res.end(Buffer.alloc(LARGE_BODY_SIZE));
      return;
    }
    if (req.url === "/images/truncated:latest/get") {
      res.writeHead(200, {
        "content-type": "application/x-tar",
        "content-length": LARGE_BODY_SIZE,
      });
      res.write("tar-bytes", () => res.socket.destroy());
      return;
    }
    if (req.url === "/images/large-error:latest/get") {
      res.writeHead(404);
      res.end(Buffer.alloc(LARGE_BODY_SIZE));
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
            server.closeAllConnections();
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

socketIt(
  "createDaemonConnection() does not queue requests behind a running pull",
  async () => {
    const daemon = await startUnixDaemon();
    const conn = createDaemonConnection(daemon.prefixUrl);
    const pull = conn.request("images/create?fromImage=slow:1", {
      method: "POST",
    });
    let timer;
    try {
      while (daemon.received.pendingPulls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Another request must reach the daemon while the pull is still open
      // instead of being queued behind it on a single connection.
      const ping = await Promise.race([
        conn.request("_ping"),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("request was queued")),
            5000,
          );
        }),
      ]);
      assert.strictEqual(ping.toString("utf-8"), "OK");
    } finally {
      clearTimeout(timer);
      for (const res of daemon.received.pendingPulls) {
        res.end();
      }
      await pull.catch(() => {
        // the pull was cut short by the test; its outcome is irrelevant
      });
      await conn.close();
      await daemon.close();
    }
  },
);

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
  "createDaemonConnection() releases the connection when a stream reader gives up",
  async () => {
    const daemon = await startUnixDaemon();
    const conn = createDaemonConnection(daemon.prefixUrl);
    try {
      await assert.rejects(
        withDeadline(
          pipeline(
            conn.stream("images/large:latest/get"),
            sink(new Error("ENOSPC")),
          ),
        ),
        /ENOSPC/,
      );
      const ping = await withDeadline(conn.request("_ping"));
      assert.strictEqual(ping.toString("utf-8"), "OK");

      // A reader that went away before the response arrived.
      const abandoned = conn.stream("images/large:latest/get");
      abandoned.on("error", () => {
        // expected
      });
      abandoned.destroy(new Error("ENOSPC"));
      await withDeadline(conn.request("_ping"));
    } finally {
      await daemon.close();
      await withDeadline(conn.close());
    }
  },
);

socketIt(
  "createDaemonConnection() releases the connection after a stream error status",
  async () => {
    const daemon = await startUnixDaemon();
    const conn = createDaemonConnection(daemon.prefixUrl);
    try {
      await assert.rejects(
        withDeadline(
          pipeline(conn.stream("images/large-error:latest/get"), sink()),
        ),
        /HTTP 404/,
      );
      await withDeadline(conn.request("_ping"));
    } finally {
      await daemon.close();
      await withDeadline(conn.close());
    }
  },
);

socketIt(
  "createDaemonConnection() reports a truncated stream to the reader",
  async () => {
    const daemon = await startUnixDaemon();
    const conn = createDaemonConnection(daemon.prefixUrl);
    try {
      await assert.rejects(
        withDeadline(
          pipeline(conn.stream("images/truncated:latest/get"), sink()),
        ),
        (error) => error.message !== "the daemon connection is still busy",
      );
      await withDeadline(conn.request("_ping"));
    } finally {
      await daemon.close();
      await withDeadline(conn.close());
    }
  },
);

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

it("aborts a daemon request that passes its overall deadline", async () => {
  const pending = [];
  const server = createServer((_req, res) => {
    // A pull that keeps the response open, as the daemon does while it runs.
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"status":"Downloading"}\n');
    pending.push(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const conn = createDaemonConnection(
    `http://127.0.0.1:${server.address().port}`,
  );
  try {
    await assert.rejects(
      conn.request("images/create?fromImage=slow:latest", {
        method: "POST",
        timeoutMs: 200,
      }),
      (err) => err?.name === "TimeoutError",
    );
  } finally {
    for (const res of pending) {
      res.destroy();
    }
    await conn.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
