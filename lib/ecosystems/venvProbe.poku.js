import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  findPythonEnvironments,
  mergeHostPythonEnvironmentPackages,
  probeHostPythonEnvironments,
} from "./venvProbe.js";

function put(root, file, content) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function metadata(name, version) {
  return `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\nSummary: ${name} summary\n\nbody text\n`;
}

function venv(root, dir, packages) {
  put(
    root,
    `${dir}/pyvenv.cfg`,
    "home = /usr/bin\ninclude-system-site-packages = false\n",
  );
  for (const [name, version] of packages) {
    put(
      root,
      `${dir}/lib/python3.12/site-packages/${name}-${version}.dist-info/METADATA`,
      metadata(name, version),
    );
  }
}

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-venvprobe-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("findPythonEnvironments()", () => {
  it("finds virtual environments and pyenv installs in the fixed places", () =>
    withRoot((root) => {
      venv(root, "opt/app/venv", []);
      venv(root, "srv/api/.venv", []);
      venv(root, "home/dev/.virtualenvs/tools", []);
      venv(root, "home/dev/projects/site/.venv", []);
      mkdirSync(join(root, "root/.pyenv/versions/3.12.7/lib"), {
        recursive: true,
      });
      // Not an environment: no pyvenv.cfg.
      mkdirSync(join(root, "opt/data/lib/python3.12/site-packages"), {
        recursive: true,
      });
      const found = findPythonEnvironments(root, "linux").map((e) => [
        e.path.slice(root.length + 1).replaceAll("\\", "/"),
        e.kind,
      ]);
      assert.deepStrictEqual(found.sort(), [
        ["home/dev/.virtualenvs/tools", "virtualenv"],
        ["home/dev/projects/site/.venv", "virtualenv"],
        ["opt/app/venv", "virtualenv"],
        ["root/.pyenv/versions/3.12.7", "pyenv"],
        ["srv/api/.venv", "virtualenv"],
      ]);
    }));
});

describe("probeHostPythonEnvironments()", () => {
  it("lists each package once with an occurrence per environment", () =>
    withRoot((root) => {
      venv(root, "opt/app/venv", [
        ["Brotli", "1.2.0"],
        ["brotlicffi", "1.2.0.0"],
      ]);
      venv(root, "home/dev/.virtualenvs/tools", [["Brotli", "1.2.0"]]);
      put(
        root,
        "opt/app/venv/lib/python3.12/site-packages/broken-1.0.dist-info/METADATA",
        "Name: broken\n",
      );
      const components = probeHostPythonEnvironments({
        rootPath: root,
        platform: "linux",
      });
      assert.deepStrictEqual(
        components.map((c) => c.purl),
        ["pkg:pypi/brotli@1.2.0", "pkg:pypi/brotlicffi@1.2.0.0"],
      );
      const brotli = components[0];
      assert.strictEqual(brotli.evidence.occurrences.length, 2);
      assert.ok(
        brotli.evidence.occurrences.every((o) =>
          o.location.endsWith(".dist-info"),
        ),
      );
      assert.deepStrictEqual(brotli.properties, [
        { name: "cdx:python:environment", value: "virtualenv" },
      ]);
      assert.ok(!brotli.purl.includes(root), "no host path in a purl");
    }));

  it("does nothing on platforms without the fixed places", () =>
    withRoot((root) => {
      venv(root, "opt/app/venv", [["Brotli", "1.2.0"]]);
      assert.deepStrictEqual(
        probeHostPythonEnvironments({ rootPath: root, platform: "win32" }),
        [],
      );
    }));

  it("is blocked in dry-run mode", async () => {
    const recordActivity = sinon.stub();
    const { probeHostPythonEnvironments: mocked } = await esmock(
      "./venvProbe.js",
      { "../core/activity.js": { isDryRun: true, recordActivity } },
    );
    await withRoot((root) => {
      venv(root, "opt/app/venv", [["Brotli", "1.2.0"]]);
      assert.deepStrictEqual(mocked({ rootPath: root, platform: "linux" }), []);
    });
    sinon.assert.calledWithMatch(recordActivity, {
      capability: "python-env-probe",
      status: "blocked",
    });
  });
});

describe("mergeHostPythonEnvironmentPackages()", () => {
  it("adds a venv's dist-info to the package osquery already listed", () => {
    const system = {
      type: "library",
      name: "brotli",
      version: "1.2.0",
      purl: "pkg:pypi/brotli@1.2.0",
      "bom-ref": "pkg:pypi/brotli@1.2.0",
      properties: [{ name: "cdx:osquery:category", value: "python_packages" }],
      evidence: {
        occurrences: [
          {
            location:
              "/usr/local/lib/python3.11/dist-packages/brotli-1.2.0.dist-info",
          },
        ],
      },
    };
    const venvBrotli = {
      purl: "pkg:pypi/brotli@1.2.0",
      "bom-ref": "pkg:pypi/brotli@1.2.0",
      properties: [{ name: "cdx:python:environment", value: "virtualenv" }],
      evidence: {
        occurrences: [
          {
            location:
              "/opt/app/venv/lib/python3.11/site-packages/brotli-1.2.0.dist-info",
          },
        ],
      },
    };
    const venvOnly = {
      purl: "pkg:pypi/brotlicffi@1.2.0.0",
      "bom-ref": "pkg:pypi/brotlicffi@1.2.0.0",
      properties: [{ name: "cdx:python:environment", value: "virtualenv" }],
      evidence: { occurrences: [{ location: "/opt/app/venv/x" }] },
    };
    const merged = mergeHostPythonEnvironmentPackages(
      [system],
      [venvBrotli, venvOnly],
    );
    assert.strictEqual(merged.length, 2);
    assert.deepStrictEqual(
      merged[0].evidence.occurrences.map((o) => o.location),
      [
        "/usr/local/lib/python3.11/dist-packages/brotli-1.2.0.dist-info",
        "/opt/app/venv/lib/python3.11/site-packages/brotli-1.2.0.dist-info",
      ],
    );
    assert.deepStrictEqual(
      merged[0].properties.map((p) => p.name),
      ["cdx:osquery:category", "cdx:python:environment"],
    );
    assert.strictEqual(merged[1], venvOnly);
    assert.deepStrictEqual(mergeHostPythonEnvironmentPackages([system], []), [
      system,
    ]);
  });
});
