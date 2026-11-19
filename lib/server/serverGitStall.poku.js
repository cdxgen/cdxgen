import { spawnSync } from "node:child_process";
import net from "node:net";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";

// git waits for a remote for as long as the remote keeps the connection open.
// A request naming a git host that accepts the connection and then never
// sends a byte must not keep the server from answering its other clients
// while the clone waits. The environment changes are process-wide, so this
// file holds one sequential test.

const GIT_ENV = {
  CDXGEN_GIT_ALLOWED_HOSTS: "127.0.0.1",
  CDXGEN_GIT_ALLOW_PROTOCOL: "git",
  // Bounds the test when the clone does block the server.
  CDXGEN_GIT_TIMEOUT_MS: "20000",
};

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

it("the server answers other requests while a clone waits on a silent git host", async () => {
  if (!gitAvailable) {
    console.log("git is not installed; the silent git host check did not run.");
    return;
  }
  const previous = Object.fromEntries(
    Object.keys(GIT_ENV).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, GIT_ENV);
  const sockets = [];
  let gitConnected;
  const gitConnection = new Promise((resolve) => {
    gitConnected = resolve;
  });
  const silentGitHost = net.createServer((socket) => {
    sockets.push(socket);
    gitConnected();
  });
  const gitUrl = `git://127.0.0.1:${await listen(silentGitHost)}/repo`;
  let cdxgenServer;
  try {
    const http = await import("node:http");
    const { start } = await esmock("./server.js", {
      "node:http": {
        ...http,
        default: {
          ...http.default,
          createServer: (app) => {
            cdxgenServer = http.default.createServer(app);
            return cdxgenServer;
          },
        },
      },
    });
    // start() refuses port 0, so a free port is found first.
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    start({ serverHost: "127.0.0.1", serverPort: port });
    await new Promise((resolve) => cdxgenServer.once("listening", resolve));

    const asked = Date.now();
    const sbom = fetch(
      `http://127.0.0.1:${port}/sbom?url=${encodeURIComponent(gitUrl)}`,
    );
    await gitConnection;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(health.status, 200);
    assert.ok(
      Date.now() - asked < 10000,
      "the server answered only after git was stopped",
    );

    // Once the git host hangs up, the clone fails and the request ends.
    for (const socket of sockets) {
      socket.destroy();
    }
    const response = await sbom;
    assert.strictEqual(response.status, 500);
    assert.strictEqual(
      (await response.json()).error,
      "Unable to clone repository",
    );
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => silentGitHost.close(resolve));
    if (cdxgenServer) {
      cdxgenServer.closeAllConnections();
      await new Promise((resolve) => cdxgenServer.close(resolve));
    }
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
