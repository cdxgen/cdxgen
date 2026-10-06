import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, it } from "poku";

import {
  parseBazelActionGraph,
  parseBazelBuild,
  parseBazelSkyframe,
  parseCljDep,
  parseEdnData,
  parseKVDep,
  parseLeinDep,
  parseLeiningenData,
  parseMavenTree,
  parseMavenTreeJson,
  parseMillDependency,
  parsePom,
} from "./utils.js";

it("parse maven tree", () => {
  assert.deepStrictEqual(parseMavenTree(null), {});
  let parsedList = parseMavenTree(
    readFileSync("./test/data/sample-mvn-tree.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 61);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 61);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    "bom-ref": "pkg:maven/com.pogeyan.cmis/copper-server@1.15.2?type=war",
    group: "com.pogeyan.cmis",
    name: "copper-server",
    version: "1.15.2",
    qualifiers: { type: "war" },
    properties: [],
    purl: "pkg:maven/com.pogeyan.cmis/copper-server@1.15.2?type=war",
    scope: undefined,
  });
  assert.deepStrictEqual(parsedList.dependenciesList[0], {
    ref: "pkg:maven/com.pogeyan.cmis/copper-server@1.15.2?type=war",
    dependsOn: [
      "pkg:maven/com.fasterxml.jackson.core/jackson-core@2.12.0?type=jar",
      "pkg:maven/com.fasterxml.jackson.core/jackson-databind@2.12.0?type=jar",
      "pkg:maven/com.github.davidb/metrics-influxdb@0.9.3?type=jar",
      "pkg:maven/com.pogeyan.cmis/copper-server-api@1.15.2?type=jar",
      "pkg:maven/com.pogeyan.cmis/copper-server-impl@1.15.2?type=jar",
      "pkg:maven/com.pogeyan.cmis/copper-server-ldap@1.15.2?type=jar",
      "pkg:maven/com.pogeyan.cmis/copper-server-mongo@1.15.2?type=jar",
      "pkg:maven/com.pogeyan.cmis/copper-server-repo@1.15.2?type=jar",
      "pkg:maven/com.typesafe.akka/akka-actor_2.11@2.4.14?type=jar",
      "pkg:maven/com.typesafe.akka/akka-cluster_2.11@2.4.14?type=jar",
      "pkg:maven/commons-fileupload/commons-fileupload@1.4?type=jar",
      "pkg:maven/commons-io/commons-io@2.6?type=jar",
      "pkg:maven/io.dropwizard.metrics/metrics-core@3.1.2?type=jar",
      "pkg:maven/javax/javaee-web-api@7.0?type=jar",
      "pkg:maven/junit/junit@4.12?type=jar",
      "pkg:maven/org.apache.chemistry.opencmis/chemistry-opencmis-server-support@1.0.0?type=jar",
      "pkg:maven/org.apache.commons/commons-lang3@3.4?type=jar",
      "pkg:maven/org.codehaus.jackson/jackson-mapper-asl@1.9.13?type=jar",
      "pkg:maven/org.slf4j/slf4j-log4j12@1.7.21?type=jar",
    ],
  });
  parsedList = parseMavenTree(
    readFileSync("./test/data/mvn-dep-tree-simple.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 39);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 39);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    "bom-ref":
      "pkg:maven/com.gitlab.security_products.tests/java-maven@1.0-SNAPSHOT?type=jar",
    purl: "pkg:maven/com.gitlab.security_products.tests/java-maven@1.0-SNAPSHOT?type=jar",
    group: "com.gitlab.security_products.tests",
    name: "java-maven",
    version: "1.0-SNAPSHOT",
    qualifiers: { type: "jar" },
    properties: [],
    scope: undefined,
  });
  assert.deepStrictEqual(parsedList.dependenciesList[0], {
    ref: "pkg:maven/com.gitlab.security_products.tests/java-maven@1.0-SNAPSHOT?type=jar",
    dependsOn: [
      "pkg:maven/com.fasterxml.jackson.core/jackson-databind@2.9.2?type=jar",
      "pkg:maven/com.github.jnr/jffi@1.3.11?classifier=native&type=jar",
      "pkg:maven/com.github.jnr/jffi@1.3.11?type=jar",
      "pkg:maven/io.netty/netty@3.9.1.Final?type=jar",
      "pkg:maven/junit/junit@3.8.1?type=jar",
      "pkg:maven/org.apache.geode/geode-core@1.1.1?type=jar",
      "pkg:maven/org.apache.maven/maven-artifact@3.3.9?type=jar",
      "pkg:maven/org.mozilla/rhino@1.7.10?type=jar",
      "pkg:maven/org.powermock/powermock-api-mockito@1.7.3?type=jar",
    ],
  });
  parsedList = parseMavenTree(
    readFileSync("./test/data/mvn-p2-plugin.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 79);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    "bom-ref":
      "pkg:maven/example.group/eclipse-repository@1.0.0-SNAPSHOT?type=eclipse-repository",
    purl: "pkg:maven/example.group/eclipse-repository@1.0.0-SNAPSHOT?type=eclipse-repository",
    group: "example.group",
    name: "eclipse-repository",
    version: "1.0.0-SNAPSHOT",
    qualifiers: { type: "eclipse-repository" },
    scope: undefined,
    properties: [],
  });
  assert.deepStrictEqual(parsedList.pkgList[4], {
    "bom-ref":
      "pkg:maven/p2.eclipse.plugin/com.ibm.icu@67.1.0.v20200706-1749?type=eclipse-plugin",
    purl: "pkg:maven/p2.eclipse.plugin/com.ibm.icu@67.1.0.v20200706-1749?type=eclipse-plugin",
    group: "p2.eclipse.plugin",
    name: "com.ibm.icu",
    version: "67.1.0.v20200706-1749",
    qualifiers: { type: "eclipse-plugin" },
    scope: "excluded",
    properties: [],
  });
  assert.deepStrictEqual(parsedList.dependenciesList.length, 79);
  assert.deepStrictEqual(parsedList.dependenciesList[0], {
    ref: "pkg:maven/example.group/eclipse-repository@1.0.0-SNAPSHOT?type=eclipse-repository",
    dependsOn: [
      "pkg:maven/example.group/example-bundle@0.1.0-SNAPSHOT?type=eclipse-plugin",
      "pkg:maven/example.group/example-feature-2@0.2.0-SNAPSHOT?type=eclipse-feature",
      "pkg:maven/example.group/example-feature@0.1.0-SNAPSHOT?type=eclipse-feature",
      "pkg:maven/example.group/org.tycho.demo.rootfiles.win@1.0.0-SNAPSHOT?type=p2-installable-unit",
      "pkg:maven/example.group/org.tycho.demo.rootfiles@1.0.0?type=p2-installable-unit",
    ],
  });
  parsedList = parseMavenTree(
    readFileSync("./test/data/mvn-metrics-tree.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 58);
  assert.deepStrictEqual(
    parsedList.parentComponent["bom-ref"],
    "pkg:maven/org.apache.dubbo/dubbo-metrics@3.3.0?type=pom",
  );
  assert.deepStrictEqual(parsedList.dependenciesList.length, 58);
  assert.deepStrictEqual(parsedList.dependenciesList[0], {
    ref: "pkg:maven/org.apache.dubbo/dubbo-metrics@3.3.0?type=pom",
    dependsOn: [
      "pkg:maven/org.apache.dubbo/dubbo-test-check@3.3.0?type=jar",
      "pkg:maven/org.awaitility/awaitility@4.2.0?type=jar",
      "pkg:maven/org.hamcrest/hamcrest@2.2?type=jar",
      "pkg:maven/org.junit.jupiter/junit-jupiter-engine@5.9.3?type=jar",
      "pkg:maven/org.junit.jupiter/junit-jupiter-params@5.9.3?type=jar",
      "pkg:maven/org.mockito/mockito-core@4.11.0?type=jar",
      "pkg:maven/org.mockito/mockito-inline@4.11.0?type=jar",
    ],
  });
  parsedList = parseMavenTree(
    readFileSync("./test/data/mvn-sbstarter-tree.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 102);
  assert.deepStrictEqual(
    parsedList.parentComponent["bom-ref"],
    "pkg:maven/org.apache.dubbo/dubbo-spring-boot-starter@3.3.0?type=jar",
  );
  assert.deepStrictEqual(parsedList.dependenciesList.length, 102);
  assert.deepStrictEqual(parsedList.dependenciesList[0], {
    ref: "pkg:maven/org.apache.dubbo/dubbo-spring-boot-starter@3.3.0?type=jar",
    dependsOn: [
      "pkg:maven/net.bytebuddy/byte-buddy-agent@1.15.0?type=jar",
      "pkg:maven/net.bytebuddy/byte-buddy@1.15.0?type=jar",
      "pkg:maven/org.apache.dubbo/dubbo-spring-boot-autoconfigure@3.3.0?type=jar",
      "pkg:maven/org.apache.dubbo/dubbo-test-check@3.3.0?type=jar",
      "pkg:maven/org.apache.logging.log4j/log4j-slf4j-impl@2.17.2?type=jar",
      "pkg:maven/org.awaitility/awaitility@4.2.0?type=jar",
      "pkg:maven/org.hamcrest/hamcrest@2.2?type=jar",
      "pkg:maven/org.junit.jupiter/junit-jupiter-engine@5.8.2?type=jar",
      "pkg:maven/org.junit.jupiter/junit-jupiter-params@5.8.2?type=jar",
      "pkg:maven/org.junit.vintage/junit-vintage-engine@5.8.2?type=jar",
      "pkg:maven/org.mockito/mockito-core@4.11.0?type=jar",
      "pkg:maven/org.mockito/mockito-inline@4.11.0?type=jar",
      "pkg:maven/org.springframework.boot/spring-boot-starter@2.7.18?type=jar",
    ],
  });
});

it("parse maven tree optional and repeated dependency edges", () => {
  const parsedOptional = parseMavenTree(`example:optional-sample:jar:1.0.0
\\- org.apache.maven:maven-artifact:jar:3.9.9:compile (optional)
   \\- org.codehaus.plexus:plexus-utils:jar:3.5.1:compile (optional)
`);
  assert.strictEqual(parsedOptional.pkgList.length, 3);
  assert.strictEqual(parsedOptional.pkgList[1].scope, "optional");
  assert.deepStrictEqual(parsedOptional.pkgList[1].properties, []);
  assert.deepStrictEqual(parsedOptional.dependenciesList[0], {
    ref: "pkg:maven/example/optional-sample@1.0.0?type=jar",
    dependsOn: ["pkg:maven/org.apache.maven/maven-artifact@3.9.9?type=jar"],
  });
  const parsedDuplicate = parseMavenTree(`example:dup-root:jar:1.0.0
+- g:a:jar:1:compile
|  \\- g:c:jar:1:compile
\\- g:b:jar:1:compile
   \\- g:c:jar:1:compile
`);
  const bDependency = parsedDuplicate.dependenciesList.find(
    (dep) => dep.ref === "pkg:maven/g/b@1?type=jar",
  );
  assert.deepStrictEqual(bDependency.dependsOn, ["pkg:maven/g/c@1?type=jar"]);
});

it("parse maven tree json", () => {
  const parsedList = parseMavenTreeJson(
    JSON.stringify({
      groupId: "example",
      artifactId: "json-root",
      version: "1.0.0",
      type: "jar",
      scope: "",
      classifier: "",
      optional: "false",
      children: [
        {
          groupId: "org.apache.maven",
          artifactId: "maven-artifact",
          version: "3.9.9",
          type: "jar",
          scope: "compile",
          classifier: "",
          optional: "true",
          children: [
            {
              groupId: "org.codehaus.plexus",
              artifactId: "plexus-utils",
              version: "3.5.1",
              type: "jar",
              scope: "compile",
              classifier: "",
              optional: "true",
            },
          ],
        },
      ],
    }),
  );
  assert.strictEqual(parsedList.pkgList.length, 3);
  assert.strictEqual(parsedList.pkgList[1].scope, "optional");
  assert.deepStrictEqual(parsedList.dependenciesList[0], {
    ref: "pkg:maven/example/json-root@1.0.0?type=jar",
    dependsOn: ["pkg:maven/org.apache.maven/maven-artifact@3.9.9?type=jar"],
  });
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:maven/org.apache.maven/maven-artifact@3.9.9?type=jar",
    dependsOn: ["pkg:maven/org.codehaus.plexus/plexus-utils@3.5.1?type=jar"],
  });
  assert.deepStrictEqual(parseMavenTreeJson("{not-json"), {});
  assert.deepStrictEqual(parseMavenTree("{not-json"), {});
});

it("parse clojure data", () => {
  assert.deepStrictEqual(parseLeiningenData(null), []);
  let dep_list = parseLeiningenData(
    readFileSync("./test/data/project.clj", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 14);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "leiningen-core",
    version: "2.9.9-SNAPSHOT",
  });
  dep_list = parseLeiningenData(
    readFileSync("./test/data/project.clj.1", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 17);
  assert.deepStrictEqual(dep_list[0], {
    group: "org.clojure",
    name: "clojure",
    version: "1.9.0",
  });
  dep_list = parseLeiningenData(
    readFileSync("./test/data/project.clj.2", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 49);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "bidi",
    version: "2.1.6",
  });
  dep_list = parseEdnData(
    readFileSync("./test/data/deps.edn", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 20);
  assert.deepStrictEqual(dep_list[0], {
    group: "org.clojure",
    name: "clojure",
    version: "1.10.3",
  });
  dep_list = parseEdnData(
    readFileSync("./test/data/deps.edn.1", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 11);
  assert.deepStrictEqual(dep_list[0], {
    group: "org.clojure",
    name: "clojure",
    version: "1.11.0-beta1",
  });
  dep_list = parseEdnData(
    readFileSync("./test/data/deps.edn.2", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 5);
  assert.deepStrictEqual(dep_list[0], {
    group: "clj-commons",
    name: "pomegranate",
    version: "1.2.1",
  });
  dep_list = parseCljDep(
    readFileSync("./test/data/clj-tree.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 253);
  assert.deepStrictEqual(dep_list[0], {
    group: "org.bouncycastle",
    name: "bcprov-jdk15on",
    version: "1.70",
  });

  dep_list = parseLeinDep(
    readFileSync("./test/data/lein-tree.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 47);
  assert.deepStrictEqual(dep_list[0], {
    group: "javax.xml.bind",
    name: "jaxb-api",
    version: "2.4.0-b180830.0359",
  });
});

it("parsePomFile", () => {
  let data = parsePom("./test/data/pom-quarkus.xml");
  assert.deepStrictEqual(data.dependencies.length, 46);
  assert.deepStrictEqual(data.modules, undefined);
  assert.ok(data.properties);
  assert.ok(data.isQuarkus);
  data = parsePom("./test/data/pom-quarkus-modules.xml");
  assert.deepStrictEqual(data.dependencies.length, 0);
  assert.deepStrictEqual(data.modules.length, 105);
  assert.ok(data.properties);
  assert.deepStrictEqual(data.isQuarkus, false);
  data = parsePom("./test/pom.xml");
  assert.deepStrictEqual(data.dependencies.length, 13);
  assert.deepStrictEqual(data.isQuarkus, false);
});

it("parsePomFile maven 4 model", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-maven4-pom-"));
  const pomFile = path.join(tempDir, "pom.xml");
  writeFileSync(
    pomFile,
    `<project xmlns="http://maven.apache.org/POM/4.1.0" root="true" preserve.model.version="true">
  <modelVersion>4.1.0</modelVersion>
  <groupId>example</groupId>
  <artifactId>maven4-root</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <subprojects><subproject>app</subproject></subprojects>
  <dependencies>
    <dependency>
      <groupId>org.example</groupId>
      <artifactId>demo</artifactId>
      <version>1.2.3</version>
      <type>test-jar</type>
      <classifier>tests</classifier>
      <optional>true</optional>
    </dependency>
  </dependencies>
</project>`,
  );
  const data = parsePom(pomFile);
  assert.deepStrictEqual(data.modules, ["app"]);
  assert.strictEqual(data.properties.modelVersion, "4.1.0");
  assert.strictEqual(data.properties.mavenRoot, "true");
  assert.strictEqual(data.properties.preserveModelVersion, "true");
  assert.strictEqual(data.dependencies[0].qualifiers.type, "test-jar");
  assert.strictEqual(data.dependencies[0].qualifiers.classifier, "tests");
  assert.strictEqual(data.dependencies[0].scope, "optional");
  rmSync(tempDir, { recursive: true, force: true });
});

it("parse scala sbt list", () => {
  let deps = parseKVDep(
    readFileSync("./test/data/sbt-dl.list", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(deps.length, 57);
  deps = parseKVDep(
    readFileSync("./test/data/atom-sbt-list.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(deps.length, 153);
});

it("parse bazel skyframe", () => {
  const deps = parseBazelSkyframe(
    readFileSync("./test/data/bazel/bazel-state.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(deps.length, 16);
  assert.deepStrictEqual(deps[0].name, "guava");
});

it("parse bazel action graph", () => {
  const deps = parseBazelActionGraph(
    readFileSync("./test/data/bazel/bazel-action-graph.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].group, "org.scala-lang");
  assert.deepStrictEqual(deps[0].name, "scala-library");
  assert.deepStrictEqual(deps[0].version, "2.13.16");
  assert.deepStrictEqual(deps[1].group, "org.jline");
  assert.deepStrictEqual(deps[1].name, "jline");
  assert.deepStrictEqual(deps[1].version, "3.26.3");
});

it("parse bazel build", () => {
  const projs = parseBazelBuild(
    readFileSync("./test/data/bazel/BUILD", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(projs.length, 2);
  assert.deepStrictEqual(projs[0], "java-maven-lib");
});

it("parseMillDependency test", () => {
  const millTestDataRoot = "./test/data/mill/";
  const dependencies = new Map();
  const relations = new Map();

  assert.deepStrictEqual(dependencies.has("application:bar:latest"), false);
  assert.deepStrictEqual(
    dependencies.has("application:bar.test:latest"),
    false,
  );
  assert.deepStrictEqual(dependencies.has("application:foo:latest"), false);
  assert.deepStrictEqual(
    dependencies.has("application:foo.test:latest"),
    false,
  );
  assert.deepStrictEqual(dependencies.size, 0);
  assert.deepStrictEqual(relations.size, 0);

  parseMillDependency("bar", dependencies, relations, millTestDataRoot);
  // cdx-purl requires a namespace (groupId) for maven purls, so a Mill module
  // without a group gets no purl and a `type:name:version` bom-ref. The bare
  // name is not usable as a ref: it collides across versions.
  assert.deepStrictEqual(dependencies.has("application:bar:latest"), true);
  assert.deepStrictEqual(
    dependencies.has("application:bar.test:latest"),
    false,
  );
  assert.deepStrictEqual(dependencies.has("application:foo:latest"), false);
  assert.deepStrictEqual(
    dependencies.has("application:foo.test:latest"),
    false,
  );
  assert.deepStrictEqual(dependencies.size, 8);
  assert.deepStrictEqual(relations.size, 8);

  parseMillDependency("bar.test", dependencies, relations, millTestDataRoot);
  assert.deepStrictEqual(dependencies.has("application:bar:latest"), true);
  assert.deepStrictEqual(dependencies.has("application:bar.test:latest"), true);
  assert.deepStrictEqual(dependencies.has("application:foo:latest"), false);
  assert.deepStrictEqual(
    dependencies.has("application:foo.test:latest"),
    false,
  );
  assert.deepStrictEqual(dependencies.size, 13);
  assert.deepStrictEqual(relations.size, 13);

  parseMillDependency("foo", dependencies, relations, millTestDataRoot);
  assert.deepStrictEqual(dependencies.has("application:bar:latest"), true);
  assert.deepStrictEqual(dependencies.has("application:bar.test:latest"), true);
  assert.deepStrictEqual(dependencies.has("application:foo:latest"), true);
  assert.deepStrictEqual(
    dependencies.has("application:foo.test:latest"),
    false,
  );
  assert.deepStrictEqual(dependencies.size, 14);
  assert.deepStrictEqual(relations.size, 14);

  parseMillDependency("foo.test", dependencies, relations, millTestDataRoot);
  assert.deepStrictEqual(dependencies.has("application:bar:latest"), true);
  assert.deepStrictEqual(dependencies.has("application:bar.test:latest"), true);
  assert.deepStrictEqual(dependencies.has("application:foo:latest"), true);
  assert.deepStrictEqual(dependencies.has("application:foo.test:latest"), true);
  assert.deepStrictEqual(dependencies.size, 15);
  assert.deepStrictEqual(relations.size, 15);
});

it("parseMillDependency emits scala artifacts in the sbt purl form", async () => {
  const { copyFileSync, mkdirSync } = await import("node:fs");
  const millRoot = mkdtempSync(path.join(tmpdir(), "cdxgen-mill1-"));
  try {
    mkdirSync(path.join(millRoot, "out", "app"), { recursive: true });
    copyFileSync(
      "./test/data/mill-1-showMvnDepsTree.log",
      path.join(millRoot, "out", "app", "showMvnDepsTree.log"),
    );
    const dependencies = new Map();
    const relations = new Map();
    parseMillDependency(
      "app",
      dependencies,
      relations,
      millRoot,
      "showMvnDepsTree.log",
    );
    const cask = [...dependencies.values()].find((c) => c.name === "cask");
    assert.ok(cask, "cask component missing");
    assert.strictEqual(cask.purl, "pkg:maven/com.lihaoyi/cask@0.11.3?type=jar");
    assert.strictEqual(
      cask.properties.find((p) => p.name === "cdx:scala:compilerVersion")
        ?.value,
      "3",
    );
    // The Scala.js artifact keeps its platform suffix and never joins cask
    const caskUtil = [...dependencies.values()].find(
      (c) => c.name === "cask-util",
    );
    assert.ok(caskUtil);
    assert.strictEqual(
      caskUtil.purl,
      "pkg:maven/com.lihaoyi/cask-util@0.11.3?type=jar",
    );
    // A Java artifact without a Scala suffix is unchanged
    const slf4j = [...dependencies.values()].find(
      (c) => c.group === "org.slf4j",
    );
    assert.ok(slf4j);
    assert.strictEqual(slf4j.properties, undefined);
  } finally {
    rmSync(millRoot, { recursive: true, force: true });
  }
});
