import { strict as assert } from "node:assert";

import { describe, it } from "poku";

import { createGtfoBinsProperties, getGtfoBinsMetadata } from "./gtfobins.js";

describe("gtfobins helpers", () => {
  it("returns metadata for exact GTFOBins matches", () => {
    const metadata = getGtfoBinsMetadata("bash");
    assert.ok(metadata);
    assert.strictEqual(metadata.canonicalName, "bash");
    assert.ok(metadata.functions.includes("shell"));
    assert.ok(metadata.contexts.includes("suid"));
    assert.ok(metadata.riskTags.includes("privilege-escalation"));
    assert.ok(metadata.riskTags.includes("lateral-movement"));
  });

  it("resolves versioned aliases conservatively", () => {
    const metadata = getGtfoBinsMetadata("python3.12");
    assert.ok(metadata);
    assert.strictEqual(metadata.canonicalName, "python");
    assert.strictEqual(metadata.matchSource, "alias");
    assert.ok(metadata.functions.includes("shell"));
  });

  it("resolves symlink targets when the basename is not indexed", () => {
    const metadata = getGtfoBinsMetadata("sh", "busybox");
    assert.ok(metadata);
    assert.strictEqual(metadata.canonicalName, "busybox");
    assert.strictEqual(metadata.matchSource, "symlink");
    assert.ok(metadata.riskTags.includes("lateral-movement"));
  });

  it("emits stable CycloneDX properties for matched binaries", () => {
    const properties = createGtfoBinsProperties("docker");
    const propertyMap = Object.fromEntries(
      properties.map((property) => [property.name, property.value]),
    );
    assert.strictEqual(propertyMap["cdx:gtfobins:matched"], "true");
    assert.strictEqual(propertyMap["cdx:gtfobins:name"], "docker");
    assert.ok(propertyMap["cdx:gtfobins:functions"].includes("shell"));
    assert.ok(
      propertyMap["cdx:gtfobins:riskTags"].includes("container-escape"),
    );
    assert.ok(
      propertyMap["cdx:gtfobins:reference"].endsWith("/gtfobins/docker/"),
    );
  });
});
