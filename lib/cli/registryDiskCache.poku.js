import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

// Separate cdxgen runs share the registry documents a run kept on disk, so a
// second scan of the same project asks the registry nothing, and a document is
// asked for again once its TTL has passed. cdxrs is switched off, as on an
// install without it, so every request runs on the JS pool, which also serves
// crates.io, HTML pages and POMs when cdxrs is present. Each pass is a fresh
// process with an empty home directory, pointed at a loopback registry.

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function runCdxgen(projectDir, outFile, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(REPO_ROOT, "bin", "cdxgen.js"),
        "-t",
        "cargo",
        "--no-install-deps",
        "-o",
        outFile,
        projectDir,
      ],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function serdeLicense(bomFile) {
  const bom = JSON.parse(readFileSync(bomFile, "utf-8"));
  return bom.components.find((c) => c.name === "serde")?.licenses?.[0]?.license
    ?.id;
}

it("a second cdxgen run reads registry documents from the disk cache", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cdxgen-disk-cache-runs-"));
  const projectDir = path.join(root, "project");
  const home = path.join(root, "home");
  const cacheDir = path.join(root, "cache");
  mkdirSync(projectDir);
  mkdirSync(home);
  copyFileSync(
    path.join(REPO_ROOT, "test", "data", "registry-stub", "Cargo.lock"),
    path.join(projectDir, "Cargo.lock"),
  );
  const hits = [];
  const registry = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        crate: {
          description: "A serialization framework",
          newest_version: "1.0.0",
          repository: "https://github.com/serde-rs/serde",
        },
        versions: [
          {
            num: "1.0.0",
            license: "MIT",
            id: 1,
            dl_path: "/api/v1/crates/serde/1.0.0/download",
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const env = {
    ...process.env,
    FETCH_LICENSE: "true",
    RUST_CRATES_URL: `http://127.0.0.1:${registry.address().port}/crates/`,
    CDXGEN_CACHE_DIR: cacheDir,
    CDXGEN_CACHE_LOOPBACK: "1",
    CDXGEN_CACHE_TTL: "3600",
    CDXGEN_RS_DISABLE: "fetch",
    HOME: home,
    USERPROFILE: home,
    CARGO_HOME: path.join(home, ".cargo"),
  };
  delete env.CDXGEN_NO_CACHE;
  try {
    const first = await runCdxgen(projectDir, path.join(root, "first.json"), env);
    assert.strictEqual(first.code, 0, first.stderr);
    // Positive control: the first run asks the registry.
    assert.deepStrictEqual(hits, ["/crates/serde"]);
    assert.strictEqual(serdeLicense(path.join(root, "first.json")), "MIT");

    hits.length = 0;
    const second = await runCdxgen(projectDir, path.join(root, "second.json"), env);
    assert.strictEqual(second.code, 0, second.stderr);
    assert.deepStrictEqual(hits, [], "the second run asked the registry again");
    assert.strictEqual(serdeLicense(path.join(root, "second.json")), "MIT");

    // Once the TTL has passed, the registry is asked again.
    const hostDir = path.join(cacheDir, "cdxrs-fetch", "127.0.0.1");
    for (const name of readdirSync(hostDir)) {
      const file = path.join(hostDir, name);
      const entry = JSON.parse(readFileSync(file, "utf-8"));
      entry.fetched_at -= 3601;
      writeFileSync(file, JSON.stringify(entry));
    }
    hits.length = 0;
    const third = await runCdxgen(projectDir, path.join(root, "third.json"), env);
    assert.strictEqual(third.code, 0, third.stderr);
    assert.deepStrictEqual(hits, ["/crates/serde"]);
  } finally {
    await new Promise((resolve) => registry.close(resolve));
    rmSync(root, { force: true, recursive: true });
  }
}, 180000);
