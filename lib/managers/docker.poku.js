import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, beforeEach, describe, it } from "poku";
import sinon from "sinon";
import { create as createTar } from "tar";

import {
  addSkippedSrcFiles,
  exportArchive,
  exportImage,
  extractFromManifest,
  isImageReference,
  isWin,
  parseImageName,
} from "./docker.js";

it("parseImageName tests", () => {
  if (isWin && process.env.CI === "true") {
    return;
  }
  assert.deepStrictEqual(parseImageName("debian"), {
    registry: "",
    repo: "debian",
    tag: "",
    digest: "",
    platform: "",
    group: "",
    name: "debian",
  });
  assert.deepStrictEqual(parseImageName("debian:latest"), {
    registry: "",
    repo: "debian",
    tag: "latest",
    digest: "",
    platform: "",
    group: "",
    name: "debian",
  });
  assert.deepStrictEqual(parseImageName("library/debian:latest"), {
    registry: "",
    repo: "library/debian",
    tag: "latest",
    digest: "",
    platform: "",
    group: "library",
    name: "debian",
  });
  assert.deepStrictEqual(parseImageName("shiftleft/scan:v1.15.6"), {
    registry: "",
    repo: "shiftleft/scan",
    tag: "v1.15.6",
    digest: "",
    platform: "",
    group: "shiftleft",
    name: "scan",
  });
  assert.deepStrictEqual(
    parseImageName("localhost:5000/shiftleft/scan:v1.15.6"),
    {
      registry: "localhost:5000",
      repo: "shiftleft/scan",
      tag: "v1.15.6",
      digest: "",
      platform: "",
      group: "shiftleft",
      name: "scan",
    },
  );
  assert.deepStrictEqual(parseImageName("localhost:5000/shiftleft/scan"), {
    registry: "localhost:5000",
    repo: "shiftleft/scan",
    tag: "",
    digest: "",
    platform: "",
    group: "shiftleft",
    name: "scan",
  });
  assert.deepStrictEqual(
    parseImageName("foocorp.jfrog.io/docker/library/eclipse-temurin:latest"),
    {
      registry: "foocorp.jfrog.io",
      repo: "docker/library/eclipse-temurin",
      tag: "latest",
      digest: "",
      platform: "",
      group: "docker/library",
      name: "eclipse-temurin",
    },
  );
  assert.deepStrictEqual(
    parseImageName(
      "--platform=linux/amd64 foocorp.jfrog.io/docker/library/eclipse-temurin:latest",
    ),
    {
      registry: "foocorp.jfrog.io",
      repo: "docker/library/eclipse-temurin",
      tag: "latest",
      digest: "",
      platform: "linux/amd64",
      group: "docker/library",
      name: "eclipse-temurin",
    },
  );
  assert.deepStrictEqual(
    parseImageName(
      "quay.io/shiftleft/scan-java@sha256:5d008306a7c5d09ba0161a3408fa3839dc2c9dd991ffb68adecc1040399fe9e1",
    ),
    {
      registry: "quay.io",
      repo: "shiftleft/scan-java",
      tag: "",
      digest:
        "5d008306a7c5d09ba0161a3408fa3839dc2c9dd991ffb68adecc1040399fe9e1",
      platform: "",
      group: "shiftleft",
      name: "scan-java",
    },
  );
});

it("isImageReference tests", () => {
  // Documented reference styles
  assert.equal(isImageReference("postgres:15-alpine"), true);
  assert.equal(isImageReference("alpine:3.20"), true);
  assert.equal(isImageReference("postgres"), true);
  assert.equal(isImageReference("shiftleft/scan-slim"), true);
  assert.equal(isImageReference("shiftleft/scan-slim:latest"), true);
  assert.equal(isImageReference("docker.io/library/postgres:15-alpine"), true);
  assert.equal(
    isImageReference("ghcr.io/owasp-dep-scan/depscan:nightly"),
    true,
  );
  assert.equal(isImageReference("quay.io/appthreat/dep-container:main"), true);
  assert.equal(
    isImageReference("myregistry.local:5000/testing/test-image"),
    true,
  );
  assert.equal(isImageReference("localhost:5000/foo:bar"), true);
  assert.equal(isImageReference("192.168.1.5:5000/foo"), true);
  assert.equal(isImageReference("registry.example.com/a/b/c:1.0.0"), true);
  // Host edge cases: empty labels, over-long ports and hostile zero runs must
  // reject, and without exponential backtracking on the way.
  assert.equal(isImageReference("a..b/img"), false);
  assert.equal(isImageReference("registry.example.com:999999/img"), false);
  assert.equal(isImageReference("registry.example.com:/img"), false);
  assert.equal(isImageReference(`0.0${"0".repeat(300)}/img`), false);
  assert.equal(
    isImageReference(
      "ubuntu@sha256:45b23dee08af5e43a7fea6c4cf9c25ccf269ee113168c19722f87876677c5cb2",
    ),
    true,
  );
  assert.equal(
    isImageReference(
      "registry.example.com/img:tag@sha256:45b23dee08af5e43a7fea6c4cf9c25ccf269ee113168c19722f87876677c5cb2",
    ),
    true,
  );
  // Filesystem paths must never be treated as image references
  assert.equal(isImageReference("c:\\Users\\prabhu"), false);
  assert.equal(isImageReference("C:\\Users\\prabhu"), false);
  assert.equal(isImageReference("c:/Users/prabhu"), false);
  assert.equal(isImageReference("/tmp/rootfs"), false);
  assert.equal(isImageReference("./relative/path"), false);
  assert.equal(isImageReference("../parent/path"), false);
  assert.equal(isImageReference("."), false);
  // URLs and schemes must never reach the container clients
  assert.equal(isImageReference("file:///etc/passwd"), false);
  assert.equal(isImageReference("https://example.com/img"), false);
  assert.equal(isImageReference("http://registry:5000/img"), false);
  assert.equal(isImageReference("ssh://git@github.com/org/repo"), false);
  assert.equal(isImageReference("docker://ghcr.io/a/b"), false);
  // Options, malformed references and junk
  assert.equal(isImageReference("--platform=linux/arm64"), false);
  assert.equal(isImageReference("-o"), false);
  assert.equal(isImageReference(""), false);
  assert.equal(isImageReference(), false);
  assert.equal(isImageReference(":tag"), false);
  assert.equal(isImageReference("repo:"), false);
  assert.equal(isImageReference("repo::tag"), false);
  assert.equal(isImageReference("repo:-leading-tag"), false);
  assert.equal(isImageReference("repo@sha256:not-hex"), false);
  assert.equal(isImageReference("repo@sha256:123"), false);
  assert.equal(isImageReference("repo@unknown-algo:"), false);
  assert.equal(isImageReference("repo@sha256:abc@sha256:def"), false);
  assert.equal(isImageReference("a b"), false);
  assert.equal(isImageReference("UPPER:tag".repeat(300)), false);
});

async function loadDockerModule({
  clientResponse,
  fsOverrides,
  streamOverrides,
  tarOverrides,
  utilsOverrides,
  osOverrides,
} = {}) {
  const dockerClient = sinon.stub().resolves(
    clientResponse || {
      Id: "sha256:hello-world",
      RepoTags: ["hello-world:latest"],
    },
  );
  dockerClient.stream = sinon.stub();
  const fsStub = {
    createReadStream: sinon.stub(),
    lstatSync: sinon.stub(),
    readdirSync: sinon.stub().returns([]),
    readFileSync: sinon.stub(),
    ...fsOverrides,
  };
  // The undici-backed daemon connection is injected so tests can assert the
  // path/options (and resolved auth headers) passed to each daemon request via
  // the `dockerClient` stub, which stands in for the connection's `request`.
  const daemonConnection = {
    baseUrl: "http://localhost",
    prefixUrl: "http://unix:/var/run/docker.sock:",
    request: dockerClient,
    stream: dockerClient.stream,
    close: sinon.stub().resolves(),
  };
  const createDaemonConnectionStub = sinon.stub().returns(daemonConnection);
  // docker.js derives isWin from node:os at import time, so tests that need
  // Windows-specific CLI selection pass osOverrides (e.g. platform: () => "win32").
  const osStub = osOverrides
    ? {
        homedir: () => "/tmp/cdxgen-home",
        platform: () => "linux",
        userInfo: () => ({ uid: 1000, gid: 1000 }),
        ...osOverrides,
      }
    : undefined;
  const utilsStub = {
    DEBUG_MODE: false,
    createDryRunError: sinon.stub(),
    extractPathEnv: sinon.stub().returns([]),
    getAllFiles: sinon.stub().returns([]),
    getTmpDir: sinon.stub().returns("/tmp"),
    isDryRun: false,
    readEnvironmentVariable: sinon
      .stub()
      .callsFake((varName) => process.env[varName]),
    recordActivity: sinon.stub(),
    recordDecisionActivity: sinon.stub(),
    recordSensitiveFileRead: sinon.stub(),
    safeExtractArchive: sinon.stub().resolves(true),
    safeExistsSync: sinon.stub().returns(false),
    safeMkdirSync: sinon.stub(),
    safeMkdtempSync: sinon.stub().returns("/tmp/docker-images-test"),
    safeRmSync: sinon.stub(),
    safeSpawnSync: sinon.stub().returns({ status: 1, stdout: "", stderr: "" }),
    safeWriteSync: sinon.stub(),
    ...utilsOverrides,
  };
  const dockerModule = await esmock("./docker.js", {
    ...(osStub ? { "node:os": osStub } : {}),
    "node:fs": fsStub,
    "node:stream/promises": {
      pipeline: sinon.stub().resolves(),
      ...streamOverrides,
    },
    "./dockerConnection.js": {
      createDaemonConnection: createDaemonConnectionStub,
    },
    tar: {
      x: sinon.stub().returns("extractor"),
      ...tarOverrides,
    },
    "../core/activity.js": utilsStub,
    "../core/fs.js": utilsStub,
    "../inventory/envcontext.js": utilsStub,
    "../inventory/evidenceUtils.js": utilsStub,
    "../inventory/osPackageResolver.js": utilsStub,
    "../inventory/depsUtils.js": utilsStub,
    "../inventory/osqueryTransform.js": utilsStub,
  });
  return {
    createDaemonConnectionStub,
    daemonConnection,
    dockerClient,
    dockerModule,
    fsStub,
    utilsStub,
  };
}

const decodeRegistryAuthHeader = (header) =>
  JSON.parse(Buffer.from(header, "base64url").toString("utf-8"));

const dockerConfigExistsStub = () =>
  sinon.stub().callsFake((filePath) => filePath.endsWith("config.json"));

const encodedAuth = Buffer.from("trusted-user:trusted-pass").toString("base64");

const authConfigData = (configuredRegistry) =>
  JSON.stringify({
    auths: {
      [configuredRegistry]: {
        auth: encodedAuth,
      },
    },
  });

const credHelperConfigData = (configuredRegistry) =>
  JSON.stringify({
    credHelpers: {
      [configuredRegistry]: "osxkeychain",
    },
  });

const credHelperExe = (helperSuffix) =>
  isWin
    ? `docker-credential-${helperSuffix}.exe`
    : `docker-credential-${helperSuffix}`;

async function loadDockerModuleWithAuths(configuredRegistry) {
  return await loadDockerModule({
    fsOverrides: {
      readFileSync: sinon.stub().returns(authConfigData(configuredRegistry)),
    },
    utilsOverrides: {
      safeExistsSync: dockerConfigExistsStub(),
    },
  });
}

async function loadDockerModuleWithCredHelpers(
  configuredRegistry,
  safeSpawnSync,
) {
  return await loadDockerModule({
    fsOverrides: {
      readFileSync: sinon
        .stub()
        .returns(credHelperConfigData(configuredRegistry)),
    },
    utilsOverrides: {
      safeExistsSync: dockerConfigExistsStub(),
      safeSpawnSync,
    },
  });
}

const withDockerConfig = async (callback) => {
  const originalDockerConfig = process.env.DOCKER_CONFIG;
  process.env.DOCKER_CONFIG = "/tmp/cdxgen-docker-config";
  try {
    await callback();
  } finally {
    if (originalDockerConfig === undefined) {
      delete process.env.DOCKER_CONFIG;
    } else {
      process.env.DOCKER_CONFIG = originalDockerConfig;
    }
  }
};

const withEnv = async (updates, callback) => {
  const originalEnv = {};
  for (const envKey of Object.keys(updates)) {
    originalEnv[envKey] = process.env[envKey];
    if (updates[envKey] === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = updates[envKey];
    }
  }
  try {
    await callback();
  } finally {
    for (const envKey of Object.keys(updates)) {
      if (originalEnv[envKey] === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalEnv[envKey];
      }
    }
  }
};

await it("docker connection uses the detected daemon client", async () => {
  const { dockerModule, createDaemonConnectionStub, daemonConnection } =
    await loadDockerModule();
  const dockerConn = await dockerModule.getConnection();
  // getConnection probes the daemon with a "_ping" request and returns the
  // established connection.
  assert.strictEqual(dockerConn, daemonConnection);
  sinon.assert.calledOnce(createDaemonConnectionStub);
  sinon.assert.calledWith(
    daemonConnection.request,
    "_ping",
    sinon.match.has("method", "GET"),
  );
});

await it("docker getImage returns inspect data from the daemon client", async () => {
  const inspectData = {
    Id: "sha256:hello-world",
    RepoTags: ["hello-world:latest"],
  };
  const { dockerModule, dockerClient } = await loadDockerModule({
    clientResponse: inspectData,
  });
  const imageData = await dockerModule.getImage("hello-world:latest");
  assert.deepStrictEqual(imageData, inspectData);
  sinon.assert.calledWith(
    dockerClient,
    "images/hello-world:latest/json",
    sinon.match.has("method", "GET"),
  );
});

await it("docker getImage falls back to the daemon client when cli inspect fails", async () => {
  const originalDockerUseCli = process.env.DOCKER_USE_CLI;
  process.env.DOCKER_USE_CLI = "1";
  try {
    const inspectData = {
      Id: "sha256:hello-world",
      RepoTags: ["hello-world:latest"],
    };
    const { dockerModule, dockerClient } = await loadDockerModule({
      clientResponse: inspectData,
    });
    const imageData = await dockerModule.getImage("hello-world:latest");
    assert.deepStrictEqual(imageData, inspectData);
    sinon.assert.calledWith(
      dockerClient,
      "images/hello-world:latest/json",
      sinon.match.has("method", "GET"),
    );
  } finally {
    if (originalDockerUseCli === undefined) {
      delete process.env.DOCKER_USE_CLI;
    } else {
      process.env.DOCKER_USE_CLI = originalDockerUseCli;
    }
  }
});

await it("docker getImage uses nerdctl when DOCKER_CMD is configured", async () => {
  const originalDockerCmd = process.env.DOCKER_CMD;
  const originalDockerUseCli = process.env.DOCKER_USE_CLI;
  process.env.DOCKER_CMD = "nerdctl";
  delete process.env.DOCKER_USE_CLI;
  try {
    const inspectData = {
      Id: "sha256:hello-world",
      RepoTags: ["hello-world:latest"],
    };
    const safeSpawnSync = sinon.stub();
    safeSpawnSync.returns({
      status: 0,
      stdout: JSON.stringify([inspectData]),
      stderr: "",
    });
    const { dockerModule, utilsStub } = await loadDockerModule({
      clientResponse: inspectData,
      utilsOverrides: {
        safeSpawnSync,
      },
    });
    const imageData = await dockerModule.getImage("hello-world:latest");
    assert.deepStrictEqual(imageData, inspectData);
    // The local image is answered by inspecting the reference itself, so no
    // listing and no pull run.
    sinon.assert.calledOnceWithExactly(safeSpawnSync, "nerdctl", [
      "image",
      "inspect",
      "hello-world:latest",
    ]);
    sinon.assert.notCalled(utilsStub.safeMkdirSync);
  } finally {
    if (originalDockerCmd === undefined) {
      delete process.env.DOCKER_CMD;
    } else {
      process.env.DOCKER_CMD = originalDockerCmd;
    }
    if (originalDockerUseCli === undefined) {
      delete process.env.DOCKER_USE_CLI;
    } else {
      process.env.DOCKER_USE_CLI = originalDockerUseCli;
    }
  }
});

// wslc (WSL Containers, GA with WSL 3.x) is a docker-compatible container CLI
// that ships with WSL. cdxgen selects it on Windows when the docker CLI is
// missing so `cdxgen -t oci <image>` works on WSL-only hosts.
const wslcInspectData = {
  Id: "sha256:abcdef0123456789",
  RepoTags: ["alpine:latest"],
  RepoDigests: ["alpine@sha256:0123456789abcdef"],
  Config: {
    Env: ["PATH=/usr/local/sbin:/usr/local/bin"],
    WorkingDir: "/",
  },
};

const WSLC_SESSION_HINT = "wslc container session could not start";
const WSLC_ALTERNATIVE_HINT = "Set the environment variable DOCKER_CMD=wslc";
const DOCKER_MISSING = {
  status: 127,
  stdout: "",
  stderr: "",
  error: { code: "ENOENT" },
};
const WSLC_VERSION = { status: 0, stdout: "wslc 3.0.1.0\r\n", stderr: "" };
const HCS_FAILURE = {
  status: 1,
  stdout: "",
  stderr:
    "WSL2 is unable to start since virtualization is not enabled on this machine.\nError code: HCS_E_HYPERV_NOT_INSTALLED\n",
};

/**
 * Build a safeSpawnSync stub that answers by command line rather than call
 * order, so the tests stay valid when the probe sequence changes. Unlisted
 * commands fail like a missing binary.
 */
const fakeContainerCli = (responses) =>
  sinon.stub().callsFake((cmd, args = []) => {
    const cmdLine = [cmd, ...args].join(" ");
    const match = Object.keys(responses)
      .filter(
        (prefix) => cmdLine === prefix || cmdLine.startsWith(`${prefix} `),
      )
      .sort((a, b) => b.length - a.length)[0];
    return match ? responses[match] : DOCKER_MISSING;
  });

/**
 * Run a test with the container CLI environment variables cleared (or set as
 * given), restoring the caller's values afterwards. A developer or CI shell
 * with DOCKER_CMD set would otherwise change which CLI gets selected.
 */
const withContainerCliEnv = async (env, fn) => {
  const names = ["DOCKER_CMD", "DOCKER_USE_CLI", "DOCKER_HOST"];
  const saved = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  for (const name of names) {
    if (env[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = env[name];
    }
  }
  try {
    return await fn();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  }
};

const loggedLines = (consoleLogStub) =>
  consoleLogStub.getCalls().map((call) => call.args.join(" "));

const countLogged = (consoleLogStub, text) =>
  loggedLines(consoleLogStub).filter((line) => line.includes(text)).length;

/**
 * Load docker.js with every daemon endpoint unreachable, so getImage exhausts
 * its daemon fallback exactly like a host without a running Docker or Podman.
 */
const loadDockerModuleWithoutDaemon = async (options) => {
  const loaded = await loadDockerModule(options);
  loaded.dockerClient.rejects(new Error("connect ENOENT"));
  return loaded;
};

/**
 * Capture console output for a test. The daemon fallback warns about Docker
 * Desktop on every miss, which would otherwise clutter the test log.
 */
const withCapturedConsole = async (fn) => {
  const consoleLogStub = sinon.stub(console, "log");
  const consoleWarnStub = sinon.stub(console, "warn");
  try {
    return await fn(consoleLogStub);
  } finally {
    consoleLogStub.restore();
    consoleWarnStub.restore();
  }
};

await it("docker getContainerCliCmd prefers wslc on Windows when docker is missing", async () => {
  await withContainerCliEnv({}, async () => {
    const safeSpawnSync = fakeContainerCli({ "wslc version": WSLC_VERSION });
    const { dockerModule, utilsStub } = await loadDockerModule({
      osOverrides: { platform: () => "win32" },
      utilsOverrides: { safeSpawnSync },
    });
    assert.strictEqual(dockerModule.getContainerCliCmd(), "wslc");
    assert.strictEqual(dockerModule.getContainerCliCmd(), "wslc");
    sinon.assert.calledWithExactly(safeSpawnSync, "docker", ["--version"]);
    sinon.assert.calledWithExactly(safeSpawnSync, "wslc", ["version"]);
    // Both probes are cached for the process.
    sinon.assert.calledTwice(safeSpawnSync);
    // The selection is recorded once in the activity log, not per call.
    sinon.assert.calledOnceWithMatch(
      utilsStub.recordDecisionActivity,
      "container-cli:wslc",
      {
        metadata: {
          decisionType: "container-cli-selection",
          selectedCli: "wslc",
        },
      },
    );
  });
});

await it("docker getContainerCliCmd keeps docker when both CLIs are installed", async () => {
  await withContainerCliEnv({}, async () => {
    const safeSpawnSync = fakeContainerCli({
      "docker --version": {
        status: 0,
        stdout: "Docker version 27.0.1\n",
        stderr: "",
      },
      "wslc version": WSLC_VERSION,
    });
    const { dockerModule, utilsStub } = await loadDockerModule({
      osOverrides: { platform: () => "win32" },
      utilsOverrides: { safeSpawnSync },
    });
    assert.strictEqual(dockerModule.getContainerCliCmd(), "docker");
    sinon.assert.calledOnceWithExactly(safeSpawnSync, "docker", ["--version"]);
    sinon.assert.notCalled(utilsStub.recordDecisionActivity);
  });
});

await it("docker getContainerCliCmd keeps docker on Windows when neither CLI is installed", async () => {
  await withContainerCliEnv({}, async () => {
    const safeSpawnSync = fakeContainerCli({});
    const { dockerModule } = await loadDockerModule({
      osOverrides: { platform: () => "win32" },
      utilsOverrides: { safeSpawnSync },
    });
    assert.strictEqual(dockerModule.getContainerCliCmd(), "docker");
    sinon.assert.calledWithExactly(safeSpawnSync, "wslc", ["version"]);
  });
});

await it("docker getContainerCliCmd never selects wslc outside Windows", async () => {
  await withContainerCliEnv({}, async () => {
    const safeSpawnSync = fakeContainerCli({ "wslc version": WSLC_VERSION });
    const { dockerModule } = await loadDockerModule({
      osOverrides: { platform: () => "darwin" },
      utilsOverrides: { safeSpawnSync },
    });
    assert.strictEqual(dockerModule.getContainerCliCmd(), "docker");
    for (const call of safeSpawnSync.getCalls()) {
      assert.notEqual(call.args[0], "wslc");
      assert.notEqual(call.args[0], "docker");
    }
  });
});

await it("docker getContainerCliCmd honours an explicit DOCKER_CMD override", async () => {
  await withContainerCliEnv({ DOCKER_CMD: "wslc" }, async () => {
    const safeSpawnSync = sinon.stub();
    const { dockerModule } = await loadDockerModule({
      osOverrides: { platform: () => "linux" },
      utilsOverrides: { safeSpawnSync },
    });
    assert.strictEqual(dockerModule.getContainerCliCmd(), "wslc");
    sinon.assert.notCalled(safeSpawnSync);
  });
});

await it("docker getImage and exportImage pass only image references to the CLI or daemon", async () => {
  const notReferences = [
    // An option where the image argument goes: docker save -o <tar> -o<file>
    "-o/tmp/owned:latest",
    "--platform=linux/amd64 alpine:latest",
    // The CLI receives the string as is, so a reference that is valid only
    // once trimmed is not one.
    " alpine:latest",
    "alpine:latest\n",
    "../images/app:latest",
    "file:///etc/passwd:latest",
  ];
  // The CLI path (DOCKER_CMD) and the daemon path (Linux default).
  for (const env of [{ DOCKER_CMD: "docker" }, {}]) {
    await withContainerCliEnv(env, async () => {
      const safeSpawnSync = sinon
        .stub()
        .returns({ status: 0, stdout: "", stderr: "" });
      const { dockerModule, dockerClient } = await loadDockerModule({
        osOverrides: { platform: () => "linux" },
        utilsOverrides: { safeSpawnSync },
      });
      await withCapturedConsole(async (consoleLogStub) => {
        for (const name of notReferences) {
          assert.strictEqual(await dockerModule.getImage(name), undefined);
          assert.strictEqual(
            await dockerModule.exportImage(name, {}),
            undefined,
          );
        }
        assert.strictEqual(
          countLogged(
            consoleLogStub,
            "is not a valid container image reference",
          ),
          notReferences.length * 2,
        );
      });
      for (const call of safeSpawnSync.getCalls()) {
        assert.ok(
          !["image", "images", "inspect", "pull", "save"].includes(
            call.args[1]?.[0],
          ),
          `unexpected ${call.args[0]} ${call.args[1]?.join(" ")}`,
        );
      }
      sinon.assert.notCalled(dockerClient);
    });
  }
});

await it("docker getImage pulls and inspects via wslc on Windows", async () => {
  await withContainerCliEnv({}, async () => {
    // A stateful double: the store starts empty, and a pull makes the
    // inspect of that reference answer with the image data.
    const pulled = new Set();
    const safeSpawnSync = sinon.stub().callsFake((cmd, args = []) => {
      if (cmd === "wslc" && args[0] === "version") {
        return WSLC_VERSION;
      }
      if (cmd !== "wslc") {
        return DOCKER_MISSING;
      }
      if (args[0] === "pull") {
        pulled.add(args[1]);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return pulled.has(args[2])
          ? { status: 0, stdout: JSON.stringify([wslcInspectData]), stderr: "" }
          : {
              status: 1,
              stdout: "",
              stderr: "Error: No such image: alpine:latest\n",
            };
      }
      return DOCKER_MISSING;
    });
    const { dockerModule, dockerClient } = await loadDockerModule({
      osOverrides: { platform: () => "win32" },
      utilsOverrides: { safeSpawnSync },
    });
    const imageData = await dockerModule.getImage("alpine:latest");
    assert.deepStrictEqual(imageData, wslcInspectData);
    sinon.assert.calledWithExactly(safeSpawnSync, "wslc", [
      "pull",
      "alpine:latest",
    ]);
    // A successful CLI inspect never falls through to the daemon client.
    sinon.assert.notCalled(dockerClient);
  });
});

await it("docker getImage reuses an image already in the wslc store", async () => {
  await withContainerCliEnv({}, async () => {
    const safeSpawnSync = fakeContainerCli({
      "wslc version": WSLC_VERSION,
      "wslc image inspect alpine:3.20": {
        status: 0,
        stdout: JSON.stringify([wslcInspectData]),
        stderr: "",
      },
    });
    const { dockerModule } = await loadDockerModule({
      osOverrides: { platform: () => "win32" },
      utilsOverrides: { safeSpawnSync },
    });
    assert.deepStrictEqual(
      await dockerModule.getImage("alpine:3.20"),
      wslcInspectData,
    );
    // The reference itself answered, so no pull and no listing ran. The
    // wslc selection probes (docker --version, wslc version) are the only
    // other calls.
    sinon.assert.calledWithExactly(safeSpawnSync, "wslc", [
      "image",
      "inspect",
      "alpine:3.20",
    ]);
    for (const call of safeSpawnSync.getCalls()) {
      assert.notEqual(call.args[1]?.[0], "pull");
    }
  });
});

await it("docker getImage explains wslc session startup failures once", async () => {
  await withContainerCliEnv({}, async () => {
    await withCapturedConsole(async (consoleLogStub) => {
      const safeSpawnSync = fakeContainerCli({
        "wslc version": WSLC_VERSION,
        "wslc image inspect": HCS_FAILURE,
        "wslc pull": HCS_FAILURE,
      });
      const { dockerModule } = await loadDockerModuleWithoutDaemon({
        osOverrides: { platform: () => "win32" },
        utilsOverrides: { safeSpawnSync },
      });
      // A compose file or Kubernetes manifest exports several images in one
      // process; the hint must not repeat for each of them.
      await dockerModule.getImage("alpine:latest");
      await dockerModule.getImage("busybox:latest");
      assert.strictEqual(countLogged(consoleLogStub, WSLC_SESSION_HINT), 1);
      assert.ok(
        loggedLines(consoleLogStub).some((line) =>
          line.includes("Try manually pulling this image using wslc pull"),
        ),
      );
      // wslc was auto-selected, so the docker alternative hint never applies.
      assert.strictEqual(countLogged(consoleLogStub, WSLC_ALTERNATIVE_HINT), 0);
    });
  });
});

await it("docker getImage does not fall back to a Docker daemon for wslc", async () => {
  await withContainerCliEnv({ DOCKER_CMD: "wslc" }, async () => {
    await withCapturedConsole(async (consoleLogStub) => {
      const safeSpawnSync = fakeContainerCli({
        "wslc image inspect": { status: 0, stdout: "", stderr: "" },
        "wslc pull": HCS_FAILURE,
      });
      // A reachable daemon that knows the image: exportImage would still save
      // through wslc, so its inspect data must not be used.
      const { dockerModule, dockerClient } = await loadDockerModule({
        osOverrides: { platform: () => "win32" },
        utilsOverrides: { safeSpawnSync },
      });
      assert.strictEqual(
        await dockerModule.getImage("alpine:latest"),
        undefined,
      );
      assert.strictEqual(
        await dockerModule.exportImage("alpine:latest", {}),
        undefined,
      );
      sinon.assert.notCalled(dockerClient);
      assert.strictEqual(
        countLogged(
          consoleLogStub,
          "Try manually pulling this image using wslc pull alpine:latest",
        ),
        2,
      );
      for (const call of safeSpawnSync.getCalls()) {
        assert.notEqual(call.args[1]?.[0], "save");
      }
    });
  });
});

await it("docker getImage shows wslc pull errors instead of docker hints", async () => {
  for (const pullError of [
    "Error response from daemon: manifest for nosuch/image:latest not found: manifest unknown: manifest unknown\n",
    // wslc runs Docker Engine inside its VM, so errors can name that daemon.
    "Error: docker daemon is not running inside the wslc session\n",
  ]) {
    await withContainerCliEnv({}, async () => {
      await withCapturedConsole(async (consoleLogStub) => {
        const safeSpawnSync = fakeContainerCli({
          "wslc version": WSLC_VERSION,
          "wslc image inspect": {
            status: 1,
            stdout: "",
            stderr: "Error: No such image: nosuch/image:latest\n",
          },
          "wslc pull": { status: 1, stdout: "", stderr: pullError },
        });
        const { dockerModule } = await loadDockerModuleWithoutDaemon({
          osOverrides: { platform: () => "win32" },
          utilsOverrides: { safeSpawnSync },
        });
        await dockerModule.getImage("nosuch/image:latest");
        const lines = loggedLines(consoleLogStub);
        assert.ok(lines.includes(pullError));
        assert.ok(
          !lines.some(
            (line) =>
              line.includes("to use an alternative command such as nerdctl") ||
              line.includes("Ensure Docker for Desktop is running"),
          ),
        );
        assert.strictEqual(countLogged(consoleLogStub, WSLC_SESSION_HINT), 0);
      });
    });
  }
});

await it("docker getImage recognises wslc configured by path", async () => {
  await withContainerCliEnv(
    { DOCKER_CMD: "C:\\Program Files\\WSL\\wslc.exe" },
    async () => {
      await withCapturedConsole(async (consoleLogStub) => {
        const safeSpawnSync = fakeContainerCli({
          "C:\\Program Files\\WSL\\wslc.exe images": HCS_FAILURE,
          "C:\\Program Files\\WSL\\wslc.exe pull": HCS_FAILURE,
          "C:\\Program Files\\WSL\\wslc.exe inspect": HCS_FAILURE,
        });
        const { dockerModule } = await loadDockerModuleWithoutDaemon({
          osOverrides: { platform: () => "win32" },
          utilsOverrides: { safeSpawnSync },
        });
        await dockerModule.getImage("alpine:latest");
        assert.strictEqual(countLogged(consoleLogStub, WSLC_SESSION_HINT), 1);
      });
    },
  );
});

await it("docker getImage points at wslc when the docker CLI cannot provide the image", async () => {
  await withContainerCliEnv({}, async () => {
    await withCapturedConsole(async (consoleLogStub) => {
      // GitHub's windows runners ship a docker CLI bound to a Windows
      // containers daemon, which cannot pull Linux images.
      const safeSpawnSync = fakeContainerCli({
        "docker --version": {
          status: 0,
          stdout: "Docker version 27.5.1, build 9f9e405\n",
          stderr: "",
        },
        "docker images": { status: 0, stdout: "", stderr: "" },
        "docker pull": {
          status: 1,
          stdout: "",
          stderr:
            "no matching manifest for windows(10.0.26100)/amd64 in the manifest list entries\n",
        },
        "docker inspect": {
          status: 1,
          stdout: "",
          stderr: "Error: No such object: alpine:3.20\n",
        },
        "wslc version": WSLC_VERSION,
      });
      const { dockerModule } = await loadDockerModuleWithoutDaemon({
        osOverrides: { platform: () => "win32" },
        utilsOverrides: { safeSpawnSync },
      });
      await dockerModule.getImage("alpine:3.20");
      await dockerModule.getImage("busybox:latest");
      assert.strictEqual(countLogged(consoleLogStub, WSLC_ALTERNATIVE_HINT), 1);
      // cdxgen suggests wslc but never switches image stores on its own.
      for (const call of safeSpawnSync.getCalls()) {
        if (call.args[0] === "wslc") {
          assert.deepStrictEqual(call.args[1], ["version"]);
        }
      }
      assert.ok(
        loggedLines(consoleLogStub).some((line) =>
          line.includes("Try manually pulling this image using docker pull"),
        ),
      );
    });
  });
});

await it("docker getImage skips the wslc hint when docker is chosen explicitly or wslc is absent", async () => {
  const dockerFailures = {
    "docker --version": {
      status: 0,
      stdout: "Docker version 27\n",
      stderr: "",
    },
    "docker images": { status: 1, stdout: "", stderr: "" },
    "docker pull": { status: 1, stdout: "", stderr: "daemon error\n" },
    "docker inspect": { status: 1, stdout: "", stderr: "daemon error\n" },
  };
  for (const { env, responses } of [
    {
      env: { DOCKER_CMD: "docker" },
      responses: { ...dockerFailures, "wslc version": WSLC_VERSION },
    },
    { env: {}, responses: dockerFailures },
  ]) {
    await withContainerCliEnv(env, async () => {
      await withCapturedConsole(async (consoleLogStub) => {
        const { dockerModule } = await loadDockerModuleWithoutDaemon({
          osOverrides: { platform: () => "win32" },
          utilsOverrides: { safeSpawnSync: fakeContainerCli(responses) },
        });
        await dockerModule.getImage("alpine:3.20");
        assert.strictEqual(
          countLogged(consoleLogStub, WSLC_ALTERNATIVE_HINT),
          0,
        );
      });
    });
  }
});

await it("docker getImage names docker in the manual pull hint when no CLI was used", async () => {
  await withContainerCliEnv({}, async () => {
    await withCapturedConsole(async (consoleLogStub) => {
      const safeSpawnSync = sinon.stub().returns({ status: 1 });
      const { dockerModule } = await loadDockerModuleWithoutDaemon({
        osOverrides: { platform: () => "linux" },
        utilsOverrides: { safeSpawnSync },
      });
      await dockerModule.getImage("alpine:3.20");
      assert.ok(
        loggedLines(consoleLogStub).some((line) =>
          line.includes("Try manually pulling this image using docker pull"),
        ),
      );
      sinon.assert.notCalled(safeSpawnSync);
    });
  });
});

await it("docker exportImage explains wslc session startup failures on save", async () => {
  await withContainerCliEnv({}, async () => {
    await withCapturedConsole(async (consoleLogStub) => {
      const safeSpawnSync = fakeContainerCli({
        "wslc version": WSLC_VERSION,
        // The local store already has alpine:latest, so no pull happens.
        "wslc image inspect alpine:latest": {
          status: 0,
          stdout: JSON.stringify([wslcInspectData]),
          stderr: "",
        },
        // wslc save fails because the WSL container session cannot start.
        "wslc save": {
          status: 1,
          stdout: "",
          stderr: "Error code: HCS_E_HYPERV_NOT_INSTALLED\n",
        },
      });
      const { dockerModule } = await loadDockerModuleWithoutDaemon({
        osOverrides: { platform: () => "win32" },
        utilsOverrides: { safeSpawnSync },
      });
      const result = await dockerModule.exportImage("alpine:latest", {});
      // exportImage keeps the inspect data collected so far and skips layer
      // extraction when the save fails.
      assert.deepStrictEqual(result, wslcInspectData);
      sinon.assert.calledWithMatch(safeSpawnSync, "wslc", [
        "save",
        "-o",
        sinon.match.string,
        "alpine:latest",
      ]);
      assert.strictEqual(countLogged(consoleLogStub, WSLC_SESSION_HINT), 1);
    });
  });
});

await it("docker getConnection reports blocked network activity in dry-run mode", async () => {
  const recordActivity = sinon.stub();
  const { dockerModule } = await loadDockerModule({
    utilsOverrides: {
      isDryRun: true,
      recordActivity,
    },
  });
  const conn = await dockerModule.getConnection({}, "docker.io");
  assert.strictEqual(conn, undefined);
  sinon.assert.calledWithMatch(recordActivity, {
    kind: "network",
    status: "blocked",
    target: "docker.io",
  });
});

await it("docker getConnection skips dry-run tracing on containerd runtimes", async () => {
  const recordActivity = sinon.stub();
  const recordSensitiveFileRead = sinon.stub();
  await withEnv(
    {
      CONTAINERD_ADDRESS: "/run/containerd/containerd.sock",
    },
    async () => {
      const { dockerModule } = await loadDockerModule({
        fsOverrides: {
          readFileSync: sinon.stub().returns(authConfigData("docker.io")),
        },
        utilsOverrides: {
          isDryRun: true,
          recordActivity,
          recordSensitiveFileRead,
          safeExistsSync: dockerConfigExistsStub(),
        },
      });
      const conn = await dockerModule.getConnection({}, "docker.io");
      assert.strictEqual(conn, undefined);
    },
  );
  sinon.assert.notCalled(recordActivity);
  sinon.assert.notCalled(recordSensitiveFileRead);
});

await it("docker getConnection traces docker credential file reads in dry-run mode", async () => {
  const recordActivity = sinon.stub();
  const recordSensitiveFileRead = sinon.stub();
  await withDockerConfig(async () => {
    const { dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(authConfigData("docker.io")),
      },
      utilsOverrides: {
        isDryRun: true,
        recordActivity,
        recordSensitiveFileRead,
        safeExistsSync: dockerConfigExistsStub(),
      },
    });
    await dockerModule.getConnection({}, "docker.io");
  });
  sinon.assert.calledWithMatch(recordSensitiveFileRead, sinon.match.string, {
    label: "Docker credential file",
  });
  sinon.assert.calledWithMatch(recordActivity, {
    kind: "network",
    status: "blocked",
    target: "docker.io",
  });
});

await it("docker makeRequest does not trace docker credential file reads when the read fails", async () => {
  const recordSensitiveFileRead = sinon.stub();
  await withEnv(
    {
      DOCKER_AUTH_CONFIG: undefined,
      DOCKER_EMAIL: undefined,
      DOCKER_PASSWORD: undefined,
      DOCKER_USER: undefined,
    },
    async () => {
      await withDockerConfig(async () => {
        const { dockerModule } = await loadDockerModule({
          fsOverrides: {
            readFileSync: sinon.stub().throws(new Error("read failed")),
          },
          utilsOverrides: {
            recordSensitiveFileRead,
            safeExistsSync: dockerConfigExistsStub(),
          },
        });
        await assert.rejects(() =>
          dockerModule.makeRequest(
            "images/create?fromImage=docker.io/library/alpine:latest",
            "POST",
            "docker.io/library/alpine:latest",
          ),
        );
      });
    },
  );
  sinon.assert.notCalled(recordSensitiveFileRead);
});

await it("docker getConnection does not trace TLS client files when reading them fails", async () => {
  const recordSensitiveFileRead = sinon.stub();
  await withEnv(
    {
      DOCKER_AUTH_CONFIG: undefined,
      DOCKER_CERT_PATH: "/tmp/docker-certs",
      DOCKER_EMAIL: undefined,
      DOCKER_HOST: "tcp://docker.example.test:2376",
      DOCKER_PASSWORD: undefined,
      DOCKER_USER: undefined,
    },
    async () => {
      const { dockerModule } = await loadDockerModule({
        fsOverrides: {
          readFileSync: sinon
            .stub()
            .onFirstCall()
            .throws(new Error("cert read failed")),
        },
        utilsOverrides: {
          recordSensitiveFileRead,
        },
      });
      await assert.rejects(() => dockerModule.getConnection({}, "docker.io"));
    },
  );
  sinon.assert.notCalled(recordSensitiveFileRead);
});

await it("docker makeRequest does not trace TLS client files when reading them fails", async () => {
  const recordSensitiveFileRead = sinon.stub();
  await withEnv(
    {
      DOCKER_AUTH_CONFIG: undefined,
      DOCKER_CERT_PATH: "/tmp/docker-certs",
      DOCKER_EMAIL: undefined,
      DOCKER_HOST: "tcp://docker.example.test:2376",
      DOCKER_PASSWORD: undefined,
      DOCKER_USER: undefined,
    },
    async () => {
      const { dockerModule } = await loadDockerModule({
        fsOverrides: {
          readFileSync: sinon
            .stub()
            .onFirstCall()
            .throws(new Error("cert read failed")),
        },
        utilsOverrides: {
          recordSensitiveFileRead,
        },
      });
      await assert.rejects(() =>
        dockerModule.makeRequest(
          "images/create?fromImage=docker.io/library/alpine:latest",
          "POST",
          "docker.io/library/alpine:latest",
        ),
      );
    },
  );
  sinon.assert.notCalled(recordSensitiveFileRead);
});

await it("docker getConnection records which credential source was selected", async () => {
  const recordDecisionActivity = sinon.stub();
  await withDockerConfig(async () => {
    const { dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(authConfigData("docker.io")),
      },
      utilsOverrides: {
        isDryRun: true,
        recordDecisionActivity,
        safeExistsSync: dockerConfigExistsStub(),
      },
    });
    await dockerModule.getConnection({}, "docker.io");
  });
  sinon.assert.calledWithMatch(
    recordDecisionActivity,
    "docker-auth:docker.io",
    {
      metadata: sinon.match({
        decisionType: "credential-source-selection",
        selectedSource: "docker-config-auth",
      }),
    },
  );
});

await it("docker getConnection traces credential helper resolution in dry-run mode", async () => {
  const safeSpawnSync = sinon.stub().returns({
    status: 1,
    stdout: "",
    stderr: "",
  });
  await withDockerConfig(async () => {
    const { dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(credHelperConfigData("docker.io")),
      },
      utilsOverrides: {
        isDryRun: true,
        safeExistsSync: dockerConfigExistsStub(),
        safeSpawnSync,
      },
    });
    await dockerModule.getConnection({}, "docker.io");
  });
  sinon.assert.calledWithExactly(
    safeSpawnSync,
    credHelperExe("osxkeychain"),
    ["get"],
    {
      input: "docker.io",
    },
  );
});

await it("docker extractTar reports a blocked untar activity in dry-run mode", async () => {
  const safeExtractArchive = sinon.stub().resolves(false);
  const { dockerModule } = await loadDockerModule({
    utilsOverrides: {
      safeExtractArchive,
    },
  });
  const result = await dockerModule.extractTar(
    "/tmp/image.tar",
    "/tmp/out",
    {},
  );
  assert.strictEqual(result, false);
  sinon.assert.calledWithMatch(
    safeExtractArchive,
    "/tmp/image.tar",
    "/tmp/out",
    sinon.match.func,
    "untar",
    {
      blockedReason:
        "Dry run mode blocks untar and layer extraction operations because they create files on disk.",
      metadata: {
        archiveFormat: "tar",
      },
    },
  );
});

await it("docker extractTar delegates successful untar tracing to safeExtractArchive", async () => {
  const safeExtractArchive = sinon.stub().resolves(true);
  const { dockerModule } = await loadDockerModule({
    utilsOverrides: {
      safeExtractArchive,
    },
  });
  const result = await dockerModule.extractTar(
    "/tmp/image.tar",
    "/tmp/out",
    {},
  );
  assert.strictEqual(result, true);
  sinon.assert.calledOnce(safeExtractArchive);
});

await it("docker extractTar preserves failure handling after safeExtractArchive rejects", async () => {
  const extractionError = new Error("permission denied");
  extractionError.code = "EACCES";
  const safeExtractArchive = sinon.stub().rejects(extractionError);
  const { dockerModule } = await loadDockerModule({
    utilsOverrides: {
      safeExtractArchive,
    },
  });
  const result = await dockerModule.extractTar(
    "/tmp/image.tar",
    "/tmp/out",
    {},
  );
  assert.strictEqual(result, false);
  sinon.assert.calledOnce(safeExtractArchive);
});

await it("docker exportImage reports a blocked container activity in dry-run mode", async () => {
  const recordActivity = sinon.stub();
  const recordSensitiveFileRead = sinon.stub();
  await withDockerConfig(async () => {
    const { dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(authConfigData("docker.io")),
      },
      utilsOverrides: {
        isDryRun: true,
        recordActivity,
        recordSensitiveFileRead,
        safeExistsSync: dockerConfigExistsStub(),
      },
    });
    const result = await dockerModule.exportImage("alpine:3.20", {});
    assert.strictEqual(result, undefined);
  });
  sinon.assert.calledWithMatch(recordSensitiveFileRead, sinon.match.string, {
    label: "Docker credential file",
  });
  sinon.assert.calledWithMatch(recordActivity, {
    kind: "container",
    status: "blocked",
    target: "alpine:3.20",
  });
});

await it("docker exportImage preserves scoped registry refs for dry-run auth tracing", async () => {
  const recordDecisionActivity = sinon.stub();
  await withDockerConfig(async () => {
    const { dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon
          .stub()
          .returns(authConfigData("registry.example.com/team")),
      },
      utilsOverrides: {
        isDryRun: true,
        recordDecisionActivity,
        safeExistsSync: dockerConfigExistsStub(),
      },
    });
    const result = await dockerModule.exportImage(
      "registry.example.com/team/app:latest",
      {},
    );
    assert.strictEqual(result, undefined);
  });
  sinon.assert.calledWithMatch(
    recordDecisionActivity,
    "docker-auth:registry.example.com/team/app",
    {
      metadata: sinon.match({
        selectedSource: "docker-config-auth",
      }),
    },
  );
});

await it("docker exportImage skips dry-run tracing for local paths", async () => {
  const recordActivity = sinon.stub();
  const recordSensitiveFileRead = sinon.stub();
  const { dockerModule } = await loadDockerModule({
    utilsOverrides: {
      isDryRun: true,
      recordActivity,
      recordSensitiveFileRead,
      safeExistsSync: sinon.stub().returns(true),
    },
  });
  const result = await dockerModule.exportImage("/tmp/image.tar", {});
  assert.strictEqual(result, undefined);
  sinon.assert.notCalled(recordActivity);
  sinon.assert.notCalled(recordSensitiveFileRead);
});

await it("docker exportImage ignores local directories", async () => {
  const imageData = await exportImage(".");
  assert.strictEqual(imageData, undefined);
});

await it("docker makeRequest prefers DOCKER_AUTH_CONFIG over config.json entries for all registries", async () => {
  await withDockerConfig(async () => {
    await withEnv(
      {
        DOCKER_AUTH_CONFIG: "opaque-global-auth-token",
      },
      async () => {
        const safeSpawnSync = sinon.stub().returns({
          status: 0,
          stdout: JSON.stringify({
            username: "helper-user",
            Secret: "helper-pass",
          }),
          stderr: "",
        });
        const { dockerClient, dockerModule } = await loadDockerModule({
          fsOverrides: {
            readFileSync: sinon.stub().returns(
              JSON.stringify({
                auths: {
                  "registry.example.com": {
                    auth: Buffer.from("trusted-user:trusted-pass").toString(
                      "base64",
                    ),
                  },
                },
                credHelpers: {
                  "registry.example.com": "osxkeychain",
                },
              }),
            ),
          },
          utilsOverrides: {
            safeExistsSync: dockerConfigExistsStub(),
            safeSpawnSync,
          },
        });

        await dockerModule.makeRequest(
          "images/create?fromImage=registry.example.com/team/app:latest",
          "POST",
          "registry.example.com/team/app",
        );

        const requestOptions = dockerClient.lastCall.args[1];
        assert.strictEqual(
          requestOptions.headers["X-Registry-Auth"],
          "opaque-global-auth-token",
        );
        sinon.assert.notCalled(safeSpawnSync);
      },
    );
  });
});

await it("docker makeRequest prefers DOCKER_USER credentials over matching config.json entries", async () => {
  await withDockerConfig(async () => {
    await withEnv(
      {
        DOCKER_USER: "env-user",
        DOCKER_PASSWORD: "env-pass",
        DOCKER_EMAIL: "env@example.com",
      },
      async () => {
        const { dockerClient, dockerModule } = await loadDockerModule({
          fsOverrides: {
            readFileSync: sinon.stub().returns(
              JSON.stringify({
                auths: {
                  "registry.example.com": {
                    auth: Buffer.from("trusted-user:trusted-pass").toString(
                      "base64",
                    ),
                  },
                },
              }),
            ),
          },
          utilsOverrides: {
            safeExistsSync: dockerConfigExistsStub(),
          },
        });

        await dockerModule.makeRequest(
          "images/create?fromImage=registry.example.com/team/app:latest",
          "POST",
          "registry.example.com/team/app",
        );

        const registryAuthHeader =
          dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
        assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
          username: "env-user",
          password: "env-pass",
          email: "env@example.com",
          serveraddress: "registry.example.com",
        });
      },
    );
  });
});

await it("docker makeRequest applies DOCKER_USER credentials regardless of configured registry entries", async () => {
  await withDockerConfig(async () => {
    await withEnv(
      {
        DOCKER_USER: "env-user",
        DOCKER_PASSWORD: "env-pass",
        DOCKER_EMAIL: "env@example.com",
      },
      async () => {
        const safeSpawnSync = sinon.stub().returns({
          status: 0,
          stdout: JSON.stringify({
            username: "helper-user",
            Secret: "helper-pass",
          }),
          stderr: "",
        });
        const { dockerClient, dockerModule } = await loadDockerModule({
          fsOverrides: {
            readFileSync: sinon.stub().returns(
              JSON.stringify({
                auths: {
                  "other-registry.example.com": {
                    auth: Buffer.from("trusted-user:trusted-pass").toString(
                      "base64",
                    ),
                  },
                },
                credHelpers: {
                  "other-registry.example.com": "osxkeychain",
                },
              }),
            ),
          },
          utilsOverrides: {
            safeExistsSync: dockerConfigExistsStub(),
            safeSpawnSync,
          },
        });

        await dockerModule.makeRequest(
          "images/create?fromImage=registry.example.com/team/app:latest",
          "POST",
          "registry.example.com/team/app",
        );

        const registryAuthHeader =
          dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
        assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
          username: "env-user",
          password: "env-pass",
          email: "env@example.com",
          serveraddress: "registry.example.com",
        });
        sinon.assert.notCalled(safeSpawnSync);
      },
    );
  });
});

await it("docker makeRequest does not forward auth for substring-matched registries", async () => {
  const originalDockerConfig = process.env.DOCKER_CONFIG;
  process.env.DOCKER_CONFIG = "/tmp/cdxgen-docker-config";
  try {
    const { dockerClient, dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(
          JSON.stringify({
            auths: {
              "private-registry.example.com": {
                auth: Buffer.from("trusted-user:trusted-pass").toString(
                  "base64",
                ),
              },
            },
          }),
        ),
      },
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => filePath.endsWith("config.json")),
      },
    });

    await dockerModule.makeRequest(
      "images/create?fromImage=registry.example.com/team/app:latest",
      "POST",
      "registry.example.com",
    );

    const requestOptions = dockerClient.lastCall.args[1];
    assert.strictEqual(requestOptions.headers, undefined);
  } finally {
    if (originalDockerConfig === undefined) {
      delete process.env.DOCKER_CONFIG;
    } else {
      process.env.DOCKER_CONFIG = originalDockerConfig;
    }
  }
});

await it("docker makeRequest accepts exact normalized registry matches from config auths", async () => {
  const originalDockerConfig = process.env.DOCKER_CONFIG;
  process.env.DOCKER_CONFIG = "/tmp/cdxgen-docker-config";
  try {
    const { dockerClient, dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(
          JSON.stringify({
            auths: {
              "https://registry.example.com/v2/": {
                auth: Buffer.from("trusted-user:trusted-pass").toString(
                  "base64",
                ),
              },
            },
          }),
        ),
      },
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => filePath.endsWith("config.json")),
      },
    });

    await dockerModule.makeRequest(
      "images/create?fromImage=registry.example.com/team/app:latest",
      "POST",
      "registry.example.com/team/app",
    );

    const registryAuthHeader =
      dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
    assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
      username: "trusted-user",
      password: "trusted-pass",
      serveraddress: "https://registry.example.com/v2/",
    });
  } finally {
    if (originalDockerConfig === undefined) {
      delete process.env.DOCKER_CONFIG;
    } else {
      process.env.DOCKER_CONFIG = originalDockerConfig;
    }
  }
});

await it("docker makeRequest accepts normalized exact matches across ipv4 ipv6 explicit ports and scoped subpaths from config auths", async () => {
  const cases = [
    {
      configuredRegistry: "127.0.0.1:5000",
      requestedRegistry: "127.0.0.1:5000/team/app",
      expectedServerAddress: "127.0.0.1:5000",
    },
    {
      configuredRegistry: "[::1]:5000",
      requestedRegistry: "[::1]:5000/team/app",
      expectedServerAddress: "[::1]:5000",
    },
    {
      configuredRegistry: "https://[2001:db8::1]:5000/v2/",
      requestedRegistry: "[2001:db8::1]:5000/team/app",
      expectedServerAddress: "https://[2001:db8::1]:5000/v2/",
    },
    {
      configuredRegistry: "HTTPS://REGISTRY.EXAMPLE.COM/V2/",
      requestedRegistry: "registry.example.com/team/app",
      expectedServerAddress: "HTTPS://REGISTRY.EXAMPLE.COM/V2/",
    },
    {
      configuredRegistry: "https://registry.example.com:443/v2/",
      requestedRegistry: "registry.example.com:443/team/app",
      expectedServerAddress: "https://registry.example.com:443/v2/",
    },
    {
      configuredRegistry: "http://registry.example.com:80/v2/",
      requestedRegistry: "registry.example.com:80/team/app",
      expectedServerAddress: "http://registry.example.com:80/v2/",
    },
    {
      configuredRegistry: "https://registry.example.com/custom/subpath",
      requestedRegistry: "registry.example.com/custom/subpath/team/app",
      expectedServerAddress: "https://registry.example.com/custom/subpath",
    },
    {
      configuredRegistry: "https://registry.example.com/custom/subpath/v2/",
      requestedRegistry: "registry.example.com/custom/subpath/team/app",
      expectedServerAddress: "https://registry.example.com/custom/subpath/v2/",
    },
  ];

  await withDockerConfig(async () => {
    for (const testCase of cases) {
      const { dockerClient, dockerModule } = await loadDockerModuleWithAuths(
        testCase.configuredRegistry,
      );

      await dockerModule.makeRequest(
        `images/create?fromImage=${testCase.requestedRegistry}:latest`,
        "POST",
        testCase.requestedRegistry,
      );

      const registryAuthHeader =
        dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
      assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
        username: "trusted-user",
        password: "trusted-pass",
        serveraddress: testCase.expectedServerAddress,
      });
    }
  });
});

await it("docker makeRequest rejects wildcard unicode bidi explicit-default-port port-boundary and unrelated scoped-path mismatches from config auths", async () => {
  const bidiRegistry = "reg\u202eistry.example.com";
  const unicodeConfusableRegistry = "reg\u0456stry.example.com";
  const cases = [
    {
      configuredRegistry: "*.example.com",
      requestedRegistry: "team.example.com/app",
    },
    {
      configuredRegistry: "registry.example.com",
      requestedRegistry: "registry.example.com:80/team/app",
    },
    {
      configuredRegistry: "registry.example.com:443",
      requestedRegistry: "registry.example.com/team/app",
    },
    {
      configuredRegistry: "127.0.0.1:5001",
      requestedRegistry: "127.0.0.1:5000/team/app",
    },
    {
      configuredRegistry: "[::1]:5001",
      requestedRegistry: "[::1]:5000/team/app",
    },
    {
      configuredRegistry: "https://registry.example.com.evil.invalid/v2/",
      requestedRegistry: "registry.example.com/team/app",
    },
    {
      configuredRegistry: "https://registry.example.com/custom/subpath",
      requestedRegistry: "registry.example.com/team/app",
    },
    {
      configuredRegistry: "https://registry.example.com/custom/subpath",
      requestedRegistry: "registry.example.com/custom/subpathology/team/app",
    },
    {
      configuredRegistry: "https://registry.example.com:443/v2/",
      requestedRegistry: "registry.example.com:444/team/app",
    },
    {
      configuredRegistry: unicodeConfusableRegistry,
      requestedRegistry: "registry.example.com/team/app",
    },
    {
      configuredRegistry: bidiRegistry,
      requestedRegistry: "registry.example.com/team/app",
    },
  ];

  await withDockerConfig(async () => {
    for (const testCase of cases) {
      const { dockerClient, dockerModule } = await loadDockerModuleWithAuths(
        testCase.configuredRegistry,
      );

      await dockerModule.makeRequest(
        `images/create?fromImage=${testCase.requestedRegistry}:latest`,
        "POST",
        testCase.requestedRegistry,
      );

      const requestOptions = dockerClient.lastCall.args[1];
      assert.strictEqual(requestOptions.headers, undefined);
    }
  });
});

await it("docker makeRequest accepts raw host:port registry matches from config auths", async () => {
  await withDockerConfig(async () => {
    const { dockerClient, dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(
          JSON.stringify({
            auths: {
              "localhost:5000": {
                auth: Buffer.from("trusted-user:trusted-pass").toString(
                  "base64",
                ),
              },
            },
          }),
        ),
      },
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => filePath.endsWith("config.json")),
      },
    });

    await dockerModule.makeRequest(
      "images/create?fromImage=localhost:5000/team/app:latest",
      "POST",
      "localhost:5000/team/app",
    );

    const registryAuthHeader =
      dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
    assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
      username: "trusted-user",
      password: "trusted-pass",
      serveraddress: "localhost:5000",
    });
  });
});

await it("docker makeRequest keeps raw host:port registries separated by port", async () => {
  await withDockerConfig(async () => {
    const { dockerClient, dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(
          JSON.stringify({
            auths: {
              "localhost:5001": {
                auth: Buffer.from("trusted-user:trusted-pass").toString(
                  "base64",
                ),
              },
            },
          }),
        ),
      },
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => filePath.endsWith("config.json")),
      },
    });

    await dockerModule.makeRequest(
      "images/create?fromImage=localhost:5000/team/app:latest",
      "POST",
      "localhost:5000/team/app",
    );

    const requestOptions = dockerClient.lastCall.args[1];
    assert.strictEqual(requestOptions.headers, undefined);
  });
});

await it("docker makeRequest preserves Docker Hub auth aliases without substring matching", async () => {
  const originalDockerConfig = process.env.DOCKER_CONFIG;
  process.env.DOCKER_CONFIG = "/tmp/cdxgen-docker-config";
  try {
    const { dockerClient, dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(
          JSON.stringify({
            auths: {
              "https://index.docker.io/v1/": {
                auth: Buffer.from("hub-user:hub-pass").toString("base64"),
              },
            },
          }),
        ),
      },
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => filePath.endsWith("config.json")),
      },
    });

    await dockerModule.makeRequest(
      "images/create?fromImage=docker.io/library/alpine:latest",
      "POST",
      "docker.io",
    );

    const registryAuthHeader =
      dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
    assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
      username: "hub-user",
      password: "hub-pass",
      serveraddress: "https://index.docker.io/v1/",
    });
  } finally {
    if (originalDockerConfig === undefined) {
      delete process.env.DOCKER_CONFIG;
    } else {
      process.env.DOCKER_CONFIG = originalDockerConfig;
    }
  }
});

await it("docker makeRequest resolves unqualified image pulls to Docker Hub auth entries", async () => {
  const requestedImages = ["myorg/app:latest", "alpine:latest"];

  await withDockerConfig(async () => {
    for (const requestedImage of requestedImages) {
      const { dockerClient, dockerModule } = await loadDockerModule({
        fsOverrides: {
          readFileSync: sinon.stub().returns(
            JSON.stringify({
              auths: {
                "https://index.docker.io/v1/": {
                  auth: Buffer.from("hub-user:hub-pass").toString("base64"),
                },
              },
            }),
          ),
        },
        utilsOverrides: {
          safeExistsSync: dockerConfigExistsStub(),
        },
      });

      await dockerModule.makeRequest(
        `images/create?fromImage=${requestedImage}`,
        "POST",
        "",
      );

      const registryAuthHeader =
        dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
      assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
        username: "hub-user",
        password: "hub-pass",
        serveraddress: "https://index.docker.io/v1/",
      });
    }
  });
});

await it("docker makeRequest skips credHelpers for substring-matched registries", async () => {
  const originalDockerConfig = process.env.DOCKER_CONFIG;
  process.env.DOCKER_CONFIG = "/tmp/cdxgen-docker-config";
  try {
    const safeSpawnSync = sinon.stub().returns({
      status: 0,
      stdout: JSON.stringify({
        Username: "trusted-user",
        Secret: "trusted-pass",
      }),
      stderr: "",
    });
    const { dockerClient, dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(
          JSON.stringify({
            credHelpers: {
              "private-registry.example.com": "osxkeychain",
            },
          }),
        ),
      },
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => filePath.endsWith("config.json")),
        safeSpawnSync,
      },
    });

    await dockerModule.makeRequest(
      "images/create?fromImage=registry.example.com/team/app:latest",
      "POST",
      "registry.example.com",
    );

    const requestOptions = dockerClient.lastCall.args[1];
    assert.strictEqual(requestOptions.headers, undefined);
    sinon.assert.notCalled(safeSpawnSync);
  } finally {
    if (originalDockerConfig === undefined) {
      delete process.env.DOCKER_CONFIG;
    } else {
      process.env.DOCKER_CONFIG = originalDockerConfig;
    }
  }
});

await it("docker makeRequest accepts raw host:port registry matches from credHelpers", async () => {
  await withDockerConfig(async () => {
    const safeSpawnSync = sinon.stub().returns({
      status: 0,
      stdout: JSON.stringify({
        username: "trusted-user",
        Secret: "trusted-pass",
      }),
      stderr: "",
    });
    const { dockerClient, dockerModule } = await loadDockerModule({
      fsOverrides: {
        readFileSync: sinon.stub().returns(
          JSON.stringify({
            credHelpers: {
              "localhost:5000": "osxkeychain",
            },
          }),
        ),
      },
      utilsOverrides: {
        safeExistsSync: sinon
          .stub()
          .callsFake((filePath) => filePath.endsWith("config.json")),
        safeSpawnSync,
      },
    });

    await dockerModule.makeRequest(
      "images/create?fromImage=localhost:5000/team/app:latest",
      "POST",
      "localhost:5000/team/app",
    );

    sinon.assert.calledOnceWithExactly(
      safeSpawnSync,
      credHelperExe("osxkeychain"),
      ["get"],
      {
        input: "localhost:5000",
      },
    );
    const registryAuthHeader =
      dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
    assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
      username: "trusted-user",
      password: "trusted-pass",
      email: "trusted-user",
      serveraddress: "localhost:5000",
    });
  });
});

await it("docker getCredsFromHelper normalizes cache keys for equivalent registry hosts", async () => {
  const safeSpawnSync = sinon.stub().returns({
    status: 0,
    stdout: JSON.stringify({
      username: "trusted-user",
      Secret: "trusted-pass",
    }),
    stderr: "",
  });
  const { dockerModule } = await loadDockerModule({
    utilsOverrides: {
      safeSpawnSync,
    },
  });

  const firstToken = dockerModule.getCredsFromHelper(
    "osxkeychain",
    "registry.example.com",
  );
  const secondToken = dockerModule.getCredsFromHelper(
    "osxkeychain",
    "https://registry.example.com/v2/",
  );

  assert.strictEqual(firstToken, secondToken);
  sinon.assert.calledOnceWithExactly(
    safeSpawnSync,
    credHelperExe("osxkeychain"),
    ["get"],
    {
      input: "registry.example.com",
    },
  );
});

await it("docker getCredsFromHelper keeps scoped path cache keys isolated", async () => {
  const safeSpawnSync = sinon.stub().returns({
    status: 0,
    stdout: JSON.stringify({
      username: "trusted-user",
      Secret: "trusted-pass",
    }),
    stderr: "",
  });
  const { dockerModule } = await loadDockerModule({
    utilsOverrides: {
      safeSpawnSync,
    },
  });

  const firstToken = dockerModule.getCredsFromHelper(
    "osxkeychain",
    "https://registry.example.com/custom/subpath/v2/",
  );
  const secondToken = dockerModule.getCredsFromHelper(
    "osxkeychain",
    "https://registry.example.com/custom/subpath/v2/",
  );
  const thirdToken = dockerModule.getCredsFromHelper(
    "osxkeychain",
    "https://registry.example.com/other/subpath/v2/",
  );

  assert.strictEqual(firstToken, secondToken);
  assert.notStrictEqual(firstToken, thirdToken);
  assert.deepStrictEqual(decodeRegistryAuthHeader(firstToken), {
    username: "trusted-user",
    password: "trusted-pass",
    email: "trusted-user",
    serveraddress: "https://registry.example.com/custom/subpath/v2/",
  });
  sinon.assert.calledTwice(safeSpawnSync);
});

await it("docker makeRequest accepts ipv4 ipv6 explicit-port and scoped-subpath registry matches from credHelpers", async () => {
  const cases = [
    {
      configuredRegistry: "127.0.0.1:5000",
      requestedRegistry: "127.0.0.1:5000/team/app",
    },
    {
      configuredRegistry: "[::1]:5000",
      requestedRegistry: "[::1]:5000/team/app",
    },
    {
      configuredRegistry: "https://registry.example.com:443/v2/",
      requestedRegistry: "registry.example.com:443/team/app",
    },
    {
      configuredRegistry: "http://registry.example.com:80/v2/",
      requestedRegistry: "registry.example.com:80/team/app",
    },
    {
      configuredRegistry: "https://registry.example.com/custom/subpath/v2/",
      requestedRegistry: "registry.example.com/custom/subpath/team/app",
    },
  ];

  await withDockerConfig(async () => {
    for (const testCase of cases) {
      const safeSpawnSync = sinon.stub().returns({
        status: 0,
        stdout: JSON.stringify({
          username: "trusted-user",
          Secret: "trusted-pass",
        }),
        stderr: "",
      });
      const { dockerClient, dockerModule } =
        await loadDockerModuleWithCredHelpers(
          testCase.configuredRegistry,
          safeSpawnSync,
        );

      await dockerModule.makeRequest(
        `images/create?fromImage=${testCase.requestedRegistry}:latest`,
        "POST",
        testCase.requestedRegistry,
      );

      sinon.assert.calledOnceWithExactly(
        safeSpawnSync,
        credHelperExe("osxkeychain"),
        ["get"],
        {
          input: testCase.configuredRegistry,
        },
      );
      const registryAuthHeader =
        dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
      assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
        username: "trusted-user",
        password: "trusted-pass",
        email: "trusted-user",
        serveraddress: testCase.configuredRegistry,
      });
    }
  });
});

await it("docker makeRequest does not invoke credHelpers for wildcard unicode bidi explicit-default-port or port-boundary mismatches", async () => {
  const bidiRegistry = "reg\u202eistry.example.com";
  const unicodeConfusableRegistry = "reg\u0456stry.example.com";
  const cases = [
    {
      configuredRegistry: "*.example.com",
      requestedRegistry: "team.example.com/app",
    },
    {
      configuredRegistry: "registry.example.com",
      requestedRegistry: "registry.example.com:80/team/app",
    },
    {
      configuredRegistry: "registry.example.com:443",
      requestedRegistry: "registry.example.com/team/app",
    },
    {
      configuredRegistry: "127.0.0.1:5001",
      requestedRegistry: "127.0.0.1:5000/team/app",
    },
    {
      configuredRegistry: "[::1]:5001",
      requestedRegistry: "[::1]:5000/team/app",
    },
    {
      configuredRegistry: "https://registry.example.com/custom/subpath/v2/",
      requestedRegistry: "registry.example.com/team/app",
    },
    {
      configuredRegistry: "https://registry.example.com/custom/subpath/v2/",
      requestedRegistry: "registry.example.com/custom/subpathology/team/app",
    },
    {
      configuredRegistry: "https://registry.example.com:443/v2/",
      requestedRegistry: "registry.example.com:444/team/app",
    },
    {
      configuredRegistry: unicodeConfusableRegistry,
      requestedRegistry: "registry.example.com/team/app",
    },
    {
      configuredRegistry: bidiRegistry,
      requestedRegistry: "registry.example.com/team/app",
    },
  ];

  await withDockerConfig(async () => {
    for (const testCase of cases) {
      const safeSpawnSync = sinon.stub().returns({
        status: 0,
        stdout: JSON.stringify({
          username: "trusted-user",
          Secret: "trusted-pass",
        }),
        stderr: "",
      });
      const { dockerClient, dockerModule } =
        await loadDockerModuleWithCredHelpers(
          testCase.configuredRegistry,
          safeSpawnSync,
        );

      await dockerModule.makeRequest(
        `images/create?fromImage=${testCase.requestedRegistry}:latest`,
        "POST",
        testCase.requestedRegistry,
      );

      const requestOptions = dockerClient.lastCall.args[1];
      assert.strictEqual(requestOptions.headers, undefined);
      sinon.assert.notCalled(safeSpawnSync);
    }
  });
});

await it("docker makeRequest resolves unqualified image pulls to Docker Hub credHelpers", async () => {
  const requestedImages = ["myorg/app:latest", "alpine:latest"];

  await withDockerConfig(async () => {
    for (const requestedImage of requestedImages) {
      const safeSpawnSync = sinon.stub().returns({
        status: 0,
        stdout: JSON.stringify({
          username: "hub-user",
          Secret: "hub-pass",
        }),
        stderr: "",
      });
      const { dockerClient, dockerModule } = await loadDockerModule({
        fsOverrides: {
          readFileSync: sinon.stub().returns(
            JSON.stringify({
              credHelpers: {
                "docker.io": "osxkeychain",
              },
            }),
          ),
        },
        utilsOverrides: {
          safeExistsSync: dockerConfigExistsStub(),
          safeSpawnSync,
        },
      });

      await dockerModule.makeRequest(
        `images/create?fromImage=${requestedImage}`,
        "POST",
        "",
      );

      sinon.assert.calledOnceWithExactly(
        safeSpawnSync,
        credHelperExe("osxkeychain"),
        ["get"],
        {
          input: "docker.io",
        },
      );
      const registryAuthHeader =
        dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
      assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
        username: "hub-user",
        password: "hub-pass",
        email: "hub-user",
        serveraddress: "docker.io",
      });
    }
  });
});

await it("docker makeRequest accepts normalized exact matches for common public registries without aliasing hosts", async () => {
  const cases = [
    {
      configuredRegistry: "https://ghcr.io/v2/",
      requestedRegistry: "ghcr.io/org/image",
    },
    {
      configuredRegistry: "https://quay.io/v2/",
      requestedRegistry: "quay.io/org/image",
    },
    {
      configuredRegistry: "https://public.ecr.aws/v2/",
      requestedRegistry: "public.ecr.aws/alias/image",
    },
    {
      configuredRegistry: "https://gcr.io/v2/",
      requestedRegistry: "gcr.io/project/image",
    },
  ];

  await withDockerConfig(async () => {
    for (const { configuredRegistry, requestedRegistry } of cases) {
      const { dockerClient, dockerModule } = await loadDockerModule({
        fsOverrides: {
          readFileSync: sinon.stub().returns(
            JSON.stringify({
              auths: {
                [configuredRegistry]: {
                  auth: Buffer.from("trusted-user:trusted-pass").toString(
                    "base64",
                  ),
                },
              },
            }),
          ),
        },
        utilsOverrides: {
          safeExistsSync: sinon
            .stub()
            .callsFake((filePath) => filePath.endsWith("config.json")),
        },
      });

      await dockerModule.makeRequest(
        `images/create?fromImage=${requestedRegistry}:latest`,
        "POST",
        requestedRegistry,
      );

      const registryAuthHeader =
        dockerClient.lastCall.args[1].headers["X-Registry-Auth"];
      assert.deepStrictEqual(decodeRegistryAuthHeader(registryAuthHeader), {
        username: "trusted-user",
        password: "trusted-pass",
        serveraddress: configuredRegistry,
      });
    }
  });
});

await it("docker makeRequest keeps ghcr quay aws and gcp registries on separate trust boundaries", async () => {
  const cases = [
    {
      configuredRegistry: "https://tenant.ghcr.io/v2/",
      requestedRegistry: "ghcr.io",
    },
    {
      configuredRegistry: "https://quay.io.evil.example/v2/",
      requestedRegistry: "quay.io",
    },
    {
      configuredRegistry:
        "https://123456789012.dkr.ecr.us-east-1.amazonaws.com/v2/",
      requestedRegistry: "public.ecr.aws",
    },
    {
      configuredRegistry: "https://mirror.gcr.io/v2/",
      requestedRegistry: "gcr.io",
    },
    {
      configuredRegistry: "https://us-docker.pkg.dev/v2/",
      requestedRegistry: "gcr.io",
    },
  ];

  await withDockerConfig(async () => {
    for (const { configuredRegistry, requestedRegistry } of cases) {
      const { dockerClient, dockerModule } = await loadDockerModule({
        fsOverrides: {
          readFileSync: sinon.stub().returns(
            JSON.stringify({
              auths: {
                [configuredRegistry]: {
                  auth: Buffer.from("trusted-user:trusted-pass").toString(
                    "base64",
                  ),
                },
              },
            }),
          ),
        },
        utilsOverrides: {
          safeExistsSync: sinon
            .stub()
            .callsFake((filePath) => filePath.endsWith("config.json")),
        },
      });

      await dockerModule.makeRequest(
        `images/create?fromImage=${requestedRegistry}/team/app:latest`,
        "POST",
        requestedRegistry,
      );

      const requestOptions = dockerClient.lastCall.args[1];
      assert.strictEqual(requestOptions.headers, undefined);
    }
  });
});

await it("extractFromManifest derives PATH metadata from archive config", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-docker-"));
  try {
    const allLayersExplodedDir = join(tempDir, "all-layers");
    const manifestFile = join(tempDir, "manifest.json");
    mkdirSync(allLayersExplodedDir, { recursive: true });
    writeFileSync(
      manifestFile,
      JSON.stringify([
        {
          Config: "blobs/sha256/config.json",
          Layers: ["blobs/sha256/layer.tar"],
        },
      ]),
    );
    mkdirSync(join(tempDir, "blobs", "sha256"), { recursive: true });
    writeFileSync(
      join(tempDir, "blobs", "sha256", "config.json"),
      JSON.stringify({
        config: {
          Env: [
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          ],
          WorkingDir: "/work",
        },
      }),
    );
    writeFileSync(join(tempDir, "blobs", "sha256", "layer.tar"), "");

    const exportData = await extractFromManifest(
      manifestFile,
      {},
      tempDir,
      allLayersExplodedDir,
      {},
    );

    assert.deepStrictEqual(exportData.binPaths, [
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ]);
    assert.deepStrictEqual(exportData.inspectData?.Config?.Env, [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ]);
    assert.strictEqual(
      exportData.lastWorkingDir,
      join(allLayersExplodedDir, "/work"),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

await it("extractFromManifest resolves OCI index manifests", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-docker-"));
  try {
    const allLayersExplodedDir = join(tempDir, "all-layers");
    const manifestFile = join(tempDir, "index.json");
    mkdirSync(allLayersExplodedDir, { recursive: true });
    mkdirSync(join(tempDir, "blobs", "sha256"), { recursive: true });
    writeFileSync(
      manifestFile,
      JSON.stringify({
        schemaVersion: 2,
        manifests: [
          {
            digest: "sha256:manifest-blob",
            mediaType: "application/vnd.oci.image.manifest.v1+json",
          },
        ],
      }),
    );
    writeFileSync(
      join(tempDir, "blobs", "sha256", "manifest-blob"),
      JSON.stringify({
        schemaVersion: 2,
        config: {
          digest: "sha256:config-blob",
        },
        layers: [
          {
            digest: "sha256:layer-blob",
          },
        ],
      }),
    );
    writeFileSync(
      join(tempDir, "blobs", "sha256", "config-blob"),
      JSON.stringify({
        config: {
          Env: ["PATH=/usr/local/bin:/usr/bin:/bin"],
          WorkingDir: "/workspace",
        },
      }),
    );
    writeFileSync(join(tempDir, "blobs", "sha256", "layer-blob"), "");

    const exportData = await extractFromManifest(
      manifestFile,
      {},
      tempDir,
      allLayersExplodedDir,
      {},
    );

    assert.deepStrictEqual(exportData.binPaths, [
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);
    assert.deepStrictEqual(exportData.inspectData?.Config?.Env, [
      "PATH=/usr/local/bin:/usr/bin:/bin",
    ]);
    assert.strictEqual(
      exportData.lastWorkingDir,
      join(allLayersExplodedDir, "/workspace"),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

await it("exportArchive derives PATH metadata from blobs-only podman archives", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-docker-"));
  try {
    const archiveDir = join(tempDir, "archive");
    const archiveFile = join(tempDir, "podman-archive.tar");
    mkdirSync(join(archiveDir, "blobs", "sha256"), { recursive: true });
    writeFileSync(
      join(archiveDir, "blobs", "sha256", "manifest-blob"),
      JSON.stringify({
        schemaVersion: 2,
        config: {
          digest: "sha256:config-blob",
        },
        layers: [
          {
            digest: "sha256:layer-blob",
          },
        ],
      }),
    );
    writeFileSync(
      join(archiveDir, "blobs", "sha256", "config-blob"),
      JSON.stringify({
        config: {
          Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin"],
          WorkingDir: "/app",
        },
      }),
    );
    writeFileSync(join(archiveDir, "blobs", "sha256", "layer-blob"), "");
    await createTar(
      {
        cwd: archiveDir,
        file: archiveFile,
        portable: true,
      },
      ["blobs"],
    );

    const exportData = await exportArchive(archiveFile, {});

    assert.deepStrictEqual(exportData.binPaths, [
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);
    assert.deepStrictEqual(exportData.inspectData?.Config?.Env, [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/bin",
    ]);
    assert.strictEqual(
      exportData.lastWorkingDir,
      join(exportData.allLayersExplodedDir, "app"),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

await it("exportArchive ignores manifest Layers and WorkingDir that escape the image", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "cdxgen-docker-e2e-"));
  try {
    const victimDir = join(workDir, "victim");
    const imageDir = join(workDir, "image");
    mkdirSync(join(victimDir, "leaked"), { recursive: true });
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(
      join(victimDir, "leaked", "package.json"),
      JSON.stringify({
        name: "victim-tar-package",
        version: "1.2.3",
        description: "SECRET-from-victim-tar",
      }),
    );
    await createTar(
      {
        cwd: victimDir,
        file: join(victimDir, "leaked-layer.tar"),
        portable: true,
      },
      ["leaked"],
    );
    writeFileSync(join(imageDir, "layer.tar"), "");
    const traversalPrefix = relative(
      imageDir,
      join(victimDir, "leaked-layer.tar"),
    )
      .split(sep)
      .map(() => "..")
      .join(sep);
    writeFileSync(
      join(imageDir, "config.json"),
      JSON.stringify({
        config: { WorkingDir: join("..", "..", "..", "cdxgen-docker-e2e-xyz") },
      }),
    );
    writeFileSync(
      join(imageDir, "manifest.json"),
      JSON.stringify([
        {
          Config: "config.json",
          RepoTags: ["evil/evil:latest"],
          Layers: [join(traversalPrefix, "leaked-layer.tar")],
        },
      ]),
    );
    const archiveFile = join(workDir, "evil-image.tar");
    await createTar({ cwd: imageDir, file: archiveFile, portable: true }, [
      "layer.tar",
      "config.json",
      "manifest.json",
    ]);

    const exportData = await exportArchive(archiveFile, {});
    assert.ok(exportData, "the well-formed parts of the image must still scan");
    assert.strictEqual(exportData.lastWorkingDir, "");
    assert.deepStrictEqual(
      exportData.pkgPathList.filter((p) => p.includes("victim")),
      [],
      "the victim directory outside the archive must not be scanned",
    );
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

await it("extractFromManifest rejects Layers and Config references that escape the archive", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-docker-"));
  const victimDir = mkdtempSync(join(tmpdir(), "cdxgen-docker-victim-"));
  try {
    const allLayersExplodedDir = join(tempDir, "all-layers");
    const manifestFile = join(tempDir, "manifest.json");
    mkdirSync(allLayersExplodedDir, { recursive: true });
    mkdirSync(join(tempDir, "blobs", "sha256"), { recursive: true });
    // A tar outside the extraction directory that the crafted manifest will
    // try to reference as a "layer".
    const victimTar = join(victimDir, "leaked-layer.tar");
    const victimEntryDir = join(victimDir, "leaked");
    mkdirSync(victimEntryDir, { recursive: true });
    const leakedManifest = JSON.stringify({
      name: "victim-tar-package",
      version: "1.2.3",
      description: "SECRET-from-victim-tar",
    });
    writeFileSync(join(victimEntryDir, "package.json"), leakedManifest);
    await createTar(
      {
        cwd: victimDir,
        file: victimTar,
        portable: true,
      },
      ["leaked"],
    );
    writeFileSync(join(tempDir, "blobs", "sha256", "layer.tar"), "");
    writeFileSync(
      join(tempDir, "blobs", "sha256", "config.json"),
      JSON.stringify({ config: { WorkingDir: "/app" } }),
    );
    const traversalPrefix = relative(tempDir, victimTar)
      .split(sep)
      .map(() => "..")
      .join(sep);
    writeFileSync(
      manifestFile,
      JSON.stringify([
        {
          Config: join(traversalPrefix, "unrelated-host.json"),
          Layers: [join("blobs", "sha256", "layer.tar"), victimTar],
        },
      ]),
    );

    const exportData = await extractFromManifest(
      manifestFile,
      {},
      tempDir,
      allLayersExplodedDir,
      {},
    );

    // The traversal layer was skipped: its contents never landed in the
    // merged layers directory.
    assert.strictEqual(
      existsSync(join(allLayersExplodedDir, "leaked", "package.json")),
      false,
    );
    // lastLayerConfigFile resolved outside the archive is not read, so no
    // WorkingDir (not even the contained one) is honoured from it.
    assert.strictEqual(exportData.lastWorkingDir, "");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
    rmSync(victimDir, { force: true, recursive: true });
  }
});

await it("extractFromManifest rejects a WorkingDir that escapes the extracted layers", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-docker-"));
  const secretDir = mkdtempSync(join(tmpdir(), "cdxgen-docker-secret-"));
  try {
    const allLayersExplodedDir = join(tempDir, "all-layers");
    const manifestFile = join(tempDir, "manifest.json");
    mkdirSync(allLayersExplodedDir, { recursive: true });
    writeFileSync(join(tempDir, "layer.tar"), "");
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        config: { WorkingDir: join("..", "..", basename(secretDir)) },
      }),
    );
    writeFileSync(join(secretDir, "package.json"), "{}");
    writeFileSync(
      manifestFile,
      JSON.stringify([{ Config: "config.json", Layers: ["layer.tar"] }]),
    );

    const exportData = await extractFromManifest(
      manifestFile,
      {},
      tempDir,
      allLayersExplodedDir,
      {},
    );

    assert.strictEqual(exportData.lastWorkingDir, "");
    // The host directory outside the layers must not become a package path.
    assert.strictEqual(
      exportData.pkgPathList.some((p) => p.includes(basename(secretDir))),
      false,
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
    rmSync(secretDir, { force: true, recursive: true });
  }
});

describe("addSkippedSrcFiles tests", () => {
  let testComponents;

  beforeEach(() => {
    testComponents = [
      {
        name: "node",
        version: "20",
        component: "node:20",
        purl: "pkg:oci/node@20?tag=20",
        type: "container",
        "bom-ref": "pkg:oci/node@20?tag=20",
        properties: [
          {
            name: "internal:SrcFile",
            value: "/some/project/Dockerfile",
          },
          {
            name: "oci:SrcImage",
            value: "node:20",
          },
        ],
      },
    ];
  });

  it("no matching additional src files", () => {
    addSkippedSrcFiles(
      [
        {
          image: "node:18",
          src: "/some/project/bitbucket-pipeline.yml",
        },
      ],
      testComponents,
    );

    assert.strictEqual(testComponents[0].properties.length, 2);
  });

  it("adds additional src files", () => {
    addSkippedSrcFiles(
      [
        {
          image: "node:20",
          src: "/some/project/bitbucket-pipeline.yml",
        },
      ],
      testComponents,
    );

    assert.equal(testComponents[0].properties.length, 3);
  });

  it("skips if same src file", () => {
    addSkippedSrcFiles(
      [
        {
          image: "node:20",
          src: "/some/project/Dockerfile",
        },
      ],
      testComponents,
    );

    assert.deepStrictEqual(testComponents[0].properties.length, 2);
  });
});
