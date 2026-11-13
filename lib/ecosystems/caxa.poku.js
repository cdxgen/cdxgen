import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";

import { assert, describe, it } from "poku";

import { enrichCaxaMetadataFromApp, parseCaxaMetadata } from "./caxa.js";

/**
 * Write a metadata document to a scratch file and parse it.
 *
 * @param {object} document Metadata contents
 * @returns {Promise<object>} Parse result
 */
async function parseDocument(document) {
  const dir = mkdtempSync(join(tmpdir(), "caxa-"));
  try {
    const mfile = join(dir, "metadata.json");
    writeFileSync(mfile, JSON.stringify(document));
    return await parseCaxaMetadata(mfile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("parseCaxaMetadata", () => {
  it("names the enclosing executable in the evidence of each component", async () => {
    const { components } = await parseDocument({
      parentComponent: { name: "cdxgen-linux-amd64", type: "application" },
      components: [{ name: "left-pad", purl: "pkg:npm/left-pad@1.3.0" }],
    });
    assert.deepStrictEqual(
      components[0].evidence.identity.methods.map((m) => m.technique),
      ["binary-analysis", "manifest-analysis"],
    );
    assert.strictEqual(
      components[0].evidence.identity.methods[0].value,
      "cdxgen-linux-amd64",
    );
  });

  it("parses a document with no parent component", async () => {
    // The caxa scan globs every `*metadata.json` under the path, so documents
    // that are not caxa builds at all reach this parser. One without a parent
    // has no executable to name and must still parse.
    const { components } = await parseDocument({
      components: [{ name: "left-pad", purl: "pkg:npm/left-pad@1.3.0" }],
    });
    assert.strictEqual(components.length, 1);
    assert.deepStrictEqual(
      components[0].evidence.identity.methods.map((m) => m.technique),
      ["manifest-analysis"],
    );
  });

  it("does not repeat an overlong parent name in every component", async () => {
    // The name is copied into the evidence of each component, so one long
    // string would be multiplied by the number of components in the BOM.
    const { components } = await parseDocument({
      parentComponent: { name: "p".repeat(100_000), type: "application" },
      components: [
        { name: "left-pad", purl: "pkg:npm/left-pad@1.3.0" },
        { name: "right-pad", purl: "pkg:npm/right-pad@1.0.0" },
      ],
    });
    for (const component of components) {
      assert.deepStrictEqual(
        component.evidence.identity.methods.map((m) => m.technique),
        ["manifest-analysis"],
      );
    }
  });

  it("returns nothing for a document that carries no components", async () => {
    assert.deepStrictEqual(await parseDocument({ parentComponent: {} }), {});
  });
});

/**
 * Write a file, creating its directory.
 *
 * @param {string} file Path
 * @param {string|Buffer|object} content Content; objects are written as JSON
 */
function put(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof content === "string" || Buffer.isBuffer(content)
      ? content
      : JSON.stringify(content),
  );
}

/**
 * Build a zip archive of stored (uncompressed) entries.
 *
 * @param {Object<string, string>} entries Entry name to content
 * @returns {Buffer} Zip bytes
 */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const fileName = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("enrichCaxaMetadataFromApp", () => {
  // An extracted app: a plugins package with a manifest and an aggregate SBOM,
  // a package that vendors PHP, Ruby and Java packages, and npm's lockfile.
  const writeApp = (appDir) => {
    const tools = join(appDir, "node_modules", "tools");
    put(join(appDir, "package.json"), { name: "app", version: "1.0.0" });
    put(join(appDir, "node_modules", ".package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "node_modules/tools": { version: "1.0.0", integrity: "sha512-AAAA" },
      },
    });
    put(join(tools, "package.json"), { name: "tools", version: "1.0.0" });
    const tool = (name) => ({
      type: "application",
      name,
      version: "1.0",
      purl: `pkg:generic/${name}@1.0`,
      "bom-ref": `pkg:generic/${name}@1.0`,
    });
    put(join(tools, "plugins", "plugins-manifest.json"), {
      plugins: [
        { binaryPath: "plugins/present/present", component: tool("present") },
        // Pruned from this build: its binary is not in the app.
        { binaryPath: "plugins/pruned/pruned", component: tool("pruned") },
        // A manifest may not point outside its package.
        { binaryPath: "../../package.json", component: tool("escape") },
      ],
    });
    put(join(tools, "plugins", "present", "present"), "placeholder bytes");
    put(join(tools, "plugins", "sbom-postbuild.cdx.json"), {
      components: [
        tool("present"),
        tool("pruned"),
        {
          name: "lib",
          purl: "pkg:golang/example.com/lib@v1.0.0",
          "bom-ref": "pkg:golang/example.com/lib@v1.0.0",
        },
        {
          name: "only-pruned",
          purl: "pkg:golang/only-pruned@1.0",
          "bom-ref": "pkg:golang/only-pruned@1.0",
        },
        // An invalid purl is repaired, but its bom-ref, which the graph uses,
        // stays as it is.
        {
          name: "odd",
          purl: "pkg:golang/odd@1.0",
          "bom-ref": "pkg:golang/odd@1.0",
        },
        // In the SBOM but used by no tool, like a test fixture.
        {
          name: "orphan",
          purl: "pkg:golang/orphan@1.0",
          "bom-ref": "pkg:golang/orphan@1.0",
        },
      ],
      dependencies: [
        {
          ref: "pkg:generic/present@1.0",
          dependsOn: [
            "pkg:golang/example.com/lib@v1.0.0",
            "pkg:golang/odd@1.0",
          ],
        },
        {
          ref: "pkg:generic/pruned@1.0",
          dependsOn: ["pkg:golang/only-pruned@1.0"],
        },
      ],
    });
    const vendor = join(appDir, "node_modules", "vendor");
    put(join(vendor, "package.json"), { name: "vendor", version: "2.0.0" });
    put(join(vendor, "php", "composer.json"), {
      name: "vendor/php",
      require: { "nikic/php-parser": "^5" },
    });
    put(join(vendor, "php", "composer.lock"), {
      packages: [{ name: "nikic/php-parser", version: "v5.8.0" }],
      "packages-dev": [],
    });
    put(
      join(vendor, "ruby", "Gemfile.lock"),
      "GEM\n  remote: https://rubygems.org/\n  specs:\n    ast (2.4.3)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  ast\n\nBUNDLED WITH\n   2.6.9\n",
    );
    put(
      join(vendor, "java", "demo-1.2.3.jar"),
      storedZip({
        "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\r\n\r\n",
        "META-INF/maven/org.example/demo/pom.properties":
          "groupId=org.example\nartifactId=demo\nversion=1.2.3\n",
      }),
    );
  };
  const metadata = () => ({
    parentComponent: { name: "app", "bom-ref": "pkg:generic/app@1.0.0" },
    components: [
      {
        name: "app",
        version: "1.0.0",
        purl: "pkg:npm/app@1.0.0",
        "bom-ref": "pkg:npm/app@1.0.0",
      },
      {
        name: "tools",
        version: "1.0.0",
        purl: "pkg:npm/tools@1.0.0",
        "bom-ref": "pkg:npm/tools@1.0.0",
        properties: [
          { name: "cdx:caxa:lazyMember", value: "plugins/present/present" },
        ],
      },
      {
        name: "vendor",
        version: "2.0.0",
        purl: "pkg:npm/vendor@2.0.0",
        "bom-ref": "pkg:npm/vendor@2.0.0",
      },
    ],
    dependencies: [
      {
        ref: "pkg:npm/app@1.0.0",
        dependsOn: ["pkg:npm/tools@1.0.0", "pkg:npm/vendor@2.0.0"],
      },
    ],
  });

  it("adds what the app ships beyond its npm packages, linked from the package that holds it", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "caxa-app-"));
    try {
      writeApp(appDir);
      const mdata = await enrichCaxaMetadataFromApp(metadata(), appDir);
      const byRef = new Map(mdata.components.map((c) => [c["bom-ref"], c]));
      const edges = Object.fromEntries(
        mdata.dependencies.map((d) => [d.ref, d.dependsOn]),
      );

      assert.strictEqual(
        byRef.get("pkg:npm/tools@1.0.0")._integrity,
        "sha512-AAAA",
      );
      // The present tool, with its lazy member, and what it depends on.
      assert.ok(byRef.has("pkg:generic/present@1.0"));
      assert.deepStrictEqual(
        byRef
          .get("pkg:generic/present@1.0")
          .properties.find((p) => p.name === "cdx:caxa:lazyMember"),
        { name: "cdx:caxa:lazyMember", value: "plugins/present/present" },
      );
      assert.deepStrictEqual(edges["pkg:npm/tools@1.0.0"], [
        "pkg:generic/present@1.0",
      ]);
      assert.deepStrictEqual(edges["pkg:generic/present@1.0"], [
        "pkg:golang/example.com/lib@v1.0.0",
        "pkg:golang/odd@1.0",
      ]);
      assert.ok(byRef.has("pkg:golang/odd@1.0"));
      // Pruned tools, what only they reach, orphans and escaping paths stay out.
      for (const absent of [
        "pkg:generic/pruned@1.0",
        "pkg:golang/only-pruned@1.0",
        "pkg:golang/orphan@1.0",
        "pkg:generic/escape@1.0",
      ]) {
        assert.ok(!byRef.has(absent), absent);
      }

      const vendored = edges["pkg:npm/vendor@2.0.0"] || [];
      for (const ref of [
        "pkg:composer/nikic/php-parser@v5.8.0",
        "pkg:gem/ast@2.4.3",
        "pkg:maven/org.example/demo@1.2.3?type=jar",
      ]) {
        assert.ok(byRef.has(ref), `${ref} in ${[...byRef.keys()]}`);
        assert.ok(vendored.includes(ref), `${ref} in ${vendored}`);
      }
      // Files are named by their path inside the app, not the temp directory
      // it was extracted into.
      assert.deepStrictEqual(
        byRef
          .get("pkg:composer/nikic/php-parser@v5.8.0")
          .properties.filter((p) => p.name === "internal:SrcFile")
          .map((p) => p.value),
        ["node_modules/vendor/php/composer.lock"],
      );
      assert.ok(
        ["pkg:generic/present@1.0", "pkg:gem/ast@2.4.3"].every(
          (ref) => byRef.get(ref).scope === "required",
        ),
      );
      // The npm graph caxa recorded is kept.
      assert.deepStrictEqual(edges["pkg:npm/app@1.0.0"], [
        "pkg:npm/tools@1.0.0",
        "pkg:npm/vendor@2.0.0",
      ]);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("leaves the metadata as it is without an app directory", async () => {
    const original = metadata();
    assert.deepStrictEqual(
      await enrichCaxaMetadataFromApp(
        metadata(),
        join(tmpdir(), "caxa-no-such-app"),
      ),
      original,
    );
  });
});
