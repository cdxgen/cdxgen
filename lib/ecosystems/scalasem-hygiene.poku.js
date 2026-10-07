import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

// Every value the Scala evidence emits is walked: a URL may carry no query,
// fragment or userinfo, a data store address no credentials, and no string may
// name a machine path. The walk covers the recorded reports and the BOM the
// evidence step builds from each of them, whose services fixture carries a URL
// with credentials and a JDBC address with a password to prove they are
// dropped.

function violations(line) {
  const found = [];
  // Purls carry qualifiers, which are not a URL query; everything else with a
  // scheme must be a sanitized URL.
  const purl = line.startsWith("pkg:");
  const url = /^([a-z][a-z0-9+.-]*):\/{2}([^/?#\s]*)(.*)$/i.exec(line);
  if (!purl && url) {
    if (line.includes("?")) {
      found.push("URL query");
    }
    if (line.includes("#")) {
      found.push("URL fragment");
    }
    if (url[2].includes("@")) {
      found.push("URL userinfo");
    }
  }
  if (/user=|password=/i.test(line)) {
    found.push("credential parameter");
  }
  // Some drivers take the user and password before the host of the address:
  // jdbc:oracle:thin:admin/hunter2@db.internal:1521:orcl.
  if (/^jdbc:[^/]*\//i.test(line) && line.includes("@")) {
    found.push("URL userinfo");
  }
  // Machine paths: the BOM names the project and the jars of its dependency
  // classpath (walked separately), and nothing else on this computer.
  if (
    /^\/(Users|home|tmp|var|private|root|coursier)\//.test(line) ||
    /^[A-Za-z]:[\\/]/.test(line) ||
    /%LOCALAPPDATA%/i.test(line) ||
    line.startsWith("~/") ||
    /(^|\/)\.cache\//.test(line) ||
    line.includes("Library/Caches")
  ) {
    found.push("machine path");
  }
  if (/(^|\/)\.\.($|\/)/.test(line)) {
    found.push("path outside the project");
  }
  if (found.length || purl) {
    return found;
  }
  // A value the BOM carries must be one of: prose, an identifier or a
  // spelling of an algorithm, object identifier, version or hash, a route
  // path, file path, host, topic, or a sanitized URL, or a symbolic operator
  // name. Anything else means a value reached the BOM unshaped.
  const shaped =
    /\s/.test(line) ||
    // The bom-ref of a crypto asset names the algorithm and its OID, and the
    // property of an algorithm without one names the finding it came from.
    line.startsWith("crypto/") ||
    /^[A-Za-z0-9_.$+-]+@[A-Za-z0-9_./$+-]+#[0-9]+$/.test(line) ||
    /^[A-Za-z0-9_$+.<>-]+([.:][=!+/*%<>&|~^:-]+)*$/.test(line) ||
    /^[A-Za-z0-9_./:${}<>#*-]+$/.test(line) ||
    /^[A-Za-z0-9_$()+[\],.<> *-]*$/.test(line) ||
    /^[=!+/*%<>&|~^:-]+$/.test(line) ||
    // A Scala name that ends in an operator after an underscore, the setter
    // of a var (`count_=`) or a prefix operator (`unary_!`), alone or in the
    // line:column:name id of a definition.
    /^([0-9]+:[0-9]+:)?[A-Za-z0-9_$]*_[=!+/*%<>&|~^:-]+$/.test(line);
  if (!shaped) {
    found.push("string outside the allowed shapes");
  }
  return found;
}

function walk(value, path, out) {
  if (typeof value === "string") {
    for (const line of value.split("\n")) {
      if (!line) {
        continue;
      }
      for (const why of violations(line)) {
        out.push(`${path}: ${why}: ${JSON.stringify(line)}`);
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, `${path}[${index}]`, out);
    });
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      // The classpath of the recorded reports points at the jars of the
      // caches of the machine that recorded it; the BOM never does.
      if (/^\$\.modules(\[\d+\])?$/.test(path) && key === "classpath") {
        continue;
      }
      walk(item, `${path}.${key}`, out);
    }
  }
}

function assertClean(value, label) {
  const out = [];
  walk(value, "$", out);
  assert.deepStrictEqual(
    out,
    [],
    `${label} carries unshaped or machine specific values:\n${out.join("\n")}`,
  );
}

const reports = join("test", "data", "scalasem");
const recordings = readdirSync(reports)
  .filter((file) => file.endsWith(".json"))
  .filter((file) => file !== "canonical-algorithms.json")
  .map((file) => file.replace(/\.json$/, ""))
  .sort();

/**
 * One library per top-level package outside the project that the report
 * names, holding the owners it references, so the references, calls and call
 * stacks of the report all join onto a component, as a real classpath join
 * does.
 */
function librariesFor(report) {
  const fileEntries = Object.values(report).filter(
    (entry) => entry && typeof entry === "object" && entry.sourceFile,
  );
  const ownRoots = new Set(
    fileEntries.flatMap((entry) =>
      (entry.definitions || []).map((d) => `${d.owner}`.split(".")[0]),
    ),
  );
  const owners = new Map();
  const add = (owner) => {
    if (typeof owner !== "string" || !owner.includes(".")) {
      return;
    }
    const segments = owner.split(".");
    if (ownRoots.has(segments[0])) {
      return;
    }
    const pkg = segments.slice(0, 2).join(".");
    if (!owners.has(pkg)) {
      owners.set(pkg, new Set());
    }
    owners.get(pkg).add(owner);
  };
  for (const entry of fileEntries) {
    for (const call of entry.calls || []) {
      add(call.owner);
    }
    for (const reference of entry.references || []) {
      add(reference.owner);
      add(reference.symbol);
    }
  }
  for (const stack of report.callStacks || []) {
    add(stack.sink?.owner);
  }
  return [...owners.entries()].map(([pkg, names]) => {
    const purl = `pkg:maven/hygiene/${pkg}@1.0.0?type=jar`;
    return {
      type: "library",
      group: "hygiene",
      name: pkg,
      version: "1.0.0",
      purl,
      "bom-ref": purl,
      properties: [
        { name: "internal:Namespaces", value: [...names].sort().join("\n") },
      ],
    };
  });
}

describe("scala evidence hygiene", () => {
  it("catches the values it is here for and passes the shapes a BOM carries", () => {
    assert.deepStrictEqual(violations("https://user:token@host/x").sort(), [
      "URL userinfo",
    ]);
    assert.deepStrictEqual(
      violations("https://host/x?sig=9f8e7d6c#keys").sort(),
      ["URL fragment", "URL query"],
    );
    assert.deepStrictEqual(
      violations("jdbc:mysql://db.internal:3306/db?user=admin&password=secret"),
      ["credential parameter"],
    );
    assert.deepStrictEqual(
      violations("jdbc:oracle:thin:admin/hunter2@db.internal:1521:orcl"),
      ["URL userinfo"],
    );
    assert.deepStrictEqual(violations("/Users/someone/.cache/coursier/x.jar"), [
      "machine path",
    ]);
    assert.deepStrictEqual(
      violations("C:\\Users\\x\\AppData\\Local\\Coursier"),
      ["machine path"],
    );
    assert.deepStrictEqual(violations("%LOCALAPPDATA%\\Coursier"), [
      "machine path",
    ]);
    assert.deepStrictEqual(violations("../outside/file.scala"), [
      "path outside the project",
    ]);
    assert.deepStrictEqual(violations("token|value"), [
      "string outside the allowed shapes",
    ]);
    for (const value of [
      "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.86?repository_url=https:%2F%2Frepo1.maven.org%2Fmaven2&type=jar",
      "pkg:maven/javax.cache/cache-api@1.1.1",
      "https://host/x",
      "jdbc:postgresql://db.internal:5432/reports",
      "kafka:order-events",
      "/accounts/{id}",
      "src/main/scala/corpus/services/DataStores.scala#15",
      "AES/GCM/NoPadding",
      "secg/secp256r1",
      "crypto/algorithm/SHA-256@2.16.840.1.101.3.4.2.1",
      "cdx:scalasem:usageScopes",
      "2026-10-07T12:00:00Z",
      "count_=",
      "unary_!",
    ]) {
      assert.deepStrictEqual(
        violations(value),
        [],
        `"${value}" is a shape the BOM may carry`,
      );
    }
  });

  it("keeps the recorded reports shaped and machine free", () => {
    for (const name of recordings) {
      assertClean(
        JSON.parse(readFileSync(join(reports, `${name}.json`), "utf-8")),
        `the recorded report ${name}`,
      );
    }
  });

  it("keeps the BOM the evidence step builds from each report shaped and machine free", async () => {
    const { analyzeProject, createEvinseFile } = await import(
      "../evinser/evinser.js"
    );
    const work = mkdtempSync(join(tmpdir(), "cdxgen-scala-hygiene-"));
    try {
      for (const name of recordings) {
        const projectDir = join(work, name);
        mkdirSync(projectDir, { recursive: true });
        const report = JSON.parse(
          readFileSync(join(reports, `${name}.json`), "utf-8"),
        );
        // The report names the project it ran on, as a real run's does.
        report._meta.projectPath = projectDir;
        const stub = join(work, `${name}-scalasem-stub.js`);
        writeFileSync(
          stub,
          `require("node:fs").writeFileSync(process.argv[3], ${JSON.stringify(JSON.stringify(report))});\n`,
        );
        const libraries = librariesFor(report);
        const bomFile = join(work, `${name}.bom.json`);
        writeFileSync(
          bomFile,
          JSON.stringify({
            bomFormat: "CycloneDX",
            specVersion: "1.7",
            version: 1,
            metadata: {
              component: {
                type: "application",
                name,
                "bom-ref": `pkg:maven/corpus.scala/${name}@0.1.0?type=jar`,
              },
            },
            components: libraries,
          }),
        );
        const options = {
          _: [projectDir],
          input: bomFile,
          output: join(work, `${name}.evinse.json`),
          language: "scala",
          semanticsSlicesFile: join(work, `${name}.slices.json`),
          scalasemCommand: stub,
          withReachables: true,
          jsonPretty: false,
        };
        const artefacts = await analyzeProject(undefined, options);
        const bomJson = await createEvinseFile(artefacts, options);
        // The walk only proves something over evidence that is there.
        assert.ok(
          bomJson.components.some((c) => c.evidence?.occurrences?.length),
          `${name} BOM has no occurrences`,
        );
        // The libraries made up here are JVM artifacts, which the join does
        // not attach to the call stacks of a Scala.js or Native module.
        const jvmOnly = (report.modules || []).every(
          (module) => module.platform === "jvm",
        );
        if (jvmOnly && (report.callStacks || []).length) {
          assert.ok(
            bomJson.components.some((c) => c.evidence?.callstack?.frames),
            `${name} BOM has no call stacks`,
          );
        }
        if ((report.crypto || []).length) {
          assert.ok(
            bomJson.components.some((c) => c.type === "cryptographic-asset"),
            `${name} BOM has no crypto assets`,
          );
        }
        if ((report.services || []).length) {
          assert.ok(bomJson.services?.length, `${name} BOM has no services`);
        }
        assertClean(bomJson, `the BOM built from ${name}`);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
