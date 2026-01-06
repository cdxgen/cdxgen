import { Buffer } from "node:buffer";
import {
  createReadStream,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { platform as _platform, userInfo as _userInfo, homedir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";
import process from "node:process";
import stream from "node:stream/promises";
import { URL } from "node:url";

import { globSync } from "glob";
import got from "got";
import { x } from "tar";

import {
  DEBUG_MODE,
  extractPathEnv,
  getAllFiles,
  getTmpDir,
  safeExistsSync,
  safeMkdirSync,
  safeSpawnSync,
} from "../helpers/utils.js";

export const isWin = _platform() === "win32";
export const DOCKER_HUB_REGISTRY = "docker.io";

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

// Taken from https://github.com/isaacs/node-tar/blob/main/src/strip-absolute-path.ts
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

/**
 * Method to get all dirs matching a name
 *
 * @param {string} dirPath Root directory for search
 * @param {string} dirName Directory name
 */
export const getDirs = (dirPath, dirName, hidden = false, recurse = true) => {
  try {
    return globSync(recurse ? "**/" : `${dirName}`, {
      cwd: dirPath,
      absolute: true,
      nocase: true,
      nodir: false,
      follow: false,
      dot: hidden,
    });
  } catch (_err) {
    return [];
  }
};

function flatten(lists) {
  return lists.reduce((a, b) => a.concat(b), []);
}

function getDirectories(srcpath) {
  if (safeExistsSync(srcpath)) {
    return readdirSync(srcpath)
      .map((file) => join(srcpath, file))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch (_e) {
          return false;
        }
      });
  }
  return [];
}

export const getOnlyDirs = (srcpath, dirName) => {
  return [
    srcpath,
    ...flatten(
      getDirectories(srcpath)
        .map((p) => {
          try {
            if (safeExistsSync(p) && lstatSync(p).isDirectory()) {
              return getOnlyDirs(p, dirName);
            }
            return [];
          } catch (_err) {
            return [];
          }
        })
        .filter((p) => p !== undefined),
    ),
  ].filter((d) => d.endsWith(dirName));
};

const getDefaultOptions = (forRegistry) => {
  let authTokenSet = false;
  if (!forRegistry) {
    forRegistry = process.env.DOCKER_SERVER_ADDRESS ?? DOCKER_HUB_REGISTRY;
  }
  if (forRegistry) {
    forRegistry = forRegistry.replace("http://", "").replace("https://", "");
    if (forRegistry.includes("/")) {
      forRegistry = forRegistry.split("/")[0];
    }
  }
  const opts = {
    enableUnixSockets: true,
    throwHttpErrors: true,
    method: "GET",
    hooks: { beforeError: [] },
    mutableDefaults: true,
  };
  const DOCKER_CONFIG = process.env.DOCKER_CONFIG || join(homedir(), ".docker");
  // Support for private registry
  if (process.env.DOCKER_AUTH_CONFIG) {
    opts.headers = {
      "X-Registry-Auth": process.env.DOCKER_AUTH_CONFIG,
    };
    authTokenSet = true;
  }
  if (
    !authTokenSet &&
    process.env.DOCKER_USER &&
    process.env.DOCKER_PASSWORD &&
    process.env.DOCKER_EMAIL &&
    forRegistry
  ) {
    const authPayload = {
      username: process.env.DOCKER_USER,
      email: process.env.DOCKER_EMAIL,
      serveraddress: forRegistry,
    };
    if (process.env.DOCKER_USER === "<token>") {
      authPayload.IdentityToken = process.env.DOCKER_PASSWORD;
    } else {
      authPayload.password = process.env.DOCKER_PASSWORD;
    }
    opts.headers = {
      "X-Registry-Auth": Buffer.from(JSON.stringify(authPayload)).toString(
        "base64",
      ),
    };
  }
  if (!authTokenSet && safeExistsSync(join(DOCKER_CONFIG, "config.json"))) {
    const configData = readFileSync(
      join(DOCKER_CONFIG, "config.json"),
      "utf-8",
    );
    if (configData) {
      try {
        const configJson = JSON.parse(configData);
        if (configJson.auths) {
          // Check if there are hardcoded tokens
          for (const serverAddress of Object.keys(configJson.auths)) {
            if (forRegistry && !serverAddress.includes(forRegistry)) {
              continue;
            }
            if (configJson.auths[serverAddress].auth) {
              opts.headers = {
                "X-Registry-Auth": configJson.auths[serverAddress].auth,
              };
              authTokenSet = true;
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
                break;
              }
            }
          }
        } else if (configJson.credHelpers) {
          // Support for credential helpers
          for (const serverAddress of Object.keys(configJson.credHelpers)) {
            if (forRegistry && !serverAddress.includes(forRegistry)) {
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
                break;
              }
            }
          }
        }
      } catch (_err) {
        // pass
      }
    }
  }
  const userInfo = _userInfo();
  opts.podmanPrefixUrl = isWin ? "" : "http://unix:/run/podman/podman.sock:";
  opts.podmanRootlessPrefixUrl = isWin
    ? ""
    : `http://unix:/run/user/${userInfo.uid}/podman/podman.sock:`;
  if (!process.env.DOCKER_HOST) {
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
    let hostStr = process.env.DOCKER_HOST;
    if (hostStr.startsWith("unix:///")) {
      hostStr = hostStr.replace("unix:///", "http://unix:/");
      if (hostStr.includes("docker.sock")) {
        hostStr = hostStr.replace("docker.sock", "docker.sock:");
        isDockerRootless = true;
      }
    }
    opts.prefixUrl = hostStr;
    if (process.env.DOCKER_CERT_PATH) {
      opts.https = {
        certificate: readFileSync(
          join(process.env.DOCKER_CERT_PATH, "cert.pem"),
          "utf8",
        ),
        key: readFileSync(
          join(process.env.DOCKER_CERT_PATH, "key.pem"),
          "utf8",
        ),
      };
      // Disable tls on empty values
      // From the docker docs: Setting the DOCKER_TLS_VERIFY environment variable to any value other than the empty string is equivalent to setting the --tlsverify flag
      if (
        process.env.DOCKER_TLS_VERIFY &&
        process.env.DOCKER_TLS_VERIFY === ""
      ) {
        opts.https.rejectUnauthorized = false;
        console.log("TLS Verification disabled for", hostStr);
      }
    }
  }

  return opts;
};

export const getConnection = async (options, forRegistry) => {
  if (isContainerd || isNerdctl) {
    return undefined;
  }
  if (!dockerConn) {
    const defaultOptions = getDefaultOptions(forRegistry);
    const opts = Object.assign(
      {},
      {
        enableUnixSockets: defaultOptions.enableUnixSockets,
        throwHttpErrors: defaultOptions.throwHttpErrors,
        method: defaultOptions.method,
        prefixUrl: defaultOptions.prefixUrl,
        headers: defaultOptions.headers,
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
          opts.prefixUrl = opts.podmanRootlessPrefixUrl;
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
          opts.prefixUrl = opts.podmanPrefixUrl;
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

export const makeRequest = async (path, method, forRegistry) => {
  const client = await getConnection({}, forRegistry);
  if (!client) {
    return undefined;
  }
  const extraOptions = {
    responseType: method === "GET" ? "json" : "buffer",
    resolveBodyOnly: true,
    enableUnixSockets: true,
    method,
  };
  const defaultOptions = getDefaultOptions(forRegistry);
  const opts = Object.assign(
    {},
    {
      enableUnixSockets: defaultOptions.enableUnixSockets,
      throwHttpErrors: defaultOptions.throwHttpErrors,
      method: defaultOptions.method,
      prefixUrl: defaultOptions.prefixUrl,
      headers: defaultOptions.headers,
    },
    extraOptions,
  );
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
const needsCliFallback = () => {
  if (
    ["true", "1"].includes(process.env.DOCKER_USE_CLI) ||
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
  if (isContainerd) {
    console.log(
      "containerd/nerdctl is currently unsupported. Export the image manually and run cdxgen against the tar image.",
    );
    return undefined;
  }
  if (needsCliFallback()) {
    let dockerCmd = process.env.DOCKER_CMD || "docker";
    if (!process.env.DOCKER_CMD) {
      detectRancherDesktop() || detectColima();
      if (isNerdctl) {
        dockerCmd = "nerdctl";
      }
    }
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
      return localData;
    }
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
 * Warnings such as TAR_ENTRY_INFO are treated as errors in strict mode. While this is mostly desired, we can relax this
 * requirement for one particular warning related to absolute paths.
 * This callback function checks for absolute paths in the entry read from the archive and strips them using a custom
 * method.
 *
 * @param entry {tar.ReadEntry} ReadEntry object from node-tar
 */
function handleAbsolutePath(entry) {
  if (entry.path === "/" || win32.isAbsolute(entry.path)) {
    entry.path = stripAbsolutePath(entry.path);
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
  "usr/share/zoneinfo/",
  "usr/share/doc/",
  "usr/share/i18n/",
  "var/lib/ca-certificates",
  "root/.gnupg",
  "root/.dotnet",
  "usr/share/licenses/device-mapper-libs",
];

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

export const extractTar = async (fullImageName, dir, options) => {
  try {
    await stream.pipeline(
      createReadStream(fullImageName),
      x({
        sync: true,
        preserveOwner: false,
        noMtime: true,
        noChmod: true,
        strict: !NON_STRICT_TAR_EXTRACT,
        C: dir,
        portable: true,
        onwarn: (code, message) => {
          if (DEBUG_MODE) {
            console.log(code, message);
          }
        },
        onReadEntry: handleAbsolutePath,
        filter: (path, entry) => {
          const name = basename(path);
          return !(
            name.startsWith(".") ||
            EXTRACT_EXCLUDE_PATHS.some((p) => path.includes(p)) ||
            EXTRACT_EXCLUDE_TYPES.has(entry.type)
          );
        },
      }),
    );
    return true;
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

/**
 * Method to export a container image archive.
 * Returns the location of the layers with additional packages related metadata
 */
export const exportArchive = async (fullImageName, options = {}) => {
  if (!safeExistsSync(fullImageName)) {
    console.log(`Unable to find container image archive ${fullImageName}`);
    return undefined;
  }
  const manifest = {};
  const tempDir = mkdtempSync(join(getTmpDir(), "docker-images-"));
  const allLayersExplodedDir = join(tempDir, "all-layers");
  const blobsDir = join(tempDir, "blobs", "sha256");
  safeMkdirSync(allLayersExplodedDir);
  const manifestFile = join(tempDir, "manifest.json");
  try {
    await extractTar(fullImageName, tempDir, options);
    // podman use blobs dir
    if (safeExistsSync(blobsDir)) {
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
      const lastWorkingDir = "";
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
    if (safeExistsSync(manifestFile)) {
      // docker manifest file
      return await extractFromManifest(
        manifestFile,
        {},
        tempDir,
        allLayersExplodedDir,
        options,
      );
    }
    console.log(`Unable to extract image archive to ${tempDir}`);
    options.failOnError && process.exit(1);
  } catch (_err) {
    // ignore
    options.failOnError && process.exit(1);
  }
  return undefined;
};

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
  let manifest = JSON.parse(
    readFileSync(manifestFile, {
      encoding: "utf-8",
    }),
  );
  let lastLayerConfig = {};
  let lastLayerConfigFile = "";
  let lastWorkingDir = "";
  // Extract the manifest for the new containerd syntax
  if (Object.keys(manifest).length !== 0 && manifest.manifests) {
    manifest = manifest.manifests;
  }
  if (Array.isArray(manifest)) {
    if (manifest.length !== 1) {
      if (DEBUG_MODE) {
        console.log(
          "Multiple image tags was downloaded. Only the last one would be used",
        );
        console.log(manifest[manifest.length - 1]);
      }
    }
    const layers = manifest[manifest.length - 1]["Layers"] || [];
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
    if (manifest.Config) {
      lastLayerConfigFile = join(tempDir, manifest.Config);
    }
    if (lastLayer.includes("layer.tar")) {
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
  const binPaths = extractPathEnv(localData?.Config?.Env);
  const exportData = {
    inspectData: localData,
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
  const tempDir = mkdtempSync(join(getTmpDir(), "docker-images-"));
  const allLayersExplodedDir = join(tempDir, "all-layers");
  let manifestFile = join(tempDir, "manifest.json");
  // Windows containers use index.json
  const manifestIndexFile = join(tempDir, "index.json");
  // On Windows or on mac with Rancher Desktop, fallback to invoking cli
  if (needsCliFallback()) {
    const imageTarFile = join(tempDir, "image.tar");
    let dockerCmd = process.env.DOCKER_CMD || "docker";
    if (!process.env.DOCKER_CMD) {
      detectRancherDesktop() || detectColima();
      if (isNerdctl) {
        dockerCmd = "nerdctl";
      }
    }
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
    if (rmSync) {
      rmSync(imageTarFile, { force: true });
    }
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
          sync: true,
          preserveOwner: false,
          noMtime: true,
          noChmod: true,
          strict: !NON_STRICT_TAR_EXTRACT,
          C: tempDir,
          portable: true,
          onwarn: (code, message) => {
            if (DEBUG_MODE) {
              console.log(code, message);
            }
          },
          onReadEntry: handleAbsolutePath,
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
              onwarn: (code, message) => {
                if (DEBUG_MODE) {
                  console.log(code, message);
                }
              },
              onReadEntry: handleAbsolutePath,
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
  if (allLayersExplodedDir && allLayersExplodedDir !== "") {
    knownSysPaths = [
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
    ];
  } else if (allLayersExplodedDir === "") {
    knownSysPaths = [
      join(allLayersExplodedDir, "/usr/local/go"),
      join(allLayersExplodedDir, "/usr/local/lib"),
      join(allLayersExplodedDir, "/usr/local/lib64"),
      join(allLayersExplodedDir, "/opt"),
      join(allLayersExplodedDir, "/root"),
      join(allLayersExplodedDir, "/usr/share"),
      join(allLayersExplodedDir, "/usr/src"),
      join(allLayersExplodedDir, "/var/www/html"),
      join(allLayersExplodedDir, "/var/lib"),
    ];
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

export const removeImage = async (fullImageName, force = false) => {
  return await makeRequest(`images/${fullImageName}?force=${force}`, "DELETE");
};

export const getCredsFromHelper = (exeSuffix, serverAddress) => {
  if (registry_auth_keys[serverAddress]) {
    return registry_auth_keys[serverAddress];
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
      const authPayload = JSON.parse(cmdOutput);
      const fixedAuthPayload = {
        username:
          authPayload.username ||
          authPayload.Username ||
          process.env.DOCKER_USER,
        password:
          authPayload.password ||
          authPayload.Secret ||
          process.env.DOCKER_PASSWORD,
        email:
          authPayload.email || authPayload.username || process.env.DOCKER_USER,
        serveraddress: serverAddress,
      };
      const authKey = Buffer.from(JSON.stringify(fixedAuthPayload)).toString(
        "base64",
      );
      registry_auth_keys[serverAddress] = authKey;
      return authKey;
    } catch (_err) {
      return undefined;
    }
  }
  return undefined;
};

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
