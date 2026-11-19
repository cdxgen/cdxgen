import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import { PYTHON_CMD } from "../core/env.js";
import { getTreeWithPlugin as realGetTreeWithPlugin } from "./piptree.js";

const pythonWithPip = ["python3", "python"].find(
  (cmd) => spawnSync(cmd, ["-m", "pip", "--version"]).status === 0,
);

it("getTreeWithPlugin() reports dry-run temp-dir, write, execute, and cleanup activity", async () => {
  const tempDir = path.join(path.sep, "tmp", "cdxgen-piptree-test");
  const pluginFile = path.join(tempDir, "piptree.py");
  const outputFile = path.join(tempDir, "piptree.json");
  const safeMkdtempSync = sinon.stub().returns(tempDir);
  const safeWriteSync = sinon.stub();
  const safeSpawnSync = sinon.stub().returns({
    error: new Error("dry run"),
    status: 1,
    stderr: "",
    stdout: "",
  });
  const safeRmSync = sinon.stub();
  const { getTreeWithPlugin } = await esmock("./piptree.js", {
    "../core/fs.js": {
      getTmpDir: sinon.stub().returns("/tmp"),
      safeExistsSync: sinon.stub().returns(false),
      safeMkdtempSync,
      safeRmSync,
      safeSpawnSync,
      safeWriteSync,
    },
  });

  const result = getTreeWithPlugin({}, "python3", "/repo");

  assert.deepStrictEqual(result, []);
  sinon.assert.calledOnce(safeMkdtempSync);
  sinon.assert.calledWithMatch(safeWriteSync, pluginFile, sinon.match.string);
  sinon.assert.calledWith(safeSpawnSync, "python3", [pluginFile, outputFile], {
    cwd: "/repo",
    env: {},
  });
  sinon.assert.calledWith(safeRmSync, tempDir, {
    force: true,
    recursive: true,
  });
});

it("getTreeWithPlugin() adds PIP_TARGET to PYTHONPATH without leaving an empty entry", async () => {
  const safeSpawnSync = sinon.stub().returns({ status: 0 });
  const { getTreeWithPlugin } = await esmock("./piptree.js", {
    "../core/fs.js": {
      getTmpDir: sinon.stub().returns("/tmp"),
      safeExistsSync: sinon.stub().returns(false),
      safeMkdtempSync: sinon.stub().returns("/tmp/cdxgen-piptree-test"),
      safeRmSync: sinon.stub(),
      safeSpawnSync,
      safeWriteSync: sinon.stub(),
    },
  });
  const pipTarget = path.join(path.sep, "tmp", "cdxgen-pip-test");
  const sitePackages = path.join(path.sep, "opt", "pypi");
  for (const [pythonPath, expected] of [
    [undefined, pipTarget],
    ["", pipTarget],
    [pipTarget, pipTarget],
    [sitePackages, `${sitePackages}${path.delimiter}${pipTarget}`],
    [
      `${path.delimiter}${sitePackages}`,
      `${sitePackages}${path.delimiter}${pipTarget}`,
    ],
  ]) {
    safeSpawnSync.resetHistory();
    getTreeWithPlugin(
      { PIP_TARGET: pipTarget, PYTHONPATH: pythonPath },
      "python3",
      "/repo",
    );
    assert.strictEqual(
      safeSpawnSync.firstCall.args[2].env.PYTHONPATH,
      expected,
    );
  }
});

it("getTreeWithPlugin() does not take the version from the url of a direct reference", () => {
  // The helper needs a Python with pip, which not every runner has.
  if (!pythonWithPip) {
    return;
  }
  const sitePackages = mkdtempSync(path.join(tmpdir(), "cdxgen-piptree-"));
  const url = "https://example.com/pkg-1.0-py3-none-any.whl";
  try {
    for (const [name, directUrl] of [
      ["indexpkg", undefined],
      ["unpadded", `${url}?keyid=a2V5&token=s3cr3t`],
      ["padded", `${url}?keyid=a2V5MQ==&token=s3cr3t`],
      ["twicepadded", `${url}?keyid=a2V5MQ==&sig=YQ==&token=s3cr3t`],
    ]) {
      const distInfo = path.join(sitePackages, `${name}-1.0.dist-info`);
      mkdirSync(distInfo);
      writeFileSync(
        path.join(distInfo, "METADATA"),
        `Metadata-Version: 2.1\nName: ${name}\nVersion: 1.0\n`,
      );
      if (directUrl) {
        writeFileSync(
          path.join(distInfo, "direct_url.json"),
          JSON.stringify({ url: directUrl, archive_info: {} }),
        );
      }
    }
    const tree = realGetTreeWithPlugin(
      { ...process.env, PIP_TARGET: sitePackages },
      pythonWithPip,
      sitePackages,
    );
    for (const [name, version] of [
      ["indexpkg", "1.0"],
      ["unpadded", "latest"],
      ["padded", "latest"],
      ["twicepadded", "latest"],
    ]) {
      const pkg = tree.find((t) => t.name === name);
      assert.ok(pkg, `${name} is in the tree`);
      assert.strictEqual(pkg.version, version);
      assert.strictEqual(pkg.purl, `pkg:pypi/${name}@${version}`);
    }
    assert.ok(!JSON.stringify(tree).includes("s3cr3t"));
  } finally {
    rmSync(sitePackages, { recursive: true, force: true });
  }
});

it("getTreeWithPlugin() removes the temp directory when the tree cannot be parsed", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-piptree-"));
  const safeRmSync = sinon.stub();
  try {
    writeFileSync(path.join(tempDir, "piptree.json"), "[{");
    const { getTreeWithPlugin } = await esmock("./piptree.js", {
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(tmpdir()),
        safeExistsSync: sinon.stub().returns(true),
        safeMkdtempSync: sinon.stub().returns(tempDir),
        safeRmSync,
        safeSpawnSync: sinon.stub().returns({ status: 0 }),
        safeWriteSync: sinon.stub(),
      },
    });
    assert.throws(() => getTreeWithPlugin({}, "python3", "/repo"), SyntaxError);
    sinon.assert.calledWith(safeRmSync, tempDir, {
      force: true,
      recursive: true,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// The plugin itself needs a Python with pip. The test returns early where there
// is none.
const hasPipPkgResources =
  spawnSync(PYTHON_CMD, ["-c", "import pip._vendor.pkg_resources"]).status ===
  0;

it("getTreeWithPlugin() evaluates a requirement once and not for every declared extra", () => {
  if (!hasPipPkgResources) {
    return;
  }
  const count = 300;
  const range = [...Array(count).keys()];
  const sitePackages = mkdtempSync(path.join(tmpdir(), "cdxgen-piptree-"));
  const writeDist = (name, lines) => {
    const distInfo = path.join(sitePackages, `${name}-1.0.dist-info`);
    mkdirSync(distInfo);
    writeFileSync(
      path.join(distInfo, "METADATA"),
      `${["Metadata-Version: 2.1", `Name: ${name}`, "Version: 1.0", ...lines].join("\n")}\n`,
    );
  };
  try {
    writeDist("manyextras", [
      ...range.map((i) => `Provides-Extra: e${i}`),
      // Applies to every declared extra, but not to a plain install
      ...range.map((i) => `Requires-Dist: a${i}; extra != ''`),
      "Requires-Dist: optional; extra == 'e0'",
      "Requires-Dist: legacy; python_version < '3'",
      "Requires-Dist: withall>=1; python_version >= '3'",
    ]);
    writeDist("withall", [
      "Provides-Extra: all",
      "Provides-Extra: dev",
      "Requires-Dist: optional; extra == 'all'",
      "Requires-Dist: legacy; extra == 'dev'",
    ]);
    writeDist("optional", []);
    writeDist("legacy", []);
    const tree = realGetTreeWithPlugin(
      { ...process.env, PIP_TARGET: sitePackages },
      PYTHON_CMD,
      sitePackages,
    );
    const root = tree.find((t) => t.name === "manyextras");
    assert.ok(root);
    assert.deepStrictEqual(root.extra_deps, {});
    assert.deepStrictEqual(root.dependencies, [
      {
        name: "withall",
        version: "1.0",
        versionSpecifiers: ">=1",
        purl: "pkg:pypi/withall@1.0",
        extra_deps: {
          all: [{ name: "optional", versionSpecifiers: "", url: null }],
        },
        dependencies: [
          {
            name: "optional",
            version: "1.0",
            versionSpecifiers: "",
            purl: "pkg:pypi/optional@1.0",
            extra_deps: {},
            dependencies: [],
          },
        ],
      },
    ]);
  } finally {
    rmSync(sitePackages, { recursive: true, force: true });
  }
});
