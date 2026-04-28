import { strict as assert } from "node:assert";

import { describe, it } from "poku";

import {
  createContainerRiskProperties,
  getContainerRiskMetadata,
} from "./containerRisk.js";

describe("container risk helpers", () => {
  it("returns offensive toolkit metadata for direct container tool matches", () => {
    const metadata = getContainerRiskMetadata("cdk");
    assert.ok(metadata);
    assert.strictEqual(metadata.canonicalName, "cdk");
    assert.ok(metadata.offenseTools.includes("cdk"));
    assert.ok(metadata.riskTags.includes("offensive-toolkit"));
    assert.ok(metadata.attackTechniques.includes("T1611"));
  });

  it("maps kubernetes control-plane helpers to ATT&CK and offensive playbooks", () => {
    const metadata = getContainerRiskMetadata("kubectl");
    assert.ok(metadata);
    assert.ok(metadata.offenseTools.includes("peirates"));
    assert.ok(metadata.offenseTools.includes("cdk"));
    assert.ok(metadata.attackTechniques.includes("T1613"));
    assert.ok(metadata.riskTags.includes("k8s-cluster-pivot"));
  });

  it("tracks seccomp-sensitive namespace escape helpers", () => {
    const metadata = getContainerRiskMetadata("nsenter");
    assert.ok(metadata);
    assert.strictEqual(metadata.seccompProfile, "docker-default");
    assert.ok(metadata.seccompBlockedSyscalls.includes("setns"));
    assert.ok(metadata.seccompBlockedSyscalls.includes("unshare"));
  });

  it("emits stable CycloneDX properties for enriched container binaries", () => {
    const properties = createContainerRiskProperties("docker");
    const propertyMap = Object.fromEntries(
      properties.map((property) => [property.name, property.value]),
    );
    assert.strictEqual(propertyMap["cdx:container:matched"], "true");
    assert.strictEqual(propertyMap["cdx:container:name"], "docker");
    assert.ok(propertyMap["cdx:container:attackTechniques"].includes("T1611"));
    assert.ok(propertyMap["cdx:container:offenseTools"].includes("deepce"));
    assert.ok(
      propertyMap["cdx:container:knowledgeSources"].includes(
        "attack-containers",
      ),
    );
  });
});
