import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";

import { assert, describe, it } from "poku";

import {
  annotateJavaProcessOptions,
  linkJdkProcessRows,
  probeHostJdk,
  processDirectory,
} from "./jdkHostProbe.js";

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-jdk-host-"));
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

// A JDK home is a release file next to bin/java: what sdkman, a tarball or an
// installer leaves on disk.
function jdk(root, home, version, implementor, launcher = "java") {
  put(
    root,
    `${home}/release`,
    `JAVA_VERSION="${version}"\nJAVA_RUNTIME_VERSION="${version}+9-LTS"\nIMPLEMENTOR="${implementor}"\nOS_ARCH="aarch64"\n`,
  );
  put(root, `${home}/bin/${launcher}`, "#!/bin/sh\n", 0o755);
}

const platformVersions = (components) =>
  components
    .filter((component) => component.type === "platform")
    .map((component) => component.version)
    .sort();

describe("probeHostJdk()", () => {
  it("identifies sdkman, tarball and macOS installer JDKs and leaves a package-owned one", () =>
    withRoot((root) => {
      jdk(
        root,
        "Users/dev/.sdkman/candidates/java/21.0.7-tem",
        "21.0.7",
        "Eclipse Adoptium",
      );
      jdk(
        root,
        "Users/dev/.sdkman/candidates/java/23.0.2-graalce",
        "23.0.2",
        "GraalVM Community",
      );
      jdk(
        root,
        "Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home",
        "17.0.16",
        "Eclipse Adoptium",
      );
      jdk(root, "opt/jdk-11", "11.0.32", "Eclipse Adoptium");
      jdk(
        root,
        "opt/homebrew/Cellar/openjdk/25.0.2/libexec/openjdk.jdk/Contents/Home",
        "25.0.2",
        "Homebrew",
      );
      const { components } = probeHostJdk({
        rootPath: root,
        platform: "darwin",
      });
      assert.deepStrictEqual(platformVersions(components), [
        "11.0.32",
        "17.0.16",
        "21.0.7",
        "23.0.2",
      ]);
      const sdkman = components.find((c) => c.version === "21.0.7");
      // The home is the JDK's directory, not its launcher
      assert.deepStrictEqual(
        sdkman.properties
          .filter((p) => p.name === "cdx:java:home")
          .map((p) => p.value),
        ["/Users/dev/.sdkman/candidates/java/21.0.7-tem"],
      );
      assert.strictEqual(sdkman.purl, "pkg:generic/temurin-jdk@21.0.7%2B9");
      assert.strictEqual(components.filter((c) => c.type === "file").length, 4);
    }));

  it("emits nothing for a JDK dpkg owns, and keeps the unpackaged one", () =>
    withRoot((root) => {
      jdk(root, "usr/lib/jvm/java-17-openjdk-amd64", "17.0.14", "Debian");
      jdk(root, "opt/java/openjdk", "21.0.5", "Eclipse Adoptium");
      put(
        root,
        "var/lib/dpkg/info/openjdk-17-jre.list",
        "/.\n/usr/lib/jvm/java-17-openjdk-amd64/bin/java\n",
      );
      const { components } = probeHostJdk({
        rootPath: root,
        platform: "linux",
      });
      assert.deepStrictEqual(platformVersions(components), ["21.0.5"]);
    }));

  it("never runs the launcher it reads", () =>
    withRoot((root) => {
      const sentinel = join(root, "ran");
      put(root, "opt/jdk-21/release", 'JAVA_VERSION="21.0.5"\n');
      put(root, "opt/jdk-21/bin/java", `#!/bin/sh\ntouch ${sentinel}\n`, 0o755);
      probeHostJdk({ rootPath: root, platform: "linux" });
      assert.strictEqual(existsSync(sentinel), false);
    }));

  it("answers nothing for a directory without a release file or Java version", () =>
    withRoot((root) => {
      put(root, "opt/jdk-x/bin/java", "#!/bin/sh\n", 0o755);
      jdk(root, "opt/jdk-y", "$(id)", "x");
      assert.deepStrictEqual(
        probeHostJdk({ rootPath: root, platform: "linux" }),
        {
          components: [],
          dependencies: [],
        },
      );
    }));
});

describe("probeHostJdk() with running processes", () => {
  const processRow = (path, category = "processes") => ({
    name: "java",
    type: "application",
    properties: [
      { name: "cdx:osquery:category", value: category },
      { name: "path", value: path },
    ],
  });

  it("finds a JDK an application bundles under a home from the path of its process", () =>
    withRoot((root) => {
      const home =
        "home/appthreat/nexus/nexus-3.89.0-09/jdk/temurin_21.0.9_10_linux_x86_64";
      jdk(root, home, "21.0.9", "Eclipse Adoptium");
      const path = `/${home}/bin/java`;
      assert.deepStrictEqual(
        probeHostJdk({ rootPath: root, platform: "linux" }).components,
        [],
      );
      const { components } = probeHostJdk({
        rootPath: root,
        platform: "linux",
        packageComponents: [processRow(path, "listening_ports")],
      });
      assert.deepStrictEqual(platformVersions(components), ["21.0.9"]);
      assert.deepStrictEqual(
        components
          .find((c) => c.type === "platform")
          .properties.filter((p) => p.name === "cdx:java:home")
          .map((p) => p.value),
        [`/${home}`],
      );
    }));

  it("does not follow a link below a home to reach a process's JDK", () =>
    withRoot((root) => {
      jdk(root, "srv/real-jdk", "21.0.9", "Eclipse Adoptium");
      mkdirSync(join(root, "home/dev"), { recursive: true });
      symlinkSync(join(root, "srv/real-jdk"), join(root, "home/dev/bundled"));
      const { components } = probeHostJdk({
        rootPath: root,
        platform: "linux",
        packageComponents: [processRow("/home/dev/bundled/bin/java")],
      });
      assert.deepStrictEqual(components, []);
    }));

  it("reads no home directory on Windows, even from a process path", () =>
    withRoot((root) => {
      jdk(root, "Users/dev/tool/jdk", "21.0.9", "Eclipse Adoptium", "java.exe");
      const { components } = probeHostJdk({
        rootPath: root,
        platform: "win32",
        env: {},
        packageComponents: [
          processRow("C:\\Users\\dev\\tool\\jdk\\bin\\java.exe"),
        ],
      });
      assert.deepStrictEqual(components, []);
    }));
});

describe("probeHostJdk() on Windows", () => {
  it("looks in the vendor folders of Program Files and reads no home", () =>
    withRoot((root) => {
      jdk(
        root,
        "Program Files/Eclipse Adoptium/jdk-25.0.4.1-hotspot",
        "25.0.4.1",
        "Eclipse Adoptium",
        "java.exe",
      );
      jdk(
        root,
        "Program Files/Java/jdk-21",
        "21.0.5",
        "Oracle Corporation",
        "java.exe",
      );
      jdk(
        root,
        "Users/dev/.jdks/temurin-17",
        "17.0.16",
        "Eclipse Adoptium",
        "java.exe",
      );
      const { components } = probeHostJdk({
        rootPath: root,
        platform: "win32",
        env: {},
      });
      assert.deepStrictEqual(platformVersions(components), [
        "21.0.5",
        "25.0.4.1",
      ]);
    }));
});

describe("linkJdkProcessRows()", () => {
  const jdkComponent = {
    type: "platform",
    name: "java",
    version: "26.0.2",
    "bom-ref": "pkg:generic/temurin-jdk@26.0.2%2B10",
    properties: [
      { name: "cdx:java:vendor", value: "Eclipse Temurin" },
      {
        name: "cdx:java:home",
        value: "/Users/dev/.sdkman/candidates/java/26.0.2-tem",
      },
    ],
  };
  const row = (path, version = "0") => ({
    name: "java",
    version,
    purl: `pkg:swid/java@${version}?tag_id=java#${path.slice(1)}`,
    "bom-ref": `pkg:swid/java@${version}?tag_id=java#${path.slice(1)}`,
    properties: [
      { name: "cdx:osquery:category", value: "listening_ports" },
      { name: "path", value: path },
    ],
  });
  it("gives a version-0 row the version of the JDK at its path", () => {
    const linked = row(
      "/Users/dev/.sdkman/candidates/java/26.0.2-tem/bin/java",
    );
    const other = row("/opt/else/bin/java");
    const known = row(
      "/Users/dev/.sdkman/candidates/java/26.0.2-tem/bin/java",
      "5",
    );
    assert.strictEqual(
      linkJdkProcessRows([linked, other, known], [jdkComponent]),
      2,
    );
    assert.strictEqual(linked.version, "26.0.2");
    assert.ok(linked.purl.startsWith("pkg:swid/java@26.0.2?"));
    assert.strictEqual(linked["bom-ref"], linked.purl);
    assert.strictEqual(other.version, "0");
    // A port-numbered row keeps its version and still names its JDK
    assert.strictEqual(known.version, "5");
    assert.ok(
      known.properties.some(
        (p) => p.name === "cdx:java:version" && p.value === "26.0.2",
      ),
    );
    assert.ok(!other.properties.some((p) => p.name === "cdx:java:version"));
  });
});

describe("linkJdkProcessRows() across homes and on Windows", () => {
  const jdkComponent = (...homes) => ({
    type: "platform",
    name: "java",
    version: "21.0.9",
    "bom-ref": "pkg:generic/temurin-jdk@21.0.9%2B10",
    properties: [
      { name: "cdx:java:vendor", value: "Eclipse Temurin" },
      { name: "cdx:java:base64IntrinsicExposure", value: "exposed" },
      ...homes.map((home) => ({ name: "cdx:java:home", value: home })),
    ],
  });
  const row = (path, cmdline) => ({
    name: "java",
    version: "0",
    properties: [
      { name: "cdx:osquery:category", value: "processes" },
      { name: "path", value: path },
      { name: "cmdline", value: cmdline },
    ],
  });
  const exposure = (jdk) =>
    jdk.properties.find((p) => p.name === "cdx:java:base64IntrinsicExposure")
      .value;
  const SAFE = "java -XX:-UseBASE64Intrinsics -jar a.jar";

  it("is mitigated only when every home has a process and every process mitigates", () => {
    const run = (rows) => {
      const jdk = jdkComponent("/opt/a", "/opt/b");
      const list = rows.map(([path, cmd]) => row(path, cmd));
      annotateJavaProcessOptions(list);
      linkJdkProcessRows(list, [jdk]);
      return exposure(jdk);
    };
    assert.strictEqual(
      run([
        ["/opt/a/bin/java", SAFE],
        ["/opt/b/bin/java", "java -jar b.jar"],
      ]),
      "exposed",
    );
    assert.strictEqual(run([["/opt/a/bin/java", SAFE]]), "exposed");
    assert.strictEqual(
      run([
        ["/opt/a/bin/java", SAFE],
        ["/opt/b/bin/java", SAFE],
      ]),
      "mitigated",
    );
  });

  it("links a Windows process row to a home written with backslashes", () => {
    const jdk = jdkComponent(
      "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.9-hotspot",
    );
    const list = [
      row(
        "c:\\program files\\eclipse adoptium\\jdk-21.0.9-hotspot\\bin\\java.exe",
        "java.exe -XX:UseAVX=2 -jar a.jar",
      ),
    ];
    annotateJavaProcessOptions(list);
    assert.strictEqual(linkJdkProcessRows(list, [jdk]), 1);
    assert.strictEqual(list[0].version, "21.0.9");
    assert.strictEqual(exposure(jdk), "mitigated");
  });
});

describe("processDirectory()", () => {
  it("does not join the live Windows root to a path that names its drive", () => {
    const context = {
      platform: "win32",
      pathApi: win32,
      rootPath: "C:\\",
      logicalRoot: "C:\\",
    };
    assert.strictEqual(
      processDirectory(context, "C:\\Program Files\\Java\\jdk\\bin\\java.exe"),
      "C:\\Program Files\\Java\\jdk\\bin",
    );
  });
  it("puts a Windows path under another root without its drive", () => {
    const context = {
      platform: "win32",
      pathApi: win32,
      rootPath: join(tmpdir(), "root"),
      logicalRoot: "C:\\",
    };
    assert.strictEqual(
      processDirectory(context, "D:\\tools\\jdk\\bin\\java.exe"),
      join(tmpdir(), "root", "tools", "jdk", "bin"),
    );
  });
});

describe("probeHostJdk() in writable directories", () => {
  it("does not let a planted release link read a file outside the JDK's parent", () =>
    withRoot((root) => {
      put(
        root,
        "secret/release",
        'JAVA_VERSION="99.0.1"\nIMPLEMENTOR="Planted"\n',
      );
      put(root, "tmp/app/jdk/bin/java", "#!/bin/sh\n", 0o755);
      symlinkSync(
        join(root, "secret", "release"),
        join(root, "tmp", "app", "jdk", "release"),
      );
      const { components } = probeHostJdk({
        rootPath: root,
        platform: "linux",
        packageComponents: [
          {
            name: "java",
            properties: [
              { name: "cdx:osquery:category", value: "processes" },
              { name: "path", value: "/tmp/app/jdk/bin/java" },
            ],
          },
        ],
      });
      assert.deepStrictEqual(components, []);
    }));
});
