import { assert, it } from "poku";

import { parseMavenArgs } from "../ecosystems/utils.js";
import { extractPathEnv, getPythonCommand } from "./env.js";

it("extractPathEnv expands only the variables each PATH entry references", () => {
  assert.deepStrictEqual(
    extractPathEnv([
      "HOME=/root",
      "APP=/opt/app",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable syntax.
      "PATH=/usr/bin:$HOME/bin:${APP}/bin:$HOMEDIR/bin:$UNSET/bin:",
    ]),
    ["/usr/bin", "/root/bin", "/opt/app/bin"],
  );
  // Replacement patterns in a value are inserted as they are, so the entries
  // keep a `$` and are dropped like any unresolved entry.
  assert.deepStrictEqual(
    extractPathEnv(["V=$`$`$`", "W=$&$'", "PATH=/a$V:/b$W/c:/usr/bin"]),
    ["/usr/bin"],
  );
  const manyVariables = Array.from({ length: 20000 }, (_, i) => `A${i}=x`);
  const manyEntries = Array.from({ length: 20000 }, (_, i) => `/p${i}$Z`);
  const started = Date.now();
  assert.deepStrictEqual(
    extractPathEnv([...manyVariables, `PATH=${manyEntries.join(":")}:/bin`]),
    ["/bin"],
  );
  assert.ok(Date.now() - started < 5000);
});

it("extractPathEnv bounds the length and number of the paths it returns", () => {
  const longValue = `/${"x".repeat(5000)}`;
  assert.deepStrictEqual(
    extractPathEnv([
      `LONG=${longValue}`,
      `PATH=$LONG/bin:/${"y".repeat(5000)}:/usr/bin`,
    ]),
    ["/usr/bin"],
  );
  const entries = Array.from({ length: 5000 }, (_, i) => `$A/${i}`);
  const paths = extractPathEnv([
    `A=/${"a".repeat(4000)}`,
    `PATH=${entries.join(":")}`,
  ]);
  assert.strictEqual(paths.length, 1024);
  assert.ok(paths.every((p) => p.length <= 4096));
});

it("parse maven args", () => {
  assert.deepStrictEqual(
    parseMavenArgs(
      '--settings "/tmp/path with spaces/settings.xml" -P dev,test -DskipTests',
    ),
    [
      "--settings",
      "/tmp/path with spaces/settings.xml",
      "-P",
      "dev,test",
      "-DskipTests",
    ],
  );
  assert.deepStrictEqual(
    parseMavenArgs(String.raw`-s C:\Users\me\settings.xml -Dpath=C:\repo\demo`),
    [
      "-s",
      String.raw`C:\Users\me\settings.xml`,
      String.raw`-Dpath=C:\repo\demo`,
    ],
  );
  assert.deepStrictEqual(parseMavenArgs(String.raw`-Dname=hello\ world`), [
    "-Dname=hello world",
  ]);
});

// Restored from the retired lib/helpers/core-misc-b.poku.js, which was
// deleted along with its module during the v13 layer reorganisation even though
// the functions under test only moved.

import {
  hasAnyProjectType,
  isPackageManagerAllowed,
  isVersionedJvmToolProjectType,
  PROJECT_TYPE_ALIASES,
  shouldRunPredictiveBomAudit,
} from "./env.js";

it("hasAnyProjectType tests", () => {
  for (const language of ["vb", "vbnet", "visualbasic", "f#", "fs", "fsharp"]) {
    assert.ok(PROJECT_TYPE_ALIASES.csharp.includes(language));
  }

  assert.deepStrictEqual(
    hasAnyProjectType(["docker"], {
      projectType: [],
      excludeType: ["oci"],
    }),
    false,
  );
  assert.deepStrictEqual(hasAnyProjectType([], {}), true);
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], { projectType: ["java"] }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], { projectType: ["java"], excludeType: [] }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], { projectType: ["csharp"] }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], { projectType: ["csharp", "rust"] }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["rust"], { projectType: ["csharp", "rust"] }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["rust"], {
      projectType: ["csharp", "rust"],
      excludeType: [],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["rust"], {
      projectType: ["csharp", "rust"],
      excludeType: ["rust"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci"], {
      projectType: ["java", "docker"],
      excludeType: ["dotnet"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci"], {
      projectType: ["docker"],
      excludeType: undefined,
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["docker"], {
      projectType: ["oci"],
      excludeType: undefined,
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci"], {
      projectType: ["rootfs"],
      excludeType: undefined,
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["docker"], {
      projectType: ["rootfs"],
      excludeType: undefined,
    }),
    true,
  );

  assert.deepStrictEqual(
    hasAnyProjectType(["js"], {
      projectType: [],
      excludeType: ["rust"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js"], {
      projectType: undefined,
      excludeType: ["csharp"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js", "docker"], {
      projectType: ["universal"],
      excludeType: ["csharp"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["rust"], {
      projectType: ["universal"],
      excludeType: ["docker"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js", "docker"], {
      projectType: ["universal"],
      excludeType: ["csharp", "javascript"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js", "docker"], {
      projectType: ["js", "docker"],
      excludeType: ["js", "docker"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js"], {
      projectType: ["js"],
      excludeType: ["js"],
    }),
    false,
  );

  // Versioned JVM build tool types dispatch java parsing exactly like the
  // bare maven/gradle/sbt/scala aliases do.
  for (const projectType of [
    "maven3.9.9",
    "mvn3.9.9",
    "gradle8.14",
    "sbt1.10",
    "scala3.6.4",
  ]) {
    assert.deepStrictEqual(
      hasAnyProjectType(["java"], { projectType: [projectType] }),
      true,
      `${projectType} should behave as a java type`,
    );
    assert.deepStrictEqual(
      hasAnyProjectType(["oci", "java"], { projectType: [projectType] }),
      true,
      `${projectType} should dispatch the java/oci pipeline`,
    );
  }
  // Mixed invocations include the java base type exactly once.
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], { projectType: ["maven3.9.9", "js"] }),
    true,
  );
  // Unrelated queries are unaffected by versioned JVM tool types.
  assert.deepStrictEqual(
    hasAnyProjectType(["js"], { projectType: ["maven3.9.9"] }),
    false,
  );
  // Bare tool aliases keep their existing behaviour without version suffixes.
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], { projectType: ["maven"] }),
    true,
  );
  // Exclusions still win over the versioned tool types.
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], {
      projectType: ["maven3.9.9"],
      excludeType: ["java"],
    }),
    false,
  );
  assert.deepStrictEqual(isVersionedJvmToolProjectType("maven3.9.9"), true);
  assert.deepStrictEqual(isVersionedJvmToolProjectType("maven"), false);
  assert.deepStrictEqual(isVersionedJvmToolProjectType("java17"), false);
  assert.deepStrictEqual(isVersionedJvmToolProjectType(""), false);
  assert.deepStrictEqual(isVersionedJvmToolProjectType(undefined), false);
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["oci"],
      {
        projectType: [],
        excludeType: [],
      },
      false,
    ),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["oci", "docker"],
      {
        projectType: undefined,
        excludeType: undefined,
      },
      false,
    ),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js", "docker"], {
      projectType: ["universal"],
      excludeType: [],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js"], {
      projectType: ["universal"],
      excludeType: ["js"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["universal"], {
      projectType: undefined,
      excludeType: ["github"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci"], {
      projectType: undefined,
      excludeType: ["github"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["os"], {
      projectType: undefined,
      excludeType: ["jar"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["docker"], {
      projectType: undefined,
      excludeType: ["jar"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci", "java"], {
      projectType: undefined,
      excludeType: ["jar"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci", "ear"], {
      projectType: undefined,
      excludeType: ["jar"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["docker", "oci", "container", "os"],
      {
        projectType: undefined,
        excludeType: ["github"],
      },
      false,
    ),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["ruby"],
      {
        projectType: ["ruby2.5.4"],
        excludeType: undefined,
      },
      false,
    ),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["ruby"],
      {
        projectType: ["rb"],
        excludeType: undefined,
      },
      false,
    ),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["ruby"],
      {
        projectType: ["ruby3.4.1", "ruby2.5.4"],
        excludeType: undefined,
      },
      false,
    ),
    true,
  );
  // Asking about ruby must not make every scan a ruby scan: a swift project
  // that ships a Gemfile for its docs tooling ran bundle install under --deep.
  for (const projectType of [["swift"], ["js"], ["java", "python"]]) {
    assert.deepStrictEqual(
      hasAnyProjectType(["ruby"], { projectType }, false),
      false,
      `${projectType} is not a ruby scan`,
    );
    assert.deepStrictEqual(
      hasAnyProjectType(["oci", "ruby"], { projectType }),
      false,
      `${projectType} does not run the ruby collector`,
    );
  }
  assert.deepStrictEqual(
    hasAnyProjectType(["oci", "ruby"], { projectType: ["docker"] }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["ruby"], { projectType: ["docker"] }, false),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci", "js"], {
      projectType: ["javascript"],
      excludeType: undefined,
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["asar"], {
      projectType: [],
      excludeType: ["asar"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["asar"], {
      projectType: undefined,
      excludeType: ["electron"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["electron"], {
      projectType: [],
      excludeType: ["asar"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["asar"], {
      projectType: [],
      excludeType: ["java"],
    }),
    true,
  );
});

it("shouldRunPredictiveBomAudit tests", () => {
  for (const commandPath of [
    "/home/u/work/cdx-hbom-wt/11/bin/cdxgen.js",
    "/Users/jobom/x/bin/cdxgen.js",
    "C:\\Users\\hbom\\cdxgen\\bin\\cdxgen.js",
  ]) {
    assert.strictEqual(shouldRunPredictiveBomAudit({}, commandPath), true);
  }
  for (const commandPath of [
    "/x/bin/obom.js",
    "/x/bin/hbom.js",
    "C:\\tools\\hbom.exe",
    "hbom-slim",
    "obom",
  ]) {
    assert.strictEqual(shouldRunPredictiveBomAudit({}, commandPath), false);
  }
  assert.strictEqual(shouldRunPredictiveBomAudit({}, "cdxgen"), true);
  assert.strictEqual(
    shouldRunPredictiveBomAudit({ projectType: ["os"] }, "cdxgen"),
    false,
  );
  assert.strictEqual(
    shouldRunPredictiveBomAudit({ projectType: ["linux"] }, "cdxgen"),
    false,
  );
  assert.strictEqual(
    shouldRunPredictiveBomAudit({ projectType: ["os", "darwin"] }, "cdxgen"),
    false,
  );
  assert.strictEqual(
    shouldRunPredictiveBomAudit({ projectType: ["os", "js"] }, "cdxgen"),
    true,
  );
  assert.strictEqual(
    shouldRunPredictiveBomAudit({ projectType: "os,linux" }, "cdxgen"),
    false,
  );
  assert.strictEqual(
    shouldRunPredictiveBomAudit({ projectType: ["hbom"] }, "cdxgen"),
    false,
  );
  assert.strictEqual(
    shouldRunPredictiveBomAudit({ projectType: ["hardware"] }, "cdxgen"),
    false,
  );
  assert.strictEqual(
    shouldRunPredictiveBomAudit({ projectType: ["js"] }, "obom"),
    false,
  );
  assert.strictEqual(
    shouldRunPredictiveBomAudit({ projectType: ["js"] }, "hbom"),
    false,
  );
});

it("isPackageManagerAllowed tests", () => {
  assert.deepStrictEqual(
    isPackageManagerAllowed("uv", ["pip", "poetry", "hatch", "pdm"], {
      projectType: undefined,
    }),
    true,
  );
  assert.deepStrictEqual(
    isPackageManagerAllowed("uv", ["pip", "poetry", "hatch", "pdm"], {
      projectType: ["python"],
    }),
    true,
  );
  assert.deepStrictEqual(
    isPackageManagerAllowed("uv", ["pip", "poetry", "hatch", "pdm"], {
      projectType: ["pip"],
    }),
    false,
  );
});

it("getPythonCommand prefers the explicit overrides, then what PATH offers", () => {
  const original = {
    PYTHON_CMD: process.env.PYTHON_CMD,
    CONDA_PYTHON_EXE: process.env.CONDA_PYTHON_EXE,
    PATH: process.env.PATH,
  };
  try {
    process.env.PYTHON_CMD = "/opt/custom/python";
    assert.strictEqual(getPythonCommand(), "/opt/custom/python");

    delete process.env.PYTHON_CMD;
    process.env.CONDA_PYTHON_EXE = "/opt/conda/bin/python";
    assert.strictEqual(getPythonCommand(), "/opt/conda/bin/python");

    delete process.env.CONDA_PYTHON_EXE;
    // An empty search path offers neither name, so the default stands and the
    // caller gets the same command this tool has always spawned.
    process.env.PATH = "";
    assert.strictEqual(getPythonCommand(), "python");
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

it("recent language version aliases are registered", () => {
  for (const alias of [
    "nodejs24",
    "nodejs25",
    "nodejs26",
    "node24",
    "node25",
    "node26",
  ]) {
    assert.ok(
      PROJECT_TYPE_ALIASES.js.includes(alias),
      `missing JS alias ${alias}`,
    );
  }
  for (const alias of ["python314", "python315"]) {
    assert.ok(
      PROJECT_TYPE_ALIASES.py.includes(alias),
      `missing Python alias ${alias}`,
    );
  }
  assert.ok(PROJECT_TYPE_ALIASES.java.includes("java27"));
  assert.ok(PROJECT_TYPE_ALIASES.csharp.includes("dotnet10"));
  assert.ok(PROJECT_TYPE_ALIASES.csharp.includes("dotnet11"));
});

it("new ecosystem aliases are registered", () => {
  const expected = {
    julia: "julia",
    r: "r",
    erlang: "rebar3",
    ocaml: "opam",
    crystal: "shards",
    nim: "nimble",
    lua: "luarocks",
    perl: "carton",
    spack: "spack",
    terraform: "opentofu",
  };
  for (const [type, alias] of Object.entries(expected)) {
    assert.ok(
      PROJECT_TYPE_ALIASES[type].includes(alias),
      `missing alias ${alias} for ${type}`,
    );
  }
  assert.ok(PROJECT_TYPE_ALIASES.haskell.includes("stack"));
});
