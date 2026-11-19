import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { arch, homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";

import { PackageURL } from "packageurl-js";
import { compareLoose } from "semver";

import {
  createPhpRuntimeComponent,
  parsePhpReportedVersion,
} from "./phpBuildInfo.js";
import {
  CARGO_CMD,
  COMPOSER_CMD,
  DEBUG_MODE,
  DOTNET_CMD,
  GCC_CMD,
  GO_CMD,
  getJavaCommand,
  getPythonCommand,
  getRuntimeInformation,
  getTmpDir,
  isMac,
  isSecureMode,
  isWin,
  MAX_BUFFER,
  NPM_CMD,
  PHP_CMD,
  RUBY_CMD,
  RUSTC_CMD,
  readEnvironmentVariable,
  SWIFT_CMD,
  safeExistsSync,
  safeSpawnSync,
} from "./utils.js";

export const GIT_COMMAND = process.env.GIT_CMD || "git";

/**
 * Config overrides applied (via `-c`) to every git invocation to neutralize
 * repository-controlled code-execution vectors. A cloned/untrusted repo can set
 * these in its local `.git/config`, so we force-disable them:
 *  - `core.fsmonitor=false`     — a repo-set fsmonitor value is a command git runs.
 *  - `core.hooksPath=/dev/null` — prevents any hook script from executing.
 *  - `safe.bareRepository=explicit` — avoids operating on an embedded bare repo.
 *  - `core.multiPackIndex=false` — a multi-pack-index names its packs by path,
 *    so a crafted one would read objects from a pack of another repository.
 *  - `gpg.program`, `gpg.ssh.program` — `%G?` in a log format verifies
 *    signatures by running these, so pin them to the tools on PATH instead of
 *    a program named by the repo.
 *  - `gpg.x509.program=/dev/null` — X.509 signatures are not verified. gpgsm
 *    imports the certificates a signature carries into the user's keyring and
 *    has dirmngr fetch the revocation list from the URL the signer's own
 *    certificate names, and git cannot tell it to stay offline. Such commits
 *    report `N`.
 *  - `log.showSignature=false` — a repo-set value makes every `git log`
 *    verify signatures and print the verifier's messages, whatever its format.
 * `-c` overrides take precedence over the repo-local config. Diff-producing
 * commands (`git show`/`git diff`) additionally pass `--no-ext-diff`/
 * `--no-textconv` to block `.gitattributes`-driven external diff and textconv
 * drivers, which are executed as shell commands.
 */
const GIT_HARDENING_CONFIG_ARGS = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "safe.bareRepository=explicit",
  "-c",
  "core.multiPackIndex=false",
  "-c",
  "gpg.program=gpg",
  "-c",
  "gpg.ssh.program=ssh-keygen",
  "-c",
  "gpg.x509.program=/dev/null",
  "-c",
  "log.showSignature=false",
]);

/**
 * Environment applied to every git invocation. Disables interactive prompts and,
 * in secure mode, ignores system/global git config so only the hardened `-c`
 * overrides and the (untrusted) repo config remain, mirroring hardenedGitCommand.
 *
 * @returns {Object} environment for spawning git
 */
function hardenedGitEnv() {
  // These commands only read the local repository. A partial clone would
  // otherwise fetch missing objects through the repo's own remote and
  // core.sshCommand settings, so turn lazy fetching and every transport off.
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "cdxgen-no-network",
  };
  if (isSecureMode) {
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = "/dev/null";
  }
  return env;
}

// sdkman tool aliases
export const SDKMAN_JAVA_TOOL_ALIASES = {
  java8: process.env.JAVA8_TOOL || "8.0.504-zulu", // Temurin no longer offers java8 :(
  java11: process.env.JAVA11_TOOL || "11.0.32-tem",
  java17: process.env.JAVA17_TOOL || "17.0.20-tem",
  java21: process.env.JAVA21_TOOL || "21.0.12-tem",
  java22: process.env.JAVA22_TOOL || "22.0.2-tem",
  java23: process.env.JAVA23_TOOL || "23.0.2-tem",
  java24: process.env.JAVA24_TOOL || "24.0.2-tem",
  java25: process.env.JAVA25_TOOL || "25.0.4-tem",
  java26: process.env.JAVA26_TOOL || "26.0.2-tem",
};

/**
 * Retrieves a git config item
 * @param {string} configKey Git config key
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export function getGitConfig(configKey, dir) {
  // A repo-set include.path would answer from the config of another repository.
  return execGitCommand(dir, ["config", "--no-includes", "--get", configKey]);
}

/**
 * Retrieves the git origin url
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export function getOriginUrl(dir) {
  return getGitConfig("remote.origin.url", dir);
}

/**
 * Retrieves the git branch name
 * @param {string} configKey Git config key
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export function getBranch(_configKey, dir) {
  return execGitCommand(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * Retrieves the tree and parent hash for a git repo
 * @param {string} dir repo directory
 *
 * @returns Output from git cat-file or undefined
 */
export function gitTreeHashes(dir) {
  const treeHashes = {};
  const output = execGitCommand(dir, ["cat-file", "commit", "HEAD"]);
  if (output) {
    output.split("\n").forEach((l) => {
      l = l.replace("\r", "");
      if (l === "\n" || l.startsWith("#")) {
        return;
      }
      if (l.startsWith("tree") || l.startsWith("parent")) {
        const tmpA = l.split(" ");
        if (tmpA && tmpA.length === 2) {
          treeHashes[tmpA[0]] = tmpA[1];
        }
      }
    });
  }
  return treeHashes;
}

/**
 * Retrieves the files git tracks under a directory at HEAD. Only the
 * directory's own subtree is listed, with names relative to it, so a scan of
 * one directory of a larger repository does not record the rest of that
 * repository.
 *
 * @param {string} dir directory inside a git working tree
 *
 * @returns {Object[]} files with their blob hash, name, OmniBOR id and SWHID
 */
export function listFiles(dir) {
  const filesList = [];
  const output = execGitCommand(dir, ["ls-tree", "-l", "-r", "HEAD"]);
  if (output) {
    output.split("\n").forEach((l) => {
      l = l.replace("\r", "");
      if (l === "\n" || l.startsWith("#")) {
        return;
      }
      const tmpA = l.split(" ");
      if (tmpA && tmpA.length >= 5) {
        const lastParts = tmpA[tmpA.length - 1].split("\t");
        filesList.push({
          hash: tmpA[2],
          name: lastParts[lastParts.length - 1],
          omniborId: `gitoid:blob:sha1:${tmpA[2]}`,
          swhid: `swh:1:rev:${tmpA[2]}`,
        });
      }
    });
  }
  return filesList;
}

/**
 * Whether `child` is `parent` or inside it. Only a whole `..` segment leaves
 * the parent: an entry named `..name` is inside it.
 *
 * @param {string} child Path to test
 * @param {string} parent Directory
 * @returns {boolean}
 */
function isInsideDir(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * Run git with the hardening `-c` overrides and environment and return what
 * it writes to standard output.
 *
 * @param {string} dir Directory to run git in
 * @param {Array} args arguments to git command
 *
 * @returns {string|undefined} standard output without its final line break,
 * or undefined when git could not run or exited with a non-zero status
 */
function gitStdout(dir, args) {
  const [command, ...commandArgs] = GIT_COMMAND.trim().split(" ");
  const result = safeSpawnSync(
    command,
    [...commandArgs, ...GIT_HARDENING_CONFIG_ARGS, ...args],
    {
      cwd: dir,
      shell: isWin,
      maxBuffer: MAX_BUFFER * 2,
      env: hardenedGitEnv(),
    },
  );
  if (result.status !== 0 || result.error || !result.stdout) {
    return undefined;
  }
  return result.stdout.toString().replace(/\r?\n$/, "");
}

/**
 * A `.git` file or a list of reftable tables larger than this is not read. git
 * itself reads no more than this much of a `.git` file.
 */
const MAX_GIT_POINTER_BYTES = 1024 * 1024;

/**
 * Marks a byte sequence that is not valid UTF-8 in a decoded path. Such a path
 * does not lead back to the file it was read from.
 */
const UNDECODABLE = "\uFFFD";

/**
 * Resolve a path to its canonical form, following symbolic links.
 *
 * @param {string} path Path that exists
 *
 * @returns {string} Real path
 */
function realPathOf(path) {
  return realpathSync.native ? realpathSync.native(path) : realpathSync(path);
}

/**
 * Read the path a git pointer file names: the `gitdir: <path>` line of a
 * `.git` file, or the `gitdir` file in the git directory of a linked worktree.
 *
 * @param {string} pointerFile File to read
 * @param {string} [prefix] Text the path follows
 *
 * @returns {string|undefined} Real path the file names, or undefined when it
 * is not such a file
 */
function readGitPointer(pointerFile, prefix = "") {
  const stats = lstatSync(pointerFile);
  if (!stats.isFile() || stats.size > MAX_GIT_POINTER_BYTES) {
    return undefined;
  }
  const text = readFileSync(pointerFile, "utf-8");
  if (!text.startsWith(prefix)) {
    return undefined;
  }
  return realPathOf(
    resolve(dirname(pointerFile), text.slice(prefix.length).trim()),
  );
}

/**
 * Whether the git directory that the `.git` file of a working tree names says
 * in turn that it belongs to that working tree. The `.git` file alone proves
 * nothing: the tree under analysis wrote it and can name any repository of
 * the host.
 *
 * @param {string} gitDir Real path of the git directory
 * @param {string} commonDir Real path of its common directory
 * @param {string} workTree Real path of the working tree git uses with it
 *
 * @returns {boolean} true for the git directory of a linked worktree or of a
 * submodule that is checked out at the working tree
 */
function isGitDirOfWorkTree(gitDir, commonDir, workTree) {
  const dotGit = join(workTree, ".git");
  if (readGitPointer(dotGit, "gitdir: ") !== gitDir) {
    return false;
  }
  if (gitDir !== commonDir) {
    // Linked worktree: <repo>/.git/worktrees/<id>/gitdir names <workTree>/.git
    return (
      dirname(gitDir) === join(commonDir, "worktrees") &&
      readGitPointer(join(gitDir, "gitdir")) === dotGit
    );
  }
  // Submodule: core.worktree of <superproject>/.git/modules/<name>/config
  // names the working tree.
  const coreWorktree = gitStdout(workTree, [
    "config",
    "--no-includes",
    "--get",
    "core.worktree",
  ]);
  return (
    !!coreWorktree && realPathOf(resolve(gitDir, coreWorktree)) === workTree
  );
}

/**
 * Whether the table list of a reftable ref store names a file outside the
 * store. git opens whatever path a line of `tables.list` spells.
 *
 * @param {string} tablesList Real path of a `tables.list` file
 *
 * @returns {boolean} true when a line is more than a file name
 */
function listsForeignTables(tablesList) {
  const stats = statSync(tablesList);
  if (!stats.isFile() || stats.size > MAX_GIT_POINTER_BYTES) {
    return true;
  }
  const text = readFileSync(tablesList, "utf-8");
  return text.includes("/") || text.includes("\\");
}

/**
 * Whether everything git reads from a git directory is stored in it or in its
 * working tree: no objects are borrowed through `objects/info/alternates`, no
 * entry is a symbolic link that leads anywhere else, and no reftable list
 * names a table elsewhere. Every entry is checked, because a ref can name any
 * file of the git directory: `ref: ORIG_HEAD` reads one at its top, and
 * `ref: hooks/HEAD` one in a hooks directory that is a link to another
 * repository. A link into the working tree, which is where hooks are often
 * kept, leads to files of the tree under analysis and is followed.
 *
 * @param {string} gitDir Real path of the git directory
 * @param {string} commonDir Real path of its common directory
 * @param {string} workTree Real path of the working tree
 *
 * @returns {boolean} true when the repository refers to nothing outside itself
 */
function isSelfContainedGitDir(gitDir, commonDir, workTree) {
  if (safeExistsSync(join(commonDir, "objects", "info", "alternates"))) {
    return false;
  }
  const pendingDirs = [...new Set([gitDir, commonDir])];
  const walkedDirs = new Set(pendingDirs);
  while (pendingDirs.length) {
    const currentDir = pendingDirs.pop();
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      let isDirectory = entry.isDirectory();
      const isLink = entry.isSymbolicLink();
      const isTablesList = entry.name.toLowerCase() === "tables.list";
      // Most entries are loose objects: plain files that need no further look.
      if (!isDirectory && !isLink && !isTablesList) {
        continue;
      }
      // The entry cannot be opened by a name that does not decode.
      if (entry.name.includes(UNDECODABLE)) {
        return false;
      }
      let entryPath = join(currentDir, entry.name);
      if (isLink) {
        try {
          entryPath = realPathOf(entryPath);
        } catch (err) {
          if (err.code === "ENOENT") {
            // git cannot read through a link to nothing either
            continue;
          }
          throw err;
        }
        if (
          !isInsideDir(entryPath, commonDir) &&
          !isInsideDir(entryPath, workTree)
        ) {
          return false;
        }
        isDirectory = statSync(entryPath).isDirectory();
      }
      if (isDirectory) {
        if (!walkedDirs.has(entryPath)) {
          walkedDirs.add(entryPath);
          pendingDirs.push(entryPath);
        }
      } else if (isTablesList && listsForeignTables(entryPath)) {
        return false;
      }
    }
  }
  return true;
}

/** @type {Set<string>} Directories the warning below was printed for */
const skippedGitDirs = new Set();

/**
 * Forget the directories isOwnGitRepository has warned about, so that a
 * later check of the same directory warns again.
 */
export function resetSkippedGitDirs() {
  skippedGitDirs.clear();
}

/**
 * Whether git finds a repository from a directory that is the directory's own.
 *
 * Which repository git reads is decided by files of the tree under analysis,
 * which is untrusted: a `.git` file or symbolic link, `commondir`,
 * `core.worktree`, `objects/info/alternates` and symbolic links below `.git`
 * can each name a path anywhere on the host, and the metadata of whatever
 * repository lives there would end up in the BOM. A repository is therefore
 * read only when it is the `.git` directory of the working tree around the
 * directory, or the git directory of a linked worktree or submodule that names
 * that working tree in return, and when it refers to nothing outside itself.
 *
 * Reference and shared clones, a separate git directory and links that leave
 * `.git` are legitimate layouts that fail this test. The operator, who knows
 * where the tree came from, accepts them with
 * CDXGEN_GIT_ALLOW_EXTERNAL_GITDIR=true. A project config file cannot.
 *
 * The answer is not remembered: a caller may scan the same path again after
 * its content has changed.
 *
 * @param {string} dir Directory git is about to run in
 * @param {boolean} [topLevelOnly] Also require the directory to be the top of
 * the working tree, which is where git opens the repository of a submodule
 *
 * @returns {boolean} false when git finds no repository from the directory, or
 * one that is not the directory's own
 */
export function isOwnGitRepository(dir, topLevelOnly = false) {
  if (
    ["true", "1"].includes(
      readEnvironmentVariable("CDXGEN_GIT_ALLOW_EXTERNAL_GITDIR"),
    )
  ) {
    return true;
  }
  // --show-cdup prints a line of its own, an empty one at the top level, so
  // inside a working tree the answer is always these four lines.
  const output = gitStdout(dir, [
    "rev-parse",
    "--absolute-git-dir",
    "--git-common-dir",
    "--show-cdup",
    "--is-inside-work-tree",
  ]);
  // No answer does not mean that no git command can read a repository from
  // here: `git config` is content with less than rev-parse, and git enters a
  // submodule without the checks it makes on the way into a repository.
  if (!output) {
    return false;
  }
  let isOwn = false;
  try {
    // A carriage return is part of a file name everywhere but on Windows.
    const lines = output.split(isWin ? /\r?\n/ : "\n");
    if (
      lines.length === 4 &&
      lines[3] === "true" &&
      !output.includes(UNDECODABLE) &&
      !(topLevelOnly && lines[2])
    ) {
      const realDir = realPathOf(resolve(dir || "."));
      const gitDir = realPathOf(lines[0]);
      const commonDir = realPathOf(resolve(realDir, lines[1]));
      const workTree = resolve(realDir, lines[2]);
      const dotGit = join(workTree, ".git");
      isOwn =
        (lstatSync(dotGit).isDirectory()
          ? gitDir === dotGit && commonDir === dotGit
          : isGitDirOfWorkTree(gitDir, commonDir, workTree)) &&
        isSelfContainedGitDir(gitDir, commonDir, workTree);
    }
  } catch (_err) {
    // a path that does not resolve cannot be vouched for
  }
  const absDir = resolve(dir || ".");
  if (!isOwn && !skippedGitDirs.has(absDir)) {
    skippedGitDirs.add(absDir);
    console.warn(
      `Git metadata of ${absDir} is left out: its repository is not kept in the working tree's own .git directory, or borrows objects or files from outside it. Set CDXGEN_GIT_ALLOW_EXTERNAL_GITDIR=true if you trust this tree and expect such a layout (separate git directory, alternates, symbolic links below .git).`,
    );
  }
  return isOwn;
}

/**
 * Execute a git command
 *
 * @param {string} dir Repo directory
 * @param {Array} args arguments to git command
 *
 * @returns Output from the git command, or undefined when the directory has no
 * repository of its own (see isOwnGitRepository)
 */
export function execGitCommand(dir, args) {
  if (!isOwnGitRepository(dir)) {
    return undefined;
  }
  // Prepend hardening `-c` overrides before the subcommand and run git with a
  // hardened environment so a scanned/untrusted repo cannot execute hooks,
  // fsmonitor commands, or config-driven scripts.
  return getCommandOutput(
    GIT_COMMAND,
    dir,
    [...GIT_HARDENING_CONFIG_ARGS, ...args],
    {
      env: hardenedGitEnv(),
    },
  );
}

/**
 * Retrieves the author names and emails from the git commit log
 *
 * @param {string} dir Repo directory
 * @param {number} maxCount Maximum number of commits to retrieve
 *
 * @returns {Array<{name: string, email: string}>} Array of authors
 */
export function gitLogAuthors(dir, maxCount = 20) {
  const count = safeGitLogCount(maxCount);
  const output = execGitCommand(dir, [
    "log",
    "-n",
    `${count}`,
    "--format=%an|%ae",
  ]);
  if (!output) {
    return [];
  }
  const authors = [];
  const lines = output.split("\n");
  const seen = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    const parts = trimmed.split("|");
    const name = parts[0]?.trim() || "";
    const email = parts[1]?.trim() || "";
    authors.push({ name, email });
  }
  return authors;
}

/**
 * Retrieves the commit logs for a git repo, returning hashes and messages
 *
 * @param {string} dir Repo directory
 * @param {number} maxCount Maximum number of commits to retrieve
 *
 * @returns {Array<{hash: string, message: string}>} Array of commit objects
 */
export function gitLogTrailers(dir, maxCount = 20) {
  const count = safeGitLogCount(maxCount);
  // %x1e (record separator) is a control character that cannot appear in a
  // commit message, so it is a safe boundary between commits.
  const output = execGitCommand(dir, [
    "log",
    "-n",
    `${count}`,
    "--format=%H%n%B%x1e",
  ]);
  if (!output) {
    return [];
  }
  const commits = [];
  const parts = output.split("\x1e");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const lines = trimmed.split("\n");
    const hash = lines[0]?.trim();
    const message = lines.slice(1).join("\n").trim();
    if (hash) {
      commits.push({ hash, message });
    }
  }
  return commits;
}

/**
 * Collect Java version and installed modules
 *
 * @param {string} dir Working directory
 * @returns Object containing the java details
 */
export function collectJavaInfo(dir) {
  const versionDesc = getCommandOutput(getJavaCommand(), dir, ["--version"]);
  const moduleDesc =
    getCommandOutput(getJavaCommand(), dir, ["--list-modules"]) || "";
  if (versionDesc) {
    return {
      type: "platform",
      name: "java",
      version: versionDesc.split("\n")[0].replace("java ", ""),
      description: versionDesc,
      properties: [
        {
          name: "java:modules",
          value: moduleDesc.replaceAll("\n", ", "),
        },
      ],
    };
  }
  return undefined;
}

/**
 * Collect dotnet version
 *
 * @param {string} dir Working directory
 * @returns Object containing dotnet details
 */
export function collectDotnetInfo(dir) {
  const versionDesc = getCommandOutput(DOTNET_CMD, dir, ["--version"]);
  const moduleDesc =
    getCommandOutput(DOTNET_CMD, dir, ["--list-runtimes"]) || "";
  if (versionDesc) {
    return {
      type: "platform",
      name: "dotnet",
      version: versionDesc.trim(),
      description: moduleDesc.replaceAll("\n", "\\n"),
    };
  }
  return undefined;
}

/**
 * Collect python version
 *
 * @param {string} dir Working directory
 * @returns Object containing python details
 */
export function collectPythonInfo(dir) {
  const versionDesc = getCommandOutput(getPythonCommand(), dir, [
    "-S",
    "--version",
  ]);
  const moduleDesc =
    getCommandOutput(getPythonCommand(), dir, [
      "-I",
      "-m",
      "pip",
      "--version",
    ]) || "";
  if (versionDesc) {
    return {
      type: "platform",
      name: "python",
      version: versionDesc.replace("Python ", ""),
      description: moduleDesc.replaceAll("\n", "\\n"),
    };
  }
  return undefined;
}

/**
 * Collect node runtime version
 *
 * @param {string} dir Working directory
 * @returns {Object} Object containing node details
 */
export function collectNodeInfo(dir) {
  const runtimeInfo = getRuntimeInformation();
  const nodeInfo = {
    type: "platform",
    name: runtimeInfo.runtime,
    version: runtimeInfo.version,
    components: runtimeInfo.components,
  };
  const moduleDesc = getCommandOutput(NPM_CMD, dir, ["--version"]);
  if (moduleDesc) {
    nodeInfo.description = `npm: ${moduleDesc}`;
  }
  return nodeInfo;
}

/**
 * Collect gcc version
 *
 * @param {string} dir Working directory
 * @returns Object containing gcc details
 */
export function collectGccInfo(dir) {
  const versionDesc = getCommandOutput(GCC_CMD, dir, ["--version"]);
  const moduleDesc = getCommandOutput(GCC_CMD, dir, ["-print-search-dirs"]);
  if (versionDesc) {
    return {
      type: "platform",
      name: "gcc",
      version: versionDesc.split("\n")[0],
      description: (moduleDesc || "").replaceAll("\n", "\\n"),
    };
  }
  return undefined;
}

/**
 * Collect rust version
 *
 * @param {string} dir Working directory
 * @returns Object containing rust details
 */
export function collectRustInfo(dir) {
  const versionDesc = getCommandOutput(RUSTC_CMD, dir, ["--version"]);
  const moduleDesc = getCommandOutput(CARGO_CMD, dir, ["--version"]);
  if (versionDesc) {
    return {
      type: "platform",
      name: "rustc",
      version: versionDesc.trim(),
      description: (moduleDesc || "").trim(),
    };
  }
  return undefined;
}

/**
 * Collect go version
 *
 * @param {string} dir Working directory
 * @returns Object containing go details
 */
export function collectGoInfo(dir) {
  const versionDesc = getCommandOutput(GO_CMD, dir, ["version"]);
  if (versionDesc) {
    return {
      type: "platform",
      name: "go",
      version: versionDesc.trim(),
    };
  }
  return undefined;
}

/**
 * Collect swift version
 *
 * @param {string} dir Working directory
 * @returns Object containing swift details
 */
export function collectSwiftInfo(dir) {
  const versionDesc = getCommandOutput(SWIFT_CMD, dir, ["--version"]);
  if (versionDesc) {
    return {
      type: "platform",
      name: "swift",
      version: versionDesc.trim(),
    };
  }
  return undefined;
}

/**
 * Collect Ruby version
 *
 * @param {string} dir Working directory
 * @returns Object containing Ruby details
 */
export function collectRubyInfo(dir) {
  const versionDesc = getCommandOutput(RUBY_CMD, dir, ["--version"]);
  if (versionDesc) {
    return {
      type: "platform",
      name: "ruby",
      version: versionDesc.trim(),
    };
  }
  return undefined;
}

/**
 * The first line of a command's output, without its line end.
 *
 * @param {string|undefined} output Output of getCommandOutput
 * @returns {string} First line, or an empty string
 */
function firstOutputLine(output) {
  return `${output || ""}`.split(/\r?\n/, 1)[0].trim();
}

/**
 * A toolchain component for the formulation section. Formulation shares the
 * document's bom-ref namespace with the inventory, which can hold the very same
 * `pkg:generic/php@<version>` runtime (an image scanned with
 * --include-formulation), so like the other toolchains it carries no bom-ref.
 *
 * @param {Object} component component with a purl and a bom-ref
 * @returns {Object} the component without its bom-ref
 */
function formulationToolchain(component) {
  delete component["bom-ref"];
  return component;
}

/**
 * Collect the PHP version of the PHP found on the PATH.
 *
 * `-n` stops PHP loading any php.ini, so a PHPRC or an auto_prepend_file cannot
 * run code, and `-v` is used rather than `-r 'echo PHP_VERSION;'` because the
 * shell on Windows does not quote arguments. The first line is
 * `PHP 8.5.11 (cli) (built: Sep 22 2026 13:32:06) (NTS)`.
 *
 * The identity is `pkg:generic/php`: a probe of the PATH cannot tell which
 * package manager, if any, installed this PHP. A banner with a distro revision,
 * such as Ubuntu 22.04's `PHP 8.1.2-1ubuntu2.14`, is recorded as reported but
 * without a CPE: the distro backports fixes under the old upstream number.
 *
 * @param {string} dir Working directory
 * @returns Object containing the PHP details
 */
export function collectPhpInfo(dir) {
  const banner = firstOutputLine(getCommandOutput(PHP_CMD, dir, ["-n", "-v"]));
  const reported = banner.startsWith("PHP ")
    ? parsePhpReportedVersion(banner.slice("PHP ".length))
    : undefined;
  if (!reported) {
    return undefined;
  }
  return formulationToolchain(
    createPhpRuntimeComponent(reported.version, {
      withCpe: !reported.distroRevision,
    }),
  );
}

/**
 * Collect the Composer version.
 *
 * `--no-plugins` and `--no-scripts` keep the plugins and scripts of the
 * project in the working directory from running, which `composer --version`
 * would otherwise let a plugin do. It needs no network. The banner is
 * `Composer version 2.10.3 2026-08-27 13:34:23`, but an older Composer on a
 * newer PHP prints deprecation notices above it, so the first line that starts
 * with it is read; the line after it names the PHP Composer runs on, with its
 * path, and is never read. The banner must start its line: an indented echo of
 * the project's composer.json in an error block does not count. Only a stable
 * release is recorded: a pre-release or a snapshot has no version a CPE can
 * name.
 *
 * @param {string} dir Working directory
 * @returns Object containing the Composer details
 */
export function collectComposerInfo(dir) {
  const output = getCommandOutput(COMPOSER_CMD, dir, [
    "--version",
    "--no-plugins",
    "--no-scripts",
    "--no-interaction",
  ]);
  const token =
    /^Composer version (\S+)/m.exec(
      `${output || ""}`.slice(0, 64 * 1024),
    )?.[1] || "";
  if (!/^\d+\.\d+\.\d+$/.test(token)) {
    return undefined;
  }
  return {
    type: "platform",
    name: "composer",
    version: token,
    cpe: `cpe:2.3:a:getcomposer:composer:${token}:*:*:*:*:*:*:*`,
    purl: new PackageURL(
      "generic",
      null,
      "composer",
      token,
      null,
      null,
    ).toString(),
  };
}

/**
 * Method to run a swift command
 *
 * @param {String} dir Working directory
 * @param {Array} args Command arguments
 * @returns Object containing swift details
 */
export function runSwiftCommand(dir, args) {
  return getCommandOutput(SWIFT_CMD, dir, args);
}

export function collectEnvInfo(dir) {
  // Version managers pick the toolchain from files in the working directory.
  // rust-toolchain.toml can name an absolute toolchain path and global.json
  // can name SDK paths, so in secure mode the probes run outside the scanned
  // project and report the toolchains installed on the host.
  if (isSecureMode) {
    dir = getTmpDir();
  }
  const infoComponents = [];
  let cmp = collectJavaInfo(dir);
  if (cmp) {
    infoComponents.push(cmp);
  }
  cmp = collectDotnetInfo(dir);
  if (cmp) {
    infoComponents.push(cmp);
  }
  cmp = collectPythonInfo(dir);
  if (cmp) {
    infoComponents.push(cmp);
  }
  cmp = collectNodeInfo(dir);
  if (cmp) {
    infoComponents.push(cmp);
  }
  cmp = collectGccInfo(dir);
  if (cmp) {
    infoComponents.push(cmp);
  }
  cmp = collectRustInfo(dir);
  if (cmp) {
    infoComponents.push(cmp);
  }
  cmp = collectGoInfo(dir);
  if (cmp) {
    infoComponents.push(cmp);
  }
  cmp = collectRubyInfo(dir);
  if (cmp) {
    infoComponents.push(cmp);
  }
  cmp = collectPhpInfo(dir);
  if (cmp) {
    infoComponents.push(cmp);
  }
  cmp = collectComposerInfo(dir);
  if (cmp) {
    infoComponents.push(cmp);
  }
  return infoComponents;
}

/**
 * Execute any command to retrieve the output
 *
 * @param {*} cmd Command to execute
 * @param {*} dir working directory
 * @param {*} args arguments
 * @param {Object} [spawnOverrides] extra options merged into spawnSync (e.g. env)
 * @returns String output from the command or undefined in case of error
 */
const getCommandOutput = (cmd, dir, args, spawnOverrides = {}) => {
  let commandToUse = cmd;
  // If the command includes space, automatically move it to the front of the args.
  if (cmd?.trim().includes(" ")) {
    const tmpA = cmd.split(" ");
    commandToUse = tmpA.shift();
    if (args?.length && tmpA.length) {
      args = tmpA.concat(args);
    }
  }
  if (DEBUG_MODE) {
    if (dir) {
      if (safeExistsSync(join(dir, commandToUse))) {
        console.warn(
          `SECURE MODE: Found ${commandToUse} inside ${dir}. This command will not be executed.`,
        );
        return undefined;
      }
      console.log(`Executing ${commandToUse} in ${dir}`);
    } else {
      console.log(`Executing ${commandToUse}`);
    }
  }
  const result = safeSpawnSync(commandToUse, args, {
    cwd: dir,
    shell: isWin,
    maxBuffer: MAX_BUFFER * 2,
    ...spawnOverrides,
  });
  const stdout = result.stdout ? result.stdout.toString() : "";
  const stderr = result.stderr ? result.stderr.toString() : "";
  return `${stdout}\n${stderr}`.trim() || undefined;
};

/**
 * Method to check if sdkman is available.
 */
export function isSdkmanAvailable() {
  let isSdkmanSetup =
    ["SDKMAN_DIR", "SDKMAN_CANDIDATES_DIR"].filter(
      (v) => process.env[v] && safeExistsSync(process.env[v]),
    ).length >= 1;
  if (!isSdkmanSetup && safeExistsSync(join(homedir(), ".sdkman", "bin"))) {
    process.env.SDKMAN_DIR = join(homedir(), ".sdkman");
    process.env.SDKMAN_CANDIDATES_DIR = join(
      homedir(),
      ".sdkman",
      "candidates",
    );
    isSdkmanSetup = true;
  }
  return isSdkmanSetup;
}

/**
 * Method to check if nvm is available.
 */
export function isNvmAvailable() {
  const result = safeSpawnSync(process.env.SHELL || "bash", [
    "-i",
    "-c",
    process.env.NVM_CMD || "nvm",
  ]);
  return result.status === 0;
}

/**
 * Method to check if a given sdkman tool is installed and available.
 *
 * @param {String} toolType Tool type such as java, gradle, maven etc.
 * @param {String} toolName Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {Boolean} true if the tool is available. false otherwise.
 */
export function isSdkmanToolAvailable(toolType, toolName) {
  toolName = getSdkmanToolFullname(toolName);
  let isToolAvailable =
    process.env.SDKMAN_CANDIDATES_DIR &&
    safeExistsSync(
      join(process.env.SDKMAN_CANDIDATES_DIR, toolType, toolName, "bin"),
    );
  if (
    !isToolAvailable &&
    safeExistsSync(
      join(homedir(), ".sdkman", "candidates", toolType, toolName, "bin"),
    )
  ) {
    process.env.SDKMAN_CANDIDATES_DIR = join(
      homedir(),
      ".sdkman",
      "candidates",
    );
    isToolAvailable = true;
  }
  return isToolAvailable;
}

/**
 * Method to install and use a given sdkman tool.
 *
 * @param {String} toolType Tool type such as java, gradle, maven etc.
 * @param {String} toolName Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {Boolean} true if the tool is available. false otherwise.
 */
export function installSdkmanTool(toolType, toolName) {
  if (isWin) {
    return false;
  }
  toolName = getSdkmanToolFullname(toolName);
  let result;
  if (!isSdkmanToolAvailable(toolType, toolName)) {
    let installDir = "";
    if (process.env.SDKMAN_CANDIDATES_DIR) {
      installDir = join(process.env.SDKMAN_CANDIDATES_DIR, toolType);
    }
    console.log("About to install", toolType, toolName, installDir);
    result = safeSpawnSync(process.env.SHELL || "bash", [
      "-i",
      "-c",
      `echo -e "no" | sdk install ${toolType} ${toolName} ${installDir}`.trim(),
    ]);
    if (DEBUG_MODE) {
      if (result.stdout) {
        console.log(result.stdout);
      }
      if (result.stderr) {
        console.log(result.stderr);
      }
    }
    if (result.status === 1 || result.error) {
      console.log(
        "Unable to install",
        toolType,
        toolName,
        "due to below errors.",
      );
      return false;
    }
  }
  const toolUpper = toolType.toUpperCase();
  // Set process env variables
  if (
    process.env[`${toolUpper}_HOME`] &&
    process.env[`${toolUpper}_HOME`].includes("current")
  ) {
    process.env[`${toolUpper}_HOME`] = process.env[`${toolUpper}_HOME`].replace(
      "current",
      toolName,
    );
    console.log(
      `${toolUpper}_HOME`,
      "set to",
      process.env[`${toolUpper}_HOME`],
    );
  } else if (
    process.env.SDKMAN_CANDIDATES_DIR &&
    safeExistsSync(join(process.env.SDKMAN_CANDIDATES_DIR, toolType, toolName))
  ) {
    process.env[`${toolUpper}_HOME`] = join(
      process.env.SDKMAN_CANDIDATES_DIR,
      toolType,
      toolName,
    );
    console.log(
      `${toolUpper}_HOME`,
      "set to",
      process.env[`${toolUpper}_HOME`],
    );
  } else {
    console.log(
      "Directory",
      join(process.env.SDKMAN_CANDIDATES_DIR, toolType, toolName),
      "is not found",
    );
  }
  const toolCurrentBin = join(toolType, "current", "bin");
  if (process.env?.PATH.includes(toolCurrentBin)) {
    process.env.PATH = process.env.PATH.replace(
      toolCurrentBin,
      join(toolType, toolName, "bin"),
    );
  } else if (process.env.SDKMAN_CANDIDATES_DIR) {
    const fullToolBinDir = join(
      process.env.SDKMAN_CANDIDATES_DIR,
      toolType,
      toolName,
      "bin",
    );
    if (!process.env?.PATH?.includes(fullToolBinDir)) {
      process.env.PATH = `${fullToolBinDir}${delimiter}${process.env.PATH}`;
    }
  }
  return true;
}

/**
 * Method to check if a given nvm tool is installed and available.
 *
 * @param {String} toolName Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {String} path of nvm if present, otherwise false
 */
export function getNvmToolDirectory(toolName) {
  const resultWhichNode = safeSpawnSync(process.env.SHELL || "bash", [
    "-i",
    "-c",
    `nvm which ${toolName}`,
  ]);
  if (DEBUG_MODE) {
    if (resultWhichNode.stdout) {
      console.log(resultWhichNode.stdout);
    }
    if (resultWhichNode.stderr) {
      console.log(resultWhichNode.stderr);
    }
  }
  if (resultWhichNode.status !== 0) {
    return;
  }
  // An interactive shell without a controlling terminal writes job control
  // notices to stderr, so only stdout can tell us whether nvm resolved the
  // version. Startup files may also print banners, hence the last path line.
  const nodePath = (resultWhichNode.stdout || "")
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"))
    .pop();
  if (!nodePath) {
    return;
  }

  return dirname(nodePath);
}

/**
 * Method to return nvm tool path
 *
 * @param {String} toolVersion Tool name with version. Eg: 22.0.2-tem
 *
 * @returns {String} path of the tool if not found installs and then returns paths. false if encounters an error.
 */
export function getOrInstallNvmTool(toolVersion) {
  const nvmNodePath = getNvmToolDirectory(toolVersion);
  if (!nvmNodePath) {
    // nvm couldn't directly use toolName so maybe needs to be installed
    const resultInstall = safeSpawnSync(process.env.SHELL || "bash", [
      "-i",
      "-c",
      `nvm install ${toolVersion}`,
    ]);

    if (DEBUG_MODE) {
      if (resultInstall.stdout) {
        console.log(resultInstall.stdout);
      }
      if (resultInstall.stderr) {
        console.log(resultInstall.stderr);
      }
    }

    if (resultInstall.status !== 0) {
      // There was some problem install the tool
      // output has already been printed out
      return false;
    }
    const nvmNodePath = getNvmToolDirectory(toolVersion);
    if (nvmNodePath) {
      return nvmNodePath;
    }
    return false;
  }
  return nvmNodePath;
}

/**
 * Retrieve sdkman tool full name
 */
function getSdkmanToolFullname(toolName) {
  return SDKMAN_JAVA_TOOL_ALIASES[toolName] || toolName;
}

/**
 * Method to check if rbenv is available.
 *
 * @returns {Boolean} true if rbenv is available. false otherwise.
 */
export function isRbenvAvailable() {
  let result = safeSpawnSync(process.env.SHELL || "bash", [
    "-i",
    "-c",
    `${process.env.RBENV_CMD || "rbenv"} --version`,
  ]);
  if (result.status !== 0) {
    result = safeSpawnSync(process.env.RBENV_CMD || "rbenv", ["--version"], {
      shell: isWin,
    });
    return result.status === 0;
  }
}

/**
 * Returns the rbenv binary directory for the given Ruby version.
 * Respects the `RBENV_ROOT` environment variable when set; otherwise falls back
 * to `~/.rbenv/versions/<rubyVersion>/bin`.
 *
 * @param {string} rubyVersion Ruby version string (e.g. `"3.2.2"`)
 * @returns {string} Absolute path to the rbenv bin directory for that version
 */
export function rubyVersionDir(rubyVersion) {
  return process.env.RBENV_ROOT
    ? join(process.env.RBENV_ROOT, "versions", rubyVersion, "bin")
    : join(homedir(), ".rbenv", "versions", rubyVersion, "bin");
}

/**
 * Perform bundle install using Ruby container images. Not working cleanly yet.
 *
 * @param rubyVersion Ruby version
 * @param cdxgenGemHome Gem Home
 * @param filePath Path
 */
export function bundleInstallWithDocker(rubyVersion, cdxgenGemHome, filePath) {
  const ociCmd = process.env.DOCKER_CMD || "docker";
  const ociArgs = [
    "run",
    "--rm",
    "-e",
    "GEM_HOME=/gems",
    "-v",
    `/tmp:${getTmpDir()}:rw`,
    "-v",
    `${filePath}:/app:rw`,
    "-v",
    `${cdxgenGemHome}:/gems:rw`,
    "-w",
    "/app",
    "-it",
    `docker.io/ruby:${rubyVersion}`,
    "bash",
    "-c",
    "bundle",
    "install",
  ];
  console.log(`Performing bundle install with: ${ociCmd}`);
  const result = safeSpawnSync(ociCmd, ociArgs, {
    shell: isWin,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    return false;
  }
  if (safeExistsSync(join(filePath, "Gemfile.lock"))) {
    console.log(
      "Gemfile.lock was generated successfully. Thank you for trying this feature!",
    );
  }
  return result.status === 0;
}

/**
 * Install a particular ruby version using rbenv.
 *
 * @param rubyVersion Ruby version to install
 * @param filePath File path
 */
export function installRubyVersion(rubyVersion, filePath) {
  if (!rubyVersion) {
    return { fullToolBinDir: undefined, status: false };
  }
  const existingRuby = collectRubyInfo(filePath);
  if (existingRuby?.version?.startsWith(`ruby ${rubyVersion} `)) {
    return { fullToolBinDir: undefined, status: true };
  }
  const fullToolBinDir = rubyVersionDir(rubyVersion);
  if (safeExistsSync(fullToolBinDir)) {
    const result = safeSpawnSync(
      process.env.RBENV_CMD || "rbenv",
      ["local", rubyVersion],
      {
        shell: isWin,
      },
    );
    if (result.error || result.status !== 0) {
      if (result.stdout) {
        console.log(result.stdout);
      }
      if (result.stderr) {
        console.log(result.stderr);
      }
    }
    if (result.status === 0) {
      return { fullToolBinDir, status: true };
    }
  }
  // Check if we're trying to install Ruby 1.x or 2.x
  if (rubyVersion.startsWith("1.")) {
    console.log(
      `Ruby version ${rubyVersion} requires very old versions of Linux such as debian:8. Consider using the container image "ghcr.io/cyclonedx/debian-ruby18:master" to build the application first and then invoke cdxgen with the arguments "--lifecycle pre-build".`,
    );
    console.log("The below install step is likely to fail.");
  } else if (
    rubyVersion.startsWith("2.") &&
    process.env?.CDXGEN_IN_CONTAINER !== "true"
  ) {
    console.log(
      `Installing Ruby version ${rubyVersion} requires specific development libraries. Consider using the custom container image "ghcr.io/cyclonedx/cdxgen-debian-ruby26:v12" instead.`,
    );
    console.log("The below install step is likely to fail.");
  }
  console.log(
    `Attempting to install Ruby ${rubyVersion} using rbenv. This might take a while ...`,
  );
  if (process.env?.CDXGEN_IN_CONTAINER === "true") {
    console.log(
      `To speed up this step, use bind mounts. Example: "--mount type=bind,src=/tmp/rbenv,dst=/root/.rbenv/versions/${rubyVersion}"`,
    );
  }
  const result = safeSpawnSync(
    process.env.RBENV_CMD || "rbenv",
    ["install", rubyVersion],
    {
      shell: isWin,
    },
  );
  if (result.error || result.status !== 0) {
    if (result.stdout) {
      console.log(result.stdout);
    }
    if (result.stderr) {
      console.log(result.stderr);
    }
    if (isMac) {
      console.log(
        "Try running the commands `sudo xcode-select --install` followed by `xcodebuild -runFirstLaunch`.",
      );
      console.log(
        "TIP: Run the command `brew info ruby` and follow the instructions to set the environment variables sLDFLAGS, CPPFLAGS, and PKG_CONFIG_PATH.",
      );
    }
    if (process.env?.CDXGEN_IN_CONTAINER === "true") {
      console.log(
        "Are there any devel packages that could be included in the cdxgen container image to avoid these errors? Start a discussion thread here: https://github.com/cdxgen/cdxgen/discussions",
      );
    } else {
      console.log(
        `TIP: Try using the custom container image "ghcr.io/cyclonedx/cdxgen-debian-ruby34" with the argument "-t ruby${rubyVersion}"`,
      );
    }
  }
  return { fullToolBinDir, status: result.status === 0 };
}

/**
 * Method to install bundler using gem.
 *
 * @param rubyVersion Ruby version
 * @param bundlerVersion Bundler version
 */
export function installRubyBundler(rubyVersion, bundlerVersion) {
  const minRubyVersion = "3.1.0";
  let bundlerWarningShown = false;
  if (!bundlerVersion && compareLoose(rubyVersion, minRubyVersion) === -1) {
    console.log(
      `Default installation for bundler requires Ruby >= ${minRubyVersion}. Attempting to detect and install an older version of bundler for Ruby ${rubyVersion}.`,
    );
    bundlerWarningShown = true;
  }
  const fullToolBinDir = rubyVersionDir(rubyVersion);
  if (safeExistsSync(fullToolBinDir)) {
    const gemInstallArgs = ["install", "bundler"];
    if (bundlerVersion) {
      gemInstallArgs.push("-v");
      gemInstallArgs.push(bundlerVersion);
    }
    if (!bundlerWarningShown) {
      if (bundlerVersion) {
        console.log(
          `Installing bundler ${bundlerVersion} using ${join(fullToolBinDir, "gem")}`,
        );
      } else {
        console.log(
          `Installing bundler using ${join(fullToolBinDir, "gem")} ${gemInstallArgs.join(" ")}`,
        );
      }
    }
    const result = safeSpawnSync(join(fullToolBinDir, "gem"), gemInstallArgs, {
      shell: isWin,
    });
    if (bundlerWarningShown) {
      if (result.stderr?.includes("Try installing it with")) {
        const oldBundlerVersion = result.stderr
          .split("`\n")[0]
          .split("Try installing it with `")
          .pop()
          .split(" ")
          .pop()
          .replaceAll("`", "");
        if (/^\d+/.test(oldBundlerVersion)) {
          console.log(
            `The last version of bundler to support your Ruby & RubyGems was ${oldBundlerVersion}. cdxgen will now attempt to install this version.`,
          );
          return installRubyBundler(rubyVersion, oldBundlerVersion);
        }
      }
    } else {
      if (result.error || result.status !== 0) {
        if (result.stdout) {
          console.log(result.stdout);
        }
        if (result.stderr) {
          console.log(result.stderr);
        }
      }
      return result.status === 0;
    }
  }
  return false;
}

/**
 * Method to perform bundle install
 *
 * @param cdxgenGemHome cdxgen Gem home
 * @param rubyVersion Ruby version
 * @param bundleCommand Bundle command to use
 * @param basePath working directory
 *
 * @returns {boolean} true if the install was successful. false otherwise.
 */
export function performBundleInstall(
  cdxgenGemHome,
  rubyVersion,
  bundleCommand,
  basePath,
) {
  if (arch() !== "x64") {
    console.log(
      `INFO: Many Ruby packages have limited support for ${arch()} architecture. Run the cdxgen container image with --platform=linux/amd64 for best experience.`,
    );
  }
  let installArgs = ["install"];
  if (process.env.BUNDLE_INSTALL_ARGS) {
    installArgs = installArgs.concat(
      process.env.BUNDLE_INSTALL_ARGS.split(" "),
    );
  }
  const gemFileLock = join(basePath, "Gemfile.lock");
  console.log(
    `Invoking ${bundleCommand} ${installArgs.join(" ")} from ${basePath} with GEM_HOME ${cdxgenGemHome}. Please wait ...`,
  );
  let result = safeSpawnSync(bundleCommand, installArgs, {
    shell: isWin,
    cwd: basePath,
    env: {
      ...process.env,
      GEM_HOME: cdxgenGemHome,
    },
  });
  if (result.error || result.status !== 0) {
    let pythonWarningShown = false;
    let rubyVersionWarningShown = false;
    if (
      result?.stderr?.includes("requires python 2 to be installed") ||
      result?.stdout?.includes("requires python 2 to be installed")
    ) {
      pythonWarningShown = true;
      console.log(
        "A native module requires python 2 to be installed. Please install python 2.7.18 from https://www.python.org/downloads/release/python-2718/.",
      );
      console.log(
        "NOTE: Python 2.7.x has now reached end-of-life. Python 2.7.18, is the FINAL RELEASE of Python 2.7.x. It will no longer be supported or updated. You should stop using this project in production and decommission immediately.",
      );
      console.log(
        "Further, the project might need older versions of gcc and other build tools which might not be readily available in this environment.",
      );
      if (process.env?.CDXGEN_IN_CONTAINER === "true") {
        console.log(
          "cdxgen container images do not bundle Python 2. Run cdxgen in cli mode to proceed with the SBOM generation.",
        );
      }
      console.log(
        "Alternatively, ensure Gemfile.lock is present locally and invoke cdxgen with the argument `--lifecycle pre-build`.",
      );
    }
    if (
      result?.stderr?.includes("Running `bundle update ") ||
      result?.stdout?.includes("Running `bundle update ")
    ) {
      console.log(
        "Gemfile.lock appears to be outdated. Attempting automated update.",
      );
      const packageToUpdate = result.stderr
        .split("Running `bundle update ")
        .pop()
        .split("`")[0];
      let updateArgs = ["update"];
      if (packageToUpdate?.length && !packageToUpdate.includes(" ")) {
        updateArgs.push(packageToUpdate);
      }
      if (process.env.BUNDLE_UPDATE_ARGS) {
        updateArgs = updateArgs.concat(
          process.env.BUNDLE_UPDATE_ARGS.split(" "),
        );
      }
      console.log(`${bundleCommand}`);
      result = safeSpawnSync(bundleCommand, updateArgs, {
        shell: isWin,
        cwd: basePath,
        env: {
          ...process.env,
          GEM_HOME: cdxgenGemHome,
        },
      });
      if (result.error || result.status !== 0) {
        console.log("------------");
        if (result.stdout) {
          console.log(result.stdout);
        }
        if (result.stderr) {
          console.log(result.stderr);
        }
        console.log("------------");
      }
      return result.status === 0;
    }
    if (
      result?.stderr?.includes("Your Ruby version is ") ||
      result?.stdout?.includes("Your Ruby version is ")
    ) {
      console.log(
        "This project requires a specific version of Ruby. The version requirements can be found in the error message below.",
      );
      rubyVersionWarningShown = true;
    }
    if (result?.stderr?.includes("requires rubygems version")) {
      console.log(
        "This project requires a specific version of RubyGems. To do this, the existing version must be uninstalled followed by installing the required version. `sudo gem uninstall rubygems-update -v <existing version>` and then `sudo gem install rubygems-update -v <required version>`.",
      );
      rubyVersionWarningShown = true;
      if (safeExistsSync(gemFileLock)) {
        console.log("Run `bundle install` command to troubleshoot the build.");
      } else {
        console.log(
          "Try building this project directly and set the environment variable CDXGEN_GEM_HOME with the gems directory. Look for any Dockerfile or CI workflow files for information regarding the exact version of Ruby, RubyGems, Bundler needed to build this project.",
        );
      }
      if (process.env?.CDXGEN_IN_CONTAINER === "true") {
        console.log(
          "TIP: Create your own container image by using an existing Ruby base image from here: https://github.com/cdxgen/cdxgen/tree/master/ci/images/debian",
        );
      }
    }
    if (result?.stderr?.includes("Bundler cannot continue")) {
      console.log(
        'Bundle install is unable to continue due to a dependency resolution and build issue. Running bundle install without certain groups might work in such instances. Try running cdxgen with the environment variable `BUNDLE_INSTALL_ARGS`. Example: to skip `test` group, set the variable `"BUNDLE_INSTALL_ARGS=--without test"`',
      );
      console.log(
        "NOTE: The generated SBOM would be incomplete with this workaround.",
      );
    }
    if (result?.stderr?.includes("Target architecture x64 is only supported")) {
      console.log(
        "A gem native extension requires x64/amd64 architecture. Run the cdxgen container image with the argument '--platform=linux/amd64'.",
      );
    }
    if (
      !pythonWarningShown &&
      (result?.stderr?.includes("Failed to build gem native extension") ||
        result?.stderr?.includes("Gem::Ext::BuildError"))
    ) {
      console.log(
        "Bundler failed to build some gem native extension(s). Carefully review the below error to install any required development libraries.",
      );
    }
    console.log("------------");
    if (result.stdout) {
      console.log(result.stdout);
    }
    if (result.stderr) {
      console.log(result.stderr);
    }
    console.log("------------");
    if (
      process.env?.CDXGEN_IN_CONTAINER === "true" &&
      !rubyVersionWarningShown
    ) {
      console.log(
        "Are there any devel packages that could be included in the cdxgen container image to avoid these errors? Start a discussion thread here: https://github.com/cdxgen/cdxgen/discussions",
      );
      console.log("------------");
    } else if (rubyVersion) {
      console.log(
        `TIP: Try using the custom container image "ghcr.io/cyclonedx/cdxgen-debian-ruby34" with the argument "-t ruby${rubyVersion}".`,
      );
    } else {
      console.log(
        `TIP: Try invoking cdxgen with a Ruby version type. With the custom container image "ghcr.io/cyclonedx/cdxgen-debian-ruby34", you can pass the argument "-t ruby<version>". Example: "-t ruby3.3.6"`,
      );
    }
  }
  return result.status === 0;
}

/**
 * Validates if a git ref name is safe to use in commands.
 *
 * @param {string} refName The git ref name to check
 * @returns {boolean} True if the ref name is safe, false otherwise
 */
function isSafeRef(refName) {
  if (!refName || typeof refName !== "string") {
    return false;
  }
  if (refName.startsWith("-")) {
    return false;
  }
  return /^[A-Za-z0-9._/@+-]+$/.test(refName);
}

// Upper bound for the commit window so a caller-supplied count cannot blow up
// the git invocation.
const MAX_GIT_LOG_COUNT = 100000;

/**
 * Coerce a caller-supplied commit count into a safe, bounded positive integer.
 * The result is always a plain integer, so it can never carry shell
 * metacharacters into the (potentially shell-invoked, on Windows) git command.
 *
 * @param {*} maxCount Requested commit count (may be any type)
 * @param {number} [fallback] Default when the value is missing/invalid
 * @returns {number} A positive integer in [1, MAX_GIT_LOG_COUNT]
 */
function safeGitLogCount(maxCount, fallback = 20) {
  const n = Number.parseInt(maxCount, 10);
  if (!Number.isInteger(n) || n <= 0) {
    return fallback;
  }
  return Math.min(n, MAX_GIT_LOG_COUNT);
}

/**
 * Validates that a commit-ish (hash or ref) is safe to place in a git command.
 * Reuses the ref charset (alphanumerics, `._/@+-`, no leading `-`), which also
 * covers hex object names and symbolic refs such as `HEAD`.
 *
 * @param {string} commitish Commit hash or ref
 * @returns {boolean} True when safe to use as a git argument
 */
function isSafeCommitish(commitish) {
  return isSafeRef(commitish);
}

/**
 * Retrieves the commit logs for a git repo with detailed author, committer, parents, signatures, and body.
 *
 * @param {string} dir Repo directory
 * @param {number} maxCount Maximum number of commits to retrieve
 * @returns {Array<Object>} Array of detailed commit objects
 */
export function gitLogCommitsDetailed(dir, maxCount = 20) {
  const count = safeGitLogCount(maxCount);
  const output = execGitCommand(dir, [
    "log",
    "-n",
    `${count}`,
    "--format=%H%n%an%n%ae%n%cn%n%ce%n%P%n%G?%n%B%x1e",
  ]);
  if (!output) {
    return [];
  }
  const commits = [];
  const parts = output.split("\x1e");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const lines = trimmed.split("\n");
    if (lines.length < 7) {
      continue;
    }
    const hash = lines[0]?.trim();
    const authorName = lines[1]?.trim() || "";
    const authorEmail = lines[2]?.trim() || "";
    const committerName = lines[3]?.trim() || "";
    const committerEmail = lines[4]?.trim() || "";
    const parents = lines[5]?.trim() ? lines[5].trim().split(/\s+/) : [];
    const signatureStatus = lines[6]?.trim() || "N";
    const message = lines.slice(7).join("\n").trim();

    // Check if Signed-off-by trailer is present
    const hasSignedOff = /signed-off-by:/i.test(message);

    if (hash) {
      commits.push({
        hash,
        authorName,
        authorEmail,
        committerName,
        committerEmail,
        parents,
        signatureStatus,
        message,
        hasSignedOff,
      });
    }
  }
  return commits;
}

/**
 * Determines whether a path looks like a test/spec file, using path-segment and
 * filename patterns rather than a naive substring match (which would flag files
 * such as `src/attestation.js` or `contest.py`).
 *
 * @param {string} filePath Repo-relative file path
 * @returns {boolean} True if the path is a test/spec source file
 */
function isTestPath(filePath) {
  if (!filePath) {
    return false;
  }
  return (
    /(^|\/)(tests?|specs?|__tests__|__mocks__|testing)\//i.test(filePath) ||
    /(^|\/)(test|spec)_[^/]+$/i.test(filePath) ||
    /[._-](test|spec|tests|specs)\.[A-Za-z0-9]+$/i.test(filePath)
  );
}

/**
 * Determines whether a path is a CI/build/script file where a bare `|| true`
 * suppression is a meaningful quality-gate-weakening signal.
 *
 * @param {string} filePath Repo-relative file path
 * @returns {boolean} True if the path is a CI/build/script file
 */
function isCiOrScriptPath(filePath) {
  if (!filePath) {
    return false;
  }
  return (
    filePath.includes(".github/workflows") ||
    /(^|\/)\.gitlab-ci\.yml$/i.test(filePath) ||
    /(^|\/)(Makefile|makefile|Justfile)$/.test(filePath) ||
    /\.(sh|bash|bat|ps1|mk)$/i.test(filePath) ||
    filePath.endsWith("package.json") ||
    /(azure-pipelines|\.circleci\/|Jenkinsfile|\.drone|bitbucket-pipelines)/i.test(
      filePath,
    )
  );
}

/**
 * High-signal quality-gate weakening tokens. These are conservative on purpose:
 * they only match constructs that intentionally silence failures or bypass
 * verification, to keep the false-positive rate low for ordinary refactors.
 */
const CI_WEAKENING_PATTERNS = [
  /continue-on-error\s*:\s*true/i,
  /--no-verify\b/,
  /HUSKY\s*=\s*0/,
  /--ignore-scripts\b/,
  /pytest\.mark\.skip\b/,
];

/**
 * Runs a git show on a commit hash and analyzes the diff for test-file
 * deletions and quality-gate-weakening changes (e.g. `|| true`,
 * `continue-on-error: true`, `--no-verify`). Detection is intentionally
 * conservative to avoid false positives from ordinary refactors.
 *
 * @param {string} dir Repo directory
 * @param {string} commitHash Commit hash to analyze
 * @returns {Object} Commit diff analysis results
 */
export function gitCommitDiffAnalysis(dir, commitHash) {
  const empty = {
    testFilesDeleted: [],
    weakeningTokens: [],
    touchedFiles: [],
    addedLinesCount: 0,
    deletedLinesCount: 0,
  };
  // Reject anything that is not a safe commit-ish (hex hash or ref); this keeps
  // shell metacharacters and option-like values out of the git argument.
  if (!isSafeCommitish(commitHash)) {
    return empty;
  }
  // --no-ext-diff / --no-textconv block .gitattributes-driven external diff and
  // textconv drivers (arbitrary shell commands) from an untrusted repo.
  const output = execGitCommand(dir, [
    "show",
    "--no-ext-diff",
    "--no-textconv",
    commitHash,
  ]);
  if (!output) {
    return empty;
  }

  const testFilesDeleted = [];
  const weakeningTokens = [];
  const touchedFiles = [];
  let addedLinesCount = 0;
  let deletedLinesCount = 0;

  // Parse the diff
  const lines = output.split("\n");
  let currentFile = "";
  let currentFileIsTest = false;
  let currentFileIsCi = false;

  for (const line of lines) {
    // Check file headers
    if (line.startsWith("diff --git ")) {
      currentFile = "";
      currentFileIsTest = false;
      currentFileIsCi = false;
      const parts = line.split(" ");
      if (parts.length >= 4) {
        let file = parts[2];
        if (file.startsWith("a/")) {
          file = file.substring(2);
        }
        touchedFiles.push(file);
        currentFile = file;
        currentFileIsTest = isTestPath(file);
        currentFileIsCi = isCiOrScriptPath(file);
      }
    } else if (line.startsWith("--- a/")) {
      const oldFile = line.substring(6).trim();
      if (!currentFile) {
        currentFile = oldFile;
        currentFileIsTest = isTestPath(oldFile);
        currentFileIsCi = isCiOrScriptPath(oldFile);
      }
    } else if (line.startsWith("+++ /dev/null") && currentFileIsTest) {
      // Whole test file removed
      testFilesDeleted.push(currentFile);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLinesCount++;
      // Quality-gate weakening tokens are only meaningful inside CI/build/script
      // config files. Matching them in arbitrary source or docs produces false
      // positives (e.g. a linter's own rule set, or documentation that merely
      // mentions `--no-verify`), so they are scoped to CI/script files.
      if (currentFileIsCi) {
        const addedContent = line.substring(1);
        if (
          CI_WEAKENING_PATTERNS.some((re) => re.test(addedContent)) ||
          /\|\|\s*true\b/.test(addedContent)
        ) {
          weakeningTokens.push(addedContent.trim());
        }
      }
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletedLinesCount++;
    }
  }

  return {
    testFilesDeleted,
    weakeningTokens,
    touchedFiles,
    addedLinesCount,
    deletedLinesCount,
  };
}

/**
 * Retrieves the git-ai notes metadata for recent commits.
 *
 * @param {string} dir Repo directory
 * @param {Object} [options] Options for note retrieval
 * @param {string} [options.ref] Notes reference path (defaults to refs/notes/ai)
 * @param {number} [options.maxCount] Maximum commits to scan (defaults to 20)
 * @returns {Array<Object>} Array of note objects { hash, note }
 */
export function gitAiNotes(dir, options = {}) {
  const ref = options.ref || "refs/notes/ai";
  const maxCount = safeGitLogCount(options.maxCount);

  if (!isSafeRef(ref)) {
    return [];
  }

  const output = execGitCommand(dir, [
    "log",
    "-n",
    `${maxCount}`,
    `--notes=${ref}`,
    "--format=%H%n%N%x1e",
  ]);

  if (!output) {
    return [];
  }

  const notes = [];
  const parts = output.split("\x1e");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const newlineIdx = trimmed.indexOf("\n");
    let hash = "";
    let noteContent = "";
    if (newlineIdx === -1) {
      hash = trimmed;
    } else {
      hash = trimmed.substring(0, newlineIdx).trim();
      noteContent = trimmed.substring(newlineIdx + 1).trim();
    }

    if (hash && noteContent) {
      notes.push({ hash, note: noteContent });
    }
  }
  return notes;
}

// Revert/hotfix/rollback intent in a commit subject. Scoped to the subject line
// (not the full body) to avoid matching commits that merely discuss a revert.
const REVERT_HOTFIX_RE = /\b(?:revert|roll[- ]?back|hot[- ]?fix)\b/i;

/**
 * Retrieves recent commits whose subject indicates a revert, hotfix, or
 * rollback. Bounded to the same recency window as the other collectors — unlike
 * `git log --grep`, which traverses the entire history looking for matches.
 *
 * @param {string} dir Repo directory
 * @param {number} maxCount Maximum number of recent commits to scan
 * @returns {Array<Object>} Array of { hash, message } revert/hotfix commits
 */
export function gitRevertsAndHotfixes(dir, maxCount = 20) {
  const count = safeGitLogCount(maxCount);
  const output = execGitCommand(dir, [
    "log",
    "-n",
    `${count}`,
    "--format=%H%n%B%x1e",
  ]);

  if (!output) {
    return [];
  }

  const entries = [];
  const parts = output.split("\x1e");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const lines = trimmed.split("\n");
    const hash = lines[0]?.trim();
    const message = lines.slice(1).join("\n").trim();
    const subject = message.split("\n")[0] || "";
    if (hash && REVERT_HOTFIX_RE.test(subject)) {
      entries.push({ hash, message });
    }
  }
  return entries;
}
