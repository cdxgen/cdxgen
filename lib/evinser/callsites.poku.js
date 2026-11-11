import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "poku";

import { attributeCallsites, initFromSbom } from "./evinser.js";

// Attribution of callsites records per ecosystem (deliverable 4691): the
// record's purl first, then the import or namespace claims of the BOM's
// components by longest prefix, then a builtin record's runtime, and no
// guessing when two components share the claim.
it("attributes python callsites through ImportedModules, longest prefix first", async () => {
  const purlImportsMap = {
    "pkg:pypi/requests@2.31.0": ["requests"],
    "pkg:pypi/zope-interface@6.0": ["zope.interface"],
  };
  const purlLocationMap = {};
  const stats = await attributeCallsites(
    {
      callsites: [
        {
          file: "client.py",
          line: 6,
          col: 16,
          method: "client.guarded",
          module: "requests.sessions",
          path: "Session",
          kind: "call",
          via: "binding",
        },
        {
          file: "iface.py",
          line: 9,
          col: 7,
          method: "iface.verify",
          module: "zope.interface.declarations",
          path: "implementer",
          kind: "call",
          via: "binding",
        },
        {
          file: "other.py",
          line: 2,
          col: 0,
          module: "boto3",
          path: "client",
          kind: "call",
          via: "binding",
        },
      ],
    },
    "python",
    [],
    purlImportsMap,
    purlLocationMap,
    {},
    undefined,
    ".",
  );
  assert.deepEqual(
    [...(purlLocationMap["pkg:pypi/requests@2.31.0"] || [])],
    ["client.py:6:16"],
  );
  assert.deepEqual(
    [...(purlLocationMap["pkg:pypi/zope-interface@6.0"] || [])],
    ["iface.py:9:7"],
  );
  assert.strictEqual(stats.records, 3);
  assert.strictEqual(stats.byEcosystem, 2);
  assert.strictEqual(stats.unattributed, 1);
});

// Two pypi components claiming the same import leave the record unattributed;
// the more specific claim of one component wins over a general claim of
// another.
it("does not guess when two components claim the same python module", async () => {
  const purlImportsMap = {
    "pkg:pypi/pyyaml@6.0.1": ["yaml"],
    "pkg:pypi/ruamel-yaml@0.18.6": ["yaml"],
    "pkg:pypi/zope-interface@6.0": ["zope"],
    "pkg:pypi/zope-component@5.1.0": ["zope.interface"],
  };
  const purlLocationMap = {};
  const stats = await attributeCallsites(
    {
      callsites: [
        { file: "a.py", line: 1, col: 0, module: "yaml", path: "safe_load" },
        {
          file: "b.py",
          line: 2,
          col: 4,
          module: "zope.interface.declarations",
          path: "implementer",
        },
      ],
    },
    "python",
    [],
    purlImportsMap,
    purlLocationMap,
    {},
    undefined,
    ".",
  );
  // yaml: two claims, no occurrence anywhere; zope: the longest prefix wins
  assert.strictEqual(purlLocationMap["pkg:pypi/pyyaml@6.0.1"], undefined);
  assert.strictEqual(purlLocationMap["pkg:pypi/ruamel-yaml@0.18.6"], undefined);
  assert.deepEqual(
    [...(purlLocationMap["pkg:pypi/zope-component@5.1.0"] || [])],
    ["b.py:2:4"],
  );
  assert.strictEqual(stats.byEcosystem, 1);
  assert.strictEqual(stats.unattributed, 1);
});

// A builtin record goes to the BOM's single runtime component, and to nothing
// when the BOM names no runtime, or two.
it("sends builtin records to a single runtime component only", async () => {
  const runtimeOnly = [
    { name: "python", purl: "pkg:generic/python@3.12.1" },
    { name: "requests", purl: "pkg:pypi/requests@2.31.0" },
  ];
  const withOneRuntime = {};
  const stats = await attributeCallsites(
    {
      callsites: [
        {
          file: "imports.py",
          line: 7,
          col: 7,
          module: "os",
          path: "getcwd",
          kind: "call",
          via: "binding",
          builtin: true,
        },
      ],
    },
    "python",
    runtimeOnly,
    {},
    withOneRuntime,
    {},
    undefined,
    ".",
  );
  assert.deepEqual(
    [...(withOneRuntime["pkg:generic/python@3.12.1"] || [])],
    ["imports.py:7:7"],
  );
  assert.strictEqual(stats.byRuntime, 1);
  const withTwoRuntimes = [
    { name: "python", purl: "pkg:generic/python@3.12.1" },
    { name: "pypy", purl: "pkg:generic/pypy@7.3.15" },
  ];
  const withNoRuntime = {};
  const statsNone = await attributeCallsites(
    {
      callsites: [
        {
          file: "imports.py",
          line: 7,
          col: 7,
          module: "os",
          path: "getcwd",
          kind: "call",
          via: "binding",
          builtin: true,
        },
      ],
    },
    "python",
    withTwoRuntimes,
    {},
    withNoRuntime,
    {},
    undefined,
    ".",
  );
  assert.strictEqual(Object.keys(withNoRuntime).length, 0);
  assert.strictEqual(statsNone.byRuntime, 0);
  assert.strictEqual(statsNone.unattributed, 1);
});

// Maven classes go through the namespaces of the BOM's jars in the evidence
// database; the exact class in a component's imports answers first, and two
// jars claiming the same namespace stay unattributed.
it("attributes java callsites through the namespace database", async () => {
  const dbObjMap = {
    Namespaces: {
      findAll: async () => [
        {
          purl: "pkg:maven/me.lib/lib-lib@0.1.0",
          data: JSON.stringify({ namespaces: ["me.lib"] }),
        },
        {
          purl: "pkg:maven/com.google/guava@32.1.0",
          data: JSON.stringify({ namespaces: ["com.google.common.collect"] }),
        },
        {
          purl: "pkg:maven/com.google/guava@31.0.1",
          data: JSON.stringify({ namespaces: ["com.google.common.collect"] }),
        },
      ],
    },
  };
  const purlLocationMap = {};
  const stats = await attributeCallsites(
    {
      callsites: [
        {
          file: "me/app/App.java",
          line: 14,
          col: -1,
          method: "me.app.App.viaLib",
          module: "me.lib.Lib",
          path: "label",
          kind: "call",
          via: "type",
        },
        {
          file: "me/app/App.java",
          line: 18,
          col: -1,
          module: "com.google.common.collect.ImmutableList",
          path: "of",
          kind: "call",
          via: "binding",
        },
        {
          file: "me/app/App.java",
          line: 21,
          col: -1,
          module: "java.util.List",
          path: "of",
          kind: "call",
          via: "binding",
          builtin: true,
        },
      ],
    },
    "jar",
    [],
    {},
    purlLocationMap,
    {},
    dbObjMap,
    ".",
  );
  // JVM bytecode records carry col -1, so the use site is the line
  assert.deepEqual(
    [...(purlLocationMap["pkg:maven/me.lib/lib-lib@0.1.0"] || [])],
    ["me/app/App.java#14"],
  );
  // two guava versions claim the namespace; the JDK class has no runtime
  assert.strictEqual(
    purlLocationMap["pkg:maven/com.google/guava@32.1.0"],
    undefined,
  );
  assert.strictEqual(
    purlLocationMap["pkg:maven/com.google/guava@31.0.1"],
    undefined,
  );
  assert.strictEqual(stats.byEcosystem, 1);
  assert.strictEqual(stats.unattributed, 2);
});

// The exact class in a component's ImportedModules answers before the
// namespace database.
it("prefers an exact import claim for a java record", async () => {
  const dbObjMap = {
    Namespaces: {
      findAll: async () => [],
    },
  };
  const purlLocationMap = {};
  const stats = await attributeCallsites(
    {
      callsites: [
        {
          file: "App.java",
          line: 9,
          col: 9,
          module: "web.Security",
          path: "login",
          kind: "call",
          via: "type",
        },
      ],
    },
    "java",
    [],
    { "pkg:maven/web/security@2.0.0": ["web.Security"] },
    purlLocationMap,
    {},
    dbObjMap,
    ".",
  );
  assert.deepEqual(
    [...(purlLocationMap["pkg:maven/web/security@2.0.0"] || [])],
    ["App.java:9:9"],
  );
  assert.strictEqual(stats.byEcosystem, 1);
});

// Composer namespaces use backslashes and gem namespaces use ::.
it("attributes composer and gem callsites through the namespace claims", async () => {
  const composerImports = {
    "pkg:composer/acme/widgets@1.2.0": ["Acme\\Widgets"],
  };
  const composerLocations = {};
  const composerStats = await attributeCallsites(
    {
      callsites: [
        {
          file: "src/Shapes.php",
          line: 15,
          col: 21,
          module: "Acme\\Widgets\\Widget",
          kind: "extends",
          via: "binding",
          purl: "pkg:composer/acme/widgets@1.2.0",
        },
        {
          file: "src/Mark.php",
          line: 3,
          col: 5,
          module: "Acme\\Widgets\\Mark",
          kind: "attribute",
          via: "binding",
          purl: "pkg:composer/other/pkg@1.0.0",
        },
        {
          file: "src/Ghost.php",
          line: 8,
          col: 0,
          module: "Ghost\\Thing",
          kind: "new",
          via: "binding",
          purl: "pkg:composer/missing/pkg@1.0.0",
        },
      ],
    },
    "php",
    [{ name: "acme/widgets", purl: "pkg:composer/acme/widgets@1.2.0" }],
    composerImports,
    composerLocations,
    {},
    undefined,
    ".",
  );
  // the record's purl names the component; the purl naming no component falls
  // through to the namespace claim; nothing covers Ghost\\Thing
  assert.deepEqual(
    [...(composerLocations["pkg:composer/acme/widgets@1.2.0"] || [])].sort(),
    ["src/Mark.php:3:5", "src/Shapes.php:15:21"],
  );
  assert.strictEqual(composerStats.byPurl, 1);
  assert.strictEqual(composerStats.byEcosystem, 1);
  assert.strictEqual(composerStats.unattributed, 1);

  const gemImports = {
    "pkg:gem/faraday@2.9.0": ["Faraday"],
  };
  const gemLocations = {};
  const gemStats = await attributeCallsites(
    {
      callsites: [
        {
          file: "lib/shapes.rb",
          line: 7,
          col: 19,
          module: "Faraday::Middleware",
          kind: "extends",
          via: "binding",
          purl: "pkg:gem/faraday@2.9.0",
        },
        {
          file: "lib/client.rb",
          line: 11,
          col: 2,
          module: "Faraday::Connection",
          path: "get",
          kind: "call",
          via: "type",
        },
      ],
    },
    "ruby",
    [{ name: "faraday", purl: "pkg:gem/faraday@2.9.0" }],
    gemImports,
    gemLocations,
    {},
    undefined,
    ".",
  );
  assert.deepEqual([...(gemLocations["pkg:gem/faraday@2.9.0"] || [])].sort(), [
    "lib/client.rb:11:2",
    "lib/shapes.rb:7:19",
  ]);
  assert.strictEqual(gemStats.byPurl, 1);
  assert.strictEqual(gemStats.byEcosystem, 1);
});

// A C header a component vendors is attributed through the include resolver
// when the spelling resolves under the component's directory.
it("attributes C callsites through the include resolver", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "evinse-c-callsites-"));
  try {
    const vendored = join(tmpDir, "third_party", "jansson");
    mkdirSync(vendored, { recursive: true });
    writeFileSync(join(vendored, "jansson.h"), "#define JANSSON_MAJOR 2\n");
    const components = [
      {
        name: "jansson",
        purl: "pkg:generic/jansson@2.14",
        properties: [
          { name: "cdx:vendored:path", value: "third_party/jansson" },
        ],
      },
    ];
    const purlLocationMap = {};
    const stats = await attributeCallsites(
      {
        callsites: [
          {
            file: "src/main.c",
            line: 12,
            col: 11,
            module: "third_party/jansson/jansson.h",
            path: "json_loads",
            kind: "call",
            via: "binding",
          },
          {
            file: "src/main.c",
            line: 4,
            col: 0,
            module: "stdio.h",
            kind: "ref",
            via: "binding",
            builtin: true,
          },
        ],
      },
      "c",
      [...components, { name: "glibc", purl: "pkg:generic/glibc@2.39" }],
      {},
      purlLocationMap,
      {},
      undefined,
      tmpDir,
    );
    assert.deepEqual(
      [...(purlLocationMap["pkg:generic/jansson@2.14"] || [])],
      ["src/main.c:12:11"],
    );
    assert.deepEqual(
      [...(purlLocationMap["pkg:generic/glibc@2.39"] || [])],
      ["src/main.c:4:0"],
    );
    assert.strictEqual(stats.byEcosystem, 1);
    assert.strictEqual(stats.byRuntime, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// A record whose purl names no component and whose module matches nothing is
// counted as unattributed and writes no occurrence.
it("counts a purl naming no component as unattributed", async () => {
  const purlLocationMap = {};
  const stats = await attributeCallsites(
    {
      callsites: [
        {
          file: "app.py",
          line: 5,
          col: 0,
          module: "unknownpkg",
          path: "run",
          kind: "call",
          via: "binding",
          purl: "pkg:pypi/ghost@1.0.0",
        },
      ],
    },
    "python",
    [],
    { "pkg:pypi/requests@2.31.0": ["requests"] },
    purlLocationMap,
    {},
    undefined,
    ".",
  );
  assert.strictEqual(Object.keys(purlLocationMap).length, 0);
  assert.strictEqual(stats.byPurl, 0);
  assert.strictEqual(stats.unattributed, 1);
});

// --exclude applies to callsites records too, on the record's `file`, with
// either path separator (deliverable 4692).
it("filters callsites records by the exclude patterns, both path separators", async () => {
  const { filterAtomSlicesByExcludePatterns } = await import(
    "../inventory/atomUtils.js"
  );
  const filtered = filterAtomSlicesByExcludePatterns(
    {
      callsites: [
        { file: "src/keep.js", line: 1, col: 0, module: "tar", path: "x" },
        {
          file: "test/generated/skip.js",
          line: 2,
          col: 0,
          module: "tar",
          path: "y",
        },
        {
          file: "test\\windows\\skip.ts",
          line: 3,
          col: 0,
          module: "tar",
          path: "z",
        },
        {
          file: "test/keep-deep/ok.js",
          line: 4,
          col: 0,
          module: "tar",
          path: "w",
        },
      ],
    },
    ["test/generated/**", "test/windows/**"],
  );
  assert.deepEqual(
    filtered.callsites.map((r) => r.file),
    ["src/keep.js", "test/keep-deep/ok.js"],
  );
});

// --annotate embeds the callsites slice beside the other slices.
it("embeds the callsites slice as an annotation", async () => {
  const { createEvinseFile } = await import("./evinser.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "evinse-callsite-annotate-"));
  try {
    const purl = "pkg:npm/tar@6.2.1";
    const bomFile = join(tmpDir, "bom.json");
    writeFileSync(
      bomFile,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: 1.6,
        serialNumber: "urn:uuid:12345678-4321-4321-4321-123456789012",
        metadata: {
          tools: {
            components: [
              { type: "application", name: "cdxgen", version: "5.0.0" },
            ],
          },
        },
        components: [
          {
            type: "library",
            name: "tar",
            version: "6.2.1",
            purl,
            properties: [{ name: "internal:ImportedModules", value: "tar" }],
          },
        ],
      }),
    );
    const callsitesFile = join(tmpDir, "callsites.slices.json");
    const callsitesSlice = {
      callsites: [
        { file: "src/app.js", line: 3, col: 9, module: "tar", path: "x" },
      ],
    };
    writeFileSync(callsitesFile, JSON.stringify(callsitesSlice));
    const bomJson = await createEvinseFile(
      {
        usagesSlicesFile: undefined,
        callsitesSlicesFile: callsitesFile,
        purlLocationMap: {},
        clearedOccurrencePurls: new Set(),
        servicesMap: {},
        dataFlowFrames: {},
      },
      {
        input: bomFile,
        output: join(tmpDir, "bom.evinse.json"),
        annotate: true,
      },
    );
    const texts = (bomJson.annotations || []).map((a) => a.text);
    assert.strictEqual(texts.length, 1);
    assert.strictEqual(texts[0].includes('"callsites"'), true);
    assert.strictEqual(texts[0].includes("src/app.js"), true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Both slices describing the same use site give one occurrence: the callsites
// record names the use site, and the usages line-only entry of that line is
// dropped rather than counted beside it.
it("does not double count a use site both slices found", async () => {
  const { createEvinseFile } = await import("./evinser.js");
  const tmpDir = mkdtempSync(join(tmpdir(), "evinse-no-double-"));
  try {
    const purl = "pkg:pypi/requests@2.31.0";
    const bomFile = join(tmpDir, "bom.json");
    writeFileSync(
      bomFile,
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: 1.6,
        metadata: {},
        components: [
          {
            type: "library",
            name: "requests",
            version: "2.31.0",
            purl,
            properties: [
              { name: "internal:ImportedModules", value: "requests" },
            ],
            evidence: {
              occurrences: [{ location: "client.py", line: 6 }],
            },
          },
        ],
      }),
    );
    const { purlLocationMap, purlImportsMap, purlSymbolMap } = initFromSbom(
      [
        {
          type: "library",
          name: "requests",
          version: "2.31.0",
          purl,
          properties: [{ name: "internal:ImportedModules", value: "requests" }],
          evidence: {
            occurrences: [{ location: "client.py", line: 6 }],
          },
        },
      ],
      "python",
    );
    // the usages slice put the use on line 6 of client.py; the callsites
    // record pins it to column 16 of the same line
    await attributeCallsites(
      {
        callsites: [
          {
            file: "client.py",
            line: 6,
            col: 16,
            module: "requests",
            path: "get",
            kind: "call",
            via: "binding",
          },
        ],
      },
      "python",
      [],
      purlImportsMap,
      purlLocationMap,
      purlSymbolMap,
      undefined,
      ".",
    );
    const bomJson = await createEvinseFile(
      {
        purlLocationMap,
        purlSymbolMap,
        clearedOccurrencePurls: new Set(),
        servicesMap: {},
        dataFlowFrames: {},
      },
      { input: bomFile, output: join(tmpDir, "bom.evinse.json") },
    );
    assert.strictEqual(bomJson.components[0].evidence.occurrences.length, 1);
    assert.deepEqual(bomJson.components[0].evidence.occurrences, [
      { location: "client.py", line: 6, offset: 16, symbol: "requests.get" },
    ]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// A usages slices file alone must still give the occurrences it always gave:
// an empty or absent callsites slice leaves the usages evidence untouched.
it("keeps usages occurrences when no callsites slice is present", async () => {
  const purlLocationMap = {
    "pkg:pypi/requests@2.31.0": new Set(["client.py#6"]),
  };
  const stats = await attributeCallsites(
    { callsites: [] },
    "python",
    [],
    { "pkg:pypi/requests@2.31.0": ["requests"] },
    purlLocationMap,
    {},
    undefined,
    ".",
  );
  assert.strictEqual(stats.records, 0);
  assert.deepEqual(
    [...purlLocationMap["pkg:pypi/requests@2.31.0"]],
    ["client.py#6"],
  );
});

// The secure-mode write-permission checks cover the callsites slices file,
// which the usages atom run creates.
it("lists the slices files an evidence run writes", async () => {
  const { evidenceSlicesFileOptions } = await import(
    "../inventory/atomUtils.js"
  );
  assert.deepEqual(evidenceSlicesFileOptions({}), [
    "deps-slices-file",
    "usages-slices-file",
    "callsites-slices-file",
    "reachables-slices-file",
  ]);
  assert.deepEqual(evidenceSlicesFileOptions({ type: "java,swift" }).length, 5);
  assert.strictEqual(
    evidenceSlicesFileOptions({ type: "java" }).includes(
      "semantics-slices-file",
    ),
    false,
  );
});
