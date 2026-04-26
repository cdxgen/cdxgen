import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { PackageURL } from "packageurl-js";

import {
  cdxgenAgent,
  DEBUG_MODE,
  getTmpDir,
  hasDangerousUnicode,
  isSecureMode,
  isValidDriveRoot,
  isWin,
  safeSpawnSync,
} from "./utils.js";

export const PURL_REGISTRY_LOOKUP_WARNING =
  "Resolved repository URL from package registry metadata. This source can be inaccurate or malicious; review before trusting results.";

/**
 * Return git allow protocol string from the environment variables.
 *
 * @returns {string} git allow protocol string
 */
export function getGitAllowProtocol() {
  return (
    process.env.GIT_ALLOW_PROTOCOL ||
    process.env.CDXGEN_GIT_ALLOW_PROTOCOL ||
    process.env.CDXGEN_SERVER_GIT_ALLOW_PROTOCOL ||
    (isSecureMode ? "https:ssh" : "https:git:ssh")
  );
}

/**
 * Return configured allowed git hosts.
 *
 * @returns {string[]} list of configured hosts
 */
function getAllowedHosts() {
  const configuredHosts =
    process.env.CDXGEN_GIT_ALLOWED_HOSTS ||
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS ||
    "";
  return configuredHosts
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/**
 * Checks the given hostname against the allowed list.
 *
 * @param {string} hostname Host name to check
 * @returns {boolean} true if the hostname in its entirety is allowed. false otherwise.
 */
export function isAllowedHost(hostname) {
  const allowedHosts = getAllowedHosts();
  if (!allowedHosts.length) {
    return true;
  }
  if (hasDangerousUnicode(hostname)) {
    return false;
  }
  return allowedHosts.includes(hostname);
}

/**
 * Return configured allowed paths.
 *
 * @returns {string[]} list of configured paths
 */
function getAllowedPaths() {
  const configuredPaths =
    process.env.CDXGEN_ALLOWED_PATHS ||
    process.env.CDXGEN_SERVER_ALLOWED_PATHS ||
    "";
  return configuredPaths
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Checks the given path string to belong to a drive in Windows.
 *
 * @param {string} p Path string to check
 * @returns {boolean} true if the windows path belongs to a drive. false otherwise (device names)
 */
export function isAllowedWinPath(p) {
  if (!isWin) {
    return true;
  }
  if (typeof p !== "string") {
    return false;
  }
  if (p === "") {
    return true;
  }
  if (hasDangerousUnicode(p)) {
    return false;
  }
  try {
    const normalized = path.normalize(p);
    if (hasDangerousUnicode(normalized)) {
      return false;
    }
    const root = path.parse(normalized).root;
    if (root === "\\") {
      return true;
    }
    if (root.startsWith("\\\\")) {
      return false;
    }
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
  if (hasDangerousUnicode(p)) {
    return false;
  }
  const allowedPaths = getAllowedPaths();
  if (!allowedPaths.length) {
    return true;
  }
  if (isWin && !isAllowedWinPath(p)) {
    return false;
  }
  return allowedPaths.some((ap) => {
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
 * Determine if the path could be a package URL.
 *
 * @param {string} filePath Path or URL
 * @returns {boolean} true if the file path looks like a purl
 */
export function maybePurlSource(filePath) {
  return typeof filePath === "string" && filePath.startsWith("pkg:");
}

/**
 * Determine if the file path could be a remote URL.
 *
 * @param {string} filePath The Git URL or local path
 * @returns {boolean} true if the file path is a remote URL. false otherwise.
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

/**
 * Clone a git repository into a temporary directory.
 *
 * @param {string} repoUrl Repository URL
 * @param {string|string[]|null} branch Branch name
 * @returns {string} cloned directory path
 */
export function gitClone(repoUrl, branch = null) {
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
      console.log(`Skipping branch clone: invalid branch name ${firstBranchStr}`);
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

function normalizeRepositoryUrl(candidateUrl) {
  if (!candidateUrl || typeof candidateUrl !== "string") {
    return undefined;
  }
  let repoUrl = candidateUrl.trim();
  if (!repoUrl) {
    return undefined;
  }
  if (repoUrl.startsWith("git+")) {
    repoUrl = repoUrl.slice(4);
  }
  if (repoUrl.startsWith("scm:git:")) {
    repoUrl = repoUrl.slice(8);
  }
  if (repoUrl.startsWith("github:")) {
    repoUrl = `https://github.com/${repoUrl.slice("github:".length)}`;
  }
  if (repoUrl.startsWith("gitlab:")) {
    repoUrl = `https://gitlab.com/${repoUrl.slice("gitlab:".length)}`;
  }
  if (repoUrl.startsWith("bitbucket:")) {
    repoUrl = `https://bitbucket.org/${repoUrl.slice("bitbucket:".length)}`;
  }
  if (!repoUrl.includes("://") && repoUrl.includes("github.com/")) {
    repoUrl = `https://${repoUrl}`;
  }
  if (!repoUrl.includes("://") && repoUrl.startsWith("www.")) {
    repoUrl = `https://${repoUrl}`;
  }
  const hashIndex = repoUrl.indexOf("#");
  if (hashIndex > -1) {
    repoUrl = repoUrl.slice(0, hashIndex);
  }
  return repoUrl;
}

function normalizeRepositoryObject(candidate) {
  if (!candidate) {
    return undefined;
  }
  if (typeof candidate === "string") {
    return normalizeRepositoryUrl(candidate);
  }
  if (typeof candidate === "object") {
    return normalizeRepositoryUrl(candidate.url);
  }
  return undefined;
}

function packageNameForLookup(purlObj) {
  const namespace = purlObj.namespace;
  if (!namespace) {
    return purlObj.name;
  }
  if (purlObj.type === "npm" && !namespace.startsWith("@")) {
    return `@${namespace}/${purlObj.name}`;
  }
  return `${namespace}/${purlObj.name}`;
}

/**
 * Resolve a git repository URL from a package URL by querying package registries.
 *
 * Supported purl types:
 * - npm    -> registry.npmjs.org
 * - pypi   -> pypi.org
 * - gem    -> rubygems.org
 * - cargo  -> crates.io
 * - pub    -> pub.dev
 *
 * @param {string} purlString package URL string
 * @returns {Promise<{repoUrl:string|undefined, registry:string|undefined, type:string}|undefined>} resolution result
 */
export async function resolveGitUrlFromPurl(purlString) {
  if (!maybePurlSource(purlString)) {
    return undefined;
  }
  let purlObj;
  try {
    purlObj = PackageURL.fromString(purlString);
  } catch (_err) {
    return undefined;
  }
  if (!purlObj?.type || !purlObj?.name) {
    return undefined;
  }

  const packageName = packageNameForLookup(purlObj);
  const packageVersion = purlObj.version;
  let repoUrl;
  let registry;

  try {
    switch (purlObj.type) {
      case "npm": {
        registry = process.env.NPM_URL || "https://registry.npmjs.org/";
        const res = await cdxgenAgent.get(`${registry}${packageName}`, {
          responseType: "json",
        });
        const body = res.body;
        const versionBody = packageVersion
          ? body.versions?.[packageVersion]
          : undefined;
        repoUrl =
          normalizeRepositoryObject(versionBody?.repository) ||
          normalizeRepositoryObject(body.repository) ||
          normalizeRepositoryUrl(versionBody?.homepage) ||
          normalizeRepositoryUrl(body.homepage);
        break;
      }
      case "pypi": {
        registry = process.env.PYPI_URL || "https://pypi.org/pypi/";
        const suffix = packageVersion
          ? `${purlObj.name}/${packageVersion}/json`
          : `${purlObj.name}/json`;
        const res = await cdxgenAgent.get(`${registry}${suffix}`, {
          responseType: "json",
        });
        const info = res.body?.info || {};
        const projectUrls = info.project_urls || {};
        repoUrl =
          normalizeRepositoryUrl(projectUrls.Source) ||
          normalizeRepositoryUrl(projectUrls.Repository) ||
          normalizeRepositoryUrl(projectUrls["Source Code"]) ||
          normalizeRepositoryUrl(projectUrls.Code) ||
          normalizeRepositoryUrl(info.home_page);
        break;
      }
      case "gem": {
        const v1Url = process.env.RUBYGEMS_V1_URL || "https://rubygems.org/api/v1/gems/";
        const v2Url = process.env.RUBYGEMS_V2_URL || "https://rubygems.org/api/v2/rubygems/";
        registry = packageVersion ? v2Url : v1Url;
        const endpoint = packageVersion
          ? `${v2Url}${purlObj.name}/versions/${packageVersion}.json`
          : `${v1Url}${purlObj.name}.json`;
        const res = await cdxgenAgent.get(endpoint, {
          responseType: "json",
        });
        const body = Array.isArray(res.body) ? res.body[0] : res.body;
        repoUrl =
          normalizeRepositoryUrl(body?.metadata?.source_code_uri) ||
          normalizeRepositoryUrl(body?.source_code_uri) ||
          normalizeRepositoryUrl(body?.homepage_uri);
        break;
      }
      case "cargo": {
        registry = process.env.RUST_CRATES_URL || "https://crates.io/api/v1/crates/";
        const res = await cdxgenAgent.get(`${registry}${purlObj.name}`, {
          responseType: "json",
        });
        repoUrl = normalizeRepositoryUrl(res.body?.crate?.repository);
        break;
      }
      case "pub": {
        registry = process.env.PUB_DEV_URL || "https://pub.dev";
        const endpoint = packageVersion
          ? `${registry}/api/packages/${purlObj.name}/versions/${packageVersion}`
          : `${registry}/api/packages/${purlObj.name}`;
        const res = await cdxgenAgent.get(endpoint, {
          responseType: "json",
          headers: {
            Accept: "application/vnd.pub.v2+json",
          },
        });
        const pubspec = res.body?.pubspec || res.body?.latest?.pubspec || {};
        repoUrl =
          normalizeRepositoryUrl(pubspec.repository) ||
          normalizeRepositoryUrl(pubspec.homepage);
        break;
      }
      default:
        return undefined;
    }
  } catch (_err) {
    return undefined;
  }

  if (!repoUrl) {
    return undefined;
  }
  if (!maybeRemotePath(repoUrl)) {
    if (DEBUG_MODE) {
      console.log(`Ignoring non-remote repository URL '${repoUrl}' from purl lookup.`);
    }
    return undefined;
  }

  return {
    type: purlObj.type,
    registry,
    repoUrl,
  };
}

/**
 * Clean up cloned source directories.
 *
 * @param {string} srcDir directory path to remove
 */
export function cleanupSourceDir(srcDir) {
  if (srcDir && srcDir.startsWith(getTmpDir()) && fs.rmSync) {
    console.log(`Cleaning up ${srcDir}`);
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
}
