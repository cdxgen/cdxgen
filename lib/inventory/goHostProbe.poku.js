import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { probeHostGo } from "./goHostProbe.js";
import { createGoToolchainComponent, MAX_GO_PROBES } from "./goToolchain.js";

// Every tree below is built by these tests: a GOROOT is a VERSION file next
// to a bin/go launcher, exactly what a tarball, a Homebrew formula or
// golang.org/dl leaves on disk.
async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-go-host-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function put(root, file, content = "", mode = undefined) {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  if (mode) {
    chmodSync(target, mode);
  }
  return target;
}

function goroot(root, dir, version, launcher = "go") {
  put(root, `${dir}/VERSION`, `${version}\n`);
  put(root, `${dir}/bin/${launcher}`, "#!/bin/sh\n", 0o755);
}

// dpkg keeps one <package>.list per package, naming each path as it is on the
// system.
function dpkgOwns(root, packageName, paths) {
  put(
    root,
    `var/lib/dpkg/info/${packageName}.list`,
    `${["/.", ...paths].join("\n")}\n`,
  );
}

const probe = (root, extra = {}) =>
  probeHostGo({ rootPath: root, platform: "linux", ...extra });
const sources = (components) =>
  components
    .filter((component) => component.type === "file")
    .map(
      (component) =>
        component.properties.find((prop) => prop.name === "internal:SrcFile")
          .value,
    )
    .sort();
describe("probeHostGo()", () => {
  it("reports an unpackaged toolchain as a launcher linked to one platform component", () =>
    withRoot((root) => {
      goroot(root, "usr/local/go", "go1.27.1");
      const { components, dependencies } = probe(root);
      const toolchain = createGoToolchainComponent("1.27.1");
      assert.deepStrictEqual(components, [
        {
          name: "go",
          type: "file",
          purl: "pkg:generic/go#usr/local/go/bin/go",
          "bom-ref": "pkg:generic/go#usr/local/go/bin/go",
          properties: [
            { name: "internal:SrcFile", value: "/usr/local/go/bin/go" },
            { name: "cdx:go:toolchainVersion", value: "1.27.1" },
            { name: "cdx:go:toolchainVersionSource", value: "version-file" },
          ],
          evidence: {
            identity: [
              {
                field: "purl",
                confidence: 0,
                methods: [
                  {
                    technique: "filename",
                    confidence: 0,
                    value: "/usr/local/go/bin/go",
                  },
                ],
                concludedValue: "/usr/local/go/bin/go",
              },
            ],
          },
        },
        toolchain,
      ]);
      assert.deepStrictEqual(dependencies, [
        { ref: "pkg:generic/go@1.27.1", dependsOn: [] },
        {
          ref: "pkg:generic/go#usr/local/go/bin/go",
          dependsOn: ["pkg:generic/go@1.27.1"],
        },
      ]);
      assert.strictEqual(
        toolchain.cpe,
        "cpe:2.3:a:golang:go:1.27.1:*:*:*:*:*:*:*",
      );
    }));

  it("finds the toolchains of the fixed directories and the sdk tree of a home", () =>
    withRoot((root) => {
      goroot(root, "usr/local/go", "go1.27.4");
      goroot(root, "usr/lib/golang", "go1.26.11");
      goroot(root, "usr/lib/go-1.25", "go1.25.5");
      goroot(root, "usr/lib/go", "go1.24.9");
      goroot(root, "opt/go", "go1.23.6");
      goroot(root, "home/linuxbrew/.linuxbrew/opt/go/libexec", "go1.27.4");
      goroot(root, "home/dev/sdk/go1.22.12", "go1.22.12");
      // A bin directory with a go launcher but no GOROOT around it is not a
      // toolchain, and neither is a VERSION file without a launcher.
      put(root, "opt/sometool/bin/go", "#!/bin/sh\n", 0o755);
      put(root, "usr/local/go2/VERSION", "go1.99.0\n");
      const { components } = probe(root);
      assert.deepStrictEqual(sources(components), [
        "/home/dev/sdk/go1.22.12/bin/go",
        "/home/linuxbrew/.linuxbrew/opt/go/libexec/bin/go",
        "/opt/go/bin/go",
        "/usr/lib/go-1.25/bin/go",
        "/usr/lib/go/bin/go",
        "/usr/lib/golang/bin/go",
        "/usr/local/go/bin/go",
      ]);
      assert.deepStrictEqual(
        components
          .filter((component) => component.type === "platform")
          .map((component) => component.purl)
          .sort(),
        [
          "pkg:generic/go@1.22.12",
          "pkg:generic/go@1.23.6",
          "pkg:generic/go@1.24.9",
          "pkg:generic/go@1.25.5",
          "pkg:generic/go@1.26.11",
          "pkg:generic/go@1.27.4",
        ],
      );
    }));

  it("leaves a Homebrew-owned toolchain to its formula, and keeps an unpackaged one", () =>
    withRoot((root) => {
      goroot(root, "opt/homebrew/Cellar/go/1.27.4/libexec", "go1.27.4");
      goroot(root, "usr/local/go", "go1.26.11");
      const { components } = probe(root, { platform: "darwin" });
      assert.deepStrictEqual(sources(components), ["/usr/local/go/bin/go"]);
      assert.deepStrictEqual(
        components
          .filter((component) => component.type === "platform")
          .map((component) => component.version),
        ["1.26.11"],
      );
    }));

  it("emits nothing for a toolchain dpkg owns, and keeps the unpackaged one", () =>
    withRoot((root) => {
      goroot(root, "usr/local/go", "go1.27.4");
      goroot(root, "usr/lib/go-1.25", "go1.25.5");
      dpkgOwns(root, "golang-1.25", [
        "/usr/lib/go-1.25/VERSION",
        "/usr/lib/go-1.25/bin/go",
      ]);
      dpkgOwns(root, "libc6:amd64", ["/lib/x86_64-linux-gnu/libc.so.6"]);
      const { components } = probe(root);
      assert.deepStrictEqual(sources(components), ["/usr/local/go/bin/go"]);
      assert.deepStrictEqual(
        components
          .filter((component) => component.type === "platform")
          .map((component) => component.version),
        ["1.27.4"],
      );
    }));

  it("answers nothing for a GOROOT whose VERSION names a development build", () =>
    withRoot((root) => {
      goroot(root, "usr/local/go", "go1.28-9d1f2f0");
      assert.deepStrictEqual(probe(root), {
        components: [],
        dependencies: [],
      });
    }));

  it("never runs the launcher it reads", () =>
    withRoot((root) => {
      const sentinel = join(root, "ran");
      put(root, "usr/local/go/VERSION", "go1.27.4\n");
      put(
        root,
        "usr/local/go/bin/go",
        `#!/bin/sh\ntouch '${sentinel}'\n`,
        0o755,
      );
      const { components } = probe(root);
      assert.strictEqual(sources(components).length, 1);
      assert.strictEqual(existsSync(sentinel), false);
    }));

  it("asks osquery's rpm_package_files who owns a candidate, and trusts its answer", () =>
    withRoot((root) => {
      mkdirSync(join(root, "var/lib/rpm"), { recursive: true });
      goroot(root, "usr/lib/golang", "go1.26.11");
      goroot(root, "usr/local/go", "go1.27.4");
      const executeOsQuery = sinon
        .stub()
        .returns([{ package: "golang", path: "/usr/lib/golang/bin/go" }]);
      const { components } = probe(root, { executeOsQuery });
      assert.deepStrictEqual(sources(components), ["/usr/local/go/bin/go"]);
      sinon.assert.calledOnce(executeOsQuery);
      assert.ok(
        executeOsQuery.firstCall.args[0].includes("'/usr/lib/golang/bin/go'"),
      );
    }));

  it("emits no generic Go while a package database it must ask cannot be read", async () => {
    const degradations = [];
    const { probeHostGo: mocked } = await esmock("./goHostProbe.js", {
      "../core/buildLedger.js": {
        recordDegradation: (id, fields) => degradations.push({ id, ...fields }),
      },
    });
    await withRoot((root) => {
      goroot(root, "usr/local/go", "go1.27.4");
      // osquery cannot be run, or answered nothing parseable.
      mkdirSync(join(root, "var/lib/rpm"), { recursive: true });
      const { components, dependencies } = mocked({
        rootPath: root,
        platform: "linux",
        executeOsQuery: () => undefined,
      });
      assert.deepStrictEqual(components, []);
      assert.deepStrictEqual(dependencies, []);
    });
    assert.deepStrictEqual(
      degradations.map((entry) => [entry.id, entry.ecosystem, entry.impact]),
      [["go.host-probe.package-db-unreadable", "go", "components"]],
    );
  });

  it("treats a launcher as unpackaged when there is no package database at all", () =>
    withRoot((root) => {
      goroot(root, "usr/local/go", "go1.27.4");
      assert.deepStrictEqual(sources(probe(root).components), [
        "/usr/local/go/bin/go",
      ]);
    }));

  it("opens at most MAX_GO_PROBES candidates", () =>
    withRoot((root) => {
      for (let i = 0; i < MAX_GO_PROBES + 20; i++) {
        goroot(root, `opt/go${i}`, "go1.27.4");
      }
      const { components } = probe(root);
      assert.strictEqual(
        components.filter((component) => component.type === "file").length,
        MAX_GO_PROBES,
      );
    }));

  it("reports nothing for a root with no Go, and skips a missing root", () =>
    withRoot((root) => {
      assert.deepStrictEqual(probe(root), {
        components: [],
        dependencies: [],
      });
      assert.deepStrictEqual(
        probeHostGo({ rootPath: join(root, "missing"), platform: "linux" }),
        { components: [], dependencies: [] },
      );
    }));

  it("blocks itself in dry-run mode and says so", async () => {
    const recordActivity = sinon.stub();
    const { probeHostGo: mocked } = await esmock("./goHostProbe.js", {
      "../core/activity.js": { isDryRun: true, recordActivity },
    });
    await withRoot((root) => {
      goroot(root, "usr/local/go", "go1.27.4");
      assert.deepStrictEqual(mocked({ rootPath: root, platform: "linux" }), {
        components: [],
        dependencies: [],
      });
    });
    sinon.assert.calledWithMatch(recordActivity, {
      capability: "go-host-probe",
      status: "blocked",
    });
  });

  it("records what it read in the activity ledger", async () => {
    const recordActivity = sinon.stub();
    const { probeHostGo: mocked } = await esmock("./goHostProbe.js", {
      "../core/activity.js": { isDryRun: false, recordActivity },
    });
    await withRoot((root) => {
      goroot(root, "usr/local/go", "go1.27.4");
      mocked({ rootPath: root, platform: "linux" });
    });
    sinon.assert.calledWithMatch(recordActivity, {
      capability: "go-host-probe",
      kind: "read",
      status: "completed",
    });
  });
});

describe("probeHostGo() on Windows", () => {
  const winProbe = (root, extra = {}) =>
    probeHostGo({
      rootPath: root,
      platform: "win32",
      env: {},
      ...extra,
    });

  it("looks in Program Files, the drive root and the hosted toolcache", () =>
    withRoot((root) => {
      goroot(root, "Program Files/Go", "go1.27.4", "go.exe");
      goroot(root, "Go", "go1.26.11", "go.exe");
      goroot(
        root,
        "hostedtoolcache/windows/go/1.25.5/x64",
        "go1.25.5",
        "go.exe",
      );
      goroot(root, "Users/dev/sdk/go1.22.12", "go1.22.12", "go.exe");
      put(root, "Program Files/NotGo/bin/go.exe", "#!/bin/sh\n");
      const { components } = winProbe(root);
      // Like the Ruby and PHP probes, the Windows probe reads no home, so the
      // sdk tree under Users/dev is not looked at.
      assert.deepStrictEqual(
        components
          .filter((component) => component.type === "platform")
          .map((component) => component.version)
          .sort(),
        ["1.25.5", "1.26.11", "1.27.4"],
      );
      const launcher = components.find(
        (component) => component.type === "file",
      );
      assert.strictEqual(launcher.name, "go.exe");
    }));
});
