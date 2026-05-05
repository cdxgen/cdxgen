import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function loadDockerModule({
  clientResponse,
  fsOverrides,
  utilsOverrides,
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
  const gotStub = {
    extend: sinon.stub().returns(dockerClient),
    get: sinon.stub().resolves({ body: "OK" }),
  };
  const utilsStub = {
    DEBUG_MODE: false,
    createDryRunError: sinon.stub(),
    extractPathEnv: sinon.stub().returns([]),
    getAllFiles: sinon.stub().returns([]),
    getTmpDir: sinon.stub().returns("/tmp"),
    isDryRun: false,
    recordActivity: sinon.stub(),
    safeExistsSync: sinon.stub().returns(false),
    safeMkdirSync: sinon.stub(),
    safeMkdtempSync: sinon.stub().returns("/tmp/docker-images-test"),
    safeRmSync: sinon.stub(),
    safeSpawnSync: sinon.stub().returns({ status: 1, stdout: "", stderr: "" }),
    safeWriteSync: sinon.stub(),
    ...utilsOverrides,
  };
  const dockerModule = await esmock("./docker.js", {
    "node:fs": fsStub,
    got: { default: gotStub },
    "../helpers/utils.js": utilsStub,
  });
  return { dockerClient, dockerModule, fsStub, gotStub, utilsStub };
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
  const { dockerModule, gotStub, dockerClient } = await loadDockerModule();
  const dockerConn = await dockerModule.getConnection();
  assert.strictEqual(dockerConn, dockerClient);
  sinon.assert.calledOnce(gotStub.get);
  sinon.assert.calledOnce(gotStub.extend);
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
    safeSpawnSync
      .onCall(0)
      .returns({
        status: 0,
        stdout: '{"Repository":"hello-world","Tag":"latest"}\n',
        stderr: "",
      })
      .onCall(1)
      .returns({
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
    sinon.assert.calledWithExactly(safeSpawnSync, "nerdctl", [
      "images",
      "--format=json",
    ]);
    sinon.assert.calledWithExactly(safeSpawnSync, "nerdctl", [
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

await it("docker extractTar reports a blocked untar activity in dry-run mode", async () => {
  const recordActivity = sinon.stub();
  const { dockerModule } = await loadDockerModule({
    utilsOverrides: {
      isDryRun: true,
      recordActivity,
    },
  });
  const result = await dockerModule.extractTar(
    "/tmp/image.tar",
    "/tmp/out",
    {},
  );
  assert.strictEqual(result, false);
  sinon.assert.calledWithMatch(recordActivity, {
    kind: "untar",
    status: "blocked",
    target: "/tmp/image.tar -> /tmp/out",
  });
});

await it("docker exportImage reports a blocked container activity in dry-run mode", async () => {
  const recordActivity = sinon.stub();
  const { dockerModule } = await loadDockerModule({
    utilsOverrides: {
      isDryRun: true,
      recordActivity,
    },
  });
  const result = await dockerModule.exportImage("alpine:3.20", {});
  assert.strictEqual(result, undefined);
  sinon.assert.calledWithMatch(recordActivity, {
    kind: "container",
    status: "blocked",
    target: "alpine:3.20",
  });
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

        const requestOptions = dockerClient.firstCall.args[1];
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
          dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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
          dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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

    const requestOptions = dockerClient.firstCall.args[1];
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
      dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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
        dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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

      const requestOptions = dockerClient.firstCall.args[1];
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
      dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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

    const requestOptions = dockerClient.firstCall.args[1];
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
      dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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
        dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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

    const requestOptions = dockerClient.firstCall.args[1];
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
      dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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
        dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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

      const requestOptions = dockerClient.firstCall.args[1];
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
        dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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
        dockerClient.firstCall.args[1].headers["X-Registry-Auth"];
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

      const requestOptions = dockerClient.firstCall.args[1];
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
            name: "SrcFile",
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
