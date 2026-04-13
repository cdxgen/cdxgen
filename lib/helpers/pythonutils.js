import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { thoughtLog } from "./logger.js";
import { DEBUG_MODE, PYTHON_CMD, safeExistsSync } from "./utils.js";

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
