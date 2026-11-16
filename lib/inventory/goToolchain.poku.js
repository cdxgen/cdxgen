import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  attachGoToolchain,
  classifyGoBinary,
  createGoToolchainComponent,
  createGoToolchainInventory,
  GO_VERSION_FILE_NAME,
  goBinaryName,
  goCpe,
  goStdlibComponent,
  goToolchainProperties,
  goToolchainRef,
  parseGoVersionOutput,
  readGoToolchainVersion,
} from "./goToolchain.js";

describe("parseGoVersionOutput", () => {
  it("reads the banner `go version` prints", () => {
    assert.strictEqual(
      parseGoVersionOutput("go version go1.27.4 darwin/arm64"),
      "1.27.4",
    );
    assert.strictEqual(
      parseGoVersionOutput("go version go1.21.13 linux/amd64"),
      "1.21.13",
    );
  });

  it("reads the version `go env GOVERSION` prints", () => {
    assert.strictEqual(parseGoVersionOutput("go1.26.10"), "1.26.10");
  });

  it("keeps the version of a boringcrypto build", () => {
    assert.strictEqual(
      parseGoVersionOutput("go version go1.26.10 X:boringcrypto"),
      "1.26.10",
    );
    assert.strictEqual(
      parseGoVersionOutput("go version go1.26.10 X:boringcrypto darwin/arm64"),
      "1.26.10",
    );
  });

  it("reads a pre-release of the rc, beta and alpha kinds", () => {
    assert.strictEqual(parseGoVersionOutput("go1.28rc1"), "1.28rc1");
    assert.strictEqual(
      parseGoVersionOutput("go version go1.19beta1 linux/amd64"),
      "1.19beta1",
    );
    assert.strictEqual(parseGoVersionOutput("go1.9.2rc2"), "1.9.2rc2");
  });

  it("keeps a patchless version as Go spells it", () => {
    // Since Go 1.21 the language version 1.21 is kept apart from the release
    // 1.21.0 (1.21 < 1.21rc1 < 1.21.0), so it is not rewritten.
    assert.strictEqual(
      parseGoVersionOutput("go version go1.21 darwin/arm64"),
      "1.21",
    );
    assert.strictEqual(
      parseGoVersionOutput("go version go1.20 linux/amd64"),
      "1.20",
    );
  });

  it("answers nothing for a development build", () => {
    assert.strictEqual(
      parseGoVersionOutput(
        "go version devel go1.28-9d1f2f0 Wed Nov 12 09:00:00 2026 darwin/arm64",
      ),
      undefined,
    );
    assert.strictEqual(parseGoVersionOutput("devel go1.28-9d1f2f0"), undefined);
  });

  it("strips the custom suffix of a rebuilt toolchain", () => {
    assert.strictEqual(
      parseGoVersionOutput("go version go1.21.3-mycorp linux/amd64"),
      "1.21.3",
    );
  });

  it("answers nothing for text that names no version", () => {
    assert.strictEqual(parseGoVersionOutput(""), undefined);
    assert.strictEqual(parseGoVersionOutput("gopher"), undefined);
    assert.strictEqual(parseGoVersionOutput("go h1:invalid"), undefined);
    assert.strictEqual(parseGoVersionOutput(undefined), undefined);
    assert.strictEqual(parseGoVersionOutput(42), undefined);
    // The command's error output is not a version
    assert.strictEqual(
      parseGoVersionOutput("go: go version: no such command"),
      undefined,
    );
  });
});

describe("goCpe", () => {
  it("names the golang:go product", () => {
    assert.strictEqual(
      goCpe("1.27.4"),
      "cpe:2.3:a:golang:go:1.27.4:*:*:*:*:*:*:*",
    );
  });

  it("puts a pre-release in the update field", () => {
    assert.strictEqual(
      goCpe("1.28rc1"),
      "cpe:2.3:a:golang:go:1.28:rc1:*:*:*:*:*:*",
    );
    assert.strictEqual(
      goCpe("1.19beta1"),
      "cpe:2.3:a:golang:go:1.19:beta1:*:*:*:*:*:*",
    );
  });
});

describe("createGoToolchainComponent", () => {
  it("is a platform component with the generic purl", () => {
    const component = createGoToolchainComponent("1.27.4");
    assert.strictEqual(component.type, "platform");
    assert.strictEqual(component.name, "go");
    assert.strictEqual(component.version, "1.27.4");
    assert.strictEqual(component.purl, "pkg:generic/go@1.27.4");
    assert.strictEqual(component["bom-ref"], "pkg:generic/go@1.27.4");
    assert.strictEqual(
      component.cpe,
      "cpe:2.3:a:golang:go:1.27.4:*:*:*:*:*:*:*",
    );
    assert.strictEqual(goToolchainRef("1.27.4"), "pkg:generic/go@1.27.4");
  });
});

describe("goStdlibComponent", () => {
  it("carries the ref trivy-produced stdlib components use", () => {
    assert.deepStrictEqual(goStdlibComponent("go1.27.2"), {
      "bom-ref": "pkg:golang/stdlib@v1.27.2",
      name: "stdlib",
      type: "library",
      version: "v1.27.2",
      group: "",
      cpe: "cpe:2.3:a:golang:go:1.27.2:*:*:*:*:*:*:*",
    });
  });

  it("names a release candidate in the CPE update field", () => {
    assert.strictEqual(
      goStdlibComponent("go1.28rc1").cpe,
      "cpe:2.3:a:golang:go:1.28:rc1:*:*:*:*:*:*",
    );
  });

  it("keeps the toolchain a boringcrypto build names", () => {
    assert.strictEqual(
      goStdlibComponent("go1.26.10 X:boringcrypto")["bom-ref"],
      "pkg:golang/stdlib@v1.26.10",
    );
  });
});

describe("classifyGoBinary", () => {
  it("names the launcher of a GOROOT", () => {
    assert.strictEqual(classifyGoBinary("go"), "go");
    assert.strictEqual(classifyGoBinary("/usr/local/go/bin/go"), "go");
    assert.strictEqual(classifyGoBinary("C:\\Go\\bin\\go.exe"), "go");
  });

  it("names the versioned download of golang.org/dl", () => {
    assert.strictEqual(classifyGoBinary("go1.21.0"), "sdk-go");
    assert.strictEqual(classifyGoBinary("go1.24.exe"), "sdk-go");
    assert.strictEqual(classifyGoBinary("google"), undefined);
    assert.strictEqual(classifyGoBinary(undefined), undefined);
  });
});

describe("goBinaryName", () => {
  it("names the platform's launcher", () => {
    assert.strictEqual(goBinaryName("linux"), "go");
    assert.strictEqual(goBinaryName("win32"), "go.exe");
    assert.strictEqual(goBinaryName(), "go");
  });
});

describe("readGoToolchainVersion", () => {
  it("reads the first line of a GOROOT's VERSION file", () => {
    const work = mkdtempSync(join(tmpdir(), "cdxgen-gotoolchain-"));
    try {
      const goRoot = join(work, "usr", "local", "go");
      mkdirSync(goRoot, { recursive: true });
      writeFileSync(join(goRoot, GO_VERSION_FILE_NAME), "go1.27.1\n");
      assert.deepStrictEqual(readGoToolchainVersion(goRoot, work), {
        version: "1.27.1",
        source: "version-file",
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("trims trailing separators of the GOROOT before naming VERSION", () => {
    const seen = [];
    const reader = (path) => {
      seen.push(path);
      return "go1.27.4\n";
    };
    assert.deepStrictEqual(
      readGoToolchainVersion("/usr/local/go//", "/", reader),
      {
        version: "1.27.4",
        source: "version-file",
      },
    );
    readGoToolchainVersion("C:\\go\\\\", "C:\\", reader);
    // A GOROOT taken from an image config can hold any number of slashes;
    // the trim must stay linear on it.
    const noisy = `/${"/".repeat(200000)}x`;
    readGoToolchainVersion(noisy, "/", reader);
    assert.deepStrictEqual(seen.slice(0, 2), [
      `/usr/local/go/${GO_VERSION_FILE_NAME}`,
      `C:\\go/${GO_VERSION_FILE_NAME}`,
    ]);
    assert.strictEqual(seen[2], `${noisy}/${GO_VERSION_FILE_NAME}`);
  });

  it("answers nothing for a GOROOT without a parsable VERSION file", () => {
    const work = mkdtempSync(join(tmpdir(), "cdxgen-gotoolchain-"));
    try {
      const goRoot = join(work, "go");
      mkdirSync(goRoot, { recursive: true });
      writeFileSync(join(goRoot, GO_VERSION_FILE_NAME), "not-a-version\n");
      assert.strictEqual(readGoToolchainVersion(goRoot, work), undefined);
      assert.strictEqual(
        readGoToolchainVersion(join(work, "absent"), work),
        undefined,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("answers nothing for a devel VERSION file", () => {
    const work = mkdtempSync(join(tmpdir(), "cdxgen-gotoolchain-"));
    try {
      const goRoot = join(work, "go");
      mkdirSync(goRoot, { recursive: true });
      writeFileSync(join(goRoot, GO_VERSION_FILE_NAME), "go1.28-9d1f2f0\n");
      assert.strictEqual(readGoToolchainVersion(goRoot, work), undefined);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("attachGoToolchain", () => {
  it("tags the launcher and links it to one toolchain per version", () => {
    const inventory = createGoToolchainInventory();
    const launcher = {
      "bom-ref": "file:usr/local/go/bin/go",
      type: "file",
      name: "go",
      properties: [],
    };
    attachGoToolchain(inventory, launcher, {
      version: "1.27.1",
      source: "version-file",
    });
    assert.deepStrictEqual(launcher.properties, [
      { name: "cdx:go:toolchainVersion", value: "1.27.1" },
      { name: "cdx:go:toolchainVersionSource", value: "version-file" },
    ]);
    assert.strictEqual(inventory.runtimeComponents.length, 1);
    assert.strictEqual(inventory.runtimeComponents[0].name, "go");
    assert.strictEqual(inventory.runtimeComponents[0].version, "1.27.1");
    assert.deepStrictEqual(inventory.dependencies, [
      { ref: "pkg:generic/go@1.27.1", dependsOn: [] },
      {
        ref: "file:usr/local/go/bin/go",
        dependsOn: ["pkg:generic/go@1.27.1"],
      },
    ]);
    assert.deepStrictEqual(
      goToolchainProperties({ version: "1.26.10", source: "version-file" }),
      [
        { name: "cdx:go:toolchainVersion", value: "1.26.10" },
        { name: "cdx:go:toolchainVersionSource", value: "version-file" },
      ],
    );
  });

  it("reuses the toolchain component of a version", () => {
    const inventory = createGoToolchainInventory();
    const first = {
      "bom-ref": "file:usr/local/go/bin/go",
      type: "file",
      name: "go",
      properties: [],
    };
    const second = {
      "bom-ref": "file:opt/homebrew/opt/go/libexec/bin/go",
      type: "file",
      name: "go",
      properties: [],
    };
    attachGoToolchain(inventory, first, {
      version: "1.27.1",
      source: "version-file",
    });
    attachGoToolchain(inventory, second, {
      version: "1.27.1",
      source: "version-file",
    });
    assert.strictEqual(inventory.runtimeComponents.length, 1);
    assert.strictEqual(inventory.dependencies.length, 3);
  });
});
