import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, assert, describe, it } from "poku";

import { getLedgerEvents, resetLedgerEvents } from "../core/buildLedger.js";
import {
  buildGradleCommandArguments,
  buildObjectForGradleModule,
  extractGradleRepositoryUrls,
  getGradleCommand,
  getMavenCommand,
  getMillCommand,
  parseGradleDep,
  parseGradleInfoLogsForUrls,
  parseGradleProjects,
  parseGradleProperties,
  parseGradleResolvedDistributions,
  parseGradleVersionCatalog,
  recordGradleInvocationFailure,
  resetGradleFailureCauses,
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

it("splits interleaved parallel gradle output by the project named in each task header", async () => {
  // Issue 4465: with parallel or interrupted output a task's report can trail
  // another task's header, and a task whose report never printed a `Project`
  // header must not overwrite a sibling project's entry. The fixture
  // rearranges the real captured blocks of gradle-dep-parallel.out into
  // exactly that shape: the client-starter task header is immediately
  // followed by the common-core task, common-core's report precedes the
  // root's, and the service's report comes last.
  const interleavedOutput = readFileSync(
    getTestFilePath("./test/gradle-dep-parallel-interleaved.out"),
    { encoding: "utf-8" },
  );
  const interleavedSplit = splitOutputByGradleProjects(interleavedOutput, [
    "dependencies",
  ]);

  assert.deepStrictEqual(interleavedSplit.size, 4);
  // The interrupted task keeps its own entry, reduced to its task line, and
  // clobbers nobody else's report. A Windows checkout gives the fixture CRLF
  // line endings, which the split keeps as Gradle's own output would have.
  assert.deepStrictEqual(
    interleavedSplit
      .get(":dependency-diff-check-client-starter")
      .replaceAll("\r", ""),
    "> Task :dependency-diff-check-client-starter:dependencies\n",
  );
  for (const [project, ownHeader, otherHeader] of [
    [
      ":dependency-diff-check-common-core",
      "Project ':dependency-diff-check-common-core'",
      "Project ':dependency-diff-check-service'",
    ],
    [
      "dependency-diff-check",
      "Root project 'dependency-diff-check'",
      "Project ':dependency-diff-check-common-core'",
    ],
    [
      ":dependency-diff-check-service",
      "Project ':dependency-diff-check-service'",
      "Root project 'dependency-diff-check'",
    ],
  ]) {
    const chunk = interleavedSplit.get(project);
    assert.ok(chunk, `missing chunk for ${project}`);
    assert.ok(
      chunk.includes(ownHeader),
      `${project} chunk must contain its own report header`,
    );
    assert.ok(
      !chunk.includes(otherHeader),
      `${project} chunk must not contain another project's report header`,
    );
  }

  // Reordering identical task reports must not change the SBOM dependency
  // graph: parsing each project's chunk from the interleaved fixture and from
  // the original sequential one yields the same components and dependsOn
  // edges.
  const sequentialOutput = readFileSync(
    getTestFilePath("./test/gradle-dep-parallel.out"),
    { encoding: "utf-8" },
  );
  const sequentialSplit = splitOutputByGradleProjects(sequentialOutput, [
    "dependencies",
  ]);
  const gradleModules = new Map();
  for (const moduleName of [
    "dependency-diff-check",
    ":dependency-diff-check-service",
    ":dependency-diff-check-common-core",
    ":dependency-diff-check-client-starter",
  ]) {
    gradleModules.set(
      moduleName,
      await buildObjectForGradleModule(moduleName, { version: "latest" }),
    );
  }
  const parseChunk = async (chunk) => {
    const parsed = await parseGradleDep(
      chunk,
      "dependency-diff-check",
      gradleModules,
      "",
    );
    return {
      purls: parsed.pkgList.map((p) => p.purl).sort(),
      dependsOn: parsed.dependenciesList
        .map((d) => `${d.ref}|${d.dependsOn.join(",")}`)
        .sort(),
    };
  };
  for (const project of [
    "dependency-diff-check",
    ":dependency-diff-check-common-core",
    ":dependency-diff-check-service",
  ]) {
    assert.deepStrictEqual(
      await parseChunk(interleavedSplit.get(project)),
      await parseChunk(sequentialSplit.get(project)),
      `dependency graph for ${project} must be identical regardless of task order`,
    );
  }
});

it("keeps every part of an interrupted gradle report with its own project, the root included", async () => {
  // Gradle flushes a long-running task's output in parts and repeats the
  // task header before each later part, which carries no report header of
  // its own. Rebuild gradle-dep-parallel.out in that shape: the root report
  // is cut inside the runtimeClasspath tree and resumes under a second
  // `> Task :dependencies` header after the service's report, and another
  // task's group sits between two reports.
  const sequentialOutput = readFileSync(
    getTestFilePath("./test/gradle-dep-parallel.out"),
    { encoding: "utf-8" },
  );
  const lines = sequentialOutput.split("\n");
  // 1-based, inclusive line ranges of the fixture.
  const block = (first, last) => lines.slice(first - 1, last);
  assert.ok(lines[57].includes("kotlin-stdlib:1.5.31 -> 1.6.20"));
  assert.ok(lines[58].includes("kotlin-stdlib-common:1.6.20"));
  const rootTaskHeader = lines[4];
  assert.ok(rootTaskHeader.startsWith("> Task :dependencies"));
  // A dependencyInsight group prints tree lines too. They belong to its own
  // task, not to the report printed before it.
  const insightGroup = [
    "> Task :dependency-diff-check-service:dependencyInsight",
    "com.google.code.gson:gson:2.10.1",
    "\\--- com.slack.api:slack-api-model:1.29.2",
    "     \\--- runtimeClasspath",
    "",
  ];
  const interleavedOutput = [
    ...block(1, 58),
    ...block(131, 348),
    rootTaskHeader,
    ...block(59, 130),
    ...insightGroup,
    ...block(519, 766),
    ...block(349, 518),
  ].join("\n");
  const interleavedSplit = splitOutputByGradleProjects(interleavedOutput, [
    "dependencies",
  ]);
  const sequentialSplit = splitOutputByGradleProjects(sequentialOutput, [
    "dependencies",
  ]);
  const projects = [
    "dependency-diff-check",
    ":dependency-diff-check-service",
    ":dependency-diff-check-common-core",
    ":dependency-diff-check-client-starter",
  ];
  // The resumed root part is not filed under a separate "root" entry.
  assert.deepStrictEqual([...interleavedSplit.keys()].sort(), projects.sort());
  for (const [project, chunk] of interleavedSplit) {
    assert.ok(
      !chunk.includes("dependencyInsight") &&
        !chunk.includes("\\--- runtimeClasspath"),
      `the dependencyInsight group must not be attributed to ${project}`,
    );
  }
  const gradleModules = new Map();
  for (const moduleName of projects) {
    gradleModules.set(
      moduleName,
      await buildObjectForGradleModule(moduleName, { version: "latest" }),
    );
  }
  const parseChunk = async (chunk, project) => {
    const parsed = await parseGradleDep(chunk, project, gradleModules, "");
    return {
      purls: parsed.pkgList.map((p) => p.purl).sort(),
      dependsOn: parsed.dependenciesList
        .map((d) => `${d.ref}|${d.dependsOn.join(",")}`)
        .sort(),
    };
  };
  for (const project of projects) {
    const interleaved = await parseChunk(
      interleavedSplit.get(project),
      project,
    );
    assert.ok(interleaved.purls.length > 0, `${project} parsed no components`);
    assert.deepStrictEqual(
      interleaved,
      await parseChunk(sequentialSplit.get(project), project),
      `dependency graph for ${project} must not depend on how its report was interrupted`,
    );
  }
});

it("matches gradle task headers by the task name, whatever status follows it", () => {
  const output = [
    "> Task :app:dependencies",
    "Project ':app'",
    "+--- org.a:a:1.0",
    // A status after the task path, and a carriage return, do not hide the
    // task; the header used to fail to match and its report went to `:app`.
    "> Task :lib:dependencies FAILED\r",
    "Project ':lib'",
    "+--- org.l:l:1.0",
    // Neither a longer name nor a camel-cased one is the dependencies task.
    "> Task :web:dependenciess",
    "+--- org.w:w:1.0",
    "> Task :web:androidDependencies",
    "+--- org.x:x:1.0",
  ].join("\n");
  const split = splitOutputByGradleProjects(output, ["dependencies"]);
  assert.deepStrictEqual([...split.keys()], [":app", ":lib"]);
  assert.strictEqual(
    split.get(":app"),
    "> Task :app:dependencies\nProject ':app'\n+--- org.a:a:1.0\n",
  );
  assert.strictEqual(
    split.get(":lib"),
    "> Task :lib:dependencies FAILED\r\nProject ':lib'\n+--- org.l:l:1.0\n",
  );
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
        name: "internal:GradleProfileName",
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
        name: "internal:GradleProfileName",
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
        name: "internal:GradleProfileName",
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
          name: "internal:GradleModule",
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
          name: "internal:GradleModule",
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
          name: "internal:GradleModule",
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

// The pinned-tool assertions mutate the shared process environment, so they
// are kept in a single sequential test to avoid races with the other
// (concurrently executed) tests in this file.
it("getMavenCommand and getGradleCommand honour explicit CLI pins over wrappers", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const osJoin = (await import("node:path")).join;
  const wrapperDir = mkdtempSync(osJoin(tmpdir(), "cdxgen-resolver-test-"));
  const managed = [
    "CDXGEN_JVM_TOOL_PINNED",
    "MVN_CMD",
    "GRADLE_CMD",
    "MAVEN_CMD",
    "MAVEN_HOME",
    "GRADLE_HOME",
  ];
  const saved = {};
  const restore = () => {
    for (const envVar of managed) {
      if (saved[envVar] === undefined || saved[envVar] === false) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = saved[envVar];
      }
    }
  };
  for (const envVar of managed) {
    saved[envVar] = process.env[envVar] ?? false;
    delete process.env[envVar];
  }
  try {
    // Wrappers that answer --version successfully, pinned to another version
    // than the one a CLI pin would request. Windows resolvers look for the
    // .bat variants, so the fixtures follow the platform.
    const isWin = process.platform === "win32";
    const mavenWrapperName = isWin ? "mvnw.bat" : "mvnw";
    const gradleWrapperName = isWin ? "gradlew.bat" : "gradlew";
    if (isWin) {
      writeFileSync(
        osJoin(wrapperDir, mavenWrapperName),
        "@echo off\r\necho Apache Maven 3.9.6\r\nexit /b 0\r\n",
        { encoding: "utf-8" },
      );
      writeFileSync(
        osJoin(wrapperDir, gradleWrapperName),
        "@echo off\r\necho Gradle 8.14\r\nexit /b 0\r\n",
        { encoding: "utf-8" },
      );
    } else {
      writeFileSync(
        osJoin(wrapperDir, mavenWrapperName),
        "#!/bin/sh\necho 'Apache Maven 3.9.6'\nexit 0\n",
        { mode: 0o775, encoding: "utf-8" },
      );
      writeFileSync(
        osJoin(wrapperDir, gradleWrapperName),
        "#!/bin/sh\necho 'Gradle 8.14'\nexit 0\n",
        { mode: 0o775, encoding: "utf-8" },
      );
    }

    // Without a pin, the project wrappers win.
    assert.strictEqual(
      getMavenCommand(wrapperDir, wrapperDir),
      osJoin(wrapperDir, mavenWrapperName),
    );
    assert.strictEqual(
      getGradleCommand(wrapperDir, wrapperDir),
      osJoin(wrapperDir, gradleWrapperName),
    );

    // With a pin, the pinned command beats the wrappers.
    process.env.CDXGEN_JVM_TOOL_PINNED = "true";
    process.env.MVN_CMD = "/opt/sdkman/candidates/maven/3.9.9/bin/mvn";
    process.env.GRADLE_CMD = "/opt/sdkman/candidates/gradle/8.14.3/bin/gradle";
    assert.strictEqual(
      getMavenCommand(wrapperDir, wrapperDir),
      "/opt/sdkman/candidates/maven/3.9.9/bin/mvn",
    );
    assert.strictEqual(
      getGradleCommand(wrapperDir, wrapperDir),
      "/opt/sdkman/candidates/gradle/8.14.3/bin/gradle",
    );

    // With a pin but no command override, fall back without the wrapper.
    delete process.env.MVN_CMD;
    delete process.env.GRADLE_CMD;
    assert.strictEqual(getMavenCommand(wrapperDir, wrapperDir), "mvn");
    assert.strictEqual(getGradleCommand(wrapperDir, wrapperDir), "gradle");
  } finally {
    restore();
    rmSync(wrapperDir, { recursive: true, force: true });
  }
});

describe("recordGradleInvocationFailure()", () => {
  const previousIntrospect = process.env.CDXGEN_INTROSPECT;
  // The recorder reads the environment live, so each test opts back in
  // before recording; the afterEach restores the caller's value.
  const beginRecording = () => {
    process.env.CDXGEN_INTROSPECT = "true";
    resetLedgerEvents();
    resetGradleFailureCauses();
  };

  /**
   * The ledger events of one kind.
   *
   * @param {string} kind Event kind to filter.
   * @returns {Object[]} Matching events.
   */
  const eventsOfKind = (kind) =>
    getLedgerEvents().filter((event) => event.kind === kind);

  /**
   * A spawn result like the ones `safeSpawnSync` produces for a failed
   * gradle invocation.
   *
   * @param {Object} parts Result pieces.
   * @param {number} [parts.status] Exit status.
   * @param {string} [parts.stderr] Standard error.
   * @param {string} [parts.stdout] Standard output.
   * @returns {Object} Spawn result.
   */
  const spawnResult = ({ status = 1, stderr = "", stdout = "" }) => ({
    status,
    stderr,
    stdout,
  });

  afterEach(() => {
    resetLedgerEvents();
    if (previousIntrospect === undefined) {
      delete process.env.CDXGEN_INTROSPECT;
    } else {
      process.env.CDXGEN_INTROSPECT = previousIntrospect;
    }
  });

  it("names the refused JDK when Gradle cannot run on it", () => {
    beginRecording();
    recordGradleInvocationFailure(
      spawnResult({
        stderr:
          "BUG! exception in phase 'semantic analysis' Unsupported class file major version 69",
      }),
      { command: "gradle properties", gradleVersion: "8.13" },
    );
    const mismatches = eventsOfKind("tool.mismatch");
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].tool, "gradle");
    // Java 25 needs Gradle 9.1.0 or higher, and the running Gradle was 8.13.
    assert.equal(mismatches[0].wanted, "9.1.0");
    assert.equal(mismatches[0].found, "8.13");
    assert.equal(mismatches[0].ecosystem, "java");
    const degradations = eventsOfKind("command.failed");
    assert.equal(degradations.length, 1);
    assert.equal(degradations[0].remediationId, "jvm.gradle.invocation-failed");
    assert.equal(degradations[0].impact, "transitive-deps");
  });

  it("names the required JDK when the launcher refuses an old one", () => {
    beginRecording();
    recordGradleInvocationFailure(
      spawnResult({
        stderr:
          "java.lang.UnsupportedClassVersionError: org/gradle/launcher/daemon/client/DaemonClient has been compiled by a more recent version of the Java Runtime (class file version 61.0), this version of the Java Runtime only recognizes class file versions up to 52.0",
      }),
      { command: "gradlew properties" },
    );
    const mismatches = eventsOfKind("tool.mismatch");
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].tool, "java");
    // Class file 61 is Java 17; the running runtime (class file 52) is Java 8.
    assert.equal(mismatches[0].wanted, "17");
    assert.equal(mismatches[0].found, "8");
  });

  it("names the demanded JDK from the launcher's modern refusal message", () => {
    beginRecording();
    // The phrasing a wrapper-downloaded Gradle prints when the image's JDK
    // predates the release the wrapper pins.
    recordGradleInvocationFailure(
      spawnResult({
        stderr:
          "FAILURE: Build failed with an exception.\n\n* What went wrong:\nAn exception occurred starting the Gradle daemon.\n\nGradle requires JVM 17 or later to run. Your build is currently configured to use JVM 8.",
      }),
      { command: "./gradlew properties" },
    );
    const mismatches = eventsOfKind("tool.mismatch");
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].kind, "tool.mismatch");
    assert.equal(mismatches[0].tool, "java");
    assert.equal(mismatches[0].wanted, "17");
    assert.equal(mismatches[0].found, "8");
    assert.equal(mismatches[0].source, "invocation");
    assert.match(mismatches[0].detail, /Gradle requires Java 17 or later/);
    assert.match(mismatches[0].detail, /the active JVM is Java 8/);
    const degradations = eventsOfKind("command.failed");
    assert.equal(degradations.length, 1);
    assert.equal(degradations[0].remediationId, "jvm.gradle.invocation-failed");
  });

  it("records a mismatch without a found version when the refusal names only the demand", () => {
    beginRecording();
    recordGradleInvocationFailure(
      spawnResult({
        stderr: "Gradle requires JVM 21 or later to run.",
      }),
      { command: "gradle properties" },
    );
    const mismatches = eventsOfKind("tool.mismatch");
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].tool, "java");
    assert.equal(mismatches[0].wanted, "21");
    assert.equal(mismatches[0].found, undefined);
    assert.match(mismatches[0].detail, /Gradle requires Java 21 or later/);
  });

  it("records no mismatch when the refusal names no usable major", () => {
    beginRecording();
    recordGradleInvocationFailure(
      spawnResult({
        stderr:
          "Gradle requires JVM or later to run. Your build is currently configured to use JVM.",
      }),
      { command: "gradle properties" },
    );
    assert.equal(eventsOfKind("tool.mismatch").length, 0);
    const degradations = eventsOfKind("command.failed");
    assert.equal(degradations.length, 1);
    assert.equal(degradations[0].remediationId, "jvm.gradle.invocation-failed");
  });

  it("reports a missing JDK when JAVA_HOME names an invalid directory", () => {
    beginRecording();
    recordGradleInvocationFailure(
      spawnResult({
        stderr: "ERROR: JAVA_HOME is set to an invalid directory: /opt/nojdk",
      }),
      { command: "gradle properties" },
    );
    const missing = eventsOfKind("tool.missing");
    assert.equal(missing.length, 1);
    assert.equal(missing[0].tool, "java");
    assert.equal(missing[0].source, "JAVA_HOME");
    const degradations = eventsOfKind("command.failed");
    assert.equal(degradations.length, 1);
    assert.equal(degradations[0].remediationId, "jvm.gradle.invocation-failed");
  });

  it("reports a daemon that did not start", () => {
    beginRecording();
    recordGradleInvocationFailure(
      spawnResult({
        stderr:
          "Could not start Gradle Daemon. Daemon could not be started because the JVM is broken.",
      }),
      { command: "gradle properties" },
    );
    const degraded = eventsOfKind("evidence.degraded");
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0].tool, "gradle");
    assert.equal(degraded[0].ecosystem, "java");
    const degradations = eventsOfKind("command.failed");
    assert.equal(degradations.length, 1);
    assert.equal(degradations[0].remediationId, "jvm.gradle.invocation-failed");
  });

  it("records only the degradation for an ordinary build failure", () => {
    beginRecording();
    recordGradleInvocationFailure(
      spawnResult({
        stderr:
          "FAILURE: Build failed with an exception. Compilation failed; see the compiler error output for details.",
      }),
      { command: "gradle properties" },
    );
    assert.equal(eventsOfKind("tool.mismatch").length, 0);
    assert.equal(eventsOfKind("tool.missing").length, 0);
    const degradations = eventsOfKind("command.failed");
    assert.equal(degradations.length, 1);
    assert.equal(degradations[0].remediationId, "jvm.gradle.invocation-failed");
  });

  it("diagnoses the same cause once per run", () => {
    beginRecording();
    const result = spawnResult({
      stderr: "Unsupported class file major version 68",
    });
    recordGradleInvocationFailure(result, { command: "gradle properties" });
    recordGradleInvocationFailure(result, { command: "gradle dependencies" });
    assert.equal(eventsOfKind("tool.mismatch").length, 1);
    assert.equal(eventsOfKind("command.failed").length, 2);
  });

  it("records nothing for a successful invocation", () => {
    beginRecording();
    recordGradleInvocationFailure(spawnResult({ status: 0, stdout: "ok" }), {
      command: "gradle properties",
    });
    assert.equal(getLedgerEvents().length, 0);
  });
});

describe("parseGradleVersionCatalog()", () => {
  it("emits only catalog entries whose version resolves to a literal", () => {
    const pkgList = parseGradleVersionCatalog(
      "./test/data/gradle-smoke/gradle/libs.versions.toml",
    );
    assert.strictEqual(pkgList.length, 2);

    const stdlib = pkgList.find((p) => p.name === "kotlin-stdlib");
    assert.strictEqual(stdlib.group, "org.jetbrains.kotlin");
    assert.strictEqual(stdlib.version, "2.0.21");
    assert.strictEqual(
      stdlib.purl,
      "pkg:maven/org.jetbrains.kotlin/kotlin-stdlib@2.0.21",
    );
    assert.strictEqual(
      stdlib.properties.find((p) => p.name === "cdx:gradle:catalog").value,
      "true",
    );

    const junit = pkgList.find((p) => p.name === "junit-bom");
    assert.strictEqual(junit.version, "5.11.3");

    // A version.ref with no matching entry and a rich range must be skipped.
    assert.ok(!pkgList.some((p) => p.name === "okhttp"));
    assert.ok(!pkgList.some((p) => p.name === "legacy-lib"));
  });

  it("returns nothing for an unreadable catalog", () => {
    assert.deepStrictEqual(
      parseGradleVersionCatalog("./test/data/gradle-smoke/missing.toml"),
      [],
    );
  });
});

describe("project-local wrappers are skipped when dependency installation is disabled", () => {
  it("getMavenCommand, getGradleCommand and getMillCommand ignore mvnw/gradlew/mill with installDeps false", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const osJoin = (await import("node:path")).join;
    const wrapperDir = mkdtempSync(osJoin(tmpdir(), "cdxgen-resolver-gate-"));
    const managed = [
      "CDXGEN_JVM_TOOL_PINNED",
      "MVN_CMD",
      "GRADLE_CMD",
      "MAVEN_CMD",
      "MAVEN_HOME",
      "GRADLE_HOME",
    ];
    const saved = {};
    const restore = () => {
      for (const envVar of managed) {
        if (saved[envVar] === undefined || saved[envVar] === false) {
          delete process.env[envVar];
        } else {
          process.env[envVar] = saved[envVar];
        }
      }
    };
    for (const envVar of managed) {
      saved[envVar] = process.env[envVar] ?? false;
      delete process.env[envVar];
    }
    try {
      const isWin = process.platform === "win32";
      const mavenWrapperName = isWin ? "mvnw.bat" : "mvnw";
      const gradleWrapperName = isWin ? "gradlew.bat" : "gradlew";
      const millWrapperName = isWin ? "mill.bat" : "mill";
      if (isWin) {
        writeFileSync(
          osJoin(wrapperDir, mavenWrapperName),
          "@echo off\r\necho Apache Maven 3.9.6\r\nexit /b 0\r\n",
          { encoding: "utf-8" },
        );
        writeFileSync(
          osJoin(wrapperDir, gradleWrapperName),
          "@echo off\r\necho Gradle 8.14\r\nexit /b 0\r\n",
          { encoding: "utf-8" },
        );
        writeFileSync(
          osJoin(wrapperDir, millWrapperName),
          "@echo off\r\necho Mill 0.12.10\r\nexit /b 0\r\n",
          { encoding: "utf-8" },
        );
      } else {
        writeFileSync(
          osJoin(wrapperDir, mavenWrapperName),
          "#!/bin/sh\necho 'Apache Maven 3.9.6'\nexit 0\n",
          { mode: 0o775, encoding: "utf-8" },
        );
        writeFileSync(
          osJoin(wrapperDir, gradleWrapperName),
          "#!/bin/sh\necho 'Gradle 8.14'\nexit 0\n",
          { mode: 0o775, encoding: "utf-8" },
        );
        writeFileSync(
          osJoin(wrapperDir, millWrapperName),
          "#!/bin/sh\necho 'Mill 0.12.10'\nexit 0\n",
          { mode: 0o775, encoding: "utf-8" },
        );
      }

      // Default (dependency installation allowed): the wrappers win.
      assert.strictEqual(
        getMavenCommand(wrapperDir, wrapperDir),
        osJoin(wrapperDir, mavenWrapperName),
      );
      assert.strictEqual(
        getGradleCommand(wrapperDir, wrapperDir),
        osJoin(wrapperDir, gradleWrapperName),
      );
      assert.strictEqual(
        getMillCommand(wrapperDir),
        osJoin(wrapperDir, millWrapperName),
      );

      // --no-install-deps (and the pre-build lifecycle): wrappers from the
      // scanned project must never be chmod'ed or executed, so the system
      // commands are used instead.
      const opts = { installDeps: false };
      assert.strictEqual(getMavenCommand(wrapperDir, wrapperDir, opts), "mvn");
      assert.strictEqual(
        getGradleCommand(wrapperDir, wrapperDir, opts),
        "gradle",
      );
      assert.strictEqual(
        getMillCommand(wrapperDir, opts).startsWith("mill"),
        true,
      );

      // Explicit opt-in keeps the historical wrapper behaviour.
      const optsOn = { installDeps: true };
      assert.strictEqual(
        getMavenCommand(wrapperDir, wrapperDir, optsOn),
        osJoin(wrapperDir, mavenWrapperName),
      );
      assert.strictEqual(
        getGradleCommand(wrapperDir, wrapperDir, optsOn),
        osJoin(wrapperDir, gradleWrapperName),
      );
    } finally {
      restore();
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });
});

describe("buildGradleCommandArguments forces the evaluation model the init script needs", () => {
  it("turns isolated projects and the configuration cache off on every invocation", () => {
    const [args] = buildGradleCommandArguments([], ["dependencies"], [], 6);
    // The bundled init script reaches into every project via allprojects and
    // registers build listeners, which isolated projects forbid (issue #4444)
    // and the configuration cache would skip on reuse. The property is spelled
    // org.gradle.unsafe.isolated-projects until Gradle 9.7 renamed it, so both
    // spellings must be forced off to cover every Gradle in between.
    assert.ok(args.includes("-Dorg.gradle.isolated-projects=false"));
    assert.ok(args.includes("-Dorg.gradle.unsafe.isolated-projects=false"));
    assert.ok(args.includes("-Dorg.gradle.configuration-cache=false"));
    assert.ok(args.includes("-Dorg.gradle.unsafe.configuration-cache=false"));
    assert.ok(args.includes("dependencies"));
  });

  it("keeps an explicit value the user passed for either spelling", () => {
    // Gradle disables a feature when any spelling is false, so forcing the
    // other spelling off would silently cancel the user's choice.
    const [args] = buildGradleCommandArguments(
      [
        "-Dorg.gradle.isolated-projects=true",
        "-Dorg.gradle.unsafe.configuration-cache=true",
      ],
      ["dependencies"],
      [],
      6,
    );
    assert.ok(!args.some((arg) => arg.includes("isolated-projects=false")));
    assert.ok(!args.some((arg) => arg.includes("configuration-cache=false")));
    assert.ok(args.includes("-Dorg.gradle.isolated-projects=true"));
    assert.ok(args.includes("-Dorg.gradle.unsafe.configuration-cache=true"));
  });

  it("treats the command-line feature options as the user's choice", () => {
    const [args] = buildGradleCommandArguments(
      ["--configuration-cache", "--no-isolated-projects"],
      ["dependencies"],
      [],
      6,
    );
    // Command-line options beat -D properties, so overriding them is moot.
    assert.ok(!args.some((arg) => arg.includes("isolated-projects=false")));
    assert.ok(!args.some((arg) => arg.includes("configuration-cache=false")));
  });
});

it("getMillVersion reads the version file, the build header or the launcher", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { getMillVersion } = await import("./gradleutils.js");
  const dir = mkdtempSync(path.join(tmpdir(), "cdxgen-millver-"));
  try {
    // No version anywhere: the launcher is probed
    assert.strictEqual(getMillVersion(dir, "false"), null);
    writeFileSync(path.join(dir, ".mill-version"), "1.0.6\n");
    assert.strictEqual(getMillVersion(dir, "false"), "1.0.6");
    rmSync(path.join(dir, ".mill-version"));
    writeFileSync(
      path.join(dir, "build.mill"),
      "//| mill-version: 1.0.4\npackage build\n",
    );
    assert.strictEqual(getMillVersion(dir, "false"), "1.0.4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("stopMillDaemons stops only the daemons the scan started", async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const esmock = (await import("esmock")).default;
  const sinon = (await import("sinon")).default;
  const fsCore = await import("../core/fs.js");
  const safeSpawnSync = sinon.stub().returns({ status: 0 });
  const { findMillDaemons, stopMillDaemons } = await esmock(
    "./gradleutils.js",
    {
      "../core/fs.js": { ...fsCore, safeSpawnSync },
    },
  );
  const scanDir = mkdtempSync(path.join(tmpdir(), "cdxgen-milldaemon-"));
  const daemonDir = (...parts) => {
    const dir = path.join(scanDir, ...parts);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  try {
    // A live daemon in the root build, written the way Mill 1.x does
    writeFileSync(
      path.join(daemonDir("out", "mill-daemon"), "processId"),
      `${process.pid}\n`,
    );
    writeFileSync(path.join(scanDir, "mill"), "#!/bin/sh\n");
    // A daemon of a nested build in the Mill 0.12 layout, whose process is gone
    writeFileSync(
      path.join(
        daemonDir("plugin", "out", "mill-server", "a1b2-1"),
        "processId",
      ),
      "999999999",
    );
    // The root daemon was already running before the scan: it is kept
    const before = findMillDaemons(scanDir);
    assert.deepStrictEqual([...before.keys()], [scanDir]);
    stopMillDaemons(scanDir, before);
    assert.strictEqual(safeSpawnSync.callCount, 0);
    // Started during the scan: it is stopped through the build's launcher
    stopMillDaemons(scanDir, new Map());
    assert.strictEqual(safeSpawnSync.callCount, 1);
    assert.deepStrictEqual(safeSpawnSync.firstCall.args[1], ["shutdown"]);
    assert.strictEqual(safeSpawnSync.firstCall.args[2].cwd, scanDir);
    assert.strictEqual(
      safeSpawnSync.firstCall.args[0],
      path.join(scanDir, "mill"),
    );
  } finally {
    rmSync(scanDir, { recursive: true, force: true });
  }
});
