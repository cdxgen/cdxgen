import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

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

  it("never enters the folders macOS privacy protection guards", () =>
    withRoot((root) => {
      venv(root, "Users/dev/projects/site/.venv", []);
      venv(root, "Users/dev/Documents/work/.venv", []);
      venv(root, "Users/dev/Desktop/env", []);
      venv(root, "Users/dev/Downloads/tool/.venv", []);
      venv(root, "Users/dev/Library/Mail/.venv", []);
      venv(
        root,
        "Users/dev/Library/Caches/pypoetry/virtualenvs/app-py3.12",
        [],
      );
      const found = (platform) =>
        findPythonEnvironments(root, platform)
          .map((e) => e.path.slice(root.length + 1).replaceAll("\\", "/"))
          .sort();
      assert.deepStrictEqual(found("darwin"), [
        "Users/dev/Library/Caches/pypoetry/virtualenvs/app-py3.12",
        "Users/dev/projects/site/.venv",
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

// Creating a link needs a privilege on Windows, and the probe has no places to
// look in there, so these cases return at once.
const linkIt = (name, fn) =>
  it(name, (...args) =>
    process.platform === "win32" ? undefined : fn(...args),
  );

describe("symbolic links in the probed places", () => {
  const purls = (root, platform = "linux") =>
    probeHostPythonEnvironments({ rootPath: root, platform }).map(
      (c) => c.purl,
    );

  linkIt("follows no link below a home directory", () =>
    withRoot((root) => {
      // A private environment outside the places the probe looks in.
      venv(root, "var/lib/billing/venv", [["secret-lib", "9.9.9"]]);
      const privateSite = join(root, "var/lib/billing/venv/lib/python3.12");
      const home = join(root, "home/dev");

      // A linked environment, a linked pyvenv.cfg, a linked lib directory
      // and a linked site-packages directory.
      mkdirSync(join(home, ".virtualenvs"), { recursive: true });
      symlinkSync(
        join(root, "var/lib/billing/venv"),
        join(home, ".virtualenvs/linked-env"),
      );
      put(home, "cfg-env/lib/python3.12/site-packages/x", "");
      symlinkSync(
        join(root, "var/lib/billing/venv/pyvenv.cfg"),
        join(home, "cfg-env/pyvenv.cfg"),
      );
      put(home, "lib-env/pyvenv.cfg", "home = /usr/bin\n");
      symlinkSync(
        join(root, "var/lib/billing/venv/lib"),
        join(home, "lib-env/lib"),
      );
      put(home, "site-env/pyvenv.cfg", "home = /usr/bin\n");
      mkdirSync(join(home, "site-env/lib/python3.12"), { recursive: true });
      symlinkSync(
        join(privateSite, "site-packages"),
        join(home, "site-env/lib/python3.12/site-packages"),
      );
      assert.deepStrictEqual(purls(root), []);
      // The linked environment and the linked pyvenv.cfg are not found; the
      // two real environments are, and their linked directories are not read.
      assert.deepStrictEqual(
        findPythonEnvironments(root, "linux")
          .map((e) => e.path.slice(home.length + 1))
          .sort(),
        ["lib-env", "site-env"],
      );
    }),
  );

  linkIt("reads no METADATA or dist-info that is a link", () =>
    withRoot((root) => {
      put(root, "var/lib/billing/other.txt", metadata("leaked", "1.0.0"));
      put(
        root,
        "var/lib/billing/dist/leaked-1.0.0.dist-info/METADATA",
        metadata("leaked-dir", "2.0.0"),
      );
      venv(root, "home/dev/proj/.venv", [["real", "1.0.0"]]);
      const site = join(
        root,
        "home/dev/proj/.venv/lib/python3.12/site-packages",
      );
      mkdirSync(join(site, "linked-1.0.dist-info"), { recursive: true });
      symlinkSync(
        join(root, "var/lib/billing/other.txt"),
        join(site, "linked-1.0.dist-info/METADATA"),
      );
      symlinkSync(
        join(root, "var/lib/billing/dist/leaked-1.0.0.dist-info"),
        join(site, "leaked-1.0.0.dist-info"),
      );
      assert.deepStrictEqual(purls(root), ["pkg:pypi/real@1.0.0"]);
    }),
  );

  linkIt("follows a link in /opt only while it stays inside /opt", () =>
    withRoot((root) => {
      venv(root, "opt/shared/real-venv", [["inside", "1.0.0"]]);
      venv(root, "var/lib/billing/venv", [["outside", "1.0.0"]]);
      mkdirSync(join(root, "opt/app"), { recursive: true });
      symlinkSync(
        join(root, "opt/shared/real-venv"),
        join(root, "opt/app/venv"),
      );
      symlinkSync(
        join(root, "var/lib/billing/venv"),
        join(root, "opt/app/escape"),
      );
      assert.deepStrictEqual(purls(root), ["pkg:pypi/inside@1.0.0"]);
    }),
  );
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
