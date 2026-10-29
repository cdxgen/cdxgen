import { readFileSync, realpathSync, statSync } from "node:fs";
import { arch, homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import process from "node:process";

import { compareLoose } from "semver";

import {
  DEBUG_MODE,
  isSecureMode,
  readEnvironmentVariable,
} from "../core/activity.js";
import {
  commandOutputText,
  isLedgerEnabled,
  LEDGER_EVENT_IMPACTS,
  LEDGER_EVENT_KINDS,
  recordDegradation,
  recordLedgerEvent,
} from "../core/buildLedger.js";
import {
  BUNDLE_CMD,
  CARGO_CMD,
  COMPOSER_CMD,
  DOTNET_CMD,
  GCC_CMD,
  GEM_CMD,
  GO_CMD,
  getJavaCommand,
  getPythonCommand,
  isBun,
  isDeno,
  isNode,
  NPM_CMD,
  PHP_CMD,
  RUBY_CMD,
  RUSTC_CMD,
  SWIFT_CMD,
} from "../core/env.js";
import {
  getTmpDir,
  MAX_BUFFER,
  safeExistsSync,
  safeSpawnSync,
} from "../core/fs.js";
import { diagnosticStream } from "../core/logger.js";
import { dirNameStr, isMac, isWin } from "../core/paths.js";
import { isProjectToolingAllowed } from "../core/projectTooling.js";
import { brotliDecoderProperties, readBrotliDecoder } from "./brotliDecoder.js";
import { isValidSdkmanVersion } from "./jvmToolEnv.js";
import { createNodeRuntimeComponent } from "./nodeBuildInfo.js";
import {
  createPhpRuntimeComponent,
  packageStoreOf,
  parsePhpReportedVersion,
} from "./phpBuildInfo.js";
import { applyPurl, tryBuildPurl } from "./purl.js";
import {
  createRubyRuntimeComponent,
  parseRubyDescription,
} from "./rubyBuildInfo.js";
import {
  classifySpawnRestriction,
  describeSpawnRestriction,
} from "./toolRequirements.js";

/**
 * Git executable name used for all git invocations, overridable via GIT_CMD.
 *
 * @type {string}
 */
export const GIT_COMMAND = readEnvironmentVariable("GIT_CMD") || "git";

/**
 * Config overrides applied (via `-c`) to every git invocation to neutralize
 * repository-controlled code-execution vectors. A cloned/untrusted repo can set
 * these in its local `.git/config`, so we force-disable them:
 *  - `core.fsmonitor=false`     — a repo-set fsmonitor value is a command git runs.
 *  - `core.hooksPath=/dev/null` — prevents any hook script from executing.
 *  - `safe.bareRepository=explicit` — avoids operating on an embedded bare repo.
 *  - `gpg.program`, `gpg.ssh.program`, `gpg.x509.program` — `%G?` in a log
 *    format verifies signatures by running these, so pin them to the tools
 *    on PATH instead of a program named by the repo.
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
  "gpg.program=gpg",
  "-c",
  "gpg.ssh.program=ssh-keygen",
  "-c",
  "gpg.x509.program=gpgsm",
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

/**
 * sdkman tool aliases mapping java version identifiers to candidate ids.
 *
 * Each alias can be overridden via the matching `JAVA*_TOOL` environment
 * variable and otherwise defaults to a Temurin candidate version.
 *
 * @type {Object<string, string>}
 */
export const SDKMAN_JAVA_TOOL_ALIASES = {
  // Identifiers must be downloadable from the sdkman broker: the `sdk list`
  // output advertises Temurin respin ids such as 21.0.12+1.1-tem, but the
  // broker cannot serve ids containing '+', so the plain ids are pinned.
  java8: readEnvironmentVariable("JAVA8_TOOL") || "8.0.504-zulu", // Temurin no longer offers java8 :(
  java11: readEnvironmentVariable("JAVA11_TOOL") || "11.0.32-tem",
  java17: readEnvironmentVariable("JAVA17_TOOL") || "17.0.20-tem",
  java21: readEnvironmentVariable("JAVA21_TOOL") || "21.0.12-tem",
  java22: readEnvironmentVariable("JAVA22_TOOL") || "22.0.2-tem",
  java23: readEnvironmentVariable("JAVA23_TOOL") || "23.0.2-tem",
  java24: readEnvironmentVariable("JAVA24_TOOL") || "24.0.2-tem",
  java25: readEnvironmentVariable("JAVA25_TOOL") || "25.0.4-tem",
  java26: readEnvironmentVariable("JAVA26_TOOL") || "26.0.2-tem",
  // The broker serves no Java 27 build yet (every vendor id 404s), so java27
  // has an alias only when JAVA27_TOOL names one that is downloadable.
  ...(readEnvironmentVariable("JAVA27_TOOL")
    ? { java27: readEnvironmentVariable("JAVA27_TOOL") }
    : {}),
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
      l = l.replaceAll("\r", "");
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
      l = l.replaceAll("\r", "");
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
  // git is a real executable, so Windows can spawn it without a shell. Doing
  // so keeps the pretty-format arguments intact: `%H`, `%n` and `%x1e` are
  // cmd.exe variable-expansion syntax, which the shell-execution guard rightly
  // refuses to pass through a shell.
  return getCommandOutput(
    GIT_COMMAND,
    dir,
    [...GIT_HARDENING_CONFIG_ARGS, ...args],
    {
      env: hardenedGitEnv(),
      shell: false,
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
 * Record a successful version probe with the version the tool reported.
 *
 * @param {string} tool Tool name
 * @param {string} ecosystem Ecosystem the tool belongs to
 * @param {string} found Version string reported by the tool
 */
function recordToolProbeResolved(tool, ecosystem, found) {
  recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_RESOLVED, {
    ecosystem,
    tool,
    found,
    source: "PATH",
  });
}

/**
 * Record a failed version probe. A probe the environment did not let run is
 * degraded evidence — the tool may well be present — while only a probe that
 * ran and found nothing counts as a missing tool.
 *
 * @param {string} tool Tool name
 * @param {string} ecosystem Ecosystem the tool belongs to
 * @param {string} command Probe command that failed
 * @param {string} [detail] What to say when the command is not restricted,
 *   instead of the default that no command answered
 */
function recordToolProbeFailure(tool, ecosystem, command, detail) {
  if (!isLedgerEnabled()) {
    return;
  }
  const restriction = describeSpawnRestriction(command);
  if (restriction) {
    // A dry-run block is the user's own request, so it costs nothing; any
    // other policy restriction hides a version the tool may well have.
    const isDryRunBlock = classifySpawnRestriction(command) === "dry-run";
    recordLedgerEvent(LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED, {
      ecosystem,
      tool,
      source: "PATH",
      remediationId: isDryRunBlock ? "policy.dry-run" : "policy.secure-mode",
      impact: isDryRunBlock
        ? LEDGER_EVENT_IMPACTS.NONE
        : LEDGER_EVENT_IMPACTS.VERSIONS,
      detail: `The ${tool} version probe could not run: ${restriction}.`,
    });
  } else {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_MISSING, {
      ecosystem,
      tool,
      source: "PATH",
      detail: detail || `No ${tool} command answered the version probe.`,
    });
  }
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
    const info = {
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
    recordToolProbeResolved("java", "java", info.version);
    return info;
  }
  recordToolProbeFailure("java", "java", getJavaCommand());
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
    const info = {
      type: "platform",
      name: "dotnet",
      version: versionDesc.trim(),
      description: moduleDesc.replaceAll("\n", "\\n"),
    };
    recordToolProbeResolved("dotnet", "csharp", info.version);
    return info;
  }
  recordToolProbeFailure("dotnet", "csharp", DOTNET_CMD);
  return undefined;
}

/**
 * Collect python version
 *
 * @param {string} dir Working directory
 * @returns Object containing python details
 */
export function collectPythonInfo(dir) {
  const pythonCmd = getPythonCommand();
  const versionDesc = getCommandOutput(pythonCmd, dir, ["-S", "--version"]);
  const moduleDesc =
    getCommandOutput(pythonCmd, dir, ["-I", "-m", "pip", "--version"]) || "";
  if (versionDesc) {
    const info = {
      type: "platform",
      name: "python",
      version: versionDesc.replace("Python ", ""),
      description: moduleDesc.replaceAll("\n", "\\n"),
    };
    recordToolProbeResolved("python", "python", info.version);
    return info;
  }
  recordToolProbeFailure("python", "python", pythonCmd);
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
  if (runtimeInfo.runtime === "Node.js" && runtimeInfo.version) {
    // The same identity a scanned image's Node.js gets, without a bom-ref, as
    // for the other toolchains.
    const runtime = formulationToolchain(
      createNodeRuntimeComponent(runtimeInfo.version),
    );
    nodeInfo.purl = runtime.purl;
    nodeInfo.cpe = runtime.cpe;
    annotateNodeBrotli(nodeInfo.components);
  }
  const moduleDesc = getCommandOutput(NPM_CMD, dir, ["--version"]);
  if (moduleDesc) {
    nodeInfo.description = `npm: ${moduleDesc}`;
    recordToolProbeResolved("npm", "npm", moduleDesc);
  } else {
    recordToolProbeFailure("npm", "npm", NPM_CMD);
  }
  return nodeInfo;
}

/**
 * Record whether the Brotli decoder the running Node.js uses carries the
 * CVE-2026-111497 fix. process.versions.brotli cannot say: Node.js backports
 * the fix without changing it. The decoder is read where it lives, in the node
 * binary or in the shared libbrotlidec a `--shared-brotli` build loads.
 *
 * @param {Object[]|undefined} components bundled components of the runtime
 */
function annotateNodeBrotli(components) {
  const brotli = (components || []).find(
    (component) => component.name === "brotli",
  );
  if (!brotli) {
    return;
  }
  let decoderFile = globalThis.process?.execPath;
  if (nodeComponentLinkage("brotli") === "shared") {
    decoderFile = (
      globalThis.process?.report?.getReport?.()?.sharedObjects || []
    ).find((path) => basename(path).startsWith("libbrotlidec"));
  }
  const decoder = decoderFile ? readBrotliDecoder(decoderFile) : undefined;
  if (decoder) {
    brotli.properties = [
      ...(brotli.properties || []),
      ...brotliDecoderProperties(decoder),
    ];
  }
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
    const info = {
      type: "platform",
      name: "gcc",
      version: versionDesc.split("\n")[0],
      description: (moduleDesc || "").replaceAll("\n", "\\n"),
    };
    recordToolProbeResolved("gcc", "c", info.version);
    return info;
  }
  recordToolProbeFailure("gcc", "c", GCC_CMD);
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
    const info = {
      type: "platform",
      name: "rustc",
      version: versionDesc.trim(),
      description: (moduleDesc || "").trim(),
    };
    recordToolProbeResolved("rustc", "rust", info.version);
    return info;
  }
  recordToolProbeFailure("rustc", "rust", RUSTC_CMD);
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
    const info = {
      type: "platform",
      name: "go",
      version: versionDesc.trim(),
    };
    recordToolProbeResolved("go", "go", info.version);
    return info;
  }
  recordToolProbeFailure("go", "go", GO_CMD);
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
    const info = {
      type: "platform",
      name: "swift",
      version: versionDesc.trim(),
    };
    recordToolProbeResolved("swift", "swift", info.version);
    return info;
  }
  recordToolProbeFailure("swift", "swift", SWIFT_CMD);
  return undefined;
}

/**
 * The real path of the executable a command name runs, looked up on PATH as
 * the shell would, or undefined when it cannot be found.
 *
 * @param {string} command command name or path
 * @returns {string|undefined}
 */
function resolveExecutable(command) {
  const name = `${command || ""}`.trim().split(" ")[0];
  if (!name) {
    return undefined;
  }
  const extensions = isWin
    ? ["", ...`${process.env.PATHEXT || ".EXE;.CMD;.BAT"}`.split(";")]
    : [""];
  const directories = isAbsolute(name)
    ? [dirname(name)]
    : `${process.env.PATH || ""}`.split(delimiter).filter(Boolean);
  const base = isAbsolute(name) ? basename(name) : name;
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${base}${extension}`);
      try {
        if (statSync(candidate).isFile()) {
          return realpathSync(candidate);
        }
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/**
 * Whether a Ruby executable is one the operating system or a package manager
 * that patches it owns. Distros backport fixes under the old upstream version,
 * so its version must not be matched against upstream advisories by CPE.
 *
 * @param {string|undefined} realPath real path of the executable
 * @returns {boolean}
 */
export function isPackagedRubyPath(realPath) {
  if (!realPath || isWin) {
    return false;
  }
  // Homebrew builds the upstream release, so it keeps the CPE, as it does in
  // an OBOM; Nix and Guix patch theirs.
  const store = packageStoreOf(realPath);
  if (store) {
    return store !== "homebrew";
  }
  return ["/usr/bin/", "/bin/", "/usr/lib/", "/usr/libexec/", "/System/"].some(
    (prefix) => realPath.startsWith(prefix),
  );
}

// The shims of rbenv, asdf and mise run whichever Ruby is selected, which can
// be the distro's (`rbenv global system`).
function isVersionManagerShim(realPath) {
  return `${realPath}`.split(/[\\/]/).includes("shims");
}

// Whether the Ruby `ruby --version` described may carry its release's CPE.
// A shim is followed to the interpreter it runs; one that cannot be followed
// keeps no CPE, since it may be the distro's.
function rubyKeepsCpe(dir) {
  let executable = resolveExecutable(RUBY_CMD);
  if (executable && isVersionManagerShim(executable)) {
    const target = isWin
      ? ""
      : firstOutputLine(
          getCommandOutput(RUBY_CMD, dir, ["-e", "print RbConfig.ruby"]),
        );
    if (!isAbsolute(target)) {
      return false;
    }
    try {
      executable = realpathSync(target);
    } catch {
      executable = target;
    }
  }
  return !isPackagedRubyPath(executable);
}

/**
 * Collect the Ruby on the PATH.
 *
 * `ruby --version` prints the interpreter's description, such as
 * `ruby 3.3.6 (2024-11-05 revision 75015d4c1f) [x86_64-linux]`, which is kept
 * as the component description. The identity is `pkg:generic/ruby@3.3.6`
 * (or jruby, truffleruby), with the CPE of the release unless a package
 * manager owns the executable: a distro backports fixes under the old upstream
 * version.
 *
 * @param {string} dir Working directory
 * @returns Object containing Ruby details
 */
export function collectRubyInfo(dir) {
  const versionDesc = getCommandOutput(RUBY_CMD, dir, ["--version"]);
  const banner = firstOutputLine(versionDesc);
  const parsed = parseRubyDescription(banner);
  if (parsed) {
    const info = formulationToolchain(
      createRubyRuntimeComponent(parsed.version, {
        engine: parsed.engine,
        withCpe: rubyKeepsCpe(dir),
      }),
    );
    info.description = banner;
    const properties = [];
    if (parsed.patchlevel !== undefined) {
      properties.push({
        name: "cdx:ruby:patchlevel",
        value: parsed.patchlevel,
      });
    }
    if (parsed.rubyVersion) {
      properties.push({
        name: "cdx:ruby:languageVersion",
        value: parsed.rubyVersion,
      });
    }
    if (parsed.platform) {
      properties.push({ name: "cdx:ruby:platform", value: parsed.platform });
    }
    if (properties.length) {
      info.properties = properties;
    }
    recordToolProbeResolved("ruby", "ruby", banner);
    return info;
  }
  recordToolProbeFailure(
    "ruby",
    "ruby",
    RUBY_CMD,
    versionDesc
      ? "The ruby version probe did not print a Ruby version banner."
      : undefined,
  );
  return undefined;
}

/**
 * Whether the Ruby collectRubyInfo found is the MRI release a project needs.
 *
 * @param {Object|undefined} info result of collectRubyInfo
 * @param {string} version wanted MRI version
 * @returns {boolean}
 */
export function isRubyVersionActive(info, version) {
  return Boolean(info && info.name === "ruby" && info.version === version);
}

/**
 * Collect the RubyGems version. `gem --version` prints the bare version.
 *
 * @param {string} dir Working directory
 * @returns {Object|undefined} the RubyGems component
 */
export function collectRubyGemsInfo(dir) {
  const token = firstOutputLine(getCommandOutput(GEM_CMD, dir, ["--version"]));
  if (/^\d+\.\d+\.\d+$/.test(token)) {
    recordToolProbeResolved("gem", "ruby", token);
    return formulationToolchain(
      applyPurl(
        {
          type: "platform",
          name: "rubygems",
          version: token,
          cpe: `cpe:2.3:a:rubygems:rubygems:${token}:*:*:*:*:*:*:*`,
        },
        tryBuildPurl({ type: "generic", name: "rubygems", version: token }),
      ),
    );
  }
  recordToolProbeFailure("gem", "ruby", GEM_CMD);
  return undefined;
}

/**
 * Collect the Bundler version. `bundle --version` prints `Bundler version
 * 2.5.22`, or the bare version from Bundler 2.6 on.
 *
 * @param {string} dir Working directory
 * @returns {Object|undefined} the Bundler component
 */
export function collectBundlerInfo(dir) {
  const line = firstOutputLine(
    getCommandOutput(BUNDLE_CMD, dir, ["--version"]),
  );
  const token = line.startsWith("Bundler version ")
    ? line.slice("Bundler version ".length).trim()
    : line;
  if (/^\d+\.\d+\.\d+$/.test(token)) {
    recordToolProbeResolved("bundler", "ruby", token);
    return formulationToolchain(
      applyPurl(
        {
          type: "platform",
          name: "bundler",
          version: token,
          cpe: `cpe:2.3:a:bundler:bundler:${token}:*:*:*:*:*:*:*`,
        },
        tryBuildPurl({ type: "gem", name: "bundler", version: token }),
      ),
    );
  }
  recordToolProbeFailure("bundler", "ruby", BUNDLE_CMD);
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
 * @param {Object} component component built with applyPurl
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
  const output = getCommandOutput(PHP_CMD, dir, ["-n", "-v"]);
  const banner = firstOutputLine(output);
  const reported = banner.startsWith("PHP ")
    ? parsePhpReportedVersion(banner.slice("PHP ".length))
    : undefined;
  if (reported) {
    recordToolProbeResolved("php", "php", reported.version);
    return formulationToolchain(
      createPhpRuntimeComponent(reported.version, {
        withCpe: !reported.distroRevision,
      }),
    );
  }
  recordToolProbeFailure(
    "php",
    "php",
    PHP_CMD,
    output
      ? "The php version probe did not print a PHP version banner."
      : undefined,
  );
  return undefined;
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
  if (/^\d+\.\d+\.\d+$/.test(token)) {
    recordToolProbeResolved("composer", "php", token);
    return formulationToolchain(
      applyPurl(
        {
          type: "platform",
          name: "composer",
          version: token,
          cpe: `cpe:2.3:a:getcomposer:composer:${token}:*:*:*:*:*:*:*`,
        },
        tryBuildPurl({ type: "generic", name: "composer", version: token }),
      ),
    );
  }
  recordToolProbeFailure(
    "composer",
    "php",
    COMPOSER_CMD,
    output
      ? "The composer version probe did not print a stable Composer version."
      : undefined,
  );
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

/**
 * Collect toolchain information components for the current environment.
 *
 * Probes the working directory for java, dotnet, python, node, gcc, rust, go,
 * ruby, php and composer toolchains and returns one component per detected
 * tool.
 *
 * @param {string} dir Working directory to inspect
 * @param {Object} [options] CLI options, which decide whether the project's
 *   own toolchain files may choose the tools that run
 * @returns {Object[]} Array of toolchain component objects; empty when nothing is detected
 */
export function collectEnvInfo(dir, options = undefined) {
  // Version managers pick the toolchain from files in the working directory.
  // rust-toolchain.toml can name an absolute toolchain path and global.json
  // can name SDK paths, so unless the project's tooling may run, the probes
  // run outside the scanned project and report the toolchains installed on
  // the host.
  if (!isProjectToolingAllowed(options)) {
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
    cmp = collectRubyGemsInfo(dir);
    if (cmp) {
      infoComponents.push(cmp);
    }
    cmp = collectBundlerInfo(dir);
    if (cmp) {
      infoComponents.push(cmp);
    }
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
      (v) =>
        readEnvironmentVariable(v) &&
        safeExistsSync(readEnvironmentVariable(v)),
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
  const result = safeSpawnSync(readEnvironmentVariable("SHELL") || "bash", [
    "-i",
    "-c",
    readEnvironmentVariable("NVM_CMD") || "nvm",
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
    readEnvironmentVariable("SDKMAN_CANDIDATES_DIR") &&
    safeExistsSync(
      join(
        readEnvironmentVariable("SDKMAN_CANDIDATES_DIR"),
        toolType,
        toolName,
        "bin",
      ),
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
  // The version is interpolated into an interactive shell command, so reject
  // any identifier that is not a single safe token before spawning.
  if (
    !/^[a-z][a-z0-9-]*$/.test(`${toolType}`) ||
    !isValidSdkmanVersion(toolName)
  ) {
    console.log(
      `Unable to install ${toolType} with an invalid version identifier '${toolName}'. Use exact sdkman version identifiers such as '3.9.9' or '21.0.7-tem'.`,
    );
    return false;
  }
  let result;
  if (!isSdkmanToolAvailable(toolType, toolName)) {
    let installDir = "";
    if (readEnvironmentVariable("SDKMAN_CANDIDATES_DIR")) {
      installDir = join(
        readEnvironmentVariable("SDKMAN_CANDIDATES_DIR"),
        toolType,
      );
    }
    console.log("About to install", toolType, toolName, installDir);
    result = safeSpawnSync(readEnvironmentVariable("SHELL") || "bash", [
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
  if (readEnvironmentVariable(`${toolUpper}_HOME`)?.includes("current")) {
    process.env[`${toolUpper}_HOME`] = process.env[`${toolUpper}_HOME`].replace(
      "current",
      toolName,
    );
    console.log(
      `${toolUpper}_HOME`,
      "set to",
      readEnvironmentVariable(`${toolUpper}_HOME`),
    );
  } else if (
    readEnvironmentVariable("SDKMAN_CANDIDATES_DIR") &&
    safeExistsSync(
      join(
        readEnvironmentVariable("SDKMAN_CANDIDATES_DIR"),
        toolType,
        toolName,
      ),
    )
  ) {
    process.env[`${toolUpper}_HOME`] = join(
      readEnvironmentVariable("SDKMAN_CANDIDATES_DIR"),
      toolType,
      toolName,
    );
    console.log(
      `${toolUpper}_HOME`,
      "set to",
      readEnvironmentVariable(`${toolUpper}_HOME`),
    );
  } else {
    console.log(
      "Directory",
      join(
        readEnvironmentVariable("SDKMAN_CANDIDATES_DIR"),
        toolType,
        toolName,
      ),
      "is not found",
    );
  }
  const toolCurrentBin = join(toolType, "current", "bin");
  if (readEnvironmentVariable("PATH").includes(toolCurrentBin)) {
    process.env.PATH = process.env.PATH.replace(
      toolCurrentBin,
      join(toolType, toolName, "bin"),
    );
  } else if (readEnvironmentVariable("SDKMAN_CANDIDATES_DIR")) {
    const fullToolBinDir = join(
      readEnvironmentVariable("SDKMAN_CANDIDATES_DIR"),
      toolType,
      toolName,
      "bin",
    );
    if (!readEnvironmentVariable("PATH")?.includes(fullToolBinDir)) {
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
    readEnvironmentVariable("SHELL") || "bash",
    ["-i", "-c", `nvm which ${toolName}`],
  );
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
    const resultInstall = safeSpawnSync(
      readEnvironmentVariable("SHELL") || "bash",
      ["-i", "-c", `nvm install ${toolVersion}`],
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
  let result = safeSpawnSync(readEnvironmentVariable("SHELL") || "bash", [
    "-i",
    "-c",
    `${readEnvironmentVariable("RBENV_CMD") || "rbenv"} --version`,
  ]);
  if (result.status !== 0) {
    result = safeSpawnSync(
      readEnvironmentVariable("RBENV_CMD") || "rbenv",
      ["--version"],
      {
        shell: isWin,
      },
    );
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
  return readEnvironmentVariable("RBENV_ROOT")
    ? join(
        readEnvironmentVariable("RBENV_ROOT"),
        "versions",
        rubyVersion,
        "bin",
      )
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
  const ociCmd = readEnvironmentVariable("DOCKER_CMD") || "docker";
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
  // The container's own output is a diagnostic. Inheriting stdout would let it
  // interleave with the BOM document when the caller asked for `-o -`, so the
  // child's stdout is pointed at the diagnostic stream instead.
  const result = safeSpawnSync(ociCmd, ociArgs, {
    shell: isWin,
    stdio: ["inherit", diagnosticStream, "inherit"],
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
  if (isRubyVersionActive(existingRuby, rubyVersion)) {
    return { fullToolBinDir: undefined, status: true };
  }
  const fullToolBinDir = rubyVersionDir(rubyVersion);
  if (safeExistsSync(fullToolBinDir)) {
    const result = safeSpawnSync(
      readEnvironmentVariable("RBENV_CMD") || "rbenv",
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
      recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_FAILED, {
        ecosystem: "ruby",
        tool: "rbenv",
        command: `rbenv local ${rubyVersion}`,
        exitCode: typeof result.status === "number" ? result.status : undefined,
        detail: `Selecting Ruby ${rubyVersion} with rbenv local did not succeed.`,
        outputExcerpt: commandOutputText(result),
      });
    }
    if (result.status === 0) {
      return { fullToolBinDir, status: true };
    }
  }
  // Check if we're trying to install Ruby 1.x or 2.x
  if (rubyVersion.startsWith("1.")) {
    recordDegradation("ruby.version.unsupported-host", {
      ecosystem: "ruby",
      tool: "ruby",
      impact: "transitive-deps",
      wanted: rubyVersion,
      detail:
        "Building Ruby 1.x on this host is unsupported; a matching legacy container image is required to build this project.",
    });
    console.log(
      `Ruby version ${rubyVersion} requires very old versions of Linux such as debian:8. Consider using the container image "ghcr.io/cdxgen/debian-ruby18:master" to build the application first and then invoke cdxgen with the arguments "--lifecycle pre-build".`,
    );
    console.log("The below install step is likely to fail.");
  } else if (
    rubyVersion.startsWith("2.") &&
    readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true"
  ) {
    recordDegradation("ruby.build-deps.missing", {
      ecosystem: "ruby",
      tool: "ruby",
      impact: "transitive-deps",
      wanted: rubyVersion,
      detail:
        "Building Ruby 2.x on this host requires development libraries that are not installed.",
    });
    console.log(
      `Installing Ruby version ${rubyVersion} requires specific development libraries. Consider using the custom container image "ghcr.io/cdxgen/cdxgen-debian-ruby26:v13" instead.`,
    );
    console.log("The below install step is likely to fail.");
  }
  console.log(
    `Attempting to install Ruby ${rubyVersion} using rbenv. This might take a while ...`,
  );
  if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true") {
    console.log(
      `To speed up this step, use bind mounts. Example: "--mount type=bind,src=/tmp/rbenv,dst=/root/.rbenv/versions/${rubyVersion}"`,
    );
  }
  recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_ATTEMPTED, {
    ecosystem: "ruby",
    tool: "rbenv",
    command: `rbenv install ${rubyVersion}`,
    detail: `Installing Ruby ${rubyVersion} with rbenv.`,
  });
  const result = safeSpawnSync(
    readEnvironmentVariable("RBENV_CMD") || "rbenv",
    ["install", rubyVersion],
    {
      shell: isWin,
    },
  );
  if (result.error || result.status !== 0) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_FAILED, {
      ecosystem: "ruby",
      tool: "rbenv",
      command: `rbenv install ${rubyVersion}`,
      exitCode: typeof result.status === "number" ? result.status : undefined,
      detail: `The rbenv install of Ruby ${rubyVersion} did not succeed.`,
      outputExcerpt: commandOutputText(result),
    });
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
    if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true") {
      console.log(
        "Are there any devel packages that could be included in the cdxgen container image to avoid these errors? Start a discussion thread here: https://github.com/cdxgen/cdxgen/discussions",
      );
    } else {
      console.log(
        `TIP: Try using the custom container image "ghcr.io/cdxgen/cdxgen-debian-ruby34" with the argument "-t ruby${rubyVersion}"`,
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
  if (readEnvironmentVariable("BUNDLE_INSTALL_ARGS")) {
    installArgs = installArgs.concat(
      readEnvironmentVariable("BUNDLE_INSTALL_ARGS").split(" "),
    );
  }
  const gemFileLock = join(basePath, "Gemfile.lock");
  console.log(
    `Invoking ${bundleCommand} ${installArgs.join(" ")} from ${basePath} with GEM_HOME ${cdxgenGemHome}. Please wait ...`,
  );
  recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_ATTEMPTED, {
    ecosystem: "ruby",
    tool: "bundler",
    command: `${bundleCommand} ${installArgs.join(" ")}`,
    path: basePath,
    detail: "Installing the project dependencies with bundler.",
  });
  let result = safeSpawnSync(bundleCommand, installArgs, {
    shell: isWin,
    cwd: basePath,
    env: {
      ...process.env,
      GEM_HOME: cdxgenGemHome,
    },
  });
  if (result.error || result.status !== 0) {
    recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_FAILED, {
      ecosystem: "ruby",
      tool: "bundler",
      command: `${bundleCommand} ${installArgs.join(" ")}`,
      path: basePath,
      exitCode: typeof result.status === "number" ? result.status : undefined,
      detail: "The bundle install did not succeed.",
      outputExcerpt: commandOutputText(result),
    });
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
      if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true") {
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
      if (readEnvironmentVariable("BUNDLE_UPDATE_ARGS")) {
        updateArgs = updateArgs.concat(
          readEnvironmentVariable("BUNDLE_UPDATE_ARGS").split(" "),
        );
      }
      console.log(`${bundleCommand}`);
      recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_ATTEMPTED, {
        ecosystem: "ruby",
        tool: "bundler",
        command: `${bundleCommand} ${updateArgs.join(" ")}`,
        path: basePath,
        detail: "Updating the outdated lockfile with bundler.",
      });
      result = safeSpawnSync(bundleCommand, updateArgs, {
        shell: isWin,
        cwd: basePath,
        env: {
          ...process.env,
          GEM_HOME: cdxgenGemHome,
        },
      });
      if (result.error || result.status !== 0) {
        recordLedgerEvent(LEDGER_EVENT_KINDS.COMMAND_FAILED, {
          ecosystem: "ruby",
          tool: "bundler",
          command: `${bundleCommand} ${updateArgs.join(" ")}`,
          path: basePath,
          exitCode:
            typeof result.status === "number" ? result.status : undefined,
          detail: "The bundle update did not succeed.",
          outputExcerpt: commandOutputText(result),
        });
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
      if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true") {
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
      readEnvironmentVariable("CDXGEN_IN_CONTAINER") === "true" &&
      !rubyVersionWarningShown
    ) {
      console.log(
        "Are there any devel packages that could be included in the cdxgen container image to avoid these errors? Start a discussion thread here: https://github.com/cdxgen/cdxgen/discussions",
      );
      console.log("------------");
    } else if (rubyVersion) {
      console.log(
        `TIP: Try using the custom container image "ghcr.io/cdxgen/cdxgen-debian-ruby34" with the argument "-t ruby${rubyVersion}".`,
      );
    } else {
      console.log(
        `TIP: Try invoking cdxgen with a Ruby version type. With the custom container image "ghcr.io/cdxgen/cdxgen-debian-ruby34", you can pass the argument "-t ruby<version>". Example: "-t ruby3.3.6"`,
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

// process.versions keys whose configure flag is named differently.
const NODE_SHARED_FLAG_NAMES = {
  ares: "cares",
  libffi: "ffi",
  llhttp: "http_parser",
  uv: "libuv",
};

/**
 * Whether the running Node.js links a bundled dependency as a shared library,
 * from the `node_shared_<name>` configure variables it reports.
 *
 * @param {string} name key of process.versions
 * @param {Object} [variables] configure variables, process.config.variables
 *   by default
 * @returns {string|undefined} `shared`, `bundled`, or undefined when the build
 *   does not say
 */
export function nodeComponentLinkage(
  name,
  variables = globalThis.process?.config?.variables,
) {
  const flag = `node_shared_${NODE_SHARED_FLAG_NAMES[name] || name}`;
  if (!variables || !(flag in variables)) {
    return undefined;
  }
  const value = variables[flag];
  return value === true || value === "true" ? "shared" : "bundled";
}

/**
 * Get information about the runtime.
 *
 * @returns {Object} Object containing the name and version of the runtime
 */
export function getRuntimeInformation() {
  const runtimeInfo = {};
  if (isDeno) {
    runtimeInfo.runtime = "Deno";
    runtimeInfo.version = globalThis.Deno.version.deno;
  } else if (isBun) {
    runtimeInfo.runtime = "Bun";
    runtimeInfo.version = globalThis.Bun.version;
  } else if (isNode) {
    runtimeInfo.runtime = "Node.js";
    runtimeInfo.version = globalThis.process.versions.node;
    const report = process.report.getReport();
    const nodeSourceUrl = report?.header?.release?.sourceUrl;
    // Collect the bundled components in node.js
    if (report?.header?.componentVersions) {
      const nodeBundledComponents = [];
      for (const [name, version] of Object.entries(
        report.header.componentVersions,
      )) {
        if (name === "node") {
          continue;
        }
        const bundledPurl = tryBuildPurl({
          type: "generic",
          name,
          version: version || null,
        });
        // A distro or Homebrew build links some of these as shared libraries
        // (`configure --shared-brotli`); the version is then the shared
        // library's, and updating Node.js alone does not update it.
        const linkage = nodeComponentLinkage(name);
        const apkg = {
          name,
          version,
          description:
            linkage === "shared"
              ? `Linked by Node.js ${runtimeInfo.version} as a shared library`
              : `Bundled with Node.js ${runtimeInfo.version}`,
          type: "library",
          scope: "excluded",
          ...(linkage
            ? { properties: [{ name: "cdx:node:linkage", value: linkage }] }
            : {}),
        };
        applyPurl(apkg, bundledPurl);
        if (nodeSourceUrl) {
          apkg.externalReferences = [
            {
              url: nodeSourceUrl,
              type: "source-distribution",
              comment: "Node.js release url",
            },
          ];
        }
        nodeBundledComponents.push(apkg);
      }
      if (nodeBundledComponents.length) {
        runtimeInfo.components = nodeBundledComponents;
      }
    }
    if (report.sharedObjects) {
      const osSharedObjects = [];
      for (const aso of report.sharedObjects) {
        const name = basename(aso);
        if (name === "node") {
          continue;
        }
        const apkg = {
          name,
          type: "library",
          scope: "excluded",
        };
        // The absolute library path belongs in the purl subpath, which is
        // relative by definition — a leading slash makes the purl invalid, and
        // names like libstdc++.so.6 need percent-encoding. The path is also the
        // only thing distinguishing two libraries that share a basename, so it
        // has to reach the bom-ref too; `pkg:generic/${name}` collided.
        applyPurl(
          apkg,
          tryBuildPurl({
            type: "generic",
            name,
            subpath: aso ? String(aso).replace(/^\/+/, "") : null,
          }),
        );
        osSharedObjects.push(apkg);
      }
      if (osSharedObjects.length) {
        // Append rather than assign: the bundled-component list built above is
        // stored in the same property and was being silently discarded.
        runtimeInfo.components = [
          ...(runtimeInfo.components ?? []),
          ...osSharedObjects,
        ];
      }
    }
  } else {
    runtimeInfo.runtime = "Unknown";
    runtimeInfo.version = "N/A";
  }

  // The runtime hosting the cdxgen run is part of the report's
  // reproducibility context, so it is recorded alongside the scanned tools.
  const runtimeTools = { Deno: "deno", Bun: "bun", "Node.js": "node" };
  const runtimeTool = runtimeTools[runtimeInfo.runtime];
  if (runtimeTool && runtimeInfo.version && runtimeInfo.version !== "N/A") {
    recordLedgerEvent(LEDGER_EVENT_KINDS.TOOL_RESOLVED, {
      ecosystem: "generic",
      tool: runtimeTool,
      found: runtimeInfo.version,
      source: "runtime",
      detail:
        "The runtime hosting this cdxgen run, recorded for report reproducibility.",
    });
  }
  return runtimeInfo;
}

/**
 * Checks for dangerous Unicode characters that could enable homograph attacks
  if (zeroWidthChars.test(str)) {
    return true;
  }

  // Check for control characters (except common ones like \n, \r, \t)
  const controlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
  return controlChars.test(str);
}
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: validation

/**
 * Get version and runtime information
 */
export function retrieveCdxgenVersion() {
  const packageJsonAsString = readFileSync(
    join(dirNameStr, "package.json"),
    "utf-8",
  );
  const packageJson = JSON.parse(packageJsonAsString);

  const runtimeInfo = getRuntimeInformation();

  return `\x1b[1mCycloneDX Generator ${packageJson.version}\x1b[0m\nRuntime: ${runtimeInfo.runtime}, Version: ${runtimeInfo.version}`;
}

/**
 * Retrieve the version of the cdxgen plugins binary package from package.json.
 *
 * Reads the local package.json and searches the `optionalDependencies` for a package
 * whose name starts with `@cdxgen/cdxgen-plugins-bin`, returning its declared version.
 *
 * @returns {string|undefined} Version string of the plugins binary package, or undefined if not found
 */
export function retrieveCdxgenPluginVersion() {
  const packageJsonAsString = readFileSync(
    join(dirNameStr, "package.json"),
    "utf-8",
  );
  const packageJson = JSON.parse(packageJsonAsString);
  for (const adepName of Object.keys(packageJson.optionalDependencies || {})) {
    if (adepName.startsWith("@cdxgen/cdxgen-plugins-bin")) {
      return packageJson.optionalDependencies[adepName];
    }
  }
  return undefined;
}
