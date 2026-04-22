import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

import bodyParser from "body-parser";
import compression from "compression";
import connect from "connect";

import { createBom, submitBom } from "../cli/index.js";
import {
  CDXGEN_VERSION,
  getTmpDir,
  hasDangerousUnicode,
  isSecureMode,
  isValidDriveRoot,
  isWin,
  safeSpawnSync,
} from "../helpers/utils.js";
import { postProcess } from "../stages/postgen/postgen.js";

// Timeout milliseconds. Default 10 mins
const TIMEOUT_MS =
  Number.parseInt(process.env.CDXGEN_SERVER_TIMEOUT_MS, 10) || 10 * 60 * 1000;

const ALLOWED_PARAMS = [
  "type",
  "excludeType",
  "multiProject",
  "requiredOnly",
  "noBabel",
  "installDeps",
  "projectId",
  "projectName",
  "projectGroup",
  "projectTag",
  "projectVersion",
  "autoCreate",
  "isLatest",
  "parentUUID",
  "parentProjectName",
  "parentProjectVersion",
  "serverUrl",
  "apiKey",
  "specVersion",
  "filter",
  "only",
  "autoCompositions",
  "gitBranch",
  "lifecycle",
  "deep",
  "profile",
  "exclude",
  "includeCrypto",
  "standard",
  "minConfidence",
  "technique",
  "tlpClassification",
];

const app = connect();

app.use(
  bodyParser.json({
    deflate: true,
    limit: "1mb",
  }),
);
app.use(compression());

/**
 * Return git allow protocol string from the environment variables.
 *
 * @returns {string} git allow protocol string
 */
function getGitAllowProtocol() {
  return (
    process.env.GIT_ALLOW_PROTOCOL ||
    process.env.CDXGEN_SERVER_GIT_ALLOW_PROTOCOL ||
    (isSecureMode ? "https:ssh" : "https:git:ssh")
  );
}

/**
 * Checks the given hostname against the allowed list.
 *
 * @param {string} hostname Host name to check
 * @returns {boolean} true if the hostname in its entirety is allowed. false otherwise.
 */
export function isAllowedHost(hostname) {
  if (!process.env.CDXGEN_SERVER_ALLOWED_HOSTS) {
    return true;
  }
  // Guard against dangerous Unicode characters
  if (hasDangerousUnicode(hostname)) {
    return false;
  }
  return (process.env.CDXGEN_SERVER_ALLOWED_HOSTS || "")
    .split(",")
    .includes(hostname);
}

/**
 * Checks the given path string to belong to a drive in Windows.
 *
 * @param {string} p Path string to check
 * @returns {boolean} true if the windows path belongs to a drive. false otherwise (device names)
 */
export function isAllowedWinPath(p) {
  if (typeof p !== "string") {
    return false;
  }
  if (p === "") {
    return true;
  }
  // Guard against dangerous Unicode characters
  if (hasDangerousUnicode(p)) {
    return false;
  }
  try {
    const normalized = path.normalize(p);
    // Check the entire normalized path for dangerous patterns
    if (hasDangerousUnicode(normalized)) {
      return false;
    }
    const { root } = path.parse(normalized);
    // Both Relative paths and invalid windows device names are resulting in an empty root
    // To keep things simple, we don't accept relative paths for Windows server-mode users at all

    // Invocations with unix-style paths result in "\\" as the root on windows
    // path.parse(path.normalize("/foo/bar"))
    // { root: '\\', dir: '\\foo', base: 'bar', ext: '', name: 'bar' }
    if (root === "\\") {
      return true;
    }
    // Check for device/UNC paths - these should always return false
    if (root.startsWith("\\\\")) {
      return false;
    }
    // Strict validation for drive letter format
    return isValidDriveRoot(root);
  } catch (_err) {
    return false;
  }
}

/**
 * Checks the given path against the allowed list.
 *
 * @param {string} p Path string to check
 * @returns {boolean} true if the path is present in the allowed paths. false otherwise.
 */
export function isAllowedPath(p) {
  if (typeof p !== "string") {
    return false;
  }
  // Guard against dangerous Unicode characters
  if (hasDangerousUnicode(p)) {
    return false;
  }
  if (!process.env.CDXGEN_SERVER_ALLOWED_PATHS) {
    return true;
  }
  // Handle CVE-2025-27210 without relying entirely on node blocklists
  if (isWin && !isAllowedWinPath(p)) {
    return false;
  }
  return (process.env.CDXGEN_SERVER_ALLOWED_PATHS || "")
    .split(",")
    .filter(Boolean)
    .some((ap) => {
      const resolvedP = path.resolve(p);
      const resolvedAp = path.resolve(ap);
      const relativePath = path.relative(resolvedAp, resolvedP);
      return (
        relativePath === "" ||
        (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
      );
    });
}

/**
 * Determine if the file path could be a remote URL.
 *
 * @param {string} filePath The Git URL or local path
 * @returns {Boolean} True if the file path is a remote URL. false otherwise.
 */
export function maybeRemotePath(filePath) {
  return /^[a-zA-Z0-9+.-]+:\/\//.test(filePath) || filePath.startsWith("git@");
}

/**
 * Validates a given Git URL/Path against dangerous protocols and allowed hosts.
 *
 * @param {string} filePath The Git URL or local path
 * @returns {Object|null} Error object if invalid, or null if valid
 */
export function validateAndRejectGitSource(filePath) {
  if (/^(ext|fd)::/i.test(filePath)) {
    return {
      status: 400,
      error: "Invalid Protocol",
      details: "The provided protocol is not allowed.",
    };
  }
  if (maybeRemotePath(filePath)) {
    let gitUrlObj;
    try {
      let urlToParse = filePath;
      if (filePath.startsWith("git@") && !filePath.includes("://")) {
        urlToParse = `ssh://${filePath.replace(":", "/")}`;
      }
      gitUrlObj = new URL(urlToParse);
    } catch (_err) {
      return {
        status: 400,
        error: "Invalid URL Format",
        details: "The provided Git URL is malformed.",
      };
    }
    const gitAllowProtocol = getGitAllowProtocol();
    const allowedSchemes = gitAllowProtocol
      .split(":")
      .filter(Boolean)
      .map((p) => `${p.toLowerCase()}:`);

    if (
      allowedSchemes.includes("ssh:") &&
      !allowedSchemes.includes("git+ssh:")
    ) {
      allowedSchemes.push("git+ssh:");
    }

    if (!allowedSchemes.includes(gitUrlObj.protocol)) {
      return {
        status: 400,
        error: "Protocol Not Allowed",
        details: `The protocol '${gitUrlObj.protocol}' is not permitted by GIT_ALLOW_PROTOCOL.`,
      };
    }

    if (gitUrlObj.href.includes("::")) {
      return {
        status: 400,
        error: "Invalid URL Syntax",
        details: "Git remote helper syntax (::) is not allowed.",
      };
    }

    if (!isAllowedHost(gitUrlObj.hostname)) {
      return {
        status: 403,
        error: "Host Not Allowed",
        details: "The Git URL host is not allowed as per the allowlist.",
      };
    }
  }

  return null;
}

function gitClone(repoUrl, branch = null) {
  let baseDirName = path.basename(repoUrl);
  if (!/^[a-zA-Z0-9_-]+$/.test(baseDirName)) {
    baseDirName = "repo-";
  }
  const tempDir = fs.mkdtempSync(path.join(getTmpDir(), baseDirName));

  const gitArgs = [
    "-c",
    "alias.clone=",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "safe.bareRepository=explicit",
    "-c",
    "core.hooksPath=/dev/null",
    "clone",
    "--template=",
    repoUrl,
    "--depth",
    "1",
    tempDir,
  ];
  if (branch) {
    const firstBranchStr = Array.isArray(branch) ? branch[0] : String(branch);
    if (firstBranchStr.startsWith("-")) {
      console.log(
        `Skipping branch clone: invalid branch name ${firstBranchStr}`,
      );
    } else {
      const cloneIndex = gitArgs.indexOf("clone");
      gitArgs.splice(cloneIndex + 1, 0, "--branch", firstBranchStr);
    }
  }
  console.log(
    `Cloning Repo${branch ? ` with branch ${branch}` : ""} to ${tempDir}`,
  );
  const gitAllowProtocol = getGitAllowProtocol();
  const envConfigs = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "safe.bareRepository",
    GIT_CONFIG_VALUE_1: "explicit",
    GIT_TERMINAL_PROMPT: "0",
  };
  const env = isSecureMode
    ? {
        ...process.env,
        ...envConfigs,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ALLOW_PROTOCOL: gitAllowProtocol,
      }
    : {
        ...process.env,
        ...envConfigs,
        GIT_ALLOW_PROTOCOL: gitAllowProtocol,
      };
  const result = safeSpawnSync("git", gitArgs, {
    shell: false,
    env,
  });
  if (result.status !== 0) {
    console.log(result.stderr);
  }

  return tempDir;
}

function sanitizeStr(s) {
  return s ? s.replace(/[\r\n]/g, "") : s;
}

/**
 * Method to safely parse value passed via the query string or body.
 *
 * @param {string|number|Array<string|number>} raw
 * @returns {string|number|boolean|Array<string|number|boolean>}
 * @throws {TypeError} if raw (or any array element) isn’t string or number
 */
export function parseValue(raw) {
  // handle arrays
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      const t = typeof item;
      if (t === "string") {
        if (item === "true") return true;
        if (item === "false") return false;
        return sanitizeStr(item);
      }
      if (t === "number") {
        return item;
      }
      if (item === null || item === undefined) {
        return item;
      }
      throw new TypeError(`Invalid array element type: ${t}.`);
    });
  }

  // handle single values
  const t = typeof raw;
  if (t === "string") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return sanitizeStr(raw);
  }
  if (t === "number") {
    return raw;
  }
  if (t === "boolean") {
    return raw;
  }
  if (raw === null || raw === undefined) {
    return raw;
  }
  throw new TypeError(`Invalid value type: ${t}.`);
}

/**
 * Parses allowed query/body parameters into a typed options object.
 * Query parameters take priority over body parameters. Handles the
 * `type` → `projectType` rename, lifecycle-based `installDeps` defaulting,
 * and profile option expansion.
 *
 * @param {Object} q Parsed query string key/value map
 * @param {Object} [body={}] Parsed request body key/value map
 * @param {Object} [options={}] Seed options object to merge results into
 * @returns {Object} Populated options object
 */
export function parseQueryString(q, body = {}, options = {}) {
  // Priority is query params followed by body
  for (const param of ALLOWED_PARAMS) {
    const raw = q[param] ?? body[param];
    if (raw !== undefined && raw !== null) {
      options[param] = parseValue(raw);
    }
  }
  options.projectType = options.type?.split(",");
  delete options.type;
  if (options.lifecycle === "pre-build") {
    options.installDeps = false;
  }
  if (options.profile) {
    applyProfileOptions(options);
  }
  return options;
}

/**
 * Extracts query parameters from an incoming HTTP request object.
 * Handles repeated keys by collecting their values into an array.
 * Returns an empty object if the URL cannot be parsed.
 *
 * @param {Object} req Node.js/connect HTTP request object
 * @returns {Object} Key/value map of query parameters from the request URL
 */
export function getQueryParams(req) {
  try {
    if (!req?.url) {
      return {};
    }

    const protocol = req.protocol || "http";
    const host = req.headers?.host || "localhost";
    const baseUrl = `${protocol}://${host}`;

    const fullUrl = new URL(req.url, baseUrl);
    const params = Object.create(null);

    // Convert multiple values to an array
    for (const [key, value] of fullUrl.searchParams) {
      if (params[key]) {
        if (Array.isArray(params[key])) {
          params[key].push(value);
        } else {
          params[key] = [params[key], value];
        }
      } else {
        params[key] = value;
      }
    }

    return params;
  } catch (error) {
    console.error("Error parsing URL:", error);
    return {};
  }
}

const applyProfileOptions = (options) => {
  switch (options.profile) {
    case "appsec":
      options.deep = true;
      break;
    case "research":
      options.deep = true;
      options.evidence = true;
      options.includeCrypto = true;
      break;
    default:
      break;
  }
};

const configureServer = (cdxgenServer) => {
  cdxgenServer.headersTimeout = TIMEOUT_MS;
  cdxgenServer.requestTimeout = TIMEOUT_MS;
  cdxgenServer.timeout = 0;
  cdxgenServer.keepAliveTimeout = 0;
};

const ALL_INTERFACES = new Set(["0.0.0.0", "::", "::/128", "::/0"]);

const start = (options) => {
  if (isSecureMode && !process.permission) {
    console.error(
      "SECURE MODE: Node.js permission model not enabled. Use --permission flag.",
    );
    process.exit(1);
  }
  console.log(`cdxgen server version ${CDXGEN_VERSION}`);
  if (ALL_INTERFACES.has(options.serverHost)) {
    console.log("Exposing cdxgen server on all IP address is a security risk!");
    if (isSecureMode) {
      process.exit(1);
    }
  }
  const serverPort = Number(options.serverPort);
  if (!Number.isInteger(serverPort) || serverPort <= 0 || serverPort > 65535) {
    console.log("Invalid server port specified.");
    process.exit(1);
  }
  if (serverPort < 1024) {
    console.log(
      "Running cdxgen server with a privileged port is a security risk!",
    );
    if (isSecureMode) {
      process.exit(1);
    }
  }
  if (
    process.getuid &&
    process.getuid() === 0 &&
    process.env?.CDXGEN_IN_CONTAINER !== "true"
  ) {
    console.log("Running cdxgen server as root is a security risk!");
    if (isSecureMode) {
      process.exit(1);
    }
  }
  if (!process.env.CDXGEN_SERVER_ALLOWED_HOSTS) {
    console.log(
      "No allowlist for git hosts has been specified. This is a security risk that could expose the system to SSRF vulnerabilities!",
    );
    if (isSecureMode) {
      process.exit(1);
    }
  }
  if (isSecureMode && !process.env.CDXGEN_SERVER_ALLOWED_PATHS) {
    console.log(
      "No allowlist for paths has been specified. This is a security risk that could expose the filesystem and internal secrets!",
    );
    process.exit(1);
  }
  if (/(ext|fd):/i.test(getGitAllowProtocol())) {
    console.log(
      "The Git protocols 'ext' and 'fd' are known to be problematic. Allowing those is a security risk that could expose the system to RCE vulnerabilities!",
    );
    if (isSecureMode) {
      process.exit(1);
    }
  }
  console.log(
    "Listening on",
    options.serverHost,
    serverPort,
    "without authentication!",
  );
  const cdxgenServer = http
    .createServer(app)
    .listen(serverPort, options.serverHost);
  configureServer(cdxgenServer);

  app.use("/health", (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "OK" }, null, 2));
  });

  app.use("/sbom", async (req, res) => {
    // Limit to only GET and POST requests
    if (req.method && !["GET", "POST"].includes(req.method.toUpperCase())) {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: "Method Not Allowed",
        }),
      );
    }
    const q = getQueryParams(req);
    let cleanup = false;
    let reqOptions = Object.create(null);
    try {
      reqOptions = parseQueryString(
        q,
        req.body,
        Object.assign(Object.create(null), options),
      );
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: e.toString(),
          details:
            "Options can only be of string, number, and array type. No object values are allowed.",
        }),
      );
    }
    const filePath = q?.path || q?.url || req?.body?.path || req?.body?.url;
    if (!filePath) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: "Path or URL is required.",
        }),
      );
    }
    const validationError = validateAndRejectGitSource(filePath);
    if (validationError) {
      res.writeHead(validationError.status, {
        "Content-Type": "application/json",
      });
      return res.end(
        JSON.stringify({
          error: validationError.error,
          details: validationError.details,
        }),
      );
    }
    let srcDir;
    if (maybeRemotePath(filePath)) {
      srcDir = gitClone(filePath, reqOptions.gitBranch);
      cleanup = true;
    } else {
      srcDir = filePath;
      if (
        !isAllowedPath(path.resolve(srcDir)) ||
        (isWin && !isAllowedWinPath(srcDir))
      ) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: "Path Not Allowed",
            details: "Path is not allowed as per the allowlist.",
          }),
        );
      }
    }
    if (srcDir !== path.resolve(srcDir)) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: "Absolute path needed",
          details: "Relative paths are not supported in server mode.",
        }),
      );
    }
    console.log("Generating SBOM for", srcDir);
    let bomNSData = (await createBom(srcDir, reqOptions)) || {};
    bomNSData = postProcess(bomNSData, reqOptions);
    if (reqOptions.serverUrl && reqOptions.apiKey) {
      if (!isAllowedHost(reqOptions.serverUrl)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: "Host Not Allowed",
            details: "The URL host is not allowed as per the allowlist.",
          }),
        );
      }
      if (isSecureMode && !reqOptions.serverUrl?.startsWith("https://")) {
        console.log(
          "Dependency Track API server is used with a non-https url, which poses a security risk.",
        );
      }
      console.log(
        `Publishing SBOM ${reqOptions.projectName} to Dependency Track`,
        reqOptions.serverUrl,
      );
      try {
        await submitBom(reqOptions, bomNSData.bomJson);
      } catch (error) {
        const errorMessages = error.response?.body?.errors;
        if (errorMessages) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: "Unable to submit the SBOM to the Dependency-Track server",
              details: errorMessages,
            }),
          );
        }
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (bomNSData.bomJson) {
      if (
        typeof bomNSData.bomJson === "string" ||
        bomNSData.bomJson instanceof String
      ) {
        res.write(bomNSData.bomJson);
      } else {
        res.write(JSON.stringify(bomNSData.bomJson, null, null));
      }
    }
    res.end("\n");
    if (cleanup && srcDir?.startsWith(getTmpDir()) && fs.rmSync) {
      console.log(`Cleaning up ${srcDir}`);
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });
};

export { configureServer, gitClone, start };
