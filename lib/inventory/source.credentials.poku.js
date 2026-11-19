import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { findGitRefForPurlVersion } from "./source.js";

// git hands a URL password that worked to the credential helpers of the
// account it runs as. A helper such as "store" or "cache" saves it and
// answers with it for every later command for that host, so one client of
// the server would clone with the token of another. These tests run real git
// against test/data/git-credentials/private-host.mjs, which gives its refs to
// one user and password only, as an account whose helper is "store".

const PRIVATE_HOST = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "test",
  "data",
  "git-credentials",
  "private-host.mjs",
);

const USER_AND_PASSWORD = "alice:alice-token";

// Everything that decides where git finds its configuration and credentials.
const GIT_ENV_NAMES = [
  "CDXGEN_GIT_ALLOWED_HOSTS",
  "CDXGEN_GIT_ALLOW_PROTOCOL",
  "CDXGEN_SERVER_ALLOWED_HOSTS",
  "CDXGEN_SERVER_GIT_ALLOW_PROTOCOL",
  "GIT_ALLOW_PROTOCOL",
  "GIT_ASKPASS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "HOME",
  "SSH_ASKPASS",
  "XDG_CONFIG_HOME",
];

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

async function withPrivateHost(fn) {
  const child = spawn(process.execPath, [PRIVATE_HOST, USER_AND_PASSWORD], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.setEncoding("utf-8");
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const ready = output
        .split("\n")
        .find((line) => line.startsWith("READY "));
      if (ready) {
        resolve(Number(ready.split(" ")[1]));
      }
    });
    child.on("exit", () => reject(new Error("The private host exited.")));
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cdxgen-git-home-"));
  const gitConfig = path.join(home, ".gitconfig");
  fs.writeFileSync(gitConfig, "[credential]\n\thelper = store\n");
  const saved = Object.fromEntries(
    GIT_ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  for (const name of GIT_ENV_NAMES) {
    delete process.env[name];
  }
  Object.assign(process.env, {
    CDXGEN_GIT_ALLOW_PROTOCOL: "http",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
  try {
    // git runs synchronously, so the host lives in its own process.
    fn(`localhost:${port}`, path.join(home, ".git-credentials"));
  } finally {
    for (const name of GIT_ENV_NAMES) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    child.stdin.end();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("git credential helpers and URL passwords", async () => {
  await it("does not save a URL password for the next command", async () => {
    if (!gitAvailable) {
      console.log("git is not installed; the credential checks did not run.");
      return;
    }
    await withPrivateHost((host, credentialStore) => {
      assert.strictEqual(
        findGitRefForPurlVersion(
          `http://${USER_AND_PASSWORD}@${host}/private.git`,
          { version: "1.0.0" },
        ),
        "v1.0.0",
      );
      assert.strictEqual(fs.existsSync(credentialStore), false);
      // The same repository without a credential, as another client of the
      // server would ask for it.
      assert.strictEqual(
        findGitRefForPurlVersion(`http://${host}/private.git`, {
          version: "1.0.0",
        }),
        undefined,
      );
    });
  });

  await it("still asks the credential helpers for a URL without a password", async () => {
    if (!gitAvailable) {
      return;
    }
    // The control: what the account itself has saved keeps working.
    await withPrivateHost((host, credentialStore) => {
      fs.writeFileSync(
        credentialStore,
        `http://${USER_AND_PASSWORD}@${host}\n`,
      );
      assert.strictEqual(
        findGitRefForPurlVersion(`http://${host}/private.git`, {
          version: "1.0.0",
        }),
        "v1.0.0",
      );
    });
  });
});
