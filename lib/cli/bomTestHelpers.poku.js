import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import esmock from "esmock";
import sinon from "sinon";

export const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "chrome-extensions",
);
export const cargoFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "cargo-workspace-repotest",
);
export const cargoCacheFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "cargo-cache-fixture",
  "registry",
  "cache",
  "index.crates.io-1949cf8c6b5b557f",
);
export const mcpFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "mcp-repotest",
);
export const cbomFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "cbom-js-repotest",
);
export const cacheDisableFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "cache-disable-repotest",
);
export const composerFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
);
export const uvSmokeFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "repotests",
  "uv-smoke",
);
export const uvWorkspaceFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "uv-workspace-repotest",
);
export const pyLockSmokeFixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "repotests",
  "pylock-smoke",
);
export const repoDir = resolve(
  join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
);

export function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

export function createComposerNodeModulesFixture() {
  const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-composer-node-modules-"));
  const packageDir = join(tmpDir, "node_modules", "moment-timezone");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "composer.json"),
    readFileSync(join(composerFixtureDir, "composer.json"), "utf-8"),
  );
  writeFileSync(
    join(packageDir, "composer.lock"),
    readFileSync(join(composerFixtureDir, "composer.lock"), "utf-8"),
  );
  return tmpDir;
}

export function createJarNodeModulesFixture() {
  const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-jar-node-modules-"));
  const packageDir = join(tmpDir, "node_modules", "font-mfizz");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "blaze.jar"), "fake jar content");
  return tmpDir;
}

export const stubbedJarPackage = {
  group: "org.slf4j",
  name: "slf4j-simple",
  version: "2.0.17",
  purl: "pkg:maven/org.slf4j/slf4j-simple@2.0.17?type=jar",
  "bom-ref": "pkg:maven/org.slf4j/slf4j-simple@2.0.17?type=jar",
};

export async function loadStubbedCreateJarBom() {
  const extractJarArchive = sinon.stub().resolves([stubbedJarPackage]);
  const getMvnMetadata = sinon.stub().callsFake(async (pkgList) => pkgList);
  const mocked = await esmock("./jvmBom.js", {
    "../ecosystems/ecosystems.js": { extractJarArchive, getMvnMetadata },
  });
  return mocked.createJarBom;
}

export function toPortablePath(filePath) {
  return normalize(filePath).split(sep).join("/");
}

export function getNpmPackFilePaths() {
  const command =
    process.platform === "win32"
      ? {
          args: ["/c", "npm", "pack", "--dry-run", "--json"],
          file: process.env.ComSpec || "cmd.exe",
        }
      : {
          args: ["pack", "--dry-run", "--json"],
          file: "npm",
        };
  const packOutput = execFileSync(command.file, command.args, {
    cwd: repoDir,
    encoding: "utf8",
  });
  const [packSummary] = JSON.parse(packOutput);
  return packSummary.files.map((file) => toPortablePath(file.path));
}

export function buildMinimalCliEnv(extraEnv = {}) {
  const baseEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
  };
  if (process.platform === "win32") {
    baseEnv.SystemRoot = process.env.SystemRoot;
    baseEnv.TEMP = process.env.TEMP;
    baseEnv.TMP = process.env.TMP;
    baseEnv.USERPROFILE = process.env.USERPROFILE;
  }
  return Object.fromEntries(
    Object.entries({
      ...baseEnv,
      ...extraEnv,
    }).filter(([, value]) => value !== undefined),
  );
}

export async function startSubmitBomTestServer(requestHandler) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      const request = {
        body,
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        method: req.method,
        url: req.url,
      };
      requests.push(request);
      const response = (await requestHandler(request, requests.length)) || {};
      if (res.writableEnded) {
        return;
      }
      res.writeHead(response.statusCode || 200, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(response.body || { success: true }));
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const serverUrl = `http://127.0.0.1:${address.port}`;
  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    requests,
    serverUrl,
  };
}

export function getRequestHeader(request, headerName) {
  const normalizedHeaderName = headerName.toLowerCase();
  const directValue = request?.headers?.[normalizedHeaderName];
  if (directValue !== undefined) {
    return Array.isArray(directValue) ? directValue[0] : directValue;
  }
  const rawHeaders = request?.rawHeaders;
  if (!Array.isArray(rawHeaders)) {
    return undefined;
  }
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === normalizedHeaderName) {
      return rawHeaders[index + 1];
    }
  }
  return undefined;
}

/**
 * Parses a `multipart/form-data` request body into a map of part name to
 * `{ value, filename, contentType }`.
 *
 * @param {string} body Raw request body
 * @param {string} contentType Content-Type header carrying the boundary
 * @returns {Object} parsed parts keyed by field name
 */
export function parseMultipartFormData(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || "");
  if (!boundary) {
    throw new Error(`No multipart boundary in content type: ${contentType}`);
  }
  const parts = {};
  for (const segment of body.split(`--${boundary[1] || boundary[2]}`)) {
    const separator = segment.indexOf("\r\n\r\n");
    if (!segment.startsWith("\r\n") || separator === -1) {
      continue;
    }
    const headers = segment.slice(2, separator);
    const name = /name="([^"]*)"/.exec(headers);
    if (!name) {
      continue;
    }
    parts[name[1]] = {
      contentType: /Content-Type:\s*(\S+)/i.exec(headers)?.[1],
      filename: /filename="([^"]*)"/.exec(headers)?.[1],
      // Every part ends with the CRLF preceding the delimiter.
      value: segment.slice(separator + 4, -2),
    };
  }
  return parts;
}
