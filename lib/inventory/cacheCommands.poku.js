import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { cacheClear, cacheInfo } from "./cacheCommands.js";
import { fetchCacheDir } from "./cacheDir.js";

function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

it("cacheInfo reports zero entries for an empty cache directory", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cdxgen-cache-info-"));
  try {
    const info = withEnv({ CDXGEN_CACHE_DIR: tmp }, () => cacheInfo());
    assert.strictEqual(info.entryCount, 0);
    assert.strictEqual(info.totalBytes, 0);
    assert.ok(info.directory);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

it("cacheInfo counts entries and bytes for a populated cache", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cdxgen-cache-pop-"));
  try {
    const fetchDir = fetchCacheDir(tmp);
    const hostDir = path.join(fetchDir, "registry.npmjs.org");
    mkdirSync(hostDir, { recursive: true });
    const entry = JSON.stringify({
      v: 2,
      url: "https://registry.npmjs.org/left-pad",
      method: "GET",
      status: 200,
      etag: '"abc"',
      last_modified: null,
      fetched_at: Date.now() / 1000,
      body: { name: "left-pad" },
    });
    writeFileSync(path.join(hostDir, "abc123.json"), entry);
    writeFileSync(path.join(hostDir, "def456.json"), entry);

    const info = withEnv({ CDXGEN_CACHE_DIR: tmp }, () => cacheInfo());
    assert.strictEqual(info.entryCount, 2);
    assert.ok(info.totalBytes > 0);
    assert.ok(info.hosts["registry.npmjs.org"]);
    assert.strictEqual(info.hosts["registry.npmjs.org"].entries, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

it("cacheInfo keeps a host directory named __proto__ off Object.prototype", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cdxgen-cache-proto-"));
  try {
    // cdxrs names the cache directory after the registry host, which a
    // scanned project's .npmrc or lockfile chooses.
    const hostDir = path.join(fetchCacheDir(tmp), "__proto__");
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(path.join(hostDir, "abc123.json"), "{}");

    const info = withEnv({ CDXGEN_CACHE_DIR: tmp }, () => cacheInfo());
    assert.strictEqual(Object.hasOwn(Object.prototype, "entries"), false);
    assert.strictEqual(Object.hasOwn(Object.prototype, "bytes"), false);
    assert.deepStrictEqual(Object.keys(info.hosts), ["__proto__"]);
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(info.hosts, "__proto__").value.entries,
      1,
    );
  } finally {
    for (const key of ["entries", "bytes"]) {
      delete Object.prototype[key];
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

it("cacheClear removes the fetch subdirectory", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "cdxgen-cache-clear-"));
  try {
    const fetchDir = fetchCacheDir(tmp);
    const hostDir = path.join(fetchDir, "registry.npmjs.org");
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      path.join(hostDir, "abc.json"),
      '{"v":2,"url":"x","method":"GET","status":200,"etag":null,"last_modified":null,"fetched_at":0,"body":{}}',
    );

    const result = withEnv({ CDXGEN_CACHE_DIR: tmp }, () => cacheClear());
    assert.strictEqual(result.removedCount, 1);
    assert.ok(result.freedBytes > 0);
    assert.ok(!existsSync(fetchDir), "fetch directory was not removed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

it("cacheInfo resolves a directory on a real system", () => {
  // On a real system, homedir() always resolves; the null case is exercised
  // by the Rust unit tests where env values are pure function parameters.
  const tmp = mkdtempSync(path.join(tmpdir(), "cdxgen-cache-real-"));
  try {
    const info = withEnv({ CDXGEN_CACHE_DIR: tmp }, () => cacheInfo());
    assert.ok(info.directory, "should resolve a cache directory");
    assert.strictEqual(info.entryCount, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
