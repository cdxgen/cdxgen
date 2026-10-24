import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { markerExcludesCPython } from "./parsers-python.js";
import {
  derivePythonLockMetadataFileName,
  parseMojoProject,
  parsePiplockData,
  parsePixiLockFile,
  parsePixiTomlFile,
  parsePyLockData,
  parsePyProjectTomlFile,
  parsePyRequiresDist,
  parseReqEnvMarkers,
  parseReqFile,
  parseSetupPyFile,
} from "./utils.js";

it("Parse requires dist string", () => {
  assert.deepStrictEqual(
    parsePyRequiresDist("lazy-object-proxy (&gt;=1.4.0)"),
    {
      name: "lazy-object-proxy",
      version: "1.4.0",
    },
  );
  assert.deepStrictEqual(parsePyRequiresDist("wrapt (&lt;1.13,&gt;=1.11)"), {
    name: "wrapt",
    version: "1.13",
  });
  assert.deepStrictEqual(
    parsePyRequiresDist(
      'typed-ast (&lt;1.5,&gt;=1.4.0) ; implementation_name == "cpython" and python_version &lt; "3.8"',
    ),
    { name: "typed-ast", version: "1.5" },
  );
  assert.deepStrictEqual(parsePyRequiresDist("asgiref (&lt;4,&gt;=3.2.10)"), {
    name: "asgiref",
    version: "4",
  });
  assert.deepStrictEqual(parsePyRequiresDist("pytz"), {
    name: "pytz",
    version: "",
  });
  assert.deepStrictEqual(parsePyRequiresDist("sqlparse (&gt;=0.2.2)"), {
    name: "sqlparse",
    version: "0.2.2",
  });
  assert.deepStrictEqual(
    parsePyRequiresDist("argon2-cffi (&gt;=16.1.0) ; extra == 'argon2'"),
    { name: "argon2-cffi", version: "16.1.0" },
  );
  assert.deepStrictEqual(parsePyRequiresDist("bcrypt ; extra == 'bcrypt'"), {
    name: "bcrypt",
    version: "",
  });
});

it("parseSetupPyFile", async () => {
  let deps = await parseSetupPyFile(`install_requires=[
    'colorama>=0.4.3',
    'libsast>=1.0.3',
],`);
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].name, "colorama");

  deps = await parseSetupPyFile(
    `install_requires=['colorama>=0.4.3','libsast>=1.0.3',],`,
  );
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].name, "colorama");

  deps = await parseSetupPyFile(
    `install_requires=['colorama>=0.4.3','libsast>=1.0.3']`,
  );
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].name, "colorama");

  deps = await parseSetupPyFile(
    `install_requires=['colorama>=0.4.3', 'libsast>=1.0.3']`,
  );
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].name, "colorama");

  deps = await parseSetupPyFile(`install_requires=[
'colorama>=0.4.3',
'libsast>=1.0.3',
]`);
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].name, "colorama");

  deps = await parseSetupPyFile(
    readFileSync("./test/data/setup-impacket.py", "utf-8"),
  );
  assert.deepStrictEqual(deps.length, 7);
  assert.ok(deps);
});

describe("parseReqEnvMarkers", () => {
  it("should handle empty or null input", () => {
    assert.deepStrictEqual(parseReqEnvMarkers(null), []);
    assert.deepStrictEqual(parseReqEnvMarkers(undefined), []);
    assert.deepStrictEqual(parseReqEnvMarkers(""), []);
  });

  it("should parse simple marker with string comparison", () => {
    const result = parseReqEnvMarkers('platform_system == "Linux"');
    assert.deepStrictEqual(result, [
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it("should parse simple marker with numeric comparison", () => {
    const result = parseReqEnvMarkers('python_version >= "3.6"');
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
    ]);
  });

  it("should parse marker without quotes", () => {
    const result = parseReqEnvMarkers("platform_system == Linux");
    assert.deepStrictEqual(result, [
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it('should parse "and" combination', () => {
    const result = parseReqEnvMarkers(
      'python_version >= "3.6" and platform_system == "Linux"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
      {
        operator: "and",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it('should parse "or" combination', () => {
    const result = parseReqEnvMarkers(
      'python_version < "3.6" or platform_system == "Windows"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: "<",
        value: "3.6",
      },
      {
        operator: "or",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Windows",
      },
    ]);
  });

  it('should parse complex combinations with both "and" and "or"', () => {
    const result = parseReqEnvMarkers(
      'python_version >= "3.6" and platform_system == "Linux" or platform_machine == "x86_64"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
      {
        operator: "and",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
      {
        operator: "or",
      },
      {
        variable: "platform_machine",
        operator: "==",
        value: "x86_64",
      },
    ]);
  });

  it("should handle negation operators", () => {
    const result = parseReqEnvMarkers('platform_system != "Windows"');
    assert.deepStrictEqual(result, [
      {
        variable: "platform_system",
        operator: "!=",
        value: "Windows",
      },
    ]);
  });

  it("should handle less than and greater than operators", () => {
    const result = parseReqEnvMarkers(
      'python_version < "3.10" and implementation_version > "2.0"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: "<",
        value: "3.10",
      },
      {
        operator: "and",
      },
      {
        variable: "implementation_version",
        operator: ">",
        value: "2.0",
      },
    ]);
  });

  it("should handle complex real-world example", () => {
    const result = parseReqEnvMarkers(
      'platform_system!="Darwin" or platform_machine!="arm64"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "platform_system",
        operator: "!=",
        value: "Darwin",
      },
      {
        operator: "or",
      },
      {
        variable: "platform_machine",
        operator: "!=",
        value: "arm64",
      },
    ]);
  });

  it("should handle multiple spaces and normalize them", () => {
    const result = parseReqEnvMarkers(
      'python_version   >=   "3.6"    and    platform_system   ==   "Linux"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
      {
        operator: "and",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it("should handle markers with no spaces around operators", () => {
    const result = parseReqEnvMarkers(
      'python_version>="3.6" and platform_system=="Linux"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
      {
        operator: "and",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it("should handle complex marker with implementation_name", () => {
    const result = parseReqEnvMarkers('implementation_name == "pypy"');
    assert.deepStrictEqual(result, [
      {
        variable: "implementation_name",
        operator: "==",
        value: "pypy",
      },
    ]);
  });

  it("should handle sys_platform marker", () => {
    const result = parseReqEnvMarkers('sys_platform == "darwin"');
    assert.deepStrictEqual(result, [
      {
        variable: "sys_platform",
        operator: "==",
        value: "darwin",
      },
    ]);
  });

  it("should handle unrecognized patterns as raw tokens", () => {
    const result = parseReqEnvMarkers(
      'unknown_function() or platform_system == "Linux"',
    );
    assert.deepStrictEqual(result, [
      {
        raw: "unknown_function()",
      },
      {
        operator: "or",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it("should handle single complex condition", () => {
    const result = parseReqEnvMarkers('python_full_version >= "3.6.0"');
    assert.deepStrictEqual(result, [
      {
        variable: "python_full_version",
        operator: ">=",
        value: "3.6.0",
      },
    ]);
  });

  it("should preserve case sensitivity in values", () => {
    const result = parseReqEnvMarkers(
      'platform_system == "Windows" or platform_system == "windows"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "platform_system",
        operator: "==",
        value: "Windows",
      },
      {
        operator: "or",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "windows",
      },
    ]);
  });

  it("should handle markers with numbers and dots", () => {
    const result = parseReqEnvMarkers('python_version == "3.9.5"');
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: "==",
        value: "3.9.5",
      },
    ]);
  });

  it("should handle extra whitespace trimming", () => {
    const result = parseReqEnvMarkers('  python_version >= "3.6"  ');
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
    ]);
  });
});

it("parse requirements.txt", async () => {
  let deps = await parseReqFile("./test/data/requirements.comments.txt", false);
  assert.deepStrictEqual(deps.length, 31);
  deps = await parseReqFile("./test/data/requirements.freeze.txt", false);
  assert.deepStrictEqual(deps.length, 113);
  assert.deepStrictEqual(deps[0], {
    name: "elasticsearch",
    version: "8.6.2",
    scope: "required",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/requirements.freeze.txt",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/requirements.freeze.txt",
          },
        ],
      },
    },
  });
  deps = await parseReqFile("./test/data/chen-science-requirements.txt", false);
  assert.deepStrictEqual(deps.length, 87);
  assert.deepStrictEqual(deps[0], {
    name: "aiofiles",
    version: "23.2.1",
    scope: undefined,
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/chen-science-requirements.txt",
          },
        ],
      },
    },
    hashes: [
      {
        alg: "SHA-256",
        content:
          "19297512c647d4b27a2cf7c34caa7e405c0d60b5560618a29a9fe027b18b0107",
      },
      {
        alg: "SHA-256",
        content:
          "84ec2218d8419404abcb9f0c02df3f34c6e0a68ed41072acfb1cef5cbc29051a",
      },
    ],
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/chen-science-requirements.txt",
      },
      {
        name: "cdx:pip:markers",
        value: 'python_full_version >= "3.8.1" and python_version < "3.12"',
      },
      {
        name: "cdx:pip:structuredMarkers",
        value:
          '[{"variable":"python_full_version","operator":">=","value":"3.8.1"},{"operator":"and"},{"variable":"python_version","operator":"<","value":"3.12"}]',
      },
    ],
  });
  deps = await parseReqFile(
    "./test/data/requirements-lock.linux_py3.txt",
    false,
  );
  assert.deepStrictEqual(deps.length, 375);
  assert.deepStrictEqual(deps[0], {
    name: "adal",
    scope: undefined,
    version: "1.2.2",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/requirements-lock.linux_py3.txt",
      },
    ],
    hashes: [
      {
        alg: "SHA-256",
        content:
          "fd17e5661f60634ddf96a569b95d34ccb8a98de60593d729c28bdcfe360eaad1",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/requirements-lock.linux_py3.txt",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(deps[1], {
    name: "aenum",
    version: "3.1.0",
    scope: undefined,
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/requirements-lock.linux_py3.txt",
          },
        ],
      },
    },
    hashes: [
      {
        alg: "SHA-256",
        content:
          "1f92fb906e3d745064e85f9a1937006ee341e00a35ecd8b7f899041b8e1d67d7",
      },
      {
        alg: "SHA-256",
        content:
          "f8401f1a258436719ed013444ab37ff22a72517e0e3097058dd1511cf284447c",
      },
    ],
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/requirements-lock.linux_py3.txt",
      },
    ],
  });
  assert.deepStrictEqual(deps[deps.length - 1], {
    name: "zipp",
    scope: undefined,
    version: "0.6.0",
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/requirements-lock.linux_py3.txt",
      },
    ],
    hashes: [
      {
        alg: "SHA-256",
        content:
          "f06903e9f1f43b12d371004b4ac7b06ab39a44adc747266928ae6debfa7b3335",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/requirements-lock.linux_py3.txt",
          },
        ],
      },
    },
  });
  deps = await parseReqFile("./test/data/extra-ml-requirements.txt", false);
  assert.deepStrictEqual(deps.length, 47);
  for (const d of deps) {
    if (d.version) {
      assert.ok(!d.version.includes(";"));
    }
  }
  deps = await parseReqFile(
    "./test/data/req_files/requirements-with-license.txt",
    false,
  );
  assert.deepStrictEqual(deps.length, 19);
  for (const d of deps) {
    assert.ok(d.licenses);
    assert.ok(d.licenses.length);
  }
});

it("parse requirements.txt enriches distribution references when package metadata fetch is enabled", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-req-pypi-"));
  const reqFile = path.join(tempDir, "requirements.txt");
  const agentGetStub = sinon.stub().resolves({
    body: {
      info: {
        author: "",
        author_email: "",
        classifiers: [],
        license: "",
        license_expression: "",
        name: "requests",
        summary: "HTTP client",
        version: "2.31.0",
      },
      releases: {
        "2.31.0": [
          {
            digests: { sha256: "abc123" },
            filename: "requests-2.31.0-py3-none-any.whl",
            packagetype: "bdist_wheel",
            url: "https://files.pythonhosted.org/packages/example/requests-2.31.0-py3-none-any.whl",
          },
        ],
      },
    },
  });
  writeFileSync(reqFile, "requests==2.31.0\n", "utf-8");
  const { parseReqFile: mockedParseReqFile } = await esmock(
    "./utils.js",
    {},
    {
      "../core/httpClient.js": {
        createHttpClient: sinon.stub().returns({ get: agentGetStub }),
      },
    },
  );
  try {
    const deps = await mockedParseReqFile(reqFile, true);
    assert.strictEqual(deps.length, 1);
    assert.ok(
      deps[0].externalReferences?.some(
        (reference) =>
          reference.type === "distribution" && reference.url.endsWith(".whl"),
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("parse requirements.txt captures direct manifest sources", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-req-source-"));
  const reqFile = path.join(tempDir, "requirements.txt");
  writeFileSync(
    reqFile,
    [
      "requests @ https://example.com/packages/requests-2.31.0.whl  # MIT",
      "-e git+https://github.com/acme/private-lib.git#egg=private-lib",
      "",
    ].join("\n"),
    "utf-8",
  );
  try {
    const deps = await parseReqFile(reqFile, false);
    const requestsPkg = deps.find((pkg) => pkg.name === "requests");
    assert.ok(requestsPkg);
    assert.ok(
      requestsPkg.properties.some(
        (property) =>
          property.name === "cdx:pypi:manifestSourceType" &&
          property.value === "url",
      ),
    );
    assert.ok(
      requestsPkg.properties.some(
        (property) =>
          property.name === "cdx:pypi:manifestSource" &&
          property.value === "https://example.com/packages/requests-2.31.0.whl",
      ),
    );
    assert.deepStrictEqual(requestsPkg.licenses, [
      {
        license: {
          id: "MIT",
        },
      },
    ]);
    const privateLibPkg = deps.find((pkg) => pkg.name === "private-lib");
    assert.ok(privateLibPkg);
    assert.ok(
      privateLibPkg.properties.some(
        (property) =>
          property.name === "cdx:pypi:manifestSourceType" &&
          property.value === "git",
      ),
    );
    assert.ok(
      privateLibPkg.properties.some(
        (property) =>
          property.name === "cdx:pypi:editable" && property.value === "true",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("parses a pyproject.toml with PEP 735 mixed-type dependency-groups (TOML 1.0)", () => {
  // @iarna/toml enforced TOML 0.5's "inline lists must be a single type" rule, which TOML
  // 1.0 removed; PEP 735 dependency-groups mix an inline table with strings, so real
  // projects (pydantic's vendored pydantic-core) carry a pyproject.toml that parser
  // rejected. smol-toml is TOML 1.0 - the file must parse and the groups must come back.
  const tmpDir = mkdtempSync(path.join(tmpdir(), "toml10-pyproject-"));
  try {
    const mixed = path.join(tmpDir, "pyproject.toml");
    writeFileSync(
      mixed,
      `[project]
name = 'mixed-groups'
version = '1.0.0'

[dependency-groups]
testing = [
    { include-group = "dev" },
    'coverage',
]
`,
    );
    const retMap = parsePyProjectTomlFile(mixed);
    assert.ok(retMap.parentComponent, "the project component must exist");
    assert.strictEqual(retMap.parentComponent.name, "mixed-groups");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

it("parse pyproject.toml", () => {
  let retMap = parsePyProjectTomlFile("./test/data/pyproject.toml");
  assert.deepStrictEqual(retMap.parentComponent, {
    author: "Team AppThreat <cloud@appthreat.com>",
    "bom-ref": "pkg:pypi/cpggen@1.9.0",
    description:
      "Generate CPG for multiple languages for code and threat analysis",
    evidence: {
      identity: {
        confidence: 1,
        field: "purl",
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/pyproject.toml",
          },
        ],
      },
    },
    homepage: {
      url: "https://github.com/AppThreat/cpggen",
    },
    license: "Apache-2.0",
    name: "cpggen",
    purl: "pkg:pypi/cpggen@1.9.0",
    repository: {
      url: "https://github.com/AppThreat/cpggen",
    },
    tags: [
      "atom",
      "code analysis",
      "code property graph",
      "cpg",
      "joern",
      "static analysis",
      "threat analysis",
    ],
    type: "application",
    version: "1.9.0",
  });
  assert.ok(retMap.poetryMode);
  retMap = parsePyProjectTomlFile("./test/data/pyproject-author-comma.toml");
  assert.deepStrictEqual(retMap.parentComponent, {
    author: "Rasa Technologies GmbH <hi@rasa.com>",
    "bom-ref": "pkg:pypi/rasa@3.7.0a1",
    purl: "pkg:pypi/rasa@3.7.0a1",
    evidence: {
      identity: {
        confidence: 1,
        field: "purl",
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/pyproject-author-comma.toml",
          },
        ],
      },
    },
    description:
      "Open source machine learning framework to automate text- and voice-based conversations: NLU, dialogue management, connect to Slack, Facebook, and more - Create chatbots and voice assistants",
    homepage: {
      url: "https://rasa.com",
    },
    license: "Apache-2.0",
    name: "rasa",
    repository: {
      url: "https://github.com/rasahq/rasa",
    },
    tags: [
      "bot",
      "bot-framework",
      "botkit",
      "bots",
      "chatbot",
      "chatbot-framework",
      "conversational-ai",
      "machine-learning",
      "machine-learning-library",
      "nlp",
      "rasa conversational-agents",
    ],
    type: "application",
    version: "3.7.0a1",
  });
  assert.deepStrictEqual(Object.keys(retMap.directDepsKeys).length, 86);
  assert.deepStrictEqual(Object.keys(retMap.groupDepsKeys).length, 36);
  retMap = parsePyProjectTomlFile("./test/data/pyproject_uv.toml");
  assert.deepStrictEqual(retMap.parentComponent, {
    authors: [
      {
        email: "redowan.nafi@gmail.com",
        name: "Redowan Delowar",
      },
    ],
    "bom-ref": "pkg:pypi/fastapi-nano@0.1.0",
    purl: "pkg:pypi/fastapi-nano@0.1.0",
    description: "A minimal FastAPI project template.",
    evidence: {
      identity: {
        confidence: 1,
        field: "purl",
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/pyproject_uv.toml",
          },
        ],
      },
    },
    name: "fastapi-nano",
    tags: ["cookiecutter", "docker", "fastapi", "minimal", "template"],
    version: "0.1.0",
    type: "application",
    properties: [
      {
        name: "cdx:pypi:requiresPython",
        value: ">=3.11",
      },
    ],
  });
  retMap = parsePyProjectTomlFile("./test/data/pyproject_uv2.toml");
  assert.deepStrictEqual(retMap.parentComponent, {
    name: "una-root",
    evidence: {
      identity: {
        confidence: 1,
        field: "purl",
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/pyproject_uv2.toml",
          },
        ],
      },
    },
    "bom-ref": "pkg:pypi/una-root@0",
    purl: "pkg:pypi/una-root@0",
    properties: [
      {
        name: "cdx:pypi:requiresPython",
        value: ">=3.11",
      },
    ],
    version: "0",
    type: "application",
  });
  assert.ok(retMap.uvMode);
  assert.deepStrictEqual(retMap.directDepsKeys, {
    "hatch-una": true,
    una: true,
  });
});

it("parse pixi.toml with workspace metadata", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pixi-workspace-"));
  const pixiTomlFile = path.join(tempDir, "pixi.toml");
  writeFileSync(
    pixiTomlFile,
    `
[workspace]
name = "pixi-workspace-app"
version = "0.1.0"
description = "Workspace metadata test"
homepage = "https://pixi.sh"
repository = "https://github.com/prefix-dev/pixi"
    `.trim(),
    "utf-8",
  );
  try {
    assert.deepStrictEqual(parsePixiTomlFile(pixiTomlFile), {
      description: "Workspace metadata test",
      name: "pixi-workspace-app",
      version: "0.1.0",
      externalReferences: [
        { type: "website", url: "https://pixi.sh" },
        { type: "vcs", url: "https://github.com/prefix-dev/pixi" },
      ],
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("parse pixi.toml with legacy project metadata", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pixi-project-"));
  const pixiTomlFile = path.join(tempDir, "pixi.toml");
  writeFileSync(
    pixiTomlFile,
    `
[project]
name = "pixi-project-app"
version = "0.2.0"
description = "Project metadata test"
homepage = "https://example.com/pixi-project"
repository = "https://example.com/pixi-project.git"
    `.trim(),
    "utf-8",
  );
  try {
    assert.deepStrictEqual(parsePixiTomlFile(pixiTomlFile), {
      description: "Project metadata test",
      name: "pixi-project-app",
      version: "0.2.0",
      externalReferences: [
        { type: "website", url: "https://example.com/pixi-project" },
        { type: "vcs", url: "https://example.com/pixi-project.git" },
      ],
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("parse pixi.lock sets evidence method value", () => {
  const parsedData = parsePixiLockFile(
    "./test/data/pixi-workspace-repotest/pixi.lock",
    "./test/data/pixi-workspace-repotest",
  );
  assert.deepStrictEqual(
    parsedData.pkgList[0].evidence.identity.methods[0].value,
    "./test/data/pixi-workspace-repotest/.pixi/envs/default",
  );
});

it("parse pixi.lock sets evidence method value without explicit path", () => {
  const parsedData = parsePixiLockFile(
    "./test/data/pixi-workspace-repotest/pixi.lock",
  );
  assert.deepStrictEqual(
    parsedData.pkgList[0].evidence.identity.methods[0].value,
    "./test/data/pixi-workspace-repotest/.pixi/envs/default",
  );
});

it("parse malformed pixi.toml returns empty metadata", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pixi-malformed-"));
  const pixiTomlFile = path.join(tempDir, "pixi.toml");
  writeFileSync(
    pixiTomlFile,
    `
[workspace]
name = "broken"
version = "0.1.0
    `.trim(),
    "utf-8",
  );
  try {
    assert.deepStrictEqual(parsePixiTomlFile(pixiTomlFile), {});
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("parse pyproject.toml with custom poetry source", () => {
  const retMap = parsePyProjectTomlFile(
    "./test/data/pyproject_with_custom_poetry_source.toml",
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    author: "Team AppThreat <cloud@appthreat.com>",
    "bom-ref": "pkg:pypi/cpggen@1.9.0",
    purl: "pkg:pypi/cpggen@1.9.0",
    description:
      "Generate CPG for multiple languages for code and threat analysis",
    evidence: {
      identity: {
        confidence: 1,
        field: "purl",
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/pyproject_with_custom_poetry_source.toml",
          },
        ],
      },
    },
    homepage: {
      url: "https://github.com/AppThreat/cpggen",
    },
    license: "Apache-2.0",
    name: "cpggen",
    repository: {
      url: "https://github.com/AppThreat/cpggen",
    },
    tags: [
      "atom",
      "code analysis",
      "code property graph",
      "cpg",
      "joern",
      "static analysis",
      "threat analysis",
    ],
    version: "1.9.0",
    type: "application",
  });
  assert.ok(retMap.poetryMode);
  assert.deepStrictEqual(Object.keys(retMap.directDepsKeys).length, 6);
});

it("parse pyproject.toml captures dependency manifest sources", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pyproject-source-"));
  const pyProjectFile = path.join(tempDir, "pyproject.toml");
  writeFileSync(
    pyProjectFile,
    `
[project]
name = "demo-app"
version = "0.1.0"
dependencies = ["anyio[http2] @ https://example.com/packages/anyio.whl"]

[tool.poetry.dependencies]
python = ">=3.11"
poetry-git = { git = "https://github.com/acme/poetry-git.git" }

[tool.uv.sources]
uv-path = { path = "../libs/uv-path" }
    `.trim(),
    "utf-8",
  );
  try {
    const pyProjectData = parsePyProjectTomlFile(pyProjectFile);
    assert.deepStrictEqual(pyProjectData.dependencySourceMap.anyio, {
      type: "url",
      value: "https://example.com/packages/anyio.whl",
    });
    assert.strictEqual(pyProjectData.directDepsKeys.anyio, true);
    assert.deepStrictEqual(pyProjectData.dependencySourceMap["poetry-git"], {
      type: "git",
      value: "https://github.com/acme/poetry-git.git",
    });
    assert.deepStrictEqual(pyProjectData.dependencySourceMap["uv-path"], {
      type: "path",
      value: "../libs/uv-path",
    });

    const retMap = await parsePyLockData(
      readFileSync("./test/data/uv.lock", { encoding: "utf-8" }),
      "./test/data/uv.lock",
      pyProjectFile,
    );
    const anyioPkg = retMap.pkgList.find((pkg) => pkg.name === "anyio");
    assert.ok(anyioPkg);
    assert.ok(
      anyioPkg.properties.some(
        (property) =>
          property.name === "cdx:pypi:manifestSourceType" &&
          property.value === "url",
      ),
    );
    assert.ok(
      anyioPkg.properties.some(
        (property) =>
          property.name === "cdx:pypi:manifestSource" &&
          property.value === "https://example.com/packages/anyio.whl",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("normalizes pyproject direct dependency keys when matching pylock packages", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pylock-normalize-"));
  const pyProjectFile = path.join(tempDir, "pyproject.toml");
  const pyLockFile = path.join(tempDir, "pylock.toml");
  writeFileSync(
    pyProjectFile,
    `
[project]
name = "normalize-demo"
version = "1.0.0"
dependencies = [
  "demo_pkg @ https://example.com/packages/demo-pkg-1.0.0.whl",
]
    `.trim(),
    "utf-8",
  );
  writeFileSync(
    pyLockFile,
    `
lock-version = "1.0"
created-by = "poku"

[[packages]]
name = "demo-pkg"
version = "1.0.0"
index = "https://pypi.org/simple/"
wheels = [
  { name = "demo_pkg-1.0.0-py3-none-any.whl", url = "https://example.com/packages/demo-pkg-1.0.0.whl", size = 1234, upload-time = 2026-01-01T00:00:00+00:00, hashes = { sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" } },
]
    `.trim(),
    "utf-8",
  );
  try {
    const retMap = await parsePyLockData(
      readFileSync(pyLockFile, { encoding: "utf-8" }),
      pyLockFile,
      pyProjectFile,
    );
    assert.strictEqual(retMap.rootList.length, 1);
    assert.strictEqual(retMap.rootList[0].name, "demo-pkg");
    assert.ok(
      retMap.rootList[0].properties.some(
        (property) =>
          property.name === "cdx:pypi:manifestSourceType" &&
          property.value === "url",
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("parse python lock files", async () => {
  // Every type:file component (incl. nested) must carry a non-empty name -
  // nameless components fail cdxgen's default schema validation (issue #4225).
  const assertNoNamelessFileComponents = (parsed, label) => {
    const walk = (components) =>
      (components || []).every(
        (component) =>
          (component.type !== "file" ||
            (typeof component.name === "string" &&
              component.name.length > 0)) &&
          walk(component.components),
      );
    assert.ok(
      parsed.pkgList.every((p) => walk(p.components)),
      `Expected no nameless type:file components from ${label}`,
    );
  };
  let retMap = await parsePyLockData(
    readFileSync("./test/data/poetry.lock", { encoding: "utf-8" }),
    "./test/data/poetry.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 32);
  assert.deepStrictEqual(retMap.pkgList[2].scope, "optional");
  assert.deepStrictEqual(retMap.dependenciesList.length, 32);
  assertNoNamelessFileComponents(retMap, "poetry.lock");
  retMap = await parsePyLockData(
    readFileSync("./test/data/poetry1.lock", { encoding: "utf-8" }),
    "./test/data/poetry1.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 68);
  // 68 packages + 1 entry for the parent component (cpggen) whose first-level
  // edges are seeded from pyproject.toml [tool.poetry.dependencies].
  assert.deepStrictEqual(retMap.dependenciesList.length, 69);
  retMap = await parsePyLockData(
    readFileSync("./test/data/poetry-cpggen.lock", { encoding: "utf-8" }),
    "./test/data/poetry-cpggen.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 69);
  // 69 packages + 1 entry for the parent component.
  assert.deepStrictEqual(retMap.dependenciesList.length, 70);
  retMap = await parsePyLockData(
    readFileSync("./test/data/pdm.lock", { encoding: "utf-8" }),
    "./test/data/pdm.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 39);
  // 37 packages with transitive edges + 1 entry for the parent component.
  assert.deepStrictEqual(retMap.dependenciesList.length, 38);
  const pdmBlinkerPkg = retMap.pkgList.find((p) => p.name === "blinker");
  assert.ok(
    pdmBlinkerPkg.externalReferences?.some(
      (reference) =>
        reference.type === "distribution" && reference.url.endsWith(".whl"),
    ),
    "Expected pdm.lock metadata files to populate distribution externalReferences",
  );
  assert.ok(
    pdmBlinkerPkg.components?.length,
    "Expected pdm.lock metadata files to produce file components",
  );
  assert.ok(
    pdmBlinkerPkg.components.every(
      (component) => typeof component.name === "string" && component.name,
    ),
    "Expected every pdm.lock file component to have a name",
  );
  assert.ok(
    pdmBlinkerPkg.components.some((component) =>
      component.name.endsWith(".whl"),
    ),
    "Expected pdm.lock file component name to be derived from the url basename",
  );
  assertNoNamelessFileComponents(retMap, "pdm.lock");
  retMap = await parsePyLockData(
    readFileSync("./test/data/uv.lock", { encoding: "utf-8" }),
    "./test/data/uv.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 63);
  // 63 packages + 1 entry for the parent component seeded from the
  // neighbouring pyproject.toml.
  assert.deepStrictEqual(retMap.dependenciesList.length, 64);
  const uvAnyioPkg = retMap.pkgList.find((p) => p.name === "anyio");
  assert.ok(
    uvAnyioPkg.externalReferences?.some(
      (reference) =>
        reference.type === "distribution" && reference.url.endsWith(".whl"),
    ),
    "Expected uv.lock packages to populate distribution externalReferences",
  );
  assertNoNamelessFileComponents(retMap, "uv.lock");
  retMap = await parsePyLockData(
    readFileSync("./test/data/uv-workspace.lock", { encoding: "utf-8" }),
    "./test/data/uv-workspace.lock",
    "./test/data/pyproject_uv-workspace.toml",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 9);
  assert.deepStrictEqual(retMap.rootList.length, 9);
  // 9 packages + 1 entry for the workspace root (my-app). The member
  // pyproject.toml files do not exist next to the lock, so rootList falls
  // back to every locked package; the root edge itself must stay precise and
  // contain only the [project.dependencies] entry (my-lib) that resolved.
  assert.deepStrictEqual(retMap.dependenciesList.length, 10);
  const workspaceRootEntry = retMap.dependenciesList.find(
    (adep) => adep.ref === "pkg:pypi/my-app@0.1.0",
  );
  assert.ok(
    workspaceRootEntry,
    "expected a dependencies entry for the workspace root my-app",
  );
  assert.deepStrictEqual(workspaceRootEntry.dependsOn, [
    "pkg:pypi/my-lib@0.1.0",
  ]);
  assertNoNamelessFileComponents(retMap, "uv-workspace.lock");
  retMap = await parsePyLockData(
    readFileSync("./test/data/pylock.toml", { encoding: "utf-8" }),
    "./test/data/pylock.toml",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 2);
  assert.deepStrictEqual(retMap.dependenciesList.length, 2);
  assert.ok(
    retMap.pyLockProperties.some((p) => p.name === "cdx:pylock:lock_version"),
  );
  const attrsPkg = retMap.pkgList.find((p) => p.name === "attrs");
  assert.ok(
    attrsPkg.properties.some((p) => p.name === "cdx:pylock:marker"),
    "Expected pylock marker custom property for attrs package",
  );
  assert.ok(
    attrsPkg.components?.length,
    "Expected pylock wheel entry to produce file component",
  );
  assert.ok(
    attrsPkg.externalReferences?.some(
      (reference) =>
        reference.type === "distribution" && reference.url.endsWith(".whl"),
    ),
    "Expected pylock package to retain distribution externalReferences",
  );
  assertNoNamelessFileComponents(retMap, "pylock.toml");
  const cattrsPkg = retMap.pkgList.find((p) => p.name === "cattrs");
  assert.ok(
    cattrsPkg.properties.some(
      (p) =>
        p.name === "cdx:pypi:registry" &&
        p.value === "https://internal.example/simple",
    ),
    "Expected non-default pylock index to map to cdx:pypi:registry",
  );
  retMap = await parsePyLockData(
    readFileSync("./test/data/pylock-named/pylock.dev.toml", {
      encoding: "utf-8",
    }),
    "./test/data/pylock-named/pylock.dev.toml",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.ok(
    retMap.pkgList[0].components?.[0]?.hashes?.some((h) => h.alg === "SHA-256"),
    "Expected sha-256 pylock hash to normalize to SHA-256",
  );
  assertNoNamelessFileComponents(retMap, "pylock.dev.toml");
}, 120000);

it("seeds the root component dependsOn from the manifest for uv.lock", async () => {
  // Regression test for issue #4343: with pyproject.toml + uv.lock the root
  // component used to end up with an empty dependsOn, because
  // parsePyLockData skipped the parent while iterating the lock entries and
  // nothing re-seeded its first-level edges. The lock fixture mirrors real
  // uv output: it contains the root project itself (virtual source, runtime
  // dependencies, [package.dev-dependencies] and [package.metadata]), so
  // the skip-and-seed path is exercised end to end. The pyproject declares
  // two runtime deps (Click, packaging - deliberately mixed case and loose
  // specifier) and one dev dep (pytest via [tool.uv] dev-dependencies).
  const retMap = await parsePyLockData(
    readFileSync("./test/data/uv-root-repro/uv.lock", { encoding: "utf-8" }),
    "./test/data/uv-root-repro/uv.lock",
    "./test/data/uv-root-repro/pyproject.toml",
  );
  assert.ok(retMap.parentComponent, "parentComponent should be resolved");
  const rootRef = retMap.parentComponent["bom-ref"];
  assert.strictEqual(rootRef, "pkg:pypi/uv-root-repro@2.0.0");

  // The root project is described by metadata.component, not as a component.
  assert.deepStrictEqual(retMap.pkgList.length, 5);
  assert.ok(
    !retMap.pkgList.some((apkg) => apkg.name === "uv-root-repro"),
    "the root project must be skipped from the component list",
  );

  const rootEntry = retMap.dependenciesList.find(
    (adep) => adep.ref === rootRef,
  );
  assert.ok(
    rootEntry,
    "dependenciesList should contain an entry for the root component",
  );
  // Only the runtime [project.dependencies] that resolved in the lock, in
  // their normalised hyphenated form. The dev dependency (pytest), its own
  // transitive (iniconfig), and the marker-conditional colorama stay out.
  assert.deepStrictEqual(rootEntry.dependsOn, [
    "pkg:pypi/click@8.1.7",
    "pkg:pypi/packaging@24.1",
  ]);

  // Transitive edges within the lock must be preserved.
  const clickEntry = retMap.dependenciesList.find(
    (adep) => adep.ref === "pkg:pypi/click@8.1.7",
  );
  assert.deepStrictEqual(clickEntry?.dependsOn, ["pkg:pypi/colorama@0.4.6"]);
  const pytestEntry = retMap.dependenciesList.find(
    (adep) => adep.ref === "pkg:pypi/pytest@8.3.5",
  );
  assert.deepStrictEqual(pytestEntry?.dependsOn, [
    "pkg:pypi/iniconfig@2.0.0",
    "pkg:pypi/packaging@24.1",
  ]);
});

it("seeds the root component dependsOn for poetry manifests with mixed-case keys", async () => {
  // [tool.poetry.dependencies] keeps the author's casing (Click = "^8.1"),
  // which used to miss every normalised lookup and left the root component
  // without any edge - the same symptom as issue #4343, on the poetry path.
  const retMap = await parsePyLockData(
    readFileSync("./test/data/poetry1.lock", { encoding: "utf-8" }),
    "./test/data/poetry1.lock",
    "./test/data/pyproject_poetry_mixed_case.toml",
  );
  const rootRef = retMap.parentComponent["bom-ref"];
  assert.strictEqual(rootRef, "pkg:pypi/poetry-mixed-case@1.0.0");
  const rootEntry = retMap.dependenciesList.find(
    (adep) => adep.ref === rootRef,
  );
  assert.ok(
    rootEntry,
    "mixed-case poetry dependencies must still resolve to a root edge",
  );
  // Click and PackageURL_Python normalise and resolve against the lock;
  // HTTPX is not locked, so it is dropped instead of left dangling.
  assert.deepStrictEqual(rootEntry.dependsOn, [
    "pkg:pypi/click@8.1.3",
    "pkg:pypi/packageurl-python@0.10.4",
  ]);
  // [tool.poetry.group.dev.dependencies] keeps the author's casing as well,
  // and group membership decides the component scope.
  const richPkg = retMap.pkgList.find((apkg) => apkg.name === "rich");
  assert.strictEqual(richPkg.scope, "optional");
  assert.ok(
    richPkg.properties.some(
      (aprop) => aprop.name === "cdx:pyproject:group" && aprop.value === "dev",
    ),
    "a mixed-case dev group dependency must still be marked as a group member",
  );
});

it("derive python lock metadata file name", () => {
  // poetry.lock entries carry an explicit `file` key.
  assert.strictEqual(
    derivePythonLockMetadataFileName({
      file: "blinker-1.6.2-py3-none-any.whl",
      hash: "sha256:abc",
    }),
    "blinker-1.6.2-py3-none-any.whl",
  );
  // A `file` value that is itself a path should be reduced to its basename.
  assert.strictEqual(
    derivePythonLockMetadataFileName({ file: "dist/foo-1.0.tar.gz" }),
    "foo-1.0.tar.gz",
  );

  // pdm.lock entries carry a `url` instead of `file`.
  assert.strictEqual(
    derivePythonLockMetadataFileName({
      url: "https://files.pythonhosted.org/packages/0d/f1/blinker-1.6.2-py3-none-any.whl",
      hash: "sha256:abc",
    }),
    "blinker-1.6.2-py3-none-any.whl",
  );
  assert.strictEqual(
    derivePythonLockMetadataFileName({
      url: "https://files.pythonhosted.org/packages/e8/f9/blinker-1.6.2.tar.gz",
    }),
    "blinker-1.6.2.tar.gz",
  );
  // Query strings and fragments must be stripped from URL-derived names.
  assert.strictEqual(
    derivePythonLockMetadataFileName({
      url: "https://example.com/pkg/foo-1.0-py3-none-any.whl?token=secret#sha256=deadbeef",
    }),
    "foo-1.0-py3-none-any.whl",
  );
  // Percent-encoded characters in the URL basename should be decoded.
  assert.strictEqual(
    derivePythonLockMetadataFileName({
      url: "https://example.com/pkg/foo%2Bbar-1.0-py3-none-any.whl",
    }),
    "foo+bar-1.0-py3-none-any.whl",
  );
  // A relative / non-absolute url should still yield a basename.
  assert.strictEqual(
    derivePythonLockMetadataFileName({ url: "subdir/foo-1.0.tar.gz" }),
    "foo-1.0.tar.gz",
  );

  // pylock.toml / uv.lock artifacts can carry an explicit `name`.
  assert.strictEqual(
    derivePythonLockMetadataFileName({
      name: "attrs-25.1.0-py3-none-any.whl",
      url: "https://example.com/wherever/attrs.whl",
    }),
    "attrs-25.1.0-py3-none-any.whl",
  );
  // ... or a local `path`.
  assert.strictEqual(
    derivePythonLockMetadataFileName({
      path: "./dist/cattrs-24.1.2.tar.gz",
    }),
    "cattrs-24.1.2.tar.gz",
  );

  // Precedence: explicit file/name win over path, which wins over url.
  assert.strictEqual(
    derivePythonLockMetadataFileName({
      file: "explicit-1.0.whl",
      path: "./dist/path-1.0.whl",
      url: "https://example.com/url-1.0.whl",
    }),
    "explicit-1.0.whl",
  );
  assert.strictEqual(
    derivePythonLockMetadataFileName({
      path: "./dist/path-1.0.whl",
      url: "https://example.com/url-1.0.whl",
    }),
    "path-1.0.whl",
  );

  // Edge cases: nothing derivable -> undefined.
  assert.strictEqual(derivePythonLockMetadataFileName(undefined), undefined);
  assert.strictEqual(derivePythonLockMetadataFileName(null), undefined);
  assert.strictEqual(derivePythonLockMetadataFileName("foo.whl"), undefined);
  assert.strictEqual(derivePythonLockMetadataFileName({}), undefined);
  assert.strictEqual(
    derivePythonLockMetadataFileName({ hash: "sha256:abc" }),
    undefined,
  );
  // Empty / whitespace-only values are ignored.
  assert.strictEqual(
    derivePythonLockMetadataFileName({ file: "   ", url: "  " }),
    undefined,
  );
  // Non-string values are ignored.
  assert.strictEqual(
    derivePythonLockMetadataFileName({ file: 123, name: {}, url: [] }),
    undefined,
  );
  // A url whose pathname has no basename (root / trailing slash) is undefined.
  assert.strictEqual(
    derivePythonLockMetadataFileName({ url: "https://example.com/" }),
    undefined,
  );
});

it("parse pipfile.lock with hashes", async () => {
  const deps = await parsePiplockData(
    JSON.parse(readFileSync("./test/data/Pipfile.lock", { encoding: "utf-8" })),
  );
  assert.deepStrictEqual(deps.length, 46);
}, 120000);

describe("parseMojoProject", () => {
  it("extracts parent and Mojo dependencies as generic with proposedType", () => {
    const { pkgList, parentComponent } = parseMojoProject(
      "./test/data/mojo-smoke/mojoproject.toml",
    );
    assert.strictEqual(parentComponent.name, "mojo-smoke");
    assert.strictEqual(parentComponent.version, "0.3.0");
    assert.strictEqual(pkgList.length, 2);

    const algorithm = pkgList.find((p) => p.name === "algorithm");
    assert.ok(algorithm);
    // The ==0.1.0 specifier is normalised to a concrete version.
    assert.strictEqual(algorithm.version, "0.1.0");
    assert.strictEqual(algorithm.purl, "pkg:generic/algorithm@0.1.0");
    assert.strictEqual(algorithm.scope, "required");
    const proposed = algorithm.properties.find(
      (p) => p.name === "cdx:purl:proposedType",
    );
    assert.strictEqual(proposed.value, "mojo");

    const mojoLib = pkgList.find((p) => p.name === "mojo-lib");
    assert.strictEqual(mojoLib.version, "0.2.1");

    // Mojo packages never squat an unregistered pkg:mojo/ type.
    for (const pkg of pkgList) {
      assert.ok(
        pkg.purl.startsWith("pkg:generic/"),
        `${pkg.name} must be generic, got ${pkg.purl}`,
      );
    }
  });

  it("returns empty results for a missing file", () => {
    const { pkgList, parentComponent } = parseMojoProject(
      "./test/data/missing-mojoproject.toml",
    );
    assert.deepEqual(pkgList, []);
    assert.deepEqual(parentComponent, {});
  });
});

describe("an unparseable python lock file always ranks a repair", () => {
  const CORRUPT_TOML = "[[packages]]\nthis is not toml =====\n";

  /**
   * Parse a deliberately corrupt lock file and collect the remediation ids
   * the failure recorded.
   *
   * @param {string} lockFileName Lock file name the parse failure is attributed to.
   * @returns {Promise<string[]>} Remediation ids recorded by the failure.
   */
  async function degradationIdsFor(lockFileName) {
    const ledger = await import("../core/buildLedger.js");
    // Recording is gated on the environment the CLI sets after parsing its
    // arguments, read live, so the test turns it on for its own call rather
    // than depending on how the suite was invoked.
    const previous = process.env.CDXGEN_INTROSPECT;
    process.env.CDXGEN_INTROSPECT = "true";
    // The ledger is process-global and every test in this file writes to it,
    // so the failing path is what identifies this call's own events.
    const lockPath = path.join(
      mkdtempSync(path.join(tmpdir(), "cdxgen-pylock-")),
      lockFileName,
    );
    try {
      await parsePyLockData(CORRUPT_TOML, lockPath);
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_INTROSPECT;
      } else {
        process.env.CDXGEN_INTROSPECT = previous;
      }
    }
    // The ledger redacts the user's home directory to `~` when it records a
    // path, so on Windows — where the default %TEMP% lives under the profile
    // — the stored path differs from lockPath by exactly that rewrite.
    // Compare against the redacted form or the equality never holds.
    const redactedPath = lockPath.split(homedir()).join("~");
    return ledger
      .getLedgerEvents()
      .filter(
        (event) =>
          event.remediationId &&
          (event.path === lockPath || event.path === redactedPath),
      )
      .map((event) => event.remediationId);
  }

  it("names the manager that owns the failing lock file", async () => {
    assert.deepEqual(await degradationIdsFor("uv.lock"), [
      "python.lockfile-unparseable.uv",
    ]);
    assert.deepEqual(await degradationIdsFor("poetry.lock"), [
      "python.lockfile-unparseable.poetry",
    ]);
    assert.deepEqual(await degradationIdsFor("pdm.lock"), [
      "python.lockfile-unparseable.pdm",
    ]);
  });

  it("falls back to the generic repair for a standards-named lock file", async () => {
    // PEP 751's pylock.toml belongs to no single manager, and a lock file
    // that names no manager must still rank a repair: without one the SBOM
    // silently loses its locked versions and the report proposes nothing.
    assert.deepEqual(await degradationIdsFor("pylock.toml"), [
      "python.lockfile-unparseable",
    ]);
  });
});

describe("parsePyLockData resilience to an unparseable workspace pyproject.toml", () => {
  // Historic context: @iarna/toml 2.2.5 enforced TOML 0.5's "inline lists must be a
  // single type" rule, which TOML 1.0 removed, and PEP 735 dependency groups mix an
  // inline table (`include-group`) with strings - so real projects carried a
  // pyproject.toml that parser rejected (pydantic's vendored `pydantic-core` among
  // them), a workspace member's parse returned no parent component, and reading its
  // `bom-ref` anyway threw and took the whole SBOM down. cdxgen now parses TOML with
  // smol-toml (TOML 1.0), so the mixed-array file PARSES; these resilience tests stay
  // as the regression guard for the empty-parent path they were built for.
  const mixedArrayPyProject = `[project]
name = 'broken-member'
version = '1.0.0'

[dependency-groups]
testing = [
    { include-group = "dev" },
    'coverage',
]
`;

  const rootPyProject = `[project]
name = 'demo-root'
version = '1.0.0'
dependencies = ['anyio']

[tool.uv.workspace]
members = ['packages/*']
`;

  const scaffold = () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "pyproj-workspace-"));
    mkdirSync(path.join(tmpRoot, "packages", "broken-member"), {
      recursive: true,
    });
    writeFileSync(path.join(tmpRoot, "pyproject.toml"), rootPyProject);
    writeFileSync(
      path.join(tmpRoot, "packages", "broken-member", "pyproject.toml"),
      mixedArrayPyProject,
    );
    writeFileSync(
      path.join(tmpRoot, "uv.lock"),
      readFileSync("./test/data/uv.lock", { encoding: "utf-8" }),
    );
    return tmpRoot;
  };

  it("does not throw, and still returns the locked components", async () => {
    const tmpRoot = scaffold();
    try {
      const lockFile = path.join(tmpRoot, "uv.lock");
      const retMap = await parsePyLockData(
        readFileSync(lockFile, { encoding: "utf-8" }),
        lockFile,
        path.join(tmpRoot, "pyproject.toml"),
      );
      assert.ok(retMap);
      assert.ok(retMap.pkgList.length > 0);
      assert.ok(retMap.pkgList.some((pkg) => pkg.name === "anyio"));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("records no parent ref for the unreadable member rather than an undefined one", async () => {
    const tmpRoot = scaffold();
    try {
      const lockFile = path.join(tmpRoot, "uv.lock");
      const retMap = await parsePyLockData(
        readFileSync(lockFile, { encoding: "utf-8" }),
        lockFile,
        path.join(tmpRoot, "pyproject.toml"),
      );
      // absence assertion: the old dereference produced an `undefined` parent ref and
      // pushed it into the tree; nothing may reference a missing parent.
      for (const dep of retMap.dependenciesList || []) {
        assert.ok(dep.ref, "every dependency entry must carry a ref");
        for (const on of dep.dependsOn || []) {
          assert.ok(on, "dependsOn must not contain an undefined ref");
        }
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("PEP 440 versions with reserved characters", () => {
  it("parseReqFile keeps epochs, local labels and arbitrary equality", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-req-pep440-"));
    try {
      const reqFile = path.join(tempDir, "requirements.txt");
      writeFileSync(
        reqFile,
        [
          "torch==2.1.0+cpu",
          "epochpkg==1!0.2.0",
          "arbitrary===1!2.0+local",
          "spaced == 3.4.5",
          "scm-app==0.1.dev3+g1234abc",
          "",
        ].join("\n"),
      );
      const pkgList = await parseReqFile(reqFile, false);
      const versions = Object.fromEntries(
        pkgList.map((p) => [p.name, p.version]),
      );
      assert.deepStrictEqual(versions, {
        torch: "2.1.0+cpu",
        epochpkg: "1!0.2.0",
        arbitrary: "1!2.0+local",
        spaced: "3.4.5",
        "scm-app": "0.1.dev3+g1234abc",
      });
      // An exact pin, spaced or not, is not a range worth recording.
      const spaced = pkgList.find((p) => p.name === "spaced");
      assert.ok(
        !(spaced.properties || []).some(
          (p) => p.name === "cdx:pypi:versionSpecifiers",
        ),
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("parsePiplockData strips an arbitrary-equality pin whole", async () => {
    const deps = await parsePiplockData({
      _meta: {},
      default: {
        epochpkg: { version: "===1!0.2.0" },
        torch: { version: "==2.1.0+cpu" },
      },
    });
    assert.deepStrictEqual(
      Object.fromEntries(deps.map((p) => [p.name, p.version])),
      { epochpkg: "1!0.2.0", torch: "2.1.0+cpu" },
    );
  });

  it("parseMojoProject keeps a PEP 440 epoch", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-mojo-epoch-"));
    try {
      const projectFile = path.join(tempDir, "mojoproject.toml");
      writeFileSync(
        projectFile,
        [
          "[project]",
          'name = "mojo-epoch"',
          'version = "0.1.0"',
          "",
          "[dependencies]",
          'epochlib = "==1!2.0"',
          "",
        ].join("\n"),
      );
      const { pkgList } = parseMojoProject(projectFile);
      const dep = pkgList.find((p) => p.name === "epochlib");
      assert.strictEqual(dep.version, "1!2.0");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe("requirements.txt comment parsing stays linear and preserves comments", () => {
  it("extracts inline comments into license evidence", async () => {
    const reqDir = mkdtempSync(path.join(tmpdir(), "cdxgen-req-comment-"));
    try {
      const reqFile = path.join(reqDir, "requirements.txt");
      writeFileSync(
        reqFile,
        ["flask==1.0  # MIT License", "requests==2.31.0", ""].join("\n"),
      );
      const pkgList = await parseReqFile(reqFile);
      const flask = pkgList.find((pkg) => pkg.name === "flask");
      assert.ok(flask, "flask component must be parsed");
      assert.ok(
        flask.licenses?.length,
        "the inline MIT comment must be captured as license evidence",
      );
      const requests = pkgList.find((pkg) => pkg.name === "requests");
      assert.ok(requests, "requests component must be parsed");
    } finally {
      rmSync(reqDir, { recursive: true, force: true });
    }
  });

  it("a long whitespace run without a hash is cheap (ReDoS regression)", async () => {
    const reqDir = mkdtempSync(path.join(tmpdir(), "cdxgen-req-redos-"));
    try {
      const reqFile = path.join(reqDir, "requirements.txt");
      // 200 KB of internal whitespace with no '#'. The pre-fix
      // /\\s+#(.*)$/ regex backtracked quadratically over this line
      // (~21 s per file).
      writeFileSync(reqFile, `flask==1.0\na${" ".repeat(200 * 1024)}!\n`);
      const start = Date.now();
      const pkgList = await parseReqFile(reqFile);
      const elapsed = Date.now() - start;
      assert.ok(Array.isArray(pkgList));
      assert.ok(
        elapsed < 1000,
        `pathological whitespace line must parse quickly, took ${elapsed}ms`,
      );
    } finally {
      rmSync(reqDir, { recursive: true, force: true });
    }
  });
});

describe("uv.lock extras and interpreter markers", () => {
  const fixture = path.join("test", "data", "brotli-exposure", "uv-extras");

  it("keeps the extra edges of a package that has no required dependencies", async () => {
    const lockFile = path.join(fixture, "uv.lock");
    const retMap = await parsePyLockData(
      readFileSync(lockFile, { encoding: "utf-8" }),
      lockFile,
      path.join(fixture, "pyproject.toml"),
    );
    const urllib3 = retMap.dependenciesList.find(
      (d) => d.ref === "pkg:pypi/urllib3@2.8.0",
    );
    assert.deepStrictEqual(urllib3?.dependsOn, [
      "pkg:pypi/brotli@1.2.0",
      "pkg:pypi/brotlicffi@1.2.0.2",
    ]);
    const byName = Object.fromEntries(retMap.pkgList.map((p) => [p.name, p]));
    // brotlicffi is only for interpreters other than CPython.
    assert.strictEqual(byName.brotlicffi.scope, "optional");
    assert.deepStrictEqual(
      byName.brotlicffi.properties.filter((p) => p.name === "cdx:pip:markers"),
      [
        {
          name: "cdx:pip:markers",
          value: "platform_python_implementation != 'CPython'",
        },
      ],
    );
    assert.notStrictEqual(byName.brotli.scope, "optional");
    // A marker that does not exclude CPython leaves the package alone.
    assert.notStrictEqual(byName.pycparser.scope, "optional");
    assert.ok(
      !byName.pycparser.properties?.some((p) => p.name === "cdx:pip:markers"),
    );
  });
});

describe("markerExcludesCPython()", () => {
  it("decides only implementation clauses", () => {
    for (const marker of [
      "platform_python_implementation != 'CPython'",
      'platform_python_implementation == "PyPy"',
      "implementation_name == 'pypy'",
      "implementation_name != 'cpython' and sys_platform == 'linux'",
      "platform_python_implementation == 'PyPy' or implementation_name == 'graalpy'",
    ]) {
      assert.ok(markerExcludesCPython(marker), marker);
    }
    for (const marker of [
      "platform_python_implementation == 'CPython'",
      "implementation_name != 'PyPy'",
      "sys_platform == 'win32'",
      "platform_python_implementation != 'CPython' or sys_platform == 'linux'",
      "(platform_python_implementation != 'CPython')",
      "",
      undefined,
    ]) {
      assert.ok(!markerExcludesCPython(marker), `${marker}`);
    }
  });
});
