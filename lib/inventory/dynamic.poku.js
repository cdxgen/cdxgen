import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import { MAX_TRACED_LIBRARY_BYTES } from "./dynamic.js";
import {
  groupHttpEntriesToServices,
  parseEgressEntries,
} from "./traceRunner.js";

// The DLLs of these tests exist on the Windows host the trace came from, not
// necessarily on this one, so the file checks see a PE image.
const windowsHostFs = {
  ...nodeFs,
  realpathSync: (p) => p,
  statSync: () => ({ isFile: () => true, size: 4096 }),
  openSync: () => 3,
  readSync: (_fd, buffer) => {
    buffer[0] = 0x4d;
    buffer[1] = 0x5a;
    return 2;
  },
  closeSync: () => undefined,
};

describe("groupHttpEntriesToServices()", () => {
  it("returns empty object for empty input", () => {
    const result = groupHttpEntriesToServices([]);
    assert.deepEqual(result, {});
  });

  it("groups entries by host and port", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
      {
        method: "POST",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
      {
        method: "GET",
        host: "other.example.com",
        path: "/health",
        port: 443,
        protocol: "https",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const keys = Object.keys(result);
    assert.strictEqual(keys.length, 2);
    assert.ok(keys[0].includes("api.example.com"));
    assert.ok(keys[1].includes("other.example.com"));
  });

  it("collects endpoints as a Set of full URLs", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    assert.ok(service.endpoints instanceof Set);
    assert.strictEqual(service.endpoints.size, 1);
    assert.ok(service.endpoints.has("https://api.example.com/v1/users"));
  });

  it("includes port in endpoint when non-default", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/health",
        port: 8080,
        protocol: "http",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    assert.ok(service.endpoints.has("http://api.example.com:8080/health"));
  });

  it("adds httpMethod property for each unique method", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
      {
        method: "POST",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    const methods = service.properties.filter(
      (p) => p.name === "cdx:service:httpMethod",
    );
    assert.strictEqual(methods.length, 2);
    assert.ok(methods.some((p) => p.value === "GET"));
    assert.ok(methods.some((p) => p.value === "POST"));
  });

  it("deduplicates httpMethod properties", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/v1/users",
        port: 443,
        protocol: "https",
      },
      {
        method: "GET",
        host: "api.example.com",
        path: "/v1/items",
        port: 443,
        protocol: "https",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    const methods = service.properties.filter(
      (p) => p.name === "cdx:service:httpMethod",
    );
    assert.strictEqual(methods.length, 1);
  });

  it("records only query parameter names, never their values", () => {
    const entries = [
      {
        method: "GET",
        host: "api.example.com",
        path: "/search",
        port: 443,
        protocol: "https",
        query: "q=test&token=s3cr3t&q=again",
      },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    const queries = service.properties.filter(
      (p) => p.name === "cdx:dynamic:httpQueryParams",
    );
    assert.strictEqual(queries.length, 1);
    assert.strictEqual(queries[0].value, "q,token");
    assert.ok(!JSON.stringify(service.properties).includes("s3cr3t"));
  });

  it("uses the http scheme and default port for plain-HTTP entries", () => {
    const result = groupHttpEntriesToServices([
      { method: "GET", host: "h.example.com", port: 80, protocol: "http" },
    ]);
    const service = result[Object.keys(result)[0]];
    assert.ok(service.endpoints.has("http://h.example.com/"));
  });

  it("handles entries without a path", () => {
    const entries = [
      { method: "GET", host: "api.example.com", port: 443, protocol: "https" },
    ];
    const result = groupHttpEntriesToServices(entries);
    const service = result[Object.keys(result)[0]];
    assert.ok(service.endpoints.has("https://api.example.com/"));
  });
});

describe("parseEgressEntries()", () => {
  it("maps proxy-connect and proxy-violation audit entries to authorities", () => {
    const entries = parseEgressEntries([
      {
        type: "proxy-connect",
        target: "registry.npmjs.org:443",
        details: "connect",
      },
      {
        type: "proxy-connect",
        target: "registry.npmjs.org:443",
        details: "connect",
      },
      {
        type: "proxy-connect",
        target: "mirror.example.org:8080",
        details: "http",
      },
      { type: "proxy-violation", target: "CONNECT evil.example.com:443" },
      {
        type: "proxy-violation",
        target: "GET http://leak.example.com/p?token=x",
      },
      { type: "proxy-violation", target: "CONNECT [2001:db8::1]:443" },
      { type: "file-read", target: "/etc/hosts" },
    ]);
    assert.deepEqual(entries, [
      {
        host: "registry.npmjs.org",
        port: 443,
        protocol: "https",
        decision: "allowed",
      },
      {
        host: "mirror.example.org",
        port: 8080,
        protocol: "http",
        decision: "allowed",
      },
      {
        host: "evil.example.com",
        port: 443,
        protocol: "https",
        decision: "denied",
      },
      {
        host: "leak.example.com",
        port: 80,
        protocol: "http",
        decision: "denied",
      },
      { host: "2001:db8::1", port: 443, protocol: "https", decision: "denied" },
    ]);
  });

  it("returns an empty list without an audit log", () => {
    assert.deepEqual(parseEgressEntries(undefined), []);
  });
});

describe("librarySubpath()", () => {
  it("keeps POSIX paths and strips the leading slash", async () => {
    const { librarySubpath } = await import("./dynamic.js");
    assert.strictEqual(
      librarySubpath("/usr/lib/libssl.so.3"),
      "usr/lib/libssl.so.3",
    );
    assert.strictEqual(librarySubpath(""), null);
    assert.strictEqual(librarySubpath(undefined), null);
  });

  it("drops the drive and UNC prefix from Windows paths", async () => {
    const { librarySubpath } = await import("./dynamic.js");
    assert.strictEqual(
      librarySubpath("C:\\Windows\\System32\\bcrypt.dll"),
      "Windows/System32/bcrypt.dll",
    );
    assert.strictEqual(
      librarySubpath("d:/tools/libcrypto-3-x64.dll"),
      "tools/libcrypto-3-x64.dll",
    );
    assert.strictEqual(
      librarySubpath("\\\\server\\share\\x.dll"),
      "server/share/x.dll",
    );
  });
});

describe("buildDynamicComponents() Windows libraries", () => {
  it("gives a DLL a valid generic purl and keeps its full path", async () => {
    const dllPath = "C:\\Windows\\System32\\bcrypt.dll";
    const { buildDynamicComponents } = await esmock("./dynamic.js", {
      "node:fs": windowsHostFs,
      "../core/fs.js": { checksumFile: async () => "ab".repeat(32) },
      "./osPackageResolver.js": { resolvePackageForFile: () => undefined },
      "./traceRunner.js": {
        executeAndTrace: async () => ({
          libPaths: [dllPath],
          httpAccessEntries: [],
          egressEntries: [],
        }),
        groupHttpEntriesToServices,
      },
    });
    const { components } = await buildDynamicComponents("true");
    assert.strictEqual(components.length, 1);
    assert.strictEqual(
      components[0].purl,
      "pkg:generic/bcrypt.dll#Windows/System32/bcrypt.dll",
    );
    assert.deepEqual(components[0].properties, [
      { name: "cdx:dynamic:filePath", value: dllPath },
    ]);
  });

  it("marks a crypto DLL and versions it from its file version", async () => {
    const dllPath = "C:\\Windows\\System32\\schannel.dll";
    const { buildDynamicComponents } = await esmock("./dynamic.js", {
      "node:fs": windowsHostFs,
      "../core/fs.js": { checksumFile: async () => "cd".repeat(32) },
      "./osPackageResolver.js": { resolvePackageForFile: () => undefined },
      "./traceRunner.js": {
        executeAndTrace: async () => ({
          // ETW missed the load, but the crypto classification did not.
          libPaths: [],
          httpAccessEntries: [],
          egressEntries: [],
          cryptoEntries: [
            {
              type: "crypto-library",
              name: "Windows Schannel",
              version: "6.2.26100.9444",
              path: dllPath,
            },
          ],
          cryptoComponents: [
            {
              type: "cryptographic-asset",
              name: "Windows Schannel",
              version: "6.2.26100.9444",
              cryptoProperties: {
                assetType: "related-crypto-material",
                relatedCryptoMaterialProperties: { type: "library" },
              },
            },
          ],
        }),
        groupHttpEntriesToServices,
      },
    });
    const { components } = await buildDynamicComponents("true");
    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].type, "library");
    assert.strictEqual(components[0].version, "6.2.26100.9444");
    assert.strictEqual(
      components[0].purl,
      "pkg:generic/schannel.dll@6.2.26100.9444#Windows/System32/schannel.dll",
    );
    assert.deepEqual(components[0].properties[1], {
      name: "cdx:dynamic:cryptoLibrary",
      value: "Windows Schannel",
    });
  });
});

describe("buildDynamicComponents() egress services", () => {
  it("adds proxy egress decisions as services and returns the dry-run summary", async () => {
    const { buildDynamicComponents } = await esmock("./dynamic.js", {
      "./traceRunner.js": {
        executeAndTrace: async () => ({
          libPaths: [],
          httpAccessEntries: [],
          egressEntries: [
            {
              host: "registry.npmjs.org",
              port: 443,
              protocol: "https",
              decision: "allowed",
            },
            {
              host: "evil.example.com",
              port: 443,
              protocol: "https",
              decision: "denied",
            },
          ],
          dryRunSummary: { totalEvents: 2 },
        }),
        groupHttpEntriesToServices,
      },
    });
    const { services, dryRunSummary } = await buildDynamicComponents("true");
    assert.deepEqual(
      services.map((s) => [s.name, s.endpoints, s.properties[0].value]),
      [
        [
          "dynamic-registry.npmjs.org-443",
          ["https://registry.npmjs.org"],
          "allowed",
        ],
        [
          "dynamic-evil.example.com-443",
          ["https://evil.example.com"],
          "denied",
        ],
      ],
    );
    // The schema names the reference "bom-ref"; "bomRef" fails validation.
    assert.deepEqual(
      services.map((s) => [s["bom-ref"], s.bomRef]),
      [
        ["urn:service:dynamic:dynamic-registry.npmjs.org-443", undefined],
        ["urn:service:dynamic:dynamic-evil.example.com-443", undefined],
      ],
    );
    assert.deepEqual(dryRunSummary, { totalEvents: 2 });
  });
});

describe("buildDynamicComponents() traced library files", () => {
  it("hashes only regular files of bounded size that start like a shared object", async () => {
    const tmp = nodeFs.mkdtempSync(join(tmpdir(), "cdxgen-dynamic-"));
    try {
      const pluginBytes = Buffer.concat([
        Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
        Buffer.from("plugin"),
      ]);
      const plugin = join(tmp, "libplugin.so");
      nodeFs.writeFileSync(plugin, pluginBytes);
      const secret = join(tmp, "credentials");
      nodeFs.writeFileSync(secret, "aws_secret_access_key = hidden\n");
      const libPaths = [plugin, secret, tmp, "/dev/null"];
      // A versioned name linked to the library is still hashed, while a
      // library swapped for a link to another file is not.
      const versioned = join(tmp, "libplugin.so.1");
      const swapped = join(tmp, "libswapped.so");
      let linked = true;
      try {
        nodeFs.symlinkSync("libplugin.so", versioned);
        nodeFs.symlinkSync(secret, swapped);
        libPaths.push(versioned, swapped);
      } catch {
        // Creating a symbolic link needs a privilege on Windows.
        linked = false;
      }
      if (process.platform !== "win32") {
        // A sparse file costs no disk space here, but hashing it would read
        // every byte.
        const sparse = join(tmp, "libsparse.so");
        nodeFs.writeFileSync(sparse, pluginBytes);
        nodeFs.truncateSync(sparse, MAX_TRACED_LIBRARY_BYTES + 1);
        libPaths.push(sparse);
      }
      const { buildDynamicComponents } = await esmock("./dynamic.js", {
        "./osPackageResolver.js": { resolvePackageForFile: () => undefined },
        "./traceRunner.js": {
          executeAndTrace: async () => ({
            libPaths,
            httpAccessEntries: [],
            egressEntries: [],
          }),
          groupHttpEntriesToServices,
        },
      });
      const { components } = await buildDynamicComponents("true", tmp);
      const pluginHash = createHash("sha256").update(pluginBytes).digest("hex");
      assert.deepStrictEqual(
        components.map((c) => [c.name, c.hashes[0].content]),
        [
          ["libplugin.so", pluginHash],
          ...(linked ? [["libplugin.so.1", pluginHash]] : []),
        ],
      );
    } finally {
      nodeFs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
