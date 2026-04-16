import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  bundleInstallWithDocker,
  collectRubyInfo,
  getOrInstallNvmTool,
  installRubyBundler,
  installRubyVersion,
  installSdkmanTool,
  isNvmAvailable,
  isRbenvAvailable,
  isSdkmanAvailable,
  performBundleInstall,
  runSwiftCommand,
  SDKMAN_JAVA_TOOL_ALIASES,
} from "../../helpers/envcontext.js";
import {
  DEBUG_MODE,
  getAllFiles,
  getTmpDir,
  hasAnyProjectType,
  isFeatureEnabled,
  isMac,
  isSecureMode,
  isWin,
  safeExistsSync,
  safeSpawnSync,
  TIMEOUT_MS,
} from "../../helpers/utils.js";

/**
 * Method to prepare the build environment for BOM generation purposes.
 *
 * @param {String} filePath Path
 * @param {Object} options CLI options
 */
export function prepareEnv(filePath, options) {
  if (!options.projectType || isSecureMode) {
    return;
  }
  for (const pt of options.projectType) {
    if (SDKMAN_JAVA_TOOL_ALIASES[pt]) {
      prepareSdkmanBuild(pt);
      break;
    }
  }
  if (filePath) {
    filePath = resolve(filePath);
  }
  // Check the pre-requisites for various types
  preparePythonEnv(filePath, options);
  prepareNodeEnv(filePath, options);
  prepareSwiftEnv(filePath, options);
  prepareRubyEnv(filePath, options);
}

/**
 * Method to prepare sdkman build environment for BOM generation purposes.
 *
 * @param {String} projectType Project type
 */
export function prepareSdkmanBuild(projectType) {
  if (!isSdkmanAvailable()) {
    console.log(
      "Install sdkman by following the instructions at https://sdkman.io/install",
    );
    return;
  }
  const toolType = "java";
  return installSdkmanTool(toolType, projectType);
}

/**
 * Method to check and prepare the environment for python
 *
 * @param {String} _filePath Path
 * @param {Object} options CLI Options
 */
export function preparePythonEnv(_filePath, options) {
  if (hasAnyProjectType(["python"], options, false)) {
    if (
      DEBUG_MODE &&
      process.env?.CDXGEN_IN_CONTAINER !== "true" &&
      arch() !== "x64"
    ) {
      console.log(
        `INFO: Many pypi packages have limited support for ${arch()} architecture. Run the cdxgen container image with --platform=linux/amd64 for best experience.`,
      );
    }
    if (platform() === "win32") {
      console.log(
        "Install the appropriate compilers and build tools on Windows by following this documentation - https://wiki.python.org/moin/WindowsCompilers",
      );
    }
  }
  for (const pyversion of [
    "python36",
    "python38",
    "python39",
    "python310",
    "python311",
    "python312",
    "python313",
  ]) {
    if (
      options.projectType?.includes(pyversion) &&
      !process.env.PIP_INSTALL_ARGS
    ) {
      const tempDir = mkdtempSync(join(getTmpDir(), "cdxgen-pip-"));
      const py_version_number = pyversion.replace("python3", "3.");
      process.env.PIP_INSTALL_ARGS = `--python-version ${py_version_number} --ignore-requires-python --no-warn-conflicts --only-binary=:all:`;
      process.env.PIP_TARGET = tempDir;
      if (DEBUG_MODE) {
        console.log("PIP_INSTALL_ARGS set to", process.env.PIP_INSTALL_ARGS);
        console.log("PIP_TARGET set to", process.env.PIP_TARGET);
      }
      break;
    }
  }
}

/**
 * Method to check and prepare the environment for node
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export function prepareNodeEnv(filePath, options) {
  // check tool for windows
  for (const pt of options.projectType) {
    const nodeVersion = pt.replace(/\D/g, "");
    if (
      pt.startsWith("node") &&
      nodeVersion &&
      !process.env.NODE_INSTALL_ARGS
    ) {
      if (!isNvmAvailable()) {
        if (process.env.NVM_DIR) {
          // for scenarios where nvm is not present, but
          // we have $NVM_DIR
          // custom logic to find nvmNodePath
          let nvmNodePath;
          const possibleNodeDir = join(process.env.NVM_DIR, "versions", "node");

          if (!tryLoadNvmAndInstallTool(nodeVersion)) {
            console.log(
              `Could not install Nodejs${nodeVersion}. There is a problem with loading nvm from ${process.env.NVM_DIR}`,
            );
            return;
          }

          const nodeVersionArray = readdirSync(possibleNodeDir, {
            withFileTypes: true,
          });
          const nodeRe = new RegExp(`^v${nodeVersion}.`);
          for (const nodeVersionsIter of nodeVersionArray) {
            const fullPath = join(possibleNodeDir, nodeVersionsIter.name);
            if (
              nodeVersionsIter.isDirectory() &&
              nodeRe.test(nodeVersionsIter.name)
            ) {
              nvmNodePath = join(fullPath, "bin");
            }
          }
          if (nvmNodePath) {
            doNpmInstall(filePath, nvmNodePath);
          } else {
            console.log(
              `"node version ${nodeVersion} was not found. Please install it with 'nvm install ${nodeVersion}"`,
            );
            return;
          }
        } else {
          console.log(
            "Install nvm by following the instructions at https://github.com/nvm-sh/nvm",
          );
          return;
        }
      }
      // set path instead of nvm use
      const nvmNodePath = getOrInstallNvmTool(nodeVersion);
      doNpmInstall(filePath, nvmNodePath);
    }
  }
}

/**
 * If NVM_DIR is in path, however nvm command is not loaded.
 * it is possible that required nodeVersion is not installed.
 * This function loads nvm and install the nodeVersion
 *
 * @param {String} nodeVersion required version number
 *
 * @returns {Boolean} true if successful, otherwise false
 */
export function tryLoadNvmAndInstallTool(nodeVersion) {
  const NVM_DIR = process.env.NVM_DIR;

  const command = `
      if [ -f ${NVM_DIR}/nvm.sh ]; then
        . ${NVM_DIR}/nvm.sh
        nvm install ${nodeVersion}
      else
        echo "NVM script not found at ${NVM_DIR}/nvm.sh"
        exit 1
      fi
      `;

  const result = safeSpawnSync(process.env.SHELL || "bash", ["-c", command], {
    encoding: "utf-8",
    shell: process.env.SHELL || true,
  });

  return result.status === 0;
}

/**
 * This method installs and create package-lock.json
 *
 * @param {String} filePath Path
 * @param {String} nvmNodePath Path to node version in nvm
 */
export function doNpmInstall(filePath, nvmNodePath) {
  // we do not install if INSTALL_ARGS set false
  if (["0", "false"].includes(process.env?.NODE_INSTALL_ARGS)) {
    return;
  }
  const newPath = `${nvmNodePath}${delimiter}${process.env.PATH}`;
  let installArgs = process.env.NPM_INSTALL_ARGS || "--package-lock-only";
  const installCommand = "install";
  if (isSecureMode) {
    installArgs = `${installArgs} --ignore-scripts --no-audit`;
  }
  const resultNpmInstall = safeSpawnSync(
    process.env.SHELL || "bash",
    [
      "-i",
      "-c",
      `export PATH='${nvmNodePath}${delimiter}$PATH' && npm ${installCommand} ${installArgs}`,
    ],
    {
      encoding: "utf-8",
      shell: process.env.SHELL || true,
      timeout: TIMEOUT_MS,
      cwd: filePath,
      env: {
        ...process.env,
        PATH: newPath,
      },
    },
  );

  if (resultNpmInstall.status !== 0 || resultNpmInstall.error) {
    // There was some problem with NpmInstall
    if (DEBUG_MODE) {
      if (resultNpmInstall.stdout) {
        console.log(resultNpmInstall.stdout);
      }
      if (resultNpmInstall.stderr) {
        console.log(resultNpmInstall.stderr);
      }
    }
  }
}

/**
 * Method to check and build the swift project
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export function prepareSwiftEnv(filePath, options) {
  if (!hasAnyProjectType(["swift"], options, false)) {
    return;
  }
  if (platform() === "win32") {
    console.log(
      "Ensure Swift for Windows is installed by following the instructions at https://www.swift.org/install/windows/",
    );
  }
  if (
    process.env?.CDXGEN_IN_CONTAINER !== "true" &&
    platform() === "linux" &&
    arch() !== "x64"
  ) {
    console.log(
      "INFO: Swift for Linux has known issues on non x64 machines. Run the cdxgen container image with --platform=linux/amd64 for best experience.",
    );
  }
  if (options.deep || options?.lifecycle?.includes("post-build")) {
    const swiftFiles = getAllFiles(
      filePath,
      `${options.multiProject ? "**/" : ""}Package*.swift`,
      options,
    );
    const pkgResolvedFiles = getAllFiles(
      filePath,
      `${options.multiProject ? "**/" : ""}Package.resolved`,
      options,
    );
    const outputFileMaps = getAllFiles(
      filePath,
      ".build/**/debug/**/output-file-map.json",
      options,
    );
    const fastlaneFiles = getAllFiles(
      filePath,
      `${options.multiProject ? "**/" : ""}Fastfile`,
      options,
    );
    if (
      (!pkgResolvedFiles.length || !outputFileMaps.length) &&
      swiftFiles.length
    ) {
      if (fastlaneFiles.length) {
        console.log(
          "For best results, build the project using the 'bundle exec fastlane' command prior to invoking cdxgen.",
        );
        console.log(
          "Look for any Makefile or CI workflow files to identify the full command along with the arguments to build this project.\nYou may also need access to keychain and private dependencies used.",
        );
        return;
      }
      for (const f of swiftFiles) {
        const basePath = dirname(f);
        console.log(
          "Attempting to generate the Package.resolved file",
          basePath,
        );
        const cmdOutput = runSwiftCommand(basePath, [
          "package",
          "-v",
          "resolve",
        ]);
        const resolvedFile = join(basePath, "Package.resolved");
        if (!cmdOutput) {
          console.log(
            "The Swift package command did not yield the expected result. Build this project manually before invoking cdxgen.",
          );
        }
        if (!safeExistsSync(resolvedFile)) {
          console.log(
            "Package.resolved file did not get generated successfully. Check the Package.swift file for declared dependencies.\nCheck if any private registry needs to be configured for the build to succeed.",
          );
        }
      }
    }
  }
}

/**
 * Method to check and prepare the environment for Ruby projects
 *
 * @param {String} filePath Path
 * @param {Object} options CLI Options
 */
export function prepareRubyEnv(filePath, options) {
  // Skip preparation early
  if (
    !hasAnyProjectType(["ruby"], options, false) ||
    !options.installDeps ||
    options?.lifecycle?.includes("pre-build")
  ) {
    return;
  }
  const gemFiles = getAllFiles(
    filePath,
    `${options.multiProject ? "**/" : ""}Gemfile`,
    {
      ...options,
      exclude: (options.exclude || []).concat([
        "**/vendor/cache/**",
        "**/vendor/bundle/**",
      ]),
    },
  );
  if (!gemFiles.length) {
    return;
  }
  const gemLockFiles = getAllFiles(
    filePath,
    `${options.multiProject ? "**/" : ""}Gemfile*.lock`,
    {
      ...options,
      exclude: (options.exclude || []).concat([
        "**/vendor/cache/**",
        "**/vendor/bundle/**",
      ]),
    },
  );
  if (gemLockFiles.length && !options.deep) {
    return;
  }
  let rubyVersionNeeded;
  const rbenvPresent = isRbenvAvailable();
  const cdxgenGemHome =
    process.env.CDXGEN_GEM_HOME ||
    process.env.BUNDLE_PATH ||
    process.env.GEM_HOME ||
    mkdtempSync(join(getTmpDir(), "cdxgen-gem-home-"));
  process.env.CDXGEN_GEM_HOME = cdxgenGemHome;
  // Is there a .ruby-version file in the project?
  if (safeExistsSync(join(filePath, ".ruby-version"))) {
    rubyVersionNeeded = readFileSync(join(filePath, ".ruby-version"), {
      encoding: "utf-8",
    })
      .trim()
      .replace("ruby-", "");
  } else if (safeExistsSync(join(filePath, "Gemfile.lock"))) {
    // Is there a lock file that can be used to identify the needed Ruby version?
    const gemlockData = readFileSync(join(filePath, "Gemfile.lock"), {
      encoding: "utf-8",
    });
    let rubyVersionMarker = false;
    for (let l of gemlockData.split("\n")) {
      l = l.replace("\r", "").trim();
      if (l.includes("RUBY VERSION")) {
        rubyVersionMarker = true;
      }
      if (rubyVersionMarker && l.includes("ruby ")) {
        const possibleVersion = l
          .split("ruby ")
          .pop()
          .split("p")[0]
          .split("d")[0];
        if (/^\d+/.test(possibleVersion)) {
          rubyVersionNeeded = possibleVersion;
          break;
        }
      }
    }
  } else {
    // Is the user invoking with a ruby with custom version type. Eg: -t ruby2.5.4
    let projectTypes = options.projectType;
    if (
      options.projectType &&
      (typeof options.projectType === "string" ||
        options.projectType instanceof String)
    ) {
      projectTypes = options.projectType.split(",");
    }
    for (const apt of projectTypes) {
      if (!apt.startsWith("ruby")) {
        continue;
      }
      const possibleVersion = apt.replace("ruby", "");
      if (/^\d+/.test(possibleVersion)) {
        rubyVersionNeeded = possibleVersion;
        break;
      }
    }
  }
  // Do we already have this version
  const existingRuby = collectRubyInfo(filePath);
  if (
    rubyVersionNeeded &&
    existingRuby?.version?.startsWith(`ruby ${rubyVersionNeeded} `)
  ) {
    if (DEBUG_MODE) {
      console.log(`Required Ruby version ${rubyVersionNeeded} is present.`);
    }
    process.env.CDXGEN_RUBY_CMD = "ruby";
    process.env.CDXGEN_GEM_CMD = "gem";
    process.env.CDXGEN_BUNDLE_CMD = "bundle";
    rubyVersionNeeded = undefined;
    // Do we have a proper GEM_HOME already?
    if (cdxgenGemHome && safeExistsSync(cdxgenGemHome)) {
      const gemspecFiles = getAllFiles(
        cdxgenGemHome,
        "**/specifications/**/*.gemspec",
        options,
      );
      if (gemspecFiles.length > 3) {
        return;
      }
    }
  }
  if (rubyVersionNeeded && !rbenvPresent) {
    console.log(
      `This project requires Ruby ${rubyVersionNeeded}. cdxgen can automatically install the required version of Ruby with rbenv command.`,
    );
    if (process.env?.CDXGEN_IN_CONTAINER !== "true") {
      console.log(
        "Try using the container image ghcr.io/cyclonedx/cdxgen, which includes the rbenv command along with the dependencies such as ruby-build, rust, etc for successful compilation.",
      );
      if (isMac) {
        console.log(
          "Alternatively, install rbenv with homebrew `brew install rbenv`, followed by `rbenv init`",
        );
      }
    }
  }
  if (rubyVersionNeeded) {
    // Should we use docker
    if (isFeatureEnabled(options, "ruby-docker-install") || isWin) {
      for (const agemf of gemFiles) {
        bundleInstallWithDocker(
          rubyVersionNeeded,
          cdxgenGemHome,
          dirname(agemf),
        );
      }
      if (DEBUG_MODE) {
        const gemspecFiles = getAllFiles(
          cdxgenGemHome,
          `${options.multiProject ? "**/" : ""}*.gemspec`,
          options,
        );
        if (gemspecFiles.length > 3) {
          console.log(
            `GEM_HOME ${cdxgenGemHome} includes ${gemspecFiles.length} .gemspec files. Bundle install with docker was successful.`,
          );
        }
      }
      return;
    }
    if (isMac) {
      console.log(
        "Installing Ruby with rbenv on macOS could fail for a variety of reasons.",
      );
      console.log(
        `TIP: Use the custom container image "ghcr.io/cyclonedx/cdxgen-debian-ruby34" with the argument "-t ruby${rubyVersionNeeded}".`,
      );
    }
    // Try rbenv install
    const { fullToolBinDir, status } = installRubyVersion(
      rubyVersionNeeded,
      filePath,
    );
    let bundleTool = "bundle";
    if (status) {
      if (fullToolBinDir) {
        if (!process.env?.PATH?.includes(`versions/${rubyVersionNeeded}`)) {
          process.env.PATH = `${fullToolBinDir}${delimiter}${process.env.PATH}`;
        }
        process.env.CDXGEN_RUBY_CMD = join(fullToolBinDir, "ruby");
        process.env.CDXGEN_GEM_CMD = join(fullToolBinDir, "gem");
        process.env.CDXGEN_BUNDLE_CMD = join(fullToolBinDir, "bundle");
        bundleTool = join(fullToolBinDir, "bundle");
        process.env.CDXGEN_BUNDLE_CMD = bundleTool;
        if (!safeExistsSync(bundleTool)) {
          const bundlerStatus = installRubyBundler(
            rubyVersionNeeded,
            undefined,
          );
          if (!bundlerStatus && !process.env.CDXGEN_DEBUG_MODE) {
            console.log(
              "bundler didn't get installed successfully. Set the environment variable CDXGEN_DEBUG_MODE=debug to troubleshoot.",
            );
          }
        }
      }
      // Do we have a proper GEM_HOME already?
      if (cdxgenGemHome && safeExistsSync(cdxgenGemHome)) {
        const gemspecFiles = getAllFiles(
          cdxgenGemHome,
          "**/specifications/**/*.gemspec",
          {
            ...options,
            exclude: (options.exclude || []).concat([
              "**/vendor/cache/**",
              "**/vendor/bundle/**",
            ]),
          },
        );
        if (gemspecFiles.length > 3) {
          if (DEBUG_MODE) {
            console.log(
              `GEM_HOME ${cdxgenGemHome} includes ${gemspecFiles.length} .gemspec files. Skipping bundle install.`,
            );
          }
          return;
        }
      }
      if (
        bundleTool &&
        (bundleTool === "bundle" || safeExistsSync(bundleTool))
      ) {
        if (DEBUG_MODE) {
          if (bundleTool === "bundle") {
            console.log("cdxgen will use the default bundle command.");
          } else {
            console.log(`bundle command is available at ${bundleTool}`);
          }
        }
        // Invoke bundle install
        for (const agemf of gemFiles) {
          performBundleInstall(
            cdxgenGemHome,
            rubyVersionNeeded,
            bundleTool,
            dirname(agemf),
          );
        }
      }
    } else {
      console.log(`Ruby install has failed for version ${rubyVersionNeeded}.`);
      options.deep && options.failOnError && process.exit(1);
    }
  } else {
    // Just attempt bundle install
    console.log(
      "Attempting bundle install with the default Ruby installation.",
    );
    for (const agemf of gemFiles) {
      performBundleInstall(
        cdxgenGemHome,
        rubyVersionNeeded,
        "bundle",
        dirname(agemf),
      );
    }
  }
}
