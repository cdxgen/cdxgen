import { readdirSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import {
  delimiter as _delimiter,
  basename,
  dirname,
  join,
  resolve,
  sep,
} from "node:path";
import process from "node:process";

import { build } from "@cdxgen/cdx-purl";

import {
  DEBUG_MODE,
  isSecureMode,
  readEnvironmentVariable,
} from "../core/activity.js";
import { PYTHON_CMD, PYTHON_EXCLUDED_COMPONENTS } from "../core/env.js";
import { getAllFiles, safeExistsSync, safeSpawnSync } from "../core/fs.js";
import { thoughtLog } from "../core/logger.js";
import { isWin } from "../core/paths.js";
import {
  PYPI_MODULE_PACKAGE_MAPPING,
  PYTHON_STD_MODULES,
} from "../core/state.js";
import { findAppModules } from "../inventory/atomUtils.js";
import { flattenDeps } from "../inventory/deps.js";
import { pypiBomRef } from "../inventory/purl.js";
import { getPyMetadata } from "./ecosystems.js";
import { parseReqFile } from "./parsers-python.js";

/**
 * Universal virtual environment metadata detector
 * @param {Object} env - Environment variables (defaults to process.env)
 * @param {string} [explicitPath] - Optional explicit venv path to inspect
 * @returns {Object} Structured environment metadata
 */
export function getVenvMetadata(env = process.env, explicitPath = null) {
  const result = {
    type: "system", // 'uv' | 'venv' | 'conda' | 'miniconda' | 'pyenv' | 'poetry' | 'pipenv' | 'virtualenv' | 'pixi' | 'bazel' | 'rye' | 'hatch' | 'pdm' | 'system' | 'unknown'
    path: null,
    isActive: false,
    pythonExecutable: null,
    pythonVersion: "unknown",
    pythonImplementation: null,
    toolVersion: null,
    uv: null,
    conda: null,
    pyenv: null,
    poetry: null,
    pipenv: null,
    pixi: null,
  };
  let venvPath = explicitPath;
  if (!venvPath) {
    if (env.VIRTUAL_ENV) {
      venvPath = env.VIRTUAL_ENV;
      result.isActive = true;
    } else if (env.CONDA_PREFIX) {
      venvPath = env.CONDA_PREFIX;
      result.isActive = true;
    } else if (env.PIXI_PROJECT_ROOT && env.PIXI_ENVIRONMENT_NAME) {
      venvPath = join(
        env.PIXI_PROJECT_ROOT,
        ".pixi",
        "envs",
        env.PIXI_ENVIRONMENT_NAME,
      );
      result.isActive = true;
    } else if (env.CONDA_PYTHON_EXE && safeExistsSync(env.CONDA_PYTHON_EXE)) {
      result.pythonExecutable = env.CONDA_PYTHON_EXE;
      result.type = "conda";
    }
  }
  if (!venvPath) {
    return result;
  }
  result.path = venvPath;
  const isWin = process.platform === "win32";
  const binDir = isWin ? "Scripts" : "bin";
  const exeNames = isWin
    ? ["python.exe", "python3.exe"]
    : ["python", "python3"];
  if (!isWin) {
    for (let minor = 16; minor >= 6; minor--) {
      exeNames.push(`python3.${minor}`);
    }
  }
  for (const exe of exeNames) {
    const candidate = join(venvPath, binDir, exe);
    if (safeExistsSync(candidate)) {
      result.pythonExecutable = candidate;
      break;
    }
  }
  if (!result.pythonExecutable && isWin) {
    const rootExe = join(venvPath, "python.exe");
    if (safeExistsSync(rootExe)) {
      result.pythonExecutable = rootExe;
    }
  }
  if (
    env.BUILD_WORKSPACE_DIRECTORY ||
    venvPath.includes("bazel-out") ||
    venvPath.includes(".runfiles")
  ) {
    result.type = "bazel";
    return result;
  }
  const isLocalVenv = basename(venvPath) === ".venv";
  const projectRoot = isLocalVenv ? dirname(venvPath) : null;
  const pyvenvCfgPath = join(venvPath, "pyvenv.cfg");
  if (safeExistsSync(pyvenvCfgPath)) {
    const cfg = _parsePyvenvCfg(pyvenvCfgPath);
    result.pythonVersion = cfg.version_info || "unknown";
    result.pythonImplementation = cfg.implementation || null;
    if (cfg.uv) {
      result.type = "uv";
      result.toolVersion = cfg.uv;
      result.uv = { version: cfg.uv, home: cfg.home };
      return result;
    }
    if (
      env.POETRY_ACTIVE === "1" ||
      venvPath.includes(`pypoetry${sep}virtualenvs`) ||
      (projectRoot && safeExistsSync(join(projectRoot, "poetry.lock")))
    ) {
      result.type = "poetry";
      if (projectRoot) result.poetry = { projectRoot };
      const lockFile = projectRoot ? join(projectRoot, "poetry.lock") : null;
      if (lockFile && safeExistsSync(lockFile)) {
        const poetryVersion = _extractPoetryVersion(lockFile);
        if (poetryVersion) result.toolVersion = poetryVersion;
      }
      return result;
    }
    if (
      env.PIPENV_ACTIVE === "1" ||
      venvPath.includes(`.virtualenvs${sep}`) ||
      (projectRoot && safeExistsSync(join(projectRoot, "Pipfile")))
    ) {
      result.type = "pipenv";
      if (projectRoot) result.pipenv = { projectRoot };
      return result;
    }
    if (
      env.RYE_ACTIVE === "1" ||
      (projectRoot &&
        safeExistsSync(join(projectRoot, "requirements.lock")) &&
        safeExistsSync(join(projectRoot, ".rye")))
    ) {
      result.type = "rye";
      return result;
    }
    if (env.HATCH_ENV_ACTIVE || venvPath.includes(`hatch${sep}env`)) {
      result.type = "hatch";
      return result;
    }
    if (
      env.PDM_ACTIVE === "1" ||
      (projectRoot && safeExistsSync(join(projectRoot, "pdm.lock")))
    ) {
      result.type = "pdm";
      return result;
    }
    if (cfg.virtualenv) {
      result.type = "virtualenv";
      result.toolVersion = cfg.virtualenv;
    } else {
      result.type = "venv";
    }
    return result;
  }

  const condaMetaDir = join(venvPath, "conda-meta");
  if (safeExistsSync(condaMetaDir)) {
    if (env.PIXI_PROJECT_ROOT || venvPath.includes(`.pixi${sep}envs`)) {
      result.type = "pixi";
      result.pixi = {
        projectRoot:
          env.PIXI_PROJECT_ROOT || dirname(dirname(dirname(venvPath))),
      };
    } else {
      result.type =
        env.CONDA_PREFIX?.includes("miniconda") ||
        env.CONDA_PREFIX?.includes("mini")
          ? "miniconda"
          : "conda";
      result.conda = {
        name: env.CONDA_DEFAULT_ENV || basename(venvPath),
        prefix: venvPath,
      };
    }
    if (env.CONDA_VERSION) {
      result.toolVersion = env.CONDA_VERSION;
    } else {
      const historyPath = join(condaMetaDir, "history");
      if (safeExistsSync(historyPath)) {
        const condaVersion = _extractCondaVersion(historyPath);
        if (condaVersion) result.toolVersion = condaVersion;
      }
    }
    const pythonPkgs = _findCondaPythonPackage(condaMetaDir);
    if (pythonPkgs?.version) {
      result.pythonVersion = pythonPkgs.version;
    }
    return result;
  }
  if (env.PYENV_ROOT && venvPath.startsWith(env.PYENV_ROOT)) {
    result.type = "pyenv";
    const versionsDir = join(env.PYENV_ROOT, "versions");
    if (venvPath.startsWith(`${versionsDir}${sep}`)) {
      const version = basename(venvPath);
      result.pyenv = { version, path: venvPath };
      result.pythonVersion = version;
    }
    return result;
  }
  result.type = "unknown";
  return result;
}

/**
 * Parse pyvenv.cfg file into key-value object
 */
function _parsePyvenvCfg(filePath) {
  const result = {};
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        result[key.trim()] = value.trim();
      }
    }
  } catch (_err) {
    // Return empty on error
  }
  return result;
}

/**
 * Extract poetry version from poetry.lock file
 */
function _extractPoetryVersion(lockPath) {
  try {
    const content = readFileSync(lockPath, "utf-8");
    const match = content.match(/^\s*poetry-version\s*=\s*"([^"]+)"/m);
    return match ? match[1] : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Extract conda version from conda-meta/history
 */
function _extractCondaVersion(historyPath) {
  try {
    const content = readFileSync(historyPath, "utf-8");
    const match = content.match(/conda version:\s*(\S+)/i);
    return match ? match[1] : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Find python package info in conda-meta directory
 */
function _findCondaPythonPackage(condaMetaDir) {
  try {
    const files = readdirSync(condaMetaDir);
    const pythonFile = files.find(
      (f) => f.startsWith("python-") && f.endsWith(".json"),
    );
    if (!pythonFile) return null;

    const pkgInfo = JSON.parse(
      readFileSync(join(condaMetaDir, pythonFile), "utf-8"),
    );
    return {
      version: pkgInfo?.version,
      build: pkgInfo?.build,
    };
  } catch (_err) {
    return null;
  }
}

/**
 * Determines the appropriate Python executable path from a virtual environment.
 * Inspects the virtual environment metadata to detect the Python type (system,
 * conda, pyenv, etc.) and returns the most specific executable found, falling
 * back to the global `PYTHON_CMD` constant when no executable is detected.
 *
 * @param {string} env Path to the Python virtual environment directory
 * @returns {string} Path to the Python executable or the fallback command name
 */
export function get_python_command_from_env(env) {
  const fallbackCmd = PYTHON_CMD;
  const meta = getVenvMetadata(env);
  const pyVersionTxt =
    meta.pythonVersion && meta.pythonVersion !== "unknown"
      ? ` version ${meta.pythonVersion}`
      : "";
  if (meta.type === "system") {
    thoughtLog(
      `I'm operating with system-managed python${pyVersionTxt}. I should be careful with the virtualenv creation and dependency tree construction.`,
    );
  } else if (meta.type === "unknown") {
    thoughtLog(
      `I'm operating with an unmanaged python${pyVersionTxt}. Let's check if pip and virtualenv packages are available.`,
    );
  } else {
    thoughtLog(`Looks like python${pyVersionTxt} is managed by ${meta.type}.`);
  }
  if (meta?.pythonExecutable) {
    if (DEBUG_MODE) {
      console.log(
        `Found python${pyVersionTxt} at ${meta.pythonExecutable} managed by ${meta.type}.`,
      );
    }
    return meta.pythonExecutable;
  }
  return fallbackCmd;
}

/** Directories that hold installed packages, not the project's own code. */
const INSTALLED_PACKAGE_DIRS = [
  "**/site-packages/**",
  "**/dist-packages/**",
  "**/.venv/**",
  "**/venv/**",
  "**/.tox/**",
  "**/.nox/**",
  "**/__pypackages__/**",
  "**/node_modules/**",
];

const projectModuleNamesCache = new Map();

/**
 * The top-level packages and modules a project provides, wherever they sit
 * in its tree: each outermost package directory (one with an `__init__.py`
 * whose parent has none), and the module files beside such packages, since
 * their directory is a source root. Directories of installed packages
 * (virtual environments, `site-packages`) are not the project's.
 *
 * @param {string} src Path to the project being analysed
 * @returns {Set<string>} Module names
 */
export function projectModuleNames(src) {
  const root = resolve(src);
  if (projectModuleNamesCache.has(root)) {
    return projectModuleNamesCache.get(root);
  }
  const names = new Set();
  const sourceRoots = new Set();
  const inits = getAllFiles(root, "**/__init__.py", {
    exclude: INSTALLED_PACKAGE_DIRS,
  });
  for (const init of inits) {
    let pkgDir = dirname(resolve(init));
    while (
      dirname(pkgDir) !== root &&
      dirname(pkgDir).startsWith(root) &&
      safeExistsSync(join(dirname(pkgDir), "__init__.py"))
    ) {
      pkgDir = dirname(pkgDir);
    }
    if (pkgDir === root) {
      continue;
    }
    names.add(basename(pkgDir));
    sourceRoots.add(dirname(pkgDir));
  }
  for (const dir of sourceRoots) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".py") && f !== "__init__.py") {
          names.add(f.slice(0, -3));
        }
      }
    } catch {
      // an unreadable directory provides nothing
    }
  }
  projectModuleNamesCache.set(root, names);
  return names;
}

/**
 * Is this import satisfied by a module that lives in the project itself?
 *
 * `atom parsedeps` reports every non-stdlib import it sees, including imports of the
 * project's own packages. Attributing those to a distribution invents dependencies:
 * `data/pypi-pkg-aliases.json` maps the module `app` to `zope2`, `test` to `pytabix`,
 * `models` to `asposestorage` and `src` to `auto-mix-prep`, so any project with a
 * local package of that name acquires an obscure component it never depended on -
 * along with every namespace and tag that component carries downstream. Filtering by
 * name would need a denylist of every plausible first-party name; asking the
 * filesystem whether the module is ours answers it exactly.
 *
 * Checks the project root and a `src/` layout for a module file, a package directory,
 * and a PEP 420 namespace package directory, then the top-level packages found
 * anywhere in the project and the modules beside them (tool-heavy repositories
 * keep their Python libraries in places such as `dev_tools/pylibs/`).
 *
 * @param {string} src Path to the project being analysed
 * @param {string} name Imported top-level module name
 * @returns {boolean} `true` if the project supplies this module itself
 */
export function isFirstPartyModule(src, name) {
  if (!src || !name || name.includes("/") || name.includes("\\")) {
    return false;
  }
  if (projectModuleNames(src).has(name)) {
    return true;
  }
  for (const root of [src, join(src, "src")]) {
    if (
      safeExistsSync(join(root, `${name}.py`)) ||
      safeExistsSync(join(root, name, "__init__.py")) ||
      safeExistsSync(join(root, name, "__main__.py"))
    ) {
      return true;
    }
    // PEP 420 namespace package: a directory of the right name holding python
    // sources but no __init__.py.
    const candidate = join(root, name);
    if (safeExistsSync(candidate)) {
      try {
        if (readdirSync(candidate).some((f) => f.endsWith(".py"))) {
          return true;
        }
      } catch {
        // not a readable directory - treat as not first-party
      }
    }
  }
  return false;
}

/**
 * Whether a directory holds Python sources for atom to parse.
 *
 * The search skips the directories the manifest searches skip, such as
 * node_modules and dot directories, and honours the exclude patterns, so a
 * Python file shipped inside an npm package does not count.
 *
 * @param {string} src directory
 * @param {Object} options CLI options
 * @returns {boolean} true when the directory holds at least one Python file
 */
export function hasPythonSources(src, options = {}) {
  return getAllFiles(src, "**/*.py", options).length > 0;
}

/**
 * Method to find python modules by parsing the imports and then checking with PyPI to obtain the latest version
 *
 * @param {string} src directory
 * @param {Array} epkgList Existing package list
 * @param {Object} options CLI options
 * @returns List of packages
 */
export async function getPyModules(src, epkgList, options) {
  const allImports = {};
  const dependenciesList = [];
  let modList = [];
  const requestedSlicesFile =
    options.depsSlicesFile || options.usagesSlicesFile;
  let slicesFile = requestedSlicesFile
    ? resolve(requestedSlicesFile)
    : undefined;
  // Issue: 615 fix. Reuse existing slices file
  if (slicesFile && safeExistsSync(slicesFile)) {
    const slicesData = JSON.parse(readFileSync(slicesFile, "utf-8"));
    if (slicesData && Object.keys(slicesData) && slicesData.modules) {
      modList = slicesData.modules;
    } else {
      modList = slicesData;
    }
  } else if (hasPythonSources(src, options)) {
    // A new slices file is kept where it was asked for only when the evidence
    // step will read it again; otherwise atom writes it to a temporary
    // directory instead of the working directory.
    if (!options.evidence) {
      slicesFile = undefined;
    }
    modList = findAppModules(src, "python", "parsedeps", slicesFile, options);
  } else {
    thoughtLog(
      `There are no Python sources at '${src}', so atom parsedeps has nothing to read.`,
    );
  }
  const pyDefaultModules = new Set(PYTHON_STD_MODULES);
  modList = modList.filter(
    (x) =>
      !pyDefaultModules.has(x.name.toLowerCase()) &&
      !x.name.startsWith("_") &&
      !x.name.startsWith(".") &&
      !isFirstPartyModule(src, x.name),
  );
  let pkgList = modList.map((p) => {
    const apkg = {
      name:
        PYPI_MODULE_PACKAGE_MAPPING[p.name.toLowerCase()] ||
        PYPI_MODULE_PACKAGE_MAPPING[p.name.replace(/_/g, "-").toLowerCase()] ||
        p.name.replace(/_/g, "-").toLowerCase(),
      version: p.version?.trim().length ? p.version : undefined,
      scope: "required",
      properties: [
        {
          name: "cdx:pypi:versionSpecifiers",
          value: p.versionSpecifiers,
        },
      ],
    };
    if (p.importedSymbols) {
      apkg.properties.push({
        name: "internal:ImportedModules",
        value: p.importedSymbols,
      });
    }
    return apkg;
  });
  pkgList = pkgList.filter(
    (obj, index) => pkgList.findIndex((i) => i.name === obj.name) === index,
  );
  if (epkgList?.length) {
    const pkgMaps = epkgList.map((p) => p.name);
    pkgList = pkgList.filter((p) => !pkgMaps.includes(p.name));
  }
  pkgList = await getPyMetadata(pkgList, true);
  // Populate the imports list after dealiasing
  if (pkgList?.length) {
    pkgList.forEach((p) => {
      allImports[p.name] = true;
    });
  }
  for (const p of pkgList) {
    if (p.version) {
      dependenciesList.push({
        ref: pypiBomRef(p.name, p.version),
        dependsOn: [],
      });
    }
  }
  return { allImports, pkgList, dependenciesList, modList };
}

/**
 * Create uv.lock file with uv sync command.
 *
 * @param {string} basePath Path
 * @param {Object} options CLI options
 */
export function createUVLock(basePath, options) {
  const python_cmd = get_python_command_from_env(process.env);
  let uvSyncArgs = ["-m", "uv", "sync"];
  // Do not update the lock file in pre-build mode
  if (options?.lifecycle?.includes("pre-build")) {
    uvSyncArgs.push("--frozen");
  } else if (options?.recurse) {
    uvSyncArgs = uvSyncArgs.concat(["--all-groups", "--all-packages"]);
  }
  // Install everything and do not remove anything extraneous
  if (options?.deep) {
    uvSyncArgs = uvSyncArgs.concat(["--all-extras", "--inexact"]);
  }
  if (process?.env?.UV_INSTALL_ARGS) {
    const addArgs = readEnvironmentVariable("UV_INSTALL_ARGS").split(" ");
    uvSyncArgs = uvSyncArgs.concat(addArgs);
  }
  if (DEBUG_MODE) {
    console.log(
      `Executing ${python_cmd} ${uvSyncArgs.join(" ")} in ${basePath}`,
    );
  }
  let result = safeSpawnSync(python_cmd, uvSyncArgs, {
    shell: isWin,
    cwd: basePath,
  });
  if (result.status !== 0 || result.error) {
    if (result?.stderr?.includes("No module named uv")) {
      if (DEBUG_MODE) {
        console.log(`Executing uv sync in ${basePath}`);
      }
      result = safeSpawnSync("uv", ["sync"], {
        shell: isWin,
        cwd: basePath,
      });
      if (result.status !== 0 || result.error) {
        console.log("Check if uv is installed and available in PATH.");
        if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
          console.log(
            "Use the cdxgen container image which comes with uv installed.",
          );
        }
        console.log(result.stderr);
      }
    } else {
      console.log(result.stderr);
    }
  }
}

/**
 * Execute pip freeze by creating a virtual env in a temp directory and construct the dependency tree
 *
 * @param {string} basePath Base path
 * @param {string} reqOrSetupFile Requirements or setup.py file
 * @param {string} tempVenvDir Temp venv dir
 * @param {Object} parentComponent Parent component
 *
 * @returns {Object} List of packages from the virtual env
 */
export async function getPipFrozenTree(
  basePath,
  reqOrSetupFile,
  tempVenvDir,
  parentComponent,
  projectRoot,
  getTreeWithPluginFn,
) {
  const pkgList = [];
  const formulationList = [];
  const rootList = [];
  const dependenciesList = [];
  let result;
  let frozen = true;
  const env = {
    ...process.env,
  };
  if (!env.CFLAGS) {
    env.CFLAGS = "-fcommon";
  } else if (!env.CFLAGS.includes("-fcommon")) {
    env.CFLAGS = `${env.CFLAGS} -fcommon`;
  }

  const explicitDeps = new Set();
  if (reqOrSetupFile?.endsWith(".txt") && safeExistsSync(reqOrSetupFile)) {
    // We only need the package names, so we pass `false` to avoid fetching full metadata.
    const tempPkgList = await parseReqFile(reqOrSetupFile, null, false);
    for (const pkg of tempPkgList) {
      if (pkg.name) {
        explicitDeps.add(pkg.name.replace(/_/g, "-").toLowerCase());
      }
    }
  }

  /**
   * Let's start with an attempt to create a new temporary virtual environment in case we aren't in one
   *
   * By checking the environment variable "VIRTUAL_ENV" we decide whether to create an env or not
   */
  if (
    !readEnvironmentVariable("VIRTUAL_ENV") &&
    !readEnvironmentVariable("CONDA_PREFIX") &&
    reqOrSetupFile &&
    !reqOrSetupFile.endsWith("poetry.lock")
  ) {
    thoughtLog(
      "Let me create a new virtual environment for installing the packages with pip.",
    );
    const venvCreationArgs = ["-m", "venv", tempVenvDir];
    if (isSecureMode) {
      venvCreationArgs.unshift("-S");
    }
    result = safeSpawnSync(PYTHON_CMD, venvCreationArgs, {
      shell: isWin,
    });
    if (result.status !== 0 || result.error) {
      frozen = false;
      if (DEBUG_MODE) {
        console.log("Virtual env creation has failed");
        if (result.stderr?.includes("safeSpawnSync python ENOENT")) {
          console.log(
            "Install suitable version of python or set the environment variable PYTHON_CMD.",
          );
        }
      }
    } else {
      if (DEBUG_MODE) {
        console.log("Using the virtual environment", tempVenvDir);
      }
      env.VIRTUAL_ENV = tempVenvDir;
      env.PATH = `${join(
        tempVenvDir,
        platform() === "win32" ? "Scripts" : "bin",
      )}${_delimiter}${readEnvironmentVariable("PATH") || ""}`;
      // When cdxgen is invoked with the container image, we seem to be including unnecessary packages from the image.
      // This workaround, unsets PYTHONPATH to suppress the pre-installed packages
      if (
        env?.PYTHONPATH === "/opt/pypi" &&
        env?.CDXGEN_IN_CONTAINER === "true"
      ) {
        env.PYTHONPATH = undefined;
      }
    }
  }
  const venvMeta = getVenvMetadata(env);
  const python_cmd_for_tree = get_python_command_from_env(env);
  // Check if pyproject.toml is actually a uv-configured workspace
  let hasToolUv = false;
  let hasToolPoetry = false;
  if (
    reqOrSetupFile?.endsWith("pyproject.toml") &&
    safeExistsSync(reqOrSetupFile)
  ) {
    try {
      const content = readFileSync(reqOrSetupFile, "utf-8");
      hasToolUv = content.includes("[tool.uv]");
      hasToolPoetry = content.includes('build-backend = "poetry.core');
    } catch (_err) {
      // Ignore read error
    }
  }
  if (reqOrSetupFile) {
    // We have a poetry.lock file
    if (reqOrSetupFile.endsWith("poetry.lock") || hasToolPoetry) {
      const poetryConfigArgs = [
        "-m",
        "poetry",
        "config",
        "virtualenvs.options.no-setuptools",
        "true",
        "--local",
      ];
      if (isSecureMode) {
        poetryConfigArgs.unshift("-S");
      }
      result = safeSpawnSync(PYTHON_CMD, poetryConfigArgs, {
        cwd: basePath,
        shell: isWin,
      });
      thoughtLog("Performing poetry install");
      let poetryInstallArgs = ["-m", "poetry", "install", "-n", "--no-root"];
      if (isSecureMode) {
        poetryInstallArgs.unshift("-S");
      }
      // Attempt to perform poetry install
      result = safeSpawnSync(PYTHON_CMD, poetryInstallArgs, {
        cwd: basePath,
        shell: isWin,
      });
      if (result.status !== 0 || result.error) {
        if (result.stderr?.includes("No module named poetry")) {
          thoughtLog(
            "Hmm, poetry doesn't seem to be available as a module. Perhaps it was installed directly 🤔?",
          );
          poetryInstallArgs = ["install", "-n", "--no-root"];
          // Attempt to perform poetry install
          result = safeSpawnSync("poetry", poetryInstallArgs, {
            cwd: basePath,
            shell: isWin,
            env,
          });
          if (result.status !== 0 || result.error) {
            frozen = false;
            if (DEBUG_MODE && result.stderr) {
              console.log(result.stderr);
            }
            thoughtLog(
              "poetry install has failed. Let me suggest some troubleshooting ideas.",
            );
            console.log("poetry install has failed.");
            console.log(
              "1. Install the poetry command using python -m pip install poetry.",
            );
            console.log(
              "2. Check the version of python supported by the project. Poetry is strict about the version used.",
            );
            console.log(
              "3. Setup and activate the poetry virtual environment and re-run cdxgen.",
            );
          }
        } else {
          frozen = false;
          console.log(
            "Poetry install has failed. Setup and activate the poetry virtual environment and re-run cdxgen.",
          );
          if (DEBUG_MODE) {
            if (result.error) {
              console.log(result.error);
            }
            if (result.stderr) {
              console.log(result.stderr);
            }
          }
        }
      } else {
        const poetryEnvArgs = ["env info", "--path"];
        result = safeSpawnSync("poetry", poetryEnvArgs, {
          cwd: basePath,
          shell: isWin,
          env,
        });
        tempVenvDir = result.stdout?.replaceAll(/[\r\n]+/g, "");
        if (tempVenvDir?.length) {
          env.VIRTUAL_ENV = tempVenvDir;
          env.PATH = `${join(
            tempVenvDir,
            platform() === "win32" ? "Scripts" : "bin",
          )}${_delimiter}${readEnvironmentVariable("PATH") || ""}`;
        }
      }
    } else if (reqOrSetupFile.endsWith("pdm.lock") || venvMeta.type === "pdm") {
      thoughtLog("Performing pdm install");
      result = safeSpawnSync("pdm", ["install"], {
        cwd: basePath,
        shell: isWin,
        env,
      });
      if (result.status !== 0 || result.error) {
        frozen = false;
      }
    } else if (
      reqOrSetupFile.endsWith("pixi.lock") ||
      venvMeta.type === "pixi"
    ) {
      thoughtLog("Performing pixi install");
      result = safeSpawnSync("pixi", ["install"], {
        cwd: basePath,
        shell: isWin,
        env,
      });
      if (result.status !== 0 || result.error) {
        frozen = false;
      }
    } else if (
      reqOrSetupFile.endsWith("uv.lock") ||
      (venvMeta.type === "uv" && hasToolUv)
    ) {
      thoughtLog("Performing uv sync");
      result = safeSpawnSync("uv", ["sync"], {
        cwd: basePath,
        shell: isWin,
        env,
      });
      if (result.status !== 0 || result.error) {
        frozen = false;
      }
    } else if (
      venvMeta.type === "rye" ||
      reqOrSetupFile.endsWith("requirements.lock")
    ) {
      thoughtLog("Performing rye sync");
      result = safeSpawnSync("rye", ["sync"], {
        cwd: basePath,
        shell: isWin,
        env,
      });
      if (result.status !== 0 || result.error) {
        frozen = false;
      }
    } else {
      // General package installation (Handling pip, or uv pip)
      let installCmd = python_cmd_for_tree;
      let pipInstallArgs = [];
      if (venvMeta.type === "uv") {
        installCmd = "uv";
        pipInstallArgs = ["pip", "install"];
        if (isSecureMode) {
          pipInstallArgs.push("--only-binary");
          pipInstallArgs.push(":all:");
        }
      } else {
        pipInstallArgs = [
          "-m",
          "pip",
          "install",
          "--disable-pip-version-check",
        ];
        if (isSecureMode) {
          pipInstallArgs.push("--only-binary=:all:");
          pipInstallArgs.unshift("-S");
        }
      }
      if (
        !reqOrSetupFile.endsWith("setup.py") &&
        !reqOrSetupFile.endsWith("pyproject.toml")
      ) {
        pipInstallArgs.push("-r");
        pipInstallArgs.push(resolve(reqOrSetupFile));
        if (reqOrSetupFile.includes("test")) {
          thoughtLog(
            `${reqOrSetupFile} appears to be related to tests. Should I suggest the "--exclude" argument?`,
          );
        }
      } else {
        pipInstallArgs.push(resolve(basePath));
      }
      if (process?.env?.PIP_INSTALL_ARGS) {
        const addArgs = readEnvironmentVariable("PIP_INSTALL_ARGS").split(" ");
        pipInstallArgs = pipInstallArgs.concat(addArgs);
      }
      thoughtLog(
        `**INSTALL**: Trying package install using the arguments: ${installCmd} ${pipInstallArgs.join(" ")}`,
      );
      if (DEBUG_MODE) {
        console.log("Executing", installCmd);
      }
      result = safeSpawnSync(installCmd, pipInstallArgs, {
        cwd: projectRoot || basePath,
        shell: isWin,
        env,
      });
      if (result.status !== 0 || result.error) {
        frozen = false;
        let versionRelatedError = false;
        if (
          result.stderr?.includes(
            "Could not find a version that satisfies the requirement",
          ) ||
          result.stderr?.includes("No matching distribution found for")
        ) {
          versionRelatedError = true;
          if (readEnvironmentVariable("PIP_INSTALL_ARGS")) {
            console.log(
              "1. Try invoking cdxgen with a different python type. Example: `-t python`, `-t python310`, or `-t python39`\n",
            );
          } else {
            console.log(
              "The version or the version specifiers used for a dependency is invalid. Try with a different python type such as -t python310 or -t python39.\nOriginal error from pip:\n",
            );
          }
          console.log(result.stderr);
        } else if (result?.stderr?.includes("No module named pip")) {
          console.log(
            "Using uv? Ensure 'uv' is in your PATH to allow cdxgen to use `uv pip install` automatically.",
          );
        } else if (
          readEnvironmentVariable("PIP_INSTALL_ARGS") &&
          result.stderr?.includes("Cannot set --home and --prefix together")
        ) {
          versionRelatedError = true;
          thoughtLog(`Got the error: ${result.stderr.split("\n").slice(0, 5)}`);
          if (DEBUG_MODE) {
            console.log(result.stderr);
          } else {
            console.log(
              "Possible build errors detected with 'pip install'. Set the environment variable CDXGEN_DEBUG_MODE=debug to troubleshoot.",
            );
            if (result?.stderr?.includes("No module named pip")) {
              console.log(
                "Using uv? Run uv pip install command prior to running cdxgen.",
              );
            } else {
              console.log(result.stderr.split("\n").slice(0, 5));
            }
          }
          console.warn(
            "This project does not support python with version types. Use an appropriate container image such as `ghcr.io/appthreat/cdxgen-python39:v13` or `ghcr.io/appthreat/cdxgen-python311:v13` and invoke cdxgen with `-t python` instead.\n",
          );
        } else if (
          result?.stderr?.includes(
            "pip subprocess to install build dependencies",
          )
        ) {
          console.log(
            "Installing build dependencies has failed. Use an appropriate container image such as `ghcr.io/appthreat/cdxgen-python39:v13` or `ghcr.io/appthreat/cdxgen-python311:v13` and invoke cdxgen with `-t python` instead.",
          );
          if (
            result?.stderr?.includes(
              "Failed to build installable wheels for some pyproject.toml based projects",
            )
          ) {
            console.log(
              "Try upgrading setuptools with `python -m pip install setuptools --upgrade`",
            );
          }
          if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
            thoughtLog(
              "Installation of build dependencies failed. I told you we must use container images for python.",
            );
          } else {
            thoughtLog(
              "Installation of build dependencies failed. Perhaps the user is using the wrong container image?",
            );
          }
        }
        if (!versionRelatedError) {
          if (DEBUG_MODE) {
            console.info(
              "\nEXPERIMENTAL: Invoke cdxgen with '--feature-flags safe-pip-install' to recover a partial dependency tree for projects with build errors.\n",
            );
            if (result.stderr) {
              console.log(result.stderr);
            }
            console.log(
              "Possible build errors detected. The resulting list in the SBOM would therefore be incomplete.\nTry installing any missing build tools or development libraries to improve the accuracy.",
            );
            thoughtLog(
              "Possible build errors detected. We have an incomplete list of pypi components and dependencies.",
            );
            if (platform() === "win32") {
              console.log(
                "- Install the appropriate compilers and build tools on Windows by following this documentation - https://wiki.python.org/moin/WindowsCompilers",
              );
            } else {
              console.log(
                "- For example, you may have to install gcc, gcc-c++ compiler, postgresql or mysql devel packages and additional development libraries using apt-get or yum package manager.",
              );
            }
            console.log(
              "- Certain projects would only build with specific versions of Python. Data science and ML related projects might require a conda/anaconda distribution.",
            );
            console.log(
              "- Check if any git submodules have to be initialized.\n- If the application has its own Dockerfile, look for any clues for build dependencies.",
            );
            if (
              readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true" &&
              !readEnvironmentVariable("PIP_INSTALL_ARGS")
            ) {
              console.log(
                "1. Try invoking cdxgen with a specific python version type. Example: `-t python36` or `-t python39`",
              );
              console.log(
                "2. Alternatively, try using the custom container images `ghcr.io/cdxgen/cdxgen-python39:v13` or `ghcr.io/cdxgen/cdxgen-python311:v13`, which bundles a range of build tools and development libraries.",
              );
            } else if (
              readEnvironmentVariable("PIP_INSTALL_ARGS")?.includes(
                "--python-version",
              )
            ) {
              console.log(
                "1. Try invoking cdxgen with a different python version type. Example: `-t python`, `-t python39`, or `-t python311`",
              );
              console.log(
                "2. Try with the experimental flag '--feature-flags safe-pip-install'",
              );
            }
          } else {
            if (readEnvironmentVariable("CDXGEN_IN_CONTAINER") !== "true") {
              thoughtLog(
                "**PIP**: Installation of build dependencies failed. If in doubt, use the cdxgen container images for python.",
              );
            } else {
              thoughtLog(
                "Installation of build dependencies failed. Perhaps the user is using the wrong cdxgen container image? Should I recommend raising a GitHub issue?",
              );
            }
            // Bug #1640. result.stderr is null here despite the process erroring with a non-zero value.
            // How do we reproduce this with repo tests?
            if (result?.stderr) {
              if (result?.stderr?.includes("No module named pip")) {
                console.log(
                  "Using uv? Run uv pip install command prior to running cdxgen.",
                );
              } else {
                console.log(
                  "Possible build errors detected. Set the environment variable CDXGEN_DEBUG_MODE=debug to troubleshoot.",
                );
                console.log(result.stderr?.split("\n")?.slice(0, 5));
              }
            }
          }
        }
      }
    }
  }
  // Bug #375. Attempt pip freeze on existing and new virtual environments
  if (env.VIRTUAL_ENV?.length || env.CONDA_PREFIX?.length) {
    const venvRoot = env.VIRTUAL_ENV || env.CONDA_PREFIX;
    const binDir = platform() === "win32" ? "Scripts" : "bin";
    const pipExe = join(
      venvRoot,
      binDir,
      platform() === "win32" ? "pip.exe" : "pip",
    );
    if (!safeExistsSync(pipExe)) {
      thoughtLog(
        "The 'pip' module is missing in this environment. Bootstrapping it to support piptree extraction.",
      );
      if (venvMeta.type === "uv") {
        safeSpawnSync("uv", ["pip", "install", "pip"], {
          cwd: basePath,
          shell: isWin,
          env,
        });
      } else if (venvMeta.type === "rye") {
        safeSpawnSync("rye", ["run", "pip", "install", "pip"], {
          cwd: basePath,
          shell: isWin,
          env,
        });
      } else {
        safeSpawnSync(python_cmd_for_tree, ["-m", "ensurepip", "--upgrade"], {
          cwd: basePath,
          shell: isWin,
          env,
        });
      }
    }
    if (DEBUG_MODE && reqOrSetupFile) {
      console.log(
        `About to construct the dependency tree based on ${reqOrSetupFile}. Please wait ...`,
      );
    }
    // This is a slow step that ideally needs to be invoked only once per venv
    const tree = getTreeWithPluginFn(env, python_cmd_for_tree, basePath);
    if (DEBUG_MODE && !tree.length) {
      console.log(
        "Dependency tree generation has failed. Please check for any errors or version incompatibilities reported in the logs.",
      );
    }
    const dependenciesMap = {};
    for (const t of tree) {
      const name = t.name.replace(/_/g, "-").toLowerCase();
      // Bug #1232 - the root package might lack a version resulting in duplicate tree
      // So we make use of the existing parent component to try and patch the version
      if (
        parentComponent &&
        parentComponent.name === t.name &&
        parentComponent.version &&
        parentComponent?.version !== "latest" &&
        t.version === "latest"
      ) {
        t.version = parentComponent.version;
      }
      const version = t.version;
      const scope = PYTHON_EXCLUDED_COMPONENTS.includes(name)
        ? "excluded"
        : undefined;
      if (!scope && !t.version.length) {
        // Don't leave out any local dependencies
        if (t.dependencies.length) {
          flattenDeps(dependenciesMap, pkgList, reqOrSetupFile, t);
        }
        continue;
      }
      const purlString = build({
        type: "pypi",
        namespace: "" || null,
        name: name,
        version: version || null,
      });
      const apkg = {
        name,
        version,
        purl: purlString,
        type: "library",
        "bom-ref": decodeURIComponent(purlString),
        scope,
        evidence: {
          identity: {
            field: "purl",
            confidence: 1,
            methods: [
              {
                technique: "instrumentation",
                confidence: 1,
                value: env.VIRTUAL_ENV || env.CONDA_PREFIX,
              },
            ],
          },
        },
        properties: [
          {
            name: "internal:SrcFile",
            value: reqOrSetupFile,
          },
        ],
      };
      if (scope !== "excluded") {
        pkgList.push(apkg);
        if (explicitDeps.size === 0 || explicitDeps.has(name)) {
          rootList.push({
            name,
            version,
            purl: purlString,
            "bom-ref": decodeURIComponent(purlString),
          });
        }
        flattenDeps(dependenciesMap, pkgList, reqOrSetupFile, t);
      } else {
        formulationList.push(apkg);
      }
    } // end for
    for (const k of Object.keys(dependenciesMap)) {
      dependenciesList.push({
        ref: k,
        dependsOn: [...new Set(dependenciesMap[k])].sort(),
      });
    }
  }
  return {
    pkgList,
    formulationList,
    rootList,
    dependenciesList,
    frozen,
  };
}

export function getPipTreeForPackages(
  basePath,
  pkgList,
  tempVenvDir,
  parentComponent,
  getTreeWithPluginFn,
) {
  const failedPkgList = [];
  const rootList = [];
  const dependenciesList = [];
  let result;
  const env = {
    ...process.env,
  };
  if (!env.CFLAGS) {
    env.CFLAGS = "-fcommon";
  } else if (!env.CFLAGS.includes("-fcommon")) {
    env.CFLAGS = `${env.CFLAGS} -fcommon`;
  }
  if (
    !readEnvironmentVariable("VIRTUAL_ENV") &&
    !readEnvironmentVariable("CONDA_PREFIX")
  ) {
    // Create a virtual environment
    const venvCreationArgs = ["-m", "venv", tempVenvDir];
    if (isSecureMode) {
      venvCreationArgs.unshift("-S");
    }
    result = safeSpawnSync(PYTHON_CMD, venvCreationArgs, {
      shell: isWin,
    });
    if (result.status !== 0 || result.error) {
      console.log("Virtual env creation has failed. Unable to continue.");
      return {};
    }
    env.VIRTUAL_ENV = tempVenvDir;
    env.PATH = `${join(
      tempVenvDir,
      platform() === "win32" ? "Scripts" : "bin",
    )}${_delimiter}${readEnvironmentVariable("PATH") || ""}`;
    // When cdxgen is invoked with the container image, we seem to be including unnecessary packages from the image.
    // This workaround, unsets PYTHONPATH to suppress the pre-installed packages
    if (
      env?.PYTHONPATH === "/opt/pypi" &&
      env?.CDXGEN_IN_CONTAINER === "true"
    ) {
      env.PYTHONPATH = undefined;
    }
  }
  const venvMeta = getVenvMetadata(env);
  const python_cmd_for_tree = get_python_command_from_env(env);
  let installCmd = python_cmd_for_tree;
  let pipInstallArgs = [];
  if (venvMeta.type === "uv") {
    installCmd = "uv";
    pipInstallArgs = ["pip", "install"];
    if (isSecureMode) {
      pipInstallArgs.push("--only-binary");
      pipInstallArgs.push(":all:");
    }
  } else {
    pipInstallArgs = ["-m", "pip", "install", "--disable-pip-version-check"];
    if (isSecureMode) {
      pipInstallArgs.push("--only-binary=:all:");
      pipInstallArgs.unshift("-S");
    }
  }
  // Support for passing additional arguments to pip
  // Eg: --python-version 3.10 --ignore-requires-python --no-warn-conflicts
  if (process?.env?.PIP_INSTALL_ARGS) {
    const addArgs = readEnvironmentVariable("PIP_INSTALL_ARGS").split(" ");
    pipInstallArgs = pipInstallArgs.concat(addArgs);
  } else {
    if (venvMeta.type !== "uv") {
      pipInstallArgs = pipInstallArgs.concat([
        "--ignore-requires-python",
        "--no-compile",
        "--no-warn-script-location",
        "--no-warn-conflicts",
      ]);
    } else {
      pipInstallArgs.push("--no-compile");
    }
  }
  if (DEBUG_MODE) {
    console.log(
      "Installing",
      pkgList.length,
      "packages using the command",
      installCmd,
      pipInstallArgs.join(" "),
    );
  }
  for (const apkg of pkgList) {
    let pkgSpecifier = apkg.name;
    if (apkg.version && apkg.version !== "latest") {
      pkgSpecifier = `${apkg.name}==${apkg.version}`;
    } else if (apkg.properties) {
      let versionSpecifierFound = false;
      for (const aprop of apkg.properties) {
        if (aprop.name === "cdx:pypi:versionSpecifiers") {
          pkgSpecifier = `${apkg.name}${aprop.value}`;
          versionSpecifierFound = true;
          break;
        }
      }
      if (!versionSpecifierFound) {
        failedPkgList.push(apkg);
        continue;
      }
    } else {
      failedPkgList.push(apkg);
      continue;
    }
    if (DEBUG_MODE) {
      console.log("Installing", pkgSpecifier);
    }
    const result = safeSpawnSync(
      installCmd,
      [...pipInstallArgs, pkgSpecifier],
      {
        cwd: basePath,
        shell: isWin,
        env,
      },
    );
    if (result.status !== 0 || result.error) {
      failedPkgList.push(apkg);
      if (DEBUG_MODE) {
        console.log(apkg.name, "failed to install.");
      }
    }
  }
  // Did any package get installed successfully?
  if (failedPkgList.length < pkgList.length) {
    const venvRoot = env.VIRTUAL_ENV || env.CONDA_PREFIX;
    if (venvRoot) {
      const binDir = platform() === "win32" ? "Scripts" : "bin";
      const pipExe = join(
        venvRoot,
        binDir,
        platform() === "win32" ? "pip.exe" : "pip",
      );
      if (!safeExistsSync(pipExe)) {
        if (venvMeta.type === "uv") {
          safeSpawnSync("uv", ["pip", "install", "pip"], {
            cwd: basePath,
            shell: isWin,
            env,
          });
        } else {
          safeSpawnSync(python_cmd_for_tree, ["-m", "ensurepip", "--upgrade"], {
            cwd: basePath,
            shell: isWin,
            env,
          });
        }
      }
    }
    const dependenciesMap = {};
    const tree = getTreeWithPluginFn(env, python_cmd_for_tree, basePath);
    for (const t of tree) {
      const name = t.name.replace(/_/g, "-").toLowerCase();
      // We can ignore excluded components such as build tools
      if (PYTHON_EXCLUDED_COMPONENTS.includes(name)) {
        continue;
      }
      if (parentComponent && parentComponent.name === t.name) {
        t.version = parentComponent.version;
      } else if (t.version && t.version === "latest") {
        continue;
      }
      const version = t.version;
      const purlString = build({
        type: "pypi",
        namespace: "" || null,
        name: name,
        version: version || null,
      });
      const apkg = {
        name,
        version,
        purl: purlString,
        type: "library",
        "bom-ref": decodeURIComponent(purlString),
        evidence: {
          identity: {
            field: "purl",
            confidence: 0.5,
            methods: [
              {
                technique: "instrumentation",
                confidence: 0.5,
                value: env.VIRTUAL_ENV,
              },
            ],
          },
        },
      };
      // These packages have lower confidence
      pkgList.push(apkg);
      rootList.push({
        name,
        version,
        purl: purlString,
        "bom-ref": decodeURIComponent(purlString),
      });
      flattenDeps(dependenciesMap, pkgList, undefined, t);
    } // end for
    for (const k of Object.keys(dependenciesMap)) {
      dependenciesList.push({
        ref: k,
        dependsOn: [...new Set(dependenciesMap[k])].sort(),
      });
    }
  } // end if
  return {
    failedPkgList,
    rootList,
    dependenciesList,
  };
}
