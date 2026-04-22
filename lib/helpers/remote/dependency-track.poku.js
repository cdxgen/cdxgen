import { assert, describe, it } from "poku";

import {
  buildDependencyTrackBomPayload,
  getDependencyTrackBomUrl,
} from "./dependency-track.js";

describe("Dependency-Track helper tests", () => {
  it("returns submission URL without trailing slash duplication", () => {
    assert.strictEqual(
      getDependencyTrackBomUrl("https://dtrack.example.com/"),
      "https://dtrack.example.com/api/v1/bom",
    );
    assert.strictEqual(
      getDependencyTrackBomUrl("https://dtrack.example.com"),
      "https://dtrack.example.com/api/v1/bom",
    );
  });

  it("builds payload with parentUUID and tags", () => {
    const payload = buildDependencyTrackBomPayload(
      {
        projectName: "child",
        projectVersion: "1.0.0",
        parentProjectId: "d9628844-5f04-4ca7-88a2-64eb6bc64db0",
        projectTag: ["tag1", "tag2"],
      },
      { bom: "test" },
    );
    assert.deepStrictEqual(payload, {
      autoCreate: "true",
      bom: "eyJib20iOiJ0ZXN0In0=",
      parentUUID: "d9628844-5f04-4ca7-88a2-64eb6bc64db0",
      projectName: "child",
      projectTags: [{ name: "tag1" }, { name: "tag2" }],
      projectVersion: "1.0.0",
    });
  });

  it("builds payload with parentName and parentVersion", () => {
    const payload = buildDependencyTrackBomPayload(
      {
        projectName: "child",
        projectVersion: "1.0.0",
        parentProjectName: "parent",
        parentProjectVersion: "2.0.0",
      },
      { bom: "test2" },
    );
    assert.deepStrictEqual(payload, {
      autoCreate: "true",
      bom: "eyJib20iOiJ0ZXN0MiJ9",
      parentName: "parent",
      parentVersion: "2.0.0",
      projectName: "child",
      projectVersion: "1.0.0",
    });
  });

  it("returns undefined when project identity is missing", () => {
    const payload = buildDependencyTrackBomPayload({}, { bom: "test3" });
    assert.strictEqual(payload, undefined);
  });

  it("supports configurable autoCreate and isLatest", () => {
    const payload = buildDependencyTrackBomPayload(
      {
        autoCreate: false,
        isLatest: true,
        projectName: "child",
      },
      { bom: "test4" },
    );
    assert.deepStrictEqual(payload, {
      autoCreate: "false",
      bom: "eyJib20iOiJ0ZXN0NCJ9",
      isLatest: true,
      projectName: "child",
      projectVersion: "main",
    });
  });

  it("defaults projectVersion to main when only projectName is provided", () => {
    const payload = buildDependencyTrackBomPayload(
      { projectName: "child" },
      { bom: "test5" },
    );
    assert.deepStrictEqual(payload, {
      autoCreate: "true",
      bom: "eyJib20iOiJ0ZXN0NSJ9",
      projectName: "child",
      projectVersion: "main",
    });
  });

  it("returns undefined when parent UUID and parent name/version are both provided", () => {
    const payload = buildDependencyTrackBomPayload(
      {
        parentProjectId: "d9628844-5f04-4ca7-88a2-64eb6bc64db0",
        parentProjectName: "parent",
        parentProjectVersion: "1.0.0",
        projectName: "child",
      },
      { bom: "test6" },
    );
    assert.strictEqual(payload, undefined);
  });

  it("returns undefined when parent name/version mode is incomplete", () => {
    const payload = buildDependencyTrackBomPayload(
      {
        parentProjectName: "parent",
        projectName: "child",
      },
      { bom: "test7" },
    );
    assert.strictEqual(payload, undefined);
  });
});
