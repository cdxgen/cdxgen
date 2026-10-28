import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import { resetRunState } from "../core/runState.js";
import { buildGradleCommandArguments } from "../ecosystems/gradleutils.js";
import {
  bazelMirrorArgs,
  clojureMirrorArgs,
  clojureMirrorSdeps,
  coursierMirrorEnv,
  gradleMirrorInitScript,
  gradleMirrorInitScriptArgs,
  isMavenCentralMirrorEnabled,
  leiningenMirrorArgs,
  MAVEN_CENTRAL_MIRROR_URLS,
  mavenCentralFetchUrl,
  mavenCentralMirrorUrl,
  mavenMirrorSettingsArgs,
  mavenWrapperMirrorEnv,
  mergeMavenMirrorSettings,
  sbtMirrorEnv,
} from "./mavenCentralMirror.js";

const MIRROR = MAVEN_CENTRAL_MIRROR_URLS.google;
const ENV_NAMES = [
  "MAVEN_CENTRAL_MIRROR",
  "MAVEN_CENTRAL_URL",
  "MVN_ARGS",
  "MAVEN_ARGS",
  "SBT_OPTS",
  "COURSIER_REPOSITORIES",
];

function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  try {
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
    resetRunState();
    fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    resetRunState();
  }
}

describe("mavenCentralMirrorUrl()", () => {
  it("stays off unless the switch names a mirror", () => {
    withEnv({}, () => {
      assert.strictEqual(mavenCentralMirrorUrl(), undefined);
      assert.strictEqual(isMavenCentralMirrorEnabled(), false);
    });
    withEnv({ MAVEN_CENTRAL_MIRROR: "false" }, () => {
      assert.strictEqual(mavenCentralMirrorUrl(), undefined);
    });
    withEnv({ MAVEN_CENTRAL_MIRROR: "not-a-mirror" }, () => {
      assert.strictEqual(mavenCentralMirrorUrl(), undefined);
    });
    withEnv({ MAVEN_CENTRAL_MIRROR: "ftp://mirror.example/maven2/" }, () => {
      assert.strictEqual(mavenCentralMirrorUrl(), undefined);
    });
  });

  it("resolves the named Google buckets and custom URLs", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      assert.strictEqual(mavenCentralMirrorUrl(), MIRROR);
    });
    withEnv({ MAVEN_CENTRAL_MIRROR: "google" }, () => {
      assert.strictEqual(mavenCentralMirrorUrl(), MIRROR);
    });
    withEnv({ MAVEN_CENTRAL_MIRROR: "eu" }, () => {
      assert.strictEqual(mavenCentralMirrorUrl(), MAVEN_CENTRAL_MIRROR_URLS.eu);
    });
    withEnv({ MAVEN_CENTRAL_MIRROR: "asia" }, () => {
      assert.strictEqual(
        mavenCentralMirrorUrl(),
        MAVEN_CENTRAL_MIRROR_URLS.asia,
      );
    });
    withEnv(
      { MAVEN_CENTRAL_MIRROR: "https://nexus.example.com/repository/central" },
      () => {
        assert.strictEqual(
          mavenCentralMirrorUrl(),
          "https://nexus.example.com/repository/central/",
        );
      },
    );
  });
});

describe("mavenCentralFetchUrl()", () => {
  it("prefers an explicit MAVEN_CENTRAL_URL over the mirror", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      assert.strictEqual(mavenCentralFetchUrl(), MIRROR);
    });
    withEnv(
      {
        MAVEN_CENTRAL_MIRROR: "true",
        MAVEN_CENTRAL_URL: "https://nexus.corp/repository",
      },
      () => {
        assert.strictEqual(mavenCentralFetchUrl(), undefined);
      },
    );
  });
});

describe("mavenMirrorSettingsArgs()", () => {
  it("generates a global settings file that remaps central", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      const args = mavenMirrorSettingsArgs();
      assert.strictEqual(args.length, 2);
      assert.strictEqual(args[0], "-gs");
      assert.ok(existsSync(args[1]));
      const settings = readFileSync(args[1], "utf-8");
      assert.ok(settings.includes(`<url>${MIRROR}</url>`));
      assert.ok(settings.includes("<mirrorOf>central</mirrorOf>"));
    });
  });

  it("keeps the user's own settings out of the way", () => {
    withEnv(
      { MAVEN_CENTRAL_MIRROR: "true", MVN_ARGS: "-s /tmp/my-settings.xml" },
      () => {
        assert.deepStrictEqual(mavenMirrorSettingsArgs(), []);
      },
    );
    withEnv(
      {
        MAVEN_CENTRAL_MIRROR: "true",
        MAVEN_ARGS: "--global-settings=/x",
      },
      () => {
        assert.deepStrictEqual(mavenMirrorSettingsArgs(), []);
      },
    );
  });

  it("merges the mirror into a settings file the caller already passes", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      const projectSettings = join(
        tmpdir(),
        `cdxgen-mirror-test-settings-${process.pid}.xml`,
      );
      writeFileSync(
        projectSettings,
        "<settings><mirrors><mirror><id>corp</id><url>https://nexus.corp/repository</url><mirrorOf>external:*</mirrorOf></mirror></mirrors></settings>",
      );
      try {
        const args = mavenMirrorSettingsArgs(projectSettings);
        assert.strictEqual(args.length, 2);
        const settings = readFileSync(args[1], "utf-8");
        // The corporate mirror comes first and keeps winning for its targets.
        assert.ok(settings.indexOf("nexus.corp") < settings.indexOf(MIRROR));
        assert.ok(settings.includes("<mirrorOf>central</mirrorOf>"));
      } finally {
        rmSync(projectSettings, { force: true });
      }
    });
  });
});

describe("mergeMavenMirrorSettings()", () => {
  it("appends to an existing mirrors block", () => {
    const merged = mergeMavenMirrorSettings(
      "<settings><mirrors><mirror><id>a</id></mirror></mirrors></settings>",
      MIRROR,
    );
    assert.ok(merged.includes("<mirror><id>a</id></mirror>"));
    assert.ok(merged.includes(MIRROR));
    assert.ok(merged.indexOf("<mirror><id>a</id>") < merged.indexOf(MIRROR));
  });

  it("creates the mirrors block and rejects unusable content", () => {
    const mirror =
      "<mirror><id>cdxgen-maven-central-mirror</id><name>cdxgen Maven Central mirror</name>" +
      `<url>${MIRROR}</url><mirrorOf>central</mirrorOf></mirror>`;
    assert.strictEqual(
      mergeMavenMirrorSettings("<settings></settings>", MIRROR),
      `<settings><mirrors>${mirror}</mirrors></settings>`,
    );
    assert.strictEqual(
      mergeMavenMirrorSettings("<settings><mirrors/></settings>", MIRROR),
      `<settings><mirrors>${mirror}</mirrors></settings>`,
    );
    assert.strictEqual(
      mergeMavenMirrorSettings("not xml at all", MIRROR),
      undefined,
    );
  });
});

describe("mavenWrapperMirrorEnv()", () => {
  it("hands the mirror base to the Maven wrapper", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      assert.deepStrictEqual(mavenWrapperMirrorEnv(), {
        MVNW_REPOURL: MIRROR.replace(/\/$/, ""),
      });
    });
    withEnv({}, () => {
      assert.deepStrictEqual(mavenWrapperMirrorEnv(), {});
    });
  });
});

describe("gradle mirror init script", () => {
  it("rewrites only the Maven Central URLs", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      const args = gradleMirrorInitScriptArgs();
      assert.strictEqual(args[0], "--init-script");
      assert.ok(existsSync(args[1]));
      const script = readFileSync(args[1], "utf-8");
      assert.ok(script.includes(MIRROR));
      assert.ok(script.includes("repo1.maven.org"));
      assert.ok(script.includes("repo.maven.apache.org"));
      assert.ok(script.includes("settingsEvaluated"));
      assert.ok(script.includes("beforeProject"));
      // Gradle settings have no `repositories` property, and reading it fails
      // the whole build before any dependency resolves.
      assert.ok(!script.includes("settings.repositories"));
      assert.ok(script.includes("dependencyResolutionManagement"));
    });
    withEnv({}, () => {
      assert.deepStrictEqual(gradleMirrorInitScriptArgs(), []);
    });
  });

  it("joins the generated init script to every Gradle invocation", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      const args = buildGradleCommandArguments(
        [],
        [":app:dependencies"],
        [],
        10,
      );
      assert.strictEqual(args.length, 1);
      assert.ok(args[0].includes("--init-script"));
      assert.ok(
        args[0].indexOf("--no-parallel") < args[0].indexOf("--init-script"),
      );
    });
    withEnv({}, () => {
      const args = buildGradleCommandArguments(
        [],
        [":app:dependencies"],
        [],
        10,
      );
      assert.ok(!args[0].includes("--init-script"));
    });
  });

  it("names the central URLs the script swaps", () => {
    const script = gradleMirrorInitScript(MIRROR);
    assert.ok(script.includes('"https://repo.maven.apache.org/maven2/"'));
    assert.ok(script.includes('"https://repo1.maven.org/maven2/"'));
  });
});

// The machine may configure its own sbt repositories, which must win, so the
// sbt injection is asserted against a module that sees none of them.
const fsModule = await import("../core/fs.js");
const sbtInjectable = await esmock("./mavenCentralMirror.js", {
  "../core/fs.js": {
    ...fsModule,
    safeExistsSync: (path) =>
      `${path}`.endsWith("sbt/repositories")
        ? false
        : fsModule.safeExistsSync(path),
  },
});

describe("sbtMirrorEnv()", () => {
  it("points sbt at a generated repositories file", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      const env = sbtInjectable.sbtMirrorEnv();
      assert.ok(env.SBT_OPTS);
      const configMatch = /-Dsbt\.repository\.config=(\S+)/.exec(env.SBT_OPTS);
      assert.ok(configMatch);
      assert.ok(env.SBT_OPTS.includes("-Dsbt.override.build.repos=true"));
      const content = readFileSync(configMatch[1], "utf-8");
      assert.ok(content.includes(`maven-central: ${MIRROR}`));
      assert.ok(
        content.includes("sbt-plugin-releases: https://repo.scala-sbt.org"),
      );
      assert.ok(content.includes("local"));
    });
    withEnv({}, () => {
      assert.deepStrictEqual(sbtMirrorEnv(), {});
    });
  });

  it("keeps an sbt configuration the user already made", () => {
    withEnv(
      {
        MAVEN_CENTRAL_MIRROR: "true",
        SBT_OPTS: "-Dsbt.repository.config=/home/me/repos",
      },
      () => {
        assert.deepStrictEqual(sbtMirrorEnv(), {});
      },
    );
    withEnv({ MAVEN_CENTRAL_MIRROR: "true", SBT_OPTS: "-Xmx2g" }, () => {
      const env = sbtInjectable.sbtMirrorEnv();
      assert.ok(env.SBT_OPTS.startsWith("-Xmx2g "));
      assert.ok(env.SBT_OPTS.includes("sbt.repository.config"));
    });
  });
});

describe("coursier, bazel and the Clojure tools", () => {
  it("sends the Coursier family to the mirror", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      assert.deepStrictEqual(coursierMirrorEnv(), {
        COURSIER_REPOSITORIES: `ivy2local|${MIRROR}`,
      });
      assert.deepStrictEqual(bazelMirrorArgs(), [
        `--repo_env=COURSIER_REPOSITORIES=ivy2local|${MIRROR}`,
      ]);
    });
    withEnv({}, () => {
      assert.deepStrictEqual(coursierMirrorEnv(), {});
      assert.deepStrictEqual(bazelMirrorArgs(), []);
    });
    withEnv(
      {
        MAVEN_CENTRAL_MIRROR: "true",
        COURSIER_REPOSITORIES: "ivy2local|central",
      },
      () => {
        assert.deepStrictEqual(coursierMirrorEnv(), {});
        assert.deepStrictEqual(bazelMirrorArgs(), []);
      },
    );
  });

  it("adds -Sdeps data that repoints central only", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      assert.deepStrictEqual(clojureMirrorArgs(["-Stree"]), [
        "-Stree",
        "-Sdeps",
        clojureMirrorSdeps(MIRROR),
      ]);
      assert.strictEqual(
        clojureMirrorSdeps(MIRROR),
        `{:mvn/repos {"central" {:url "${MIRROR}"}}}`,
      );
      // The user's own -Sdeps data must survive untouched.
      assert.deepStrictEqual(clojureMirrorArgs(["-Sdeps", "{:deps {}}"]), [
        "-Sdeps",
        "{:deps {}}",
      ]);
    });
    withEnv({}, () => {
      assert.deepStrictEqual(clojureMirrorArgs(["-Stree"]), ["-Stree"]);
    });
  });

  it("prepends a lein update-in transformation", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      assert.deepStrictEqual(
        leiningenMirrorArgs(["deps", ":tree-data"], undefined),
        [
          "update-in",
          ":mirrors",
          "assoc",
          '"central"',
          `{:url "${MIRROR}"}`,
          "--",
          "deps",
          ":tree-data",
        ],
      );
      // A project with its own mirrors keeps them.
      assert.deepStrictEqual(
        leiningenMirrorArgs(
          ["deps", ":tree-data"],
          '(defproject a "1" :mirrors {"central" {:url "https://nexus.corp"}})',
        ),
        ["deps", ":tree-data"],
      );
    });
    withEnv({}, () => {
      assert.deepStrictEqual(
        leiningenMirrorArgs(["deps", ":tree-data"], undefined),
        ["deps", ":tree-data"],
      );
    });
  });
});

describe("mirror artifacts", () => {
  it("are removed when the run resets", () => {
    withEnv({ MAVEN_CENTRAL_MIRROR: "true" }, () => {
      // The esmock'd instances of this module shadow its run-reset
      // registration, so the cleanup is asserted on the artifact of the
      // instance whose registration is the live one.
      const env = sbtInjectable.sbtMirrorEnv();
      const configMatch = /-Dsbt\.repository\.config=(\S+)/.exec(env.SBT_OPTS);
      assert.ok(configMatch);
      assert.ok(existsSync(configMatch[1]));
      resetRunState();
      assert.strictEqual(existsSync(configMatch[1]), false);
    });
  });
});

describe("secure mode keeps its behaviour", () => {
  it("injects nothing for any tool", async () => {
    const secure = await esmock("./mavenCentralMirror.js", {
      "../core/activity.js": {
        isSecureMode: true,
        readEnvironmentVariable: (name) => process.env[name],
      },
    });
    process.env.MAVEN_CENTRAL_MIRROR = "true";
    try {
      assert.strictEqual(secure.mavenCentralMirrorUrl(), MIRROR);
      assert.strictEqual(secure.mavenCentralFetchUrl(), MIRROR);
      assert.deepStrictEqual(secure.mavenMirrorSettingsArgs(), []);
      assert.deepStrictEqual(secure.gradleMirrorInitScriptArgs(), []);
      assert.deepStrictEqual(secure.sbtMirrorEnv(), {});
      assert.deepStrictEqual(secure.coursierMirrorEnv(), {});
      assert.deepStrictEqual(secure.bazelMirrorArgs(), []);
      assert.deepStrictEqual(secure.clojureMirrorArgs(["-Stree"]), ["-Stree"]);
      assert.deepStrictEqual(
        secure.leiningenMirrorArgs(["deps", ":tree-data"], undefined),
        ["deps", ":tree-data"],
      );
    } finally {
      delete process.env.MAVEN_CENTRAL_MIRROR;
    }
  });
});
