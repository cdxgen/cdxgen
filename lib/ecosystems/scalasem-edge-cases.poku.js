import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import {
  analyzeScalaProject,
  collectScalaJsNpmComponents,
  collectScalasemEvidence,
  componentCoordinateIndex,
  jarPathCoordinates,
  matchClasspathEntry,
  ScalaJoinIndex,
  sanitizeJdbcUrl,
  scalaPurlPlatform,
  scalasemCryptoOidKey,
  scalasemOutputFile,
  scalasemProviderPurl,
  scalasemServiceEndpoint,
  scalasemServiceName,
} from "./scalasem.js";

function quiet(fn) {
  const original = { log: console.log, warn: console.warn };
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
  }
}

async function quietAsync(fn) {
  const original = { log: console.log, warn: console.warn };
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
  }
}

describe("JDBC and service addresses", () => {
  // Each row: the address a report may carry, the address the BOM keeps, the
  // service name, and the secrets that must not survive.
  const rows = [
    [
      "jdbc:mysql://admin:se;cret@db.internal/x",
      "jdbc:mysql://db.internal/x",
      "mysql-db.internal",
      ["admin", "se", "cret"],
    ],
    [
      "jdbc:mysql://admin:p?w@db.internal/x",
      "jdbc:mysql://db.internal/x",
      "mysql-db.internal",
      ["admin"],
    ],
    [
      "jdbc:mysql://admin:p#w@db.internal/x",
      "jdbc:mysql://db.internal/x",
      "mysql-db.internal",
      ["admin"],
    ],
    [
      "jdbc:postgresql://u:pa/ss@host/db",
      "jdbc:postgresql://host/db",
      "postgresql-host",
      ["pa/ss", "u:"],
    ],
    [
      "jdbc:postgresql://u:p@ss@host/db",
      "jdbc:postgresql://host/db",
      "postgresql-host",
      ["u:p", "ss@"],
    ],
    [
      "jdbc:mysql://u:p=w@host/db",
      "jdbc:mysql://host/db",
      "mysql-host",
      ["p=w"],
    ],
    [
      "jdbc:mysql://user:12345;x@h/db",
      "jdbc:mysql://h/db",
      "mysql-h",
      ["user", "12345"],
    ],
    [
      "jdbc:oracle:oci:scott/tiger@myhost:1521:orcl",
      "jdbc:oracle:oci:@myhost:1521:orcl",
      "oracle-myhost",
      ["scott", "tiger"],
    ],
    [
      "jdbc:oracle:thin:scott/tiger@//h:1521/svc",
      "jdbc:oracle:thin:@//h:1521/svc",
      "oracle-h",
      ["scott", "tiger"],
    ],
    [
      "jdbc:oracle:thin:scott/tiger@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=orahost)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=x)))",
      "jdbc:oracle:thin:@orahost:1521",
      "oracle-orahost",
      ["scott", "tiger", "SERVICE_NAME"],
    ],
    [
      "jdbc:db:user:pass@host:1/x",
      "jdbc:db:@host:1",
      "db-host",
      ["user", "pass"],
    ],
    [
      "jdbc:db2://host:50000/db:user=bob;password=x;",
      "jdbc:db2://host:50000/db",
      "db2-host",
      ["bob", "password"],
    ],
    [
      "jdbc:informix-sqli://h:9088/db:INFORMIXSERVER=s;user=u;password=p",
      "jdbc:informix-sqli://h:9088/db",
      "informix-sqli-h",
      ["INFORMIXSERVER", "password"],
    ],
    [
      "jdbc:mysql://address=(protocol=tcp)(host=h1)(port=3306)(user=u)(password=p)/db",
      "jdbc:mysql://h1:3306/db",
      "mysql-h1",
      ["user=", "password"],
    ],
    [
      "jdbc:mysql://(host=h2,port=3307,user=u,password=p;w)/db",
      "jdbc:mysql://h2:3307/db",
      "mysql-h2",
      ["user=", "password", "p;w"],
    ],
    [
      "jdbc:sqlserver://host:1433;user=a@b.com;password=x",
      "jdbc:sqlserver://host:1433",
      "sqlserver-host",
      ["a@b.com", "password"],
    ],
    [
      "jdbc:postgresql://host:5432/db?user=a@b&password=x",
      "jdbc:postgresql://host:5432/db",
      "postgresql-host",
      ["a@b", "password"],
    ],
    [
      "jdbc:h2:mem:test;USER=sa;PASSWORD=x",
      "jdbc:h2:mem:test",
      "h2",
      ["USER", "PASSWORD"],
    ],
    [
      "jdbc:mysql:loadbalance://u:p@h1,h2/db",
      "jdbc:mysql:loadbalance://h1,h2/db",
      "mysql-h1",
      ["u:p"],
    ],
    [
      "jdbc:postgresql://[::1]:5432/db",
      "jdbc:postgresql://[::1]:5432/db",
      "postgresql-::1",
      [],
    ],
  ];

  for (const [url, address, name, secrets] of rows) {
    it(`keeps no credentials of ${url}`, () => {
      assert.strictEqual(sanitizeJdbcUrl(url), address);
      assert.strictEqual(scalasemServiceName({ url }), name);
      assert.strictEqual(scalasemServiceEndpoint({ url }), address);
      for (const secret of secrets) {
        assert.ok(!address.includes(secret), `${address} keeps ${secret}`);
        assert.ok(!name.includes(secret), `${name} keeps ${secret}`);
      }
    });
  }

  it("drops the userinfo of a host value and of a URL whose password holds a slash", () => {
    assert.strictEqual(scalasemServiceName({ host: "user:pw@h:5432" }), "h");
    assert.strictEqual(
      scalasemServiceEndpoint({ host: "user:pw@h:5432" }),
      "h:5432",
    );
    assert.strictEqual(scalasemServiceName({ host: "[::1]:80" }), "::1");
    assert.strictEqual(scalasemServiceEndpoint({ host: "u:p/w@h" }), "h");
    assert.strictEqual(scalasemServiceName({ url: "http://u:1/w@h/x" }), "h");
    assert.strictEqual(
      scalasemServiceEndpoint({ url: "http://u:1/w@h/x" }),
      "http://h",
    );
    assert.strictEqual(
      scalasemServiceEndpoint({ url: "kafka://u:p/w@broker:9092/t" }),
      "kafka://broker:9092",
    );
    assert.strictEqual(
      scalasemServiceName({ url: "kafka://u:p/w@broker:9092/t" }),
      "broker",
    );
    // An address in a parameter is not userinfo.
    assert.strictEqual(
      scalasemServiceEndpoint({ url: "HTTPS://h:8443/x?mail=a@b" }),
      "https://h:8443",
    );
  });
});

describe("Scala.js and Scala Native components", () => {
  it("reads the platform with or without the Scala binary suffix", () => {
    for (const [purl, platform] of [
      ["pkg:maven/com.lihaoyi/upickle_sjs1_3@3.1.0", "js"],
      ["pkg:maven/com.lihaoyi/upickle_sjs1@3.1.0", "js"],
      ["pkg:maven/org.scala-js/scalajs-dom_sjs0.6_2.12@0.9.8", "js"],
      ["pkg:maven/com.lihaoyi/upickle_native0.5_3@3.1.0", "native"],
      ["pkg:maven/com.lihaoyi/upickle_native0.4_2.13@2.0.0", "native"],
      ["pkg:maven/com.lihaoyi/upickle_3@3.1.0", "jvm"],
      ["pkg:maven/com.lihaoyi/upickle@3.1.0", "jvm"],
      [undefined, "jvm"],
    ]) {
      assert.strictEqual(scalaPurlPlatform(purl), platform, purl);
    }
  });

  it("joins a Scala.js file to a jar-scanned Scala.js component", () => {
    const index = new ScalaJoinIndex();
    const dom = "pkg:maven/org.scala-js/scalajs-dom_sjs1_3@2.8.0?type=jar";
    const jvm = "pkg:maven/org.example/dom-shim_3@1.0.0?type=jar";
    index.addNamespaces(dom, ["org.scalajs.dom.Element"], 2);
    index.addNamespaces(jvm, ["org.scalajs.dom.Element"], 2);
    assert.strictEqual(index.lookup("org.scalajs.dom.Element", "js"), dom);
    assert.strictEqual(index.lookup("org.scalajs.dom.Element", "jvm"), jvm);
  });

  it("finds a Scala.js build from a jar-scanned name", async () => {
    const work = mkdtempSync(join(tmpdir(), "scalasem-sjs-"));
    try {
      const result = await collectScalaJsNpmComponents(work, [
        { purl: "pkg:maven/org.scala-js/scalajs-library_2.13@1.16.0" },
      ]);
      assert.deepStrictEqual(result, {
        components: [],
        roots: [],
        dependencies: [],
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("ScalaJoinIndex package owners", () => {
  const circe = "pkg:maven/io.circe/circe-core@0.14.6";
  const util = "pkg:maven/com.acme/acme-util@1.0.0";
  const index = new ScalaJoinIndex();
  index.addNamespaces(circe, ["io.circe.Json", "io.circe.syntax.package$"], 2);
  index.addNamespaces(util, ["com.acme.Util"], 2);
  index.addProjectDefinitions({
    "src/main/scala/Main.scala": {
      definitions: [{ kind: "object", owner: "com.acme.app", name: "Main" }],
    },
  });

  it("never credits a library with a sub-package it does not ship", () => {
    assert.strictEqual(
      index.lookup("io.circe.generic.auto.deriveEncoder"),
      undefined,
    );
    assert.strictEqual(index.lookup("com.acme.app.Helper.run"), undefined);
  });

  it("still credits the package a library ships, and its package objects", () => {
    assert.strictEqual(index.lookup("io.circe.Json.fromString"), circe);
    assert.strictEqual(index.lookup("io.circe.Decoder.decodeJson"), circe);
    assert.strictEqual(index.lookup("io.circe"), circe);
    assert.strictEqual(index.lookup("io.circe.syntax.asJson"), circe);
    assert.strictEqual(index.lookup("com.acme.Util.helper"), util);
  });

  it("indexes no compiler-generated class names", () => {
    const generated = new ScalaJoinIndex();
    const purl = "pkg:maven/a/a@1";
    generated.addNamespaces(
      purl,
      [
        "a.Foo",
        "a.Foo$$anon$1",
        "a.Foo$$anonfun$bar$1",
        "a.Foo$$Lambda$12",
        "a.Foo$1",
        "a.Foo$Inner",
        "a.$colon$colon",
      ],
      2,
    );
    assert.deepStrictEqual(generated.namespacesByPurl.get(purl), [
      "a.Foo",
      "a.Foo$Inner",
      "a.$colon$colon",
    ]);
    assert.ok(
      ![...generated.classPurls.keys()].some((key) => key.includes("anon")),
    );
    assert.ok(generated.classPurls.has("a.Foo.Inner"));
    assert.ok(generated.classPurls.has("a.$colon$colon"));
    assert.ok(!generated.classPurls.has("a."));
  });
});

describe("classpath entries", () => {
  const component = (purl, properties = []) => ({ purl, properties });
  const circe = component("pkg:maven/io.circe/circe-core_3@0.14.6?type=jar");
  const index = componentCoordinateIndex([circe]);

  it("shortens a report group only by the directories the path names", () => {
    const path =
      "/home/u/.cache/coursier/v1/https/packages.example.com/maven/io/circe/circe-core_3/0.14.6/circe-core_3-0.14.6.jar";
    const entry = {
      group: "maven.io.circe",
      artifact: "circe-core_3",
      version: "0.14.6",
      path,
    };
    assert.strictEqual(
      matchClasspathEntry(entry, index, "jvm")?.component,
      circe,
    );
    assert.deepStrictEqual(
      jarPathCoordinates(entry).map((coordinates) => coordinates.group),
      ["io.circe", "circe"],
    );
    // A group the path does not end in is never tried.
    assert.deepStrictEqual(
      jarPathCoordinates({ ...entry, group: "maven.org.typelevel" }),
      [],
    );
  });

  it("prefers the longest group, and leaves an ambiguous direct match alone", () => {
    const wrong = component("pkg:maven/circe/circe-core_3@0.14.6");
    const both = componentCoordinateIndex([wrong, circe]);
    const entry = {
      group: "maven.io.circe",
      artifact: "circe-core_3",
      version: "0.14.6",
      path: "C:\\Users\\u\\AppData\\Local\\Coursier\\cache\\v1\\https\\r.example\\maven\\io\\circe\\circe-core_3\\0.14.6\\circe-core_3-0.14.6.jar",
    };
    assert.strictEqual(
      matchClasspathEntry(entry, both, "jvm")?.component,
      circe,
    );
    // A classpath name without a Scala suffix fits the 2.13 and the 3 build
    // alike, and the path, which names one of them, is not consulted then.
    const twice = componentCoordinateIndex([
      component("pkg:maven/io.circe/circe-core_3@0.14.6?type=jar"),
      component("pkg:maven/io.circe/circe-core_2.13@0.14.6?type=jar"),
    ]);
    assert.strictEqual(
      matchClasspathEntry(
        {
          group: "io.circe",
          artifact: "circe-core",
          version: "0.14.6",
          path: "/home/u/.gradle/caches/modules-2/files-2.1/io.circe/circe-core_3/0.14.6/0a1b2c/circe-core_3-0.14.6.jar",
        },
        twice,
        "jvm",
      ),
      undefined,
    );
  });

  it("reads the Gradle and Ivy cache layouts", () => {
    const cases = [
      [
        "/home/u/.gradle/caches/modules-2/files-2.1/io.circe/circe-core_3/0.14.6/0a1b2c/circe-core_3-0.14.6.jar",
        { group: "io.circe", artifact: "circe-core_3", version: "0.14.6" },
      ],
      [
        "/home/u/.ivy2/cache/io.circe/circe-core_3/jars/circe-core_3-0.14.6.jar",
        { group: "io.circe", artifact: "circe-core_3", version: "0.14.6" },
      ],
      [
        "C:\\Users\\u\\.ivy2\\local\\io.circe\\circe-core_3\\0.14.6\\jars\\circe-core_3.jar",
        { group: "io.circe", artifact: "circe-core_3", version: "0.14.6" },
      ],
      [
        "/home/u/.ivy2/cache/io.circe/circe-core_3/bundles/circe-core_3-0.14.6.jar",
        { group: "io.circe", artifact: "circe-core_3", version: "0.14.6" },
      ],
    ];
    for (const [path, expected] of cases) {
      assert.deepStrictEqual(jarPathCoordinates({ path }), [expected], path);
      assert.strictEqual(
        matchClasspathEntry({ path }, index, "jvm")?.component,
        circe,
        path,
      );
    }
    assert.deepStrictEqual(jarPathCoordinates({ path: "/lib/x.jar" }), []);
    assert.deepStrictEqual(jarPathCoordinates({}), []);
  });

  it("puts the spellings of one library built for overlapping Scala versions on one entry", () => {
    const sbt = component("pkg:maven/io.circe/circe-core@0.14.6", [
      { name: "cdx:scala:compilerVersion", value: "2.13" },
      { name: "cdx:scala:compilerVersion", value: "3" },
    ]);
    const jar = component("pkg:maven/io.circe/circe-core_3@0.14.6?type=jar");
    const maven212 = component("pkg:maven/io.circe/circe-core_2.12@0.14.6");
    for (const order of [
      [sbt, jar, maven212],
      [jar, maven212, sbt],
      [maven212, sbt, jar],
    ]) {
      const overlapping = componentCoordinateIndex(order);
      assert.strictEqual(
        matchClasspathEntry(
          { group: "io.circe", artifact: "circe-core_3", version: "0.14.6" },
          overlapping,
          "jvm",
        )?.component,
        sbt,
      );
      assert.strictEqual(
        matchClasspathEntry(
          { group: "io.circe", artifact: "circe-core_2.12", version: "0.14.6" },
          overlapping,
          "jvm",
        )?.component,
        maven212,
      );
    }
  });
});

describe("jar namespace map", () => {
  it("reads entries written as objects and as newline-joined strings", async () => {
    const components = [
      { purl: "pkg:maven/io.appthreat/odb2-core@3.1.1?type=jar" },
      { purl: "pkg:maven/com.lihaoyi/ujson@4.4.3?type=jar" },
    ];
    const evidence = await collectScalasemEvidence(
      {
        _meta: { schemaVersion: "scalasem/2" },
        modules: [],
        "src/A.scala": {
          scope: "main",
          references: [
            { symbol: "overflowdb.Graph", line: 2 },
            { symbol: "ujson.Value", line: 3 },
          ],
        },
      },
      components,
      {
        scalaNamespaceMap: {
          "pkg:maven/io.appthreat/odb2-core@3.1.1?type=jar":
            "overflowdb.Graph\noverflowdb.Node",
          "pkg:maven/com.lihaoyi/ujson@4.4.3?type=jar": {
            namespaces: ["ujson.Value"],
          },
        },
      },
    );
    assert.deepStrictEqual(Object.keys(evidence.purlLocationMap).sort(), [
      "pkg:maven/com.lihaoyi/ujson@4.4.3?type=jar",
      "pkg:maven/io.appthreat/odb2-core@3.1.1?type=jar",
    ]);
  });
});

describe("call stack frames", () => {
  it("names the package of a class nested in an object", async () => {
    const purl = "pkg:maven/com.github.pathikrit/better-files@3.9.2";
    const evidence = await collectScalasemEvidence(
      {
        _meta: { schemaVersion: "scalasem/2" },
        modules: [],
        "src/U.scala": {
          scope: "main",
          definitions: [
            {
              kind: "def",
              name: "copy",
              owner:
                "io.appthreat.jimple2cpg.util.ProgramHandlingUtil$.ClassFile",
              line: 1,
              endLine: 10,
            },
          ],
        },
        callStacks: [
          {
            frames: [{ file: "src/U.scala", function: "copy", line: 5 }],
            sink: {
              file: "src/U.scala",
              line: 5,
              name: "copyTo",
              owner: "better.files.File",
            },
          },
        ],
      },
      [
        {
          purl,
          properties: [
            { name: "internal:Namespaces", value: "better.files.File" },
          ],
        },
      ],
    );
    const [frames] = evidence.dataFlowFrames[purl];
    assert.strictEqual(frames[0].package, "io.appthreat.jimple2cpg.util");
    assert.strictEqual(
      frames[0].module,
      "io.appthreat.jimple2cpg.util.ProgramHandlingUtil$.ClassFile",
    );
  });
});

describe("crypto evidence", () => {
  it("looks AES modes up in any case", () => {
    assert.strictEqual(
      scalasemCryptoOidKey("AES", 256, "gcm"),
      scalasemCryptoOidKey("AES", 256, "GCM"),
    );
    assert.notStrictEqual(
      scalasemCryptoOidKey("AES", 256, "gcm"),
      scalasemCryptoOidKey("AES"),
    );
  });

  it("records a finding without a line as the file alone", async () => {
    const evidence = await collectScalasemEvidence(
      {
        _meta: { schemaVersion: "scalasem/2" },
        modules: [],
        crypto: [
          {
            kind: "cipher",
            algorithm: "AES",
            keySize: 256,
            mode: "GCM",
            primitive: "ae",
            file: "src/A.scala",
          },
          { kind: "cipher", algorithm: "NoSuchCipher", file: "src/B.scala" },
        ],
      },
      [],
    );
    const occurrences = evidence.cryptoComponents.flatMap(
      (asset) => asset.evidence.occurrences,
    );
    assert.deepStrictEqual(occurrences, [{ location: "src/A.scala" }]);
    const values = evidence.metadataProperties
      .filter((property) => property.name === "cdx:scalasem:crypto:cipher")
      .map((property) => property.value);
    assert.deepStrictEqual(values, ["NoSuchCipher@src/B.scala"]);
  });

  it("picks the provider on the classpath, then the exact artifact, whatever the order", () => {
    const components = [
      { purl: "pkg:maven/org.bouncycastle/bcprov-ext-jdk18on@1.80" },
      { purl: "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.80" },
      { purl: "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.78" },
    ];
    for (const order of [components, [...components].reverse()]) {
      assert.strictEqual(
        scalasemProviderPurl("bcprov", order),
        "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.78",
      );
      assert.strictEqual(
        scalasemProviderPurl(
          "bcprov",
          order,
          new Set(["pkg:maven/org.bouncycastle/bcprov-jdk18on@1.80"]),
        ),
        "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.80",
      );
    }
  });

  it("attributes a JavaScript import to the hoisted copy of a package", async () => {
    const npm = (version, location) => ({
      purl: `pkg:npm/react@${version}`,
      properties: [{ name: "internal:LocalNodeModulesPath", value: location }],
    });
    const hoisted = npm("18.3.1", "node_modules/react");
    const nested = npm("17.0.2", "node_modules/x/node_modules/react");
    for (const order of [
      [hoisted, nested],
      [nested, hoisted],
    ]) {
      const evidence = await collectScalasemEvidence(
        {
          _meta: { schemaVersion: "scalasem/2" },
          modules: [],
          jsModules: [{ module: "react", file: "src/App.scala", line: 3 }],
        },
        order,
      );
      assert.deepStrictEqual(Object.keys(evidence.purlLocationMap), [
        hoisted.purl,
      ]);
    }
  });
});

describe("persisted reports", () => {
  const report = (projectPath, extra = {}) => ({
    _meta: {
      schemaVersion: "scalasem/2",
      tool: "scalasem",
      ...(projectPath ? { projectPath } : {}),
      diagnostics: [],
      ...extra,
    },
    config: { routes: [] },
    modules: [],
    "src/main/scala/A.scala": { scope: "main", definitions: [] },
  });

  function project() {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "scalasem-keep-")));
    const projectDir = join(work, "app");
    mkdirSync(join(projectDir, "src", "main", "scala"), { recursive: true });
    writeFileSync(join(projectDir, "build.sbt"), "");
    writeFileSync(join(projectDir, "src", "main", "scala", "A.scala"), "");
    const past = new Date(Date.now() - 120_000);
    for (const file of [
      join(projectDir, "build.sbt"),
      join(projectDir, "src", "main", "scala", "A.scala"),
    ]) {
      utimesSync(file, past, past);
    }
    const stubs = join(work, "stubs");
    mkdirSync(stubs);
    const failing = join(stubs, "fail.js");
    writeFileSync(failing, "process.exit(9);");
    const writing = join(stubs, "write.js");
    writeFileSync(
      writing,
      `require("node:fs").writeFileSync(process.argv[3], ${JSON.stringify(
        JSON.stringify(report(projectDir)),
      )});`,
    );
    return { work, projectDir, failing, writing };
  }

  it("has nowhere to keep a report without an output", () => {
    assert.strictEqual(
      scalasemOutputFile({ semanticsSlicesFile: "semantics.slices.json" }),
      undefined,
    );
  });

  it("reuses a kept report only for the settings and sources it was made from", () => {
    const { work, projectDir, failing, writing } = project();
    try {
      const options = {
        input: join(work, "missing-bom.json"),
        semanticsSlicesFile: "semantics.slices.json",
        output: join(work, "bom.evinse.json"),
        installDeps: true,
      };
      const kept = join(work, "semantics.slices.json");
      const first = quiet(() =>
        analyzeScalaProject(projectDir, {
          ...options,
          scalasemCommand: writing,
        }),
      );
      assert.strictEqual(first.reportFile, kept);
      assert.deepStrictEqual(
        JSON.parse(readFileSync(kept, "utf-8"))._meta.cdxgenRunSettings,
        { build: true, includeTests: false },
      );
      const again = (extra = {}) =>
        quiet(() =>
          analyzeScalaProject(projectDir, {
            ...options,
            ...extra,
            scalasemCommand: failing,
          }),
        ).report;
      assert.ok(again(), "the same settings reuse the report");
      assert.strictEqual(again({ scalasemIncludeTests: true }), undefined);
      assert.strictEqual(again({ installDeps: false }), undefined);
      // A source written after the report makes it stale.
      const future = new Date(Date.now() + 60_000);
      const source = join(projectDir, "src", "main", "scala", "A.scala");
      utimesSync(source, future, future);
      assert.strictEqual(again(), undefined);
      // So does one that went away.
      unlinkSync(source);
      assert.strictEqual(again(), undefined);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("reuses a report through a symbolic link to the project, and never one without a project", () => {
    const { work, projectDir, failing } = project();
    try {
      const link = join(work, "linked");
      symlinkSync(projectDir, link, "junction");
      const reportFile = join(work, "given.json");
      const options = {
        input: join(work, "missing-bom.json"),
        semanticsSlicesFile: reportFile,
        output: join(work, "bom.evinse.json"),
        scalasemCommand: failing,
      };
      writeFileSync(reportFile, JSON.stringify(report(link)));
      assert.ok(quiet(() => analyzeScalaProject(projectDir, options)).report);
      writeFileSync(reportFile, JSON.stringify(report(undefined)));
      const cwd = process.cwd();
      process.chdir(projectDir);
      try {
        assert.strictEqual(
          quiet(() => analyzeScalaProject(projectDir, options)).report,
          undefined,
        );
      } finally {
        process.chdir(cwd);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("removes its run directory when the analyzer cannot be started", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "scalasem-run-"));
    const previous = process.env.CDXGEN_TEMP_DIR;
    process.env.CDXGEN_TEMP_DIR = scratch;
    try {
      const { analyzeScalaProject: analyze } = await esmock("./scalasem.js", {
        "../core/fs.js": {
          safeSpawnSync: () => {
            throw new Error("command not allowed");
          },
        },
      });
      const result = await quietAsync(() =>
        analyze(scratch, { scalasemCommand: "/no/such/scalasem.js" }),
      );
      assert.strictEqual(result.report, undefined);
      assert.ok(
        result.metadataProperties.some(
          (property) =>
            property.name === "cdx:scalasem:diagnostic:scalasem-not-runnable",
        ),
      );
      assert.deepStrictEqual(readdirSync(scratch), []);
    } finally {
      if (previous === undefined) {
        delete process.env.CDXGEN_TEMP_DIR;
      } else {
        process.env.CDXGEN_TEMP_DIR = previous;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
