import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { PackageURL } from "packageurl-js";
import { coerce, diff, prerelease } from "semver";

import { thoughtLog } from "./logger.js";
import {
  cdxgenAgent,
  DEBUG_MODE,
  fetchPomXmlAsJson,
  getTmpDir,
  hasDangerousUnicode,
  isSecureMode,
  isValidDriveRoot,
  isWin,
  safeSpawnSync,
} from "./utils.js";

export const PURL_REGISTRY_LOOKUP_WARNING =
  "Resolved repository URL from package registry metadata. This source can be inaccurate or malicious; review before trusting results.";

export const SUPPORTED_PURL_SOURCE_TYPES = [
  "npm",
  "pypi",
  "gem",
  "cargo",
  "pub",
  "github",
  "bitbucket",
  "maven",
  "composer",
  "generic",
];

const MAX_MONOREPO_PACKAGE_JSON_FILES = 2000;
const MAX_MONOREPO_DIRECTORIES = 5000;
const MAX_RELEASE_NOTE_RESOLVES = 50;

/**
 * Build a scoped npm package name.
 *
 * @param {string|undefined} namespace package namespace
 * @param {string|undefined} name package name
 * @returns {string|undefined} scoped package name
 */
function buildScopedNpmPackageName(namespace, name) {
  if (!name) {
    return undefined;
  }
  if (!namespace) {
    return name;
  }
  return `${namespace.startsWith("@") ? namespace : `@${namespace}`}/${name}`;
}

/**
 * Validate git ref names used as branch/tag values.
 *
 * @param {string|undefined} refName branch or tag name
 * @returns {boolean} true if safe
 */
function isSafeGitRefName(refName) {
  if (!refName || typeof refName !== "string") {
    return false;
  }
  if (refName.startsWith("-")) {
    return false;
  }
  return /^[A-Za-z0-9._/@+-]+$/.test(refName);
}

/**
 * Execute git with hardened defaults.
 *
 * @param {string[]} args git arguments
 * @param {Object} options command options
 * @param {string|undefined} options.cwd working directory
 * @returns {Object} spawn result
 */
export function hardenedGitCommand(args, options = {}) {
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
  return safeSpawnSync("git", args, {
    shell: false,
    cwd: options.cwd,
    env,
  });
}

function normalizeTagName(tagName) {
  if (!tagName || typeof tagName !== "string") {
    return undefined;
  }
  return tagName
    .trim()
    .replace(/^refs\/tags\//, "")
    .replace(/\^\{\}$/, "");
}

function releaseTypeFromTags(currentTag, previousTag) {
  const currentVersion = coerce(currentTag || "");
  const previousVersion = coerce(previousTag || "");
  if (!currentVersion || !previousVersion) {
    return "internal";
  }
  if (prerelease(currentVersion.version)?.length) {
    return "pre-release";
  }
  const versionDiff = diff(previousVersion.version, currentVersion.version);
  if (versionDiff === "major") {
    return "major";
  }
  if (versionDiff === "minor") {
    return "minor";
  }
  if (versionDiff === "patch") {
    return "patch";
  }
  return "internal";
}

function parseTagList(output) {
  return (output || "")
    .split("\n")
    .map((line) => normalizeTagName(line))
    .filter((tagName) => isSafeGitRefName(tagName))
    .filter(Boolean);
}

function parseLsRemoteTags(output) {
  const tags = [];
  for (const line of (output || "").split("\n")) {
    const ref = normalizeTagName(line.trim().split(/\s+/)[1]);
    if (ref && isSafeGitRefName(ref)) {
      tags.push(ref);
    }
  }
  return Array.from(new Set(tags)).sort((a, b) => {
    const av = coerce(a || "");
    const bv = coerce(b || "");
    if (av && bv) {
      return bv.compare(av);
    }
    return b.localeCompare(a);
  });
}

function issueTypeFromCommitMessage(message) {
  const normalized = (message || "").toLowerCase();
  if (
    normalized.includes("security") ||
    normalized.includes("cve-") ||
    normalized.includes("vuln")
  ) {
    return "security";
  }
  if (
    normalized.startsWith("fix") ||
    normalized.includes(" bug") ||
    normalized.includes("defect")
  ) {
    return "defect";
  }
  return "enhancement";
}

/**
 * Build CycloneDX release notes from git tags and commits.
 *
 * @param {string|undefined} repoPath local repository path
 * @param {Object} options options carrying release notes hints
 * @returns {Object|undefined} releaseNotes object
 */
export function buildReleaseNotesFromGit(repoPath, options = {}) {
  let currentTag = normalizeTagName(options.releaseNotesCurrentTag);
  let previousTag = normalizeTagName(options.releaseNotesPreviousTag);
  let remoteUrl;
  let localRepoAvailable = false;
  if (repoPath && !maybeRemotePath(repoPath)) {
    const repoCheck = hardenedGitCommand(
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: repoPath,
      },
    );
    localRepoAvailable = repoCheck.status === 0;
    if (localRepoAvailable) {
      const localTagsResult = hardenedGitCommand(
        ["tag", "--sort=-creatordate", "--merged", "HEAD"],
        { cwd: repoPath },
      );
      const localTags = parseTagList(localTagsResult.stdout);
      if (!currentTag && localTags.length) {
        currentTag = localTags[0];
      }
      if (!previousTag && localTags.length > 1) {
        previousTag = localTags.find((t) => t !== currentTag);
      }
      const remoteResult = hardenedGitCommand(
        ["config", "--get", "remote.origin.url"],
        { cwd: repoPath },
      );
      if (remoteResult.status === 0 && remoteResult.stdout) {
        remoteUrl = remoteResult.stdout.toString().trim();
      }
    }
  }
  remoteUrl = remoteUrl || options.releaseNotesGitUrl;
  const remoteUrlValidationError =
    typeof remoteUrl === "string"
      ? validateAndRejectGitSource(remoteUrl)
      : null;
  const canDiscoverRemoteTags =
    (!currentTag || !previousTag) &&
    typeof remoteUrl === "string" &&
    !remoteUrl.startsWith("-") &&
    !remoteUrlValidationError &&
    /github\.com[:/]/i.test(remoteUrl);
  if (canDiscoverRemoteTags) {
    const remoteTagsResult = hardenedGitCommand(
      [
        "-c",
        "alias.ls-remote=",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "safe.bareRepository=explicit",
        "-c",
        "core.hooksPath=/dev/null",
        "ls-remote",
        "--refs",
        "--tags",
        "--",
        remoteUrl,
      ],
      {},
    );
    const remoteTags = parseLsRemoteTags(remoteTagsResult.stdout);
    if (!currentTag && remoteTags.length) {
      currentTag = remoteTags[0];
    }
    if (!previousTag && remoteTags.length > 1) {
      previousTag = remoteTags.find((t) => t !== currentTag);
    }
  }
  if (!currentTag) {
    return undefined;
  }
  if (!isSafeGitRefName(currentTag)) {
    return undefined;
  }
  if (previousTag && !isSafeGitRefName(previousTag)) {
    previousTag = undefined;
  }
  let timestamp;
  if (localRepoAvailable) {
    const tsResult = hardenedGitCommand(
      ["log", "-1", "--format=%cI", currentTag],
      {
        cwd: repoPath,
      },
    );
    if (tsResult.status === 0 && tsResult.stdout) {
      timestamp = tsResult.stdout.toString().trim();
    }
  }
  if (!timestamp) {
    timestamp = new Date().toISOString();
  }
  const resolves = [];
  if (localRepoAvailable && previousTag) {
    const logResult = hardenedGitCommand(
      ["log", "--pretty=format:%H%x09%s", `${previousTag}..${currentTag}`],
      { cwd: repoPath },
    );
    if (logResult.status === 0 && logResult.stdout) {
      // Keep the resolves list bounded to avoid excessive metadata growth.
      for (const line of logResult.stdout
        .toString()
        .split("\n")
        .filter(Boolean)) {
        const [sha, ...rest] = line.split("\t");
        const message = rest.join("\t").trim();
        if (!sha || !message) {
          continue;
        }
        resolves.push({
          type: issueTypeFromCommitMessage(message),
          id: sha.substring(0, 12),
          name: message,
          description: message,
        });
      }
      if (resolves.length > MAX_RELEASE_NOTE_RESOLVES) {
        resolves.length = MAX_RELEASE_NOTE_RESOLVES;
      }
    }
  }
  const tags = [currentTag];
  if (previousTag && previousTag !== currentTag) {
    tags.push(previousTag);
  }
  return {
    type: releaseTypeFromTags(currentTag, previousTag),
    title: `Release notes for ${currentTag}`,
    description: previousTag
      ? `Changes between ${previousTag} and ${currentTag}.`
      : `Release notes for ${currentTag}.`,
    timestamp,
    tags,
    resolves,
  };
}

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
  if (typeof p !== "string") {
    return false;
  }
  if (p === "") {
    return true;
  }
  if (hasDangerousUnicode(p)) {
    return false;
  }
  if (!isWin) {
    return true;
  }
  try {
    const normalized = path.normalize(p);
    if (hasDangerousUnicode(normalized)) {
      return false;
    }
    const { root } = path.parse(normalized);
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
    if (!isSafeGitRefName(firstBranchStr)) {
      console.log("Skipping branch clone: invalid branch name");
    } else {
      const cloneIndex = gitArgs.indexOf("clone");
      gitArgs.splice(cloneIndex + 1, 0, "--branch", firstBranchStr);
    }
  }
  console.log(
    `Cloning Repo${branch ? ` with branch ${branch}` : ""} to ${tempDir}`,
  );
  const result = hardenedGitCommand(gitArgs);
  if (result.status !== 0) {
    console.log(result.stderr);
  }

  return tempDir;
}

/**
 * Sanitize remote URL for logging.
 *
 * @param {string|undefined} remoteUrl Repository URL
 * @returns {string|undefined} sanitized URL
 */
export function sanitizeRemoteUrlForLogs(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== "string") {
    return remoteUrl;
  }
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch (_err) {
    return remoteUrl;
  }
}

/**
 * Find a matching git ref for a package version.
 *
 * @param {string} repoUrl Repository URL
 * @param {Object|undefined} purlResolution purl resolution metadata
 * @returns {string|undefined} matching tag or branch reference
 */
export function findGitRefForPurlVersion(repoUrl, purlResolution) {
  const packageVersion = purlResolution?.version;
  if (!packageVersion) {
    return undefined;
  }
  const purlType = purlResolution?.type;
  const purlNamespace = purlResolution?.namespace;
  const purlName = purlResolution?.name;
  const refCandidates = [packageVersion, `v${packageVersion}`];
  if (purlType === "npm" && purlName) {
    const scopedName = buildScopedNpmPackageName(purlNamespace, purlName);
    refCandidates.push(
      `${purlName}@${packageVersion}`,
      `${scopedName}@${packageVersion}`,
      `${purlName}-v${packageVersion}`,
      `${scopedName}-v${packageVersion}`,
    );
  }
  const filteredCandidates = [...new Set(refCandidates)].filter((candidate) =>
    isSafeGitRefName(candidate),
  );
  if (!repoUrl || repoUrl.startsWith("-")) {
    return undefined;
  }
  if (validateAndRejectGitSource(repoUrl)) {
    return undefined;
  }
  const result = hardenedGitCommand(
    [
      "-c",
      "alias.ls-remote=",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "safe.bareRepository=explicit",
      "-c",
      "core.hooksPath=/dev/null",
      "ls-remote",
      "--refs",
      "--tags",
      "--heads",
      "--",
      repoUrl,
    ],
    {},
  );
  if (result.status !== 0 || !result.stdout) {
    return undefined;
  }
  const availableRefs = result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/(?:tags|heads)\//, ""));
  for (const candidate of filteredCandidates) {
    if (availableRefs.includes(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Find the best source directory for purl-based npm monorepo scans.
 *
 * @param {string} srcDir cloned source directory
 * @param {Object|undefined} purlResolution purl resolution metadata
 * @returns {string|undefined} preferred source directory
 */
export function resolvePurlSourceDirectory(srcDir, purlResolution) {
  if (purlResolution?.type !== "npm" || !purlResolution?.name || !srcDir) {
    return undefined;
  }
  const purlNamespace = purlResolution?.namespace;
  const packageNameCandidates = [purlResolution.name];
  if (purlNamespace) {
    packageNameCandidates.push(
      `${purlNamespace}/${purlResolution.name}`,
      buildScopedNpmPackageName(purlNamespace, purlResolution.name),
    );
  }
  const uniquePackageNameCandidates = [
    ...new Set(packageNameCandidates.filter(Boolean)),
  ];
  const skipDirectories = new Set([
    ".git",
    ".idea",
    ".vscode",
    "build",
    "dist",
    "node_modules",
    "out",
    "target",
    "vendor",
  ]);
  const queue = [srcDir];
  const matches = new Set();
  let packageJsonCount = 0;
  let currentIndex = 0;
  while (
    currentIndex < queue.length &&
    packageJsonCount < MAX_MONOREPO_PACKAGE_JSON_FILES
  ) {
    if (currentIndex >= MAX_MONOREPO_DIRECTORIES) {
      break;
    }
    const currentDir = queue[currentIndex];
    currentIndex += 1;
    if (!currentDir) {
      continue;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, {
        withFileTypes: true,
      });
    } catch (_err) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirectories.has(entry.name)) {
          continue;
        }
        queue.push(path.join(currentDir, entry.name));
        continue;
      }
      if (!entry.isFile() || entry.name !== "package.json") {
        continue;
      }
      packageJsonCount += 1;
      const packageJsonPath = path.join(currentDir, entry.name);
      try {
        const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
        if (uniquePackageNameCandidates.includes(pkgJson?.name)) {
          matches.add(currentDir);
        }
      } catch (_err) {
        // Ignore invalid package.json files in monorepos.
      }
    }
  }
  if (!matches.size) {
    return undefined;
  }
  const dedupedMatches = [...matches];
  dedupedMatches.sort((a, b) => a.length - b.length);
  return dedupedMatches[0];
}

/**
 * Normalize repository URL values from registry metadata to a cloneable URL.
 *
 * @param {string|undefined} candidateUrl raw URL candidate
 * @returns {string|undefined} normalized URL
 */
function normalizeRepositoryUrl(candidateUrl) {
  if (!candidateUrl || typeof candidateUrl !== "string") {
    return undefined;
  }
  let repoUrl = candidateUrl.trim();
  if (!repoUrl) {
    return undefined;
  }
  if (/^git\s+/.test(repoUrl)) {
    repoUrl = repoUrl.replace(/^git\s+/, "git+");
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
  if (
    !repoUrl.includes("://") &&
    /^(?:[^/]+\.)?github\.com\/.+/.test(repoUrl)
  ) {
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

/**
 * Normalize repository URL values represented as string/object metadata fields.
 *
 * @param {string|Object|undefined} candidate repository field value
 * @returns {string|undefined} normalized URL
 */
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

/**
 * Build a cloneable repository URL from known download URL patterns.
 *
 * @param {string|undefined} candidateUrl raw download URL
 * @returns {string|undefined} normalized repository URL
 */
function normalizeDownloadRepositoryUrl(candidateUrl) {
  const normalized = normalizeRepositoryUrl(candidateUrl);
  if (!normalized) {
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_err) {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (parsed.hostname === "github.com" && segments.length >= 2) {
    return `https://github.com/${segments[0]}/${segments[1]}`;
  }
  if (parsed.hostname === "codeload.github.com" && segments.length >= 2) {
    return `https://github.com/${segments[0]}/${segments[1]}`;
  }
  if (parsed.hostname === "gitlab.com" && segments.length >= 2) {
    return `https://gitlab.com/${segments[0]}/${segments[1]}`;
  }
  if (normalized.endsWith(".git")) {
    return normalized;
  }
  return undefined;
}

/**
 * Build package name key for registry lookup from a parsed package URL.
 *
 * @param {PackageURL} purlObj parsed package URL object
 * @returns {string} package name suitable for registry API lookup
 */
function packageNameForLookup(purlObj) {
  const namespace = purlObj.namespace;
  if (!namespace) {
    return purlObj.name;
  }
  return `${namespace}/${purlObj.name}`;
}

/**
 * Validate package URL source input and return an error object when invalid.
 *
 * @param {string} purlString package URL string
 * @returns {{status:number,error:string,details:string}|null} validation error or null
 */
export function validatePurlSource(purlString) {
  if (!maybePurlSource(purlString)) {
    return null;
  }
  let purlObj;
  try {
    purlObj = PackageURL.fromString(purlString);
  } catch (_err) {
    return {
      status: 400,
      error: "Invalid purl source",
      details: "The provided package URL is malformed.",
    };
  }
  const purlType = purlObj?.type;
  if (!SUPPORTED_PURL_SOURCE_TYPES.includes(purlType)) {
    return {
      status: 400,
      error: "Unsupported purl source type",
      details: `Supported purl types for automatic git URL detection: ${SUPPORTED_PURL_SOURCE_TYPES.join(", ")}.`,
    };
  }
  if (!purlObj?.name) {
    return {
      status: 400,
      error: "Invalid purl source",
      details: "The provided package URL does not include a package name.",
    };
  }
  const purlQualifiers = purlObj?.qualifiers || {};
  if (
    ["github", "bitbucket", "maven", "composer"].includes(purlType) &&
    !purlObj?.namespace
  ) {
    return {
      status: 400,
      error: "Invalid purl source",
      details: `The provided ${purlType} package URL must include a namespace.`,
    };
  }
  if (purlType === "maven" && !purlObj?.version) {
    return {
      status: 400,
      error: "Invalid purl source",
      details: "The provided maven package URL must include a version.",
    };
  }
  if (
    purlType === "generic" &&
    !purlQualifiers.vcs_url &&
    !purlQualifiers.download_url
  ) {
    return {
      status: 400,
      error: "Unsupported generic purl source",
      details:
        "generic purl sources must include a vcs_url or download_url qualifier.",
    };
  }
  return null;
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
 * - github -> github.com/{namespace}/{name}
 * - bitbucket -> bitbucket.org/{namespace}/{name}
 * - maven  -> repo1.maven.org POM scm metadata
 * - composer -> repo.packagist.org p2 metadata
 * - generic -> qualifiers: vcs_url, download_url
 *
 * @param {string} purlString package URL string
 * @returns {Promise<{repoUrl:string|undefined, registry:string|undefined, type:string}|undefined>} resolution result
 */
export async function resolveGitUrlFromPurl(purlString) {
  if (!maybePurlSource(purlString)) {
    return undefined;
  }
  const validationError = validatePurlSource(purlString);
  if (validationError) {
    return undefined;
  }
  let purlObj;
  try {
    purlObj = PackageURL.fromString(purlString);
  } catch (err) {
    if (DEBUG_MODE) {
      const errorMessage = err?.message || String(err);
      thoughtLog("Unable to resolve repository URL for purl.", {
        purlString,
        errorMessage,
      });
    }
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
        const v1Url =
          process.env.RUBYGEMS_V1_URL || "https://rubygems.org/api/v1/gems/";
        const v2Url =
          process.env.RUBYGEMS_V2_URL ||
          "https://rubygems.org/api/v2/rubygems/";
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
        registry =
          process.env.RUST_CRATES_URL || "https://crates.io/api/v1/crates/";
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
      case "github": {
        registry = "https://github.com";
        if (purlObj.namespace) {
          repoUrl = normalizeRepositoryUrl(
            `${registry}/${purlObj.namespace}/${purlObj.name}`,
          );
        }
        break;
      }
      case "bitbucket": {
        registry = "https://bitbucket.org";
        if (purlObj.namespace) {
          repoUrl = normalizeRepositoryUrl(
            `${registry}/${purlObj.namespace}/${purlObj.name}`,
          );
        }
        break;
      }
      case "maven": {
        if (!purlObj.namespace || !packageVersion) {
          break;
        }
        const mavenCentralUrl =
          process.env.MAVEN_CENTRAL_URL || "https://repo1.maven.org/maven2/";
        registry = mavenCentralUrl.endsWith("/")
          ? mavenCentralUrl
          : `${mavenCentralUrl}/`;
        const pomJson = await fetchPomXmlAsJson({
          urlPrefix: registry,
          group: purlObj.namespace,
          name: purlObj.name,
          version: packageVersion,
        });
        repoUrl =
          normalizeRepositoryUrl(pomJson?.scm?.url?._) ||
          normalizeRepositoryUrl(pomJson?.scm?.connection?._) ||
          normalizeRepositoryUrl(pomJson?.scm?.developerConnection?._);
        break;
      }
      case "composer": {
        const packagistUrl =
          process.env.PACKAGIST_URL || "https://repo.packagist.org/p2/";
        registry = packagistUrl.endsWith("/")
          ? packagistUrl
          : `${packagistUrl}/`;
        const endpoint = `${registry}${packageName}.json`;
        const res = await cdxgenAgent.get(endpoint, {
          responseType: "json",
        });
        const packageVersions = res.body?.packages?.[packageName];
        if (!Array.isArray(packageVersions) || !packageVersions.length) {
          break;
        }
        const selectedVersion = packageVersion
          ? packageVersions.find(
              (v) =>
                v?.version === packageVersion ||
                v?.version_normalized === packageVersion,
            )
          : packageVersions[0];
        repoUrl =
          normalizeRepositoryUrl(selectedVersion?.source?.url) ||
          normalizeRepositoryUrl(selectedVersion?.homepage);
        break;
      }
      case "generic": {
        const genericVcsUrl = purlObj.qualifiers?.vcs_url;
        const genericDownloadUrl = purlObj.qualifiers?.download_url;
        repoUrl =
          normalizeRepositoryUrl(genericVcsUrl) ||
          normalizeDownloadRepositoryUrl(genericDownloadUrl);
        break;
      }
      default:
        return undefined;
    }
  } catch (err) {
    if (DEBUG_MODE) {
      const errorMessage = err?.message || String(err);
      thoughtLog("Unable to resolve repository URL for purl.", {
        purlString,
        errorMessage,
      });
    }
    return undefined;
  }

  if (!repoUrl) {
    return undefined;
  }
  if (!maybeRemotePath(repoUrl)) {
    if (DEBUG_MODE) {
      console.log(
        `Ignoring non-remote repository URL '${repoUrl}' from purl lookup.`,
      );
    }
    return undefined;
  }

  return {
    type: purlObj.type,
    registry,
    repoUrl,
    version: purlObj.version,
    namespace: purlObj.namespace,
    name: purlObj.name,
  };
}

/**
 * Clean up cloned source directories.
 *
 * @param {string} srcDir directory path to remove
 */
export function cleanupSourceDir(srcDir) {
  if (srcDir?.startsWith(getTmpDir()) && fs.rmSync) {
    console.log(`Cleaning up ${srcDir}`);
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
}
