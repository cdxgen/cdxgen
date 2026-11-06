import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import {
  findGitRefForPurlVersion,
  gitClone,
  gitRedirectsRefused,
} from "./source.js";

// git follows the first redirect of an HTTP remote by default, so a host on
// the git allowlist could send a clone or ls-remote to any other host. These
// tests run real git against test/data/git-redirect/redirect-servers.mjs,
// whose "allowed" server redirects every request to a "target" server under
// another host name.

const SERVERS = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "test",
  "data",
  "git-redirect",
  "redirect-servers.mjs",
);

const GIT_ENV_NAMES = [
  "CDXGEN_GIT_ALLOWED_HOSTS",
  "CDXGEN_GIT_ALLOW_PROTOCOL",
  "CDXGEN_SERVER_ALLOWED_HOSTS",
  "CDXGEN_SERVER_GIT_ALLOW_PROTOCOL",
  "GIT_ALLOW_PROTOCOL",
];

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

async function withRedirectServers(env, fn) {
  const child = spawn(process.execPath, [SERVERS], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.setEncoding("utf-8");
  const ports = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const ready = output
        .split("\n")
        .find((line) => line.startsWith("READY "));
      if (ready) {
        const [, allowed, target] = ready.split(" ");
        resolve({ allowed: Number(allowed), target: Number(target) });
      }
    });
    child.on("exit", () => reject(new Error("The redirect servers exited.")));
  });
  const saved = Object.fromEntries(
    GIT_ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  for (const name of GIT_ENV_NAMES) {
    delete process.env[name];
  }
  Object.assign(process.env, env);
  try {
    // git runs synchronously, so the servers live in their own process and
    // their output is read once git has finished.
    fn(`http://localhost:${ports.allowed}/repo.git`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return output
      .split("\n")
      .filter((line) => line.startsWith("HIT "))
      .map((line) => line.split(" ")[1]);
  } finally {
    for (const name of GIT_ENV_NAMES) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    child.stdin.end();
  }
}

// The cases run one after another: cdxgen prints its redirect hint once per
// process, and the clone case expects to be the first to trigger it.
describe("git redirects and the git host allowlist", async () => {
  await it("refuses redirects while a git host allowlist applies", () => {
    const saved = Object.fromEntries(
      GIT_ENV_NAMES.map((name) => [name, process.env[name]]),
    );
    try {
      for (const name of GIT_ENV_NAMES) {
        delete process.env[name];
      }
      assert.strictEqual(gitRedirectsRefused(), false);
      process.env.CDXGEN_GIT_ALLOWED_HOSTS = "github.com";
      assert.strictEqual(gitRedirectsRefused(), true);
      delete process.env.CDXGEN_GIT_ALLOWED_HOSTS;
      process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "github.com";
      assert.strictEqual(gitRedirectsRefused(), true);
    } finally {
      for (const name of GIT_ENV_NAMES) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
    }
  });

  await it("follows a redirect when no allowlist applies", async () => {
    if (!gitAvailable) {
      console.log("git is not installed; the redirect checks did not run.");
      return;
    }
    // The control: without an allowlist git reaches the second host, which
    // is what the allowlisted runs below must not do.
    const hits = await withRedirectServers(
      { CDXGEN_GIT_ALLOW_PROTOCOL: "http" },
      (url) => {
        rmSync(gitClone(url), { recursive: true, force: true });
      },
    );
    assert.ok(hits.includes("allowed"), hits.join(","));
    assert.ok(hits.includes("target"), hits.join(","));
  });

  await it("does not clone through a redirect to a host outside the allowlist", async () => {
    if (!gitAvailable) {
      return;
    }
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let hits;
    try {
      hits = await withRedirectServers(
        {
          CDXGEN_GIT_ALLOWED_HOSTS: "localhost",
          CDXGEN_GIT_ALLOW_PROTOCOL: "http",
        },
        (url) => {
          rmSync(gitClone(url), { recursive: true, force: true });
        },
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(hits.includes("allowed"), hits.join(","));
    assert.ok(!hits.includes("target"), hits.join(","));
    assert.ok(
      warnings.some((warning) => warning.includes("answered with a redirect")),
      warnings.join("\n"),
    );
  });

  await it("does not list remote refs through a redirect to a host outside the allowlist", async () => {
    if (!gitAvailable) {
      return;
    }
    const hits = await withRedirectServers(
      {
        CDXGEN_SERVER_ALLOWED_HOSTS: "localhost",
        CDXGEN_GIT_ALLOW_PROTOCOL: "http",
      },
      (url) => {
        assert.strictEqual(
          findGitRefForPurlVersion(url, { version: "1.0.0" }),
          undefined,
        );
      },
    );
    assert.ok(hits.includes("allowed"), hits.join(","));
    assert.ok(!hits.includes("target"), hits.join(","));
  });
});
