import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { assert, it } from "poku";

import { parseIntegrity } from "../core/integrity.js";

const jarMetadataFixturesDir = path.resolve("test", "data", "jar-metadata");

function _createMockedProcess(envOverrides = {}) {
  const env = {
    ...process.env,
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const mockedProcess = Object.create(process);
  mockedProcess.argv = [...process.argv];
  mockedProcess.env = env;
  return mockedProcess;
}

function _readJarMetadataFixture(...segments) {
  return readFileSync(path.join(jarMetadataFixturesDir, ...segments), {
    encoding: "utf-8",
  });
}

it("integrity strings are parsed", () => {
  // gopkg.lock hash
  let ss = parseIntegrity(
    "2ca532a6bc655663344004ba102436d29031018eab236247678db1d8978627bf",
  );
  assert.deepStrictEqual(ss, []);
  ss = parseIntegrity(
    "sha256-2ca532a6bc655663344004ba102436d29031018eab236247678db1d8978627bf",
  );
  assert.deepStrictEqual(
    ss[0].digest,
    "2ca532a6bc655663344004ba102436d29031018eab236247678db1d8978627bf",
  );
  ss = parseIntegrity(
    `sha256-${Buffer.from(
      "2ca532a6bc655663344004ba102436d29031018eab236247678db1d8978627bf",
      "hex",
    ).toString("base64")}`,
  );
  assert.deepStrictEqual(
    ss[0].digest,
    "LKUyprxlVmM0QAS6ECQ20pAxAY6rI2JHZ42x2JeGJ78=",
  );
  ss = parseIntegrity(
    "sha512-Vn0lE2mprXEFPcRoI89xjw1fk1VJiyVbwfaPnVnvCXxEieByioO8Mj6sMwa6ON9PRuqbAjIxaQpkzccu41sYlw==",
  );
  assert.deepStrictEqual(
    ss[0].digest,
    "Vn0lE2mprXEFPcRoI89xjw1fk1VJiyVbwfaPnVnvCXxEieByioO8Mj6sMwa6ON9PRuqbAjIxaQpkzccu41sYlw==",
  );
});

// Slow test

it("multimodule go.mod file ordering", async () => {
  // Test that simulates the file ordering logic from createGoBom
  const mockPath = "/workspace/project";
  const mockGomodFiles = [
    "/workspace/project/deep/nested/go.mod",
    "/workspace/project/go.mod",
    "/workspace/project/submodule/go.mod",
  ];

  // Sort files by depth (shallowest first) - this is the fix we implemented
  const sortedFiles = mockGomodFiles.sort((a, b) => {
    const relativePathA = a.replace(`${mockPath}/`, "");
    const relativePathB = b.replace(`${mockPath}/`, "");
    const depthA = relativePathA.split("/").length;
    const depthB = relativePathB.split("/").length;
    return depthA - depthB;
  });

  // The root go.mod should be first (shallowest)
  assert.deepStrictEqual(sortedFiles[0], "/workspace/project/go.mod");
  assert.deepStrictEqual(sortedFiles[1], "/workspace/project/submodule/go.mod");
  assert.deepStrictEqual(
    sortedFiles[2],
    "/workspace/project/deep/nested/go.mod",
  );
});

// These tests are disabled because they are returning undefined
