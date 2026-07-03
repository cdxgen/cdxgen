import { arch, homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";

import { compareLoose } from "semver";

import {
  CARGO_CMD,
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
  RUBY_CMD,
  RUSTC_CMD,
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
]);

/**
 * Environment applied to every git invocation. Disables interactive prompts and,
 * in secure mode, ignores system/global git config so only the hardened `-c`
 * overrides and the (untrusted) repo config remain, mirroring hardenedGitCommand.
 *
 * @returns {Object} environment for spawning git
 */
function hardenedGitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (isSecureMode) {
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = "/dev/null";
  }
  return env;
}

// sdkman tool aliases
export const SDKMAN_JAVA_TOOL_ALIASES = {
  java8: process.env.JAVA8_TOOL || "8.0.452-amzn", // Temurin no longer offers java8 :(
  java11: process.env.JAVA11_TOOL || "11.0.31-tem",
  java17: process.env.JAVA17_TOOL || "17.0.19-tem",
  java21: process.env.JAVA21_TOOL || "21.0.11-tem",
  java22: process.env.JAVA22_TOOL || "22.0.2-tem",
  java23: process.env.JAVA23_TOOL || "23.0.2-tem",
  java24: process.env.JAVA24_TOOL || "24.0.2-tem",
  java25: process.env.JAVA25_TOOL || "25.0.3-tem",
  java26: process.env.JAVA26_TOOL || "26.0.1-tem",
};

/**
 * Retrieves a git config item
 * @param {string} configKey Git config key
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export function getGitConfig(configKey, dir) {
  return execGitCommand(dir, ["config", "--get", configKey]);
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
 * Retrieves the files list from git
 * @param {string} dir repo directory
 *
 * @returns Output from git config or undefined
 */
export function listFiles(dir) {
  const filesList = [];
  const output = execGitCommand(dir, [
    "ls-tree",
    "-l",
    "-r",
    "--full-tree",
    "HEAD",
  ]);
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
 * Execute a git command
 *
 * @param {string} dir Repo directory
 * @param {Array} args arguments to git command
 *
 * @returns Output from the git command
 */
export function execGitCommand(dir, args) {
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
  const result = safeSpawnSync(
    process.env.SHELL || "bash",
    ["-i", "-c", process.env.NVM_CMD || "nvm"],
    {
      shell: process.env.SHELL || true,
    },
  );
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
    result = safeSpawnSync(
      process.env.SHELL || "bash",
      [
        "-i",
        "-c",
        `"echo -e "no" | sdk install ${toolType} ${toolName} ${installDir}"`.trim(),
      ],
      {
        shell: process.env.SHELL || true,
      },
    );
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
  const resultWhichNode = safeSpawnSync(
    process.env.SHELL || "bash",
    ["-i", "-c", `"nvm which ${toolName}"`],
    {
      shell: process.env.SHELL || true,
    },
  );
  if (DEBUG_MODE) {
    if (resultWhichNode.stdout) {
      console.log(resultWhichNode.stdout);
    }
    if (resultWhichNode.stderr) {
      console.log(resultWhichNode.stderr);
    }
  }
  if (resultWhichNode.status !== 0 || resultWhichNode.stderr) {
    return;
  }

  return dirname(resultWhichNode.stdout.trim());
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
    const resultInstall = safeSpawnSync(
      process.env.SHELL || "bash",
      ["-i", "-c", `"nvm install ${toolVersion}"`],
      {
        shell: process.env.SHELL || true,
      },
    );

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
  let result = safeSpawnSync(
    process.env.SHELL || "bash",
    ["-i", "-c", process.env.RBENV_CMD || "rbenv", "--version"],
    {
      shell: process.env.SHELL || true,
    },
  );
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
