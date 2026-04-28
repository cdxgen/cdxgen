import process from "node:process";

import esmock from "esmock";
import { assert, beforeEach, describe, it } from "poku";
import sinon from "sinon";

import {
  addSkippedSrcFiles,
  exportImage,
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

async function loadDockerModule({ clientResponse } = {}) {
  const dockerClient = sinon.stub().resolves(
    clientResponse || {
      Id: "sha256:hello-world",
      RepoTags: ["hello-world:latest"],
    },
  );
  dockerClient.stream = sinon.stub();
  const gotStub = {
    extend: sinon.stub().returns(dockerClient),
    get: sinon.stub().resolves({ body: "OK" }),
  };
  const utilsStub = {
    DEBUG_MODE: false,
    extractPathEnv: sinon.stub().returns([]),
    getAllFiles: sinon.stub().returns([]),
    getTmpDir: sinon.stub().returns("/tmp"),
    safeExistsSync: sinon.stub().returns(false),
    safeMkdirSync: sinon.stub(),
    safeSpawnSync: sinon.stub().returns({ status: 1, stdout: "", stderr: "" }),
  };
  const dockerModule = await esmock("./docker.js", {
    got: { default: gotStub },
    "../helpers/utils.js": utilsStub,
  });
  return { dockerClient, dockerModule, gotStub };
}

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

await it("docker exportImage ignores local directories", async () => {
  const imageData = await exportImage(".");
  assert.strictEqual(imageData, undefined);
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
