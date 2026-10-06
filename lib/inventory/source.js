import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { Purl } from "@cdxgen/cdx-purl";
import { coerce, diff, prerelease } from "semver";

import {
  cdxgenAgent,
  createDryRunError,
  DEBUG_MODE,
  hasDangerousUnicode,
  isDryRun,
  isSecureMode,
  readEnvironmentVariable,
  recordActivity,
} from "../core/activity.js";
import {
  getTmpDir,
  safeMkdtempSync,
  safeRmSync,
  safeSpawnSync,
} from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { isValidDriveRoot, isWin } from "../core/paths.js";
import {
  prefetchEnabled,
  prefetchedResponse,
  prefetchJson,
  withHostRateLimit,
} from "./fetchBatch.js";
import { canonicalPurlFromLooseString } from "./purl.js";

/** Raised when a caller omits a registry helper that the purl type requires. */
class MissingRegistryHelperError extends Error {}

/** Warning emitted for repository URLs resolved from untrusted package registry metadata. */
export const PURL_REGISTRY_LOOKUP_WARNING =
  "Resolved repository URL from package registry metadata. This source can be inaccurate or malicious; review before trusting results.";

/** Purl types supported for source repository resolution. */
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
export function isSafeGitRefName(refName) {
  if (!refName || typeof refName !== "string") {
    return false;
  }
  if (refName.startsWith("-")) {
    return false;
  }
  return /^[A-Za-z0-9._/@+-]+$/.test(refName);
}

function inferGitOperation(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-c" || arg === "--config-env") {
      index += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("-")) {
      continue;
    }
    return arg || "command";
  }
  return "command";
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
  const gitOperation = inferGitOperation(args);
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
    cdxgenActivity: {
      blockedReason: `Dry run mode blocks git ${gitOperation} operations.`,
      gitOperation,
      kind: `git-${gitOperation}`,
      metadata: {
        capability: "git-operation",
      },
    },
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
    readEnvironmentVariable("GIT_ALLOW_PROTOCOL") ||
    readEnvironmentVariable("CDXGEN_GIT_ALLOW_PROTOCOL") ||
    readEnvironmentVariable("CDXGEN_SERVER_GIT_ALLOW_PROTOCOL") ||
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
    readEnvironmentVariable("CDXGEN_GIT_ALLOWED_HOSTS") ||
    readEnvironmentVariable("CDXGEN_SERVER_ALLOWED_HOSTS") ||
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
    readEnvironmentVariable("CDXGEN_ALLOWED_PATHS") ||
    readEnvironmentVariable("CDXGEN_SERVER_ALLOWED_PATHS") ||
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
  if (isDryRun) {
    const error = createDryRunError(
      "clone",
      repoUrl,
      "Dry run mode blocks repository cloning.",
    );
    recordActivity({
      kind: "clone",
      reason: error.message,
      status: "blocked",
      target: repoUrl,
    });
    return path.join(getTmpDir(), `${baseDirName}${path.sep}dry-run-clone`);
  }
  const tempDir = safeMkdtempSync(path.join(getTmpDir(), baseDirName));

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
      console.warn("Skipping branch clone: invalid branch name");
    } else {
      const cloneIndex = gitArgs.indexOf("clone");
      gitArgs.splice(cloneIndex + 1, 0, "--branch", firstBranchStr);
    }
  }
  thoughtLog(
    `Cloning Repo${branch ? ` with branch ${branch}` : ""} to ${tempDir}`,
  );
  const result = hardenedGitCommand(gitArgs);
  if (result.status !== 0) {
    console.error(result.stderr);
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
 * Read a purl supplied as a scan source.
 *
 * People type purls the way their package manager prints versions and URLs:
 * `pkg:cargo/wasi@0.11.0+wasi-snapshot-preview1` or
 * `pkg:npm/foo?vcs_url=git+https://...`. cdx-purl requires those `+` to be
 * escaped, so a purl that does not parse strictly is split on its separators
 * and rebuilt with every component escaped once. The rebuilt purl is then
 * parsed strictly, so validation always inspects cdx-purl's reading of it.
 *
 * @param {string} purlString Package URL as supplied
 * @returns {Purl|undefined} Parsed purl, or undefined when none can be recovered
 */
function parsePurlSourceInput(purlString) {
  try {
    return Purl.parse(purlString);
  } catch {
    // Fall through to the structural rebuild.
  }
  const canonical = canonicalPurlFromLooseString(purlString);
  if (!canonical) {
    return undefined;
  }
  try {
    return Purl.parse(canonical);
  } catch {
    return undefined;
  }
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
  const purlObj = parsePurlSourceInput(purlString);
  if (!purlObj) {
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
 * `fetchPomXmlAsJson` is injected rather than imported because it is
 * maven-specific and lives a layer above this module. Every maven resolution
 * needs it, so it is required rather than optional: omitting it would silently
 * turn every maven purl into an unresolvable one.
 *
 * @param {string} purlString package URL string
 * @param {{ fetchPomXmlAsJson?: Function }} [helpers] injected registry fetchers
 * @returns {Promise<{repoUrl:string|undefined, registry:string|undefined, type:string}|undefined>} resolution result
 */
/**
 * The registry document `resolveGitUrlFromPurl` reads for a purl.
 *
 * Extracted so the batch round and the resolution switch cannot drift apart: a
 * prefetch that spelled a URL even slightly differently would fetch documents
 * nobody reads and leave the switch making its own serial request. Types that
 * need no network (`github`, `bitbucket`, `generic`) and `maven`, whose POM is
 * fetched through an injected helper with its own prefetch, return undefined.
 *
 * @param {Object} purlObj Parsed purl.
 * @returns {{registry: string, url: string, accept?: string}|undefined}
 */
function registryLookupForPurl(purlObj) {
  const packageName = packageNameForLookup(purlObj);
  const packageVersion = purlObj.version;
  switch (purlObj.type) {
    case "npm": {
      const registry =
        readEnvironmentVariable("NPM_URL") || "https://registry.npmjs.org/";
      return { registry, url: `${registry}${packageName}` };
    }
    case "pypi": {
      const registry =
        readEnvironmentVariable("PYPI_URL") || "https://pypi.org/pypi/";
      const suffix = packageVersion
        ? `${purlObj.name}/${packageVersion}/json`
        : `${purlObj.name}/json`;
      return { registry, url: `${registry}${suffix}` };
    }
    case "gem": {
      const v1Url =
        readEnvironmentVariable("RUBYGEMS_V1_URL") ||
        "https://rubygems.org/api/v1/gems/";
      const v2Url =
        readEnvironmentVariable("RUBYGEMS_V2_URL") ||
        "https://rubygems.org/api/v2/rubygems/";
      return {
        registry: packageVersion ? v2Url : v1Url,
        url: packageVersion
          ? `${v2Url}${purlObj.name}/versions/${packageVersion}.json`
          : `${v1Url}${purlObj.name}.json`,
      };
    }
    case "cargo": {
      const registry =
        readEnvironmentVariable("RUST_CRATES_URL") ||
        "https://crates.io/api/v1/crates/";
      return { registry, url: `${registry}${purlObj.name}` };
    }
    case "pub": {
      const registry =
        readEnvironmentVariable("PUB_DEV_URL") || "https://pub.dev";
      return {
        accept: "application/vnd.pub.v2+json",
        registry,
        url: packageVersion
          ? `${registry}/api/packages/${purlObj.name}/versions/${packageVersion}`
          : `${registry}/api/packages/${purlObj.name}`,
      };
    }
    case "composer": {
      const packagistUrl =
        readEnvironmentVariable("PACKAGIST_URL") ||
        "https://repo.packagist.org/p2/";
      const registry = packagistUrl.endsWith("/")
        ? packagistUrl
        : `${packagistUrl}/`;
      return { registry, url: `${registry}${packageName}.json` };
    }
    default:
      return undefined;
  }
}

/**
 * Registry documents, prefetched by {@link prefetchGitUrlSources}.
 *
 * Module state rather than a parameter because `resolveGitUrlFromPurl` takes
 * one purl and is called from three places; threading a map through them would
 * be a wide change for no gain. A miss means the lookup issues its own request.
 */
let gitUrlSourcePrefetch = new Map();

/**
 * Discard prefetched registry documents. Tests only.
 */
export function resetGitUrlSourcePrefetch() {
  gitUrlSourcePrefetch = new Map();
}

/**
 * Prefetch the registry documents a list of purls will be resolved from.
 *
 * `resolveGitUrlFromPurl` takes a single purl, so on its own it can only ever
 * make one request at a time. Callers that know the whole list up front — the
 * predictive audit knows every target before it starts — can hand it over here
 * and have the documents fetched in one round instead.
 *
 * @param {Array<string>} purlStrings Purls about to be resolved. Duplicates,
 *   empties and unparseable entries are fine.
 * @returns {Promise<void>}
 */
export async function prefetchGitUrlSources(purlStrings) {
  if (!prefetchEnabled() || !Array.isArray(purlStrings)) {
    return;
  }
  const requests = [];
  const seen = new Set();
  for (const purlString of purlStrings) {
    const purlObj = parsePurlForSourceResolution(purlString);
    if (!purlObj) {
      continue;
    }
    const lookup = registryLookupForPurl(purlObj);
    if (!lookup || seen.has(lookup.url)) {
      continue;
    }
    seen.add(lookup.url);
    requests.push({
      ...(lookup.accept ? { accept: lookup.accept } : {}),
      url: lookup.url,
    });
  }
  if (!requests.length) {
    return;
  }
  for (const [key, value] of await prefetchJson(requests)) {
    gitUrlSourcePrefetch.set(key, value);
  }
}

/**
 * Read a registry document, from the batch round when it ran.
 *
 * @param {{url: string, accept?: string}} lookup
 * @returns {Promise<Object>} A response-shaped object with a `body`.
 */
async function fetchRegistryDocument(lookup) {
  // A prefetch miss issues the request here instead, so it goes through the
  // same per-host gate the batch pool uses. That matters most for crates.io,
  // whose policy is one request per second however the request was reached.
  return (
    prefetchedResponse(gitUrlSourcePrefetch, lookup.url) ||
    (await withHostRateLimit(
      lookup.url,
      (gate) =>
        cdxgenAgent.get(lookup.url, {
          ...gate,
          ...(lookup.accept ? { headers: { Accept: lookup.accept } } : {}),
          responseType: "json",
        }),
      { deferGate: true },
    ))
  );
}

/**
 * Parse a purl for source resolution, applying the same guards and qualifier
 * normalization {@link resolveGitUrlFromPurl} applies.
 *
 * @param {string} purlString
 * @returns {Object|undefined} Parsed purl, or undefined when unusable.
 */
function parsePurlForSourceResolution(purlString) {
  if (!maybePurlSource(purlString) || validatePurlSource(purlString)) {
    return undefined;
  }
  // Purls in the wild leave `+` unescaped in versions and in qualifier values
  // such as `vcs_url=git+https://`; the shared reader rebuilds them.
  const purlObj = parsePurlSourceInput(purlString);
  if (!purlObj) {
    if (DEBUG_MODE) {
      thoughtLog("Unable to resolve repository URL for purl.", {
        purlString,
      });
    }
    return undefined;
  }
  if (!purlObj?.type || !purlObj?.name) {
    return undefined;
  }
  return purlObj;
}

/**
 * Resolve source repository details for a package from its purl.
 *
 * Queries the package registry (or constructs the URL directly for VCS-hosted
 * purl types) and normalizes the repository or homepage URL found in registry
 * metadata. Network and lookup failures are logged and yield `undefined`.
 *
 * @param {string} purlString Package URL string
 * @param {Object} [helpers={}] Injected registry helpers (e.g. `fetchPomXmlAsJson` required for maven)
 * @returns {Promise<{type: string, registry: string, repoUrl: string, version: string, namespace: string, name: string}|undefined>} Resolved source details, or `undefined` when no remote repository URL could be resolved
 */
export async function resolveGitUrlFromPurl(purlString, helpers = {}) {
  const purlObj = parsePurlForSourceResolution(purlString);
  if (!purlObj) {
    return undefined;
  }

  const packageName = packageNameForLookup(purlObj);
  const packageVersion = purlObj.version;
  let repoUrl;
  let registry;
  const logPurlResolutionError = (err) => {
    const errorMessage = err?.message || String(err);
    const errorDetails = [];
    if (err?.code) {
      errorDetails.push(`code=${err.code}`);
    }
    if (typeof err?.statusCode === "number") {
      errorDetails.push(`status=${err.statusCode}`);
    }
    if (err?.hostname) {
      errorDetails.push(`host=${err.hostname}`);
    }
    const sanitizedRegistry = sanitizeRemoteUrlForLogs(registry);
    console.error(
      `Unable to resolve repository URL for purl '${purlString}'${sanitizedRegistry ? ` using registry '${sanitizedRegistry}'` : ""}: ${errorMessage}${errorDetails.length ? ` (${errorDetails.join(", ")})` : ""}`,
    );
    if (DEBUG_MODE) {
      thoughtLog("Unable to resolve repository URL for purl.", {
        purlString,
        errorMessage,
        errorDetails,
        registry: sanitizedRegistry,
      });
    }
  };

  try {
    switch (purlObj.type) {
      case "npm": {
        const lookup = registryLookupForPurl(purlObj);
        registry = lookup.registry;
        const res = await fetchRegistryDocument(lookup);
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
        const lookup = registryLookupForPurl(purlObj);
        registry = lookup.registry;
        const res = await fetchRegistryDocument(lookup);
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
        const lookup = registryLookupForPurl(purlObj);
        registry = lookup.registry;
        const res = await fetchRegistryDocument(lookup);
        const body = Array.isArray(res.body) ? res.body[0] : res.body;
        repoUrl =
          normalizeRepositoryUrl(body?.metadata?.source_code_uri) ||
          normalizeRepositoryUrl(body?.source_code_uri) ||
          normalizeRepositoryUrl(body?.homepage_uri);
        break;
      }
      case "cargo": {
        const lookup = registryLookupForPurl(purlObj);
        registry = lookup.registry;
        const res = await fetchRegistryDocument(lookup);
        repoUrl = normalizeRepositoryUrl(res.body?.crate?.repository);
        break;
      }
      case "pub": {
        const lookup = registryLookupForPurl(purlObj);
        registry = lookup.registry;
        const res = await fetchRegistryDocument(lookup);
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
          readEnvironmentVariable("MAVEN_CENTRAL_URL") ||
          "https://repo1.maven.org/maven2/";
        registry = mavenCentralUrl.endsWith("/")
          ? mavenCentralUrl
          : `${mavenCentralUrl}/`;
        if (typeof helpers.fetchPomXmlAsJson !== "function") {
          throw new MissingRegistryHelperError(
            "resolveGitUrlFromPurl cannot resolve a maven purl without an injected fetchPomXmlAsJson.",
          );
        }
        const pomJson = await helpers.fetchPomXmlAsJson({
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
        const lookup = registryLookupForPurl(purlObj);
        registry = lookup.registry;
        const res = await fetchRegistryDocument(lookup);
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
    // Network and registry failures are expected and non-fatal. A missing
    // injected helper is a wiring bug in the caller, so it must not be
    // swallowed by the same handler.
    if (err instanceof MissingRegistryHelperError) {
      throw err;
    }
    logPurlResolutionError(err);
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
  const normalizePath = (candidatePath) => {
    if (!candidatePath) {
      return undefined;
    }
    try {
      return fs.realpathSync.native
        ? fs.realpathSync.native(candidatePath)
        : fs.realpathSync(candidatePath);
    } catch {
      return path.resolve(candidatePath);
    }
  };
  const normalizedSrcDir = normalizePath(srcDir);
  const tempRoots = [getTmpDir()];
  if (process.platform !== "win32") {
    tempRoots.push("/tmp");
    tempRoots.push("/private/tmp");
  }
  const normalizedTmpDirs = tempRoots
    .map((candidatePath) => normalizePath(candidatePath))
    .filter(Boolean);
  if (
    normalizedSrcDir &&
    normalizedTmpDirs.some(
      (normalizedTmpDir) =>
        normalizedSrcDir === normalizedTmpDir ||
        normalizedSrcDir.startsWith(`${normalizedTmpDir}${path.sep}`),
    ) &&
    fs.rmSync
  ) {
    thoughtLog(`Cleaning up ${srcDir}`);
    safeRmSync(srcDir, { recursive: true, force: true });
  }
}
