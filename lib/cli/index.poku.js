import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

describe("CLI tests", () => {
  describe("submitBom()", () => {
    it("should successfully report the SBOM with given project id, name, version and a single tag", async () => {
      const fakeGotResponse = {
        json: sinon.stub().resolves({ success: true }),
      };

      const gotStub = sinon.stub().returns(fakeGotResponse);
      gotStub.extend = sinon.stub().returns(gotStub);

      const { submitBom } = await esmock("./index.js", {
        got: { default: gotStub },
      });

      const serverUrl = "https://dtrack.example.com";
      const projectId = "f7cb9f02-8041-4991-9101-b01fa07a6522";
      const projectName = "cdxgen-test-project";
      const projectVersion = "1.0.0";
      const projectTag = "tag1";
      const bomContent = { bom: "test" };
      const apiKey = "TEST_API_KEY";
      const skipDtTlsCheck = false;

      const expectedRequestPayload = {
        autoCreate: "true",
        bom: "eyJib20iOiJ0ZXN0In0=", // stringified and base64 encoded bomContent
        project: projectId,
        projectName,
        projectVersion,
        projectTags: [{ name: projectTag }],
      };

      await submitBom(
        {
          serverUrl,
          projectId,
          projectName,
          projectVersion,
          apiKey,
          skipDtTlsCheck,
          projectTag,
        },
        bomContent,
      );

      // Verify got was called exactly once
      sinon.assert.calledOnce(gotStub);

      // Grab call arguments
      const [calledUrl, options] = gotStub.firstCall.args;

      assert.equal(calledUrl, `${serverUrl}/api/v1/bom`);
      assert.equal(options.method, "PUT");
      assert.equal(options.https.rejectUnauthorized, !skipDtTlsCheck);
      assert.equal(options.headers["X-Api-Key"], apiKey);
      assert.match(options.headers["user-agent"], /@CycloneDX\/cdxgen/);
      assert.deepEqual(options.json, expectedRequestPayload);
    });

    it("should successfully report the SBOM with given parent project, name, version and multiple tags", async () => {
      const fakeGotResponse = {
        json: sinon.stub().resolves({ success: true }),
      };

      const gotStub = sinon.stub().returns(fakeGotResponse);
      gotStub.extend = sinon.stub().returns(gotStub);

      const { submitBom } = await esmock("./index.js", {
        got: { default: gotStub },
      });

      const serverUrl = "https://dtrack.example.com";
      const projectName = "cdxgen-test-project";
      const projectVersion = "1.1.0";
      const projectTags = ["tag1", "tag2"];
      const parentProjectId = "5103b8b4-4ca3-46ea-8051-036a3b2ab17e";
      const bomContent = {
        bom: "test2",
      };
      const apiKey = "TEST_API_KEY";
      const skipDtTlsCheck = false;

      const expectedRequestPayload = {
        autoCreate: "true",
        bom: "eyJib20iOiJ0ZXN0MiJ9", // stringified and base64 encoded bomContent
        parentUUID: parentProjectId,
        projectName,
        projectVersion,
        projectTags: [{ name: projectTags[0] }, { name: projectTags[1] }],
      };

      await submitBom(
        {
          serverUrl,
          parentProjectId,
          projectName,
          projectVersion,
          apiKey,
          skipDtTlsCheck,
          projectTag: projectTags,
        },
        bomContent,
      );

      // Verify got was called exactly once
      sinon.assert.calledOnce(gotStub);

      // Grab call arguments
      const [calledUrl, options] = gotStub.firstCall.args;

      // Assert call arguments against expectations
      assert.equal(calledUrl, `${serverUrl}/api/v1/bom`);
      assert.equal(options.method, "PUT");
      assert.equal(options.https.rejectUnauthorized, !skipDtTlsCheck);
      assert.equal(options.headers["X-Api-Key"], apiKey);
      assert.match(options.headers["user-agent"], /@CycloneDX\/cdxgen/);
      assert.deepEqual(options.json, expectedRequestPayload);
    });
  });
});

import { mergeDependencies } from "./index.js";

describe("mergeDependencies()", () => {
  it("merges two non-overlapping dependency arrays", () => {
    const a = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1"] }];
    const b = [{ ref: "pkg:npm/c@1", dependsOn: ["pkg:npm/d@1"] }];
    const result = mergeDependencies(a, b);
    assert.strictEqual(result.length, 2);
    const aEntry = result.find((d) => d.ref === "pkg:npm/a@1");
    assert.ok(aEntry);
    assert.deepStrictEqual(aEntry.dependsOn, ["pkg:npm/b@1"]);
  });

  it("merges dependsOn sets for the same ref", () => {
    const a = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1"] }];
    const b = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/c@1"] }];
    const result = mergeDependencies(a, b);
    assert.strictEqual(result.length, 1);
    const entry = result[0];
    assert.ok(entry.dependsOn.includes("pkg:npm/b@1"));
    assert.ok(entry.dependsOn.includes("pkg:npm/c@1"));
  });

  it("deduplicates identical dependsOn entries", () => {
    const a = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1"] }];
    const b = [
      { ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1", "pkg:npm/c@1"] },
    ];
    const result = mergeDependencies(a, b);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(
      result[0].dependsOn.filter((x) => x === "pkg:npm/b@1").length,
      1,
    );
  });

  it("handles undefined newDependencies gracefully", () => {
    const a = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1"] }];
    const result = mergeDependencies(a, undefined);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].ref, "pkg:npm/a@1");
  });

  it("handles empty arrays", () => {
    assert.deepStrictEqual(mergeDependencies([], []), []);
    assert.deepStrictEqual(mergeDependencies([], undefined), []);
  });

  it("merges a single dependency object (non-array)", () => {
    const a = [{ ref: "pkg:npm/a@1", dependsOn: ["pkg:npm/b@1"] }];
    const single = { ref: "pkg:npm/c@1", dependsOn: ["pkg:npm/d@1"] };
    const result = mergeDependencies(a, single);
    assert.strictEqual(result.length, 2);
  });

  it("handles the provides field for OmniBOR / ADG links", () => {
    const a = [
      {
        ref: "gitoid:commit:sha1:abc",
        dependsOn: [],
        provides: ["gitoid:commit:sha1:def"],
      },
    ];
    const b = [
      {
        ref: "gitoid:commit:sha1:def",
        provides: ["gitoid:blob:sha1:001", "gitoid:blob:sha1:002"],
      },
    ];
    const result = mergeDependencies(a, b);
    assert.ok(
      result.every((d) => Array.isArray(d.provides)),
      "all entries should have provides",
    );
    const defEntry = result.find((d) => d.ref === "gitoid:commit:sha1:def");
    assert.ok(defEntry);
    assert.ok(defEntry.provides.includes("gitoid:blob:sha1:001"));
    assert.ok(defEntry.provides.includes("gitoid:blob:sha1:002"));
  });

  it("excludes parent component from dependsOn", () => {
    const parentComponent = { "bom-ref": "pkg:npm/myapp@1.0.0" };
    const a = [
      {
        ref: "pkg:npm/a@1",
        dependsOn: ["pkg:npm/myapp@1.0.0", "pkg:npm/b@1"],
      },
    ];
    const result = mergeDependencies(a, [], parentComponent);
    const entry = result.find((d) => d.ref === "pkg:npm/a@1");
    assert.ok(
      !entry.dependsOn.includes("pkg:npm/myapp@1.0.0"),
      "parent should be excluded",
    );
    assert.ok(entry.dependsOn.includes("pkg:npm/b@1"));
  });

  it("merges parser-returned dependencies into BOM dependencies", () => {
    const bomDeps = [{ ref: "pkg:npm/app@1", dependsOn: ["pkg:npm/lib@2"] }];
    const parserDeps = [
      {
        ref: "workflow-bom-ref-1",
        dependsOn: ["task-bom-ref-1", "task-bom-ref-2"],
      },
      { ref: "task-bom-ref-1", dependsOn: ["pkg:github/actions/checkout@v4"] },
    ];
    const result = mergeDependencies(bomDeps, parserDeps);
    assert.strictEqual(result.length, 3);
    const wfEntry = result.find((d) => d.ref === "workflow-bom-ref-1");
    assert.ok(wfEntry);
    assert.ok(wfEntry.dependsOn.includes("task-bom-ref-1"));
    assert.ok(wfEntry.dependsOn.includes("task-bom-ref-2"));
  });
});
