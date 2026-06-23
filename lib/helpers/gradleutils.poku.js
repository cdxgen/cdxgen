import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, it } from "poku";

import {
  buildObjectForGradleModule,
  extractGradleRepositoryUrls,
  parseGradleDep,
  parseGradleInfoLogsForUrls,
  parseGradleProjects,
  parseGradleProperties,
  parseGradleResolvedDistributions,
  splitOutputByGradleProjects,
} from "./gradleutils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

function getTestFilePath(relativePath) {
  const cleanPath = relativePath.startsWith("./")
    ? relativePath.substring(2)
    : relativePath;
  return path.resolve(repoRoot, cleanPath);
}

it("splits parallel gradle properties output correctly", () => {
  const parallelGradlePropertiesOutput = readFileSync(
    getTestFilePath("./test/gradle-prop-parallel.out"),
    { encoding: "utf-8" },
  );
  const relevantTasks = ["properties"];
  const propOutputSplitBySubProject = splitOutputByGradleProjects(
    parallelGradlePropertiesOutput,
    relevantTasks,
  );

  assert.deepStrictEqual(propOutputSplitBySubProject.size, 4);
  assert.deepStrictEqual(
    propOutputSplitBySubProject.has("dependency-diff-check"),
    true,
  );
  assert.deepStrictEqual(
    propOutputSplitBySubProject.has(":dependency-diff-check-service"),
    true,
  );
  assert.deepStrictEqual(
    propOutputSplitBySubProject.has(":dependency-diff-check-common-core"),
    true,
  );
  assert.deepStrictEqual(
    propOutputSplitBySubProject.has(":dependency-diff-check-client-starter"),
    true,
  );

  const retMap = parseGradleProperties(
    propOutputSplitBySubProject.get("dependency-diff-check"),
  );
  assert.deepStrictEqual(retMap.rootProject, "dependency-diff-check");
  assert.deepStrictEqual(retMap.projects.length, 3);
  assert.deepStrictEqual(retMap.metadata.group, "com.ajmalab");
  assert.deepStrictEqual(retMap.metadata.version, "0.0.1-SNAPSHOT");
});

it("splits parallel gradle dependencies output correctly", async () => {
  const parallelGradleDepOutput = readFileSync(
    getTestFilePath("./test/gradle-dep-parallel.out"),
    { encoding: "utf-8" },
  );
  const relevantTasks = ["dependencies"];
  const depOutputSplitBySubProject = splitOutputByGradleProjects(
    parallelGradleDepOutput,
    relevantTasks,
  );

  assert.deepStrictEqual(depOutputSplitBySubProject.size, 4);
  assert.deepStrictEqual(
    depOutputSplitBySubProject.has("dependency-diff-check"),
    true,
  );
  assert.deepStrictEqual(
    depOutputSplitBySubProject.has(":dependency-diff-check-service"),
    true,
  );
  assert.deepStrictEqual(
    depOutputSplitBySubProject.has(":dependency-diff-check-common-core"),
    true,
  );
  assert.deepStrictEqual(
    depOutputSplitBySubProject.has(":dependency-diff-check-client-starter"),
    true,
  );

  const retMap = await parseGradleDep(
    depOutputSplitBySubProject.get("dependency-diff-check"),
    "dependency-diff-check",
    new Map().set(
      "dependency-diff-check",
      await buildObjectForGradleModule("dependency-diff-check", {
        version: "latest",
      }),
    ),
  );
  assert.deepStrictEqual(retMap.pkgList.length, 12);
  assert.deepStrictEqual(retMap.dependenciesList.length, 13);
});

it("splits parallel custom gradle task outputs correctly", async () => {
  const parallelGradleOutputWithOverridenTask = readFileSync(
    getTestFilePath("./test/gradle-build-env-dep.out"),
    { encoding: "utf-8" },
  );
  const overridenTasks = ["buildEnvironment"];
  const customDepTaskOuputSplitByProject = splitOutputByGradleProjects(
    parallelGradleOutputWithOverridenTask,
    overridenTasks,
  );
  assert.deepStrictEqual(customDepTaskOuputSplitByProject.size, 4);
  assert.deepStrictEqual(
    customDepTaskOuputSplitByProject.has("dependency-diff-check"),
    true,
  );
  assert.deepStrictEqual(
    customDepTaskOuputSplitByProject.has(":dependency-diff-check-service"),
    true,
  );
  assert.deepStrictEqual(
    customDepTaskOuputSplitByProject.has(":dependency-diff-check-common-core"),
    true,
  );
  assert.deepStrictEqual(
    customDepTaskOuputSplitByProject.has(
      ":dependency-diff-check-client-starter",
    ),
    true,
  );

  const retMap = await parseGradleDep(
    customDepTaskOuputSplitByProject.get(
      ":dependency-diff-check-client-starter",
    ),
    "dependency-diff-check",
    new Map().set(
      "dependency-diff-check",
      await buildObjectForGradleModule("dependency-diff-check", {
        version: "latest",
      }),
    ),
  );
  assert.deepStrictEqual(retMap.pkgList.length, 22);
  assert.deepStrictEqual(retMap.dependenciesList.length, 23);
});

it("parse gradle dependencies", async () => {
  const modulesMap = new Map();
  modulesMap.set(
    "test-project",
    await buildObjectForGradleModule("test-project", {
      version: "latest",
    }),
  );
  modulesMap.set(
    "dependency-diff-check-common-core",
    await buildObjectForGradleModule("dependency-diff-check-common-core", {
      version: "latest",
    }),
  );
  modulesMap.set(
    "app",
    await buildObjectForGradleModule("app", {
      version: "latest",
    }),
  );
  modulesMap.set(
    "failing-project",
    await buildObjectForGradleModule("failing-project", {
      version: "latest",
    }),
  );
  assert.deepStrictEqual(await parseGradleDep(null), {});
  let parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/gradle-dep.out"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 33);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 34);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "org.ethereum",
    name: "solcJ-all",
    qualifiers: {
      type: "jar",
    },
    version: "0.4.25",
    "bom-ref": "pkg:maven/org.ethereum/solcJ-all@0.4.25?type=jar",
    purl: "pkg:maven/org.ethereum/solcJ-all@0.4.25?type=jar",
  });

  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-android-dep.out"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 104);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 105);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "com.android.support.test",
    name: "runner",
    qualifiers: {
      type: "jar",
    },
    scope: "optional",
    version: "1.0.2",
    properties: [
      {
        name: "GradleProfileName",
        value: "debugAndroidTestCompileClasspath",
      },
    ],
    "bom-ref": "pkg:maven/com.android.support.test/runner@1.0.2?type=jar",
    purl: "pkg:maven/com.android.support.test/runner@1.0.2?type=jar",
  });
  assert.deepStrictEqual(parsedList.pkgList[103], {
    group: "androidx.core",
    name: "core",
    qualifiers: {
      type: "jar",
    },
    version: "1.7.0",
    scope: "optional",
    properties: [
      {
        name: "GradleProfileName",
        value: "releaseUnitTestRuntimeClasspath",
      },
    ],
    "bom-ref": "pkg:maven/androidx.core/core@1.7.0?type=jar",
    purl: "pkg:maven/androidx.core/core@1.7.0?type=jar",
  });
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-out1.dep"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 89);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 90);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "org.springframework.boot",
    name: "spring-boot-starter-web",
    version: "2.2.0.RELEASE",
    qualifiers: { type: "jar" },
    properties: [
      {
        name: "GradleProfileName",
        value: "compileClasspath",
      },
    ],
    "bom-ref":
      "pkg:maven/org.springframework.boot/spring-boot-starter-web@2.2.0.RELEASE?type=jar",
    purl: "pkg:maven/org.springframework.boot/spring-boot-starter-web@2.2.0.RELEASE?type=jar",
  });

  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-rich1.dep"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 4);
  assert.deepStrictEqual(parsedList.pkgList[parsedList.pkgList.length - 1], {
    group: "ch.qos.logback",
    name: "logback-core",
    qualifiers: { type: "jar" },
    version: "1.4.5",
    "bom-ref": "pkg:maven/ch.qos.logback/logback-core@1.4.5?type=jar",
    purl: "pkg:maven/ch.qos.logback/logback-core@1.4.5?type=jar",
  });
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-rich2.dep"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 2);
  assert.deepStrictEqual(parsedList.pkgList, [
    {
      group: "io.appium",
      name: "java-client",
      qualifiers: { type: "jar" },
      version: "8.1.1",
      "bom-ref": "pkg:maven/io.appium/java-client@8.1.1?type=jar",
      purl: "pkg:maven/io.appium/java-client@8.1.1?type=jar",
    },
    {
      group: "org.seleniumhq.selenium",
      name: "selenium-support",
      qualifiers: { type: "jar" },
      version: "4.5.0",
      "bom-ref":
        "pkg:maven/org.seleniumhq.selenium/selenium-support@4.5.0?type=jar",
      purl: "pkg:maven/org.seleniumhq.selenium/selenium-support@4.5.0?type=jar",
    },
  ]);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-rich3.dep"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 1);
  assert.deepStrictEqual(parsedList.pkgList, [
    {
      group: "org.seleniumhq.selenium",
      name: "selenium-remote-driver",
      version: "4.5.0",
      qualifiers: { type: "jar" },
      "bom-ref":
        "pkg:maven/org.seleniumhq.selenium/selenium-remote-driver@4.5.0?type=jar",
      purl: "pkg:maven/org.seleniumhq.selenium/selenium-remote-driver@4.5.0?type=jar",
    },
  ]);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-rich4.dep"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 1);
  assert.deepStrictEqual(parsedList.pkgList, [
    {
      group: "org.seleniumhq.selenium",
      name: "selenium-api",
      version: "4.5.0",
      qualifiers: { type: "jar" },
      "bom-ref":
        "pkg:maven/org.seleniumhq.selenium/selenium-api@4.5.0?type=jar",
      purl: "pkg:maven/org.seleniumhq.selenium/selenium-api@4.5.0?type=jar",
    },
  ]);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-rich5.dep"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 67);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 68);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-out-249.dep"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 21);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 22);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-service.out"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 35);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 36);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-s.out"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 28);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 29);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-core.out"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 18);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 19);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-single.out"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 152);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 153);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-android-app.dep"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 102);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-android-jetify.dep"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 1);
  assert.deepStrictEqual(parsedList.pkgList, [
    {
      group: "androidx.appcompat",
      name: "appcompat",
      version: "1.2.0",
      qualifiers: { type: "jar" },
      "bom-ref": "pkg:maven/androidx.appcompat/appcompat@1.2.0?type=jar",
      purl: "pkg:maven/androidx.appcompat/appcompat@1.2.0?type=jar",
    },
  ]);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-sm.dep"), {
      encoding: "utf-8",
    }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 6);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 7);
  parsedList = await parseGradleDep(
    readFileSync(getTestFilePath("./test/data/gradle-dependencies-559.txt"), {
      encoding: "utf-8",
    }),
    "failing-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 372);
});

it("parse gradle projects", () => {
  assert.deepStrictEqual(parseGradleProjects(null), {
    projects: [],
    rootProject: "root",
  });
  let retMap = parseGradleProjects(
    readFileSync(getTestFilePath("./test/data/gradle-projects.out"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "elasticsearch");
  assert.deepStrictEqual(retMap.projects.length, 368);
  retMap = parseGradleProjects(
    readFileSync(getTestFilePath("./test/data/gradle-projects1.out"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "elasticsearch");
  assert.deepStrictEqual(retMap.projects.length, 409);
  retMap = parseGradleProjects(
    readFileSync(getTestFilePath("./test/data/gradle-projects2.out"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "fineract");
  assert.deepStrictEqual(retMap.projects.length, 22);
  retMap = parseGradleProjects(
    readFileSync(getTestFilePath("./test/data/gradle-android-app.dep"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "root");
  assert.deepStrictEqual(retMap.projects, [":app"]);
  retMap = parseGradleProjects(
    readFileSync(getTestFilePath("./test/data/gradle-properties-sm.txt"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "root");
  assert.deepStrictEqual(retMap.projects, [
    ":module:dummy:core",
    ":module:dummy:service",
    ":module:dummy:starter",
    ":custom:foo:service",
  ]);
});

it("parse gradle properties", () => {
  assert.deepStrictEqual(parseGradleProperties(null), {
    projects: [],
    rootProject: "root",
    metadata: {
      group: "",
      version: "latest",
      properties: [],
    },
  });
  let retMap = parseGradleProperties(
    readFileSync(getTestFilePath("./test/data/gradle-properties.txt"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap, {
    rootProject: "dependency-diff-check",
    projects: [
      ":dependency-diff-check-client-starter",
      ":dependency-diff-check-common-core",
      ":dependency-diff-check-service",
    ],
    metadata: {
      group: "com.ajmalab",
      version: "0.0.1-SNAPSHOT",
      properties: [
        {
          name: "GradleModule",
          value: "dependency-diff-check",
        },
        {
          name: "buildFile",
          value:
            "/home/almalinux/work/sandbox/dependency-diff-check/build.gradle",
        },
        {
          name: "projectDir",
          value: "/home/almalinux/work/sandbox/dependency-diff-check",
        },
        {
          name: "rootDir",
          value: "/home/almalinux/work/sandbox/dependency-diff-check",
        },
      ],
    },
  });
  retMap = parseGradleProperties(
    readFileSync(getTestFilePath("./test/data/gradle-properties-single.txt"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap, {
    rootProject: "java-test",
    projects: [":app"],
    metadata: {
      group: "com.ajmalab.demo",
      version: "latest",
      properties: [
        {
          name: "GradleModule",
          value: "java-test",
        },
        {
          name: "buildFile",
          value: "/home/almalinux/work/sandbox/java-test/build.gradle",
        },
        {
          name: "projectDir",
          value: "/home/almalinux/work/sandbox/java-test",
        },
        { name: "rootDir", value: "/home/almalinux/work/sandbox/java-test" },
      ],
    },
  });
  retMap = parseGradleProperties(
    readFileSync(getTestFilePath("./test/data/gradle-properties-single2.txt"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap, {
    rootProject: "java-test",
    projects: [],
    metadata: {
      group: "com.ajmalab.demo",
      version: "latest",
      properties: [
        {
          name: "GradleModule",
          value: "java-test",
        },
        {
          name: "buildFile",
          value: "/home/almalinux/work/sandbox/java-test/build.gradle",
        },
        { name: "projectDir", value: "/home/almalinux/work/sandbox/java-test" },
        { name: "rootDir", value: "/home/almalinux/work/sandbox/java-test" },
      ],
    },
  });
  retMap = parseGradleProperties(
    readFileSync(getTestFilePath("./test/data/gradle-properties-elastic.txt"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "elasticsearch");
  assert.deepStrictEqual(retMap.projects.length, 409);
  retMap = parseGradleProperties(
    readFileSync(getTestFilePath("./test/data/gradle-properties-android.txt"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "CdxgenAndroidTest");
  assert.deepStrictEqual(retMap.projects.length, 2);
  retMap = parseGradleProperties(
    readFileSync(getTestFilePath("./test/data/gradle-properties-sm.txt"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "root");
  assert.deepStrictEqual(retMap.projects, []);
  retMap = parseGradleProperties(
    readFileSync(getTestFilePath("./test/data/gradle-properties-559.txt"), {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "failing-project");
  assert.deepStrictEqual(retMap.projects, []);
});

it("extracts gradle repository URLs correctly", () => {
  const sampleOutput = `
Some gradle build output line
<CDXGEN:repository>: maven-central : https://repo.maven.apache.org/maven2
<CDXGEN:repository>: local-m2 : file:///home/user/.m2/repository
  `;
  const result = extractGradleRepositoryUrls(sampleOutput);
  assert.deepStrictEqual(result, {
    "maven-central": "https://repo.maven.apache.org/maven2",
    "local-m2": "file:///home/user/.m2/repository",
  });
});

it("parses gradle info logs for URLs correctly", () => {
  const sampleStdout = `
Resource found. [HTTP GET: https://repo1.maven.org/maven2/org/slf4j/slf4j-api/1.7.36/slf4j-api-1.7.36.jar]
Cached resource https://repo1.maven.org/maven2/com/google/guava/guava/31.1-jre/guava-31.1-jre.pom is up-to-date
Cached resource https://dl.google.com/dl/android/maven2/androidx/annotation/annotation/1.6.0/annotation-1.6.0.module is up-to-date
Found locally available resource with matching checksum: [https://repo.maven.apache.org/maven2/org/slf4j/slf4j-api/2.0.7/slf4j-api-2.0.7.pom, /Users/prabhu/.m2/repository/org/slf4j/slf4j-api/2.0.7/slf4j-api-2.0.7.pom]
  `;
  const result = parseGradleInfoLogsForUrls(sampleStdout);
  assert.deepStrictEqual(result, {
    "slf4j-api-1.7.36.jar":
      "https://repo1.maven.org/maven2/org/slf4j/slf4j-api/1.7.36/slf4j-api-1.7.36.jar",
    "guava-31.1-jre.jar":
      "https://repo1.maven.org/maven2/com/google/guava/guava/31.1-jre/guava-31.1-jre.jar",
    "annotation-1.6.0.jar":
      "https://dl.google.com/dl/android/maven2/androidx/annotation/annotation/1.6.0/annotation-1.6.0.jar",
    "slf4j-api-2.0.7.jar":
      "https://repo.maven.apache.org/maven2/org/slf4j/slf4j-api/2.0.7/slf4j-api-2.0.7.jar",
  });
});

it("parses gradle resolved distributions correctly", () => {
  const sampleStdout = `
Some gradle build output line
<CDXGEN:distribution>:org.slf4j:slf4j-api:2.0.7 -> https://repo.maven.apache.org/maven2/org/slf4j/slf4j-api/2.0.7/slf4j-api-2.0.7.jar
<CDXGEN:distribution>:com.google.android.gms:play-services-basement:18.1.0 -> https://dl.google.com/dl/android/maven2/com/google/android/gms/play-services-basement/18.1.0/play-services-basement-18.1.0.aar
malformed <CDXGEN:distribution>:no-separator-here
  `;
  const result = parseGradleResolvedDistributions(sampleStdout);
  assert.deepStrictEqual(result, {
    "org.slf4j:slf4j-api:2.0.7":
      "https://repo.maven.apache.org/maven2/org/slf4j/slf4j-api/2.0.7/slf4j-api-2.0.7.jar",
    "com.google.android.gms:play-services-basement:18.1.0":
      "https://dl.google.com/dl/android/maven2/com/google/android/gms/play-services-basement/18.1.0/play-services-basement-18.1.0.aar",
  });
  assert.deepStrictEqual(parseGradleResolvedDistributions(""), {});
});
