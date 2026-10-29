import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import {
  getLedgerEvents,
  LEDGER_EVENT_IMPACTS,
  LEDGER_EVENT_KINDS,
} from "../../core/buildLedger.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "test",
  "data",
  "jvm-tools",
);

const cannedSdkLists = {
  maven: readFileSync(join(fixturesDir, "sdk-list-maven.txt"), {
    encoding: "utf-8",
  }),
  gradle: readFileSync(join(fixturesDir, "sdk-list-gradle.txt"), {
    encoding: "utf-8",
  }),
  sbt: readFileSync(join(fixturesDir, "sdk-list-sbt.txt"), {
    encoding: "utf-8",
  }),
};

/** Java type aliases mapped the way installSdkmanTool resolves them. */
const TEST_JAVA_ALIASES = {
  java8: "8.0.504-zulu",
  java11: "11.0.32-tem",
  java17: "17.0.20-tem",
  java21: "21.0.12-tem",
};

const managedEnvVars = [
  "CDXGEN_JVM_TOOL_PINNED",
  "MVN_CMD",
  "GRADLE_CMD",
  "SBT_CMD",
  "MAVEN_HOME",
  "GRADLE_HOME",
  "SBT_HOME",
  "MAVEN_TOOL",
  "GRADLE_TOOL",
  "SBT_TOOL",
  "SCALA_TOOL",
  "MAVEN_VERSION",
  "GRADLE_VERSION",
  "SBT_VERSION",
  "SCALA_VERSION",
  "SDKMAN_CANDIDATES_DIR",
];

const savedEnv = {};

function cleanManagedEnv() {
  for (const envVar of managedEnvVars) {
    if (!(envVar in savedEnv)) {
      savedEnv[envVar] = process.env[envVar];
    }
    delete process.env[envVar];
  }
}

function restoreManagedEnv() {
  for (const [envVar, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[envVar];
    } else {
      process.env[envVar] = value;
    }
  }
}

/**
 * Build an esmocked pregen module with instrumented sdkman helpers.
 *
 * @param {Object} [overrides] Extra behavior keyed by helper name
 * @param {Object} [spawnResults] Optional outcomes for `--version` probes
 * @param {Boolean} [dryRun] Run the module with dry-run mode enabled
 * @param {Object} [extraModuleMocks] Additional module mocks merged into the
 *   dependency map, keyed by module specifier
 *
 * @returns {Promise<Object>} `{ pregenModule, installCalls, spawnCalls, activities }`
 */
async function mockPregen(
  overrides = {},
  spawnResults = {},
  dryRun = false,
  extraModuleMocks = {},
) {
  const installCalls = [];
  const spawnCalls = [];
  const activities = [];
  const candidatesDir = mkdtempSync(join(tmpdir(), "cdxgen-pregen-test-"));
  const defaults = {
    isSdkmanAvailable: () => true,
    isSdkmanToolAvailable: () => false,
    collectJavaInfo: () => ({ version: "openjdk 21.0.5 2025-01-01" }),
    installSdkmanTool: (toolType, toolName) => {
      const resolvedName =
        toolType === "java"
          ? TEST_JAVA_ALIASES[toolName] || toolName
          : toolName;
      installCalls.push([toolType, resolvedName]);
      if (toolType !== "java") {
        // Emulate the installer activating the tool home so the command
        // environment wiring can be exercised for real.
        const toolHome = join(candidatesDir, toolType, toolName);
        mkdirSync(join(toolHome, "bin"), { recursive: true });
        const binaryName =
          toolType === "maven"
            ? "mvn"
            : toolType === "gradle"
              ? "gradle"
              : "sbt";
        writeFileSync(join(toolHome, "bin", binaryName), "#!/bin/sh\n", {
          encoding: "utf-8",
        });
        process.env[`${toolType.toUpperCase()}_HOME`] = toolHome;
      }
      return true;
    },
    ...overrides,
  };
  const pregenModule = await esmock("./pregen.js", {
    ...extraModuleMocks,
    "../../inventory/envcontext.js": defaults,
    // sdkman provisioning is a POSIX-only path that bails out early on
    // Windows. Pinning the platform keeps these scenarios meaningful on every
    // runner instead of passing vacuously; the bail-out has its own test.
    "../../core/paths.js": { isWin: false },
    "../../core/activity.js": {
      isDryRun: dryRun,
      recordObservedActivity: (kind, target, options = {}) => {
        activities.push({ kind, target, ...options });
        return undefined;
      },
    },
    "../../core/fs.js": {
      safeSpawnSync: (...args) => {
        spawnCalls.push(args);
        const commandText = `${args[0]} ${args[1]?.join(" ") ?? ""}`;
        for (const [candidate, output] of Object.entries(cannedSdkLists)) {
          if (commandText.includes(`sdk list ${candidate}`)) {
            return { status: 0, stdout: output, stderr: "" };
          }
        }
        const probeTool = ["mvn", "gradle", "sbt", "scala"].find((binary) =>
          args[0].endsWith(binary),
        );
        if (probeTool && spawnResults[probeTool] !== undefined) {
          return spawnResults[probeTool];
        }
        return (
          spawnResults.default ?? {
            status: 1,
            error: "not found",
            stdout: "",
            stderr: "",
          }
        );
      },
    },
  });
  return {
    activities,
    pregenModule,
    installCalls,
    spawnCalls,
    candidatesDir,
  };
}

/**
 * Build an esmocked pregen module with a recording build ledger, so the
 * recorded event sequence can be asserted per scenario.
 *
 * @param {Object} [overrides] Extra behavior keyed by helper name
 * @param {Object} [spawnResults] Optional outcomes for `--version` probes
 * @param {Boolean} [dryRun] Run the module with dry-run mode enabled
 *
 * @returns {Promise<Object>} mockPregen result plus `ledgerEvents`
 */
async function mockPregenWithLedger(
  overrides = {},
  spawnResults = {},
  dryRun = false,
) {
  const ledgerEvents = [];
  const mocked = await mockPregen(overrides, spawnResults, dryRun, {
    "../../core/buildLedger.js": {
      LEDGER_ENABLED: true,
      isLedgerEnabled: () => true,
      LEDGER_EVENT_KINDS,
      LEDGER_EVENT_IMPACTS,
      recordLedgerEvent: (kind, fields = {}) => {
        const event = { kind, ...fields };
        ledgerEvents.push(event);
        return event;
      },
    },
  });
  return { ...mocked, ledgerEvents };
}

/** Compact `(kind, tool, wanted, found)` projection of recorded events. */
function eventRows(events) {
  return events.map((event) => [
    event.kind,
    event.tool,
    event.wanted,
    event.found,
  ]);
}

// Every scenario below mutates the shared process environment and esmock's
// module registry, so they are consolidated into sequential tests to avoid
// races with concurrently executed tests in this file (the same pattern used
// by lib/core/httpClient.poku.js).

it("prepareJvmBuildEnv installs explicit pins with JDK ordering and pinning", async () => {
  cleanManagedEnv();
  try {
    // Exact pin: install, activate, and pin the resolvers.
    {
      const { pregenModule, installCalls } = await mockPregen();
      pregenModule.prepareJvmBuildEnv(fixturesDir, {
        projectType: ["maven3.9.9"],
      });
      assert.deepStrictEqual(installCalls, [["maven", "3.9.9"]]);
      assert.strictEqual(process.env.CDXGEN_JVM_TOOL_PINNED, "true");
      assert.strictEqual(
        process.env.MVN_CMD,
        join(process.env.MAVEN_HOME, "bin", "mvn"),
      );
    }

    // Partial pin: resolved through the available sdkman versions.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls } = await mockPregen();
      pregenModule.prepareJvmBuildEnv(fixturesDir, {
        projectType: ["maven3.9"],
      });
      assert.deepStrictEqual(installCalls, [["maven", "3.9.16"]]);
    }

    // Gradle 9 on Java 8: the JDK is raised before the tool install.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls } = await mockPregen({
        collectJavaInfo: () => ({ version: "openjdk 8.0.452 2025-01-01" }),
      });
      pregenModule.prepareJvmBuildEnv(fixturesDir, {
        projectType: ["gradle9.6.1"],
      });
      assert.deepStrictEqual(installCalls, [
        ["java", "17.0.20-tem"],
        ["gradle", "9.6.1"],
      ]);
      assert.strictEqual(
        process.env.GRADLE_CMD,
        join(process.env.GRADLE_HOME, "bin", "gradle"),
      );
    }

    // A later unpinned run clears the signal left by an earlier pinned run,
    // which matters for long-lived processes such as the server.
    {
      cleanManagedEnv();
      const { pregenModule } = await mockPregen();
      pregenModule.prepareJvmBuildEnv(fixturesDir, {
        projectType: ["maven3.9.9"],
      });
      assert.strictEqual(process.env.CDXGEN_JVM_TOOL_PINNED, "true");
      pregenModule.prepareJvmBuildEnv(fixturesDir, { projectType: ["java"] });
      assert.strictEqual(process.env.CDXGEN_JVM_TOOL_PINNED, undefined);
    }

    // A value the user set themselves is left alone.
    {
      cleanManagedEnv();
      const { pregenModule } = await mockPregen();
      process.env.CDXGEN_JVM_TOOL_PINNED = "true";
      pregenModule.prepareJvmBuildEnv(fixturesDir, { projectType: ["java"] });
      assert.strictEqual(process.env.CDXGEN_JVM_TOOL_PINNED, "true");
    }

    // Explicit java type: honoured and installed before the tool.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls } = await mockPregen();
      pregenModule.prepareJvmBuildEnv(fixturesDir, {
        projectType: ["maven3.9.9", "java17"],
      });
      assert.deepStrictEqual(installCalls, [
        ["java", "17.0.20-tem"],
        ["maven", "3.9.9"],
      ]);
    }

    // Explicit java type below the tool minimum: warn, then continue.
    {
      cleanManagedEnv();
      const consoleStub = sinon.stub(console, "log");
      try {
        const { pregenModule, installCalls } = await mockPregen();
        pregenModule.prepareJvmBuildEnv(fixturesDir, {
          projectType: ["gradle9.6.1", "java8"],
        });
        const warnings = consoleStub
          .getCalls()
          .map((call) => call.args.join(" "))
          .filter((text) => text.includes("require Java 17"));
        assert.ok(warnings.length, "expected a JDK requirement warning");
        assert.deepStrictEqual(installCalls, [
          ["java", "8.0.504-zulu"],
          ["gradle", "9.6.1"],
        ]);
      } finally {
        consoleStub.restore();
      }
    }

    // Gradle too old for the current JDK: warn without guess-installing.
    {
      cleanManagedEnv();
      const consoleStub = sinon.stub(console, "log");
      try {
        const { pregenModule, installCalls } = await mockPregen({
          collectJavaInfo: () => ({ version: "openjdk 25.0.1 2025-01-01" }),
        });
        pregenModule.prepareJvmBuildEnv(fixturesDir, {
          projectType: ["gradle8.14.3"],
        });
        const warnings = consoleStub
          .getCalls()
          .map((call) => call.args.join(" "))
          .filter((text) =>
            text.includes("Gradle 8.14.3 cannot run on Java 25"),
          );
        assert.ok(warnings.length, "expected a gradle/Java cap warning");
        assert.deepStrictEqual(installCalls, [["gradle", "8.14.3"]]);
      } finally {
        consoleStub.restore();
      }
    }

    // Invalid version pins: rejected with a message, nothing spawned.
    {
      cleanManagedEnv();
      const consoleStub = sinon.stub(console, "log");
      try {
        const { pregenModule, installCalls, spawnCalls } = await mockPregen();
        pregenModule.prepareJvmBuildEnv(fixturesDir, {
          projectType: ["maven3.9;rm -rf"],
        });
        const messages = consoleStub
          .getCalls()
          .map((call) => call.args.join(" "))
          .filter((text) => text.includes("Invalid version"));
        assert.ok(messages.length, "expected an invalid version message");
        assert.deepStrictEqual(installCalls, []);
        assert.deepStrictEqual(spawnCalls, []);
      } finally {
        consoleStub.restore();
      }
    }

    // Bare and non-JVM types stay no-ops.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls, spawnCalls } = await mockPregen();
      for (const projectType of [["maven"], ["js"], ["java"], ["java17"], []]) {
        pregenModule.prepareJvmBuildEnv(fixturesDir, { projectType });
      }
      assert.deepStrictEqual(installCalls, []);
      assert.deepStrictEqual(spawnCalls, []);
    }

    // sdkman missing: continue unless deep + failOnError.
    {
      cleanManagedEnv();
      const exitStub = sinon.stub(process, "exit");
      try {
        const { pregenModule, installCalls } = await mockPregen({
          isSdkmanAvailable: () => false,
        });
        pregenModule.prepareJvmBuildEnv(fixturesDir, {
          projectType: ["maven3.9.9"],
        });
        assert.deepStrictEqual(installCalls, []);
        assert.strictEqual(exitStub.callCount, 0);
        pregenModule.prepareJvmBuildEnv(fixturesDir, {
          projectType: ["maven3.9.9"],
          deep: true,
          failOnError: true,
        });
        assert.strictEqual(exitStub.firstCall.args[0], 1);
      } finally {
        exitStub.restore();
      }
    }
  } finally {
    restoreManagedEnv();
  }
});

it("prepareJvmBuildEnv automatic mode follows repo markers and wrappers", async () => {
  cleanManagedEnv();
  try {
    // Wrapper-pinned tools are never installed; only JDK compatibility runs.
    {
      const { pregenModule, installCalls, spawnCalls } = await mockPregen();
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "gradle-wrapper-bin"), {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(installCalls, []);
      assert.deepStrictEqual(spawnCalls, []);
      assert.strictEqual(process.env.CDXGEN_JVM_TOOL_PINNED, undefined);
    }

    // Automatic mode without a project path inspects no repo markers.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls } = await mockPregen();
      pregenModule.prepareJvmBuildEnv(undefined, {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(installCalls, []);
    }

    // Build tool launchers read JVM arguments from the working directory, so
    // the availability probe must never run inside the scanned project.
    {
      cleanManagedEnv();
      const projectPath = join(fixturesDir, "maven-nowrapper");
      const { pregenModule, spawnCalls } = await mockPregen();
      pregenModule.prepareJvmBuildEnv(projectPath, {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      const probeCwds = spawnCalls
        .filter((call) => call[1]?.includes("--version"))
        .map((call) => call[2]?.cwd);
      assert.ok(probeCwds.length, "expected at least one --version probe");
      for (const cwd of probeCwds) {
        assert.ok(
          cwd && !`${cwd}`.startsWith(projectPath),
          `probe ran inside the scanned project: ${cwd}`,
        );
      }
    }

    // Wrapper-less pom projects get a default maven without pinning.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls } = await mockPregen();
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "maven-nowrapper"), {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(installCalls, [["maven", "3.9.16"]]);
      // Automatic provisioning must not beat project wrappers.
      assert.strictEqual(process.env.CDXGEN_JVM_TOOL_PINNED, undefined);
    }

    // An existing PATH tool satisfies the marker without any install.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls } = await mockPregen(
        {},
        {
          default: { status: 0, stdout: "Apache Maven 3.9.9", stderr: "" },
        },
      );
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "maven-nowrapper"), {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(installCalls, []);
    }

    // .sdkmanrc pins every candidate and raises the JDK to the file's java.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls } = await mockPregen({
        collectJavaInfo: () => ({ version: "openjdk 17.0.9 2024-01-01" }),
      });
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "sdkmanrc-full"), {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(installCalls, [
        ["java", "21.0.12-tem"],
        ["maven", "3.9.16"],
        ["gradle", "9.6.1"],
        ["sbt", "1.10.11"],
      ]);
    }

    // Without the feature flag the automatic mode stays dormant.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls, spawnCalls } = await mockPregen();
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "maven-nowrapper"), {
        projectType: ["java"],
      });
      assert.deepStrictEqual(installCalls, []);
      assert.deepStrictEqual(spawnCalls, []);
    }
  } finally {
    restoreManagedEnv();
  }
});

it("prepareEnv guards keep environment preparation opt-in", async () => {
  cleanManagedEnv();
  try {
    // Dry-run and secure modes must not install anything.
    for (const flag of ["isDryRun", "isSecureMode"]) {
      const installCalls = [];
      const pregenModule = await esmock("./pregen.js", {
        "../../core/activity.js": {
          [flag]: true,
        },
        "../../inventory/envcontext.js": {
          installSdkmanTool: () => {
            installCalls.push(true);
            return true;
          },
          isSdkmanAvailable: () => true,
        },
      });
      pregenModule.prepareEnv(fixturesDir, { projectType: ["maven3.9.9"] });
      assert.deepStrictEqual(installCalls, [], `${flag} must disable installs`);
    }

    // No project types: nothing to prepare.
    {
      const installCalls = [];
      const pregenModule = await esmock("./pregen.js", {
        "../../inventory/envcontext.js": {
          installSdkmanTool: () => {
            installCalls.push(true);
            return true;
          },
          isSdkmanAvailable: () => true,
        },
      });
      pregenModule.prepareEnv(fixturesDir, {});
      pregenModule.prepareEnv(fixturesDir, { projectType: [] });
      assert.deepStrictEqual(installCalls, []);
    }
  } finally {
    restoreManagedEnv();
  }
});

it("resolveJvmToolPinVersion keeps available versions and falls back safely", async () => {
  cleanManagedEnv();
  try {
    // Locally available exact versions skip the sdkman consultation.
    {
      const { pregenModule, spawnCalls } = await mockPregen({
        isSdkmanToolAvailable: (tool, version) =>
          tool === "maven" && version === "3.9.9",
      });
      const pin = pregenModule.resolveJvmToolPinVersion({
        tool: "maven",
        version: "3.9.9",
        source: "cli",
      });
      assert.deepStrictEqual(pin, {
        tool: "maven",
        version: "3.9.9",
        source: "cli",
      });
      assert.deepStrictEqual(spawnCalls, []);
    }

    // sdk list unavailable: exact versions still pass through untouched.
    {
      const { pregenModule } = await mockPregen({
        isSdkmanAvailable: () => false,
      });
      const pin = pregenModule.resolveJvmToolPinVersion({
        tool: "maven",
        version: "3.9.9",
        source: "cli",
      });
      assert.deepStrictEqual(pin, {
        tool: "maven",
        version: "3.9.9",
        source: "cli",
      });
    }

    // Default pins are dropped when no version can be determined.
    {
      const consoleStub = sinon.stub(console, "log");
      try {
        const { pregenModule } = await mockPregen({
          isSdkmanAvailable: () => false,
        });
        const pin = pregenModule.resolveJvmToolPinVersion({
          tool: "gradle",
          version: undefined,
          source: "default",
        });
        assert.strictEqual(pin, undefined);
        const messages = consoleStub
          .getCalls()
          .map((call) => call.args.join(" "))
          .filter((text) => text.includes("did not return any versions"));
        assert.ok(messages.length, "expected an sdk list failure message");
      } finally {
        consoleStub.restore();
      }
    }
  } finally {
    restoreManagedEnv();
  }
});

it("resolveJvmToolPinVersion constrains the Gradle default to the project JDK", async () => {
  cleanManagedEnv();
  try {
    // The canned gradle sdk list tops out at 9.7.0, which cannot run on
    // Java 27: the default install chooses nothing rather than a Gradle that
    // would fail at run time.
    const { pregenModule } = await mockPregen();
    const pin = pregenModule.resolveJvmToolPinVersion(
      {
        tool: "gradle",
        version: undefined,
        source: "default",
      },
      27,
    );
    assert.strictEqual(pin, undefined);

    // Without a JDK signal the default resolution is unchanged and keeps
    // picking the newest stable version from the same list.
    const unconstrained = pregenModule.resolveJvmToolPinVersion({
      tool: "gradle",
      version: undefined,
      source: "default",
    });
    assert.strictEqual(unconstrained?.version, "9.7.0");

    // An explicit version pin is never overridden by the JDK constraint.
    const explicit = pregenModule.resolveJvmToolPinVersion(
      {
        tool: "gradle",
        version: "8.14.5",
        source: "cli",
      },
      27,
    );
    assert.deepStrictEqual(explicit, {
      tool: "gradle",
      version: "8.14.5",
      source: "cli",
    });
  } finally {
    restoreManagedEnv();
  }
});

it("prepareJvmBuildEnv reports the toolchain under dry-run without provisioning it", async () => {
  cleanManagedEnv();
  try {
    // An explicit pin is reported as a certain install, along with the
    // environment it would rewrite, and nothing is installed.
    {
      const { pregenModule, installCalls, spawnCalls, activities } =
        await mockPregen({}, {}, true);
      pregenModule.prepareJvmBuildEnv(fixturesDir, {
        projectType: ["maven3.9.9"],
      });
      assert.deepStrictEqual(installCalls, []);
      assert.deepStrictEqual(spawnCalls, []);
      assert.strictEqual(process.env.CDXGEN_JVM_TOOL_PINNED, undefined);
      assert.strictEqual(process.env.MVN_CMD, undefined);
      const provisions = activities.filter((a) => a.kind === "provision");
      assert.deepStrictEqual(
        provisions.map((a) => a.target),
        ["sdkman:maven@3.9.9"],
      );
      assert.ok(provisions.every((a) => a.status === "blocked"));
      assert.ok(
        activities.some(
          (a) =>
            a.kind === "env" &&
            a.target === "process.env:MVN_CMD" &&
            a.status === "blocked",
        ),
        "expected the MVN_CMD rewrite to be reported",
      );
      assert.ok(
        activities.some(
          (a) => a.target === "process.env:CDXGEN_JVM_TOOL_PINNED",
        ),
        "expected the resolver pin signal to be reported",
      );
      // The JDK is installed only when the active one is too old, and dry-run
      // cannot run java to find out, so it is a requirement, not an install.
      assert.ok(
        activities.some((a) => a.kind === "decision" && a.target === "java>=8"),
        "expected a conditional JDK requirement",
      );
    }

    // An explicit javaNN type is always installed, so it is reported as one.
    {
      cleanManagedEnv();
      const { pregenModule, activities } = await mockPregen({}, {}, true);
      pregenModule.prepareJvmBuildEnv(fixturesDir, {
        projectType: ["maven3.9.9", "java17"],
      });
      assert.ok(
        activities.some(
          (a) =>
            a.kind === "provision" &&
            a.target === "sdkman:java@17.0.20-tem" &&
            a.status === "blocked",
        ),
        "expected the pinned JDK to be reported as an install",
      );
    }

    // Automatic mode reports repo-derived pins and separates the tools the
    // project provisions itself from the ones cdxgen would install.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls, activities } = await mockPregen(
        {},
        {},
        true,
      );
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "sdkmanrc-full"), {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(installCalls, []);
      const provisions = activities.filter((a) => a.kind === "provision");
      assert.ok(
        provisions.length,
        "expected .sdkmanrc pins to be reported as installs",
      );
      for (const provision of provisions) {
        assert.match(provision.reason, /^Would install /);
        assert.strictEqual(provision.status, "blocked");
      }
    }

    // Wrapper-pinned tools are reported as detected, never as installs.
    {
      cleanManagedEnv();
      const { pregenModule, installCalls, activities } = await mockPregen(
        {},
        {},
        true,
      );
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "gradle-wrapper-bin"), {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(installCalls, []);
      assert.deepStrictEqual(
        activities.filter((a) => a.kind === "provision"),
        [],
      );
      const discovered = activities.find(
        (a) => a.kind === "discover" && a.target === "gradle@8.14.3",
      );
      assert.ok(
        discovered,
        "expected the wrapper-pinned gradle to be reported",
      );
      assert.match(discovered.reason, /provisions it itself/);
    }

    // The availability probe answers from PATH instead of executing the tool.
    {
      cleanManagedEnv();
      const { pregenModule, spawnCalls, activities } = await mockPregen(
        {},
        {},
        true,
      );
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "maven-nowrapper"), {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(spawnCalls, []);
      const probe = activities.find((a) => a.kind === "probe");
      assert.ok(probe, "expected an availability probe to be reported");
      assert.strictEqual(probe.status, "blocked");
      assert.match(probe.reason, /without executing it|not executed/);
    }
  } finally {
    restoreManagedEnv();
  }
});

it("prepareJvmBuildEnv bails out on Windows, where sdkman is unavailable", async () => {
  cleanManagedEnv();
  const consoleStub = sinon.stub(console, "log");
  try {
    const installCalls = [];
    const activities = [];
    const pregenModule = await esmock("./pregen.js", {
      "../../core/paths.js": { isWin: true },
      "../../core/activity.js": {
        recordObservedActivity: (kind, target, options = {}) => {
          activities.push({ kind, target, ...options });
          return undefined;
        },
      },
      "../../inventory/envcontext.js": {
        isSdkmanAvailable: () => true,
        isSdkmanToolAvailable: () => false,
        installSdkmanTool: (...args) => {
          installCalls.push(args);
          return true;
        },
      },
    });
    pregenModule.prepareJvmBuildEnv(fixturesDir, {
      projectType: ["maven3.9.9"],
    });
    assert.deepStrictEqual(installCalls, []);
    assert.deepStrictEqual(activities, []);
    assert.strictEqual(process.env.CDXGEN_JVM_TOOL_PINNED, undefined);
    const messages = consoleStub
      .getCalls()
      .map((call) => call.args.join(" "))
      .filter((text) => text.includes("unavailable on Windows"));
    assert.ok(messages.length, "expected the Windows guidance message");
  } finally {
    consoleStub.restore();
    restoreManagedEnv();
  }
});

it("prepareJvmBuildEnv records the expected-vs-found event sequence per fixture", async () => {
  cleanManagedEnv();
  try {
    // Wrapper-pinned gradle: one expectation from the wrapper, then the JDK
    // compatibility check resolving the required major against the live JDK.
    {
      const { pregenModule, ledgerEvents } = await mockPregenWithLedger();
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "gradle-wrapper-bin"), {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(eventRows(ledgerEvents), [
        ["tool.expected", "gradle", "8.14.3", undefined],
        ["tool.resolved", "java", "8", "21"],
      ]);
      assert.strictEqual(ledgerEvents[0].source, "wrapper");
      assert.strictEqual(ledgerEvents[1].source, "env");
    }

    // The -all wrapper pins a newer gradle, raising the required JDK major.
    {
      cleanManagedEnv();
      const { pregenModule, ledgerEvents } = await mockPregenWithLedger();
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "gradle-wrapper-all"), {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(eventRows(ledgerEvents), [
        ["tool.expected", "gradle", "9.6.1", undefined],
        ["tool.resolved", "java", "17", "21"],
      ]);
    }

    // Wrapper-less maven project: the failed availability probe records a
    // missing tool, the default pin is resolved through sdk list, and the
    // install plus command-env wiring are recorded end to end.
    {
      cleanManagedEnv();
      const { pregenModule, ledgerEvents } = await mockPregenWithLedger();
      pregenModule.prepareJvmBuildEnv(join(fixturesDir, "maven-nowrapper"), {
        projectType: ["java"],
        featureFlags: ["jvm-tool-setup"],
      });
      assert.deepStrictEqual(eventRows(ledgerEvents), [
        ["tool.missing", "maven", undefined, undefined],
        ["tool.expected", "maven", undefined, undefined],
        ["tool.resolved", "maven", undefined, "3.9.16"],
        // The fixture's pom.xml declares maven.compiler.release 17, so the
        // JDK compatibility check targets 17 rather than the tool minimum 8.
        ["tool.resolved", "java", "17", "21"],
        ["command.attempted", "maven", undefined, undefined],
        ["tool.resolved", "maven", "3.9.16", "3.9.16"],
      ]);
      assert.strictEqual(ledgerEvents[0].source, "PATH");
      assert.strictEqual(ledgerEvents[1].source, "default");
      assert.strictEqual(ledgerEvents[2].source, "sdkman");
      assert.match(ledgerEvents[4].command, /sdk install maven 3\.9\.16/);
      assert.ok(ledgerEvents[5].path, "expected the resolved tool path");
    }

    // sdkman unavailable and no maven on PATH: the pinned expectation is
    // followed by a missing tool, not a resolution.
    {
      cleanManagedEnv();
      const wrapperProject = mkdtempSync(join(tmpdir(), "cdxgen-mvnwrapper-"));
      const wrapperDir = join(wrapperProject, ".mvn", "wrapper");
      mkdirSync(wrapperDir, { recursive: true });
      writeFileSync(
        join(wrapperDir, "maven-wrapper.properties"),
        "distributionUrl=https://repo1.maven.org/maven2/org/apache/maven/apache-maven/3.9.9/binaries/apache-maven-3.9.9-bin.zip\n",
      );
      writeFileSync(join(wrapperProject, "pom.xml"), "<project></project>\n");
      try {
        const { pregenModule, ledgerEvents } = await mockPregenWithLedger(
          { isSdkmanAvailable: () => false },
          {
            default: { status: 1, error: "not found", stdout: "", stderr: "" },
          },
        );
        pregenModule.prepareJvmBuildEnv(wrapperProject, {
          projectType: ["maven3.9.9"],
        });
        const mavenEvents = ledgerEvents.filter(
          (event) => event.tool === "maven",
        );
        assert.deepStrictEqual(eventRows(mavenEvents), [
          ["tool.expected", "maven", "3.9.9", undefined],
          ["tool.missing", "maven", undefined, undefined],
        ]);
        assert.strictEqual(mavenEvents[0].source, "cli");
        assert.strictEqual(mavenEvents[1].source, "PATH");
      } finally {
        rmSync(wrapperProject, { recursive: true, force: true });
      }
    }

    // A JDK newer than the gradle pin supports records the gradle/Java cap
    // mismatch, while the JDK itself satisfies the tool requirement.
    {
      cleanManagedEnv();
      const consoleStub = sinon.stub(console, "log");
      try {
        const { pregenModule, ledgerEvents } = await mockPregenWithLedger({
          collectJavaInfo: () => ({ version: "openjdk 25.0.1 2025-01-01" }),
        });
        pregenModule.prepareJvmBuildEnv(fixturesDir, {
          projectType: ["gradle8.14.3"],
        });
        const mismatches = ledgerEvents.filter(
          (event) => event.kind === LEDGER_EVENT_KINDS.TOOL_MISMATCH,
        );
        assert.deepStrictEqual(
          mismatches.map((event) => [event.tool, event.wanted, event.found]),
          [["gradle", "9.1.0", "8.14.3"]],
        );
        assert.ok(
          ledgerEvents.some(
            (event) =>
              event.kind === LEDGER_EVENT_KINDS.TOOL_RESOLVED &&
              event.tool === "java" &&
              event.wanted === "8" &&
              event.found === "25",
          ),
          "expected the satisfied JDK requirement to be recorded",
        );
      } finally {
        consoleStub.restore();
      }
    }
  } finally {
    restoreManagedEnv();
  }
});

it("prepareEnv records declared tool requirements and missing node_modules", async () => {
  cleanManagedEnv();
  const savedNodeEnvVars = {};
  for (const envVar of ["VIRTUAL_ENV", "CONDA_PREFIX", "NODE_INSTALL_ARGS"]) {
    savedNodeEnvVars[envVar] = process.env[envVar];
    delete process.env[envVar];
  }
  try {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-declared-reqs-"));
    writeFileSync(
      join(projectDir, ".tool-versions"),
      "nodejs 20.11.1\npython 3.12.7\n",
    );
    writeFileSync(
      join(projectDir, "package.json"),
      '{"engines": {"node": ">=18"}, "packageManager": "pnpm@9.1.0"}',
    );
    writeFileSync(
      join(projectDir, "global.json"),
      '{"sdk": {"version": "9.0.100"}}',
    );
    try {
      const { pregenModule, ledgerEvents } = await mockPregenWithLedger();
      pregenModule.prepareEnv(projectDir, { projectType: ["js"] });
      assert.deepStrictEqual(eventRows(ledgerEvents).slice(0, 5), [
        ["tool.expected", "nodejs", "20.11.1", undefined],
        ["tool.expected", "python", "3.12.7", undefined],
        ["tool.expected", "node", ">=18", undefined],
        ["tool.expected", "pnpm", "9.1.0", undefined],
        ["tool.expected", "dotnet", "9.0.100", undefined],
      ]);
      assert.strictEqual(ledgerEvents[0].source, ".tool-versions");
      assert.strictEqual(ledgerEvents[2].source, "package.json");
      assert.strictEqual(ledgerEvents[4].source, "global.json");
      assert.ok(
        ledgerEvents.some(
          (event) =>
            event.kind === LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED &&
            event.ecosystem === "npm" &&
            event.remediationId === "js.no-node-modules" &&
            event.impact === LEDGER_EVENT_IMPACTS.TRANSITIVE_DEPS,
        ),
        "expected the absent node_modules to be recorded as degraded evidence",
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  } finally {
    for (const [envVar, value] of Object.entries(savedNodeEnvVars)) {
      if (value === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = value;
      }
    }
    restoreManagedEnv();
  }
});

it("records wrapper-declared JVM tool pins without the jvm-tool-setup flag", async () => {
  cleanManagedEnv();
  try {
    // Tool provisioning is opt-in behind `jvm-tool-setup`, but observing what a
    // repository declares is not, so `prepareEnv` records the pins on the
    // default path every ordinary scan takes.
    for (const [fixture, tool, wanted] of [
      ["gradle-wrapper-bin", "gradle", "8.14.3"],
      ["gradle-wrapper-all", "gradle", "9.6.1"],
      ["maven-wrapper", "maven", "3.9.9"],
      ["sbt-basic", "sbt", "1.10.11"],
      ["sdkmanrc-full", "java", "21.0.7-tem"],
      ["sdkmanrc-full", "maven", "3.9.16"],
    ]) {
      const { pregenModule, ledgerEvents } = await mockPregenWithLedger();
      pregenModule.prepareEnv(join(fixturesDir, fixture), {
        projectType: ["java"],
      });
      const declared = ledgerEvents.filter(
        (event) =>
          event.kind === LEDGER_EVENT_KINDS.TOOL_EXPECTED &&
          event.tool === tool,
      );
      assert.strictEqual(declared.length, 1, `${fixture} declares ${tool}`);
      assert.strictEqual(declared[0].wanted, wanted);
      assert.strictEqual(declared[0].ecosystem, "java");
    }
    // A project pinning nothing must not invent a requirement.
    const { pregenModule, ledgerEvents } = await mockPregenWithLedger();
    pregenModule.prepareEnv(join(fixturesDir, "gradle-nowrapper"), {
      projectType: ["java"],
    });
    assert.deepStrictEqual(
      ledgerEvents.filter(
        (event) =>
          event.kind === LEDGER_EVENT_KINDS.TOOL_EXPECTED &&
          event.ecosystem === "java",
      ),
      [],
    );
  } finally {
    restoreManagedEnv();
  }
});

it("reports absent node_modules only for projects declaring npm dependencies", async () => {
  cleanManagedEnv();
  try {
    // Node preparation runs for every project type, so a JVM-only fixture must
    // not acquire an npm finding.
    const { pregenModule, ledgerEvents } = await mockPregenWithLedger();
    pregenModule.prepareEnv(join(fixturesDir, "maven-nowrapper"), {
      projectType: ["java"],
    });
    assert.deepStrictEqual(
      ledgerEvents.filter((event) => event.ecosystem === "npm"),
      [],
    );
  } finally {
    restoreManagedEnv();
  }
});

it("build ledger recording stays inert when introspection is disabled", async () => {
  cleanManagedEnv();
  try {
    const { pregenModule, installCalls } = await mockPregen();
    pregenModule.prepareJvmBuildEnv(join(fixturesDir, "maven-nowrapper"), {
      projectType: ["java"],
      featureFlags: ["jvm-tool-setup"],
    });
    pregenModule.prepareEnv(fixturesDir, { projectType: ["java"] });
    assert.ok(installCalls.length, "expected the scenario to do real work");
    assert.deepStrictEqual(getLedgerEvents(), []);
  } finally {
    restoreManagedEnv();
  }
});

it("prepareDotnetEnv checks that the bundled dosai starts on deep .NET runs", async () => {
  const savedEnv = {
    CDXGEN_IN_CONTAINER: process.env.CDXGEN_IN_CONTAINER,
    DOSAI_CMD: process.env.DOSAI_CMD,
  };
  delete process.env.CDXGEN_IN_CONTAINER;
  delete process.env.DOSAI_CMD;
  const dotnetDir = mkdtempSync(join(tmpdir(), "pregen-dotnet-"));
  const otherDir = mkdtempSync(join(tmpdir(), "pregen-no-dotnet-"));
  writeFileSync(join(dotnetDir, "App.csproj"), "<Project />");
  writeFileSync(join(otherDir, "pom.xml"), "<project />");
  // What the .NET host prints when the runtime dosai targets is missing
  const missingRuntime = {
    status: 150,
    stdout: "",
    stderr:
      "You must install or update .NET to run this application.\n\nApp: /plugins/dosai/dosai\nArchitecture: arm64\nFramework: 'Microsoft.NETCore.App', version '11.0.0-rc.2.26504.105' (arm64)\n.NET location: /usr/local/share/dotnet\n",
  };
  const run = async (filePath, options, spawnResult = missingRuntime) => {
    const spawnCalls = [];
    const ledgerEvents = [];
    const failures = [];
    const logs = [];
    const marked = [];
    // Other tests in this file stub console.log concurrently, so the module
    // gets its own console instead
    const pregenModule = await esmock(
      "./pregen.js",
      {
        "../../inventory/plugins.js": {
          resolvePluginBinary: () => "/plugins/dosai/dosai",
        },
        "../../inventory/dosai.js": {
          markDosaiLaunchFailureReported: (executable) =>
            marked.push(executable),
        },
        "../../core/fs.js": {
          safeSpawnSync: (...args) => {
            spawnCalls.push(args);
            return spawnResult;
          },
        },
        "../../core/buildLedger.js": {
          recordLedgerEvent: (kind, payload) =>
            ledgerEvents.push({ kind, ...payload }),
        },
        "../../core/deferredExit.js": {
          deferFailOnError: (_options, failure) => failures.push(failure),
        },
      },
      {
        import: {
          console: { ...console, log: (...args) => logs.push(args.join(" ")) },
        },
      },
    );
    pregenModule.prepareDotnetEnv(filePath, options);
    const warnings = logs.filter((text) => text.includes("dosai"));
    return { spawnCalls, ledgerEvents, failures, warnings, marked };
  };
  try {
    // A detected .NET tree whose dosai cannot find its runtime: warn, record
    // the degraded evidence, and hand the failure to --fail-on-error.
    {
      const { spawnCalls, ledgerEvents, failures, warnings, marked } =
        await run(dotnetDir, { deep: true, multiProject: true });
      assert.deepStrictEqual(spawnCalls[0].slice(0, 2), [
        "/plugins/dosai/dosai",
        ["--version"],
      ]);
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes("11.0.0-rc.2.26504.105"));
      assert.ok(warnings[0].includes("DOSAI_CMD"));
      // dosai runs of the same executable do not repeat the warning
      assert.deepStrictEqual(marked, ["/plugins/dosai/dosai"]);
      assert.strictEqual(
        ledgerEvents[0].kind,
        LEDGER_EVENT_KINDS.EVIDENCE_DEGRADED,
      );
      assert.strictEqual(ledgerEvents[0].tool, "dosai");
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(failures[0].exitCode, 150);
      assert.ok(failures[0].detail.includes("11.0.0-rc.2.26504.105"));
    }
    // No .NET at all: the host names only its own version, whose major is
    // the .NET release to install
    {
      const { failures, warnings } = await run(
        dotnetDir,
        { deep: true, multiProject: true },
        {
          status: 131,
          stdout: "",
          stderr:
            "You must install .NET to run this application.\n\nApp: /plugins/dosai/dosai\nArchitecture: arm64\nApp host version: 11.0.0-rc.2.26504.105\n.NET location: Not found\n",
        },
      );
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes("no .NET installation was found"));
      assert.ok(warnings[0].includes("Install the .NET 11 runtime or SDK"));
      assert.strictEqual(failures[0].exitCode, 131);
    }
    // Any other start failure is not a missing runtime, so later dosai runs
    // still report what they find
    {
      const { marked, warnings } = await run(
        dotnetDir,
        { deep: true, multiProject: true },
        { status: 134, stdout: "", stderr: "Unhandled exception." },
      );
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].startsWith("WARNING: dosai could not start"));
      assert.deepStrictEqual(marked, []);
    }
    // An explicit .NET project type is checked without looking for files
    {
      const { spawnCalls, failures } = await run(otherDir, {
        deep: true,
        projectType: ["dotnet"],
      });
      assert.strictEqual(spawnCalls.length, 1);
      assert.strictEqual(failures.length, 1);
    }
    // dosai starts: nothing to report
    {
      const { ledgerEvents, failures, warnings } = await run(
        dotnetDir,
        { deep: true, multiProject: true },
        { status: 0, stdout: "5.0.0-rc.1", stderr: "" },
      );
      assert.deepStrictEqual([ledgerEvents, failures, warnings], [[], [], []]);
    }
    // Not checked: no --deep, another project type, no .NET files, the
    // container images, or a DOSAI_CMD the user chose
    for (const [filePath, options] of [
      [dotnetDir, { multiProject: true }],
      [dotnetDir, { deep: true, projectType: ["java"] }],
      [otherDir, { deep: true, multiProject: true }],
    ]) {
      const { spawnCalls } = await run(filePath, options);
      assert.deepStrictEqual(spawnCalls, [], JSON.stringify(options));
    }
    for (const [name, value] of [
      ["CDXGEN_IN_CONTAINER", "true"],
      ["DOSAI_CMD", "/opt/dosai/dosai"],
    ]) {
      process.env[name] = value;
      const { spawnCalls } = await run(dotnetDir, {
        deep: true,
        multiProject: true,
      });
      delete process.env[name];
      assert.deepStrictEqual(spawnCalls, [], name);
    }
  } finally {
    rmSync(dotnetDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

it("doNpmInstall() does not run npm when dependency installation is disabled", async () => {
  // npm install runs the project's preinstall script even with
  // --package-lock-only, so --no-install-deps must skip it.
  const fsCore = await import("../../core/fs.js");
  const safeSpawnSync = sinon.stub().returns({ status: 0, stdout: "" });
  const { doNpmInstall } = await esmock("./pregen.js", {
    "../../core/fs.js": { ...fsCore, safeSpawnSync },
  });
  doNpmInstall(tmpdir(), "/opt/node/bin", { installDeps: false });
  assert.strictEqual(safeSpawnSync.callCount, 0);
});

it("javaMajorFromProjectType reads only versioned java types", async () => {
  const { pregenModule } = await mockPregen();
  assert.strictEqual(pregenModule.javaMajorFromProjectType("java27"), 27);
  assert.strictEqual(pregenModule.javaMajorFromProjectType("java8"), 8);
  for (const projectType of ["java", "javascript", "java27x", "jvm", 27]) {
    assert.strictEqual(
      pregenModule.javaMajorFromProjectType(projectType),
      undefined,
    );
  }
});

it("resolveJvmToolPinVersion names the Gradle floor the JDK needs when none is listed", async () => {
  cleanManagedEnv();
  try {
    const { pregenModule, ledgerEvents } = await mockPregenWithLedger();
    const pin = pregenModule.resolveJvmToolPinVersion(
      { tool: "gradle", version: undefined, source: "default" },
      27,
    );
    assert.strictEqual(pin, undefined);
    const missing = ledgerEvents.find(
      (event) =>
        event.kind === LEDGER_EVENT_KINDS.TOOL_MISSING &&
        event.tool === "gradle",
    );
    assert.ok(missing, "no TOOL_MISSING event for gradle");
    assert.strictEqual(missing.wanted, ">=9.8.0");
    assert.ok(missing.detail.includes("Java 27"), missing.detail);
  } finally {
    restoreManagedEnv();
  }
});

it("java27 has an sdkman alias only when JAVA27_TOOL names one", async () => {
  const original = process.env.JAVA27_TOOL;
  try {
    delete process.env.JAVA27_TOOL;
    const withoutTool = await esmock("../../inventory/envcontext.js");
    assert.ok(!("java27" in withoutTool.SDKMAN_JAVA_TOOL_ALIASES));
    assert.strictEqual(
      withoutTool.SDKMAN_JAVA_TOOL_ALIASES.java26,
      "26.0.2-tem",
    );
    process.env.JAVA27_TOOL = "27.0.1-tem";
    const withTool = await esmock("../../inventory/envcontext.js");
    assert.strictEqual(withTool.SDKMAN_JAVA_TOOL_ALIASES.java27, "27.0.1-tem");
  } finally {
    if (original === undefined) {
      delete process.env.JAVA27_TOOL;
    } else {
      process.env.JAVA27_TOOL = original;
    }
  }
});
