import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";
import sinon from "sinon";

import {
  _resetOsInfoCache,
  collectNativeExtensions,
  markOsInstalledLanguagePackages,
  resolvePackageForFile,
} from "./osPackageResolver.js";

describe("osPackageResolver", () => {
  it("resolves undefined for empty path", () => {
    _resetOsInfoCache();
    const result = resolvePackageForFile("");
    assert.strictEqual(result, undefined);
  });

  it("returns undefined for null/undefined filePath", () => {
    _resetOsInfoCache();
    assert.strictEqual(resolvePackageForFile(null), undefined);
    assert.strictEqual(resolvePackageForFile(undefined), undefined);
  });

  it("returns undefined for a path that is not owned by any package", () => {
    _resetOsInfoCache();
    // A path that definitely does not exist
    const result = resolvePackageForFile(
      "/tmp/cdxgen-test-nonexistent-file-xyz123.so",
    );
    assert.ok(
      result === undefined,
      "should return undefined for unknown paths",
    );
  });

  it("caches repeated calls to avoid duplicate subprocess invocations", () => {
    _resetOsInfoCache();
    const path = "/tmp/cdxgen-test-cache-check.so";
    const first = resolvePackageForFile(path);
    const second = resolvePackageForFile(path);
    assert.deepStrictEqual(
      first,
      second,
      "cached result should equal first lookup",
    );
  });
});

// What getDistroInfo() reads from the os-release of the hosts the real-system
// runs used.
const UBUNTU_2404 = {
  purlType: "deb",
  namespace: "ubuntu",
  distroId: "ubuntu-24.04",
  distroName: "noble",
};
const ALMALINUX_98 = {
  purlType: "rpm",
  namespace: "almalinux",
  distroId: "almalinux-9.8",
  distroName: "",
};
const ALPINE_324 = {
  purlType: "apk",
  namespace: "alpine",
  distroId: "alpine-3.24.3",
  distroName: "alpine-3.24",
};

// resolvePackageForFile reads process.platform and process.arch when it is
// called, so each case runs with the pair it is about and puts the real ones
// back.
async function resolveWith({ platform, arch, distro, spawn }, filePath) {
  const { default: esmock } = await import("esmock");
  const { _resetOsInfoCache, resolvePackageForFile } = await esmock(
    "./osPackageResolver.js",
    { "../core/fs.js": { safeSpawnSync: spawn } },
    { "./osinfo.js": { getDistroInfo: () => distro } },
  );
  _resetOsInfoCache();
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: platform });
  Object.defineProperty(process, "arch", { value: arch });
  try {
    return resolvePackageForFile(filePath);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", archDescriptor);
  }
}

const answer = (table) =>
  sinon.stub().callsFake((command, args) => {
    const key = `${command} ${args.join(" ")}`;
    for (const [prefix, reply] of Object.entries(table)) {
      if (key.startsWith(prefix)) {
        return { status: 0, stdout: reply, stderr: "" };
      }
    }
    return { status: 1, stdout: "", stderr: "" };
  });

describe("resolvePackageForFile() gives a file the identity of its package", () => {
  it("names a Homebrew formula pkg:brew, not pkg:generic", async () => {
    const info = await resolveWith(
      { platform: "darwin", arch: "arm64", spawn: answer({}) },
      "/opt/homebrew/Cellar/php/8.5.11_1/bin/php",
    );
    assert.strictEqual(info.type, "brew");
    assert.strictEqual(info.name, "php");
    assert.strictEqual(info.version, "8.5.11_1");
    assert.strictEqual(info.purl, "pkg:brew/php@8.5.11_1");
  });

  it("gives the file the purl of the package the OBOM names, with no architecture", async () => {
    // homebrew_packages gives pkg:brew/php@8.5.11_1; a file of that package
    // must say the same, whatever the CPU.
    for (const arch of ["arm64", "x64"]) {
      const info = await resolveWith(
        { platform: "darwin", arch, spawn: answer({}) },
        "/opt/homebrew/Cellar/php/8.5.11_1/sbin/php-fpm",
      );
      assert.strictEqual(info.purl, "pkg:brew/php@8.5.11_1", arch);
    }
  });

  it("encodes a versioned formula name", async () => {
    const info = await resolveWith(
      { platform: "darwin", arch: "arm64", spawn: answer({}) },
      "/opt/homebrew/Cellar/php@8.4/8.4.26_1/bin/php",
    );
    assert.strictEqual(info.purl, "pkg:brew/php%408.4@8.4.26_1");
  });

  it("names a deb the way the container scan does", async () => {
    const spawn = answer({
      "dpkg-query -S": "libc6:amd64: /lib/x86_64-linux-gnu/libc.so.6\n",
      "dpkg-query -W": "2.39-0ubuntu8.9 amd64",
    });
    const info = await resolveWith(
      { platform: "linux", arch: "x64", distro: UBUNTU_2404, spawn },
      "/lib/x86_64-linux-gnu/libc.so.6",
    );
    assert.strictEqual(
      info.purl,
      "pkg:deb/ubuntu/libc6@2.39-0ubuntu8.9?arch=amd64&distro=ubuntu-24.04&distro_name=noble",
    );
  });

  it("gives a deb with an epoch the epoch qualifier", async () => {
    const spawn = answer({
      "dpkg-query -S": "bsdutils: /usr/bin/logger\n",
      "dpkg-query -W": "1:2.39.3-9ubuntu6.6 amd64",
    });
    const info = await resolveWith(
      { platform: "linux", arch: "x64", distro: UBUNTU_2404, spawn },
      "/usr/bin/logger",
    );
    assert.strictEqual(
      info.purl,
      "pkg:deb/ubuntu/bsdutils@1:2.39.3-9ubuntu6.6?arch=amd64&distro=ubuntu-24.04&distro_name=noble&epoch=1",
    );
  });

  it("asks rpm for the epoch and gives an rpm the release and the epoch", async () => {
    const spawn = answer({
      "rpm -qf": "openssl-libs 1 3.5.8-1.el9_8 x86_64\n",
    });
    const info = await resolveWith(
      { platform: "linux", arch: "x64", distro: ALMALINUX_98, spawn },
      "/usr/lib64/libssl.so.3",
    );
    assert.strictEqual(
      info.purl,
      "pkg:rpm/almalinux/openssl-libs@1:3.5.8-1.el9_8?arch=x86_64&distro=almalinux-9.8&epoch=1",
    );
    // The query carries %{EPOCH}, written so that a package with none gives 0.
    const query = spawn.getCalls().find((call) => call.args[0] === "rpm")
      .args[1];
    assert.ok(query.join(" ").includes("%{EPOCH}"), query.join(" "));
  });

  it("gives an rpm without an epoch no epoch", async () => {
    const spawn = answer({ "rpm -qf": "acl 0 2.4.0-1.el9_8 x86_64\n" });
    const info = await resolveWith(
      { platform: "linux", arch: "x64", distro: ALMALINUX_98, spawn },
      "/usr/bin/getfacl",
    );
    assert.strictEqual(
      info.purl,
      "pkg:rpm/almalinux/acl@2.4.0-1.el9_8?arch=x86_64&distro=almalinux-9.8",
    );
  });

  it("names an apk package with the distro and release series of the container scan", async () => {
    const spawn = answer({
      "apk info -W": "/lib/ld-musl-x86_64.so.1 is owned by musl-1.2.6-r3\n",
    });
    const info = await resolveWith(
      { platform: "linux", arch: "x64", distro: ALPINE_324, spawn },
      "/lib/ld-musl-x86_64.so.1",
    );
    assert.strictEqual(
      info.purl,
      "pkg:apk/alpine/musl@1.2.6-r3?arch=x86_64&distro=alpine-3.24.3&distro_name=alpine-3.24",
    );
  });

  it("gives an apk package of an ARM host apk's name for the architecture", async () => {
    const spawn = answer({
      "apk info -W": "/lib/ld-musl-aarch64.so.1 is owned by musl-1.2.6-r3\n",
    });
    const info = await resolveWith(
      { platform: "linux", arch: "arm64", distro: ALPINE_324, spawn },
      "/lib/ld-musl-aarch64.so.1",
    );
    assert.ok(info.purl.includes("arch=aarch64"), info.purl);
    assert.ok(!info.purl.includes("arch=arm64"), info.purl);
  });
});

describe("collectNativeExtensions()", () => {
  it("lists language-installed native modules that nothing else collected", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-nativeext-"));
    const put = (file) => {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "x");
    };
    try {
      for (const file of [
        "usr/local/lib/python3.12/site-packages/_brotli.cpython-312-x86_64-linux-gnu.so",
        "usr/lib/python3/dist-packages/_brotli.cpython-311-x86_64-linux-gnu.so",
        "usr/local/lib/php/extensions/no-debug-non-zts-20230831/brotli.so",
        "usr/local/bundle/gems/brotli-0.8.0/lib/brotli/brotli.so",
        "usr/local/bundle/extensions/x86_64-linux/3.3.0/brotli-0.8.0/brotli/brotli.so",
        "app/node_modules/iltorb/build/Release/iltorb.node",
        "usr/share/dotnet/shared/Microsoft.NETCore.App/8.0.32/libSystem.IO.Compression.Native.so",
        "usr/local/lib/python3.12/site-packages/brotli.py",
        "proc/self/maps.so",
        // A Windows image's extensions.
        "Files/Python312/Lib/site-packages/_brotli.cp312-win_amd64.pyd",
        "Files/php/ext/php_brotli.dll",
        "Files/Program Files/dotnet/shared/Microsoft.NETCore.App/8.0.32/System.IO.Compression.Native.dll",
        "Files/Program Files/dotnet/shared/Microsoft.NETCore.App/8.0.32/System.Text.Json.dll",
      ]) {
        put(file);
      }
      assert.deepStrictEqual(
        collectNativeExtensions(root, [
          "/usr/lib/python3/dist-packages/_brotli.cpython-311-x86_64-linux-gnu.so",
        ]),
        [
          "Files/Program Files/dotnet/shared/Microsoft.NETCore.App/8.0.32/System.IO.Compression.Native.dll",
          "Files/Python312/Lib/site-packages/_brotli.cp312-win_amd64.pyd",
          "Files/php/ext/php_brotli.dll",
          "app/node_modules/iltorb/build/Release/iltorb.node",
          "usr/local/bundle/extensions/x86_64-linux/3.3.0/brotli-0.8.0/brotli/brotli.so",
          "usr/local/bundle/gems/brotli-0.8.0/lib/brotli/brotli.so",
          "usr/local/lib/php/extensions/no-debug-non-zts-20230831/brotli.so",
          "usr/local/lib/python3.12/site-packages/_brotli.cpython-312-x86_64-linux-gnu.so",
          "usr/share/dotnet/shared/Microsoft.NETCore.App/8.0.32/libSystem.IO.Compression.Native.so",
        ],
      );
      assert.deepStrictEqual(collectNativeExtensions(undefined), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("markOsInstalledLanguagePackages()", () => {
  it("names the OS package that installed a language package", () => {
    const owner =
      "pkg:apk/alpine/py3-brotli@1.1.0-r2?arch=aarch64&distro=alpine-3.20.10";
    const owners = new Map([
      [
        "usr/lib/python3.12/site-packages/Brotli-1.1.0.dist-info/METADATA",
        owner,
      ],
    ]);
    const components = [
      {
        purl: "pkg:pypi/brotli@1.1.0",
        properties: [
          {
            name: "internal:SrcFile",
            value:
              "/tmp/all-layers/usr/lib/python3.12/site-packages/Brotli-1.1.0.dist-info/METADATA",
          },
        ],
      },
      {
        purl: "pkg:pypi/brotli@1.2.0",
        properties: [
          {
            name: "internal:SrcFile",
            value:
              "/usr/local/lib/python3.12/site-packages/brotli-1.2.0.dist-info/METADATA",
          },
        ],
      },
      {
        purl: "pkg:apk/alpine/py3-brotli@1.1.0-r2",
        properties: [
          {
            name: "internal:SrcFile",
            value:
              "/usr/lib/python3.12/site-packages/Brotli-1.1.0.dist-info/METADATA",
          },
        ],
      },
    ];
    assert.strictEqual(
      markOsInstalledLanguagePackages(components, owners, "/tmp/all-layers"),
      1,
    );
    assert.deepStrictEqual(components[0].properties.at(-1), {
      name: "cdx:os:installedBy",
      value: owner,
    });
    assert.ok(
      !components[1].properties.some((p) => p.name === "cdx:os:installedBy"),
      "a pip-installed package is left alone",
    );
    assert.ok(
      !components[2].properties.some((p) => p.name === "cdx:os:installedBy"),
      "an OS package is not marked as installed by itself",
    );
    assert.strictEqual(
      markOsInstalledLanguagePackages(components, owners, "/tmp/all-layers"),
      0,
      "marking twice adds nothing",
    );
    assert.strictEqual(
      markOsInstalledLanguagePackages(components, new Map()),
      0,
    );
  });
});
