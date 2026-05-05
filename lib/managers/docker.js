import { Buffer } from "node:buffer";
import {
  createReadStream,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { platform as _platform, userInfo as _userInfo, homedir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";
import process from "node:process";
import stream from "node:stream/promises";
import { URL } from "node:url";

import got from "got";
import { x } from "tar";

import {
  DEBUG_MODE,
  extractPathEnv,
  getAllFiles,
  getTmpDir,
  isDryRun,
  readEnvironmentVariable,
  recordActivity,
  recordDecisionActivity,
  recordSensitiveFileRead,
  safeExistsSync,
  safeExtractArchive,
  safeMkdirSync,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
  safeWriteSync,
} from "../helpers/utils.js";
import { getDirs, getOnlyDirs } from "./containerutils.js";

export const isWin = _platform() === "win32";
export const DOCKER_HUB_REGISTRY = "docker.io";
// Docker commonly stores Hub credentials under index.docker.io or
// registry-1.docker.io while pulls target docker.io.
const DOCKER_HUB_REGISTRY_ALIASES = new Set([
  DOCKER_HUB_REGISTRY,
  "index.docker.io",
  "registry-1.docker.io",
]);

/**
 * Encode a value as base64url (RFC 4648 §5) with padding.
 * Docker Engine decodes X-Registry-Auth with Go's base64.URLEncoding,
 * which uses the URL-safe alphabet (-_ instead of +/) and expects = padding.
 * Node's "base64url" omits padding, so we convert from standard base64.
 */
const toBase64Url = (value) =>
  Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

const normalizeRegistryPath = (registryPath) => {
  if (!registryPath || registryPath === "/") {
    return "";
  }
  let normalizedPath = registryPath.trim();
  if (!normalizedPath.startsWith("/")) {
    normalizedPath = `/${normalizedPath}`;
  }
  while (normalizedPath.endsWith("/")) {
    normalizedPath = normalizedPath.slice(0, -1);
  }
  const lowerCasePath = normalizedPath.toLowerCase();
  if (lowerCasePath.endsWith("/v1") || lowerCasePath.endsWith("/v2")) {
    normalizedPath = normalizedPath.slice(0, -3);
  }
  return normalizedPath === "/" ? "" : normalizedPath;
};

const buildRegistryAuthority = (hostname, port) => {
  if (!hostname) {
    return undefined;
  }
  hostname = hostname.toLowerCase();
  if (hostname.includes(":") && !hostname.startsWith("[")) {
    hostname = `[${hostname}]`;
  }
  if (port) {
    return `${hostname}:${port}`;
  }
  return hostname;
};

const parseRawRegistryAuthority = (authority) => {
  if (!authority?.trim()) {
    return undefined;
  }
  authority = authority.trim();
  if (authority.startsWith("[")) {
    const closingBracketIndex = authority.indexOf("]");
    if (closingBracketIndex === -1) {
      return undefined;
    }
    const hostname = authority.slice(0, closingBracketIndex + 1);
    const portSuffix = authority.slice(closingBracketIndex + 1);
    if (!portSuffix) {
      return buildRegistryAuthority(hostname);
    }
    if (!/^:\d+$/.test(portSuffix)) {
      return undefined;
    }
    return buildRegistryAuthority(hostname, portSuffix.slice(1));
  }
  const colonIndex = authority.lastIndexOf(":");
  if (colonIndex > -1 && authority.indexOf(":") === colonIndex) {
    const portCandidate = authority.slice(colonIndex + 1);
    if (/^\d+$/.test(portCandidate)) {
      return buildRegistryAuthority(
        authority.slice(0, colonIndex),
        portCandidate,
      );
    }
  }
  return buildRegistryAuthority(authority);
};

const parseRegistryReference = (registry) => {
  if (!registry?.trim()) {
    return undefined;
  }
  registry = registry.trim();
  if (registry.includes("://")) {
    if (!URL.canParse(registry)) {
      return undefined;
    }
    const registryUrl = new URL(registry);
    const authoritySource = registry
      .slice(registry.indexOf("://") + 3)
      .split("/")[0];
    return {
      authority: parseRawRegistryAuthority(authoritySource),
      path: normalizeRegistryPath(registryUrl.pathname),
    };
  }
  const slashIndex = registry.indexOf("/");
  const authority =
    slashIndex === -1 ? registry : registry.slice(0, slashIndex);
  const registryPath = slashIndex === -1 ? "" : registry.slice(slashIndex);
  if (!authority) {
    return undefined;
  }
  try {
    // Raw registry references such as host:port are not absolute URLs, so we
    // add an https scheme only to parse the authority and optional port.
    return {
      authority: parseRawRegistryAuthority(authority),
      path: normalizeRegistryPath(registryPath),
    };
  } catch (_err) {
    return undefined;
  }
};

const looksLikeImageReference = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  value = value.trim();
  if (value.includes("://")) {
    return false;
  }
  if (!value.includes("/")) {
    if (value.includes(":")) {
      const tagOrPortSuffix = value.slice(value.lastIndexOf(":") + 1);
      if (!/^\d+$/.test(tagOrPortSuffix)) {
        return true;
      }
      return !parseRegistryReference(value)?.authority;
    }
    return !(
      value.includes(".") ||
      value === "localhost" ||
      value.startsWith("[")
    );
  }
  const firstSegment = value.split("/")[0];
  return !(
    parseRegistryReference(firstSegment)?.authority &&
    (firstSegment.includes(".") ||
      firstSegment.includes(":") ||
      firstSegment === "localhost" ||
      firstSegment.startsWith("["))
  );
};

const resolveRequestedRegistryRef = (forRegistry, requestedRegistryRef) => {
  const fallbackRegistry =
    forRegistry || process.env.DOCKER_SERVER_ADDRESS || DOCKER_HUB_REGISTRY;
  if (
    typeof requestedRegistryRef !== "string" ||
    !requestedRegistryRef.trim()
  ) {
    return fallbackRegistry;
  }
  requestedRegistryRef = requestedRegistryRef.trim();
  if (requestedRegistryRef.includes("://")) {
    return requestedRegistryRef;
  }
  return looksLikeImageReference(requestedRegistryRef)
    ? fallbackRegistry
    : requestedRegistryRef;
};

const extractRequestedRegistryRefFromPath = (path, forRegistry) => {
  if (!path?.includes("?")) {
    return resolveRequestedRegistryRef(forRegistry, forRegistry);
  }
  const queryString = path.slice(path.indexOf("?") + 1);
  const requestedImageRef = new URLSearchParams(queryString).get("fromImage");
  return resolveRequestedRegistryRef(
    forRegistry,
    requestedImageRef || forRegistry,
  );
};

const normalizeRegistryReference = (registry) => {
  const parsedRegistry = parseRegistryReference(registry);
  if (!parsedRegistry?.authority) {
    return undefined;
  }
  return parsedRegistry.path
    ? `${parsedRegistry.authority}${parsedRegistry.path}`
    : parsedRegistry.authority;
};

const registriesMatch = (configuredRegistry, requestedRegistry) => {
  if (!requestedRegistry) {
    return false;
  }
  const normalizedConfiguredRegistry =
    parseRegistryReference(configuredRegistry);
  const normalizedRequestedRegistry = parseRegistryReference(requestedRegistry);
  if (
    !normalizedConfiguredRegistry?.authority ||
    !normalizedRequestedRegistry?.authority
  ) {
    return false;
  }
  const hostMatches =
    normalizedConfiguredRegistry.authority ===
      normalizedRequestedRegistry.authority ||
    (DOCKER_HUB_REGISTRY_ALIASES.has(normalizedConfiguredRegistry.authority) &&
      DOCKER_HUB_REGISTRY_ALIASES.has(normalizedRequestedRegistry.authority));
  if (!hostMatches) {
    return false;
  }
  if (!normalizedConfiguredRegistry.path) {
    return true;
  }
  return (
    normalizedConfiguredRegistry.path === normalizedRequestedRegistry.path ||
    normalizedRequestedRegistry.path.startsWith(
      `${normalizedConfiguredRegistry.path}/`,
    )
  );
};

// Should we extract the tar image in non-strict mode
const NON_STRICT_TAR_EXTRACT = ["true", "1"].includes(
  process?.env?.NON_STRICT_TAR_EXTRACT,
);
if (NON_STRICT_TAR_EXTRACT) {
  console.log(
    "Warning: Extracting container images and tar files in non-strict mode could lead to security risks!",
  );
}

let dockerConn;
let isPodman = false;
let isPodmanRootless = true;
let isDockerRootless = false;
// https://github.com/containerd/containerd
let isContainerd = !!process.env.CONTAINERD_ADDRESS;
const WIN_LOCAL_TLS = "http://localhost:2375";
let isWinLocalTLS = false;
let isNerdctl;
let isColima;

if (
  !process.env.DOCKER_HOST &&
  (process.env.CONTAINERD_ADDRESS ||
    (process.env.XDG_RUNTIME_DIR &&
      safeExistsSync(
        join(process.env.XDG_RUNTIME_DIR, "containerd-rootless", "api.sock"),
      )))
) {
  isContainerd = true;
}

/**
 * Strip absolute path prefixes from a path string, handling both Unix and
 * Windows paths (including UNC and extended-length paths such as //?/C:/).
 * Taken from https://github.com/isaacs/node-tar/blob/main/src/strip-absolute-path.ts
 *
 * @param {string} path The path to strip
 * @returns {string} The path with its absolute root removed
 */
export const stripAbsolutePath = (path) => {
  // This appears to be a most frequent case, so let's return quickly.
  if (path === "/") {
    return "";
  }
  let parsed = win32.parse(path);
  while (win32.isAbsolute(path) || parsed.root) {
    // windows will think that //x/y/z has a "root" of //x/y/
    // but strip the //?/C:/ off of //?/C:/path
    const root =
      path.charAt(0) === "/" && path.slice(0, 4) !== "//?/" ? "/" : parsed.root;
    path = path.slice(root.length);
    parsed = win32.parse(path);
  }
  return path;
};

/**
 * Detect colima
 */
export function detectColima() {
  if (isColima) {
    return true;
  }
  if (_platform() === "darwin") {
    const result = safeSpawnSync("colima", ["version"]);
    if (result.status !== 0 || result.error) {
      return false;
    }
    if (result?.stdout?.includes("colima version")) {
      isColima = true;
      console.log(
        "Colima is known to have issues with volume mounts, which might result in incomplete BOM. Use it with caution!",
      );
      if (result?.stdout?.includes("runtime: containerd")) {
        isNerdctl = true;
      }
    }
  }
  return isColima;
}

/**
 * Detect if Rancher desktop is running on a mac.
 */
export function detectRancherDesktop() {
  // Detect Rancher desktop and nerdctl on a mac
  if (_platform() === "darwin") {
    const limaHome = join(
      homedir(),
      "Library",
      "Application Support",
      "rancher-desktop",
      "lima",
    );
    const limactl = join(
      "/Applications",
      "Rancher Desktop.app",
      "Contents",
      "Resources",
      "resources",
      "darwin",
      "lima",
      "bin",
      "limactl",
    );
    // Is Rancher Desktop running
    if (safeExistsSync(limactl) || safeExistsSync(limaHome)) {
      const result = safeSpawnSync("rdctl", ["list-settings"]);
      if (result.status !== 0 || result.error) {
        if (
          isNerdctl === undefined &&
          result.stderr?.includes("connection refused")
        ) {
          console.warn(
            "Ensure Rancher Desktop is running prior to invoking cdxgen. To start from the command line, type the command 'rdctl start'",
          );
          isNerdctl = false;
        }
      } else {
        if (DEBUG_MODE) {
          console.log("Rancher Desktop found!");
        }
        isNerdctl = true;
      }
    }
  }
  return isNerdctl;
}

// Cache the registry auth keys
const registry_auth_keys = {};
const REQUEST_TIMEOUT_SECS = 60000;
/**
 * Build a `got` options object for Docker / registry API requests. Resolves
 * authentication headers by consulting (in order) the DOCKER_AUTH_CONFIG
 * environment variable, DOCKER_USER/DOCKER_PASSWORD/DOCKER_EMAIL environment
 * variables, hardcoded tokens in ~/.docker/config.json, credential helpers
 * listed in credHelpers/credsStore, and finally TLS certificate files pointed
 * to by DOCKER_CERT_PATH.
 *
 * @param {string} [forRegistry] Registry hostname (e.g. "registry-1.docker.io").
 *   Defaults to DOCKER_SERVER_ADDRESS env var or "docker.io".
 * @param {string} [requestedRegistryRef] Requested registry/image reference used
 *   to scope config.json auth matching. Unqualified images default to Docker Hub.
 * @returns {Object} Options object suitable for passing to `got`
 */
const getDefaultOptions = (forRegistry, requestedRegistryRef = forRegistry) => {
  let authTokenSet = false;
  const credentialSourceEvaluations = [];
  let selectedCredentialSource;
  const noteCredentialSource = (source, outcome, detail = undefined) => {
    credentialSourceEvaluations.push({
      detail,
      outcome,
      source,
    });
    if (outcome === "selected") {
      selectedCredentialSource = source;
    }
  };
  const dockerServerAddress = readEnvironmentVariable("DOCKER_SERVER_ADDRESS");
  const dockerConfig = readEnvironmentVariable("DOCKER_CONFIG");
  const dockerAuthConfig = readEnvironmentVariable("DOCKER_AUTH_CONFIG", {
    sensitive: true,
  });
  const dockerUser = readEnvironmentVariable("DOCKER_USER", {
    sensitive: true,
  });
  const dockerPassword = readEnvironmentVariable("DOCKER_PASSWORD", {
    sensitive: true,
  });
  const dockerEmail = readEnvironmentVariable("DOCKER_EMAIL", {
    sensitive: true,
  });
  if (!forRegistry) {
    forRegistry = dockerServerAddress ?? DOCKER_HUB_REGISTRY;
  }
  requestedRegistryRef = resolveRequestedRegistryRef(
    forRegistry,
    requestedRegistryRef,
  );
  const normalizedForRegistry =
    parseRegistryReference(forRegistry)?.authority ?? forRegistry;
  const authDecisionTarget =
    requestedRegistryRef ||
    normalizedForRegistry ||
    forRegistry ||
    DOCKER_HUB_REGISTRY;
  const opts = {
    enableUnixSockets: true,
    throwHttpErrors: true,
    method: "GET",
    timeout: {
      request: REQUEST_TIMEOUT_SECS,
      socket: REQUEST_TIMEOUT_SECS,
    },
    retry: {
      limit: 3,
      methods: ["GET", "POST", "HEAD"],
      statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
    },
    hooks: { beforeError: [] },
    mutableDefaults: true,
  };
  const DOCKER_CONFIG = dockerConfig || join(homedir(), ".docker");
  const dockerConfigFile = join(DOCKER_CONFIG, "config.json");
  // Support for private registry
  if (dockerAuthConfig) {
    opts.headers = {
      "X-Registry-Auth": dockerAuthConfig,
    };
    authTokenSet = true;
    noteCredentialSource("DOCKER_AUTH_CONFIG", "selected");
  } else {
    noteCredentialSource("DOCKER_AUTH_CONFIG", "skipped", "not set");
  }
  if (
    !authTokenSet &&
    dockerUser &&
    dockerPassword &&
    dockerEmail &&
    normalizedForRegistry
  ) {
    const authPayload = {
      username: dockerUser,
      email: dockerEmail,
      serveraddress: normalizedForRegistry,
    };
    if (dockerUser === "<token>") {
      authPayload.IdentityToken = dockerPassword;
    } else {
      authPayload.password = dockerPassword;
    }
    opts.headers = {
      "X-Registry-Auth": toBase64Url(JSON.stringify(authPayload)),
    };
    authTokenSet = true;
    noteCredentialSource(
      "DOCKER_USER/DOCKER_PASSWORD/DOCKER_EMAIL",
      "selected",
    );
  } else if (!authTokenSet) {
    noteCredentialSource(
      "DOCKER_USER/DOCKER_PASSWORD/DOCKER_EMAIL",
      "skipped",
      dockerUser || dockerPassword || dockerEmail
        ? "incomplete environment credentials"
        : "not set",
    );
  }
  if (!authTokenSet && safeExistsSync(dockerConfigFile)) {
    const configData = readFileSync(dockerConfigFile, "utf-8");
    recordSensitiveFileRead(dockerConfigFile, {
      label: "Docker credential file",
    });
    if (configData) {
      try {
        const configJson = JSON.parse(configData);
        if (configJson.auths) {
          // Check if there are hardcoded tokens
          for (const serverAddress of Object.keys(configJson.auths)) {
            if (!registriesMatch(serverAddress, requestedRegistryRef)) {
              continue;
            }
            if (configJson.auths[serverAddress].auth) {
              // The Docker config stores auth as base64("user:pass").
              // The X-Registry-Auth header expects base64-encoded JSON.
              const decoded = Buffer.from(
                configJson.auths[serverAddress].auth,
                "base64",
              ).toString();
              const sepIdx = decoded.indexOf(":");
              const authPayload = {
                username: decoded.substring(0, sepIdx),
                password: decoded.substring(sepIdx + 1),
                serveraddress: serverAddress,
              };
              opts.headers = {
                "X-Registry-Auth": toBase64Url(JSON.stringify(authPayload)),
              };
              authTokenSet = true;
              noteCredentialSource(
                "docker-config-auth",
                "selected",
                serverAddress,
              );
              break;
            }
            if (configJson.credsStore) {
              const helperAuthToken = getCredsFromHelper(
                configJson.credsStore,
                serverAddress,
              );
              if (helperAuthToken) {
                opts.headers = {
                  "X-Registry-Auth": helperAuthToken,
                };
                authTokenSet = true;
                noteCredentialSource(
                  `docker-credential-helper:${configJson.credsStore}`,
                  "selected",
                  serverAddress,
                );
                break;
              }
            }
          }
        } else if (configJson.credHelpers) {
          // Support for credential helpers
          for (const serverAddress of Object.keys(configJson.credHelpers)) {
            if (!registriesMatch(serverAddress, requestedRegistryRef)) {
              continue;
            }
            if (configJson.credHelpers[serverAddress]) {
              const helperAuthToken = getCredsFromHelper(
                configJson.credHelpers[serverAddress],
                serverAddress,
              );
              if (helperAuthToken) {
                opts.headers = {
                  "X-Registry-Auth": helperAuthToken,
                };
                authTokenSet = true;
                noteCredentialSource(
                  `docker-credential-helper:${configJson.credHelpers[serverAddress]}`,
                  "selected",
                  serverAddress,
                );
                break;
              }
            }
          }
        }
        if (!authTokenSet) {
          noteCredentialSource(
            "docker-config",
            "skipped",
            "no matching config.json auth entry",
          );
        }
      } catch (_err) {
        // pass
        noteCredentialSource("docker-config", "skipped", "config parse failed");
      }
    }
  } else if (!authTokenSet) {
    noteCredentialSource("docker-config", "skipped", "config.json not found");
  }
  const userInfo = _userInfo();
  opts.podmanPrefixUrl = isWin ? "" : "http://unix:/run/podman/podman.sock:";
  opts.podmanRootlessPrefixUrl = isWin
    ? ""
    : `http://unix:/run/user/${userInfo.uid}/podman/podman.sock:`;
  const dockerHost = readEnvironmentVariable("DOCKER_HOST");
  const dockerCertPath = readEnvironmentVariable("DOCKER_CERT_PATH");
  const dockerTlsVerify = readEnvironmentVariable("DOCKER_TLS_VERIFY");
  if (!dockerHost) {
    if (isPodman) {
      opts.prefixUrl = isPodmanRootless
        ? opts.podmanRootlessPrefixUrl
        : opts.podmanPrefixUrl;
    } else {
      if (isWinLocalTLS) {
        opts.prefixUrl = WIN_LOCAL_TLS;
      } else {
        // Named pipes syntax for Windows doesn't work with got
        // See: https://github.com/sindresorhus/got/issues/2178
        /*
        opts.prefixUrl = isWin
          ? "npipe//./pipe/docker_engine:"
          : "unix:/var/run/docker.sock:";
        */
        opts.prefixUrl = isWin
          ? WIN_LOCAL_TLS
          : isDockerRootless
            ? `http://unix:${homedir()}/.docker/run/docker.sock:`
            : "http://unix:/var/run/docker.sock:";
      }
    }
  } else {
    let hostStr = dockerHost;
    if (hostStr.startsWith("unix:///")) {
      hostStr = hostStr.replace("unix:///", "http://unix:/");
      if (hostStr.includes("docker.sock")) {
        hostStr = hostStr.replace("docker.sock", "docker.sock:");
        isDockerRootless = true;
      }
    }
    opts.prefixUrl = hostStr;
    if (dockerCertPath) {
      const dockerCertFile = join(dockerCertPath, "cert.pem");
      const dockerKeyFile = join(dockerCertPath, "key.pem");
      const dockerCertificate = readFileSync(dockerCertFile, "utf8");
      recordSensitiveFileRead(dockerCertFile, {
        label: "Docker client certificate",
      });
      const dockerKey = readFileSync(dockerKeyFile, "utf8");
      recordSensitiveFileRead(dockerKeyFile, {
        label: "Docker client private key",
      });
      opts.https = {
        certificate: dockerCertificate,
        key: dockerKey,
      };
      // Disable tls on empty values
      // From the docker docs: Setting the DOCKER_TLS_VERIFY environment variable to any value other than the empty string is equivalent to setting the --tlsverify flag
      if (dockerTlsVerify === "") {
        opts.https.rejectUnauthorized = false;
        console.log("TLS Verification disabled for", hostStr);
      }
    }
  }

  if (!selectedCredentialSource) {
    noteCredentialSource(
      "anonymous",
      "selected",
      "no credential source resolved",
    );
  }
  const skippedSources = credentialSourceEvaluations
    .filter((entry) => entry.outcome !== "selected")
    .map((entry) =>
      entry.detail ? `${entry.source} (${entry.detail})` : entry.source,
    );
  recordDecisionActivity(`docker-auth:${authDecisionTarget}`, {
    metadata: {
      decisionType: "credential-source-selection",
      evaluatedSources: credentialSourceEvaluations.map(
        ({ detail, outcome, source }) =>
          detail ? `${source}:${outcome}:${detail}` : `${source}:${outcome}`,
      ),
      selectedSource: selectedCredentialSource,
    },
    reason: `Selected Docker auth source '${selectedCredentialSource}' for ${authDecisionTarget}. Skipped: ${skippedSources.length ? skippedSources.join(", ") : "none"}.`,
  });

  return opts;
};

/**
 * Establish (or reuse) a `got` client connected to the local Docker or Podman
 * daemon. Tries multiple socket / URL candidates in order: the default Docker
 * socket, the rootless Docker socket, the Windows TCP endpoint, the rootless
 * Podman socket, and the root Podman socket. Sets the module-level flags
 * `isPodman`, `isPodmanRootless`, `isDockerRootless`, and `isWinLocalTLS` as a
 * side-effect. Returns `undefined` when containerd / nerdctl is in use or no
 * daemon could be reached.
 *
 * @param {Object} options Additional `got` options to merge into the connection
 * @param {string} [forRegistry] Registry hostname forwarded to `getDefaultOptions`
 * @returns {Promise<import("got").Got|undefined>} A `got` instance bound to the
 *   daemon base URL, or `undefined`
 */
export const getConnection = async (options, forRegistry) => {
  if (isContainerd || isNerdctl) {
    return undefined;
  }
  if (isDryRun) {
    try {
      getDefaultOptions(forRegistry);
    } catch (error) {
      recordActivity({
        kind: "read",
        reason: `Dry run mode failed while tracing Docker credential inputs: ${error.message}`,
        status: "failed",
        target: error?.path || forRegistry || "container-daemon",
      });
    }
    recordActivity({
      kind: "network",
      reason:
        "Dry run mode blocks container daemon and registry HTTP requests.",
      status: "blocked",
      target: forRegistry || "container-daemon",
    });
    return undefined;
  }
  if (!dockerConn) {
    const defaultOptions = getDefaultOptions(forRegistry);
    const podmanRootlessUrl = defaultOptions.podmanRootlessPrefixUrl;
    const podmanRootUrl = defaultOptions.podmanPrefixUrl;
    const opts = Object.assign(
      {},
      {
        enableUnixSockets: defaultOptions.enableUnixSockets,
        throwHttpErrors: defaultOptions.throwHttpErrors,
        method: defaultOptions.method,
        prefixUrl: defaultOptions.prefixUrl,
      },
      options,
    );
    try {
      await got.get("_ping", opts);
      dockerConn = got.extend(opts);
      if (DEBUG_MODE) {
        if (isDockerRootless) {
          console.log("Docker service in rootless mode detected.");
        } else {
          console.log(
            "Docker service in root mode detected. Consider switching to rootless mode to improve security. See https://docs.docker.com/engine/security/rootless/",
          );
        }
      }
    } catch (_err) {
      opts.prefixUrl = `http://unix:${homedir()}/.docker/run/docker.sock:`;
      try {
        await got.get("_ping", opts);
        dockerConn = got.extend(opts);
        isDockerRootless = true;
        if (DEBUG_MODE) {
          console.log("Docker service in rootless mode detected.");
        }
        return dockerConn;
      } catch (_err) {
        // ignore
      }
      try {
        if (isWin) {
          opts.prefixUrl = WIN_LOCAL_TLS;
          await got.get("_ping", opts);
          dockerConn = got.extend(opts);
          isWinLocalTLS = true;
          if (DEBUG_MODE) {
            console.log("Docker desktop on Windows detected.");
          }
        } else {
          opts.prefixUrl = podmanRootlessUrl;
          await got.get("libpod/_ping", opts);
          isPodman = true;
          isPodmanRootless = true;
          dockerConn = got.extend(opts);
          if (DEBUG_MODE) {
            console.log(
              "Podman in rootless mode detected. Thank you for using podman!",
            );
          }
        }
      } catch (_err) {
        try {
          opts.prefixUrl = podmanRootUrl;
          await got.get("libpod/_ping", opts);
          isPodman = true;
          isPodmanRootless = false;
          dockerConn = got.extend(opts);
          console.log(
            "Podman in root mode detected. Consider switching to rootless mode to improve security. See https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md",
          );
        } catch (_err) {
          if (_platform() === "win32") {
            console.warn(
              "Ensure Docker for Desktop is running as an administrator with 'Exposing daemon on TCP without TLS' setting turned on.",
            );
          } else if (_platform() === "darwin" && !isNerdctl) {
            if (detectRancherDesktop() || detectColima()) {
              return undefined;
            }
            if (isNerdctl === undefined) {
              console.warn(
                "Ensure Podman Desktop (open-source) or Docker for Desktop (May require subscription) is running.",
              );
            }
          } else {
            console.warn(
              "Ensure docker/podman service or Docker for Desktop is running.",
            );
            console.log(
              "Check if the post-installation steps were performed correctly as per this documentation https://docs.docker.com/engine/install/linux-postinstall/",
            );
          }
        }
      }
    }
  }
  return dockerConn;
};

/**
 * Send a single HTTP request to the Docker / Podman daemon via the `got`
 * client returned by {@link getConnection}. GET requests are parsed as JSON;
 * all other methods receive a Buffer response body.
 *
 * @param {string} path API path relative to the daemon base URL (e.g. "images/ubuntu:latest/json")
 * @param {string} method HTTP method (e.g. "GET", "POST", "DELETE")
 * @param {string} [forRegistry] Registry hostname forwarded to `getDefaultOptions` for auth headers
 * @returns {Promise<Object|Buffer|undefined>} Parsed JSON object for GET
 *   requests, raw Buffer for other methods, or `undefined` if no client is available
 */
export const makeRequest = async (path, method, forRegistry) => {
  if (isDryRun) {
    recordActivity({
      kind: "network",
      reason:
        "Dry run mode blocks container daemon and registry HTTP requests.",
      status: "blocked",
      target: `${method} ${forRegistry || "container-daemon"}/${path}`,
    });
    return undefined;
  }
  const client = await getConnection({}, forRegistry);
  if (!client) {
    return undefined;
  }
  // Use the client's prefixUrl (set correctly by getConnection for
  // docker/podman). Only pass per-request auth headers and method options.
  const defaultOptions = getDefaultOptions(
    forRegistry,
    extractRequestedRegistryRefFromPath(path, forRegistry),
  );
  const opts = {
    responseType: method === "GET" ? "json" : "buffer",
    resolveBodyOnly: true,
    enableUnixSockets: true,
    throwHttpErrors: true,
    method,
  };
  if (defaultOptions.headers) {
    opts.headers = defaultOptions.headers;
  }
  return await client(path, opts);
};

/**
 * Parse image name
 *
 * docker pull debian
 * docker pull debian:jessie
 * docker pull ubuntu@sha256:45b23dee08af5e43a7fea6c4cf9c25ccf269ee113168c19722f87876677c5cb2
 * docker pull myregistry.local:5000/testing/test-image
 */
export const parseImageName = (fullImageName) => {
  const nameObj = {
    registry: "",
    repo: "",
    tag: "",
    digest: "",
    platform: "",
    group: "",
    name: "",
  };
  if (!fullImageName) {
    return nameObj;
  }
  // ensure it's lowercased
  fullImageName = fullImageName.toLowerCase().trim();

  // Extract platform
  if (fullImageName.startsWith("--platform=")) {
    const tmpName = fullImageName.replace("--platform=", "").split(" ");
    nameObj.platform = tmpName[0];
    fullImageName = tmpName[1];
  }

  // Extract registry name
  if (
    fullImageName.includes("/") &&
    (fullImageName.includes(".") || fullImageName.includes(":"))
  ) {
    let urlObj;
    if (URL.canParse(fullImageName)) {
      urlObj = new URL(fullImageName);
    }
    const tmpA = fullImageName.split("/");
    if (
      (urlObj && urlObj.pathname !== fullImageName) ||
      tmpA[0].includes(".") ||
      tmpA[0].includes(":")
    ) {
      nameObj.registry = tmpA[0];
      fullImageName = fullImageName.replace(`${tmpA[0]}/`, "");
    }
  }

  // Extract digest name
  if (fullImageName.includes("@sha256:")) {
    const tmpA = fullImageName.split("@sha256:");
    if (tmpA.length > 1) {
      nameObj.digest = tmpA[tmpA.length - 1];
      fullImageName = fullImageName.replace(`@sha256:${nameObj.digest}`, "");
    }
  }

  // Extract tag name
  if (fullImageName.includes(":")) {
    const tmpA = fullImageName.split(":");
    if (tmpA.length > 1) {
      nameObj.tag = tmpA[tmpA.length - 1];
      fullImageName = fullImageName.replace(`:${nameObj.tag}`, "");
    }
  }

  // The left over string is the repo name
  nameObj.repo = fullImageName;
  nameObj.name = fullImageName;

  // extract group name
  if (fullImageName.includes("/")) {
    const tmpA = fullImageName.split("/");
    if (tmpA.length > 1) {
      nameObj.name = tmpA[tmpA.length - 1];
      nameObj.group = fullImageName.replace(`/${tmpA[tmpA.length - 1]}`, "");
    }
  }

  return nameObj;
};

/**
 * Prefer cli on windows, nerdctl on mac, or when using tcp/ssh based host.
 *
 * @returns boolean true if we should use the cli. false otherwise
 */
const getContainerCliCmd = () => {
  if (process.env.DOCKER_CMD?.trim()) {
    return process.env.DOCKER_CMD.trim();
  }
  detectRancherDesktop() || detectColima();
  if (isNerdctl) {
    return "nerdctl";
  }
  return "docker";
};

const needsCliFallback = () => {
  if (
    ["true", "1"].includes(process.env.DOCKER_USE_CLI) ||
    process.env.DOCKER_CMD?.trim() ||
    (_platform() === "darwin" && (detectRancherDesktop() || detectColima()))
  ) {
    return true;
  }
  return (
    isWin ||
    (process.env.DOCKER_HOST &&
      (process.env.DOCKER_HOST.startsWith("tcp://") ||
        process.env.DOCKER_HOST.startsWith("ssh://")))
  );
};

/**
 * Method to get image to the local registry by pulling from the remote if required
 */
export const getImage = async (fullImageName) => {
  let localData;
  let pullData;
  const { registry, repo, tag, digest } = parseImageName(fullImageName);
  const repoWithTag =
    registry && registry !== DOCKER_HUB_REGISTRY
      ? fullImageName
      : `${repo}:${tag !== "" ? tag : ":latest"}`;
  // Fetch only the latest tag if none is specified
  if (tag === "" && digest === "") {
    fullImageName = `${fullImageName}:latest`;
  }
  if (isContainerd && !needsCliFallback()) {
    console.log(
      "containerd/nerdctl is currently unsupported. Export the image manually and run cdxgen against the tar image.",
    );
    return undefined;
  }
  if (needsCliFallback()) {
    const dockerCmd = getContainerCliCmd();
    let needsPull = true;
    // Let's check the local cache first
    let result = safeSpawnSync(dockerCmd, ["images", "--format=json"]);
    if (result.status === 0 && result.stdout) {
      for (const imgLine of result.stdout.split("\n")) {
        try {
          const imgObj = JSON.parse(Buffer.from(imgLine).toString());
          if (`${imgObj.Repository}:${imgObj.Tag}` === fullImageName) {
            needsPull = false;
            break;
          }
        } catch (_err) {
          // continue regardless of error
        }
      }
    }
    if (needsPull) {
      result = safeSpawnSync(dockerCmd, ["pull", fullImageName]);
      if (result.status !== 0 || result.error) {
        if (result.stderr?.includes("docker daemon is not running")) {
          console.log(
            "Ensure Docker for Desktop is running as an administrator with 'Exposing daemon on TCP without TLS' setting turned on.",
          );
        } else if (result.stderr?.includes("not found")) {
          console.log(
            "Set the environment variable DOCKER_CMD to use an alternative command such as nerdctl or podman.",
          );
        } else if (result.stderr) {
          console.log(result.stderr);
        }
      }
    }
    result = safeSpawnSync(dockerCmd, ["inspect", fullImageName]);
    if (result.status !== 0 || result.error) {
      if (result.stderr) {
        console.log(result.stderr);
      }
      // Continue with the daemon client when the CLI fallback is unavailable
      // or unable to inspect the image.
    } else {
      try {
        const stdout = result.stdout;
        if (stdout) {
          const inspectData = JSON.parse(Buffer.from(stdout).toString());
          if (inspectData && Array.isArray(inspectData)) {
            return inspectData[0];
          }
          return inspectData;
        }
      } catch (_err) {
        // continue regardless of error
      }
    }
  }
  try {
    localData = await makeRequest(
      `images/${repoWithTag}/json`,
      "GET",
      registry,
    );
    if (localData) {
      return localData;
    }
  } catch (_err) {
    // ignore
  }
  try {
    localData = await makeRequest(`images/${repo}/json`, "GET", registry);
  } catch (_err) {
    try {
      localData = await makeRequest(
        `images/${fullImageName}/json`,
        "GET",
        registry,
      );
      if (localData) {
        return localData;
      }
    } catch (_err) {
      // ignore
    }
    if (DEBUG_MODE) {
      console.log(
        `Trying to pull the image ${fullImageName} from registry. This might take a while ...`,
      );
    }
    // If the data is not available locally
    try {
      pullData = await makeRequest(
        `images/create?fromImage=${fullImageName}`,
        "POST",
        registry,
      );
      if (
        pullData &&
        (pullData.includes("no match for platform in manifest") ||
          pullData.includes("Error choosing an image from manifest list"))
      ) {
        console.warn(
          "You may have to enable experimental settings in docker to support this platform!",
        );
        console.warn(
          "To scan windows images, run cdxgen on a windows server with hyper-v and docker installed. Switch to windows containers in your docker settings.",
        );
        return undefined;
      }
    } catch (_err) {
      try {
        if (DEBUG_MODE) {
          console.log(`Re-trying the pull with the name ${repoWithTag}.`);
        }
        await makeRequest(
          `images/create?fromImage=${repoWithTag}`,
          "POST",
          registry,
        );
      } catch (_err) {
        // continue regardless of error
      }
    }
    try {
      if (DEBUG_MODE) {
        console.log(`Trying with ${repoWithTag}`);
      }
      localData = await makeRequest(
        `images/${repoWithTag}/json`,
        "GET",
        registry,
      );
      if (localData) {
        return localData;
      }
    } catch (_err) {
      try {
        if (DEBUG_MODE) {
          console.log(`Trying with ${repo}`);
        }
        localData = await makeRequest(`images/${repo}/json`, "GET", registry);
        if (localData) {
          return localData;
        }
      } catch (_err) {
        // continue regardless of error
      }
      try {
        if (DEBUG_MODE) {
          console.log(`Trying with ${fullImageName}`);
        }
        localData = await makeRequest(
          `images/${fullImageName}/json`,
          "GET",
          registry,
        );
      } catch (_err) {
        // continue regardless of error
      }
    }
  }
  if (!localData) {
    console.log(
      `Unable to pull ${fullImageName}. Check if the name is valid. Perform any authentication prior to invoking cdxgen.`,
    );
    console.log(
      `Try manually pulling this image using docker pull ${fullImageName}`,
    );
  }
  return localData;
};

/**
 * @typedef {{ path: string }} TarReadEntryLike
 */

/**
 * Warnings such as TAR_ENTRY_INFO are treated as errors in strict mode. While this is mostly desired, we can relax this
 * requirement for one particular warning related to absolute paths.
 * This callback function checks for absolute paths in the entry read from the archive and strips them using a custom
 * method.
 *
 * @param {TarReadEntryLike} entry ReadEntry object from node-tar
 */
function handleAbsolutePath(entry) {
  if (entry.path === "/" || win32.isAbsolute(entry.path)) {
    entry.path = stripAbsolutePath(entry.path);
  }
}

/**
 * Filter out problematic files, paths, and devices during tar extraction.
 */
function tarFilter(path, entry) {
  const name = basename(path);
  if (name.startsWith(".wh.")) {
    return false;
  }
  const ext = win32.extname(name).toLowerCase();
  if (MEDIA_EXTENSIONS.has(ext)) {
    return false;
  }
  return !(
    EXTRACT_EXCLUDE_PATHS.some((p) => path.includes(p)) ||
    EXTRACT_EXCLUDE_TYPES.has(entry.type)
  );
}

/**
 * Suppress low-signal tar warnings (TAR_ENTRY_INFO, TAR_LONGLINK) that are
 * expected when extracting container image layers. All other warning codes are
 * logged when DEBUG_MODE is enabled.
 *
 * @param {string} code Tar warning code (e.g. "TAR_ENTRY_INFO")
 * @param {string} message Human-readable warning message
 */
function handleTarWarning(code, message) {
  if (code === "TAR_ENTRY_INFO" || code === "TAR_LONGLINK") {
    return;
  }
  if (DEBUG_MODE) {
    console.log(code, message);
  }
}

// These paths are known to cause extract errors
const EXTRACT_EXCLUDE_PATHS = [
  "etc/machine-id",
  "etc/gshadow",
  "etc/shadow",
  "etc/passwd",
  "etc/ssl/certs",
  "etc/pki/ca-trust",
  "usr/lib/systemd/",
  "usr/lib64/libdevmapper.so",
  "usr/sbin/",
  "cacerts",
  "ssl/certs",
  "logs/",
  "dev/",
  "proc/",
  "sys/",
  "usr/share/zoneinfo/",
  "usr/share/doc/",
  "usr/share/man/",
  "usr/share/icons/",
  "usr/share/i18n/",
  "var/lib/ca-certificates",
  "root/.gnupg",
  "root/.dotnet",
  "usr/share/licenses/device-mapper-libs",
];

const MEDIA_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".tiff",
  ".ico",
  ".svg",
  ".mp3",
  ".wav",
  ".mp4",
  ".avi",
  ".mov",
  ".ttf",
  ".woff",
  ".woff2",
  ".eot",
]);

// These device types are known to cause extract errors
const EXTRACT_EXCLUDE_TYPES = new Set([
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "MultiVolume",
  "TapeVolume",
  "SymbolicLink",
  "RenamedOrSymlinked",
  "HardLink",
  "Link",
]);

/**
 * Extract a container image tar archive into a destination directory.
 * Applies path sanitisation, ownership/permission preservation settings, and
 * an entry filter to skip problematic files and device nodes. Handles common
 * tar errors gracefully, logging only unexpected ones.
 *
 * @param {string} fullImageName Path to the source tar archive
 * @param {string} dir Destination directory to extract into
 * @param {Object} options CLI options (uses `options.failOnError`)
 * @returns {Promise<boolean>} `true` on success, `false` when the archive is
 *   empty or a non-fatal error was encountered
 */
export const extractTar = async (fullImageName, dir, options) => {
  try {
    return await safeExtractArchive(
      fullImageName,
      dir,
      async () =>
        await stream.pipeline(
          createReadStream(fullImageName),
          x({
            sync: false,
            preserveOwner: false,
            noMtime: true,
            noChmod: true,
            strict: !NON_STRICT_TAR_EXTRACT,
            C: dir,
            portable: true,
            unlink: true,
            onwarn: handleTarWarning,
            onReadEntry: handleAbsolutePath,
            filter: tarFilter,
          }),
        ),
      "untar",
      {
        blockedReason:
          "Dry run mode blocks untar and layer extraction operations because they create files on disk.",
        metadata: {
          archiveFormat: "tar",
        },
      },
    );
  } catch (err) {
    if (err.code === "EPERM" && err.syscall === "symlink") {
      console.log(
        "Please run cdxgen from a powershell terminal with admin privileges to create symlinks.",
      );
      console.log(err);
    } else if (
      ![
        "TAR_BAD_ARCHIVE",
        "TAR_ENTRY_INFO",
        "TAR_ENTRY_INVALID",
        "TAR_ENTRY_ERROR",
        "TAR_ENTRY_UNSUPPORTED",
        "TAR_ABORT",
        "EACCES",
      ].includes(err.code)
    ) {
      console.log(
        `Error while extracting image ${fullImageName} to ${dir}. Please file this bug to the cdxgen repo. https://github.com/cdxgen/cdxgen/issues`,
      );
      console.log("------------");
      console.log(err);
      console.log("------------");
    } else if (err.code === "TAR_BAD_ARCHIVE") {
      if (DEBUG_MODE) {
        console.log(`Archive ${fullImageName} is empty. Skipping.`);
      }
      return false;
    } else if (["EACCES"].includes(err.code)) {
      console.log(err);
    } else if (["TAR_ENTRY_INFO", "TAR_ENTRY_INVALID"].includes(err.code)) {
      if (
        err?.header?.path?.includes("{") ||
        err?.message?.includes("linkpath required") ||
        err?.message?.includes("linkpath forbidden")
      ) {
        return false;
      }
      if (DEBUG_MODE) {
        console.log(err);
      }
    } else if (DEBUG_MODE) {
      console.log(err.code, "is not handled yet in extractTar method.");
    }
    options.failOnError && process.exit(1);
    return false;
  }
};

const readArchiveJson = (jsonFile) => {
  if (!jsonFile || !safeExistsSync(jsonFile)) {
    return undefined;
  }
  return JSON.parse(
    readFileSync(jsonFile, {
      encoding: "utf-8",
    }),
  );
};

const tryReadArchiveJson = (jsonFile) => {
  try {
    return readArchiveJson(jsonFile);
  } catch (_err) {
    return undefined;
  }
};

const digestToBlobPath = (digest) => {
  if (!digest?.startsWith("sha256:")) {
    return undefined;
  }
  return join("blobs", "sha256", digest.replace("sha256:", ""));
};

const archiveBlobPath = (tempDir, digest) => {
  const blobPath = digestToBlobPath(digest);
  return blobPath ? join(tempDir, blobPath) : undefined;
};

const toManifestEntry = (manifestBlob) => {
  const configBlob = digestToBlobPath(manifestBlob?.config?.digest);
  const layers =
    manifestBlob?.layers
      ?.map((layer) => digestToBlobPath(layer?.digest))
      .filter(Boolean) || [];
  if (!configBlob && !layers.length) {
    return undefined;
  }
  return {
    Config: configBlob,
    Layers: layers,
  };
};

const resolveArchiveManifest = (manifestData, tempDir) => {
  if (Array.isArray(manifestData)) {
    return manifestData;
  }
  if (!manifestData || typeof manifestData !== "object") {
    return [];
  }
  if (Array.isArray(manifestData.manifests)) {
    const resolvedManifests = manifestData.manifests
      .map((manifestEntry) => {
        if (manifestEntry?.Layers?.length || manifestEntry?.Config) {
          return manifestEntry;
        }
        const manifestBlob = tryReadArchiveJson(
          archiveBlobPath(tempDir, manifestEntry?.digest),
        );
        const resolvedEntry = toManifestEntry(manifestBlob);
        return resolvedEntry
          ? {
              ...manifestEntry,
              ...resolvedEntry,
            }
          : manifestEntry;
      })
      .filter(Boolean);
    return resolvedManifests.length
      ? resolvedManifests
      : manifestData.manifests;
  }
  const manifestEntry = toManifestEntry(manifestData);
  return manifestEntry ? [manifestEntry] : [];
};

const discoverManifestFromBlobs = (tempDir) => {
  const blobsDir = join(tempDir, "blobs", "sha256");
  if (!safeExistsSync(blobsDir)) {
    return undefined;
  }
  const blobFiles = readdirSync(blobsDir);
  for (const blobFile of blobFiles) {
    const manifestBlob = tryReadArchiveJson(join(blobsDir, blobFile));
    const manifestEntry = toManifestEntry(manifestBlob);
    if (manifestEntry?.Layers?.length || manifestEntry?.Config) {
      return [manifestEntry];
    }
  }
  return undefined;
};

/**
 * Method to export a container image archive.
 * Returns the location of the layers with additional packages related metadata
 */
export const exportArchive = async (fullImageName, options = {}) => {
  if (isDryRun) {
    recordActivity({
      kind: "container",
      reason:
        "Dry run mode blocks container archive expansion and layer materialization.",
      status: "blocked",
      target: fullImageName,
    });
    return undefined;
  }
  if (!safeExistsSync(fullImageName)) {
    console.log(`Unable to find container image archive ${fullImageName}`);
    return undefined;
  }
  const manifest = {};
  const tempDir = safeMkdtempSync(join(getTmpDir(), "docker-images-"));
  const allLayersExplodedDir = join(tempDir, "all-layers");
  const blobsDir = join(tempDir, "blobs", "sha256");
  safeMkdirSync(allLayersExplodedDir);
  const manifestFile = join(tempDir, "manifest.json");
  const manifestIndexFile = join(tempDir, "index.json");
  const synthesizedManifestFile = join(tempDir, "synthetic-manifest.json");
  try {
    await extractTar(fullImageName, tempDir, options);
    if (safeExistsSync(manifestFile)) {
      // docker archive manifest file
      return await extractFromManifest(
        manifestFile,
        {},
        tempDir,
        allLayersExplodedDir,
        options,
      );
    }
    if (safeExistsSync(manifestIndexFile)) {
      return await extractFromManifest(
        manifestIndexFile,
        {},
        tempDir,
        allLayersExplodedDir,
        options,
      );
    }
    // podman use blobs dir
    if (safeExistsSync(blobsDir)) {
      const discoveredManifest = discoverManifestFromBlobs(tempDir);
      if (discoveredManifest?.length) {
        safeWriteSync(
          synthesizedManifestFile,
          JSON.stringify(discoveredManifest),
          "utf-8",
        );
        return await extractFromManifest(
          synthesizedManifestFile,
          {},
          tempDir,
          allLayersExplodedDir,
          options,
        );
      }
      if (DEBUG_MODE) {
        console.log(
          `Image archive ${fullImageName} successfully exported to directory ${tempDir}`,
        );
      }
      const allBlobs = getAllFiles(blobsDir, "*");
      for (const ablob of allBlobs) {
        if (DEBUG_MODE) {
          console.log(`Extracting ${ablob} to ${allLayersExplodedDir}`);
        }
        await extractTar(ablob, allLayersExplodedDir, options);
      }
      const lastLayerConfig = {};
      // Bug #3565. We may not know the work directory, so we have to try and detect them.
      const lastWorkingDir = "/";
      const exportData = {
        manifest,
        allLayersDir: tempDir,
        allLayersExplodedDir,
        lastLayerConfig,
        lastWorkingDir,
      };
      exportData.pkgPathList = getPkgPathList(exportData, lastWorkingDir);
      return exportData;
    }
    console.log(`Unable to extract image archive to ${tempDir}`);
    options.failOnError && process.exit(1);
  } catch (_err) {
    // ignore
    options.failOnError && process.exit(1);
  }
  return undefined;
};

/**
 * Parse a Docker/containerd manifest file and extract all image layers into a
 * single merged directory. Resolves the last layer's config to determine the
 * container's working directory, and builds the package path list for
 * subsequent analysis.
 *
 * @param {string} manifestFile Path to the manifest.json (or index.json) file
 * @param {Object} localData Local image inspect data (e.g. from `docker inspect`)
 * @param {string} tempDir Temporary directory that holds the unpacked image
 * @param {string} allLayersExplodedDir Directory where all layers are merged
 * @param {Object} options CLI options (uses `options.failOnError`)
 * @returns {Promise<Object>} Export data object containing `manifest`,
 *   `allLayersDir`, `allLayersExplodedDir`, `lastLayerConfig`,
 *   `lastWorkingDir`, `binPaths`, and `pkgPathList`
 */
export const extractFromManifest = async (
  manifestFile,
  localData,
  tempDir,
  allLayersExplodedDir,
  options,
) => {
  // Example of manifests
  // [{"Config":"blobs/sha256/dedc100afa8d6718f5ac537730dd4a5ceea3563e695c90f1a8ac6df32c4cb291","RepoTags":["shiftleft/core:latest"],"Layers":["blobs/sha256/eaead16dc43bb8811d4ff450935d607f9ba4baffda4fc110cc402fa43f601d83","blobs/sha256/2039af03c0e17a3025b989335e9414149577fa09e7d0dcbee80155333639d11f"]}]
  // {"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.docker.distribution.manifest.list.v2+json","digest":"sha256:7706ac20c7587081dc7a00e0ec65a6633b0bb3788e0048a3e971d3eae492db63","size":318,"annotations":{"io.containerd.image.name":"docker.io/shiftleft/scan-slim:latest","org.opencontainers.image.ref.name":"latest"}}]}
  let manifest = readArchiveJson(manifestFile);
  let lastLayerConfig = {};
  let lastLayerConfigFile = "";
  let selectedManifest;
  let lastWorkingDir = "";
  manifest = resolveArchiveManifest(manifest, tempDir);
  if (Array.isArray(manifest)) {
    selectedManifest = manifest[manifest.length - 1];
    if (manifest.length !== 1) {
      if (DEBUG_MODE) {
        console.log(
          "Multiple image tags was downloaded. Only the last one would be used",
        );
        console.log(selectedManifest);
      }
    }
    const layers = selectedManifest?.Layers || [];
    if (!layers.length && safeExistsSync(tempDir)) {
      const blobFiles = readdirSync(join(tempDir, "blobs", "sha256"));
      if (blobFiles?.length) {
        for (const blobf of blobFiles) {
          layers.push(join("blobs", "sha256", blobf));
        }
      }
    }
    const lastLayer = layers[layers.length - 1];
    for (const layer of layers) {
      try {
        if (!lstatSync(join(tempDir, layer)).isFile()) {
          console.log(
            `Skipping layer ${layer} since it is not a readable file.`,
          );
          continue;
        }
      } catch (_e) {
        console.log(`Skipping layer ${layer} since it is not a readable file.`);
        continue;
      }
      if (DEBUG_MODE) {
        console.log(`Extracting layer ${layer} to ${allLayersExplodedDir}`);
      }
      try {
        await extractTar(join(tempDir, layer), allLayersExplodedDir, options);
      } catch (err) {
        if (err.code === "TAR_BAD_ARCHIVE") {
          if (DEBUG_MODE) {
            console.log(`Layer ${layer} is empty.`);
          }
        } else {
          console.log(err);
          options.failOnError && process.exit(1);
        }
      }
    }
    if (selectedManifest?.Config) {
      lastLayerConfigFile = join(tempDir, selectedManifest.Config);
    }
    if (!lastLayerConfigFile && lastLayer?.includes("layer.tar")) {
      lastLayerConfigFile = join(
        tempDir,
        lastLayer.replace("layer.tar", "json"),
      );
    }
    if (lastLayerConfigFile && safeExistsSync(lastLayerConfigFile)) {
      try {
        lastLayerConfig = JSON.parse(
          readFileSync(lastLayerConfigFile, {
            encoding: "utf-8",
          }),
        );
        lastWorkingDir = lastLayerConfig.config?.WorkingDir
          ? join(allLayersExplodedDir, lastLayerConfig.config.WorkingDir)
          : "";
      } catch (_err) {
        options.failOnError && process.exit(1);
      }
    }
  }
  const inspectData = localData?.Config
    ? localData
    : lastLayerConfig?.config
      ? {
          ...localData,
          Config: lastLayerConfig.config,
        }
      : localData;
  const binPaths = extractPathEnv(inspectData?.Config?.Env);
  const exportData = {
    inspectData,
    manifest,
    allLayersDir: tempDir,
    allLayersExplodedDir,
    lastLayerConfig,
    lastWorkingDir,
    binPaths,
  };
  exportData.pkgPathList = getPkgPathList(exportData, lastWorkingDir);
  return exportData;
};

/**
 * Method to export a container image by using the export feature in docker or podman service.
 * Returns the location of the layers with additional packages related metadata
 */
export const exportImage = async (fullImageName, options) => {
  // Safely ignore local directories
  if (
    !fullImageName ||
    fullImageName === "." ||
    safeExistsSync(resolve(fullImageName))
  ) {
    return undefined;
  }
  if (isDryRun) {
    const imageDetails = parseImageName(fullImageName);
    const requestedRegistryRef = imageDetails.registry
      ? imageDetails.repo
        ? `${imageDetails.registry}/${imageDetails.repo}`
        : imageDetails.registry
      : DOCKER_HUB_REGISTRY;
    await getConnection({}, requestedRegistryRef);
    recordActivity({
      kind: "container",
      reason:
        "Dry run mode blocks container image pull, save, and export operations.",
      status: "blocked",
      target: fullImageName,
    });
    return undefined;
  }
  // Try to get the data locally first
  const localData = await getImage(fullImageName);
  if (!localData) {
    return undefined;
  }
  const { registry, tag, digest } = parseImageName(fullImageName);
  // Fetch only the latest tag if none is specified
  if (tag === "" && digest === "") {
    fullImageName = `${fullImageName}:latest`;
  }
  const tempDir = safeMkdtempSync(join(getTmpDir(), "docker-images-"));
  const allLayersExplodedDir = join(tempDir, "all-layers");
  let manifestFile = join(tempDir, "manifest.json");
  // Windows containers use index.json
  const manifestIndexFile = join(tempDir, "index.json");
  // On Windows or on mac with Rancher Desktop, fallback to invoking cli
  if (needsCliFallback()) {
    const imageTarFile = join(tempDir, "image.tar");
    const dockerCmd = getContainerCliCmd();
    console.log(
      `About to export image ${fullImageName} to ${imageTarFile} using ${dockerCmd} cli`,
    );
    const result = safeSpawnSync(dockerCmd, [
      "save",
      "-o",
      imageTarFile,
      fullImageName,
    ]);
    if (result.status !== 0 || result.error) {
      if (result.stdout || result.stderr) {
        console.log(result.stdout, result.stderr);
      }
      return localData;
    }
    await extractTar(imageTarFile, tempDir, options);
    if (DEBUG_MODE) {
      console.log(`Cleaning up ${imageTarFile}`);
    }
    safeRmSync(imageTarFile, { force: true });
  } else {
    const client = await getConnection({}, registry);
    try {
      if (DEBUG_MODE) {
        if (registry?.trim().length) {
          console.log(
            `About to export image ${fullImageName} from ${registry} to ${tempDir}`,
          );
        } else {
          console.log(`About to export image ${fullImageName} to ${tempDir}`);
        }
      }
      await stream.pipeline(
        client.stream(`images/${fullImageName}/get`),
        x({
          sync: false,
          preserveOwner: false,
          noMtime: true,
          noChmod: true,
          strict: !NON_STRICT_TAR_EXTRACT,
          C: tempDir,
          portable: true,
          unlink: true,
          onwarn: handleTarWarning,
          onReadEntry: handleAbsolutePath,
          filter: tarFilter,
        }),
      );
    } catch (_err) {
      if (localData?.Id) {
        console.log(`Retrying with ${localData.Id}`);
        try {
          await stream.pipeline(
            client.stream(`images/${localData.Id}/get`),
            x({
              sync: true,
              preserveOwner: false,
              noMtime: true,
              noChmod: true,
              strict: !NON_STRICT_TAR_EXTRACT,
              C: tempDir,
              portable: true,
              onwarn: handleTarWarning,
              onReadEntry: handleAbsolutePath,
              filter: tarFilter,
            }),
          );
        } catch (_err) {
          // ignore
        }
      }
    }
  }
  // Continue with extracting the layers
  if (safeExistsSync(tempDir)) {
    if (safeExistsSync(manifestFile)) {
      // This is fine
    } else if (safeExistsSync(manifestIndexFile)) {
      manifestFile = manifestIndexFile;
    } else {
      console.log(
        `Manifest file ${manifestFile} was not found after export at ${tempDir}`,
      );
      return undefined;
    }
    if (DEBUG_MODE) {
      console.log(
        `Image ${fullImageName} successfully exported to directory ${tempDir}`,
      );
    }
    safeMkdirSync(allLayersExplodedDir);
    return await extractFromManifest(
      manifestFile,
      localData,
      tempDir,
      allLayersExplodedDir,
      options,
    );
  }
  console.log(`Unable to export image to ${tempDir}`);
  return undefined;
};

/**
 * Method to retrieve path list for system-level packages
 */
export const getPkgPathList = (exportData, lastWorkingDir) => {
  const allLayersExplodedDir = exportData.allLayersExplodedDir;
  const allLayersDir = exportData.allLayersDir;
  let pathList = [];
  let knownSysPaths = [];
  // Bug #3565. Try and detect the working directory
  if (lastWorkingDir === "/" || lastWorkingDir === "") {
    if (DEBUG_MODE) {
      console.log("Attempting to detect the work directories ...");
    }
    const possibleWorkDirs = getDirs(allLayersExplodedDir, "*", true, false);
    for (const adir of possibleWorkDirs) {
      if (safeExistsSync(adir) && !lstatSync(adir).isDirectory()) {
        break;
      }
      let ignoreDir = false;
      for (const nonWorkDirs of [
        "/var",
        "/usr",
        "/mnt",
        "/opt",
        "/root",
        "/home",
      ]) {
        if (adir.endsWith(nonWorkDirs)) {
          ignoreDir = true;
          break;
        }
      }
      if (!ignoreDir) {
        knownSysPaths.push(adir);
      }
    }
    if (DEBUG_MODE) {
      console.log("Possible work directories", knownSysPaths);
    }
  }
  if (allLayersExplodedDir && allLayersExplodedDir !== "") {
    knownSysPaths = knownSysPaths.concat([
      join(allLayersExplodedDir, "/usr/local/go"),
      join(allLayersExplodedDir, "/usr/local/lib"),
      join(allLayersExplodedDir, "/usr/local/lib64"),
      join(allLayersExplodedDir, "/opt"),
      join(allLayersExplodedDir, "/root"),
      join(allLayersExplodedDir, "/home"),
      join(allLayersExplodedDir, "/usr/share"),
      join(allLayersExplodedDir, "/usr/src"),
      join(allLayersExplodedDir, "/var/www/html"),
      join(allLayersExplodedDir, "/var/lib"),
      join(allLayersExplodedDir, "/mnt"),
    ]);
  } else if (allLayersExplodedDir === "") {
    knownSysPaths = knownSysPaths.concat([
      join(allLayersExplodedDir, "/usr/local/go"),
      join(allLayersExplodedDir, "/usr/local/lib"),
      join(allLayersExplodedDir, "/usr/local/lib64"),
      join(allLayersExplodedDir, "/opt"),
      join(allLayersExplodedDir, "/root"),
      join(allLayersExplodedDir, "/usr/share"),
      join(allLayersExplodedDir, "/usr/src"),
      join(allLayersExplodedDir, "/var/www/html"),
      join(allLayersExplodedDir, "/var/lib"),
    ]);
  }
  if (safeExistsSync(join(allLayersDir, "Files"))) {
    knownSysPaths.push(join(allLayersDir, "Files"));
  }
  /*
  // Too slow
  if (safeExistsSync(path.join(allLayersDir, "Users"))) {
    knownSysPaths.push(path.join(allLayersDir, "Users"));
  }
  */
  if (safeExistsSync(join(allLayersDir, "ProgramData"))) {
    knownSysPaths.push(join(allLayersDir, "ProgramData"));
  }
  const pyInstalls = getDirs(allLayersDir, "Python*/", false, false);
  if (pyInstalls?.length) {
    for (const pyiPath of pyInstalls) {
      const pyDirs = getOnlyDirs(pyiPath, "site-packages");
      if (pyDirs?.length) {
        pathList = pathList.concat(pyDirs);
      }
    }
  }
  if (lastWorkingDir && lastWorkingDir !== "") {
    if (
      lastWorkingDir !== "/" &&
      !lastWorkingDir.includes("/opt/") &&
      !lastWorkingDir.includes("/home/") &&
      !lastWorkingDir.includes("/root/")
    ) {
      knownSysPaths.push(lastWorkingDir);
    }
    // Some more common app dirs
    if (!lastWorkingDir.includes("/app/")) {
      knownSysPaths.push(join(allLayersExplodedDir, "/app"));
    }
    if (!lastWorkingDir.includes("/layers/")) {
      knownSysPaths.push(join(allLayersExplodedDir, "/layers"));
    }
    if (!lastWorkingDir.includes("/data/")) {
      knownSysPaths.push(join(allLayersExplodedDir, "/data"));
    }
    if (!lastWorkingDir.includes("/srv/")) {
      knownSysPaths.push(join(allLayersExplodedDir, "/srv"));
    }
  } else {
    // Bug #3426
    knownSysPaths.push(join(allLayersExplodedDir, "/app"));
  }
  // Known to cause EACCESS error
  knownSysPaths.push(join(allLayersExplodedDir, "/usr/lib"));
  knownSysPaths.push(join(allLayersExplodedDir, "/usr/lib64"));
  // Build path list
  for (const wpath of knownSysPaths) {
    pathList = pathList.concat(wpath);
    const nodeModuleDirs = getOnlyDirs(wpath, "node_modules");
    if (nodeModuleDirs?.length) {
      pathList.push(nodeModuleDirs[0]);
    }
    const pyDirs = getOnlyDirs(wpath, "site-packages");
    if (pyDirs?.length) {
      pathList = pathList.concat(pyDirs);
    }
    const gemsDirs = getOnlyDirs(wpath, "gems");
    if (gemsDirs?.length) {
      pathList = pathList.concat(gemsDirs[0]);
    }
    const cargoDirs = getOnlyDirs(wpath, ".cargo");
    if (cargoDirs?.length) {
      pathList = pathList.concat(cargoDirs);
    }
    const composerDirs = getOnlyDirs(wpath, ".composer");
    if (composerDirs?.length) {
      pathList = pathList.concat(composerDirs);
    }
  }
  pathList = Array.from(new Set(pathList)).sort();
  if (DEBUG_MODE) {
    console.log("pathList", pathList);
  }
  return pathList;
};

/**
 * Remove a container image from the local Docker / Podman daemon.
 *
 * @param {string} fullImageName Full image name including tag or digest (e.g. "ubuntu:22.04")
 * @param {boolean} [force=false] When `true`, force-remove the image even if it is in use
 * @returns {Promise<Buffer|undefined>} Raw response buffer from the daemon, or
 *   `undefined` if no daemon connection is available
 */
export const removeImage = async (fullImageName, force = false) => {
  return await makeRequest(`images/${fullImageName}?force=${force}`, "DELETE");
};

/**
 * Retrieve a base64url-encoded authentication token for a registry server by
 * invoking the `docker-credential-<exeSuffix>` credential helper binary.
 * Results are cached in `registry_auth_keys` to avoid redundant subprocess
 * calls.
 *
 * @param {string} exeSuffix Credential helper name suffix (e.g. "osxkeychain", "wincred", "pass")
 * @param {string} serverAddress Registry server address (e.g. "https://index.docker.io/v1/")
 * @returns {string|undefined} Base64url-encoded JSON auth token, or `undefined`
 *   if the helper is unavailable or returns an error
 */
export const getCredsFromHelper = (exeSuffix, serverAddress) => {
  const cacheKey = `${exeSuffix}:${normalizeRegistryReference(serverAddress) ?? serverAddress}`;
  if (registry_auth_keys[cacheKey]) {
    return registry_auth_keys[cacheKey];
  }
  let credHelperExe = `docker-credential-${exeSuffix}`;
  if (isWin) {
    credHelperExe = `${credHelperExe}.exe`;
  }
  const result = safeSpawnSync(credHelperExe, ["get"], {
    input: serverAddress,
  });
  if (result.status !== 0 || result.error) {
    if (result.stdout || result.stderr) {
      console.log(result.stdout, result.stderr);
    }
  } else if (result.stdout) {
    const cmdOutput = Buffer.from(result.stdout).toString();
    try {
      const dockerUser = readEnvironmentVariable("DOCKER_USER", {
        sensitive: true,
      });
      const dockerPassword = readEnvironmentVariable("DOCKER_PASSWORD", {
        sensitive: true,
      });
      const authPayload = JSON.parse(cmdOutput);
      const fixedAuthPayload = {
        username: authPayload.username || authPayload.Username || dockerUser,
        password: authPayload.password || authPayload.Secret || dockerPassword,
        email: authPayload.email || authPayload.username || dockerUser,
        serveraddress: serverAddress,
      };
      const authKey = toBase64Url(JSON.stringify(fixedAuthPayload));
      registry_auth_keys[cacheKey] = authKey;
      return authKey;
    } catch (_err) {
      return undefined;
    }
  }
  return undefined;
};

/**
 * Append skipped source-file entries to the `SrcFile` properties of matching
 * components. A component matches when its `oci:SrcImage` property value
 * equals the skipped image's `image` field and the source file path is not
 * already listed.
 *
 * @param {Array<{image: string, src: string}>} skippedImageSrcs List of skipped image/source pairs
 * @param {Array<Object>} components CycloneDX component objects to update in place
 */
export const addSkippedSrcFiles = (skippedImageSrcs, components) => {
  for (const skippedImage of skippedImageSrcs) {
    for (const co of components) {
      const srcFileValues = [];
      let srcImageValue;
      co.properties.forEach((property) => {
        if (property.name === "oci:SrcImage") {
          srcImageValue = property.value;
        }

        if (property.name === "SrcFile") {
          srcFileValues.push(property.value);
        }
      });

      if (
        srcImageValue === skippedImage.image &&
        !srcFileValues.includes(skippedImage.src)
      ) {
        co.properties = co.properties.concat({
          name: "SrcFile",
          value: skippedImage.src,
        });
      }
    }
  }
};
