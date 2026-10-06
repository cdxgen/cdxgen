// A local stand-in for Maven Central. See README.md for when and how to use it.
//
// GET and HEAD requests for /maven2/<path> are answered from the proxy's own store, then from
// the local Coursier and Maven caches (read-only), then from the upstream mirrors in order.
// Files fetched upstream are kept in the store. maven-metadata.xml and SNAPSHOT files change
// upstream, so they are fetched again once older than MAVEN_PROXY_TTL seconds and served stale
// when every upstream fails. The proxy listens on 127.0.0.1 only.
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import process from "node:process";

const home = homedir();
const cacheHome =
  process.env.XDG_CACHE_HOME ||
  (process.platform === "darwin"
    ? join(home, "Library", "Caches")
    : join(home, ".cache"));
const stateDir =
  process.env.MAVEN_PROXY_STATE || join(cacheHome, "cdxgen-maven-proxy");
const store = join(stateDir, "store");
const port = Number(process.env.MAVEN_PROXY_PORT || 18081);
const ttl = Number(process.env.MAVEN_PROXY_TTL || 3600) * 1000;
const upstreams = (
  process.env.MAVEN_PROXY_UPSTREAM ||
  "https://maven-central.storage-download.googleapis.com/maven2,https://repo1.maven.org/maven2"
)
  .split(",")
  .map((u) => u.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const coursierRoot =
  process.env.COURSIER_SHARED_CACHE ||
  (process.platform === "darwin"
    ? join(home, "Library", "Caches", "Coursier", "v1")
    : join(cacheHome, "coursier", "v1"));
const seeds = [
  join(coursierRoot, "https", "repo1.maven.org", "maven2"),
  join(coursierRoot, "https", "repo.maven.apache.org", "maven2"),
  join(
    coursierRoot,
    "https",
    "maven-central.storage-download.googleapis.com",
    "maven2",
  ),
  join(home, ".m2", "repository"),
].filter((d) => existsSync(d));

const MISS_TTL = 10 * 60 * 1000;
const misses = new Map();
const inflight = new Map();
const stats = { store: 0, seed: 0, upstream: 0, stale: 0, miss: 0, error: 0 };

const isDynamic = (rel) =>
  rel.includes("maven-metadata") || rel.includes(`-SNAPSHOT${sep}`);

function fileIfPresent(path) {
  try {
    const st = statSync(path);
    return st.isFile() && st.size > 0 ? st : undefined;
  } catch {
    return undefined;
  }
}

async function fetchUpstream(rel) {
  const urlPath = rel.split(sep).join("/");
  for (const base of upstreams) {
    try {
      const res = await fetch(`${base}/${urlPath}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(120000),
      });
      if (res.ok) {
        const body = Buffer.from(await res.arrayBuffer());
        const target = join(store, rel);
        mkdirSync(dirname(target), { recursive: true });
        const part = `${target}.${process.pid}.${Date.now()}.part`;
        writeFileSync(part, body);
        renameSync(part, target);
        return { ok: true };
      }
      // A 404 is an answer. A rate limit or a server error moves on to the next mirror.
      if (res.status === 404) {
        return { ok: false, status: 404 };
      }
    } catch {
      // Unreachable or timed out: try the next mirror.
    }
  }
  return { ok: false, status: 502 };
}

// Concurrent requests for the same file share one upstream fetch.
function fetchOnce(rel) {
  if (!inflight.has(rel)) {
    inflight.set(
      rel,
      fetchUpstream(rel).finally(() => inflight.delete(rel)),
    );
  }
  return inflight.get(rel);
}

function send(req, res, path, st, source) {
  stats[source]++;
  res.writeHead(200, { "content-length": st.size, "x-maven-proxy": source });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(path).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstreams, seeds, store, stats }));
    return;
  }
  if (
    !["GET", "HEAD"].includes(req.method) ||
    !url.pathname.startsWith("/maven2/")
  ) {
    res.writeHead(404).end();
    return;
  }
  const rel = normalize(
    decodeURIComponent(url.pathname.slice("/maven2/".length)),
  );
  if (
    !rel ||
    rel === "." ||
    rel.startsWith("..") ||
    rel.startsWith(sep) ||
    rel.includes("\0")
  ) {
    res.writeHead(400).end();
    return;
  }
  const stored = join(store, rel);
  const dynamic = isDynamic(rel);
  let st = fileIfPresent(stored);
  if (st && (!dynamic || Date.now() - st.mtimeMs < ttl)) {
    send(req, res, stored, st, "store");
    return;
  }
  if (!dynamic) {
    for (const seed of seeds) {
      const path = join(seed, rel);
      const seedStat = fileIfPresent(path);
      if (seedStat) {
        send(req, res, path, seedStat, "seed");
        return;
      }
    }
  }
  const missedAt = misses.get(rel);
  if (missedAt && Date.now() - missedAt < MISS_TTL) {
    stats.miss++;
    res.writeHead(404).end();
    return;
  }
  const result = await fetchOnce(rel);
  st = fileIfPresent(stored);
  if (result.ok && st) {
    send(req, res, stored, st, "upstream");
    return;
  }
  if (st) {
    send(req, res, stored, st, "stale");
    return;
  }
  if (result.status === 404) {
    misses.set(rel, Date.now());
    stats.miss++;
  } else {
    stats.error++;
  }
  res.writeHead(result.status).end();
}

mkdirSync(store, { recursive: true });
createServer((req, res) => {
  handle(req, res).catch(() => {
    stats.error++;
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`maven-proxy listening on http://127.0.0.1:${port}/maven2/`);
  console.log(`store: ${store}`);
  console.log(`seeds: ${seeds.join(", ") || "none"}`);
  console.log(`upstreams: ${upstreams.join(", ")}`);
});
