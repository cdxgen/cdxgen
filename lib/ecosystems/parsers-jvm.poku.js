// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Maven pom properties are written as ${name}
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "poku";

// Not re-exported through the deprecated ./utils.js barrel
import { parsePomWithLocalParents } from "./parsers-jvm.js";
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
  // The marker is only a suffix: trailing blanks after it are fine, but a
  // classifier that merely ends with the word is not optional.
  const parsedMarkerEdges = parseMavenTree(`example:marker-sample:jar:1.0.0
+- g:a:jar:1:compile (optional)   \r
\\- g:b:jar:(optional):1:compile
`);
  assert.strictEqual(parsedMarkerEdges.pkgList[1].scope, "optional");
  assert.strictEqual(parsedMarkerEdges.pkgList[1].version, "1");
  assert.strictEqual(parsedMarkerEdges.pkgList[2].scope, "required");
  assert.strictEqual(
    parsedMarkerEdges.pkgList[2].qualifiers.classifier,
    "(optional)",
  );
  // A long run of blanks inside a coordinate (a classifier from a dependency's
  // pom) must parse in linear time, not be retried from every blank.
  const started = performance.now();
  const parsedBlankRun = parseMavenTree(
    `example:blank-run:jar:1.0.0\n\\- g:c:jar:a${" ".repeat(50000)}z:1.0:compile\n`,
  );
  assert.ok(performance.now() - started < 1000);
  assert.strictEqual(parsedBlankRun.pkgList.length, 2);
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

// ---------------------------------------------------------------------------
// Reading poms without Maven (issue #4527): property expansion, the pom's own
// dependencyManagement, and parent poms inside the scanned directory.
// ---------------------------------------------------------------------------

/**
 * Write a pom file, creating its directory.
 *
 * @param {string} dir Directory of the pom
 * @param {string} body XML inside <project>
 * @returns {string} Path of the pom
 */
function writePom(dir, body) {
  mkdirSync(dir, { recursive: true });
  const pomFile = path.join(dir, "pom.xml");
  writeFileSync(
    pomFile,
    `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
${body}
</project>`,
  );
  return pomFile;
}

/** XML for one dependency; a missing version leaves the element out. */
function depXml(groupId, artifactId, version, extra = "") {
  return `<dependency><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId>${
    version === undefined ? "" : `<version>${version}</version>`
  }${extra}</dependency>`;
}

/** Version of the dependency named `name`, failing when it is absent. */
function versionOf(pomData, name) {
  const dep = pomData.dependencies.find((d) => d.name === name);
  assert.ok(dep, `dependency ${name} is missing`);
  return dep.version;
}

describe("parsePom property and dependencyManagement resolution", () => {
  it("resolves ${revision} in the project version and uses it in pomPurl", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-revision-"));
    try {
      const pomFile = writePom(
        tempDir,
        `<groupId>org.example</groupId>
  <artifactId>app</artifactId>
  <version>\${revision}</version>
  <properties><revision>2.3.4</revision></properties>`,
      );
      const data = parsePom(pomFile);
      assert.strictEqual(data.properties.version, "2.3.4");
      assert.strictEqual(
        data.pomPurl,
        "pkg:maven/org.example/app@2.3.4?type=jar",
      );
      assert.strictEqual(data.parent, undefined);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves ${project.version}, ${project.groupId} and chained properties in dependencies", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-props-"));
    try {
      const pomFile = writePom(
        tempDir,
        `<groupId>org.example</groupId>
  <artifactId>app</artifactId>
  <version>\${revision}</version>
  <packaging>war</packaging>
  <properties>
    <revision>2.3.4</revision>
    <base.version>1.2</base.version>
    <lib.version>\${base.version}.3</lib.version>
  </properties>
  <dependencies>
    ${depXml("${project.groupId}", "sibling", "${project.version}")}
    ${depXml("com.acme", "chained", "${lib.version}")}
  </dependencies>`,
      );
      const data = parsePom(pomFile);
      assert.strictEqual(
        data.pomPurl,
        "pkg:maven/org.example/app@2.3.4?type=war",
      );
      const sibling = data.dependencies.find((d) => d.name === "sibling");
      assert.strictEqual(sibling.group, "org.example");
      assert.strictEqual(sibling.version, "2.3.4");
      assert.strictEqual(versionOf(data, "chained"), "1.2.3");
      assert.deepStrictEqual(data.userProperties, {
        revision: "2.3.4",
        "base.version": "1.2",
        "lib.version": "${base.version}.3",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("takes versions from the pom's own dependencyManagement and skips imported BOMs", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-managed-"));
    try {
      const pomFile = writePom(
        tempDir,
        `<groupId>org.example</groupId>
  <artifactId>app</artifactId>
  <version>1.0.0</version>
  <properties><managed.version>4.5.6</managed.version></properties>
  <dependencyManagement>
    <dependencies>
      ${depXml("com.acme", "managed", "${managed.version}")}
      ${depXml("com.acme", "acme-bom", "9.9.9", "<type>pom</type><scope>import</scope>")}
    </dependencies>
  </dependencyManagement>
  <dependencies>
    ${depXml("com.acme", "managed")}
    ${depXml("com.acme", "acme-bom")}
    ${depXml("com.acme", "unmanaged")}
    ${depXml("com.acme", "pinned", "7.0.0")}
  </dependencies>`,
      );
      const data = parsePom(pomFile);
      assert.deepStrictEqual(data.managedVersions, {
        "com.acme:managed": "4.5.6",
      });
      assert.strictEqual(versionOf(data, "managed"), "4.5.6");
      // An imported BOM manages versions this pom cannot see, and is not a
      // managed version itself
      assert.strictEqual(versionOf(data, "acme-bom"), undefined);
      assert.strictEqual(versionOf(data, "unmanaged"), undefined);
      assert.strictEqual(versionOf(data, "pinned"), "7.0.0");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves a version undefined when its property is missing or refers to itself", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-unresolved-"));
    try {
      const pomFile = writePom(
        tempDir,
        `<groupId>org.example</groupId>
  <artifactId>app</artifactId>
  <version>1.0.0</version>
  <properties>
    <self.version>\${self.version}</self.version>
    <ping.version>\${pong.version}</ping.version>
    <pong.version>\${ping.version}</pong.version>
    <half.version>1.\${missing.minor}</half.version>
  </properties>
  <dependencies>
    ${depXml("com.acme", "missing", "${missing.version}")}
    ${depXml("com.acme", "self", "${self.version}")}
    ${depXml("com.acme", "cycle", "${ping.version}")}
    ${depXml("com.acme", "half", "${half.version}")}
    ${depXml("com.acme", "unterminated", "${broken")}
  </dependencies>`,
      );
      const data = parsePom(pomFile);
      for (const name of ["missing", "self", "cycle", "half", "unterminated"]) {
        assert.strictEqual(versionOf(data, name), undefined, name);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves a version undefined when a property or managed version is too long", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-long-"));
    try {
      const pomFile = writePom(
        tempDir,
        `<groupId>org.example</groupId>
  <artifactId>app</artifactId>
  <version>1.0.0</version>
  <properties>
    <long.version>${"x".repeat(1025)}</long.version>
    <part.version>${"y".repeat(600)}</part.version>
    <fits.version>${"z".repeat(1000)}</fits.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      ${depXml("com.acme", "managed-long", "w".repeat(1025))}
    </dependencies>
  </dependencyManagement>
  <dependencies>
    ${depXml("com.acme", "long", "${long.version}")}
    ${depXml("com.acme", "amplified", "${part.version}.${part.version}")}
    ${depXml("com.acme", "fits", "1.${fits.version}.2")}
    ${depXml("com.acme", "managed-long", undefined, "<classifier>c1</classifier>")}
    ${depXml("com.acme", "managed-long", undefined, "<classifier>c2</classifier>")}
  </dependencies>`,
      );
      const data = parsePom(pomFile);
      assert.strictEqual(versionOf(data, "long"), undefined);
      assert.strictEqual(versionOf(data, "amplified"), undefined);
      assert.strictEqual(versionOf(data, "fits"), `1.${"z".repeat(1000)}.2`);
      // A managed version is copied into every dependency that omits its own,
      // so a literal one is bounded too
      assert.deepStrictEqual(data.managedVersions, {});
      for (const dep of data.dependencies.filter(
        (d) => d.name === "managed-long",
      )) {
        assert.strictEqual(dep.version, undefined, dep.qualifiers.classifier);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects nested property references before building an oversized value", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-nested-"));
    try {
      const deps = [];
      for (let i = 0; i < 200; i++) {
        deps.push(depXml("g", `d${i}`, "${a}".repeat(10)));
      }
      const pomFile = writePom(
        tempDir,
        `<groupId>g</groupId>
  <artifactId>root</artifactId>
  <version>1</version>
  <properties>
    <b>${"x".repeat(200000)}</b>
    <a>${"${b}".repeat(10)}</a>
  </properties>
  <dependencies>${deps.join("")}</dependencies>`,
      );
      const started = performance.now();
      const data = parsePom(pomFile);
      assert.ok(performance.now() - started < 1000);
      assert.strictEqual(data.dependencies.length, 200);
      for (const dep of data.dependencies) {
        assert.strictEqual(dep.version, undefined, dep.name);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns the parent reference with Maven's relativePath default", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-parent-"));
    try {
      const parentXml = (relativePath) =>
        `<parent><groupId>org.example</groupId><artifactId>parent</artifactId><version>3.0.0</version>${relativePath}</parent>
  <artifactId>child</artifactId>`;
      let data = parsePom(writePom(path.join(tempDir, "a"), parentXml("")));
      assert.deepStrictEqual(data.parent, {
        groupId: "org.example",
        artifactId: "parent",
        version: "3.0.0",
        relativePath: "../pom.xml",
      });
      // The coordinates the child leaves out come from the parent
      assert.strictEqual(data.properties.groupId, "org.example");
      assert.strictEqual(data.properties.version, "3.0.0");
      data = parsePom(
        writePom(path.join(tempDir, "b"), parentXml("<relativePath/>")),
      );
      assert.strictEqual(data.parent.relativePath, "");
      data = parsePom(
        writePom(
          path.join(tempDir, "c"),
          parentXml("<relativePath>../../build/pom.xml</relativePath>"),
        ),
      );
      assert.strictEqual(data.parent.relativePath, "../../build/pom.xml");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("parsePomWithLocalParents", () => {
  /**
   * A grandparent at the root, a parent below it and a child below that,
   * each passing on properties and managed versions.
   */
  function writeParentChain(root) {
    writePom(
      root,
      `<groupId>org.example</groupId>
  <artifactId>grandparent</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules><module>parent</module></modules>
  <properties>
    <guava.version>33.0.0-jre</guava.version>
    <slf4j.version>2.0.13</slf4j.version>
  </properties>
  <dependencyManagement><dependencies>
    ${depXml("com.google.guava", "guava", "${guava.version}")}
  </dependencies></dependencyManagement>`,
    );
    writePom(
      path.join(root, "parent"),
      `<parent><groupId>org.example</groupId><artifactId>grandparent</artifactId><version>1.0.0</version></parent>
  <artifactId>parent</artifactId>
  <packaging>pom</packaging>
  <modules><module>child</module></modules>
  <properties><jackson.version>2.17.0</jackson.version></properties>
  <dependencyManagement><dependencies>
    ${depXml("com.fasterxml.jackson.core", "jackson-databind", "${jackson.version}")}
  </dependencies></dependencyManagement>`,
    );
    return writePom(
      path.join(root, "parent", "child"),
      `<parent><groupId>org.example</groupId><artifactId>parent</artifactId><version>1.0.0</version></parent>
  <artifactId>child</artifactId>
  <dependencies>
    ${depXml("com.google.guava", "guava")}
    ${depXml("com.fasterxml.jackson.core", "jackson-databind")}
    ${depXml("org.slf4j", "slf4j-api", "${slf4j.version}")}
  </dependencies>`,
    );
  }

  it("inherits properties and managed versions from a local parent and grandparent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-chain-"));
    try {
      const childPom = writeParentChain(root);
      // Without the parents nothing resolves
      const alone = parsePom(childPom);
      assert.strictEqual(versionOf(alone, "guava"), undefined);
      assert.strictEqual(versionOf(alone, "jackson-databind"), undefined);
      assert.strictEqual(versionOf(alone, "slf4j-api"), undefined);
      const cache = new Map();
      const data = parsePomWithLocalParents(childPom, root, cache);
      assert.strictEqual(versionOf(data, "guava"), "33.0.0-jre");
      assert.strictEqual(versionOf(data, "jackson-databind"), "2.17.0");
      assert.strictEqual(versionOf(data, "slf4j-api"), "2.0.13");
      assert.strictEqual(data.properties.version, "1.0.0");
      assert.strictEqual(
        data.pomPurl,
        "pkg:maven/org.example/child@1.0.0?type=jar",
      );
      // The parents were read once and kept for the other poms of the scan
      assert.ok(cache.size >= 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a parent whose artifactId does not match the reference", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-mismatch-"));
    try {
      writePom(
        root,
        `<groupId>org.example</groupId>
  <artifactId>actual-parent</artifactId>
  <version>1.0.0</version>
  <properties><lib.version>5.0.0</lib.version></properties>`,
      );
      const childPom = writePom(
        path.join(root, "child"),
        `<parent><groupId>org.example</groupId><artifactId>named-parent</artifactId><version>1.0.0</version></parent>
  <artifactId>child</artifactId>
  <dependencies>${depXml("com.acme", "lib", "${lib.version}")}</dependencies>`,
      );
      const data = parsePomWithLocalParents(childPom, root);
      assert.strictEqual(versionOf(data, "lib"), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a parent named by many modules once per scan", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-shared-"));
    try {
      const parentXml = (artifactId) => `<groupId>org.example</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>1.0.0</version>
  <properties><lib.version>5.0.0</lib.version></properties>`;
      const moduleNaming = (dir, parentArtifactId) =>
        writePom(
          path.join(root, dir),
          `<parent><groupId>org.example</groupId><artifactId>${parentArtifactId}</artifactId><version>1.0.0</version></parent>
  <artifactId>${dir}</artifactId>
  <dependencies>${depXml("com.acme", "lib", "${lib.version}")}</dependencies>`,
        );
      writePom(root, parentXml("shared-parent"));
      const first = moduleNaming("first", "shared-parent");
      const other = moduleNaming("other", "other-parent");
      const second = moduleNaming("second", "shared-parent");
      const cache = new Map();
      assert.strictEqual(
        versionOf(parsePomWithLocalParents(first, root, cache), "lib"),
        "5.0.0",
      );
      // The cached coordinates still reject a module naming another parent
      assert.strictEqual(
        versionOf(parsePomWithLocalParents(other, root, cache), "lib"),
        undefined,
      );
      // Changing the parent on disk is not noticed within the scan: the
      // second module resolves from what the first read, not from a re-parse
      writePom(root, parentXml("renamed-parent"));
      assert.strictEqual(
        versionOf(parsePomWithLocalParents(second, root, cache), "lib"),
        "5.0.0",
      );
      // A fresh scan reads the file as it is now
      assert.strictEqual(
        versionOf(parsePomWithLocalParents(second, root), "lib"),
        undefined,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a parent outside the scanned directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-outside-"));
    try {
      writePom(
        path.join(root, "outside"),
        `<groupId>org.example</groupId>
  <artifactId>outside-parent</artifactId>
  <version>1.0.0</version>
  <properties><lib.version>5.0.0</lib.version></properties>`,
      );
      const scanned = path.join(root, "scanned");
      const childPom = writePom(
        scanned,
        `<parent><groupId>org.example</groupId><artifactId>outside-parent</artifactId><version>1.0.0</version><relativePath>../outside/pom.xml</relativePath></parent>
  <artifactId>child</artifactId>
  <dependencies>${depXml("com.acme", "lib", "${lib.version}")}</dependencies>`,
      );
      const data = parsePomWithLocalParents(childPom, scanned);
      assert.strictEqual(versionOf(data, "lib"), undefined);
      // Positive control: the same parent is read once it is inside the root
      const widened = parsePomWithLocalParents(childPom, root);
      assert.strictEqual(versionOf(widened, "lib"), "5.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a parent reference with an empty relativePath", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-emptyrel-"));
    try {
      writePom(
        root,
        `<groupId>org.example</groupId>
  <artifactId>root-parent</artifactId>
  <version>1.0.0</version>
  <properties><lib.version>5.0.0</lib.version></properties>`,
      );
      const parentRef = (relativePath) =>
        `<parent><groupId>org.example</groupId><artifactId>root-parent</artifactId><version>1.0.0</version>${relativePath}</parent>
  <artifactId>child</artifactId>
  <dependencies>${depXml("com.acme", "lib", "${lib.version}")}</dependencies>`;
      const emptyRel = writePom(
        path.join(root, "empty"),
        parentRef("<relativePath/>"),
      );
      assert.strictEqual(
        versionOf(parsePomWithLocalParents(emptyRel, root), "lib"),
        undefined,
      );
      // Positive control: Maven's default ../pom.xml finds the same parent
      const defaultRel = writePom(path.join(root, "default"), parentRef(""));
      assert.strictEqual(
        versionOf(parsePomWithLocalParents(defaultRel, root), "lib"),
        "5.0.0",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminates on a parent cycle", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cdxgen-pom-cycle-"));
    try {
      const aPom = writePom(
        path.join(root, "a"),
        `<parent><groupId>org.example</groupId><artifactId>b</artifactId><version>1.0.0</version><relativePath>../b/pom.xml</relativePath></parent>
  <groupId>org.example</groupId>
  <artifactId>a</artifactId>
  <version>1.0.0</version>
  <properties><a.version>1.1.1</a.version></properties>
  <dependencies>
    ${depXml("com.acme", "from-b", "${b.version}")}
    ${depXml("com.acme", "from-a", "${a.version}")}
  </dependencies>`,
      );
      writePom(
        path.join(root, "b"),
        `<parent><groupId>org.example</groupId><artifactId>a</artifactId><version>1.0.0</version><relativePath>../a/pom.xml</relativePath></parent>
  <groupId>org.example</groupId>
  <artifactId>b</artifactId>
  <version>1.0.0</version>
  <properties><b.version>2.2.2</b.version></properties>`,
      );
      const data = parsePomWithLocalParents(aPom, root);
      assert.strictEqual(data.properties.artifactId, "a");
      assert.strictEqual(versionOf(data, "from-a"), "1.1.1");
      assert.strictEqual(versionOf(data, "from-b"), "2.2.2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
