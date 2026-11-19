import { spawnSync } from "node:child_process";
import net from "node:net";
import process from "node:process";

import { assert, describe, it } from "poku";

import {
  findGitRefForPurlVersionAsync,
  gitClone,
  gitCloneAsync,
} from "./source.js";

// git waits for a remote for as long as the remote keeps the connection open.
// These tests run real git against a listener that accepts connections and
// never sends a byte.

const GIT_ENV = {
  CDXGEN_GIT_ALLOWED_HOSTS: undefined,
  CDXGEN_GIT_ALLOW_PROTOCOL: "git",
  CDXGEN_GIT_TIMEOUT_MS: "1000",
  CDXGEN_SERVER_ALLOWED_HOSTS: undefined,
  CDXGEN_SERVER_GIT_ALLOW_PROTOCOL: undefined,
  GIT_ALLOW_PROTOCOL: undefined,
};

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

async function withSilentGitHost(fn) {
  const saved = Object.fromEntries(
    Object.keys(GIT_ENV).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(GIT_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  const sockets = [];
  const listener = net.createServer((socket) => {
    // Windows resets the connection when git is stopped; the reset is
    // expected and must not surface as an uncaught exception.
    socket.on("error", () => undefined);
    sockets.push(socket);
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`git://127.0.0.1:${listener.address().port}/repo`);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => listener.close(resolve));
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

describe("git operations on a remote that stays silent", async () => {
  await it("are stopped at CDXGEN_GIT_TIMEOUT_MS", async () => {
    if (!gitAvailable) {
      console.log("git is not installed; the timeout checks did not run.");
      return;
    }
    await withSilentGitHost((repoUrl) => {
      const started = Date.now();
      assert.throws(() => gitClone(repoUrl), /Git clone failed/);
      assert.ok(Date.now() - started < 30000);
    });
  });

  await it("leave the event loop running when started with the async variants", async () => {
    if (!gitAvailable) {
      return;
    }
    await withSilentGitHost(async (repoUrl) => {
      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
      }, 50);
      try {
        const gitRef = await findGitRefForPurlVersionAsync(repoUrl, {
          version: "1.0.0",
        });
        assert.strictEqual(gitRef, undefined);
        assert.ok(ticks >= 5, `the event loop ran ${ticks} times`);
        ticks = 0;
        await assert.rejects(() => gitCloneAsync(repoUrl), /Git clone failed/);
        assert.ok(ticks >= 5, `the event loop ran ${ticks} times`);
      } finally {
        clearInterval(ticker);
      }
    });
  });
});
