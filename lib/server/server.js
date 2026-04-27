import http from "node:http";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

import bodyParser from "body-parser";
import compression from "compression";
import connect from "connect";

import { createBom, submitBom } from "../cli/index.js";
import { normalizeOutputFormats } from "../helpers/exportUtils.js";
import {
  cleanupSourceDir,
  findGitRefForPurlVersion,
  getGitAllowProtocol,
  gitClone,
  isAllowedPath,
  isAllowedWinPath,
  maybePurlSource,
  maybeRemotePath,
  PURL_REGISTRY_LOOKUP_WARNING,
  resolveGitUrlFromPurl,
  resolvePurlSourceDirectory,
  sanitizeRemoteUrlForLogs,
  validateAndRejectGitSource,
  validatePurlSource,
} from "../helpers/source.js";
import {
  CDXGEN_VERSION,
  hasDangerousUnicode,
  isSecureMode,
  isWin,
} from "../helpers/utils.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { convertCycloneDxToSpdx } from "../stages/postgen/spdxConverter.js";

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
  "format",
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

function isAllowedHttpHost(hostname) {
  if (!process.env.CDXGEN_ALLOWED_HOSTS) {
    return true;
  }
  if (!hostname || hasDangerousUnicode(hostname)) {
    return false;
  }
  const allowHosts = process.env.CDXGEN_ALLOWED_HOSTS.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  for (const allowedHost of allowHosts) {
    if (hostname === allowedHost) {
      return true;
    }
    if (
      allowedHost.startsWith("*.") &&
      hostname.endsWith(allowedHost.slice(1))
    ) {
      return true;
    }
  }
  return false;
}

app.use(
  bodyParser.json({
    deflate: true,
    limit: "1mb",
  }),
);
app.use(compression());

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
  if (
    !process.env.CDXGEN_GIT_ALLOWED_HOSTS &&
    !process.env.CDXGEN_SERVER_ALLOWED_HOSTS
  ) {
    console.log(
      "No allowlist for git hosts has been specified. This is a security risk that could expose the system to SSRF vulnerabilities!",
    );
    if (isSecureMode) {
      process.exit(1);
    }
  }
  if (
    isSecureMode &&
    !process.env.CDXGEN_ALLOWED_PATHS &&
    !process.env.CDXGEN_SERVER_ALLOWED_PATHS
  ) {
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
    let cloneDir;
    let srcDir;
    try {
      let sourcePath = filePath;
      let purlResolution;
      if (maybePurlSource(sourcePath)) {
        const purlValidationError = validatePurlSource(sourcePath);
        if (purlValidationError) {
          res.writeHead(purlValidationError.status, {
            "Content-Type": "application/json",
          });
          return res.end(
            JSON.stringify({
              error: purlValidationError.error,
              details: purlValidationError.details,
            }),
          );
        }
        purlResolution = await resolveGitUrlFromPurl(sourcePath);
        if (!purlResolution?.repoUrl) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: "Unsupported purl source",
              details:
                "Unable to resolve the provided package URL to a repository URL.",
            }),
          );
        }
        if (purlResolution.registry) {
          console.warn(
            `${PURL_REGISTRY_LOOKUP_WARNING} Registry: ${purlResolution.registry}, purl type: ${purlResolution.type}, resolved URL: ${sanitizeRemoteUrlForLogs(purlResolution.repoUrl)}`,
          );
        } else {
          console.warn(
            `Resolved repository URL from purl metadata. purl type: ${purlResolution.type}, resolved URL: ${sanitizeRemoteUrlForLogs(purlResolution.repoUrl)}`,
          );
        }
        sourcePath = purlResolution.repoUrl;
      }
      const validationError = validateAndRejectGitSource(sourcePath);
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
      if (maybeRemotePath(sourcePath)) {
        let gitRef = reqOptions.gitBranch;
        if (!gitRef && purlResolution?.version) {
          gitRef = findGitRefForPurlVersion(sourcePath, purlResolution);
          if (!gitRef) {
            console.warn(
              `Unable to find a matching git tag for version '${purlResolution.version}'. Falling back to repository default branch.`,
            );
          }
        }
        cloneDir = gitClone(sourcePath, gitRef);
        srcDir = cloneDir;
        if (purlResolution?.type === "npm") {
          const cloneRootDir = cloneDir;
          const purlSourceDir = resolvePurlSourceDirectory(
            srcDir,
            purlResolution,
          );
          if (purlSourceDir && purlSourceDir !== cloneRootDir) {
            const relativeDir = path.relative(cloneRootDir, purlSourceDir);
            if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
              console.warn(
                `Ignoring detected npm package directory outside clone root: ${purlSourceDir}`,
              );
            } else {
              console.warn(
                `Using npm package directory '${purlSourceDir}' for purl '${purlResolution.namespace ? `${purlResolution.namespace}/` : ""}${purlResolution.name}'.`,
              );
              srcDir = purlSourceDir;
            }
          }
        }
        cleanup = true;
      } else {
        srcDir = sourcePath;
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
      bomNSData = postProcess(bomNSData, reqOptions, srcDir);
      const requestedFormats = normalizeOutputFormats(reqOptions.format);
      let responseBomJson = bomNSData.bomJson;
      if (
        requestedFormats.includes("spdx") &&
        bomNSData?.bomJson?.bomFormat === "CycloneDX"
      ) {
        responseBomJson = convertCycloneDxToSpdx(bomNSData.bomJson, reqOptions);
      }
      if (reqOptions.serverUrl && reqOptions.apiKey) {
        let serverHostname;
        try {
          serverHostname = new URL(reqOptions.serverUrl).hostname;
        } catch (err) {
          console.log("Invalid Dependency-Track server URL", err);
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: "Invalid Server URL",
              details: "The Dependency-Track server URL is invalid.",
            }),
          );
        }
        if (!isAllowedHttpHost(serverHostname)) {
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
                error:
                  "Unable to submit the SBOM to the Dependency-Track server",
                details: errorMessages,
              }),
            );
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (responseBomJson) {
        if (
          typeof responseBomJson === "string" ||
          responseBomJson instanceof String
        ) {
          res.write(responseBomJson);
        } else {
          res.write(JSON.stringify(responseBomJson, null, null));
        }
      }
      res.end("\n");
    } catch (err) {
      if (!res.headersSent) {
        console.log("Unable to generate SBOM", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: "Unable to generate SBOM",
            details: "Unexpected server error while generating SBOM.",
          }),
        );
      }
      console.log("Error while generating SBOM response", err);
    } finally {
      if (cleanup && cloneDir) {
        cleanupSourceDir(cloneDir);
      }
    }
  });
};

export { configureServer, start };
