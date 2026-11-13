import http from "node:http";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

import bodyParser from "body-parser";
import compression from "compression";
import connect from "connect";

import { validateSpecVersion } from "../cli/cliOptions.js";
import { createBom, submitBom } from "../cli/index.js";
import {
  isAllowedHttpHost,
  isSecureMode,
  readEnvironmentVariable,
} from "../core/activity.js";
import { HOST_SCOPE_PROJECT_TYPES, PROJECT_TYPE_ALIASES } from "../core/env.js";
import { safeExistsSync } from "../core/fs.js";
import {
  boundUntrustedGlobPatterns,
  UNTRUSTED_GLOB_EXPANSION_BUDGET,
  UNTRUSTED_GLOB_PATTERN_MAX_LENGTH,
} from "../core/globPatterns.js";
import { isWin } from "../core/paths.js";
import { isSecureModeActive } from "../core/projectTooling.js";
import { resetRunState } from "../core/runState.js";
import { CDXGEN_VERSION } from "../core/state.js";
import { installConsoleShim, ui } from "../core/ui.js";
import { fetchPomXmlAsJson } from "../ecosystems/ecosystems.js";
import { normalizeOutputFormats } from "../helpers/exportUtils.js";
import {
  isCycloneDx20SpecVersion,
  isCycloneDxBom,
} from "../inventory/bomUtils.js";
import { DEPENDENCY_TRACK_CDX20_ERROR } from "../inventory/cyclonedx20.js";
import {
  cleanupSourceDir,
  findGitRefForPurlVersion,
  getGitAllowProtocol,
  gitClone,
  isAllowedPath,
  isAllowedRealPath,
  isAllowedWinPath,
  maybePurlSource,
  maybeRemotePath,
  PURL_REGISTRY_LOOKUP_WARNING,
  resolveGitUrlFromPurl,
  resolvePurlSourceDirectory,
  sanitizeRemoteUrlForLogs,
  validateAndRejectGitSource,
  validatePurlSource,
} from "../inventory/source.js";
import { executeOsQuery } from "../managers/binary.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { convertCycloneDxToSpdx } from "../stages/postgen/spdxConverter.js";

// Timeout milliseconds. Default 10 mins
const TIMEOUT_MS =
  Number.parseInt(readEnvironmentVariable("CDXGEN_SERVER_TIMEOUT_MS"), 10) ||
  10 * 60 * 1000;

// Longest local path a request may name. Linux allows 4096 bytes.
const MAX_LOCAL_PATH_LENGTH = 4096;

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

// Options that install packages or run the scanned project's own build tools
// (for example `cargo check`, which runs build.rs), and so execute code from
// the scanned repository.
const CODE_EXECUTION_PARAMS = ["installDeps", "deep"];

const app = connect();

export { isAllowedHttpHost };

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
  const operatorOptions = { ...options };
  // Priority is query params followed by body
  for (const param of ALLOWED_PARAMS) {
    const raw = q[param] ?? body[param];
    if (raw !== undefined && raw !== null) {
      options[param] = parseValue(raw);
    }
  }
  options.projectType = toProjectTypeList(options.type);
  delete options.type;
  if (options.lifecycle === "pre-build") {
    options.installDeps = false;
  }
  if (options.profile) {
    applyProfileOptions(options);
  }
  // failOnError ends the process, so one failing request would stop the server
  // for every client.
  options.failOnError = false;
  // With formulation on, includeCrypto also inventories the crypto packages,
  // certificates and keys of the host the server runs on. Like the host-scope
  // project types, that ignores the scan path, so only the operator's own
  // --include-crypto asks for it.
  options.hostCryptoInventory = operatorOptions.includeCrypto === true;
  restrictRequestOptions(options, operatorOptions);
  // A C/C++ scan maps the headers it finds to the development packages
  // installed on this host, which describes the server rather than the scan
  // path, so like the host-scope types it needs a C/C++ start-up type.
  options.hostDevPackages = (
    toProjectTypeList(operatorOptions.type ?? operatorOptions.projectType) || []
  ).some((t) => PROJECT_TYPE_ALIASES.c.includes(t));
  return options;
}

/**
 * Normalise a `type` value from the request or the start-up options, which may
 * be a comma separated string or an array, into a list of project types.
 * Types are lower-cased so that the host-scope refusal below, the operator's
 * own type list and the BOM builders (some of which lower-case the type before
 * matching it, such as the HBOM dispatch) all see the same spelling.
 *
 * @param {string|string[]|undefined} type Project type value
 * @returns {string[]|undefined} Project types, or undefined when none are given
 */
function toProjectTypeList(type) {
  if (type === undefined || type === null || type === "") {
    return undefined;
  }
  const types = (Array.isArray(type) ? type : [type])
    .flatMap((t) => String(t).split(","))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return types.length ? types : undefined;
}

/**
 * Stop a request from turning on options that execute code from the scanned
 * repository when the operator has not. In secure mode, or when the server was
 * started with --no-install-deps, a request may turn these options off but
 * never on.
 *
 * @param {Object} options Options parsed from the request
 * @param {Object} operatorOptions Options the server was started with
 * @returns {void}
 */
function restrictRequestOptions(options, operatorOptions) {
  if (!isSecureModeActive() && operatorOptions.installDeps !== false) {
    return;
  }
  for (const param of CODE_EXECUTION_PARAMS) {
    // Only an explicit false from the request changes the operator's choice.
    // Values such as "" or 0 would otherwise pass gates that test `!== false`.
    options[param] =
      operatorOptions[param] === true && options[param] !== false;
  }
}

/**
 * Check request options that the server must refuse outright.
 *
 * @param {Object} reqOptions Options parsed from the request
 * @param {Object} operatorOptions Options the server was started with
 * @returns {Object|null} Error object with status, error and details, or null
 */
export function validateRequestOptions(reqOptions, operatorOptions = {}) {
  const operatorTypes = new Set(
    toProjectTypeList(operatorOptions.type ?? operatorOptions.projectType) ||
      [],
  );
  const hostScopeType = (reqOptions.projectType || []).find(
    (t) => HOST_SCOPE_PROJECT_TYPES.has(t) && !operatorTypes.has(t),
  );
  if (hostScopeType) {
    return {
      status: 403,
      error: "Project Type Not Allowed",
      details: `The '${hostScopeType}' project type scans the server host. Start the server with this type to allow it.`,
    };
  }
  // Every exclude pattern is matched against every file the scan walks, and
  // brace patterns expand before matching, so one short pattern such as
  // {1..100000}, or a long enough list, can keep the server busy for minutes.
  if (
    reqOptions.exclude !== operatorOptions.exclude &&
    boundUntrustedGlobPatterns(reqOptions.exclude, { allowBraces: false })
      .refused.length
  ) {
    return {
      status: 400,
      error: "Invalid Exclude Pattern",
      details: `Exclude patterns sent to the server cannot use braces, exceed ${UNTRUSTED_GLOB_PATTERN_MAX_LENGTH} characters, or number more than ${UNTRUSTED_GLOB_EXPANSION_BUDGET}.`,
    };
  }
  if (
    reqOptions.serverUrl &&
    reqOptions.serverUrl !== operatorOptions.serverUrl
  ) {
    const requestedOrigin = urlOrigin(reqOptions.serverUrl);
    if (!requestedOrigin) {
      return {
        status: 400,
        error: "Invalid Server URL",
        details: "The Dependency-Track server URL is invalid.",
      };
    }
    if (requestedOrigin !== urlOrigin(operatorOptions.serverUrl)) {
      // The operator's API key only ever goes to the operator's server.
      if (
        operatorOptions.apiKey &&
        reqOptions.apiKey === operatorOptions.apiKey
      ) {
        return {
          status: 400,
          error: "API Key Required",
          details:
            "A request that names its own Dependency-Track server must send its own API key.",
        };
      }
      // CDXGEN_SERVER_ALLOWED_HOSTS only covers git hosts, so in secure mode a
      // server the operator did not configure must be on CDXGEN_ALLOWED_HOSTS.
      if (isSecureMode && !readEnvironmentVariable("CDXGEN_ALLOWED_HOSTS")) {
        return {
          status: 403,
          error: "Host Not Allowed",
          details:
            "Set CDXGEN_ALLOWED_HOSTS to let requests choose a Dependency-Track server.",
        };
      }
    }
  }
  if (isSecureMode && reqOptions.includeFormulation && reqOptions.serverUrl) {
    return {
      status: 400,
      error: "Formulation Not Allowed",
      details:
        "Formulation data may contain secrets and is not submitted to Dependency-Track in secure mode.",
    };
  }
  // Dependency-Track ingests CycloneDX 1.x only, so a request that would
  // upload (server URL plus API key) cannot ask for the 2.0 draft.
  if (
    reqOptions.serverUrl &&
    reqOptions.apiKey &&
    isCycloneDx20SpecVersion(reqOptions.specVersion)
  ) {
    return {
      status: 400,
      error: "Unsupported Spec Version For Dependency-Track",
      details: DEPENDENCY_TRACK_CDX20_ERROR,
    };
  }
  return null;
}

function urlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch (_err) {
    return undefined;
  }
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

/**
 * Serialize the BOM response body before any status line is written, so a
 * failure (for example a BOM larger than the maximum string length) can still
 * be answered with an error status.
 *
 * @param {Object|string|undefined} responseBomJson BOM object or pre-rendered string
 * @returns {string|undefined} Serialized body, an empty string when there is no
 *   BOM, or undefined when serialization fails
 */
export function serializeBomResponse(responseBomJson) {
  if (!responseBomJson) {
    return "";
  }
  if (
    typeof responseBomJson === "string" ||
    responseBomJson instanceof String
  ) {
    return String(responseBomJson);
  }
  try {
    return JSON.stringify(responseBomJson, null, null);
  } catch (err) {
    console.log("Unable to serialize the SBOM response", err?.message);
    return undefined;
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

/**
 * Configure timeout and keepAlive values on the cdxgen HTTP server.
 *
 * @param {import("node:http").Server} cdxgenServer HTTP server instance to configure
 * @returns {void}
 */
const configureServer = (cdxgenServer) => {
  cdxgenServer.headersTimeout = TIMEOUT_MS;
  cdxgenServer.requestTimeout = TIMEOUT_MS;
  cdxgenServer.timeout = 0;
  cdxgenServer.keepAliveTimeout = 0;
};

const ALL_INTERFACES = new Set(["0.0.0.0", "::", "::/128", "::/0"]);

// Registry answers, recorded misses and local cache lookups last for one scan.
// They are emptied whenever no scan is running, so a scan neither starts from
// an earlier scan's answers, which would hide new releases and new downloads,
// nor has its own emptied by a scan running alongside it.
let activeScans = 0;

function beginScan() {
  if (activeScans === 0) {
    resetRunState();
  }
  activeScans++;
}

function endScan() {
  activeScans--;
  if (activeScans === 0) {
    resetRunState();
  }
}

/**
 * Boot the cdxgen HTTP server.
 *
 * Performs startup security checks (secure mode, host exposure, privileged
 * ports), validates the configured port, registers routes, and begins
 * listening for BOM generation requests.
 *
 * @param {object} options CLI options including `serverHost` and `serverPort`
 * @returns {void}
 */
const start = (options) => {
  // Server mode forces non-interactive NDJSON diagnostics process-wide: a
  // daemon started from a terminal has a TTY stderr, but concurrent requests
  // must never each animate a spinner, and stdout must carry only HTTP bodies.
  ui.configure({ interactive: false, color: false, format: "json" });
  installConsoleShim(ui);
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
    readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true"
  ) {
    console.log("Running cdxgen server as root is a security risk!");
    if (isSecureMode) {
      process.exit(1);
    }
  }
  if (
    !readEnvironmentVariable("CDXGEN_GIT_ALLOWED_HOSTS") &&
    !readEnvironmentVariable("CDXGEN_SERVER_ALLOWED_HOSTS")
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
    !readEnvironmentVariable("CDXGEN_ALLOWED_PATHS") &&
    !readEnvironmentVariable("CDXGEN_SERVER_ALLOWED_PATHS")
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
    const optionsError = validateRequestOptions(reqOptions, options);
    if (optionsError) {
      res.writeHead(optionsError.status, {
        "Content-Type": "application/json",
      });
      return res.end(
        JSON.stringify({
          error: optionsError.error,
          details: optionsError.details,
        }),
      );
    }
    // Enforce the v13 CycloneDX spec floor on the HTTP entry point too, so the
    // server cannot be used to request a generation target the CLI rejects.
    if (reqOptions.specVersion !== undefined) {
      const specVersionError = validateSpecVersion(
        reqOptions.specVersion,
        "cdxgen server",
      );
      if (specVersionError) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: specVersionError }));
      }
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
    beginScan();
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
        purlResolution = await resolveGitUrlFromPurl(sourcePath, {
          fetchPomXmlAsJson,
        });
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
        try {
          cloneDir = gitClone(sourcePath, gitRef);
        } catch (_err) {
          console.log("Unable to clone repository. See the server log.");
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: "Unable to clone repository",
              details: "Cloning the repository failed. See the server log.",
            }),
          );
        }
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
        // The allowlist checks and the file discovery of the scan cost time
        // and memory that grow faster than the number of path segments, so a
        // path longer than any the platform accepts is refused first.
        if (
          typeof srcDir === "string" &&
          srcDir.length > MAX_LOCAL_PATH_LENGTH
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: "Path Too Long",
              details: `The path is longer than ${MAX_LOCAL_PATH_LENGTH} characters.`,
            }),
          );
        }
        // Check where a symlinked path really points as well, so a link inside
        // an allowed directory cannot open a scan of a directory outside it.
        if (
          !isAllowedPath(path.resolve(srcDir)) ||
          !isAllowedRealPath(srcDir) ||
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
        // Checked after the allowlist, so the answer says nothing about
        // paths outside it.
        if (!safeExistsSync(srcDir)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              error: "Path Not Found",
              details: "The path does not exist on the server.",
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
      // AI provenance/oversight detection is opt-in via `-t ai-provenance`; the
      // detected properties are written to the BOM document root BEFORE
      // post-processing so the annotation summary can reference them.
      const isAiProvenanceGeneration =
        Array.isArray(reqOptions.projectType) &&
        reqOptions.projectType.some((t) =>
          ["ai-provenance", "ai-authorship", "aicode", "ai-codegen"].includes(
            t,
          ),
        );
      if (isAiProvenanceGeneration && bomNSData?.bomJson) {
        const { ensureAiProvenanceProperties, ensureAiOversightProperties } =
          await import("../stages/postgen/auditBom.js");
        ensureAiProvenanceProperties(bomNSData.bomJson, reqOptions);
        await ensureAiOversightProperties(bomNSData.bomJson, reqOptions);
      }
      bomNSData = await postProcess(
        bomNSData,
        { ...reqOptions, executeOsQuery },
        srcDir,
      );
      const requestedFormats = normalizeOutputFormats(reqOptions.format);
      let responseBomJson = bomNSData.bomJson;
      if (
        requestedFormats.includes("spdx") &&
        isCycloneDxBom(bomNSData?.bomJson)
      ) {
        // The SPDX converter reads the 1.x shape; at 2.0 that is the
        // internal model rather than the rendered document.
        responseBomJson = convertCycloneDxToSpdx(
          bomNSData.internalBomJson ?? bomNSData.bomJson,
          reqOptions,
        );
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
      const responseBody = serializeBomResponse(responseBomJson);
      if (responseBody === undefined) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            error: "Unable to serialize SBOM",
            details: "The generated SBOM could not be serialized.",
          }),
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(`${responseBody}\n`);
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
      res.destroy();
    } finally {
      endScan();
      if (cleanup && cloneDir) {
        cleanupSourceDir(cloneDir);
      }
    }
  });
};

export { configureServer, start };
