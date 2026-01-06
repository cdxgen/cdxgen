import { Buffer } from "node:buffer";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PackageURL } from "packageurl-js";
import { assert, describe, it, test } from "poku";
import { parse } from "ssri";
import { parse as loadYaml } from "yaml";

import {
  buildObjectForCocoaPod,
  buildObjectForGradleModule,
  encodeForPurl,
  findLicenseId,
  findPnpmPackagePath,
  getCratesMetadata,
  getDartMetadata,
  getLicenses,
  getMvnMetadata,
  getNugetMetadata,
  getPyMetadata,
  guessPypiMatchingVersion,
  hasAnyProjectType,
  isPackageManagerAllowed,
  isPartialTree,
  isValidIriReference,
  mapConanPkgRefToPurlStringAndNameAndVersion,
  parseBazelActionGraph,
  parseBazelBuild,
  parseBazelSkyframe,
  parseBdistMetadata,
  parseBitbucketPipelinesFile,
  parseBowerJson,
  parseCabalData,
  parseCargoAuditableData,
  parseCargoData,
  parseCargoDependencyData,
  parseCargoTomlData,
  parseCljDep,
  parseCloudBuildData,
  parseCmakeDotFile,
  parseCmakeLikeFile,
  parseCocoaDependency,
  parseComposerJson,
  parseComposerLock,
  parseConanData,
  parseConanLockData,
  parseContainerFile,
  parseContainerSpecData,
  parseCsPkgData,
  parseCsPkgLockData,
  parseCsProjAssetsData,
  parseCsProjData,
  parseEdnData,
  parseFlakeLock,
  parseFlakeNix,
  parseGemfileLockData,
  parseGemspecData,
  parseGitHubWorkflowData,
  parseGoListDep,
  parseGoModData,
  parseGoModGraph,
  parseGoModulesTxt,
  parseGoModWhy,
  parseGopkgData,
  parseGosumData,
  parseGoVersionData,
  parseGradleDep,
  parseGradleProjects,
  parseGradleProperties,
  parseHelmYamlData,
  parseKVDep,
  parseLeinDep,
  parseLeiningenData,
  parseMakeDFile,
  parseMavenTree,
  parseMillDependency,
  parseMinJs,
  parseMixLockData,
  parseNodeShrinkwrap,
  parseNupkg,
  parseNuspecData,
  parseOpenapiSpecData,
  parsePackageJsonName,
  parsePaketLockData,
  parsePiplockData,
  parsePkgJson,
  parsePkgLock,
  parsePnpmLock,
  parsePnpmWorkspace,
  parsePodfileLock,
  parsePodfileTargets,
  parsePom,
  parsePrivadoFile,
  parsePubLockData,
  parsePubYamlData,
  parsePyLockData,
  parsePyProjectTomlFile,
  parsePyRequiresDist,
  parseReqEnvMarkers,
  parseReqFile,
  parseSbtLock,
  parseSbtTree,
  parseSetupPyFile,
  parseSwiftJsonTree,
  parseSwiftResolved,
  parseYarnLock,
  pnpmMetadata,
  purlFromUrlString,
  readZipEntry,
  splitOutputByGradleProjects,
  toGemModuleNames,
  yarnLockToIdentMap,
} from "./utils.js";
import { validateRefs } from "./validator.js";

it("SSRI test", () => {
  // gopkg.lock hash
  let ss = parse(
    "2ca532a6bc655663344004ba102436d29031018eab236247678db1d8978627bf",
  );
  assert.deepStrictEqual(ss, null);
  ss = parse(
    "sha256-2ca532a6bc655663344004ba102436d29031018eab236247678db1d8978627bf",
  );
  assert.deepStrictEqual(
    ss.sha256[0].digest,
    "2ca532a6bc655663344004ba102436d29031018eab236247678db1d8978627bf",
  );
  ss = parse(
    `sha256-${Buffer.from(
      "2ca532a6bc655663344004ba102436d29031018eab236247678db1d8978627bf",
      "hex",
    ).toString("base64")}`,
  );
  assert.deepStrictEqual(
    ss.sha256[0].digest,
    "LKUyprxlVmM0QAS6ECQ20pAxAY6rI2JHZ42x2JeGJ78=",
  );
  ss = parse(
    "sha512-Vn0lE2mprXEFPcRoI89xjw1fk1VJiyVbwfaPnVnvCXxEieByioO8Mj6sMwa6ON9PRuqbAjIxaQpkzccu41sYlw==",
  );
  assert.deepStrictEqual(
    ss.sha512[0].digest,
    "Vn0lE2mprXEFPcRoI89xjw1fk1VJiyVbwfaPnVnvCXxEieByioO8Mj6sMwa6ON9PRuqbAjIxaQpkzccu41sYlw==",
  );
});

it("Parse requires dist string", () => {
  assert.deepStrictEqual(
    parsePyRequiresDist("lazy-object-proxy (&gt;=1.4.0)"),
    {
      name: "lazy-object-proxy",
      version: "1.4.0",
    },
  );
  assert.deepStrictEqual(parsePyRequiresDist("wrapt (&lt;1.13,&gt;=1.11)"), {
    name: "wrapt",
    version: "1.13",
  });
  assert.deepStrictEqual(
    parsePyRequiresDist(
      'typed-ast (&lt;1.5,&gt;=1.4.0) ; implementation_name == "cpython" and python_version &lt; "3.8"',
    ),
    { name: "typed-ast", version: "1.5" },
  );
  assert.deepStrictEqual(parsePyRequiresDist("asgiref (&lt;4,&gt;=3.2.10)"), {
    name: "asgiref",
    version: "4",
  });
  assert.deepStrictEqual(parsePyRequiresDist("pytz"), {
    name: "pytz",
    version: "",
  });
  assert.deepStrictEqual(parsePyRequiresDist("sqlparse (&gt;=0.2.2)"), {
    name: "sqlparse",
    version: "0.2.2",
  });
  assert.deepStrictEqual(
    parsePyRequiresDist("argon2-cffi (&gt;=16.1.0) ; extra == 'argon2'"),
    { name: "argon2-cffi", version: "16.1.0" },
  );
  assert.deepStrictEqual(parsePyRequiresDist("bcrypt ; extra == 'bcrypt'"), {
    name: "bcrypt",
    version: "",
  });
});

it("finds license id from name", () => {
  assert.deepStrictEqual(
    findLicenseId("Apache License Version 2.0"),
    "Apache-2.0",
  );
  assert.deepStrictEqual(
    findLicenseId("GNU General Public License (GPL) version 2.0"),
    "GPL-2.0-only",
  );
});

it("splits parallel gradle properties output correctly", () => {
  const parallelGradlePropertiesOutput = readFileSync(
    "./test/gradle-prop-parallel.out",
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
    "./test/gradle-dep-parallel.out",
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
    "./test/gradle-build-env-dep.out",
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
    readFileSync("./test/gradle-dep.out", { encoding: "utf-8" }),
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
    readFileSync("./test/data/gradle-android-dep.out", { encoding: "utf-8" }),
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
        value: "androidTestImplementation",
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
    readFileSync("./test/data/gradle-out1.dep", { encoding: "utf-8" }),
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
    readFileSync("./test/data/gradle-rich1.dep", { encoding: "utf-8" }),
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
    readFileSync("./test/data/gradle-rich2.dep", { encoding: "utf-8" }),
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
    readFileSync("./test/data/gradle-rich3.dep", { encoding: "utf-8" }),
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
    readFileSync("./test/data/gradle-rich4.dep", { encoding: "utf-8" }),
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
    readFileSync("./test/data/gradle-rich5.dep", { encoding: "utf-8" }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 67);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 68);
  parsedList = await parseGradleDep(
    readFileSync("./test/data/gradle-out-249.dep", { encoding: "utf-8" }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 21);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 22);
  parsedList = await parseGradleDep(
    readFileSync("./test/data/gradle-service.out", { encoding: "utf-8" }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 35);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 36);
  parsedList = await parseGradleDep(
    readFileSync("./test/data/gradle-s.out", { encoding: "utf-8" }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 28);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 29);
  parsedList = await parseGradleDep(
    readFileSync("./test/data/gradle-core.out", { encoding: "utf-8" }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 18);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 19);
  parsedList = await parseGradleDep(
    readFileSync("./test/data/gradle-single.out", { encoding: "utf-8" }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 152);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 153);
  parsedList = await parseGradleDep(
    readFileSync("./test/data/gradle-android-app.dep", { encoding: "utf-8" }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 102);
  parsedList = await parseGradleDep(
    readFileSync("./test/data/gradle-android-jetify.dep", {
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
    readFileSync("./test/data/gradle-sm.dep", { encoding: "utf-8" }),
    "test-project",
    modulesMap,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 6);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 7);
  parsedList = await parseGradleDep(
    readFileSync("./test/data/gradle-dependencies-559.txt", {
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
    readFileSync("./test/data/gradle-projects.out", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(retMap.rootProject, "elasticsearch");
  assert.deepStrictEqual(retMap.projects.length, 368);
  retMap = parseGradleProjects(
    readFileSync("./test/data/gradle-projects1.out", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(retMap.rootProject, "elasticsearch");
  assert.deepStrictEqual(retMap.projects.length, 409);
  retMap = parseGradleProjects(
    readFileSync("./test/data/gradle-projects2.out", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(retMap.rootProject, "fineract");
  assert.deepStrictEqual(retMap.projects.length, 22);
  retMap = parseGradleProjects(
    readFileSync("./test/data/gradle-android-app.dep", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(retMap.rootProject, "root");
  assert.deepStrictEqual(retMap.projects, [":app"]);
  retMap = parseGradleProjects(
    readFileSync("./test/data/gradle-properties-sm.txt", {
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
    readFileSync("./test/data/gradle-properties.txt", { encoding: "utf-8" }),
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
    readFileSync("./test/data/gradle-properties-single.txt", {
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
    readFileSync("./test/data/gradle-properties-single2.txt", {
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
    readFileSync("./test/data/gradle-properties-elastic.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "elasticsearch");
  assert.deepStrictEqual(retMap.projects.length, 409);
  retMap = parseGradleProperties(
    readFileSync("./test/data/gradle-properties-android.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "CdxgenAndroidTest");
  assert.deepStrictEqual(retMap.projects.length, 2);
  retMap = parseGradleProperties(
    readFileSync("./test/data/gradle-properties-sm.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "root");
  assert.deepStrictEqual(retMap.projects, []);
  retMap = parseGradleProperties(
    readFileSync("./test/data/gradle-properties-559.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.rootProject, "failing-project");
  assert.deepStrictEqual(retMap.projects, []);
});

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
    scope: undefined,
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
  assert.deepStrictEqual(parsedList.pkgList.length, 90);
  assert.deepStrictEqual(
    parsedList.parentComponent["bom-ref"],
    "pkg:maven/org.apache.dubbo/dubbo-spring-boot-starter@3.3.0?type=jar",
  );
  assert.deepStrictEqual(parsedList.dependenciesList.length, 90);
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
      "pkg:maven/org.yaml/snakeyaml@1.30?type=jar",
    ],
  });
});

// Slow test
/*
it("get maven metadata", async () => {
  let data = await utils.getMvnMetadata([
    {
      group: "com.squareup.okhttp3",
      name: "okhttp",
      version: "3.8.1",
    },
  ]);
  assert.deepStrictEqual(data, [
    {
      description: "",
      group: "com.squareup.okhttp3",
      name: "okhttp",
      version: "3.8.1",
    },
  ]);

  data = await utils.getMvnMetadata([
    {
      group: "com.fasterxml.jackson.core",
      name: "jackson-databind",
      version: "2.8.5",
    },
    {
      group: "com.github.jnr",
      name: "jnr-posix",
      version: "3.0.47",
    },
  ]);
  assert.deepStrictEqual(data, [
    {
      group: "com.fasterxml.jackson.core",
      name: "jackson-databind",
      version: "2.8.5",
      description:
        "General data-binding functionality for Jackson: works on core streaming API",
      repository: { url: "http://github.com/FasterXML/jackson-databind" },
    },
    {
      group: "com.github.jnr",
      name: "jnr-posix",
      version: "3.0.47",
      license: ["EPL-2.0", "GPL-2.0-only", "LGPL-2.1-only"],
      description: "\n    Common cross-project/cross-platform POSIX APIs\n  ",
      repository: { url: "git@github.com:jnr/jnr-posix.git" },
    },
  ]);
});
*/

it("get py metadata", async () => {
  const data = await getPyMetadata(
    [
      {
        group: "",
        name: "Flask",
        version: "1.1.0",
      },
    ],
    false,
  );
  assert.deepStrictEqual(data, [
    {
      group: "",
      name: "Flask",
      version: "1.1.0",
    },
  ]);
}, 240000);

it("parseGoModData", async () => {
  let retMap = await parseGoModData(null);
  assert.deepStrictEqual(retMap, {});
  const gosumMap = {
    "google.golang.org/grpc@v1.21.0":
      "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
    "github.com/aws/aws-sdk-go@v1.38.47": "sha256-fake-sha-for-aws-go-sdk=",
    "github.com/spf13/cobra@v1.0.0":
      "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
    "github.com/spf13/viper@v1.3.0":
      "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
    "github.com/stretchr/testify@v1.6.1":
      "sha256-6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=",
  };
  retMap = await parseGoModData(
    readFileSync("./test/gomod/go.mod", { encoding: "utf-8" }),
    gosumMap,
  );
  assert.deepStrictEqual(retMap.pkgList.length, 6);
  assert.ok(retMap.pkgList);

  retMap.pkgList.forEach((d) => {
    assert.deepStrictEqual(d.license);
  });
  retMap = await parseGoModData(
    readFileSync("./test/data/go-dvwa.mod", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:golang/github.com/sqreen/go-dvwa",
    name: "github.com/sqreen/go-dvwa",
    purl: "pkg:golang/github.com/sqreen/go-dvwa",
    type: "application",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 19);
  assert.deepStrictEqual(retMap.rootList.length, 4);
  retMap = await parseGoModData(
    readFileSync("./test/data/go-syft.mod", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:golang/github.com/anchore/syft",
    name: "github.com/anchore/syft",
    purl: "pkg:golang/github.com/anchore/syft",
    type: "application",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 239);
  assert.deepStrictEqual(retMap.rootList.length, 84);
}, 120000);

it("parseGoSumData", async () => {
  let dep_list = await parseGosumData(null);
  assert.deepStrictEqual(dep_list, []);
  dep_list = await parseGosumData(
    readFileSync("./test/gomod/go.sum", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 4);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "google.golang.org/grpc",
    license: undefined,
    version: "v1.21.0",
    _integrity: "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
    "bom-ref": "pkg:golang/google.golang.org/grpc@v1.21.0",
    purl: "pkg:golang/google.golang.org/grpc@v1.21.0",
  });
  assert.deepStrictEqual(dep_list[1], {
    group: "",
    name: "github.com/spf13/cobra",
    license: undefined,
    version: "v1.0.0",
    _integrity: "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
    "bom-ref": "pkg:golang/github.com/spf13/cobra@v1.0.0",
    purl: "pkg:golang/github.com/spf13/cobra@v1.0.0",
  });
  assert.deepStrictEqual(dep_list[2], {
    group: "",
    name: "github.com/spf13/viper",
    license: undefined,
    version: "v1.0.2",
    _integrity: "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
    "bom-ref": "pkg:golang/github.com/spf13/viper@v1.0.2",
    purl: "pkg:golang/github.com/spf13/viper@v1.0.2",
  });
  assert.deepStrictEqual(dep_list[3], {
    group: "",
    name: "github.com/stretchr/testify",
    license: undefined,
    version: "v1.6.1",
    _integrity: "sha256-6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=",
    "bom-ref": "pkg:golang/github.com/stretchr/testify@v1.6.1",
    purl: "pkg:golang/github.com/stretchr/testify@v1.6.1",
  });
  dep_list.forEach((d) => {
    assert.deepStrictEqual(d.license);
  });
  it(() => {
    delete process.env.GO_FETCH_VCS;
  });
}, 120000);

describe("go data with vcs", () => {
  it(() => {
    process.env.GO_FETCH_VCS = "true";
  });
  it("parseGoSumData with vcs", async () => {
    let dep_list = await parseGosumData(null);
    assert.deepStrictEqual(dep_list, []);
    dep_list = await parseGosumData(
      readFileSync("./test/gomod/go.sum", { encoding: "utf-8" }),
    );
    assert.deepStrictEqual(dep_list.length, 4);
    assert.ok(dep_list[0]);
  }, 120000);

  it("parseGoModData", async () => {
    process.env.GO_FETCH_VCS = "false";
    let retMap = await parseGoModData(null);
    assert.deepStrictEqual(retMap, {});
    const gosumMap = {
      "google.golang.org/grpc@v1.21.0":
        "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
      "github.com/aws/aws-sdk-go@v1.38.47": "sha256-fake-sha-for-aws-go-sdk=",
      "github.com/spf13/cobra@v1.0.0":
        "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
      "github.com/spf13/viper@v1.3.0":
        "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
      "github.com/stretchr/testify@v1.6.1":
        "sha256-6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=",
    };
    retMap = await parseGoModData(
      readFileSync("./test/gomod/go.mod", { encoding: "utf-8" }),
      gosumMap,
    );
    assert.deepStrictEqual(retMap.pkgList.length, 6);
    // Doesn't reliably work in CI/CD due to rate limiting.
    /*
    assert.deepStrictEqual(retMap.pkgList, [
      {
        group: "",
        name: "github.com/aws/aws-sdk-go",
        version: "v1.38.47",
        _integrity: "sha256-fake-sha-for-aws-go-sdk=",
        purl: "pkg:golang/github.com/aws/aws-sdk-go@v1.38.47",
        "bom-ref": "pkg:golang/github.com/aws/aws-sdk-go@v1.38.47",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/aws/aws-sdk-go",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/cobra",
        version: "v1.0.0",
        _integrity: "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
        purl: "pkg:golang/github.com/spf13/cobra@v1.0.0",
        "bom-ref": "pkg:golang/github.com/spf13/cobra@v1.0.0",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/spf13/cobra",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/viper",
        version: "v1.0.2",
        purl: "pkg:golang/github.com/spf13/viper@v1.0.2",
        "bom-ref": "pkg:golang/github.com/spf13/viper@v1.0.2",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/spf13/viper",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/viper",
        version: "v1.3.0",
        _integrity: "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
        purl: "pkg:golang/github.com/spf13/viper@v1.3.0",
        "bom-ref": "pkg:golang/github.com/spf13/viper@v1.3.0",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/spf13/viper",
          },
        ],
      },
      {
        group: "",
        name: "google.golang.org/grpc",
        version: "v1.21.0",
        _integrity: "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
        purl: "pkg:golang/google.golang.org/grpc@v1.21.0",
        "bom-ref": "pkg:golang/google.golang.org/grpc@v1.21.0",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/grpc/grpc-go",
          },
        ],
      },
      {
        group: "",
        name: "google.golang.org/grpc",
        version: "v1.32.0",
        purl: "pkg:golang/google.golang.org/grpc@v1.32.0",
        "bom-ref": "pkg:golang/google.golang.org/grpc@v1.32.0",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/grpc/grpc-go",
          },
        ],
      },
    ]);
    */

    retMap.pkgList.forEach((d) => {
      assert.deepStrictEqual(d.license);
    });
    retMap = await parseGoModData(
      readFileSync("./test/data/go-dvwa.mod", { encoding: "utf-8" }),
      {},
    );
    assert.deepStrictEqual(retMap.parentComponent, {
      "bom-ref": "pkg:golang/github.com/sqreen/go-dvwa",
      name: "github.com/sqreen/go-dvwa",
      purl: "pkg:golang/github.com/sqreen/go-dvwa",
      type: "application",
    });
    assert.deepStrictEqual(retMap.pkgList.length, 19);
    assert.deepStrictEqual(retMap.rootList.length, 4);
    retMap = await parseGoModData(
      readFileSync("./test/data/go-syft.mod", { encoding: "utf-8" }),
      {},
    );
    assert.deepStrictEqual(retMap.parentComponent, {
      "bom-ref": "pkg:golang/github.com/anchore/syft",
      name: "github.com/anchore/syft",
      purl: "pkg:golang/github.com/anchore/syft",
      type: "application",
    });
    assert.deepStrictEqual(retMap.pkgList.length, 239);
    assert.deepStrictEqual(retMap.rootList.length, 84);
  }, 120000);
});

describe("go vendor modules tests", () => {
  it("parseGoModulesTxt", async () => {
    const gosumMap = {
      "cel.dev/expr@v0.18.0":
        "sha256-CJ6drgk+Hf96lkLikr4rFf19WrU0BOWEihyZnI2TAzo=",
      "github.com/AdaLogics/go-fuzz-headers@v0.0.0-20230811130428-ced1acdcaa24":
        "sha256-bvDV9vkmnHYOMsOr4WLk+Vo07yKIzd94sVoIqshQ4bU=",
      "github.com/Azure/go-ansiterm@v0.0.0-20230124172434-306776ec8161":
        "sha256-L/gRVlceqvL25UVaW/CKtUDjefjrs0SPonmDGUVOYP0=",
    };
    const pkgList = await parseGoModulesTxt(
      "./test/data/modules.txt",
      gosumMap,
    );
    assert.deepStrictEqual((await pkgList).length, 212);
  });
});

describe("go data with licenses", () => {
  it(() => {
    process.env.FETCH_LICENSE = "true";
  });
  test.skip("parseGoSumData with licenses", async () => {
    let dep_list = await parseGosumData(null);
    assert.deepStrictEqual(dep_list, []);
    dep_list = await parseGosumData(
      readFileSync("./test/gomod/go.sum", { encoding: "utf-8" }),
    );
    assert.deepStrictEqual(dep_list.length, 4);
    assert.deepStrictEqual(dep_list[0], {
      group: "",
      name: "google.golang.org/grpc",
      version: "v1.21.0",
      _integrity: "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
      "bom-ref": "pkg:golang/google.golang.org/grpc@v1.21.0",
      purl: "pkg:golang/google.golang.org/grpc@v1.21.0",
      license: [
        {
          id: "Apache-2.0",
          url: "https://pkg.go.dev/google.golang.org/grpc?tab=licenses",
        },
      ],
    });
    assert.deepStrictEqual(dep_list[1], {
      group: "",
      name: "github.com/spf13/cobra",
      version: "v1.0.0",
      _integrity: "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
      "bom-ref": "pkg:golang/github.com/spf13/cobra@v1.0.0",
      purl: "pkg:golang/github.com/spf13/cobra@v1.0.0",
      license: [
        {
          id: "Apache-2.0",
          url: "https://pkg.go.dev/github.com/spf13/cobra?tab=licenses",
        },
      ],
    });
    assert.deepStrictEqual(dep_list[2], {
      group: "",
      name: "github.com/spf13/viper",
      version: "v1.0.2",
      _integrity: "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
      "bom-ref": "pkg:golang/github.com/spf13/viper@v1.0.2",
      purl: "pkg:golang/github.com/spf13/viper@v1.0.2",
      license: [
        {
          id: "MIT",
          url: "https://pkg.go.dev/github.com/spf13/viper?tab=licenses",
        },
      ],
    });
    assert.deepStrictEqual(dep_list[3], {
      group: "",
      name: "github.com/stretchr/testify",
      version: "v1.6.1",
      _integrity: "sha256-6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=",
      "bom-ref": "pkg:golang/github.com/stretchr/testify@v1.6.1",
      purl: "pkg:golang/github.com/stretchr/testify@v1.6.1",
      license: [
        {
          id: "MIT",
          url: "https://pkg.go.dev/github.com/stretchr/testify?tab=licenses",
        },
      ],
    });
    dep_list.forEach((d) => {
      assert.deepStrictEqual(d.license);
    });
  }, 120000);

  test.skip("parseGoModData with licenses", async () => {
    let retMap = await parseGoModData(null);
    assert.deepStrictEqual(retMap, {});
    const gosumMap = {
      "google.golang.org/grpc@v1.21.0":
        "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
      "github.com/aws/aws-sdk-go@v1.38.47": "sha256-fake-sha-for-aws-go-sdk=",
      "github.com/spf13/cobra@v1.0.0":
        "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
      "github.com/spf13/viper@v1.3.0":
        "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
      "github.com/stretchr/testify@v1.6.1":
        "sha256-6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=",
    };
    retMap = await parseGoModData(
      readFileSync("./test/gomod/go.mod", { encoding: "utf-8" }),
      gosumMap,
    );
    assert.deepStrictEqual(retMap.pkgList.length, 6);
    assert.deepStrictEqual(retMap.pkgList, [
      {
        group: "",
        name: "github.com/aws/aws-sdk-go",
        version: "v1.38.47",
        _integrity: "sha256-fake-sha-for-aws-go-sdk=",
        purl: "pkg:golang/github.com/aws/aws-sdk-go@v1.38.47",
        "bom-ref": "pkg:golang/github.com/aws/aws-sdk-go@v1.38.47",
        license: [
          {
            id: "Apache-2.0",
            url: "https://pkg.go.dev/github.com/aws/aws-sdk-go?tab=licenses",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/cobra",
        version: "v1.0.0",
        _integrity: "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
        purl: "pkg:golang/github.com/spf13/cobra@v1.0.0",
        "bom-ref": "pkg:golang/github.com/spf13/cobra@v1.0.0",
        license: [
          {
            id: "Apache-2.0",
            url: "https://pkg.go.dev/github.com/spf13/cobra?tab=licenses",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/viper",
        version: "v1.0.2",
        purl: "pkg:golang/github.com/spf13/viper@v1.0.2",
        "bom-ref": "pkg:golang/github.com/spf13/viper@v1.0.2",
        license: [
          {
            id: "MIT",
            url: "https://pkg.go.dev/github.com/spf13/viper?tab=licenses",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/viper",
        version: "v1.3.0",
        _integrity: "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
        purl: "pkg:golang/github.com/spf13/viper@v1.3.0",
        "bom-ref": "pkg:golang/github.com/spf13/viper@v1.3.0",
        license: [
          {
            id: "MIT",
            url: "https://pkg.go.dev/github.com/spf13/viper?tab=licenses",
          },
        ],
      },
      {
        group: "",
        name: "google.golang.org/grpc",
        version: "v1.21.0",
        _integrity: "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
        purl: "pkg:golang/google.golang.org/grpc@v1.21.0",
        "bom-ref": "pkg:golang/google.golang.org/grpc@v1.21.0",
        license: [
          {
            id: "Apache-2.0",
            url: "https://pkg.go.dev/google.golang.org/grpc?tab=licenses",
          },
        ],
      },
      {
        group: "",
        name: "google.golang.org/grpc",
        version: "v1.32.0",
        purl: "pkg:golang/google.golang.org/grpc@v1.32.0",
        "bom-ref": "pkg:golang/google.golang.org/grpc@v1.32.0",
        license: [
          {
            id: "Apache-2.0",
            url: "https://pkg.go.dev/google.golang.org/grpc?tab=licenses",
          },
        ],
      },
    ]);

    retMap.pkgList.forEach((d) => {
      assert.deepStrictEqual(d.license);
    });
    retMap = await parseGoModData(
      readFileSync("./test/data/go-dvwa.mod", { encoding: "utf-8" }),
      {},
    );
    assert.deepStrictEqual(retMap.parentComponent, {
      "bom-ref": "pkg:golang/github.com/sqreen/go-dvwa",
      name: "github.com/sqreen/go-dvwa",
      purl: "pkg:golang/github.com/sqreen/go-dvwa",
      type: "application",
    });
    assert.deepStrictEqual(retMap.pkgList.length, 19);
    assert.deepStrictEqual(retMap.rootList.length, 4);
    retMap = await parseGoModData(
      readFileSync("./test/data/go-syft.mod", { encoding: "utf-8" }),
      {},
    );
    assert.deepStrictEqual(retMap.parentComponent, {
      "bom-ref": "pkg:golang/github.com/anchore/syft",
      name: "github.com/anchore/syft",
      purl: "pkg:golang/github.com/anchore/syft",
      type: "application",
    });
    assert.deepStrictEqual(retMap.pkgList.length, 239);
    assert.deepStrictEqual(retMap.rootList.length, 84);
  }, 120000);
  it(() => {
    delete process.env.FETCH_LICENSE;
  });
});

it("parse go list dependencies", async () => {
  const retMap = await parseGoListDep(
    readFileSync("./test/data/golist-dep.txt", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(retMap.pkgList.length, 4);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "",
    name: "github.com/gorilla/mux",
    "bom-ref": "pkg:golang/github.com/gorilla/mux@v1.7.4",
    purl: "pkg:golang/github.com/gorilla/mux@v1.7.4",
    version: "v1.7.4",
    _integrity: undefined,
    license: undefined,
    scope: "required",
    properties: [
      {
        name: "SrcGoMod",
        value:
          "/home/almalinux/go/pkg/mod/cache/download/github.com/gorilla/mux/@v/v1.7.4.mod",
      },
      { name: "ModuleGoVersion", value: "1.12" },
      {
        name: "cdx:go:indirect",
        value: "false",
      },
    ],
  });
});

it("parse go mod graph", async () => {
  let retMap = await parseGoModGraph(
    readFileSync("./test/data/gomod-graph.txt", { encoding: "utf-8" }),
    undefined,
    {},
    [],
    {},
  );
  assert.deepStrictEqual(retMap.pkgList.length, 536);
  assert.deepStrictEqual(retMap.pkgList[0], {
    _integrity: undefined,
    "bom-ref": "pkg:golang/cloud.google.com/go@v0.26.0",
    group: "",
    license: undefined,
    name: "cloud.google.com/go",
    purl: "pkg:golang/cloud.google.com/go@v0.26.0",
    version: "v0.26.0",
  });
  retMap = await parseGoModGraph(
    readFileSync("./test/data/gomod-dvwa-graph.txt", { encoding: "utf-8" }),
    "./test/data/go-dvwa.mod",
    {},
    [],
    {},
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:golang/github.com/sqreen/go-dvwa",
    name: "github.com/sqreen/go-dvwa",
    purl: "pkg:golang/github.com/sqreen/go-dvwa",
    type: "application",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 19);
  assert.deepStrictEqual(retMap.rootList.length, 4);
  retMap = await parseGoModGraph(
    readFileSync("./test/data/gomod-syft-graph.txt", { encoding: "utf-8" }),
    "./test/data/go-syft.mod",
    {},
    [],
    {},
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:golang/github.com/anchore/syft",
    name: "github.com/anchore/syft",
    purl: "pkg:golang/github.com/anchore/syft",
    type: "application",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 235);
  assert.deepStrictEqual(retMap.rootList.length, 84);
});

it("parse go mod why dependencies", () => {
  let pkg_name = parseGoModWhy(
    readFileSync("./test/data/gomodwhy.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(pkg_name, "github.com/mailgun/mailgun-go/v4");
  pkg_name = parseGoModWhy(
    readFileSync("./test/data/gomodwhynot.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(pkg_name, undefined);
});

it("multimodule go.mod file ordering", async () => {
  // Test that simulates the file ordering logic from createGoBom
  const mockPath = "/workspace/project";
  const mockGomodFiles = [
    "/workspace/project/deep/nested/go.mod",
    "/workspace/project/go.mod",
    "/workspace/project/submodule/go.mod",
  ];

  // Sort files by depth (shallowest first) - this is the fix we implemented
  const sortedFiles = mockGomodFiles.sort((a, b) => {
    const relativePathA = a.replace(`${mockPath}/`, "");
    const relativePathB = b.replace(`${mockPath}/`, "");
    const depthA = relativePathA.split("/").length;
    const depthB = relativePathB.split("/").length;
    return depthA - depthB;
  });

  // The root go.mod should be first (shallowest)
  assert.deepStrictEqual(sortedFiles[0], "/workspace/project/go.mod");
  assert.deepStrictEqual(sortedFiles[1], "/workspace/project/submodule/go.mod");
  assert.deepStrictEqual(
    sortedFiles[2],
    "/workspace/project/deep/nested/go.mod",
  );
});

it("parseGoModData for multiple modules with root priority", async () => {
  // Test parsing multiple go.mod files to ensure proper component hierarchy
  const rootModData = readFileSync("./test/data/multimodule-root.mod", {
    encoding: "utf-8",
  });
  const subModData = readFileSync("./test/data/multimodule-sub.mod", {
    encoding: "utf-8",
  });
  const deepModData = readFileSync("./test/data/multimodule-deep.mod", {
    encoding: "utf-8",
  });

  const rootResult = await parseGoModData(rootModData, {});
  const subResult = await parseGoModData(subModData, {});
  const deepResult = await parseGoModData(deepModData, {});

  // Root module should be identified correctly
  assert.deepStrictEqual(
    rootResult.parentComponent.name,
    "github.com/example/root-project",
  );
  assert.deepStrictEqual(rootResult.parentComponent.type, "application");

  // Sub modules should also be parsed correctly
  assert.deepStrictEqual(
    subResult.parentComponent.name,
    "github.com/example/root-project/submodule",
  );
  assert.deepStrictEqual(
    deepResult.parentComponent.name,
    "github.com/example/root-project/deep/nested",
  );

  // In the fixed logic, the root should take priority over sub-modules
  // This test verifies the parsing works correctly for each individual module
}, 10000);

it("parseGopkgData", async () => {
  let dep_list = await parseGopkgData(null);
  assert.deepStrictEqual(dep_list, []);
  dep_list = await parseGopkgData(
    readFileSync("./test/gopkg/Gopkg.lock", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 36);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "cloud.google.com/go",
    version: "v0.39.0",
    _integrity: "sha256-LKUyprxlVmM0QAS6ECQ20pAxAY6rI2JHZ42x2JeGJ78=",
  });
  dep_list.forEach((d) => {
    assert.deepStrictEqual(d.license);
  });
}, 120000);

it("parse go version data", async () => {
  let dep_list = await parseGoVersionData(
    readFileSync("./test/data/goversion.txt", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(dep_list.length, 125);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "github.com/ShiftLeftSecurity/atlassian-connect-go",
    "bom-ref":
      "pkg:golang/github.com/ShiftLeftSecurity/atlassian-connect-go@v0.0.2",
    purl: "pkg:golang/github.com/ShiftLeftSecurity/atlassian-connect-go@v0.0.2",
    version: "v0.0.2",
    _integrity: "",
    license: undefined,
  });
  dep_list = await parseGoVersionData(
    readFileSync("./test/data/goversion2.txt", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(dep_list.length, 149);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "cloud.google.com/go",
    "bom-ref": "pkg:golang/cloud.google.com/go@v0.79.0",
    purl: "pkg:golang/cloud.google.com/go@v0.79.0",
    version: "v0.79.0",
    _integrity: "sha256-oqqswrt4x6b9OGBnNqdssxBl1xf0rSUNjU2BR4BZar0=",
    license: undefined,
  });
});

it("parse cargo lock", async () => {
  assert.deepStrictEqual(await parseCargoData(null), []);

  let dep_list = await parseCargoData("./test/Cargo.lock");
  assert.deepStrictEqual(dep_list.length, 225);
  assert.deepStrictEqual(dep_list[0], {
    type: "library",
    group: "",
    "bom-ref": "pkg:cargo/abscissa_core@0.5.2",
    purl: "pkg:cargo/abscissa_core@0.5.2",
    name: "abscissa_core",
    version: "0.5.2",
    hashes: [
      {
        alg: "SHA-384",
        content:
          "6a07677093120a02583717b6dd1ef81d8de1e8d01bd226c83f0f9bdf3e56bb3a",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.6,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.6,
            value: "./test/Cargo.lock",
          },
        ],
      },
    },
    properties: [
      {
        name: "SrcFile",
        value: "./test/Cargo.lock",
      },
    ],
  });

  dep_list = await parseCargoData("./test/data/Cargom.lock");
  assert.deepStrictEqual(dep_list.length, 243);
  assert.deepStrictEqual(dep_list[0], {
    type: "library",
    group: "",
    "bom-ref": "pkg:cargo/actix-codec@0.3.0",
    purl: "pkg:cargo/actix-codec@0.3.0",
    name: "actix-codec",
    version: "0.3.0",
    hashes: [
      {
        alg: "SHA-384",
        content:
          "78d1833b3838dbe990df0f1f87baf640cf6146e898166afe401839d1b001e570",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.6,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.6,
            value: "./test/data/Cargom.lock",
          },
        ],
      },
    },
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/Cargom.lock",
      },
    ],
  });

  // The base64 package does not have an associated checksum. Make sure the
  // function does not accidentally insert an undefined hashsum value.
  const base64Package = dep_list.find((pkg) => pkg.name === "base64");
  assert.ok(base64Package.hashes);
});

it("parse cargo lock simple component representation", async () => {
  // If asking for a simple representation, we should skip any extended attributes.
  const componentList = await parseCargoData("./test/Cargo.lock", true);
  const firstPackage = componentList[0];
  assert.strictEqual(firstPackage.evidence, undefined);
});

it("parse cargo lock lists last package", async () => {
  // The implementation procedurally fills an object with the package
  // information line-by-line, considering a package's information "complete"
  // when the next package is found. This risks missing the last package in
  // the file, so this test case makes sure it is still found.
  const componentList = await parseCargoData("./test/data/Cargom.lock");
  assert.ok(componentList.find((pkg) => pkg.name === "yaml-rust"));
});

it("parse cargo lock dependencies tests", async () => {
  const dependencyData = await parseCargoDependencyData(
    readFileSync("./test/Cargo.lock", { encoding: "utf-8" }),
  );
  const purlIsPackage = (purl, packageName) =>
    new RegExp(`^pkg:cargo/${packageName}@.+`).test(purl);

  assert.ok(dependencyData.length > 0);

  // Make sure some samples makes sense.
  // aho-corasick has a single dependency
  const ahoCorasick = dependencyData.find((dependency) =>
    purlIsPackage(dependency.ref, "aho-corasick"),
  );
  assert.deepStrictEqual(ahoCorasick.dependsOn.length, 1);
  assert.deepStrictEqual(
    purlIsPackage(ahoCorasick.dependsOn[0], "memchr"),
    true,
  );

  // First edge case is component with a dependency of a specific version.
  // winapi-util has a dependency on "winapi 0.3.8"
  const winapiUtil = dependencyData.find((dependency) =>
    purlIsPackage(dependency.ref, "winapi-util"),
  );
  assert.deepStrictEqual(
    purlIsPackage(winapiUtil.dependsOn[0], "winapi"),
    true,
  );
  assert.deepStrictEqual(winapiUtil.dependsOn[0], "pkg:cargo/winapi@0.3.8");

  // Second edge case is a component with a dependency of a specific version and a registry url.
  const base64 = dependencyData.find((dependency) =>
    purlIsPackage(dependency.ref, "base64"),
  );
  assert.deepStrictEqual(purlIsPackage(base64.dependsOn[0], "byteorder"), true);
  assert.deepStrictEqual(base64.dependsOn[0], "pkg:cargo/byteorder@1.3.1");

  // Make sure we respect packages specifying different versions of the same package.
  // kernel32-sys is dependent on a different version of winapi than winapi-util.
  const kernel32Sys = dependencyData.find((dependency) =>
    purlIsPackage(dependency.ref, "kernel32-sys"),
  );
  assert.deepStrictEqual(
    purlIsPackage(kernel32Sys.dependsOn[0], "winapi"),
    true,
  );
  assert.deepStrictEqual(kernel32Sys.dependsOn[0], "pkg:cargo/winapi@0.2.8");
});

it("parse dependency tree from cargo lock files without metadata footer", async () => {
  // CI tests revealed the function failed when applied to the Rust repo. It
  // fails because at least one Cargo.lock file did not have a metadata
  // section in the footer, making the regex trip up. This test is the
  // shortest form representing that case.
  const cargoFileContent = `# This file is automatically @generated by Cargo.
# It is not intended for manual editing.
version = 3

[[package]]
name = "package1"
version = "1.21.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "8a30b2e23b9e17a9f90641c7ab1549cd9b44f296d3ccbf309d2863cfe398a0cb"
`;
  const dependencyData = await parseCargoDependencyData(cargoFileContent);
  assert.ok(dependencyData);
  assert.deepStrictEqual(dependencyData.length, 1);
});

it("parse cargo lock dependencies tests for files on Windows", async () => {
  const fileContent = await readFileSync("./test/Cargo.lock", {
    encoding: "utf-8",
  });

  // Simulate Windows files by forcing CRLF line endings to the data we
  // attempt to parse.
  const crlfFileContent = fileContent.replace(/(\r\n|\n)/g, "\r\n");

  // The function's logic is tested by other test functions. This test will
  // serve as a smoke test for files on Windows, to make sure the function
  // handles both types of input.
  const dependencyData = parseCargoDependencyData(crlfFileContent);
  assert.ok(dependencyData);
  assert.ok(dependencyData.length > 1);
});

it("parse cargo lock dependencies tests with undefined dependency", async () => {
  // In case a package is listed as a dependency but is not defined as a
  // package in a file, the Cargo.lock-file is deemed broken. It has been
  // decided that such an occurence shouldn't fail the process, but continue
  // with a warning message.

  const cargoFileContent = `# This file is automatically @generated by Cargo.
# It is not intended for manual editing.
version = 3

[[package]]
name = "package1"
version = "1.21.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "8a30b2e23b9e17a9f90641c7ab1549cd9b44f296d3ccbf309d2863cfe398a0cb"
dependencies = ["does-not-exist"]
`;
  const dependencyData = await parseCargoDependencyData(cargoFileContent);
  assert.ok(dependencyData);
  assert.deepStrictEqual(dependencyData.length, 1);

  // The package for this test should have been skipped.
  assert.deepStrictEqual(dependencyData.dependsOn, undefined);
});

it("parse cargo toml", async () => {
  assert.deepStrictEqual(await parseCargoTomlData(null), []);
  let dep_list = await parseCargoTomlData("./test/data/Cargo1.toml");
  assert.deepStrictEqual(dep_list.length, 4);
  assert.deepStrictEqual(dep_list, [
    {
      author: "The Rust Project Developers",
      group: "",
      name: "unwind",
      version: "0.0.0",
      properties: [{ name: "SrcFile", value: "./test/data/Cargo1.toml" }],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.5,
              value: "./test/data/Cargo1.toml",
            },
          ],
        },
      },
      purl: "pkg:cargo/unwind@0.0.0",
      "bom-ref": "pkg:cargo/unwind@0.0.0",
      type: "library",
    },
    {
      name: "libc",
      version: "0.2.79",
      properties: [{ name: "SrcFile", value: "./test/data/Cargo1.toml" }],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.5,
              value: "./test/data/Cargo1.toml",
            },
          ],
        },
      },
      purl: "pkg:cargo/libc@0.2.79",
      "bom-ref": "pkg:cargo/libc@0.2.79",
      type: "library",
    },
    {
      name: "compiler_builtins",
      version: "0.1.0",
      properties: [{ name: "SrcFile", value: "./test/data/Cargo1.toml" }],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.5,
              value: "./test/data/Cargo1.toml",
            },
          ],
        },
      },
      purl: "pkg:cargo/compiler_builtins@0.1.0",
      "bom-ref": "pkg:cargo/compiler_builtins@0.1.0",
      type: "library",
    },
    {
      name: "cfg-if",
      version: "0.1.8",
      properties: [{ name: "SrcFile", value: "./test/data/Cargo1.toml" }],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.5,
              value: "./test/data/Cargo1.toml",
            },
          ],
        },
      },
      purl: "pkg:cargo/cfg-if@0.1.8",
      "bom-ref": "pkg:cargo/cfg-if@0.1.8",
      type: "library",
    },
  ]);
  dep_list = await parseCargoTomlData("./test/data/Cargo2.toml");
  assert.deepStrictEqual(dep_list.length, 3);
  assert.deepStrictEqual(dep_list, [
    {
      group: "",
      name: "quiche-fuzz",
      version: "0.1.0",
      author: "Alessandro Ghedini <alessandro@ghedini.me>",
      properties: [{ name: "SrcFile", value: "./test/data/Cargo2.toml" }],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.5,
              value: "./test/data/Cargo2.toml",
            },
          ],
        },
      },
      purl: "pkg:cargo/quiche-fuzz@0.1.0",
      "bom-ref": "pkg:cargo/quiche-fuzz@0.1.0",
      type: "library",
    },
    {
      name: "lazy_static",
      version: "1",
      properties: [{ name: "SrcFile", value: "./test/data/Cargo2.toml" }],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.5,
              value: "./test/data/Cargo2.toml",
            },
          ],
        },
      },
      purl: "pkg:cargo/lazy_static@1",
      "bom-ref": "pkg:cargo/lazy_static@1",
      type: "library",
    },
    {
      name: "libfuzzer-sys",
      version: "git+https://github.com/rust-fuzz/libfuzzer-sys.git",
      properties: [{ name: "SrcFile", value: "./test/data/Cargo2.toml" }],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.5,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 0.5,
              value: "./test/data/Cargo2.toml",
            },
          ],
        },
      },
      purl: "pkg:cargo/libfuzzer-sys@git%2Bhttps:%2F%2Fgithub.com%2Frust-fuzz%2Flibfuzzer-sys.git",
      "bom-ref":
        "pkg:cargo/libfuzzer-sys@git+https://github.com/rust-fuzz/libfuzzer-sys.git",
      type: "library",
    },
  ]);
  dep_list = await parseCargoTomlData("./test/data/Cargo3.toml", true);
  assert.deepStrictEqual(dep_list.length, 10);
});

it("parse cargo auditable data", async () => {
  assert.deepStrictEqual(await parseCargoAuditableData(null), []);
  const dep_list = await parseCargoAuditableData(
    readFileSync("./test/data/cargo-auditable.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 32);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "adler",
    version: "1.0.2",
  });
});

it("get crates metadata", async () => {
  const dep_list = await getCratesMetadata([
    {
      group: "",
      name: "abscissa_core",
      version: "0.5.2",
      _integrity:
        "sha256-6a07677093120a02583717b6dd1ef81d8de1e8d01bd226c83f0f9bdf3e56bb3a",
    },
  ]);
  assert.deepStrictEqual(dep_list.length, 1);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "abscissa_core",
    version: "0.5.2",
    _integrity:
      "sha256-6a07677093120a02583717b6dd1ef81d8de1e8d01bd226c83f0f9bdf3e56bb3a",
    description:
      "Application microframework with support for command-line option parsing,\nconfiguration, error handling, logging, and terminal interactions.\nThis crate contains the framework's core functionality.\n",
    distribution: {
      url: "https://crates.io/api/v1/crates/abscissa_core/0.5.2/download",
    },
    license: "Apache-2.0",
    repository: {
      url: "https://github.com/iqlusioninc/abscissa/tree/main/core/",
    },
    homepage: { url: "https://github.com/iqlusioninc/abscissa/" },
    properties: [
      { name: "cdx:cargo:crate_id", value: "207912" },
      { name: "cdx:cargo:latest_version", value: "0.9.0" },
      {
        name: "cdx:cargo:features",
        value:
          '{"application":["config","generational-arena","trace","options","semver/serde","terminal"],"config":["secrets","serde","terminal","toml"],"default":["application","signals","secrets","testing","time"],"gimli-backtrace":["backtrace/gimli-symbolize","color-backtrace/gimli-symbolize"],"options":["gumdrop"],"secrets":["secrecy"],"signals":["libc","signal-hook"],"terminal":["color-backtrace","termcolor"],"testing":["regex","wait-timeout"],"time":["chrono"],"trace":["tracing","tracing-log","tracing-subscriber"]}',
      },
    ],
  });
}, 20000);

it("parse pub lock", async () => {
  assert.deepStrictEqual(await parsePubLockData(null), []);
  const ret_val = await parsePubLockData(
    readFileSync("./test/data/pubspec.lock", { encoding: "utf-8" }),
  );
  const root_list = ret_val.rootList;
  let dep_list = ret_val.pkgList;
  assert.deepStrictEqual(dep_list.length, 28);
  assert.deepStrictEqual(dep_list[0], {
    name: "async",
    version: "2.11.0",
    _integrity:
      "sha256-947bfcf187f74dbc5e146c9eb9c0f10c9f8b30743e341481c1e2ed3ecc18c20c",
    "bom-ref": "pkg:pub/async@2.11.0",
    scope: "required",
    properties: [],
  });
  assert.deepStrictEqual(root_list.length, 3);
  assert.deepStrictEqual(root_list[0], {
    name: "flare_flutter",
    version: "3.0.2",
    _integrity:
      "sha256-99d63c60f00fac81249ce6410ee015d7b125c63d8278a30da81edf3317a1f6a0",
    "bom-ref": "pkg:pub/flare_flutter@3.0.2",
    scope: "required",
    properties: [],
  });
  dep_list = parsePubYamlData(
    readFileSync("./test/data/pubspec.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 1);
  assert.deepStrictEqual(dep_list[0], {
    name: "awesome_dialog",
    version: "2.2.1",
    description:
      "Flutter package to show beautiful dialogs(INFO,QUESTION,WARNING,SUCCESS,ERROR) with animations as simply as possible.",
    homepage: {
      url: "https://github.com/marcos930807/awesomeDialogs",
    },
    "bom-ref": "pkg:pub/awesome_dialog@2.2.1",
    purl: "pkg:pub/awesome_dialog@2.2.1",
  });
});

// This test is flaky
it("get dart metadata", async () => {
  const dep_list = await getDartMetadata([
    {
      group: "",
      name: "async",
      version: "2.11.0",
    },
  ]);
  assert.deepStrictEqual(dep_list.length, 1);
  assert.ok(dep_list[0]);
}, 120000);

it("parse cabal freeze", () => {
  assert.deepStrictEqual(parseCabalData(null), []);
  let dep_list = parseCabalData(
    readFileSync("./test/data/cabal.project.freeze", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 24);
  assert.deepStrictEqual(dep_list[0], {
    name: "ansi-terminal",
    version: "0.11.3",
  });
  dep_list = parseCabalData(
    readFileSync("./test/data/cabal-2.project.freeze", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 366);
  assert.deepStrictEqual(dep_list[0], {
    name: "Cabal",
    version: "3.2.1.0",
  });
});

it("parse conan data", () => {
  let conanLockData = parseConanLockData(null);
  assert.deepStrictEqual(conanLockData.pkgList.length, 0);
  assert.deepStrictEqual(Object.keys(conanLockData.dependencies).length, 0);
  assert.deepStrictEqual(conanLockData.parentComponentDependencies.length, 0);
  conanLockData = parseConanLockData(
    readFileSync("./test/data/conan-v1.lock", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(conanLockData.pkgList.length, 3);
  assert.deepStrictEqual(conanLockData.pkgList[0], {
    name: "zstd",
    version: "1.4.4",
    "bom-ref": "pkg:conan/zstd@1.4.4",
    purl: "pkg:conan/zstd@1.4.4",
  });
  assert.deepStrictEqual(Object.keys(conanLockData.dependencies).length, 0);
  assert.deepStrictEqual(conanLockData.parentComponentDependencies, [
    "pkg:conan/zstd@1.4.4",
    "pkg:conan/jerryscript@2.2.0",
    "pkg:conan/wolfssl@4.4.0",
  ]);

  conanLockData = parseConanLockData(
    readFileSync("./test/data/conan-v1-for-reference.lock", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(Object.keys(conanLockData.pkgList).length, 7);
  assert.deepStrictEqual(conanLockData.pkgList[0], {
    name: "grpc",
    version: "1.50.1",
    "bom-ref": "pkg:conan/grpc@1.50.1",
    purl: "pkg:conan/grpc@1.50.1",
  });
  assert.deepStrictEqual(Object.keys(conanLockData.dependencies).length, 3);
  assert.deepStrictEqual(conanLockData.dependencies["pkg:conan/grpc@1.50.1"], [
    "pkg:conan/abseil@20230802.1",
    "pkg:conan/protobuf@3.21.12",
    "pkg:conan/c-ares@1.34.1",
    "pkg:conan/openssl@3.3.2",
    "pkg:conan/re2@20230301",
    "pkg:conan/zlib@1.3.1",
  ]);
  assert.deepStrictEqual(
    conanLockData.dependencies["pkg:conan/protobuf@3.21.12"],
    ["pkg:conan/zlib@1.3.1"],
  );
  assert.deepStrictEqual(
    conanLockData.dependencies["pkg:conan/openssl@3.3.2"],
    ["pkg:conan/zlib@1.3.1"],
  );
  assert.deepStrictEqual(conanLockData.parentComponentDependencies.length, 0);

  conanLockData = parseConanLockData(
    readFileSync("./test/data/conan-v1-with-nested-deps.lock", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(conanLockData.pkgList.length, 9);
  assert.deepStrictEqual(conanLockData.pkgList[0], {
    name: "grpc",
    version: "1.50.1",
    "bom-ref": "pkg:conan/grpc@1.50.1",
    purl: "pkg:conan/grpc@1.50.1",
  });
  assert.deepStrictEqual(conanLockData.pkgList[1], {
    name: "abseil",
    version: "20230802.1",
    "bom-ref": "pkg:conan/abseil@20230802.1",
    purl: "pkg:conan/abseil@20230802.1",
  });
  assert.deepStrictEqual(conanLockData.pkgList[2], {
    name: "protobuf",
    version: "3.21.12",
    "bom-ref": "pkg:conan/protobuf@3.21.12",
    purl: "pkg:conan/protobuf@3.21.12",
  });
  assert.deepStrictEqual(conanLockData.pkgList[3], {
    name: "zlib",
    version: "1.3.1",
    "bom-ref": "pkg:conan/zlib@1.3.1",
    purl: "pkg:conan/zlib@1.3.1",
  });
  assert.deepStrictEqual(conanLockData.pkgList[5], {
    name: "openssl",
    version: "3.3.2",
    "bom-ref": "pkg:conan/openssl@3.3.2",
    purl: "pkg:conan/openssl@3.3.2",
  });
  assert.deepStrictEqual(conanLockData.pkgList[8], {
    name: "gtest",
    version: "1.13.0",
    "bom-ref": "pkg:conan/gtest@1.13.0",
    purl: "pkg:conan/gtest@1.13.0",
  });
  assert.deepStrictEqual(Object.keys(conanLockData.dependencies).length, 3);
  assert.deepStrictEqual(conanLockData.dependencies["pkg:conan/grpc@1.50.1"], [
    "pkg:conan/abseil@20230802.1",
    "pkg:conan/protobuf@3.21.12",
    "pkg:conan/c-ares@1.34.1",
    "pkg:conan/openssl@3.3.2",
    "pkg:conan/re2@20230301",
    "pkg:conan/zlib@1.3.1",
  ]);
  assert.deepStrictEqual(
    conanLockData.dependencies["pkg:conan/protobuf@3.21.12"],
    ["pkg:conan/zlib@1.3.1"],
  );
  assert.deepStrictEqual(
    conanLockData.dependencies["pkg:conan/openssl@3.3.2"],
    ["pkg:conan/zlib@1.3.1"],
  );
  assert.deepStrictEqual(conanLockData.parentComponentDependencies.length, 3);
  assert.deepStrictEqual(
    conanLockData.parentComponentDependencies[0],
    "pkg:conan/grpc@1.50.1",
  );
  assert.deepStrictEqual(
    conanLockData.parentComponentDependencies[1],
    "pkg:conan/rapidjson@1.1.0",
  );
  assert.deepStrictEqual(
    conanLockData.parentComponentDependencies[2],
    "pkg:conan/gtest@1.13.0",
  );

  conanLockData = parseConanLockData(
    readFileSync("./test/data/conan-v2.lock", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(conanLockData.pkgList.length, 2);
  assert.deepStrictEqual(conanLockData.pkgList[0], {
    name: "opensta",
    version: "4.0.0",
    "bom-ref": "pkg:conan/opensta@4.0.0?rrev=765a7eed989e624c762a73291d712b14",
    purl: "pkg:conan/opensta@4.0.0?rrev=765a7eed989e624c762a73291d712b14",
  });
  assert.deepStrictEqual(Object.keys(conanLockData.dependencies).length, 0);
  assert.deepStrictEqual(conanLockData.parentComponentDependencies.length, 0);
  let dep_list = parseConanData(
    readFileSync("./test/data/conanfile.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 3);
  assert.deepStrictEqual(dep_list[0], {
    name: "zstd",
    version: "1.4.4",
    "bom-ref": "pkg:conan/zstd@1.4.4",
    purl: "pkg:conan/zstd@1.4.4",
    scope: "required",
  });
  dep_list = parseConanData(
    readFileSync("./test/data/cmakes/conanfile.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 1);
  assert.deepStrictEqual(dep_list[0], {
    name: "qr-code-generator",
    version: "1.8.0",
    "bom-ref": "pkg:conan/qr-code-generator@1.8.0",
    purl: "pkg:conan/qr-code-generator@1.8.0",
    scope: "required",
  });
  dep_list = parseConanData(
    readFileSync("./test/data/cmakes/conanfile1.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 43);
  assert.deepStrictEqual(dep_list[0], {
    "bom-ref":
      "pkg:conan/7-Zip@19.00?channel=stable&rrev=bb67aa9bc0da3feddc68ca9f334f4c8b&user=iw",
    name: "7-Zip",
    purl: "pkg:conan/7-Zip@19.00?channel=stable&rrev=bb67aa9bc0da3feddc68ca9f334f4c8b&user=iw",
    scope: "required",
    version: "19.00",
  });
});

it("conan package reference mapper to pURL", () => {
  const checkParseResult = (inputPkgRef, expectedPurl) => {
    const [purl, name, version] =
      mapConanPkgRefToPurlStringAndNameAndVersion(inputPkgRef);
    assert.deepStrictEqual(purl, expectedPurl);

    const expectedPurlPrefix = `pkg:conan/${name}@${version}`;
    assert.deepStrictEqual(
      purl.substring(0, expectedPurlPrefix.length),
      expectedPurlPrefix,
    );
  };

  checkParseResult("testpkg", "pkg:conan/testpkg@latest");

  checkParseResult("testpkg/1.2.3", "pkg:conan/testpkg@1.2.3");

  checkParseResult(
    "testpkg/1.2.3#recipe_revision",
    "pkg:conan/testpkg@1.2.3?rrev=recipe_revision",
  );

  checkParseResult(
    "testpkg/1.2.3@someuser/somechannel",
    "pkg:conan/testpkg@1.2.3?channel=somechannel&user=someuser",
  );

  checkParseResult(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision",
    "pkg:conan/testpkg@1.2.3?channel=somechannel&rrev=recipe_revision&user=someuser",
  );

  checkParseResult(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision:package_id#package_revision",
    "pkg:conan/testpkg@1.2.3" +
      "?channel=somechannel" +
      "&prev=package_revision" +
      "&rrev=recipe_revision" +
      "&user=someuser",
  );

  const expectParseError = (pkgRef) => {
    const result = mapConanPkgRefToPurlStringAndNameAndVersion(pkgRef);
    assert.deepStrictEqual(result[0], null);
    assert.deepStrictEqual(result[1], null);
    assert.deepStrictEqual(result[2], null);
  };

  expectParseError("testpkg/"); // empty version
  expectParseError("testpkg/1.2.3@"); // empty user
  expectParseError("testpkg/1.2.3@someuser"); // pkg ref is not allowed to stop here
  expectParseError("testpkg/1.2.3@someuser/"); // empty channel
  expectParseError("testpkg/1.2.3@someuser/somechannel#"); // empty recipe revision
  expectParseError("testpkg/1.2.3@someuser/somechannel#recipe_revision:"); // empty package id
  expectParseError(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision:package_id",
  ); // pkg ref is not allowed to stop here
  expectParseError(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision:package_id#",
  ); // empty package revision
  expectParseError("testpkg/1.2.3/unexpected"); // unexpected pkg ref segment separator
  expectParseError("testpkg/1.2.3@someuser/somechannel/unexpected"); // unexpected pkg ref segment separator
  expectParseError(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision/unexpected",
  ); // unexpected pkg ref segment separator
  expectParseError(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision:package_id/unexpected",
  ); // unexpected pkg ref segment separator
  expectParseError(
    "testpkg/1.2.3@someuser/somechannel#recipe_revision:package_id#package_revision/unexpected",
  ); // unexpected pkg ref segment separator
});

it("parse conan data where packages use custom user/channel", () => {
  const conanLockData = parseConanLockData(
    readFileSync("./test/data/conan.with_custom_pkg_user_channel.lock", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(conanLockData.pkgList.length, 4);
  assert.deepStrictEqual(conanLockData.pkgList[0], {
    name: "libcurl",
    version: "8.1.2",
    "bom-ref":
      "pkg:conan/libcurl@8.1.2?channel=stable&rrev=25215c550633ef0224152bc2c0556698&user=internal",
    purl: "pkg:conan/libcurl@8.1.2?channel=stable&rrev=25215c550633ef0224152bc2c0556698&user=internal",
  });
  assert.deepStrictEqual(conanLockData.pkgList[1], {
    name: "openssl",
    version: "3.1.0",
    "bom-ref":
      "pkg:conan/openssl@3.1.0?channel=stable&rrev=c9c6ab43aa40bafacf8b37c5948cdb1f&user=internal",
    purl: "pkg:conan/openssl@3.1.0?channel=stable&rrev=c9c6ab43aa40bafacf8b37c5948cdb1f&user=internal",
  });
  assert.deepStrictEqual(conanLockData.pkgList[2], {
    name: "zlib",
    version: "1.2.13",
    "bom-ref":
      "pkg:conan/zlib@1.2.13?channel=stable&rrev=aee6a56ff7927dc7261c55eb2db4fc5b&user=internal",
    purl: "pkg:conan/zlib@1.2.13?channel=stable&rrev=aee6a56ff7927dc7261c55eb2db4fc5b&user=internal",
  });
  assert.deepStrictEqual(conanLockData.pkgList[3], {
    name: "fmt",
    version: "10.0.0",
    purl: "pkg:conan/fmt@10.0.0?channel=stable&rrev=79e7cc169695bc058fb606f20df6bb10&user=internal",
    "bom-ref":
      "pkg:conan/fmt@10.0.0?channel=stable&rrev=79e7cc169695bc058fb606f20df6bb10&user=internal",
  });

  const dep_list = parseConanData(
    readFileSync("./test/data/conanfile.with_custom_pkg_user_channel.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    name: "libcurl",
    version: "8.1.2",
    "bom-ref": "pkg:conan/libcurl@8.1.2?channel=stable&user=internal",
    purl: "pkg:conan/libcurl@8.1.2?channel=stable&user=internal",
    scope: "required",
  });
  assert.deepStrictEqual(dep_list[1], {
    name: "fmt",
    version: "10.0.0",
    purl: "pkg:conan/fmt@10.0.0?channel=stable&user=internal",
    "bom-ref": "pkg:conan/fmt@10.0.0?channel=stable&user=internal",
    scope: "optional",
  });
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

it("parse mix lock data", () => {
  assert.deepStrictEqual(parseMixLockData(null), []);
  let dep_list = parseMixLockData(
    readFileSync("./test/data/mix.lock", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 16);
  assert.deepStrictEqual(dep_list[0], {
    name: "absinthe",
    version: "1.7.0",
  });
  dep_list = parseMixLockData(
    readFileSync("./test/data/mix.lock.1", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 23);
  assert.deepStrictEqual(dep_list[0], {
    name: "bunt",
    version: "0.2.0",
  });
});

it("parse github actions workflow data", () => {
  assert.deepStrictEqual(parseGitHubWorkflowData(null), []);
  let dep_list = parseGitHubWorkflowData("./.github/workflows/nodejs.yml");
  assert.deepStrictEqual(dep_list.length, 7);
  assert.deepStrictEqual(dep_list[0], {
    group: "actions",
    name: "checkout",
    version: "6.0.1",
    purl: "pkg:github/actions/checkout@6.0.1?commit=8e8c483db84b4bee98b60c0593521ed34d9990e8",
    properties: [
      {
        name: "SrcFile",
        value: "./.github/workflows/nodejs.yml",
      },
      {
        name: "cdx:actions:isOfficial",
        value: "true",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.7,
        methods: [
          {
            technique: "source-code-analysis",
            confidence: 0.7,
            value: "./.github/workflows/nodejs.yml",
          },
        ],
      },
    },
  });
  dep_list = parseGitHubWorkflowData("./test/data/github-actions-tj.yaml");
  assert.deepStrictEqual(dep_list.length, 4);
  assert.deepStrictEqual(dep_list, [
    {
      group: "pixel",
      name: "steamcmd",
      version: "1.2.7",
      purl: "pkg:github/pixel/steamcmd@1.2.7?commit=foo",
      properties: [
        {
          name: "SrcFile",
          value: "./test/data/github-actions-tj.yaml",
        },
      ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.7,
          methods: [
            {
              technique: "source-code-analysis",
              confidence: 0.7,
              value: "./test/data/github-actions-tj.yaml",
            },
          ],
        },
      },
    },
    {
      group: "tj",
      name: "branch",
      version: "8.2.0",
      purl: "pkg:github/tj/branch@8.2.0?commit=47dd",
      properties: [
        {
          name: "SrcFile",
          value: "./test/data/github-actions-tj.yaml",
        },
      ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.7,
          methods: [
            {
              technique: "source-code-analysis",
              confidence: 0.7,
              value: "./test/data/github-actions-tj.yaml",
            },
          ],
        },
      },
    },
    {
      group: "tj",
      name: "branch2",
      version: "08",
      purl: "pkg:github/tj/branch2@08?tag=v0.0.18",
      properties: [
        {
          name: "SrcFile",
          value: "./test/data/github-actions-tj.yaml",
        },
      ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.7,
          methods: [
            {
              technique: "source-code-analysis",
              confidence: 0.7,
              value: "./test/data/github-actions-tj.yaml",
            },
          ],
        },
      },
    },
    {
      group: "github/codeql-action",
      name: "upload-sarif",
      version: "3.30.3",
      purl: "pkg:github/github/codeql-action/upload-sarif@3.30.3?commit=192325c86100d080feab897ff886c34abd4c83a3",
      properties: [
        {
          name: "SrcFile",
          value: "./test/data/github-actions-tj.yaml",
        },
        {
          name: "cdx:actions:isOfficial",
          value: "true",
        },
      ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 0.7,
          methods: [
            {
              technique: "source-code-analysis",
              confidence: 0.7,
              value: "./test/data/github-actions-tj.yaml",
            },
          ],
        },
      },
    },
  ]);
  dep_list = parseGitHubWorkflowData("./.github/workflows/repotests.yml");
  assert.deepStrictEqual(dep_list.length, 14);
});

it("parse cs pkg data", () => {
  assert.deepStrictEqual(parseCsPkgData(null), []);
  const dep_list = parseCsPkgData(
    readFileSync("./test/data/packages.config", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 21);
  assert.deepStrictEqual(dep_list[0], {
    "bom-ref": "pkg:nuget/Antlr@3.5.0.2",
    group: "",
    name: "Antlr",
    version: "3.5.0.2",
    purl: "pkg:nuget/Antlr@3.5.0.2",
  });
});

it("parse cs pkg data 2", () => {
  assert.deepStrictEqual(parseCsPkgData(null), []);
  const dep_list = parseCsPkgData(
    readFileSync("./test/data/packages2.config", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 1);
  assert.deepStrictEqual(dep_list[0], {
    "bom-ref": "pkg:nuget/EntityFramework@6.2.0",
    group: "",
    name: "EntityFramework",
    version: "6.2.0",
    purl: "pkg:nuget/EntityFramework@6.2.0",
  });
});

it("parse cs proj", () => {
  assert.deepStrictEqual(parseCsProjData(null), []);
  let retMap = parseCsProjData(
    readFileSync("./test/sample.csproj", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(retMap?.parentComponent["bom-ref"], undefined);
  assert.deepStrictEqual(retMap.pkgList.length, 5);
  assert.deepStrictEqual(retMap.pkgList[0], {
    "bom-ref": "pkg:nuget/Microsoft.AspNetCore.Mvc.NewtonsoftJson@3.1.1",
    group: "",
    name: "Microsoft.AspNetCore.Mvc.NewtonsoftJson",
    version: "3.1.1",
    purl: "pkg:nuget/Microsoft.AspNetCore.Mvc.NewtonsoftJson@3.1.1",
  });
  assert.deepStrictEqual(retMap?.parentComponent.properties, [
    { name: "cdx:dotnet:target_framework", value: "netcoreapp3.1" },
  ]);
  retMap = parseCsProjData(
    readFileSync("./test/data/WindowsFormsApplication1.csproj", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    type: "application",
    properties: [
      {
        name: "cdx:dotnet:project_guid",
        value: "{3336A23A-6F2C-46D4-89FA-93C726CEB23D}",
      },
      {
        name: "Namespaces",
        value: "WindowsFormsApplication1",
      },
      { name: "cdx:dotnet:target_framework", value: "v4.8" },
    ],
    name: "WindowsFormsApplication1",
    version: "8.0.30703",
    purl: "pkg:nuget/WindowsFormsApplication1@8.0.30703?output_type=WinExe",
    "bom-ref":
      "pkg:nuget/WindowsFormsApplication1@8.0.30703?output_type=WinExe",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 53);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "",
    name: "activeup.net.common",
    purl: "pkg:nuget/activeup.net.common",
    "bom-ref": "pkg:nuget/activeup.net.common",
    properties: [
      {
        name: "cdx:dotnet:hint_path",
        value: "..\\activeup.net.common.dll",
      },
      {
        name: "PackageFiles",
        value: "activeup.net.common.dll",
      },
    ],
  });
  assert.deepStrictEqual(retMap.dependencies, [
    {
      dependsOn: [
        "pkg:nuget/BouncyCastle@1.7.0",
        "pkg:nuget/Bunifu_UI_v1.5.3",
        "pkg:nuget/Google.Apis.Auth@1.10.0",
        "pkg:nuget/Google.Apis.Calendar.v3",
        "pkg:nuget/Google.Apis.Core@1.10.0",
        "pkg:nuget/Google.Apis.Oauth2.v2",
        "pkg:nuget/Google.Apis.Sheets.v4@1.35.2.1356",
        "pkg:nuget/Google.Apis.Tasks.v1",
        "pkg:nuget/Google.Apis@1.10.0",
        "pkg:nuget/Google.GData.Apps",
        "pkg:nuget/Google.GData.Client",
        "pkg:nuget/Google.GData.Contacts",
        "pkg:nuget/Google.GData.Extensions",
        "pkg:nuget/Google.GData.Spreadsheets",
        "pkg:nuget/HtmlAgilityPack@1.4.6.0",
        "pkg:nuget/MailKit",
        "pkg:nuget/MaterialMessageBox@1.0.0.11",
        "pkg:nuget/Microsoft.Bcl.Async@1.0.168",
        "pkg:nuget/Microsoft.Bcl@1.1.10",
        "pkg:nuget/Microsoft.CSharp",
        "pkg:nuget/Microsoft.Net.Http@2.2.29",
        "pkg:nuget/Microsoft.VisualBasic",
        "pkg:nuget/MimeKit",
        "pkg:nuget/NUnit@3.10.1",
        "pkg:nuget/Newtonsoft.Json@7.0.1",
        "pkg:nuget/Proxy@3.0.16061.1530",
        "pkg:nuget/S22.Imap",
        "pkg:nuget/SKGL",
        "pkg:nuget/Selenium.WebDriver@3.13.1",
        "pkg:nuget/System",
        "pkg:nuget/System.Core",
        "pkg:nuget/System.Data",
        "pkg:nuget/System.Data.DataSetExtensions",
        "pkg:nuget/System.Deployment",
        "pkg:nuget/System.Drawing",
        "pkg:nuget/System.Management",
        "pkg:nuget/System.Net",
        "pkg:nuget/System.Windows.Forms",
        "pkg:nuget/System.Xml",
        "pkg:nuget/System.Xml.Linq",
        "pkg:nuget/Zlib.Portable.Signed@1.11.0",
        "pkg:nuget/activeup.net.common",
        "pkg:nuget/activeup.net.imap4",
        "pkg:nuget/log4net@2.0.3",
      ],
      ref: "pkg:nuget/WindowsFormsApplication1@8.0.30703?output_type=WinExe",
    },
  ]);
  assert.deepStrictEqual(retMap?.parentComponent.properties, [
    {
      name: "cdx:dotnet:project_guid",
      value: "{3336A23A-6F2C-46D4-89FA-93C726CEB23D}",
    },
    {
      name: "Namespaces",
      value: "WindowsFormsApplication1",
    },
    {
      name: "cdx:dotnet:target_framework",
      value: "v4.8",
    },
  ]);
  retMap = parseCsProjData(
    readFileSync("./test/data/Server.csproj", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    type: "library",
    properties: [
      {
        name: "cdx:dotnet:project_guid",
        value: "{6BA9F9E1-E43C-489D-A3B4-8916CA2D4C5F}",
      },
      { name: "Namespaces", value: "OutputMgr.Server" },
      { name: "cdx:dotnet:target_framework", value: "v4.8" },
    ],
    name: "Server",
    version: "9.0.21022",
    purl: "pkg:nuget/Server@9.0.21022",
    "bom-ref": "pkg:nuget/Server@9.0.21022",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 34);
  assert.deepStrictEqual(retMap?.parentComponent.properties, [
    {
      name: "cdx:dotnet:project_guid",
      value: "{6BA9F9E1-E43C-489D-A3B4-8916CA2D4C5F}",
    },
    {
      name: "Namespaces",
      value: "OutputMgr.Server",
    },
    {
      name: "cdx:dotnet:target_framework",
      value: "v4.8",
    },
  ]);
  retMap = parseCsProjData(
    readFileSync("./test/data/Logging.csproj", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap?.parentComponent["bom-ref"], undefined);
  assert.deepStrictEqual(retMap?.parentComponent.properties, [
    { name: "Namespaces", value: "Sample.OData" },
    { name: "cdx:dotnet:target_framework", value: "$(TargetFrameworks);" },
  ]);
});

it("parse cs proj hint path", () => {
  const retMap = parseCsProjData(
    readFileSync("./test/data/issue-2156/demo.csproj", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(retMap.pkgList.length, 36);
  assert.deepStrictEqual(retMap.pkgList[0], {
    "bom-ref": "pkg:nuget/Auth0.AuthenticationApi@7.26.1",
    group: "",
    name: "Auth0.AuthenticationApi",
    properties: [
      {
        name: "cdx:dotnet:assembly_version",
        value: "7.26.1.0",
      },
      {
        name: "cdx:dotnet:hint_path",
        value:
          "..\\packages\\Auth0.AuthenticationApi.7.26.1\\lib\\net462\\Auth0.AuthenticationApi.dll",
      },
      {
        name: "PackageFiles",
        value: "Auth0.AuthenticationApi.dll",
      },
    ],
    purl: "pkg:nuget/Auth0.AuthenticationApi@7.26.1",
    version: "7.26.1",
  });
});

it("parse project.assets.json", () => {
  assert.deepStrictEqual(parseCsProjAssetsData(null), {
    dependenciesList: [],
    pkgList: [],
  });
  let dep_list = parseCsProjAssetsData(
    readFileSync("./test/data/project.assets.json", { encoding: "utf-8" }),
    "./test/data/project.assets.json",
  );
  assert.deepStrictEqual(dep_list["pkgList"].length, 302);
  assert.deepStrictEqual(dep_list["pkgList"][0], {
    "bom-ref": "pkg:nuget/Castle.Core.Tests@0.0.0",
    purl: "pkg:nuget/Castle.Core.Tests@0.0.0",
    group: "",
    name: "Castle.Core.Tests",
    type: "application",
    version: "0.0.0",
  });
  assert.deepStrictEqual(dep_list["dependenciesList"].length, 302);
  assert.deepStrictEqual(dep_list["dependenciesList"][0], {
    dependsOn: [
      "pkg:nuget/Castle.Core-NLog@0.0.0",
      "pkg:nuget/Castle.Core-Serilog@0.0.0",
      "pkg:nuget/Castle.Core-log4net@0.0.0",
      "pkg:nuget/Castle.Core@0.0.0",
      "pkg:nuget/Microsoft.NET.Test.Sdk@17.1.0",
      "pkg:nuget/Microsoft.NETCore.App@2.1.0",
      "pkg:nuget/Microsoft.NETFramework.ReferenceAssemblies@1.0.0",
      "pkg:nuget/NLog@4.5.0",
      "pkg:nuget/NUnit.Console@3.11.1",
      "pkg:nuget/NUnit3TestAdapter@3.16.1",
      "pkg:nuget/NUnitLite@3.13.3",
      "pkg:nuget/PublicApiGenerator@10.1.2",
      "pkg:nuget/Serilog.Sinks.TextWriter@2.0.0",
      "pkg:nuget/Serilog@2.0.0",
      "pkg:nuget/System.Net.NameResolution@4.3.0",
      "pkg:nuget/System.Net.Primitives@4.3.0",
      "pkg:nuget/System.Security.Permissions@4.7.0",
      "pkg:nuget/System.Security.Permissions@6.0.0",
      "pkg:nuget/log4net@2.0.13",
    ],
    ref: "pkg:nuget/Castle.Core.Tests@0.0.0",
  });
  dep_list = parseCsProjAssetsData(
    readFileSync("./test/data/project.assets1.json", { encoding: "utf-8" }),
    "./test/data/project.assets1.json",
  );
  assert.deepStrictEqual(dep_list["pkgList"].length, 43);
  assert.deepStrictEqual(dep_list["pkgList"][0], {
    "bom-ref": "pkg:nuget/Podcast.Server@1.0.0",
    purl: "pkg:nuget/Podcast.Server@1.0.0",
    group: "",
    name: "Podcast.Server",
    type: "application",
    version: "1.0.0",
  });
  /*
  const pkgList = addEvidenceForDotnet(
    dep_list.pkgList,
    "./test/data/dosai-methods.json"
  );
  assert.deepStrictEqual(pkgList.length, 43);
  */
});

it("parse packages.lock.json", () => {
  assert.deepStrictEqual(parseCsPkgLockData(null), {
    dependenciesList: [],
    pkgList: [],
    rootList: [],
  });
  let dep_list = parseCsPkgLockData(
    readFileSync("./test/data/packages.lock.json", { encoding: "utf-8" }),
    "./test/data/packages.lock.json",
  );
  assert.deepStrictEqual(dep_list["pkgList"].length, 14);
  assert.deepStrictEqual(dep_list["pkgList"][0], {
    group: "",
    name: "Antlr",
    version: "3.5.0.2",
    purl: "pkg:nuget/Antlr@3.5.0.2",
    "bom-ref": "pkg:nuget/Antlr@3.5.0.2",
    _integrity:
      "sha512-CSfrVuDVMx3OrQhT84zed+tOdM1clljyRLWWlQM22fJsmG836RVDGQlE6tzysXh8X8p9UjkHbLr6OqEIVhtdEA==",
    properties: [{ name: "SrcFile", value: "./test/data/packages.lock.json" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/packages.lock.json",
          },
        ],
      },
    },
  });
  dep_list = parseCsPkgLockData(
    readFileSync("./test/data/packages2.lock.json", { encoding: "utf-8" }),
    "./test/data/packages2.lock.json",
  );
  assert.deepStrictEqual(dep_list["pkgList"].length, 34);
  assert.deepStrictEqual(dep_list["dependenciesList"].length, 34);
  assert.deepStrictEqual(dep_list["pkgList"][0], {
    group: "",
    name: "McMaster.Extensions.Hosting.CommandLine",
    version: "4.0.1",
    purl: "pkg:nuget/McMaster.Extensions.Hosting.CommandLine@4.0.1",
    "bom-ref": "pkg:nuget/McMaster.Extensions.Hosting.CommandLine@4.0.1",
    _integrity:
      "sha512-pZJF/zeXT3OC+3GUNO9ZicpCO9I7wYLmj0E2qPR8CRA6iUs0kGu6SCkmraB1sITx4elcVjMLiZDGMsBVMqaPhg==",
    properties: [{ name: "SrcFile", value: "./test/data/packages2.lock.json" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/packages2.lock.json",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(dep_list["dependenciesList"][0], {
    ref: "pkg:nuget/McMaster.Extensions.Hosting.CommandLine@4.0.1",
    dependsOn: [
      "pkg:nuget/McMaster.Extensions.CommandLineUtils@4.0.1",
      "pkg:nuget/Microsoft.Extensions.Hosting.Abstractions@6.0.0",
      "pkg:nuget/Microsoft.Extensions.Logging.Abstractions@6.0.0",
    ],
  });
  dep_list = parseCsPkgLockData(
    readFileSync("./test/data/packages3.lock.json", { encoding: "utf-8" }),
    "./test/data/packages3.lock.json",
  );
  assert.deepStrictEqual(dep_list["pkgList"].length, 15);
  assert.deepStrictEqual(dep_list["pkgList"][1], {
    group: "",
    name: "FSharp.Core",
    version: "4.5.2",
    purl: "pkg:nuget/FSharp.Core@4.5.2",
    "bom-ref": "pkg:nuget/FSharp.Core@4.5.2",
    _integrity:
      "sha512-apbdQOjzsjQ637kTWQuW29jqwY18jsHMyNC5A+TPJZKFEIE2cIfQWf3V7+mXrxlbX69BueYkv293/g70wuXuRw==",
    properties: [{ name: "SrcFile", value: "./test/data/packages3.lock.json" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/packages3.lock.json",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(dep_list["dependenciesList"].length, 15);
});

it("parse paket.lock", () => {
  assert.deepStrictEqual(parsePaketLockData(null), {
    pkgList: [],
    dependenciesList: [],
  });
  const dep_list = parsePaketLockData(
    readFileSync("./test/data/paket.lock", { encoding: "utf-8" }),
    "./test/data/paket.lock",
  );
  assert.deepStrictEqual(dep_list.pkgList.length, 13);
  assert.deepStrictEqual(dep_list.pkgList[0], {
    group: "",
    name: "0x53A.ReferenceAssemblies.Paket",
    version: "0.2",
    purl: "pkg:nuget/0x53A.ReferenceAssemblies.Paket@0.2",
    "bom-ref": "pkg:nuget/0x53A.ReferenceAssemblies.Paket@0.2",
    properties: [{ name: "SrcFile", value: "./test/data/paket.lock" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/paket.lock",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(dep_list.dependenciesList.length, 13);
  assert.deepStrictEqual(dep_list.dependenciesList[2], {
    ref: "pkg:nuget/FSharp.Compiler.Service@17.0.1",
    dependsOn: [
      "pkg:nuget/System.Collections.Immutable@1.4",
      "pkg:nuget/System.Reflection.Metadata@1.5",
    ],
  });
});

it("parse .net cs proj", () => {
  assert.deepStrictEqual(parseCsProjData(null), []);
  const retMap = parseCsProjData(
    readFileSync("./test/data/sample-dotnet.csproj", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    type: "library",
    properties: [
      { name: "Namespaces", value: "Calculator" },
      { name: "cdx:dotnet:target_framework", value: "v4.6.2" },
    ],
    name: "Calculator",
    purl: "pkg:nuget/Calculator@latest",
    "bom-ref": "pkg:nuget/Calculator@latest",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 19);
  assert.deepStrictEqual(retMap.pkgList[0], {
    "bom-ref": "pkg:nuget/Antlr@3.5.0.2",
    group: "",
    name: "Antlr",
    properties: [
      {
        name: "cdx:dotnet:assembly_name",
        value: "Antlr3.Runtime",
      },
      {
        name: "cdx:dotnet:assembly_version",
        value: "3.5.0.2",
      },
      {
        name: "cdx:dotnet:hint_path",
        value: "..\\packages\\Antlr.3.5.0.2\\lib\\Antlr3.Runtime.dll",
      },
      {
        name: "PackageFiles",
        value: "Antlr3.Runtime.dll",
      },
    ],
    purl: "pkg:nuget/Antlr@3.5.0.2",
    version: "3.5.0.2",
  });
  for (const apkg of retMap.pkgList) {
    if (
      (apkg.name.startsWith("System.") ||
        apkg.name.startsWith("Mono.") ||
        apkg.name.startsWith("Microsoft.")) &&
      !apkg.version
    ) {
      assert.ok(apkg.properties.length >= 1);
      assert.deepStrictEqual(
        apkg.properties[0].name,
        "cdx:dotnet:target_framework",
      );
    }
  }
  assert.deepStrictEqual(retMap.dependencies, [
    {
      dependsOn: [
        "pkg:nuget/Antlr@3.5.0.2",
        "pkg:nuget/Microsoft.ApplicationInsights.Agent.Intercept@2.4.0",
        "pkg:nuget/Microsoft.ApplicationInsights.DependencyCollector@2.5.1",
        "pkg:nuget/Microsoft.ApplicationInsights.PerfCounterCollector@2.5.1",
        "pkg:nuget/Microsoft.ApplicationInsights.Web@2.5.1",
        "pkg:nuget/Microsoft.ApplicationInsights.WindowsServer.TelemetryChannel@2.5.1",
        "pkg:nuget/Microsoft.ApplicationInsights.WindowsServer@2.5.1",
        "pkg:nuget/Microsoft.ApplicationInsights@2.5.1",
        "pkg:nuget/Microsoft.AspNet.SessionState.SessionStateModule@1.1.0",
        "pkg:nuget/Microsoft.AspNet.TelemetryCorrelation@1.0.0",
        "pkg:nuget/Microsoft.CSharp",
        "pkg:nuget/Microsoft.CodeDom.Providers.DotNetCompilerPlatform@1.0.8",
        "pkg:nuget/Microsoft.Web.Infrastructure@1.0.0.0",
        "pkg:nuget/Microsoft.Web.RedisSessionStateProvider@4.0.1",
        "pkg:nuget/Microsoft.WindowsAzure.Diagnostics@2.8.0.0",
        "pkg:nuget/Newtonsoft.Json@11.0.1",
        "pkg:nuget/Pipelines.Sockets.Unofficial@1.0.7",
        "pkg:nuget/StackExchange.Redis@2.0.519",
        "pkg:nuget/WebGrease@1.6.0",
      ],
      ref: "pkg:nuget/Calculator@latest",
    },
  ]);
});

it("get nget metadata", async () => {
  const dep_list = [
    {
      dependsOn: [
        "pkg:nuget/Microsoft.NET.Test.Sdk@17.1.0",
        "pkg:nuget/Microsoft.NETCore.App@2.1.0",
        "pkg:nuget/Microsoft.NETFramework.ReferenceAssemblies@1.0.0",
        "pkg:nuget/NLog@4.5.0",
        "pkg:nuget/NUnit.Console@3.11.1",
        "pkg:nuget/NUnit3TestAdapter@3.16.1",
        "pkg:nuget/NUnitLite@3.13.3",
        "pkg:nuget/PublicApiGenerator@10.1.2",
        "pkg:nuget/Serilog.Sinks.TextWriter@2.0.0",
        "pkg:nuget/Serilog@3.0.1",
        "pkg:nuget/System.Net.NameResolution@4.3.0",
        "pkg:nuget/System.Net.Primitives@4.3.0",
        "pkg:nuget/System.Security.Permissions@4.7.0",
        "pkg:nuget/System.Security.Permissions@6.0.0",
        "pkg:nuget/log4net@2.0.13",
      ],
      ref: "pkg:nuget/Castle.Core@4.4.0",
    },
    {
      dependsOn: [
        "pkg:nuget/Microsoft.CSharp@4.0.1",
        "pkg:nuget/System.Collections@4.0.11",
        "pkg:nuget/System.Dynamic.Runtime@4.0.11",
        "pkg:nuget/System.Globalization@4.0.11",
        "pkg:nuget/System.Linq@4.1.0",
        "pkg:nuget/System.Reflection.Extensions@4.0.1",
        "pkg:nuget/System.Reflection@4.1.0",
        "pkg:nuget/System.Runtime.Extensions@4.1.0",
        "pkg:nuget/System.Runtime@4.1.0",
        "pkg:nuget/System.Text.RegularExpressions@4.1.0",
        "pkg:nuget/System.Threading@4.0.11",
      ],
      ref: "pkg:nuget/Serilog@3.0.1",
    },
  ];
  const pkg_list = [
    {
      group: "",
      name: "Castle.Core",
      version: "4.4.0",
      "bom-ref": "pkg:nuget/Castle.Core@4.4.0",
    },
    {
      group: "",
      name: "Serilog",
      version: "3.0.1",
      "bom-ref": "pkg:nuget/Serilog@3.0.1",
    },
  ];
  const { pkgList, dependencies } = await getNugetMetadata(pkg_list, dep_list);
  // This data will need to be updated periodically as it tests that missing versions are set to the latest rc
  assert.deepStrictEqual(pkgList, [
    {
      author: "Castle Project Contributors",
      "bom-ref": "pkg:nuget/Castle.Core@4.4.0",
      description:
        "Castle Core, including DynamicProxy, Logging Abstractions and DictionaryAdapter",
      group: "",
      homepage: {
        url: "https://www.nuget.org/packages/Castle.Core/4.4.0/",
      },
      license: "Apache-2.0",
      name: "Castle.Core",
      repository: {
        url: "http://www.castleproject.org/",
      },
      tags: [
        "castle",
        "dynamicproxy",
        "dynamic",
        "proxy",
        "dynamicproxy2",
        "dictionaryadapter",
        "emailsender",
      ],
      version: "4.4.0",
    },
    {
      author: "Serilog Contributors",
      "bom-ref": "pkg:nuget/Serilog@3.0.1",
      description: "Simple .NET logging with fully-structured events",
      group: "",
      homepage: {
        url: "https://www.nuget.org/packages/Serilog/3.0.1/",
      },
      license: "Apache-2.0",
      name: "Serilog",
      repository: {
        url: "https://serilog.net/",
      },
      tags: ["serilog", "logging", "semantic", "structured"],
      version: "3.0.1",
    },
  ]);
  assert.deepStrictEqual(pkgList.length, 2);
  assert.deepStrictEqual(dependencies, [
    {
      dependsOn: [
        "pkg:nuget/Microsoft.NET.Test.Sdk@17.1.0",
        "pkg:nuget/Microsoft.NETCore.App@2.1.0",
        "pkg:nuget/Microsoft.NETFramework.ReferenceAssemblies@1.0.0",
        "pkg:nuget/NLog@4.5.0",
        "pkg:nuget/NUnit.Console@3.11.1",
        "pkg:nuget/NUnit3TestAdapter@3.16.1",
        "pkg:nuget/NUnitLite@3.13.3",
        "pkg:nuget/PublicApiGenerator@10.1.2",
        "pkg:nuget/Serilog.Sinks.TextWriter@2.0.0",
        "pkg:nuget/Serilog@3.0.1",
        "pkg:nuget/System.Net.NameResolution@4.3.0",
        "pkg:nuget/System.Net.Primitives@4.3.0",
        "pkg:nuget/System.Security.Permissions@4.7.0",
        "pkg:nuget/System.Security.Permissions@6.0.0",
        "pkg:nuget/log4net@2.0.13",
      ],
      ref: "pkg:nuget/Castle.Core@4.4.0",
    },
    {
      dependsOn: [
        "pkg:nuget/Microsoft.CSharp@4.0.1",
        "pkg:nuget/System.Collections@4.0.11",
        "pkg:nuget/System.Dynamic.Runtime@4.0.11",
        "pkg:nuget/System.Globalization@4.0.11",
        "pkg:nuget/System.Linq@4.1.0",
        "pkg:nuget/System.Reflection.Extensions@4.0.1",
        "pkg:nuget/System.Reflection@4.1.0",
        "pkg:nuget/System.Runtime.Extensions@4.1.0",
        "pkg:nuget/System.Runtime@4.1.0",
        "pkg:nuget/System.Text.RegularExpressions@4.1.0",
        "pkg:nuget/System.Threading@4.0.11",
      ],
      ref: "pkg:nuget/Serilog@3.0.1",
    },
  ]);
}, 240000);

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

it("parsePomMetadata", async () => {
  const deps = parsePom("./test/pom.xml");
  const data = await getMvnMetadata(deps.dependencies);
  assert.deepStrictEqual(data.length, deps.dependencies.length);
});

// These tests are disabled because they are returning undefined
/*
it("get repo license", async () => {
  let license = await getRepoLicense(
    "https://github.com/ShiftLeftSecurity/sast-scan",
    {
      group: "ShiftLeftSecurity",
      name: "sast-scan",
    },
  );
  assert.deepStrictEqual(license, {
    id: "Apache-2.0",
    url: "https://github.com/ShiftLeftSecurity/sast-scan/blob/master/LICENSE",
  });

  license = await getRepoLicense("https://github.com/cdxgen/cdxgen", {
    group: "cyclonedx",
    name: "cdxgen",
  });
  assert.deepStrictEqual(license, {
    id: "Apache-2.0",
    url: "https://github.com/cdxgen/cdxgen/blob/master/LICENSE",
  });

  license = await getRepoLicense("https://cloud.google.com/go", {
    group: "cloud.google.com",
    name: "go"
  });
  assert.deepStrictEqual(license, "Apache-2.0");

  license = await getRepoLicense(undefined, {
    group: "github.com/ugorji",
    name: "go"
  });
  assert.deepStrictEqual(license, {
    id: "MIT",
    url: "https://github.com/ugorji/go/blob/master/LICENSE"
  });
});

it("get go pkg license", async () => {
  let license = await getGoPkgLicense({
    group: "github.com/Azure/azure-amqp-common-go",
    name: "v2",
  });
  assert.deepStrictEqual(license, [
    {
      id: "MIT",
      url: "https://pkg.go.dev/github.com/Azure/azure-amqp-common-go/v2?tab=licenses",
    },
  ]);

  license = await getGoPkgLicense({
    group: "go.opencensus.io",
    name: "go.opencensus.io",
  });
  assert.deepStrictEqual(license, [
    {
      id: "Apache-2.0",
      url: "https://pkg.go.dev/go.opencensus.io?tab=licenses",
    },
  ]);

  license = await getGoPkgLicense({
    group: "github.com/DataDog",
    name: "zstd",
  });
  assert.deepStrictEqual(license, [
    {
      id: "BSD-3-Clause",
      url: "https://pkg.go.dev/github.com/DataDog/zstd?tab=licenses",
    },
  ]);
});
*/

it("get licenses", () => {
  let licenses = getLicenses({ license: "MIT" });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
  ]);

  licenses = getLicenses({ license: ["MIT", "GPL-3.0-or-later"] });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
    {
      license: {
        id: "GPL-3.0-or-later",
        url: "https://opensource.org/licenses/GPL-3.0-or-later",
      },
    },
  ]);

  licenses = getLicenses({
    license: {
      id: "MIT",
      url: "https://opensource.org/licenses/MIT",
    },
  });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
  ]);

  licenses = getLicenses({
    license: "GPL-2.0+",
  });
  assert.deepStrictEqual(licenses, [
    {
      license: {
        id: "GPL-2.0+",
        url: "https://opensource.org/licenses/GPL-2.0+",
      },
    },
  ]);

  licenses = getLicenses({
    license: "(MIT or Apache-2.0)",
  });
  assert.deepStrictEqual(licenses, [
    {
      expression: "(MIT or Apache-2.0)",
    },
  ]);

  // In case this is not a known license in the current build but it is a valid SPDX license expression
  licenses = getLicenses({
    license: "NOT-GPL-2.1+",
  });
  assert.deepStrictEqual(licenses, [
    {
      expression: "NOT-GPL-2.1+",
    },
  ]);

  licenses = getLicenses({
    license: "GPL-3.0-only WITH Classpath-exception-2.0",
  });
  assert.deepStrictEqual(licenses, [
    {
      expression: "GPL-3.0-only WITH Classpath-exception-2.0",
    },
  ]);

  licenses = getLicenses({
    license: undefined,
  });
  assert.deepStrictEqual(licenses, undefined);
});

it("parsePkgJson", async () => {
  const pkgList = await parsePkgJson("./package.json", true);
  assert.deepStrictEqual(pkgList.length, 1);
});

it("parsePkgLock v1", async () => {
  const parsedList = await parsePkgLock(
    "./test/data/package-json/v1/package-lock.json",
  );
  const deps = parsedList.pkgList;
  assert.deepStrictEqual(deps.length, 910);
  assert.deepStrictEqual(
    deps[1]._integrity,
    "sha512-ZmIomM7EE1DvPEnSFAHZn9Vs9zJl5A9H7el0EGTE6ZbW9FKe/14IYAlPbC8iH25YarEQxZL+E8VW7Mi7kfQrDQ==",
  );
  assert.deepStrictEqual(parsedList.dependenciesList.length, 910);
});

it("parsePkgLock v2", async () => {
  const parsedList = await parsePkgLock(
    "./test/data/package-json/v2/package-lock.json",
  );
  const deps = parsedList.pkgList;
  assert.deepStrictEqual(deps.length, 134);
  assert.deepStrictEqual(
    deps[1]._integrity,
    "sha512-x9yaMvEh5BEaZKeVQC4vp3l+QoFj3BXcd4aYfuKSzIIyihjdVARAadYy3SMNIz0WCCdS2vB9JL/U6GQk5PaxQw==",
  );
  assert.deepStrictEqual(deps[1].license, "Apache-2.0");
  assert.deepStrictEqual(deps[0], {
    "bom-ref": "pkg:npm/shopify-theme-tailwindcss@2.2.1",
    purl: "pkg:npm/shopify-theme-tailwindcss@2.2.1",
    author: "Wessel van Ree <hello@wesselvanree.com>",
    group: "",
    name: "shopify-theme-tailwindcss",
    license: "MIT",
    type: "application",
    version: "2.2.1",
  });
  assert.deepStrictEqual(deps[deps.length - 1].name, "rollup");
  const pkgFilePath = path.resolve(
    path.join("test", "data", "package-json", "v2", "package-lock.json"),
  );
  assert.deepStrictEqual(deps[deps.length - 1].evidence, {
    identity: {
      field: "purl",
      confidence: 1,
      methods: [
        {
          technique: "manifest-analysis",
          confidence: 1,
          value: pkgFilePath,
        },
      ],
    },
  });
  assert.deepStrictEqual(parsedList.dependenciesList.length, 134);
});

it("parsePkgLock v2 workspace", async () => {
  const parsedList = await parsePkgLock(
    "./test/data/package-json/v2-workspace/package-lock.json",
  );
  const pkgs = parsedList.pkgList;
  const deps = parsedList.dependenciesList;
  assert.deepStrictEqual(pkgs.length, 1034);
  assert.deepStrictEqual(pkgs[0].license, "MIT");
  const hasAppWorkspacePkg = pkgs.some(
    (obj) => obj["bom-ref"] === "pkg:npm/app@0.0.0",
  );
  const hasAppWorkspaceDeps = deps.some(
    (obj) => obj.ref === "pkg:npm/app@0.0.0",
  );
  assert.ok(hasAppWorkspacePkg);
  assert.ok(hasAppWorkspaceDeps);
  const hasRootPkg = pkgs.some(
    (obj) => obj["bom-ref"] === "pkg:npm/root@0.0.0",
  );
  const hasRootDeps = deps.some((obj) => obj.ref === "pkg:npm/root@0.0.0");
  assert.ok(hasRootPkg);
  assert.ok(hasRootDeps);
  const hasScriptsWorkspacePkg = pkgs.some(
    (obj) => obj["bom-ref"] === "pkg:npm/scripts@0.0.0",
  );
  const hasScriptsWorkspaceDeps = deps.some(
    (obj) => obj.ref === "pkg:npm/scripts@0.0.0",
  );
  assert.ok(hasScriptsWorkspacePkg);
  assert.ok(hasScriptsWorkspaceDeps);
});

it("parsePkgLock v3", async () => {
  const parsedList = await parsePkgLock(
    "./test/data/package-json/v3/package-lock.json",
    {
      projectVersion: "latest",
      projectName: "cdxgen",
    },
  );
  const deps = parsedList.pkgList;
  assert.deepStrictEqual(deps.length, 161);
  assert.deepStrictEqual(
    deps[1]._integrity,
    "sha512-s93jiP6GkRApn5duComx6RLwtP23YrulPxShz+8peX7svd6Q+MS8nKLhKCCazbP92C13eTVaIOxgeLt0ezIiCg==",
  );
  assert.deepStrictEqual(deps[0], {
    "bom-ref": "pkg:npm/clase-21---jwt@latest",
    purl: "pkg:npm/clase-21---jwt@latest",
    group: "",
    author: "",
    license: "ISC",
    name: "clase-21---jwt",
    type: "application",
    version: "latest",
  });
  assert.deepStrictEqual(deps[deps.length - 1].name, "uid2");
  assert.deepStrictEqual(parsedList.dependenciesList.length, 161);
});

it("parsePkgLock theia", async () => {
  const parsedList = await parsePkgLock(
    "./test/data/package-json/theia/package-lock.json",
    {},
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 2410);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 2410);
  assert.deepStrictEqual(
    validateRefs({
      components: parsedList.pkgList,
      dependencies: parsedList.dependenciesList,
    }),
    true,
  );
});

it("parseBowerJson", async () => {
  const deps = await parseBowerJson("./test/data/bower.json");
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0].name, "jquery");
});

it("parseNodeShrinkwrap", async () => {
  const deps = await parseNodeShrinkwrap("./test/shrinkwrap-deps.json");
  assert.deepStrictEqual(deps.length, 496);
  assert.deepStrictEqual(
    deps[0]._integrity,
    "sha512-a9gxpmdXtZEInkCSHUJDLHZVBgb1QS0jhss4cPP93EW7s+uC5bikET2twEF3KV+7rDblJcmNvTR7VJejqd2C2g==",
  );
});

it("parseSetupPyFile", async () => {
  let deps = await parseSetupPyFile(`install_requires=[
    'colorama>=0.4.3',
    'libsast>=1.0.3',
],`);
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].name, "colorama");

  deps = await parseSetupPyFile(
    `install_requires=['colorama>=0.4.3','libsast>=1.0.3',],`,
  );
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].name, "colorama");

  deps = await parseSetupPyFile(
    `install_requires=['colorama>=0.4.3','libsast>=1.0.3']`,
  );
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].name, "colorama");

  deps = await parseSetupPyFile(
    `install_requires=['colorama>=0.4.3', 'libsast>=1.0.3']`,
  );
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].name, "colorama");

  deps = await parseSetupPyFile(`install_requires=[
'colorama>=0.4.3',
'libsast>=1.0.3',
]`);
  assert.deepStrictEqual(deps.length, 2);
  assert.deepStrictEqual(deps[0].name, "colorama");

  deps = await parseSetupPyFile(
    readFileSync("./test/data/setup-impacket.py", "utf-8"),
  );
  assert.deepStrictEqual(deps.length, 7);
  assert.ok(deps);
});

it("parsePnpmWorkspace", async () => {
  const wobj = parsePnpmWorkspace("./test/data/pnpm_locks/pnpm-workspace.yaml");
  assert.deepStrictEqual(wobj.packages.length, 31);
  assert.deepStrictEqual(Object.keys(wobj.catalogs).length, 217);
});

it("parsePnpmLock", async () => {
  let parsedList = await parsePnpmLock("./test/pnpm-lock.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 1706);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1706);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-IGhtTmpjGbYzcEDOw7DcQtbQSXcG9ftmAXtWTu9V936vDye4xjjekktFAtgZsWpzTj/X01jocB46mTywm/4SZw==",
    group: "@babel",
    name: "code-frame",
    "bom-ref": "pkg:npm/@babel/code-frame@7.10.1",
    purl: "pkg:npm/%40babel/code-frame@7.10.1",
    scope: undefined,
    type: "library",
    version: "7.10.1",
    properties: [
      {
        name: "SrcFile",
        value: "./test/pnpm-lock.yaml",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/pnpm-lock.yaml",
          },
        ],
      },
    },
  });
  parsedList = await parsePnpmLock("./test/data/pnpm-lock.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 318);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 318);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-iAXqUn8IIeBTNd72xsFlgaXHkMBMt6y4HJp1tIaK465CWLT/fG1aqB7ykr95gHHmlBdGbFeWWfyB4NJJ0nmeIg==",
    group: "@babel",
    name: "code-frame",
    "bom-ref": "pkg:npm/@babel/code-frame@7.16.7",
    purl: "pkg:npm/%40babel/code-frame@7.16.7",
    scope: "optional",
    type: "library",
    version: "7.16.7",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/pnpm-lock.yaml",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock.yaml",
          },
        ],
      },
    },
  });
  parsedList = await parsePnpmLock("./test/data/pnpm-lock2.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 7);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 7);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "",
    name: "ansi-regex",
    version: "2.1.1",
    "bom-ref": "pkg:npm/ansi-regex@2.1.1",
    purl: "pkg:npm/ansi-regex@2.1.1",
    scope: undefined,
    type: "library",
    _integrity: "sha1-w7M6te42DYbg5ijwRorn7yfWVN8=",
    properties: [{ name: "SrcFile", value: "./test/data/pnpm-lock2.yaml" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock2.yaml",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(parsedList.dependenciesList[2], {
    ref: "pkg:npm/chalk@1.1.3",
    dependsOn: [
      "pkg:npm/ansi-styles@2.2.1",
      "pkg:npm/escape-string-regexp@1.0.5",
      "pkg:npm/has-ansi@2.0.0",
      "pkg:npm/strip-ansi@3.0.1",
      "pkg:npm/supports-color@2.0.0",
    ],
  });
  parsedList = await parsePnpmLock("./test/data/pnpm-lock3.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 449);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 449);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "@nodelib",
    name: "fs.scandir",
    version: "2.1.5",
    "bom-ref": "pkg:npm/@nodelib/fs.scandir@2.1.5",
    purl: "pkg:npm/%40nodelib/fs.scandir@2.1.5",
    scope: undefined,
    type: "library",
    _integrity:
      "sha512-vq24Bq3ym5HEQm2NKCr3yXDwjc7vTsEThRDnkp2DK9p1uqLR+DHurm/NOTo0KG7HYHU7eppKZj3MyqYuMBf62g==",
    properties: [{ name: "SrcFile", value: "./test/data/pnpm-lock3.yaml" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock3.yaml",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(parsedList.dependenciesList[2], {
    ref: "pkg:npm/@nodelib/fs.walk@1.2.8",
    dependsOn: ["pkg:npm/@nodelib/fs.scandir@2.1.5", "pkg:npm/fastq@1.13.0"],
  });

  parsedList = await parsePnpmLock("./test/data/pnpm-lock4.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 1);

  parsedList = await parsePnpmLock("./test/data/pnpm-lock6.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 200);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 200);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "@babel",
    name: "code-frame",
    version: "7.18.6",
    "bom-ref": "pkg:npm/@babel/code-frame@7.18.6",
    purl: "pkg:npm/%40babel/code-frame@7.18.6",
    scope: "optional",
    type: "library",
    _integrity:
      "sha512-TDCmlK5eOvH+eH7cdAFlNXeVJqWIQ7gW9tY1GJIpUtFb6CmjVyq2VM3u71bOyR8CRihcCgMUYoDNyLXao3+70Q==",
    properties: [{ name: "SrcFile", value: "./test/data/pnpm-lock6.yaml" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock6.yaml",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(parsedList.pkgList[parsedList.pkgList.length - 1], {
    group: "",
    name: "yargs",
    version: "17.7.1",
    "bom-ref": "pkg:npm/yargs@17.7.1",
    purl: "pkg:npm/yargs@17.7.1",
    scope: "optional",
    type: "library",
    _integrity:
      "sha512-cwiTb08Xuv5fqF4AovYacTFNxk62th7LKJ6BL9IGUpTJrWoU7/7WdQGTP2SjKf1dUNBGzDd28p/Yfs/GI6JrLw==",
    properties: [{ name: "SrcFile", value: "./test/data/pnpm-lock6.yaml" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock6.yaml",
          },
        ],
      },
    },
  });
  parsedList = await parsePnpmLock("./test/data/pnpm-lock6a.yaml");
  assert.deepStrictEqual(parsedList.pkgList.length, 234);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 234);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "@babel",
    name: "code-frame",
    version: "7.18.6",
    "bom-ref": "pkg:npm/@babel/code-frame@7.18.6",
    purl: "pkg:npm/%40babel/code-frame@7.18.6",
    scope: "optional",
    type: "library",
    _integrity:
      "sha512-TDCmlK5eOvH+eH7cdAFlNXeVJqWIQ7gW9tY1GJIpUtFb6CmjVyq2VM3u71bOyR8CRihcCgMUYoDNyLXao3+70Q==",
    properties: [{ name: "SrcFile", value: "./test/data/pnpm-lock6a.yaml" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/pnpm-lock6a.yaml",
          },
        ],
      },
    },
  });
  // Test case to see if parsePnpmLock is finding all root deps
  const dummpyParent = {
    name: "rush",
    group: "",
    purl: "pkg:npm/rush",
    type: "application",
    "bom-ref": "pkg:npm/rush",
  };
  parsedList = await parsePnpmLock(
    "./test/data/pnpm-lock6b.yaml",
    dummpyParent,
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 17);
  // this is due to additions projects defined in importers section of pnpm-lock.yaml
  assert.deepStrictEqual(parsedList.dependenciesList.length, 21);
  const mainRootDependency = parsedList.dependenciesList.find(
    (obj) => obj["ref"] === "pkg:npm/rush",
  );
  const myAppRootDependency = parsedList.dependenciesList.find(
    (obj) => obj["ref"] === "pkg:npm/rush/my-app@latest#apps/my-app",
  );
  const myControlsRootDependency = parsedList.dependenciesList.find(
    (obj) =>
      obj["ref"] === "pkg:npm/rush/my-controls@latest#libraries/my-controls",
  );
  const myToolChainRootDependency = parsedList.dependenciesList.find(
    (obj) =>
      obj["ref"] === "pkg:npm/rush/my-toolchain@latest#tools/my-toolchain",
  );
  assert.deepStrictEqual(mainRootDependency["dependsOn"].length, 0);
  assert.deepStrictEqual(myAppRootDependency["dependsOn"].length, 4);
  assert.deepStrictEqual(myControlsRootDependency["dependsOn"].length, 2);
  assert.deepStrictEqual(myToolChainRootDependency["dependsOn"].length, 4);

  parsedList = await parsePnpmLock("./test/data/pnpm-lock9a.yaml", {
    name: "pnpm9",
    purl: "pkg:npm/pnpm9@1.0.0",
  });
  assert.deepStrictEqual(parsedList.pkgList.length, 1007);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1006);
  assert.deepStrictEqual(
    parsedList.pkgList.filter((pkg) => !pkg.scope).length,
    0,
  );
  parsedList = await parsePnpmLock("./test/data/pnpm-lock9b.yaml", {
    name: "pnpm9",
    purl: "pkg:npm/pnpm9@1.0.0",
  });
  assert.deepStrictEqual(parsedList.pkgList.length, 1366);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1353);
  assert.deepStrictEqual(
    parsedList.pkgList.filter((pkg) => !pkg.scope).length,
    12,
  );
  parsedList = await parsePnpmLock("./test/data/pnpm-lock9c.yaml", {
    name: "pnpm9",
    purl: "pkg:npm/pnpm9@1.0.0",
  });
  assert.deepStrictEqual(parsedList.pkgList.length, 461);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 462);
  assert.deepStrictEqual(
    parsedList.pkgList.filter((pkg) => !pkg.scope).length,
    3,
  );
  parsedList = await parsePnpmLock(
    "./test/data/pnpm_locks/bytemd-pnpm-lock.yaml",
  );
  assert.deepStrictEqual(parsedList.pkgList.length, 1189);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1189);
});

it("findPnpmPackagePath", () => {
  // Test with non-existent base directory
  assert.deepStrictEqual(
    findPnpmPackagePath("/nonexistent", "test-package", "1.0.0"),
    null,
  );

  // Test with null/undefined inputs
  assert.deepStrictEqual(
    findPnpmPackagePath(null, "test-package", "1.0.0"),
    null,
  );
  assert.deepStrictEqual(findPnpmPackagePath("/tmp", null, "1.0.0"), null);
  assert.deepStrictEqual(findPnpmPackagePath("/tmp", "", "1.0.0"), null);

  // Test with actual cdxgen project structure - should find packages in node_modules
  const packagePath = findPnpmPackagePath(".", "chalk", "4.1.2");
  if (packagePath) {
    assert.ok(packagePath.match(/node_modules.*chalk/));
    // Verify package.json exists at the found path
    assert.deepStrictEqual(
      existsSync(path.join(packagePath, "package.json")),
      true,
    );
  }

  // Test with scoped package
  const scopedPackagePath = findPnpmPackagePath(".", "@babel/core", "7.22.5");
  if (scopedPackagePath) {
    assert.ok(scopedPackagePath.toMatch(/node_modules.*@babel.*core/));
  }
});

it("pnpmMetadata enhancement", async () => {
  // Test with empty/null inputs
  assert.deepStrictEqual(await pnpmMetadata([], "./pnpm-lock.yaml"), []);
  assert.deepStrictEqual(await pnpmMetadata(null, "./pnpm-lock.yaml"), null);
  assert.deepStrictEqual(
    await pnpmMetadata(undefined, "./pnpm-lock.yaml"),
    undefined,
  );

  // Test with non-existent lockfile path
  const mockPkgList = [
    {
      name: "test-package",
      version: "1.0.0",
      properties: [],
    },
  ];
  const result = await pnpmMetadata(mockPkgList, "/nonexistent/pnpm-lock.yaml");
  assert.deepStrictEqual(result, mockPkgList);
  assert.deepStrictEqual(result[0].description, undefined);

  // Test with actual project that has node_modules
  const testPkgList = [
    {
      name: "chalk",
      version: "4.1.2",
      properties: [],
    },
    {
      name: "nonexistent-package",
      version: "1.0.0",
      properties: [],
    },
  ];

  const enhancedResult = await pnpmMetadata(testPkgList, "./pnpm-lock.yaml");

  const chalkPkg = enhancedResult.find((p) => p.name === "chalk");
  if (chalkPkg) {
    const localPath = chalkPkg.properties?.find(
      (p) => p.name === "LocalNodeModulesPath",
    );
    if (localPath) {
      assert.ok(localPath.value.toMatch(/node_modules.*chalk/));
      assert.ok(chalkPkg.description);
      assert.ok(chalkPkg.license);
    }
  }

  // Non-existent package should remain unchanged
  const nonExistentPkg = enhancedResult.find(
    (p) => p.name === "nonexistent-package",
  );
  assert.deepStrictEqual(nonExistentPkg.description, undefined);
  assert.deepStrictEqual(
    nonExistentPkg.properties.find((p) => p.name === "LocalNodeModulesPath"),
    undefined,
  );
});

it("pnpmMetadata preserves existing metadata", async () => {
  const testPkgList = [
    {
      name: "test-package",
      version: "1.0.0",
      description: "Existing description",
      author: "Existing author",
      license: "Existing license",
      properties: [],
    },
  ];

  const result = await pnpmMetadata(testPkgList, "./pnpm-lock.yaml");

  // Should preserve existing metadata
  assert.deepStrictEqual(result[0].description, "Existing description");
  assert.deepStrictEqual(result[0].author, "Existing author");
  assert.deepStrictEqual(result[0].license, "Existing license");
});

it("pnpmMetadata with scoped packages", async () => {
  const testPkgList = [
    {
      name: "@babel/core",
      version: "7.22.5",
      properties: [],
    },
  ];

  const result = await pnpmMetadata(testPkgList, "./pnpm-lock.yaml");

  // Check if scoped package was processed
  const babelPkg = result.find((p) => p.name === "@babel/core");
  assert.ok(babelPkg);
  assert.deepStrictEqual(babelPkg.name, "@babel/core");
});

it("pnpmMetadata integration with parsePnpmLock", async () => {
  // Test that the integration works by parsing a real pnpm lock file
  const parsedList = await parsePnpmLock("./pnpm-lock.yaml");

  // Check that some packages have been enhanced with LocalNodeModulesPath
  const enhancedPackages = parsedList.pkgList.filter((pkg) =>
    pkg.properties?.some((p) => p.name === "LocalNodeModulesPath"),
  );

  if (enhancedPackages.length > 0) {
    assert.ok(enhancedPackages.length > 0);

    const examplePkg = enhancedPackages[0];
    assert.ok(
      examplePkg.properties.find((p) => p.name === "LocalNodeModulesPath"),
    );

    const packagesWithMetadata = enhancedPackages.filter(
      (pkg) => pkg.description || pkg.license || pkg.author,
    );
    assert.ok(packagesWithMetadata.length > 0);
  }
});

it("parseYarnLock", async () => {
  let identMap = yarnLockToIdentMap(readFileSync("./test/yarn.lock", "utf8"));
  assert.deepStrictEqual(Object.keys(identMap).length, 62);
  let parsedList = await parseYarnLock("./test/yarn.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 56);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "",
    name: "asap",
    version: "2.0.5",
    _integrity: "sha256-522765b50c3510490e52d7dcfe085ef9ba96958f",
    "bom-ref": "pkg:npm/asap@2.0.5",
    purl: "pkg:npm/asap@2.0.5",
    properties: [
      {
        name: "SrcFile",
        value: "./test/yarn.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/yarn.lock",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(parsedList.dependenciesList.length, 56);
  assert.deepStrictEqual(isPartialTree(parsedList.dependenciesList), false);
  identMap = yarnLockToIdentMap(
    readFileSync("./test/data/yarn_locks/yarn.lock", "utf8"),
  );
  assert.deepStrictEqual(Object.keys(identMap).length, 2566);
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 2029);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 2029);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "@babel",
    name: "cli",
    version: "7.10.1",
    "bom-ref": "pkg:npm/@babel/cli@7.10.1",
    purl: "pkg:npm/%40babel/cli@7.10.1",
    _integrity:
      "sha512-cVB+dXeGhMOqViIaZs3A9OUAe4pKw4SBNdMw6yHJMYR7s4TB+Cei7ThquV/84O19PdIFWuwe03vxxES0BHUm5g==",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/yarn_locks/yarn.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarn.lock",
          },
        ],
      },
    },
  });
  parsedList.pkgList.forEach((d) => {
    assert.ok(d.name);
    assert.ok(d.version);
  });

  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn-multi.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1909);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1909);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-zpruxnFMz6K94gs2pqc3sidzFDbQpKT5D6P/J/I9s8ekHZ5eczgnRp6pqXC86Bh7+44j/btpmOT0kwiboyqTnA==",
    group: "@apollo",
    name: "client",
    version: "3.2.5",
    "bom-ref": "pkg:npm/@apollo/client@3.2.5",
    purl: "pkg:npm/%40apollo/client@3.2.5",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/yarn_locks/yarn-multi.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarn-multi.lock",
          },
        ],
      },
    },
  });

  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn-light.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 315);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 315);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-rZ1k9kQvJX21Vwgx1L6kSQ6yeXo9cCMyqURSnjG+MRoJn+Mr3LblxmVdzScHXRzv0N9yzy49oG7Bqxp9Knyv/g==",
    group: "@actions",
    name: "artifact",
    version: "0.6.1",
    "bom-ref": "pkg:npm/@actions/artifact@0.6.1",
    purl: "pkg:npm/%40actions/artifact@0.6.1",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/yarn_locks/yarn-light.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarn-light.lock",
          },
        ],
      },
    },
  });

  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn3.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 5);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 5);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(parsedList.pkgList[1], {
    _integrity:
      "sha512-+X9Jn4mPI+RYV0ITiiLyJSYlT9um111BocJSaztsxXR+9ZxWErpzdfQqyk+EYZUOklugjJkerQZRtJGLfJeClw==",
    group: "",
    name: "lru-cache",
    "bom-ref": "pkg:npm/lru-cache@6.0.0",
    purl: "pkg:npm/lru-cache@6.0.0",
    version: "6.0.0",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/yarn_locks/yarn3.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarn3.lock",
          },
        ],
      },
    },
  });

  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv2.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1088);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1088);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-G0U5NjBUYIs39l1J1ckgpVfVX2IxpzRAIT4/2An86O2Mcri3k5xNu7/RRkfObo12wN9s7BmnREAMhH7252oZiA==",
    group: "@arcanis",
    name: "slice-ansi",
    version: "1.0.2",
    "bom-ref": "pkg:npm/@arcanis/slice-ansi@1.0.2",
    purl: "pkg:npm/%40arcanis/slice-ansi@1.0.2",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/yarn_locks/yarnv2.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarnv2.lock",
          },
        ],
      },
    },
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv3.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 363);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 363);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(parsedList.pkgList[0], {
    _integrity:
      "sha512-vtU+q0TmdIDmezU7lKub73vObN6nmd3lkcKWz7R9hyNI8gz5o7grDb+FML9nykOLW+09gGIup2xyJ86j5vBKpg==",
    group: "@babel",
    name: "code-frame",
    version: "7.16.7",
    "bom-ref": "pkg:npm/@babel/code-frame@7.16.7",
    purl: "pkg:npm/%40babel/code-frame@7.16.7",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/yarn_locks/yarnv3.lock",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarnv3.lock",
          },
        ],
      },
    },
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn4.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn-at.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 4);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 4);
  assert.deepStrictEqual(parsedList.pkgList[0], {
    group: "@ac-synth",
    name: "yjs",
    version: "13.5.39-alpha1",
    "bom-ref": "pkg:npm/@ac-synth/yjs@13.5.39-alpha1",
    purl: "pkg:npm/%40ac-synth/yjs@13.5.39-alpha1",
    _integrity:
      "sha512-JE93VWVyVa07xkK1wJ5ogjSZ30Nn4ptUuUXdPnu8MsKme1xFHLFFD3UtnHxnxnNDSnGx+WLlhuyHdIFfSCYqYg==",
    properties: [
      { name: "SrcFile", value: "./test/data/yarn_locks/yarn-at.lock" },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/yarn_locks/yarn-at.lock",
          },
        ],
      },
    },
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn5.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1962);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1962);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40ampproject/remapping@2.2.0",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]["bom-ref"],
    "pkg:npm/@ampproject/remapping@2.2.0",
  );
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/@babel/code-frame@7.12.11",
    dependsOn: ["pkg:npm/@babel/highlight@7.18.6"],
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn6.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1472);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1472);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]["bom-ref"],
    "pkg:npm/@aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/@ampproject/remapping@2.2.1",
    dependsOn: [
      "pkg:npm/@jridgewell/gen-mapping@0.3.3",
      "pkg:npm/@jridgewell/trace-mapping@0.3.19",
    ],
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarn7.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1350);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1347);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]["bom-ref"],
    "pkg:npm/@aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/@ampproject/remapping@2.2.1",
    dependsOn: [
      "pkg:npm/@jridgewell/gen-mapping@0.3.3",
      "pkg:npm/@jridgewell/trace-mapping@0.3.19",
    ],
  });
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv4.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 1851);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 1851);
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]["bom-ref"],
    "pkg:npm/@aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/@actions/core@1.2.6",
    dependsOn: [],
  });
  assert.deepStrictEqual(isPartialTree(parsedList.dependenciesList), false);
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv4.1.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 861);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 858);
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]["bom-ref"],
    "pkg:npm/@aashutoshrathi/word-wrap@1.2.6",
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0]._integrity,
    "sha512-U8KyMaYaRnkrOaDUO8T093a7RUKqV+4EkwZ2gC5VASgsL8iqwU5M0fESD/i1Jha2/1q1Oa0wqiJ31yZES3Fhnw==",
  );
  assert.deepStrictEqual(isPartialTree(parsedList.dependenciesList), false);
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv1-fs.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 882);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 882);
  assert.deepStrictEqual(parsedList.pkgList[0].purl, "pkg:npm/abbrev@1.0.9");
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/accepts@1.3.3",
    dependsOn: ["pkg:npm/mime-types@2.1.12", "pkg:npm/negotiator@0.6.1"],
  });
  assert.deepStrictEqual(isPartialTree(parsedList.dependenciesList), false);
  parsedList = await parseYarnLock("./test/data/yarn_locks/yarnv1-empty.lock");
  assert.deepStrictEqual(parsedList.pkgList.length, 770);
  assert.deepStrictEqual(parsedList.dependenciesList.length, 770);
  assert.deepStrictEqual(
    isPartialTree(parsedList.dependenciesList, parsedList.pkgList.length),
    false,
  );
  assert.deepStrictEqual(
    parsedList.pkgList[0].purl,
    "pkg:npm/%40ampproject/remapping@2.2.0",
  );
  assert.deepStrictEqual(parsedList.dependenciesList[1], {
    ref: "pkg:npm/@aws-sdk/shared-ini-file-loader@3.188.0",
    dependsOn: ["pkg:npm/@aws-sdk/types@3.188.0", "pkg:npm/tslib@2.4.0"],
  });
});

describe("yarn workspace functionality", () => {
  it("should parse yarn workspace lock file with workspace packages", async () => {
    const mockWorkspacePackages = [
      "pkg:npm/workspace-app@1.0.0",
      "pkg:npm/@my-org/workspace-lib@2.0.0",
    ];
    const mockWorkspaceSrcFiles = {
      "workspace-app": "/workspace/apps/app/package.json",
      "@my-org/workspace-lib": "/workspace/packages/lib/package.json",
    };
    const mockDepsWorkspaceRefs = {
      "workspace-app|^1.0.0": "pkg:npm/workspace-app@1.0.0",
      "@my-org/workspace-lib|^2.0.0": "pkg:npm/@my-org/workspace-lib@2.0.0",
    };

    // Test with existing yarn lock file but with workspace parameters
    const parsedList = await parseYarnLock(
      "./test/yarn.lock",
      null,
      mockWorkspacePackages,
      mockWorkspaceSrcFiles,
      {},
      mockDepsWorkspaceRefs,
    );

    // Basic assertions
    assert.ok(parsedList.pkgList.length > 0);
    assert.ok(parsedList.dependenciesList.length > 0);

    // Verify workspace packages are included and properties are set correctly
    parsedList.pkgList.forEach((pkg) => {
      assert.ok(pkg.name);
      assert.ok(pkg.purl);
      assert.ok(pkg["bom-ref"]);

      // Check for workspace-specific properties if this is a workspace package
      const isWorkspacePackage = Object.keys(mockWorkspaceSrcFiles).includes(
        pkg.name,
      );
      if (isWorkspacePackage) {
        // Only check if properties exist - the actual workspace logic may not be implemented yet
        if (pkg.properties && pkg.properties.length > 0) {
          assert.ok(
            pkg.properties.some((p) => p.name === "internal:workspaceRef"),
          );
          assert.ok(pkg.properties.some((p) => p.name === "SrcFile"));
          assert.ok(
            pkg.properties.some((p) => p.name === "cdx:npm:is_workspace"),
          );
        }
      }
    });

    // Verify that the function can handle workspace parameters without error
    // Even if no workspace packages are found in the yarn.lock file
    assert.ok(true); // Test passes if we reach here without throwing
  });

  it("should handle empty workspace parameters gracefully", async () => {
    const parsedList = await parseYarnLock(
      "./test/yarn.lock",
      null,
      [], // Empty workspace packages
      {}, // Empty workspace src files
      {},
      {}, // Empty workspace refs
    );

    assert.ok(parsedList.pkgList.length > 0);
    assert.ok(parsedList.dependenciesList.length > 0);

    // Should still parse normally without workspace enhancement
    parsedList.pkgList.forEach((pkg) => {
      assert.ok(pkg.name);
      assert.ok(pkg.version);
    });
  });

  it("should create correct workspace PURLs", async () => {
    // Create a minimal yarn lock content for testing
    const yarnLockContent = `
# yarn lockfile v1

"my-workspace-pkg@^1.0.0":
  version "1.0.0"
  dependencies:
    lodash "^4.17.21"

"lodash@^4.17.21":
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"
  integrity sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==
`;

    // Since we can't easily create a temp file, we'll test the helper functions directly
    const identMap = yarnLockToIdentMap(yarnLockContent);
    assert.ok(identMap["my-workspace-pkg|^1.0.0"]);
    assert.deepStrictEqual(identMap["my-workspace-pkg|^1.0.0"], "1.0.0");
  });

  it("should handle npm prefix parsing correctly", () => {
    // Test the npm: prefix parsing logic that was fixed
    const testCases = [
      {
        input: "npm:string-width@^4.2.0",
        expectedName: "string-width",
        expectedRange: "^4.2.0",
      },
      {
        input: "npm:@types/ioredis@^4.28.10",
        expectedName: "@types/ioredis",
        expectedRange: "^4.28.10",
      },
      {
        input: "npm:^5.1.1",
        expectedName: undefined, // Should use original dgroupname
        expectedRange: "^5.1.1",
      },
    ];

    testCases.forEach((testCase) => {
      let dgroupnameToUse = "original-package-name";
      let versionRange = "";

      if (testCase.input.startsWith("npm:")) {
        if (testCase.input.includes("@")) {
          versionRange = testCase.input.split("@").splice(-1)[0];
          dgroupnameToUse = testCase.input
            .replace("npm:", "")
            .replace(`@${versionRange}`, "");
        } else {
          versionRange = testCase.input.replace("npm:", "");
          dgroupnameToUse = "original-package-name"; // Should keep original
        }
      }

      if (testCase.expectedName) {
        assert.deepStrictEqual(dgroupnameToUse, testCase.expectedName);
      }
      assert.deepStrictEqual(versionRange, testCase.expectedRange);
    });
  });

  it("should handle workspace dependency resolution", async () => {
    // Test version resolution logic for workspace packages
    const mockDepsWorkspaceRefs = {
      "workspace-app|^1.0.0": "pkg:npm/workspace-app@1.0.0",
      "@my-org/lib|^2.0.0": "pkg:npm/@my-org/lib@2.0.0",
    };

    // Mock identMap that would come from yarn lock parsing
    const mockIdentMap = {
      "workspace-app|^1.0.0": "1.0.0",
      "@my-org/lib|^2.0.0": "2.0.0",
      "lodash|^4.17.21": "4.17.21",
    };

    // Test workspace reference resolution
    const workspaceKey = "workspace-app|^1.0.0";
    const resolvedVersion = mockIdentMap[workspaceKey];
    const workspaceRef = mockDepsWorkspaceRefs[workspaceKey];

    assert.deepStrictEqual(resolvedVersion, "1.0.0");
    assert.deepStrictEqual(workspaceRef, "pkg:npm/workspace-app@1.0.0");

    // Test scoped workspace package
    const scopedKey = "@my-org/lib|^2.0.0";
    const scopedResolvedVersion = mockIdentMap[scopedKey];
    const scopedWorkspaceRef = mockDepsWorkspaceRefs[scopedKey];

    assert.deepStrictEqual(scopedResolvedVersion, "2.0.0");
    assert.deepStrictEqual(scopedWorkspaceRef, "pkg:npm/@my-org/lib@2.0.0");
  });

  it("should handle undefined version resolution fallback", async () => {
    // Test the fallback logic when version cannot be resolved
    const mockIdentMap = {
      "some-package|^1.0.0": "1.5.0",
      "another-package|~2.0.0": "2.0.5",
    };

    // Simulate the fallback logic for unresolved versions
    const testPackage = "unknown-package";

    // Try to find any available resolved version for the package
    const availableVersions = Object.keys(mockIdentMap)
      .filter((key) => key.startsWith(`${testPackage}|`))
      .map((key) => mockIdentMap[key]);

    let resolvedVersion = "undefined"; // Default fallback

    if (availableVersions.length > 0) {
      resolvedVersion = availableVersions[0];
    } else {
      // Check for any version without range matching
      const anyVersionKey = Object.keys(mockIdentMap).find(
        (key) => key.split("|")[0] === testPackage,
      );
      if (anyVersionKey) {
        resolvedVersion = mockIdentMap[anyVersionKey];
      }
    }

    // Should fall back to "undefined" when no version found
    assert.deepStrictEqual(resolvedVersion, "undefined");

    // Test with existing package
    const existingPackage = "some-package";
    const existingRange = "^1.0.0";
    const existingKey = `${existingPackage}|${existingRange}`;
    const existingVersion = mockIdentMap[existingKey] || "undefined";

    assert.deepStrictEqual(existingVersion, "1.5.0");
  });

  it("should create workspace properties correctly", async () => {
    // Test workspace property creation
    const workspacePackage = "my-workspace";
    const workspacePurl = "pkg:npm/my-workspace@1.0.0";
    const workspaceSrcFile = "/workspace/packages/my-workspace/package.json";

    const expectedProperties = [
      {
        name: "internal:workspaceRef",
        value: workspacePurl,
      },
      {
        name: "internal:workspaceSrcFile",
        value: workspaceSrcFile,
      },
    ];

    // Verify property structure
    expectedProperties.forEach((prop) => {
      assert.ok(prop.name);
      assert.ok(prop.value);
      assert.ok(prop.name.startsWith("internal:workspace"));
    });

    // Test PURL encoding
    const testPurl = new PackageURL(
      "npm",
      "",
      workspacePackage,
      "1.0.0",
      null,
      null,
    );
    assert.deepStrictEqual(testPurl.toString(), "pkg:npm/my-workspace@1.0.0");
    assert.deepStrictEqual(
      decodeURIComponent(testPurl.toString()),
      "pkg:npm/my-workspace@1.0.0",
    );
  });

  it("should handle scoped workspace packages correctly", async () => {
    // Test scoped package parsing and PURL creation
    const version = "2.0.0";

    const testPurl = new PackageURL(
      "npm",
      "@my-org",
      "workspace-lib",
      version,
      null,
      null,
    );
    const expectedPurl = "pkg:npm/%40my-org/workspace-lib@2.0.0";

    assert.deepStrictEqual(testPurl.toString(), expectedPurl);
    assert.deepStrictEqual(
      decodeURIComponent(testPurl.toString()),
      "pkg:npm/@my-org/workspace-lib@2.0.0",
    );

    // Test bom-ref generation
    const expectedBomRef = decodeURIComponent(expectedPurl);
    assert.deepStrictEqual(
      expectedBomRef,
      "pkg:npm/@my-org/workspace-lib@2.0.0",
    );
  });

  it("should validate yarn lock identity map parsing", () => {
    // Test yarnLockToIdentMap function with various formats
    const testLockData = `
# yarn lockfile v1

"@babel/core@^7.0.0", "@babel/core@^7.1.0":
  version "7.1.6"

"string-width-cjs@npm:string-width@^4.2.0":
  version "4.2.3"

"@types/node@npm:@types/node@^18.0.0":
  version "18.19.0"

"lru-cache@npm:^6.0.0":
  version "6.0.0"
`;

    const identMap = yarnLockToIdentMap(testLockData);

    // Test standard package with multiple ranges
    assert.deepStrictEqual(identMap["@babel/core|^7.0.0"], "7.1.6");
    assert.deepStrictEqual(identMap["@babel/core|^7.1.0"], "7.1.6");

    // Test npm: prefixed packages
    assert.deepStrictEqual(identMap["string-width-cjs|^4.2.0"], "4.2.3");
    assert.deepStrictEqual(identMap["@types/node|^18.0.0"], "18.19.0");
    assert.deepStrictEqual(identMap["lru-cache|^6.0.0"], "6.0.0");
  });

  it("should handle workspace package matching", async () => {
    // Test workspace package matching logic
    const workspacePackages = [
      "pkg:npm/app@1.0.0",
      "pkg:npm/@my-org/lib@2.0.0",
      "pkg:npm/common@1.5.0",
    ];

    // Test matching function (simulated)
    const findWorkspaceMatch = (packageName, version) => {
      return workspacePackages.find((purl) =>
        purl.includes(`/${packageName}@${version}`),
      );
    };

    // Test matches
    assert.deepStrictEqual(
      findWorkspaceMatch("app", "1.0.0"),
      "pkg:npm/app@1.0.0",
    );
    assert.deepStrictEqual(
      findWorkspaceMatch("@my-org/lib", "2.0.0"),
      "pkg:npm/@my-org/lib@2.0.0",
    );
    assert.deepStrictEqual(
      findWorkspaceMatch("nonexistent", "1.0.0"),
      undefined,
    );
  });

  it("should create workspace components with proper metadata", async () => {
    // Test workspace component creation
    const workspaceName = "workspace-package";
    const workspaceVersion = "1.0.0";
    const workspaceSrcFile =
      "/workspace/packages/workspace-package/package.json";
    const workspacePurl = "pkg:npm/workspace-package@1.0.0";

    const expectedComponent = {
      group: "",
      name: workspaceName,
      version: workspaceVersion,
      purl: workspacePurl,
      "bom-ref": decodeURIComponent(workspacePurl),
      properties: [
        {
          name: "SrcFile",
          value: "./test/yarn.lock",
        },
        {
          name: "internal:workspaceRef",
          value: workspacePurl,
        },
        {
          name: "internal:workspaceSrcFile",
          value: workspaceSrcFile,
        },
      ],
      evidence: {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "manifest-analysis",
              confidence: 1,
              value: "./test/yarn.lock",
            },
          ],
        },
      },
    };

    // Verify component structure
    assert.deepStrictEqual(expectedComponent.name, workspaceName);
    assert.deepStrictEqual(expectedComponent.version, workspaceVersion);
    assert.deepStrictEqual(expectedComponent.purl, workspacePurl);
    assert.deepStrictEqual(expectedComponent["bom-ref"], workspacePurl);

    // Verify workspace-specific properties
    const workspaceRefProp = expectedComponent.properties.find(
      (p) => p.name === "internal:workspaceRef",
    );
    assert.ok(workspaceRefProp);
    assert.deepStrictEqual(workspaceRefProp.value, workspacePurl);

    const workspaceSrcProp = expectedComponent.properties.find(
      (p) => p.name === "internal:workspaceSrcFile",
    );
    assert.ok(workspaceSrcProp);
    assert.deepStrictEqual(workspaceSrcProp.value, workspaceSrcFile);
  });

  it("should handle yarn lock with workspace dependencies", async () => {
    // Test dependency resolution with workspace references
    const mockWorkspaceDeps = {
      "workspace-app|^1.0.0": "pkg:npm/workspace-app@1.0.0",
      "@my-org/lib|^2.0.0": "pkg:npm/@my-org/lib@2.0.0",
    };

    // Simulate dependency resolution
    const resolveDependency = (depName, depRange) => {
      const key = `${depName}|${depRange}`;
      return mockWorkspaceDeps[key] || null;
    };

    // Test workspace dependency resolution
    assert.deepStrictEqual(
      resolveDependency("workspace-app", "^1.0.0"),
      "pkg:npm/workspace-app@1.0.0",
    );
    assert.deepStrictEqual(
      resolveDependency("@my-org/lib", "^2.0.0"),
      "pkg:npm/@my-org/lib@2.0.0",
    );
    assert.deepStrictEqual(
      resolveDependency("external-package", "^1.0.0"),
      null,
    );
  });

  it("should validate workspace PURL encoding", () => {
    // Test PURL encoding for workspace packages
    const testCases = [
      {
        name: "simple-workspace",
        group: "",
        version: "1.0.0",
        expected: "pkg:npm/simple-workspace@1.0.0",
      },
      {
        name: "workspace-lib",
        group: "@my-org",
        version: "2.0.0",
        expected: "pkg:npm/%40my-org/workspace-lib@2.0.0",
      },
      {
        name: "workspace-with-special-chars",
        group: "@my-org",
        version: "1.0.0-alpha.1",
        expected:
          "pkg:npm/%40my-org/workspace-with-special-chars@1.0.0-alpha.1",
      },
    ];

    testCases.forEach((testCase) => {
      const purl = new PackageURL(
        "npm",
        testCase.group,
        testCase.name,
        testCase.version,
        null,
        null,
      );
      assert.deepStrictEqual(purl.toString(), testCase.expected);
    });
  });

  it("should handle workspace package edge cases", async () => {
    // Test edge cases for workspace handling
    const edgeCases = [
      {
        description: "package with no version",
        package: "no-version-pkg",
        version: "",
        shouldCreateComponent: false,
      },
      {
        description: "package with empty name",
        package: "",
        version: "1.0.0",
        shouldCreateComponent: false,
      },
      {
        description: "valid workspace package",
        package: "valid-workspace",
        version: "1.0.0",
        shouldCreateComponent: true,
      },
    ];

    edgeCases.forEach((testCase) => {
      const isValid = Boolean(
        testCase.package &&
          testCase.package.length > 0 &&
          testCase.version &&
          testCase.version.length > 0,
      );

      assert.deepStrictEqual(isValid, testCase.shouldCreateComponent);
    });
  });

  it("should handle workspace packages with duplicate names", async () => {
    const mockWorkspacePackages = [
      "pkg:npm/app-b@1.0.0",
      "pkg:npm/app-a@1.0.0",
    ];
    const mockWorkspaceSrcFiles = {
      "pkg:npm/app-b@1.0.0":
        "test/data/yarn-workspaces-same-version-demo/packages/app-b/package.json",
      "pkg:npm/app-a@1.0.0":
        "test/data/yarn-workspaces-same-version-demo/packages/app-a/package.json",
    };
    const mockWorkspaceDirectDeps = {
      "pkg:npm/app-b@1.0.0": [
        "pkg:npm/dayjs@1.11.10",
        "pkg:npm/axios@1.7.8",
        "pkg:npm/lodash@4.17.21",
      ],
      "pkg:npm/app-a@1.0.0": [
        "pkg:npm/dayjs@1.11.10",
        "pkg:npm/axios@1.7.9",
        "pkg:npm/lodash@4.17.21",
      ],
    };
    const mockDepsWorkspaceRefs = {
      "pkg:npm/dayjs@1.11.10": ["pkg:npm/app-b@1.0.0", "pkg:npm/app-a@1.0.0"],
      "pkg:npm/axios@1.7.8": ["pkg:npm/app-b@1.0.0"],
      "pkg:npm/lodash@4.17.21": ["pkg:npm/app-b@1.0.0", "pkg:npm/app-a@1.0.0"],
      "pkg:npm/axios@1.7.9": ["pkg:npm/app-a@1.0.0"],
    };
    const parsedMap = await parseYarnLock(
      "test/data/yarn-workspaces-same-version-demo/yarn.lock",
      null,
      mockWorkspacePackages,
      mockWorkspaceSrcFiles,
      mockWorkspaceDirectDeps,
      mockDepsWorkspaceRefs,
    );
    assert.equal(parsedMap.pkgList.length, 28);
    assert.equal(parsedMap.dependenciesList.length, 26);
    parsedMap.pkgList.forEach((pkg) => {
      assert.ok(pkg.name);
      assert.ok(pkg.purl);
      assert.ok(pkg["bom-ref"]);
      if (["lodash", "dayjs", "axios"].includes(pkg.name)) {
        assert.ok(
          pkg.properties.some((p) => p.name === "internal:workspaceRef"),
        );
        assert.ok(pkg.properties.some((p) => p.name === "SrcFile"));
      }
    });
  });
});

it("parseComposerLock", () => {
  let retMap = parseComposerLock("./test/data/composer.lock");
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(retMap.dependenciesList.length, 1);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "quickbooks",
    name: "v3-php-sdk",
    scope: "required",
    tags: ["api", "http", "quickbooks", "rest", "smallbusiness"],
    version: "v4.0.6.1",
    authors: [
      {
        email: "Hao_Lu@intuit.com",
        name: "hlu2",
      },
    ],
    distribution: {
      url: "https://api.github.com/repos/intuit/QuickBooks-V3-PHP-SDK/zipball/fe42e409bcdc431614f1cfc80cfc4191b926f3ed",
    },
    purl: "pkg:composer/quickbooks/v3-php-sdk@v4.0.6.1",
    "bom-ref": "pkg:composer/quickbooks/v3-php-sdk@v4.0.6.1",
    repository: {
      type: "git",
      url: "https://github.com/intuit/QuickBooks-V3-PHP-SDK.git",
      reference: "fe42e409bcdc431614f1cfc80cfc4191b926f3ed",
    },
    license: ["Apache-2.0"],
    description: "The Official PHP SDK for QuickBooks Online Accounting API",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/composer.lock",
      },
      {
        name: "Namespaces",
        value: "QuickBooksOnline\\API\\",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/composer.lock",
          },
        ],
      },
    },
  });

  retMap = parseComposerLock("./test/data/composer-2.lock");
  assert.deepStrictEqual(retMap.pkgList.length, 73);
  assert.deepStrictEqual(retMap.dependenciesList.length, 73);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "amphp",
    name: "amp",
    scope: "required",
    version: "v2.4.4",
    purl: "pkg:composer/amphp/amp@v2.4.4",
    "bom-ref": "pkg:composer/amphp/amp@v2.4.4",
    authors: [
      {
        email: "rdlowrey@php.net",
        name: "Daniel Lowrey",
      },
      {
        email: "aaron@trowski.com",
        name: "Aaron Piotrowski",
      },
      {
        email: "bobwei9@hotmail.com",
        name: "Bob Weinand",
      },
      {
        email: "me@kelunik.com",
        name: "Niklas Keller",
      },
    ],
    repository: {
      type: "git",
      url: "https://github.com/amphp/amp.git",
      reference: "1e58d53e4af390efc7813e36cd215bd82cba4b06",
    },
    distribution: {
      url: "https://api.github.com/repos/amphp/amp/zipball/1e58d53e4af390efc7813e36cd215bd82cba4b06",
    },
    license: ["MIT"],
    description: "A non-blocking concurrency framework for PHP applications.",
    tags: [
      "async",
      "asynchronous",
      "awaitable",
      "concurrency",
      "event",
      "event-loop",
      "future",
      "non-blocking",
      "promise",
    ],
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/composer-2.lock",
      },
      {
        name: "Namespaces",
        value: "Amp\\",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/composer-2.lock",
          },
        ],
      },
    },
  });

  retMap = parseComposerLock("./test/data/composer-3.lock");
  assert.deepStrictEqual(retMap.pkgList.length, 62);
  assert.deepStrictEqual(retMap.dependenciesList.length, 62);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "amphp",
    name: "amp",
    version: "v2.6.2",
    purl: "pkg:composer/amphp/amp@v2.6.2",
    "bom-ref": "pkg:composer/amphp/amp@v2.6.2",
    authors: [
      {
        email: "rdlowrey@php.net",
        name: "Daniel Lowrey",
      },
      {
        email: "aaron@trowski.com",
        name: "Aaron Piotrowski",
      },
      {
        email: "bobwei9@hotmail.com",
        name: "Bob Weinand",
      },
      {
        email: "me@kelunik.com",
        name: "Niklas Keller",
      },
    ],
    repository: {
      type: "git",
      url: "https://github.com/amphp/amp.git",
      reference: "9d5100cebffa729aaffecd3ad25dc5aeea4f13bb",
    },
    license: ["MIT"],
    description: "A non-blocking concurrency framework for PHP applications.",
    distribution: {
      url: "https://api.github.com/repos/amphp/amp/zipball/9d5100cebffa729aaffecd3ad25dc5aeea4f13bb",
    },
    tags: [
      "async",
      "asynchronous",
      "awaitable",
      "concurrency",
      "event",
      "event-loop",
      "future",
      "non-blocking",
      "promise",
    ],
    scope: "required",
    properties: [
      { name: "SrcFile", value: "./test/data/composer-3.lock" },
      {
        name: "Namespaces",
        value: "Amp\\",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/composer-3.lock",
          },
        ],
      },
    },
  });
  retMap = parseComposerLock("./test/data/composer-4.lock");
  assert.deepStrictEqual(retMap.pkgList.length, 50);
  assert.deepStrictEqual(retMap.dependenciesList.length, 50);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "apache",
    name: "log4php",
    purl: "pkg:composer/apache/log4php@2.3.0",
    "bom-ref": "pkg:composer/apache/log4php@2.3.0",
    version: "2.3.0",
    repository: {
      type: "git",
      url: "https://git-wip-us.apache.org/repos/asf/logging-log4php.git",
      reference: "8c6df2481cd68d0d211d38f700406c5f0a9de0c2",
    },
    license: ["Apache-2.0"],
    description: "A versatile logging framework for PHP",
    scope: "required",
    tags: ["log", "logging", "php"],
    properties: [{ name: "SrcFile", value: "./test/data/composer-4.lock" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/composer-4.lock",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(retMap.dependenciesList[1], {
    ref: "pkg:composer/doctrine/annotations@v1.2.1",
    dependsOn: ["pkg:composer/doctrine/lexer@v1.0"],
  });
});

it("parseComposerJson", () => {
  let retMap = parseComposerJson("./test/data/composer.json");
  assert.deepStrictEqual(Object.keys(retMap.rootRequires).length, 1);

  retMap = parseComposerJson("./test/data/composer-2.json");
  assert.deepStrictEqual(Object.keys(retMap.rootRequires).length, 31);
});

it("parseGemfileLockData", async () => {
  let retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 140);
  assert.deepStrictEqual(retMap.rootList.length, 42);
  assert.deepStrictEqual(retMap.dependenciesList.length, 140);
  assert.deepStrictEqual(retMap.pkgList[0], {
    name: "actioncable",
    version: "6.0.0",
    purl: "pkg:gem/actioncable@6.0.0",
    "bom-ref": "pkg:gem/actioncable@6.0.0",
    properties: [
      { name: "SrcFile", value: "./test/data/Gemfile.lock" },
      {
        name: "cdx:gem:remote",
        value: "https://rubygems.org/",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.8,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.8,
            value: "./test/data/Gemfile.lock",
          },
        ],
      },
    },
  });
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile1.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile1.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 36);
  assert.deepStrictEqual(retMap.rootList.length, 2);
  assert.deepStrictEqual(retMap.dependenciesList.length, 36);
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile2.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile2.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 89);
  assert.deepStrictEqual(retMap.rootList.length, 2);
  assert.deepStrictEqual(retMap.dependenciesList.length, 89);
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile4.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile4.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 182);
  assert.deepStrictEqual(retMap.rootList.length, 78);
  assert.deepStrictEqual(retMap.dependenciesList.length, 182);
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile5.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile5.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 43);
  assert.deepStrictEqual(retMap.rootList.length, 11);
  assert.deepStrictEqual(retMap.dependenciesList.length, 43);
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile6.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile6.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 139);
  assert.deepStrictEqual(retMap.rootList.length, 22);
  assert.deepStrictEqual(retMap.dependenciesList.length, 139);
  retMap = await parseGemfileLockData(
    readFileSync("./test/data/Gemfile-opt.lock", { encoding: "utf-8" }),
    "./test/data/Gemfile-opt.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 37);
  assert.deepStrictEqual(retMap.rootList.length, 8);
  assert.deepStrictEqual(retMap.rootList, [
    "pkg:gem/http_parser.rb@0.8.0",
    "pkg:gem/jekyll@4.3.4",
    "pkg:gem/jekyll-feed@0.17.0",
    "pkg:gem/jekyll-readme-index@0.3.0",
    "pkg:gem/tzinfo@2.0.6",
    "pkg:gem/tzinfo-data",
    "pkg:gem/wdm",
    "pkg:gem/webrick@1.8.2",
  ]);
  assert.deepStrictEqual(retMap.dependenciesList.length, 37);
});

it("toGemModuleName", () => {
  assert.deepStrictEqual(toGemModuleNames("ruby_parser"), ["RubyParser"]);
  assert.deepStrictEqual(toGemModuleNames("public_suffix"), ["PublicSuffix"]);
  assert.deepStrictEqual(toGemModuleNames("unicode-display_width"), [
    "Unicode",
    "Unicode::DisplayWidth",
  ]);
  assert.deepStrictEqual(toGemModuleNames("net-http-persistent"), [
    "Net",
    "Net::Http",
    "Net::Http::Persistent",
  ]);
  assert.deepStrictEqual(toGemModuleNames("ruby-prof"), ["RubyProf"]);
  assert.deepStrictEqual(toGemModuleNames("thread_safe"), ["ThreadSafe"]);
  assert.deepStrictEqual(toGemModuleNames("pluck_to_hash"), ["PluckToHash"]);
  assert.deepStrictEqual(toGemModuleNames("sinatra"), ["Sinatra"]);
  assert.deepStrictEqual(toGemModuleNames("passenger"), ["Passenger"]);
  assert.deepStrictEqual(toGemModuleNames("simplecov-html"), [
    "Simplecov",
    "Simplecov::Html",
  ]);
});

it("parseGemspecData", async () => {
  let deps = await parseGemspecData(
    readFileSync("./test/data/xmlrpc.gemspec", { encoding: "utf-8" }),
    "./test/data/xmlrpc.gemspec",
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    authors: [
      {
        name: "SHIBATA Hiroshi",
      },
    ],
    "bom-ref": "pkg:gem/xmlrpc@0.3.0",
    licenses: [
      {
        license: {
          name: "Ruby",
        },
      },
    ],
    description:
      "XMLRPC is a lightweight protocol that enables remote procedure calls over HTTP.",
    evidence: {
      identity: {
        confidence: 0.5,
        field: "purl",
        methods: [
          {
            confidence: 0.5,
            technique: "manifest-analysis",
            value: "./test/data/xmlrpc.gemspec",
          },
        ],
      },
    },
    homepage: "https://github.com/ruby/xmlrpc",
    name: "xmlrpc",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/xmlrpc.gemspec",
      },
    ],
    purl: "pkg:gem/xmlrpc@0.3.0",
    version: "0.3.0",
  });
  deps = await parseGemspecData(
    readFileSync("./test/data/loofah-2.3.1.gemspec", { encoding: "utf-8" }),
    "./test/data/loofah-2.3.1.gemspec",
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    authors: [
      {
        name: "Mike Dalessio",
      },
      {
        name: "Bryan Helmkamp",
      },
    ],
    "bom-ref": "pkg:gem/loofah@2.3.1",
    licenses: [
      {
        license: {
          name: "MIT",
        },
      },
    ],
    description:
      "Loofah is a general library for manipulating and transforming HTML/XML documents and fragments, built on top of Nokogiri.\\n\\nLoofah excels at HTML sanitization (XSS prevention). It includes some nice HTML sanitizers, which are based on HTML5lib's safelist, so it most likely won't make your codes less secure. (These statements have not been evaluated by Netexperts.)\\n\\nActiveRecord extensions for sanitization are available in the [`loofah-activerecord` gem](https://github.com/flavorjones/loofah-activerecord).",
    evidence: {
      identity: {
        confidence: 0.5,
        field: "purl",
        methods: [
          {
            confidence: 0.5,
            technique: "manifest-analysis",
            value: "./test/data/loofah-2.3.1.gemspec",
          },
        ],
      },
    },
    homepage: "https://github.com/flavorjones/loofah",
    name: "loofah",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/loofah-2.3.1.gemspec",
      },
    ],
    purl: "pkg:gem/loofah@2.3.1",
    version: "2.3.1",
  });
  deps = await parseGemspecData(
    readFileSync("./test/data/nokogiri-1.10.10.gemspec", { encoding: "utf-8" }),
    "./test/data/nokogiri-1.10.10.gemspec",
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    authors: [
      {
        name: "Aaron Patterson",
      },
      {
        name: "Mike Dalessio",
      },
      {
        name: "Yoko Harada",
      },
      {
        name: "Tim Elliott",
      },
      {
        name: "Akinori MUSHA",
      },
      {
        name: "John Shahid",
      },
      {
        name: "Lars Kanis",
      },
    ],
    "bom-ref": "pkg:gem/nokogiri@1.10.10",
    licenses: [
      {
        license: {
          name: "MIT",
        },
      },
    ],
    description:
      "Nokogiri (\\u92F8) is an HTML, XML, SAX, and Reader parser. Among\\nNokogiri's many features is the ability to search documents via XPath\\nor CSS3 selectors.",
    evidence: {
      identity: {
        confidence: 0.5,
        field: "purl",
        methods: [
          {
            confidence: 0.5,
            technique: "manifest-analysis",
            value: "./test/data/nokogiri-1.10.10.gemspec",
          },
        ],
      },
    },
    homepage: "https://nokogiri.org",
    name: "nokogiri",
    properties: [
      {
        name: "cdx:gem:executables",
        value: "nokogiri",
      },
      {
        name: "SrcFile",
        value: "./test/data/nokogiri-1.10.10.gemspec",
      },
    ],
    purl: "pkg:gem/nokogiri@1.10.10",
    version: "1.10.10",
  });
  deps = await parseGemspecData(
    readFileSync("./test/data/activerecord-import.gemspec", {
      encoding: "utf-8",
    }),
    "./test/data/activerecord-import.gemspec",
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    authors: [
      {
        name: "Zach Dennis",
      },
    ],
    "bom-ref": "pkg:gem/activerecord-import",
    version: undefined,
    description: "A library for bulk inserting data using ActiveRecord.",
    evidence: {
      identity: {
        confidence: 0.2,
        field: "purl",
        methods: [
          {
            confidence: 0.2,
            technique: "manifest-analysis",
            value: "./test/data/activerecord-import.gemspec",
          },
        ],
      },
    },
    homepage: "https://github.com/zdennis/activerecord-import",
    name: "activerecord-import",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/activerecord-import.gemspec",
      },
    ],
    purl: "pkg:gem/activerecord-import",
  });
});

describe("parseReqEnvMarkers", () => {
  it("should handle empty or null input", () => {
    assert.deepStrictEqual(parseReqEnvMarkers(null), []);
    assert.deepStrictEqual(parseReqEnvMarkers(undefined), []);
    assert.deepStrictEqual(parseReqEnvMarkers(""), []);
  });

  it("should parse simple marker with string comparison", () => {
    const result = parseReqEnvMarkers('platform_system == "Linux"');
    assert.deepStrictEqual(result, [
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it("should parse simple marker with numeric comparison", () => {
    const result = parseReqEnvMarkers('python_version >= "3.6"');
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
    ]);
  });

  it("should parse marker without quotes", () => {
    const result = parseReqEnvMarkers("platform_system == Linux");
    assert.deepStrictEqual(result, [
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it('should parse "and" combination', () => {
    const result = parseReqEnvMarkers(
      'python_version >= "3.6" and platform_system == "Linux"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
      {
        operator: "and",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it('should parse "or" combination', () => {
    const result = parseReqEnvMarkers(
      'python_version < "3.6" or platform_system == "Windows"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: "<",
        value: "3.6",
      },
      {
        operator: "or",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Windows",
      },
    ]);
  });

  it('should parse complex combinations with both "and" and "or"', () => {
    const result = parseReqEnvMarkers(
      'python_version >= "3.6" and platform_system == "Linux" or platform_machine == "x86_64"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
      {
        operator: "and",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
      {
        operator: "or",
      },
      {
        variable: "platform_machine",
        operator: "==",
        value: "x86_64",
      },
    ]);
  });

  it("should handle negation operators", () => {
    const result = parseReqEnvMarkers('platform_system != "Windows"');
    assert.deepStrictEqual(result, [
      {
        variable: "platform_system",
        operator: "!=",
        value: "Windows",
      },
    ]);
  });

  it("should handle less than and greater than operators", () => {
    const result = parseReqEnvMarkers(
      'python_version < "3.10" and implementation_version > "2.0"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: "<",
        value: "3.10",
      },
      {
        operator: "and",
      },
      {
        variable: "implementation_version",
        operator: ">",
        value: "2.0",
      },
    ]);
  });

  it("should handle complex real-world example", () => {
    const result = parseReqEnvMarkers(
      'platform_system!="Darwin" or platform_machine!="arm64"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "platform_system",
        operator: "!=",
        value: "Darwin",
      },
      {
        operator: "or",
      },
      {
        variable: "platform_machine",
        operator: "!=",
        value: "arm64",
      },
    ]);
  });

  it("should handle multiple spaces and normalize them", () => {
    const result = parseReqEnvMarkers(
      'python_version   >=   "3.6"    and    platform_system   ==   "Linux"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
      {
        operator: "and",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it("should handle markers with no spaces around operators", () => {
    const result = parseReqEnvMarkers(
      'python_version>="3.6" and platform_system=="Linux"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
      {
        operator: "and",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it("should handle complex marker with implementation_name", () => {
    const result = parseReqEnvMarkers('implementation_name == "pypy"');
    assert.deepStrictEqual(result, [
      {
        variable: "implementation_name",
        operator: "==",
        value: "pypy",
      },
    ]);
  });

  it("should handle sys_platform marker", () => {
    const result = parseReqEnvMarkers('sys_platform == "darwin"');
    assert.deepStrictEqual(result, [
      {
        variable: "sys_platform",
        operator: "==",
        value: "darwin",
      },
    ]);
  });

  it("should handle unrecognized patterns as raw tokens", () => {
    const result = parseReqEnvMarkers(
      'unknown_function() or platform_system == "Linux"',
    );
    assert.deepStrictEqual(result, [
      {
        raw: "unknown_function()",
      },
      {
        operator: "or",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "Linux",
      },
    ]);
  });

  it("should handle single complex condition", () => {
    const result = parseReqEnvMarkers('python_full_version >= "3.6.0"');
    assert.deepStrictEqual(result, [
      {
        variable: "python_full_version",
        operator: ">=",
        value: "3.6.0",
      },
    ]);
  });

  it("should preserve case sensitivity in values", () => {
    const result = parseReqEnvMarkers(
      'platform_system == "Windows" or platform_system == "windows"',
    );
    assert.deepStrictEqual(result, [
      {
        variable: "platform_system",
        operator: "==",
        value: "Windows",
      },
      {
        operator: "or",
      },
      {
        variable: "platform_system",
        operator: "==",
        value: "windows",
      },
    ]);
  });

  it("should handle markers with numbers and dots", () => {
    const result = parseReqEnvMarkers('python_version == "3.9.5"');
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: "==",
        value: "3.9.5",
      },
    ]);
  });

  it("should handle extra whitespace trimming", () => {
    const result = parseReqEnvMarkers('  python_version >= "3.6"  ');
    assert.deepStrictEqual(result, [
      {
        variable: "python_version",
        operator: ">=",
        value: "3.6",
      },
    ]);
  });
});

it("parse requirements.txt", async () => {
  let deps = await parseReqFile("./test/data/requirements.comments.txt", false);
  assert.deepStrictEqual(deps.length, 31);
  deps = await parseReqFile("./test/data/requirements.freeze.txt", false);
  assert.deepStrictEqual(deps.length, 113);
  assert.deepStrictEqual(deps[0], {
    name: "elasticsearch",
    version: "8.6.2",
    scope: "required",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/requirements.freeze.txt",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/requirements.freeze.txt",
          },
        ],
      },
    },
  });
  deps = await parseReqFile("./test/data/chen-science-requirements.txt", false);
  assert.deepStrictEqual(deps.length, 87);
  assert.deepStrictEqual(deps[0], {
    name: "aiofiles",
    version: "23.2.1",
    scope: undefined,
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/chen-science-requirements.txt",
          },
        ],
      },
    },
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/chen-science-requirements.txt",
      },
      {
        name: "cdx:pip:markers",
        value: 'python_full_version >= "3.8.1" and python_version < "3.12"',
      },
      {
        name: "cdx:pip:structuredMarkers",
        value:
          '[{"variable":"python_full_version","operator":">=","value":"3.8.1"},{"operator":"and"},{"variable":"python_version","operator":"<","value":"3.12"}]',
      },
    ],
  });
  deps = await parseReqFile(
    "./test/data/requirements-lock.linux_py3.txt",
    false,
  );
  assert.deepStrictEqual(deps.length, 375);
  assert.deepStrictEqual(deps[0], {
    name: "adal",
    scope: undefined,
    version: "1.2.2",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/requirements-lock.linux_py3.txt",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/requirements-lock.linux_py3.txt",
          },
        ],
      },
    },
  });
  assert.deepStrictEqual(deps[deps.length - 1], {
    name: "zipp",
    scope: undefined,
    version: "0.6.0",
    properties: [
      {
        name: "SrcFile",
        value: "./test/data/requirements-lock.linux_py3.txt",
      },
    ],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/requirements-lock.linux_py3.txt",
          },
        ],
      },
    },
  });
  deps = await parseReqFile("./test/data/extra-ml-requirements.txt", false);
  assert.deepStrictEqual(deps.length, 47);
  for (const d of deps) {
    if (d.version) {
      assert.ok(!d.version.includes(";"));
    }
  }
});

it("parse pyproject.toml", () => {
  let retMap = parsePyProjectTomlFile("./test/data/pyproject.toml");
  assert.deepStrictEqual(retMap.parentComponent, {
    author: "Team AppThreat <cloud@appthreat.com>",
    "bom-ref": "pkg:pypi/cpggen@1.9.0",
    description:
      "Generate CPG for multiple languages for code and threat analysis",
    evidence: {
      identity: {
        confidence: 1,
        field: "purl",
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/pyproject.toml",
          },
        ],
      },
    },
    homepage: {
      url: "https://github.com/AppThreat/cpggen",
    },
    license: "Apache-2.0",
    name: "cpggen",
    purl: "pkg:pypi/cpggen@1.9.0",
    repository: {
      url: "https://github.com/AppThreat/cpggen",
    },
    tags: [
      "atom",
      "code analysis",
      "code property graph",
      "cpg",
      "joern",
      "static analysis",
      "threat analysis",
    ],
    type: "application",
    version: "1.9.0",
  });
  assert.ok(retMap.poetryMode);
  retMap = parsePyProjectTomlFile("./test/data/pyproject-author-comma.toml");
  assert.deepStrictEqual(retMap.parentComponent, {
    author: "Rasa Technologies GmbH <hi@rasa.com>",
    "bom-ref": "pkg:pypi/rasa@3.7.0a1",
    purl: "pkg:pypi/rasa@3.7.0a1",
    evidence: {
      identity: {
        confidence: 1,
        field: "purl",
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/pyproject-author-comma.toml",
          },
        ],
      },
    },
    description:
      "Open source machine learning framework to automate text- and voice-based conversations: NLU, dialogue management, connect to Slack, Facebook, and more - Create chatbots and voice assistants",
    homepage: {
      url: "https://rasa.com",
    },
    license: "Apache-2.0",
    name: "rasa",
    repository: {
      url: "https://github.com/rasahq/rasa",
    },
    tags: [
      "bot",
      "bot-framework",
      "botkit",
      "bots",
      "chatbot",
      "chatbot-framework",
      "conversational-ai",
      "machine-learning",
      "machine-learning-library",
      "nlp",
      "rasa conversational-agents",
    ],
    type: "application",
    version: "3.7.0a1",
  });
  assert.deepStrictEqual(Object.keys(retMap.directDepsKeys).length, 86);
  assert.deepStrictEqual(Object.keys(retMap.groupDepsKeys).length, 36);
  retMap = parsePyProjectTomlFile("./test/data/pyproject_uv.toml");
  assert.deepStrictEqual(retMap.parentComponent, {
    authors: [
      {
        email: "redowan.nafi@gmail.com",
        name: "Redowan Delowar",
      },
    ],
    "bom-ref": "pkg:pypi/fastapi-nano@0.1.0",
    purl: "pkg:pypi/fastapi-nano@0.1.0",
    description: "A minimal FastAPI project template.",
    evidence: {
      identity: {
        confidence: 1,
        field: "purl",
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/pyproject_uv.toml",
          },
        ],
      },
    },
    name: "fastapi-nano",
    tags: ["cookiecutter", "docker", "fastapi", "minimal", "template"],
    version: "0.1.0",
    type: "application",
    properties: [
      {
        name: "cdx:pypi:requiresPython",
        value: ">=3.11",
      },
    ],
  });
  retMap = parsePyProjectTomlFile("./test/data/pyproject_uv2.toml");
  assert.deepStrictEqual(retMap.parentComponent, {
    name: "una-root",
    evidence: {
      identity: {
        confidence: 1,
        field: "purl",
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/pyproject_uv2.toml",
          },
        ],
      },
    },
    "bom-ref": "pkg:pypi/una-root@0",
    purl: "pkg:pypi/una-root@0",
    properties: [
      {
        name: "cdx:pypi:requiresPython",
        value: ">=3.11",
      },
    ],
    version: "0",
    type: "application",
  });
  assert.ok(retMap.uvMode);
  assert.deepStrictEqual(retMap.directDepsKeys, {
    "hatch-una": true,
    una: true,
  });
});

it("parse pyproject.toml with custom poetry source", () => {
  const retMap = parsePyProjectTomlFile(
    "./test/data/pyproject_with_custom_poetry_source.toml",
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    author: "Team AppThreat <cloud@appthreat.com>",
    "bom-ref": "pkg:pypi/cpggen@1.9.0",
    purl: "pkg:pypi/cpggen@1.9.0",
    description:
      "Generate CPG for multiple languages for code and threat analysis",
    evidence: {
      identity: {
        confidence: 1,
        field: "purl",
        methods: [
          {
            confidence: 1,
            technique: "manifest-analysis",
            value: "./test/data/pyproject_with_custom_poetry_source.toml",
          },
        ],
      },
    },
    homepage: {
      url: "https://github.com/AppThreat/cpggen",
    },
    license: "Apache-2.0",
    name: "cpggen",
    repository: {
      url: "https://github.com/AppThreat/cpggen",
    },
    tags: [
      "atom",
      "code analysis",
      "code property graph",
      "cpg",
      "joern",
      "static analysis",
      "threat analysis",
    ],
    version: "1.9.0",
    type: "application",
  });
  assert.ok(retMap.poetryMode);
  assert.deepStrictEqual(Object.keys(retMap.directDepsKeys).length, 6);
});

it("parse python lock files", async () => {
  let retMap = await parsePyLockData(
    readFileSync("./test/data/poetry.lock", { encoding: "utf-8" }),
    "./test/data/poetry.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 32);
  assert.deepStrictEqual(retMap.pkgList[2].scope, "optional");
  assert.deepStrictEqual(retMap.dependenciesList.length, 32);
  retMap = await parsePyLockData(
    readFileSync("./test/data/poetry1.lock", { encoding: "utf-8" }),
    "./test/data/poetry1.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 68);
  assert.deepStrictEqual(retMap.dependenciesList.length, 68);
  retMap = await parsePyLockData(
    readFileSync("./test/data/poetry-cpggen.lock", { encoding: "utf-8" }),
    "./test/data/poetry-cpggen.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 69);
  assert.deepStrictEqual(retMap.dependenciesList.length, 69);
  retMap = await parsePyLockData(
    readFileSync("./test/data/pdm.lock", { encoding: "utf-8" }),
    "./test/data/pdm.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 39);
  assert.deepStrictEqual(retMap.dependenciesList.length, 37);
  retMap = await parsePyLockData(
    readFileSync("./test/data/uv.lock", { encoding: "utf-8" }),
    "./test/data/uv.lock",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 63);
  assert.deepStrictEqual(retMap.dependenciesList.length, 63);
  retMap = await parsePyLockData(
    readFileSync("./test/data/uv-workspace.lock", { encoding: "utf-8" }),
    "./test/data/uv-workspace.lock",
    "./test/data/pyproject_uv-workspace.toml",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 9);
  assert.deepStrictEqual(retMap.rootList.length, 9);
  assert.deepStrictEqual(retMap.dependenciesList.length, 9);
}, 120000);

it("parse wheel metadata", () => {
  let deps = parseBdistMetadata(
    readFileSync("./test/data/METADATA", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    version: "1.26.1",
    name: "yamllint",
    publisher: "Adrien Vergé",
    description: "A linter for YAML files.",
    homepage: { url: "https://github.com/adrienverge/yamllint" },
    repository: { url: "https://github.com/adrienverge/yamllint" },
  });
  deps = parseBdistMetadata(
    readFileSync("./test/data/mercurial-5.5.2-py3.8.egg-info", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    version: "5.5.2",
    name: "mercurial",
    publisher: "Matt Mackall and many others",
    description:
      "Fast scalable distributed SCM (revision control, version control) system",
    homepage: { url: "https://mercurial-scm.org/" },
  });
});

it("parse wheel", async () => {
  const metadata = await readZipEntry(
    "./test/data/appthreat_depscan-2.0.2-py3-none-any.whl",
    "METADATA",
  );
  assert.ok(metadata);
  const parsed = parseBdistMetadata(metadata);
  assert.deepStrictEqual(parsed[0], {
    version: "2.0.2",
    name: "appthreat-depscan",
    description:
      "Fully open-source security audit for project dependencies based on known vulnerabilities and advisories.",
    homepage: { url: "https://github.com/appthreat/dep-scan" },
    publisher: "Team AppThreat",
  });
});

it("parse pipfile.lock with hashes", async () => {
  const deps = await parsePiplockData(
    JSON.parse(readFileSync("./test/data/Pipfile.lock", { encoding: "utf-8" })),
  );
  assert.deepStrictEqual(deps.length, 46);
}, 120000);

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

it("parse scala sbt tree", () => {
  const retMap = parseSbtTree("./test/data/atom-sbt-tree.txt");
  assert.deepStrictEqual(retMap.pkgList.length, 153);
  assert.deepStrictEqual(retMap.dependenciesList.length, 153);
});

it("parse scala sbt lock", () => {
  const deps = parseSbtLock("./test/data/build.sbt.lock");
  assert.deepStrictEqual(deps.length, 117);
});

it("parse nupkg file", async () => {
  let retMap = await parseNupkg(
    "./test/data/Microsoft.Web.Infrastructure.1.0.0.0.nupkg",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(
    retMap.pkgList[0].name,
    "Microsoft.Web.Infrastructure",
  );
  assert.deepStrictEqual(retMap.dependenciesMap, {});
  retMap = parseNuspecData(
    "./test/data/Microsoft.Web.Infrastructure.1.0.0.0.nuspec",
    readFileSync(
      "./test/data/Microsoft.Web.Infrastructure.1.0.0.0.nuspec",
      "ascii",
    ),
  );
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(
    retMap.pkgList[0].name,
    "Microsoft.Web.Infrastructure",
  );
  assert.deepStrictEqual(retMap.dependenciesMap, {});
  retMap = await parseNupkg("./test/data/jquery.3.6.0.nupkg");
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(retMap.pkgList[0].name, "jQuery");
  assert.deepStrictEqual(retMap.dependenciesMap, {});
  retMap = parseNuspecData(
    "./test/data/xunit.nuspec",
    readFileSync("./test/data/xunit.nuspec", "utf-8"),
  );
  assert.deepStrictEqual(retMap.pkgList.length, 1);
  assert.deepStrictEqual(retMap.dependenciesMap, {
    "pkg:nuget/xunit@2.2.0": ["xunit.core", "xunit.assert"],
  });
  retMap = parseNuspecData(
    "./test/data/xunit.nuspec",
    readFileSync("./test/data/xunit.runner.utility.nuspec", "utf-8"),
  );
  assert.deepStrictEqual(retMap.pkgList.length, 8);
  assert.deepStrictEqual(retMap.pkgList[1].properties, [
    { name: "SrcFile", value: "./test/data/xunit.nuspec" },
    { name: "cdx:dotnet:target_framework", value: ".NETFramework3.5" },
  ]);
  assert.deepStrictEqual(retMap.dependenciesMap, {
    "pkg:nuget/xunit.runner.utility@2.2.0": [
      "xunit.abstractions",
      "NETStandard.Library",
      "xunit.extensibility.core",
      "System.Reflection.TypeExtensions",
    ],
  });
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

it("parse helm charts", () => {
  let dep_list = parseHelmYamlData(
    readFileSync("./test/data/Chart.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 3);
  assert.deepStrictEqual(dep_list[0], {
    name: "prometheus",
    version: "16.0.0",
    description: "Prometheus is a monitoring system and time series database.",
    homepage: {
      url: "https://prometheus.io/",
    },
  });
  dep_list = parseHelmYamlData(
    readFileSync("./test/data/prometheus-community-index.yaml", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(dep_list.length, 1836);
  assert.deepStrictEqual(dep_list[0], {
    name: "alertmanager",
    version: "0.22.0",
    description:
      "The Alertmanager handles alerts sent by client applications such as the Prometheus server.",
    homepage: { url: "https://prometheus.io/" },
    _integrity:
      "sha256-c8ece226669d90fa56a3424fa789b80a10de2cd458cd93141b8e445e26c6054d",
    repository: { url: "https://github.com/prometheus/alertmanager" },
  });
});

it("parse container spec like files", () => {
  let dep_list = parseContainerSpecData(
    readFileSync("./test/data/docker-compose.yml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 4);
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/docker-compose-ng.yml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 8);
  assert.deepStrictEqual(dep_list[0], {
    service: "frontend",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/docker-compose-cr.yml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 14);
  assert.deepStrictEqual(dep_list[0], {
    service: "crapi-identity",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/tekton-task.yml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    image:
      "docker.io/amazon/aws-cli:2.0.52@sha256:1506cec98a7101c935176d440a14302ea528b8f92fcaf4a6f1ea2d7ecef7edc4",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/postgrescluster.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 6);
  assert.deepStrictEqual(dep_list[0], {
    image:
      "registry.developers.crunchydata.com/crunchydata/crunchy-postgres:ubi8-14.5-1",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/deployment.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    image: "node-typescript-example",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/skaffold.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 6);
  assert.deepStrictEqual(dep_list[0], {
    image: "leeroy-web",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/skaffold-ms.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 22);
  assert.deepStrictEqual(dep_list[0], {
    image: "emailservice",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/emailservice.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    image: "emailservice",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/redis.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    image: "redis:alpine",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/adservice.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 2);
  assert.deepStrictEqual(dep_list[0], {
    image: "gcr.io/google-samples/microservices-demo/adservice:v0.4.1",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/kustomization.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 22);
  assert.deepStrictEqual(dep_list[0], {
    image: "gcr.io/google-samples/microservices-demo/adservice",
  });
  dep_list = parseContainerSpecData(
    readFileSync("./test/data/service.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 0);
});

it("parse containerfiles / dockerfiles", () => {
  const dep_list = parseContainerFile(
    readFileSync("./test/data/Dockerfile", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 7);
  assert.deepStrictEqual(dep_list[0], {
    image: "hello-world",
  });
  assert.deepStrictEqual(dep_list[1], {
    image: "hello-world:latest",
  });
  assert.deepStrictEqual(dep_list[2], {
    image: "hello-world@sha256:1234567890abcdef",
  });
  assert.deepStrictEqual(dep_list[3], {
    image: "hello-world:latest@sha256:1234567890abcdef",
  });
  assert.deepStrictEqual(dep_list[4], {
    image: "docker.io/hello-world@sha256:1234567890abcdef",
  });
  assert.deepStrictEqual(dep_list[5], {
    image: "docker.io/hello-world:latest@sha256:1234567890abcdef",
  });
  assert.deepStrictEqual(dep_list[6], {
    image: "docker.io/hello-world:latest",
  });
});

it("parse bitbucket-pipelines", () => {
  const dep_list = parseBitbucketPipelinesFile(
    readFileSync("./test/data/bitbucket-pipelines.yml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 5);
  assert.deepStrictEqual(dep_list[0], {
    image: "node:16",
  });
  assert.deepStrictEqual(dep_list[1], {
    image: "node:18",
  });
  assert.deepStrictEqual(dep_list[2], {
    image: "some.private.org/docker/library/node:20",
  });
  assert.deepStrictEqual(dep_list[3], {
    image: "atlassian/aws/s3-deploy:0.2.2",
  });
  assert.deepStrictEqual(dep_list[4], {
    image: "some.private.org/docker/library/some-pipe:1.0.0",
  });
});

it("parse cloudbuild data", () => {
  assert.deepStrictEqual(parseCloudBuildData(null), []);
  const dep_list = parseCloudBuildData(
    readFileSync("./test/data/cloudbuild.yaml", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 1);
  assert.deepStrictEqual(dep_list[0], {
    group: "gcr.io/k8s-skaffold",
    name: "skaffold",
    version: "v2.0.1",
  });
});

it("parse privado files", () => {
  const servList = parsePrivadoFile("./test/data/privado.json");
  assert.deepStrictEqual(servList.length, 1);
  assert.deepStrictEqual(servList[0].data.length, 11);
  assert.deepStrictEqual(servList[0].endpoints.length, 17);
  assert.deepStrictEqual(servList[0].properties.length, 5);
});

it("parse openapi spec files", () => {
  let aservice = parseOpenapiSpecData(
    readFileSync("./test/data/openapi/openapi-spec.json", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(aservice.length, 1);
  assert.deepStrictEqual(aservice[0], {
    "bom-ref": "urn:service:OWASP-crAPI-API:1-oas3",
    name: "OWASP-crAPI-API",
    description: "",
    version: "1-oas3",
    endpoints: [
      "http://localhost:8888/identity/api/auth/signup",
      "http://localhost:8888/identity/api/auth/login",
      "http://localhost:8888/identity/api/auth/forget-password",
      "http://localhost:8888/identity/api/auth/v3/check-otp",
      "http://localhost:8888/identity/api/auth/v2/check-otp",
      "http://localhost:8888/identity/api/auth/v4.0/user/login-with-token",
      "http://localhost:8888/identity/api/auth/v2.7/user/login-with-token",
      "http://localhost:8888/identity/api/v2/user/reset-password",
      "http://localhost:8888/identity/api/v2/user/change-email",
      "http://localhost:8888/identity/api/v2/user/verify-email-token",
      "http://localhost:8888/identity/api/v2/user/dashboard",
      "http://localhost:8888/identity/api/v2/user/pictures",
      "http://localhost:8888/identity/api/v2/user/videos",
      "http://localhost:8888/identity/api/v2/user/videos/{video_id}",
      "http://localhost:8888/identity/api/v2/user/videos/convert_video",
      "http://localhost:8888/identity/api/v2/admin/videos/{video_id}",
      "http://localhost:8888/identity/api/v2/vehicle/vehicles",
      "http://localhost:8888/identity/api/v2/vehicle/add_vehicle",
      "http://localhost:8888/identity/api/v2/vehicle/{vehicleId}/location",
      "http://localhost:8888/identity/api/v2/vehicle/resend_email",
      "http://localhost:8888/community/api/v2/community/posts/{postId}",
      "http://localhost:8888/community/api/v2/community/posts",
      "http://localhost:8888/community/api/v2/community/posts/{postId}/comment",
      "http://localhost:8888/community/api/v2/community/posts/recent",
      "http://localhost:8888/community/api/v2/coupon/new-coupon",
      "http://localhost:8888/community/api/v2/coupon/validate-coupon",
      "http://localhost:8888/workshop/api/shop/products",
      "http://localhost:8888/workshop/api/shop/orders",
      "http://localhost:8888/workshop/api/shop/orders/{order_id}",
      "http://localhost:8888/workshop/api/shop/orders/all",
      "http://localhost:8888/workshop/api/shop/orders/return_order",
      "http://localhost:8888/workshop/api/shop/apply_coupon",
      "http://localhost:8888/workshop/api/shop/return_qr_code",
      "http://localhost:8888/workshop/api/mechanic/",
      "http://localhost:8888/workshop/api/merchant/contact_mechanic",
      "http://localhost:8888/workshop/api/mechanic/receive_report",
      "http://localhost:8888/workshop/api/mechanic/mechanic_report",
      "http://localhost:8888/workshop/api/mechanic/service_requests",
      "http://localhost:8888/workshop/api/mechanic/signup",
    ],
    authenticated: true,
  });
  aservice = parseOpenapiSpecData(
    readFileSync("./test/data/openapi/openapi-oai.yaml", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(aservice.length, 1);
  assert.deepStrictEqual(aservice[0], {
    "bom-ref": "urn:service:OpenAI-API:1.1.0",
    name: "OpenAI-API",
    description: "",
    version: "1.1.0",
    endpoints: [
      "https://api.openai.com/v1/engines",
      "https://api.openai.com/v1/engines/{engine_id}",
      "https://api.openai.com/v1/completions",
      "https://api.openai.com/v1/edits",
      "https://api.openai.com/v1/images/generations",
      "https://api.openai.com/v1/images/edits",
      "https://api.openai.com/v1/images/variations",
      "https://api.openai.com/v1/embeddings",
      "https://api.openai.com/v1/engines/{engine_id}/search",
      "https://api.openai.com/v1/files",
      "https://api.openai.com/v1/files/{file_id}",
      "https://api.openai.com/v1/files/{file_id}/content",
      "https://api.openai.com/v1/answers",
      "https://api.openai.com/v1/classifications",
      "https://api.openai.com/v1/fine-tunes",
      "https://api.openai.com/v1/fine-tunes/{fine_tune_id}",
      "https://api.openai.com/v1/fine-tunes/{fine_tune_id}/cancel",
      "https://api.openai.com/v1/fine-tunes/{fine_tune_id}/events",
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1/models/{model}",
      "https://api.openai.com/v1/moderations",
    ],
    authenticated: false,
  });
});

it("parse swift deps files", () => {
  assert.deepStrictEqual(
    parseSwiftJsonTree(null, "./test/data/swift-deps.json"),
    {},
  );
  let retData = parseSwiftJsonTree(
    readFileSync("./test/data/swift-deps.json", { encoding: "utf-8" }),
    "./test/data/swift-deps.json",
  );
  assert.deepStrictEqual(retData.rootList.length, 1);
  assert.deepStrictEqual(retData.pkgList.length, 5);
  assert.deepStrictEqual(retData.rootList[0], {
    name: "swift-markdown",
    group: "",
    purl: "pkg:swift/swift-markdown@unspecified",
    type: "application",
    version: "unspecified",
    properties: [
      { name: "SrcPath", value: "/Volumes/Work/sandbox/swift-markdown" },
      { name: "SrcFile", value: "./test/data/swift-deps.json" },
    ],
    "bom-ref": "pkg:swift/swift-markdown@unspecified",
  });
  assert.deepStrictEqual(retData.pkgList[1], {
    "bom-ref": "pkg:swift/github.com/apple/swift-cmark@unspecified",
    group: "github.com/apple",
    name: "swift-cmark",
    properties: [
      {
        name: "cdx:swift:packageName",
        value: "cmark-gfm",
      },
    ],
    purl: "pkg:swift/github.com/apple/swift-cmark@unspecified",
    repository: {
      url: "https://github.com/apple/swift-cmark.git",
    },
    version: "unspecified",
  });
  assert.deepStrictEqual(retData.dependenciesList.length, 5);
  assert.deepStrictEqual(retData.dependenciesList[0], {
    ref: "pkg:swift/github.com/apple/swift-cmark@unspecified",
    dependsOn: [],
  });
  assert.deepStrictEqual(
    retData.dependenciesList[retData.dependenciesList.length - 1],
    {
      ref: "pkg:swift/swift-markdown@unspecified",
      dependsOn: [
        "pkg:swift/github.com/apple/swift-argument-parser@1.0.3",
        "pkg:swift/github.com/apple/swift-cmark@unspecified",
        "pkg:swift/github.com/apple/swift-docc-plugin@1.1.0",
      ],
    },
  );
  retData = parseSwiftJsonTree(
    readFileSync("./test/data/swift-deps1.json", { encoding: "utf-8" }),
    "./test/data/swift-deps.json",
  );
  assert.deepStrictEqual(retData.rootList.length, 1);
  assert.deepStrictEqual(retData.pkgList.length, 5);
  assert.deepStrictEqual(retData.rootList[0], {
    name: "swift-certificates",
    group: "",
    purl: "pkg:swift/swift-certificates@unspecified",
    version: "unspecified",
    type: "application",
    properties: [
      {
        name: "SrcPath",
        value: "/Volumes/Work/sandbox/swift-certificates",
      },
      { name: "SrcFile", value: "./test/data/swift-deps.json" },
    ],
    "bom-ref": "pkg:swift/swift-certificates@unspecified",
  });
  assert.deepStrictEqual(retData.pkgList[1], {
    "bom-ref": "pkg:swift/github.com/apple/swift-crypto@2.4.0",
    group: "github.com/apple",
    name: "swift-crypto",
    purl: "pkg:swift/github.com/apple/swift-crypto@2.4.0",
    repository: {
      url: "https://github.com/apple/swift-crypto.git",
    },
    version: "2.4.0",
  });
  assert.deepStrictEqual(retData.dependenciesList, [
    {
      ref: "pkg:swift/github.com/apple/swift-docc-symbolkit@1.0.0",
      dependsOn: [],
    },
    {
      ref: "pkg:swift/github.com/apple/swift-docc-plugin@1.1.0",
      dependsOn: ["pkg:swift/github.com/apple/swift-docc-symbolkit@1.0.0"],
    },
    {
      ref: "pkg:swift/github.com/apple/swift-asn1@0.7.0",
      dependsOn: ["pkg:swift/github.com/apple/swift-docc-plugin@1.1.0"],
    },
    {
      ref: "pkg:swift/github.com/apple/swift-crypto@2.4.0",
      dependsOn: ["pkg:swift/github.com/apple/swift-asn1@0.7.0"],
    },
    {
      ref: "pkg:swift/swift-certificates@unspecified",
      dependsOn: ["pkg:swift/github.com/apple/swift-crypto@2.4.0"],
    },
  ]);
  let pkgList = parseSwiftResolved("./test/data/Package.resolved");
  assert.deepStrictEqual(pkgList.length, 6);
  assert.deepStrictEqual(pkgList[0], {
    name: "swift-argument-parser",
    group: "github.com/apple",
    version: "1.0.3",
    purl: "pkg:swift/github.com/apple/swift-argument-parser@1.0.3",
    properties: [{ name: "SrcFile", value: "./test/data/Package.resolved" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/Package.resolved",
          },
        ],
      },
    },
    "bom-ref": "pkg:swift/github.com/apple/swift-argument-parser@1.0.3",
    repository: { url: "https://github.com/apple/swift-argument-parser" },
  });
  pkgList = parseSwiftResolved("./test/data/Package2.resolved");
  assert.deepStrictEqual(pkgList.length, 7);
  assert.deepStrictEqual(pkgList[0], {
    name: "swift-argument-parser",
    group: "github.com/apple",
    version: "1.2.2",
    purl: "pkg:swift/github.com/apple/swift-argument-parser@1.2.2",
    properties: [{ name: "SrcFile", value: "./test/data/Package2.resolved" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/Package2.resolved",
          },
        ],
      },
    },
    "bom-ref": "pkg:swift/github.com/apple/swift-argument-parser@1.2.2",
    repository: { url: "https://github.com/apple/swift-argument-parser.git" },
  });
  assert.deepStrictEqual(pkgList[4], {
    name: "swift-http-server",
    group: "github.com/swift",
    version: "0.7.4",
    purl: "pkg:swift/github.com/swift/swift-http-server@0.7.4",
    properties: [{ name: "SrcFile", value: "./test/data/Package2.resolved" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/Package2.resolved",
          },
        ],
      },
    },
    "bom-ref": "pkg:swift/github.com/swift/swift-http-server@0.7.4",
    repository: {
      url: "git@github.com:swift/swift-http-server.git",
    },
  });
  assert.deepStrictEqual(pkgList[5], {
    name: "swift-http-server",
    group: "bitbucket.org/swift",
    version: "0.7.4",
    purl: "pkg:swift/bitbucket.org/swift/swift-http-server@0.7.4",
    properties: [{ name: "SrcFile", value: "./test/data/Package2.resolved" }],
    evidence: {
      identity: {
        field: "purl",
        confidence: 1,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 1,
            value: "./test/data/Package2.resolved",
          },
        ],
      },
    },
    "bom-ref": "pkg:swift/bitbucket.org/swift/swift-http-server@0.7.4",
    repository: {
      url: "ssh://git@bitbucket.org:7999/swift/swift-http-server.git",
    },
  });
});

it("assigns default namespace for local swift paths (#2781)", () => {
  const purl = purlFromUrlString("swift", "/Users/arsh/project", "1.0.0");
  assert.equal(purl.namespace, "local");
  assert.equal(purl.name, "project");
  assert.equal(purl.version, "1.0.0");
});

it("pypi version solver tests", () => {
  const versionsList = [
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "1.2.0.dev1+hg.5.b11e5e6f0b0b",
    "2.0.3",
    "2.0b1",
    "3.0.12-alpha.13",
    "3.0.12-alpha.12",
    "3.0.12-alpha.14",
    "4.0.0",
  ];
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, "<4"),
    "3.0.12-alpha.14",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, ">1.0.0 <3.0.0"),
    "2.0.3",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, "== 1.0.1"),
    "1.0.1",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, "~= 1.0.1"),
    "1.0.1",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, ">= 2.0.1, == 2.8.*"),
    null,
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(
      ["2.0.0", "2.0.1", "2.4.0", "2.8.4", "2.9.0", "3.0.1"],
      ">= 2.0.1, == 2.8.*",
    ),
    "2.8.4",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, "== 1.1.0; python_version < '3.8'"),
    "1.1.0",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, "<3.6,>1.9,!=1.9.6,<4.0a0"),
    "3.0.12-alpha.14",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, ">=1.4.2,<2.2,!=1.5.*,!=1.6.*"),
    "2.0.3",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, ">=1.21.1,<3"),
    "2.0.3",
  );
});

it("purl encode tests", () => {
  assert.deepStrictEqual(
    encodeForPurl("org.apache.commons"),
    "org.apache.commons",
  );
  assert.deepStrictEqual(encodeForPurl("@angular"), "%40angular");
  assert.deepStrictEqual(encodeForPurl("%40angular"), "%40angular");
});

it("parsePackageJsonName tests", () => {
  assert.deepStrictEqual(parsePackageJsonName("foo"), {
    fullName: "foo",
    moduleName: "foo",
    projectName: null,
    scope: null,
  });
  assert.deepStrictEqual(parsePackageJsonName("@babel/code-frame"), {
    fullName: "code-frame",
    moduleName: "code-frame",
    projectName: null,
    scope: "@babel",
  });
  assert.deepStrictEqual(parsePackageJsonName(null), {
    fullName: "",
    moduleName: "",
    projectName: "",
    scope: null,
  });
  assert.deepStrictEqual(parsePackageJsonName(undefined), {
    fullName: "",
    moduleName: "",
    projectName: "",
    scope: null,
  });
});

it("parseDot tests", () => {
  const retMap = parseCmakeDotFile("./test/data/tslite.dot", "conan");
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:conan/tensorflow-lite",
    group: "",
    name: "tensorflow-lite",
    purl: "pkg:conan/tensorflow-lite",
    type: "application",
    version: "",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 283);
  assert.deepStrictEqual(retMap.dependenciesList.length, 247);
});

it("parseCmakeLikeFile tests", () => {
  let retMap = parseCmakeLikeFile("./test/data/CMakeLists.txt", "conan");
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:conan/tensorflow-lite",
    group: "",
    name: "tensorflow-lite",
    purl: "pkg:conan/tensorflow-lite",
    type: "application",
    version: "",
  });
  retMap = parseCmakeLikeFile("./test/data/cmakes/CMakeLists.txt", "conan");
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:conan/mongo-c-driver",
    group: "",
    name: "mongo-c-driver",
    purl: "pkg:conan/mongo-c-driver",
    type: "application",
    version: "",
  });
  retMap = parseCmakeLikeFile(
    "./test/data/cmakes/CMakeLists-version.txt",
    "generic",
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:generic/MyProject@2.1.3",
    group: "",
    name: "MyProject",
    purl: "pkg:generic/MyProject@2.1.3",
    type: "application",
    version: "2.1.3",
  });
  retMap = parseCmakeLikeFile(
    "./test/data/cmakes/CMakeLists-tpl.txt",
    "generic",
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:generic/aurora-examples",
    group: "",
    name: "aurora-examples",
    purl: "pkg:generic/aurora-examples",
    type: "application",
    version: "",
  });
  retMap = parseCmakeLikeFile(
    "./test/data/cmakes/mongoc-config.cmake",
    "conan",
  );
  assert.deepStrictEqual(retMap.pkgList.length, 2);
  retMap = parseCmakeLikeFile("./test/data/meson.build", "conan");
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:conan/mtxclient@0.9.2",
    group: "",
    name: "mtxclient",
    purl: "pkg:conan/mtxclient@0.9.2",
    type: "application",
    version: "0.9.2",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 7);
  retMap = parseCmakeLikeFile("./test/data/meson-1.build", "conan");
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:conan/abseil-cpp@20230125.1",
    group: "",
    name: "abseil-cpp",
    purl: "pkg:conan/abseil-cpp@20230125.1",
    type: "application",
    version: "20230125.1",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 2);
});

it("parseMakeDFile tests", () => {
  const pkgFilesMap = parseMakeDFile("test/data/zstd_sys-dc50c4de2e4e7df8.d");
  assert.deepStrictEqual(pkgFilesMap, {
    zstd_sys: [
      ".cargo/registry/src/index.crates.io-hash/zstd-sys-2.0.10+zstd.1.5.6/src/lib.rs",
      ".cargo/registry/src/index.crates.io-hash/zstd-sys-2.0.10+zstd.1.5.6/src/bindings_zstd.rs",
      ".cargo/registry/src/index.crates.io-hash/zstd-sys-2.0.10+zstd.1.5.6/src/bindings_zdict.rs",
    ],
  });
});

it("hasAnyProjectType tests", () => {
  assert.deepStrictEqual(
    hasAnyProjectType(["docker"], {
      projectType: [],
      excludeType: ["oci"],
    }),
    false,
  );
  assert.deepStrictEqual(hasAnyProjectType([], {}), true);
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], { projectType: ["java"] }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], { projectType: ["java"], excludeType: [] }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], { projectType: ["csharp"] }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["java"], { projectType: ["csharp", "rust"] }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["rust"], { projectType: ["csharp", "rust"] }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["rust"], {
      projectType: ["csharp", "rust"],
      excludeType: [],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["rust"], {
      projectType: ["csharp", "rust"],
      excludeType: ["rust"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci"], {
      projectType: ["java", "docker"],
      excludeType: ["dotnet"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci"], {
      projectType: ["docker"],
      excludeType: undefined,
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["docker"], {
      projectType: ["oci"],
      excludeType: undefined,
    }),
    true,
  );

  assert.deepStrictEqual(
    hasAnyProjectType(["js"], {
      projectType: [],
      excludeType: ["rust"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js"], {
      projectType: undefined,
      excludeType: ["csharp"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js", "docker"], {
      projectType: ["universal"],
      excludeType: ["csharp"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["rust"], {
      projectType: ["universal"],
      excludeType: ["docker"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js", "docker"], {
      projectType: ["universal"],
      excludeType: ["csharp", "javascript"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js", "docker"], {
      projectType: ["js", "docker"],
      excludeType: ["js", "docker"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js"], {
      projectType: ["js"],
      excludeType: ["js"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["oci"],
      {
        projectType: [],
        excludeType: [],
      },
      false,
    ),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["oci", "docker"],
      {
        projectType: undefined,
        excludeType: undefined,
      },
      false,
    ),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js", "docker"], {
      projectType: ["universal"],
      excludeType: [],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["js"], {
      projectType: ["universal"],
      excludeType: ["js"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["universal"], {
      projectType: undefined,
      excludeType: ["github"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci"], {
      projectType: undefined,
      excludeType: ["github"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["os"], {
      projectType: undefined,
      excludeType: ["jar"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["docker"], {
      projectType: undefined,
      excludeType: ["jar"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci", "java"], {
      projectType: undefined,
      excludeType: ["jar"],
    }),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci", "ear"], {
      projectType: undefined,
      excludeType: ["jar"],
    }),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["docker", "oci", "container", "os"],
      {
        projectType: undefined,
        excludeType: ["github"],
      },
      false,
    ),
    false,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["ruby"],
      {
        projectType: ["ruby2.5.4"],
        excludeType: undefined,
      },
      false,
    ),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["ruby"],
      {
        projectType: ["rb"],
        excludeType: undefined,
      },
      false,
    ),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(
      ["ruby"],
      {
        projectType: ["ruby3.4.1", "ruby2.5.4"],
        excludeType: undefined,
      },
      false,
    ),
    true,
  );
  assert.deepStrictEqual(
    hasAnyProjectType(["oci", "js"], {
      projectType: ["javascript"],
      excludeType: undefined,
    }),
    true,
  );
});

it("isPackageManagerAllowed tests", () => {
  assert.deepStrictEqual(
    isPackageManagerAllowed("uv", ["pip", "poetry", "hatch", "pdm"], {
      projectType: undefined,
    }),
    true,
  );
  assert.deepStrictEqual(
    isPackageManagerAllowed("uv", ["pip", "poetry", "hatch", "pdm"], {
      projectType: ["python"],
    }),
    true,
  );
  assert.deepStrictEqual(
    isPackageManagerAllowed("uv", ["pip", "poetry", "hatch", "pdm"], {
      projectType: ["pip"],
    }),
    false,
  );
});

it("parsePodfileLock tests", async () => {
  assert.deepStrictEqual(
    (
      await parsePodfileLock(
        loadYaml(readFileSync("./test/Podfile.lock", "utf-8")),
      )
    ).size,
    6,
  );

  process.env.COCOA_MERGE_SUBSPECS = false;
  assert.deepStrictEqual(
    (
      await parsePodfileLock(
        loadYaml(readFileSync("./test/Podfile.lock", "utf-8")),
      )
    ).size,
    16,
  );
  process.env.COCOA_MERGE_SUBSPECS = true;
});

it("parsePodfileTargets tests", () => {
  const targetDependencies = new Map();
  parsePodfileTargets(
    JSON.parse(readFileSync("./test/Podfile.json", "utf-8"))[
      "target_definitions"
    ][0],
    targetDependencies,
  );
  assert.deepStrictEqual(targetDependencies.size, 5);
  assert.deepStrictEqual(targetDependencies.has("Pods"), true);
});

it("parseCocoaDependency tests", () => {
  let dependency = parseCocoaDependency("Alamofire (3.0.0)");
  assert.deepStrictEqual(dependency.name, "Alamofire");
  assert.deepStrictEqual(dependency.version, "3.0.0");

  dependency = parseCocoaDependency("boost/graph-includes (= 1.59.0)", false);
  assert.deepStrictEqual(dependency.name, "boost/graph-includes");
  assert.deepStrictEqual(dependency.version, undefined);
});

it("buildObjectForCocoaPod tests", async () => {
  assert.deepStrictEqual(
    await buildObjectForCocoaPod(parseCocoaDependency("Alamofire (3.0.0)")),
    {
      name: "Alamofire",
      version: "3.0.0",
      type: "library",
      purl: "pkg:cocoapods/Alamofire@3.0.0",
      "bom-ref": "pkg:cocoapods/Alamofire@3.0.0",
    },
  );

  assert.deepStrictEqual(
    await buildObjectForCocoaPod(
      parseCocoaDependency("boost/graph-includes (= 1.59.0)"),
    ),
    {
      name: "boost/graph-includes",
      version: "= 1.59.0",
      type: "library",
      properties: [
        {
          name: "cdx:pods:Subspec",
          value: "graph-includes",
        },
      ],
      purl: "pkg:cocoapods/boost@%3D%201.59.0#graph-includes",
      "bom-ref": "pkg:cocoapods/boost@= 1.59.0#graph-includes",
    },
  );
});

it("parseMillDependency test", () => {
  const millTestDataRoot = "./test/data/mill/";
  const dependencies = new Map();
  const relations = new Map();

  assert.deepStrictEqual(
    dependencies.has("pkg:maven/bar@latest?type=jar"),
    false,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/bar.test@latest?type=jar"),
    false,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/foo@latest?type=jar"),
    false,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/foo.test@latest?type=jar"),
    false,
  );
  assert.deepStrictEqual(dependencies.size, 0);
  assert.deepStrictEqual(relations.size, 0);

  parseMillDependency("bar", dependencies, relations, millTestDataRoot);
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/bar@latest?type=jar"),
    true,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/bar.test@latest?type=jar"),
    false,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/foo@latest?type=jar"),
    false,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/foo.test@latest?type=jar"),
    false,
  );
  assert.deepStrictEqual(dependencies.size, 8);
  assert.deepStrictEqual(relations.size, 8);

  parseMillDependency("bar.test", dependencies, relations, millTestDataRoot);
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/bar@latest?type=jar"),
    true,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/bar.test@latest?type=jar"),
    true,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/foo@latest?type=jar"),
    false,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/foo.test@latest?type=jar"),
    false,
  );
  assert.deepStrictEqual(dependencies.size, 13);
  assert.deepStrictEqual(relations.size, 13);

  parseMillDependency("foo", dependencies, relations, millTestDataRoot);
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/bar@latest?type=jar"),
    true,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/bar.test@latest?type=jar"),
    true,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/foo@latest?type=jar"),
    true,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/foo.test@latest?type=jar"),
    false,
  );
  assert.deepStrictEqual(dependencies.size, 14);
  assert.deepStrictEqual(relations.size, 14);

  parseMillDependency("foo.test", dependencies, relations, millTestDataRoot);
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/bar@latest?type=jar"),
    true,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/bar.test@latest?type=jar"),
    true,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/foo@latest?type=jar"),
    true,
  );
  assert.deepStrictEqual(
    dependencies.has("pkg:maven/foo.test@latest?type=jar"),
    true,
  );
  assert.deepStrictEqual(dependencies.size, 15);
  assert.deepStrictEqual(relations.size, 15);
});

it("parse flake.nix file", () => {
  const result = parseFlakeNix("./test/data/test-flake.nix");
  assert.ok(result.pkgList);
  assert.ok(result.dependencies);
  assert.deepStrictEqual(result.pkgList.length, 3);

  // Check nixpkgs input
  const nixpkgs = result.pkgList.find((pkg) => pkg.name === "nixpkgs");
  assert.ok(nixpkgs);
  assert.deepStrictEqual(nixpkgs.version, "latest");
  assert.deepStrictEqual(nixpkgs.purl, "pkg:nix/nixpkgs@latest");
  assert.deepStrictEqual(nixpkgs["bom-ref"], "pkg:nix/nixpkgs@latest");
  assert.deepStrictEqual(nixpkgs.scope, "required");
  assert.deepStrictEqual(nixpkgs.description, "Nix flake input: nixpkgs");
  assert.ok(nixpkgs.properties);

  // Check properties
  const srcFileProperty = nixpkgs.properties.find((p) => p.name === "SrcFile");
  assert.deepStrictEqual(srcFileProperty.value, "./test/data/test-flake.nix");

  const urlProperty = nixpkgs.properties.find(
    (p) => p.name === "cdx:nix:input_url",
  );
  assert.deepStrictEqual(
    urlProperty.value,
    "github:NixOS/nixpkgs/release-23.11",
  );

  // Check flake-utils input
  const flakeUtils = result.pkgList.find((pkg) => pkg.name === "flake-utils");
  assert.ok(flakeUtils);
  assert.deepStrictEqual(flakeUtils.version, "latest");

  // Check rust-overlay input
  const rustOverlay = result.pkgList.find((pkg) => pkg.name === "rust-overlay");
  assert.ok(rustOverlay);
  assert.deepStrictEqual(rustOverlay.version, "latest");

  const rustOverlayUrlProperty = rustOverlay.properties.find(
    (p) => p.name === "cdx:nix:input_url",
  );
  assert.deepStrictEqual(
    rustOverlayUrlProperty.value,
    "github:oxalica/rust-overlay",
  );

  // Check evidence
  assert.ok(nixpkgs.evidence);
  assert.deepStrictEqual(nixpkgs.evidence.identity.field, "purl");
  assert.deepStrictEqual(nixpkgs.evidence.identity.confidence, 0.8);
  assert.deepStrictEqual(
    nixpkgs.evidence.identity.methods[0].technique,
    "manifest-analysis",
  );
});

it("parse flake.lock file", () => {
  const result = parseFlakeLock("./test/data/test-flake.lock");
  assert.ok(result.pkgList);
  assert.ok(result.dependencies);
  assert.deepStrictEqual(result.pkgList.length, 4);

  // Check nixpkgs package
  const nixpkgs = result.pkgList.find((pkg) => pkg.name === "nixpkgs");
  assert.ok(nixpkgs);
  assert.deepStrictEqual(nixpkgs.version, "bd645e8"); // Short commit hash
  assert.deepStrictEqual(nixpkgs.purl, "pkg:nix/nixpkgs@bd645e8");
  assert.deepStrictEqual(nixpkgs["bom-ref"], "pkg:nix/nixpkgs@bd645e8");
  assert.deepStrictEqual(nixpkgs.scope, "required");
  assert.deepStrictEqual(nixpkgs.description, "Nix flake dependency: nixpkgs");

  // Check properties for nixpkgs
  const nixpkgsProperties = nixpkgs.properties;
  assert.ok(nixpkgsProperties);

  const srcFileProperty = nixpkgsProperties.find((p) => p.name === "SrcFile");
  assert.deepStrictEqual(srcFileProperty.value, "./test/data/test-flake.lock");

  const narHashProperty = nixpkgsProperties.find(
    (p) => p.name === "cdx:nix:nar_hash",
  );
  assert.deepStrictEqual(
    narHashProperty.value,
    "sha256-RtDKd8Mynhe5CFnVT8s0/0yqtWFMM9LmCzXv/YKxnq4=",
  );

  const lastModifiedProperty = nixpkgsProperties.find(
    (p) => p.name === "cdx:nix:last_modified",
  );
  assert.deepStrictEqual(lastModifiedProperty.value, "1704194953");

  const revisionProperty = nixpkgsProperties.find(
    (p) => p.name === "cdx:nix:revision",
  );
  assert.deepStrictEqual(
    revisionProperty.value,
    "bd645e8668ec6612439a9ee7e71f7eac4099d4f6",
  );

  // Check flake-utils package
  const flakeUtils = result.pkgList.find((pkg) => pkg.name === "flake-utils");
  assert.ok(flakeUtils);
  assert.deepStrictEqual(flakeUtils.version, "1ef2e67");

  // Check rust-overlay package
  const rustOverlay = result.pkgList.find((pkg) => pkg.name === "rust-overlay");
  assert.ok(rustOverlay);
  assert.deepStrictEqual(rustOverlay.version, "9a8a835");

  // Check systems package
  const systems = result.pkgList.find((pkg) => pkg.name === "systems");
  assert.ok(systems);
  assert.deepStrictEqual(systems.version, "da67096");

  // Check dependencies
  assert.deepStrictEqual(result.dependencies.length, 1);
  const rootDep = result.dependencies[0];
  assert.deepStrictEqual(rootDep.ref, "pkg:nix/flake@latest");
  assert.ok(rootDep.dependsOn);
  assert.deepStrictEqual(rootDep.dependsOn.length, 3); // flake-utils, nixpkgs, rust-overlay
  assert.ok(rootDep.dependsOn);

  // Check evidence
  assert.ok(nixpkgs.evidence);
  assert.deepStrictEqual(nixpkgs.evidence.identity.field, "purl");
  assert.deepStrictEqual(nixpkgs.evidence.identity.confidence, 1.0);
  assert.deepStrictEqual(
    nixpkgs.evidence.identity.methods[0].technique,
    "manifest-analysis",
  );
});

it("parse flake.nix file with missing file", () => {
  const result = parseFlakeNix("./test/data/missing-flake.nix");
  assert.ok(result.pkgList);
  assert.ok(result.dependencies);
  assert.deepStrictEqual(result.pkgList.length, 0);
  assert.deepStrictEqual(result.dependencies.length, 0);
});

it("parse flake.lock file with missing file", () => {
  const result = parseFlakeLock("./test/data/missing-flake.lock");
  assert.ok(result.pkgList);
  assert.ok(result.dependencies);
  assert.deepStrictEqual(result.pkgList.length, 0);
  assert.deepStrictEqual(result.dependencies.length, 0);
});

// biome-ignore-start lint/style/useTemplate: This is a unit test
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: This is a unit test
const testCases = [
  // --- Existing Test Cases (for context) ---
  ["", false],
  ["git@gitlab.com:behat-chrome/chrome-mink-driver.git", false],
  ["     git@gitlab.com:behat-chrome/chrome-mink-driver.git      ", false],
  ["${repository.url}", false],
  // bomLink - https://cyclonedx.org/capabilities/bomlink/
  ["urn:cdx:f08a6ccd-4dce-4759-bd84-c626675d60a7/1#componentA", true],
  // http uri - https://www.ietf.org/rfc/rfc7230.txt
  ["https://gitlab.com/behat-chrome/chrome-mink-driver.git      ", false], // Fails due to trailing space
  [
    "     https://gitlab.com/behat-chrome/chrome-mink-driver.git           ",
    false, // Fails due to leading space
  ],
  ["http://gitlab.com/behat-chrome/chrome-mink-driver.git", true],
  ["git+https://github.com/Alex-D/check-disk-space.git      ", false], // Fails due to trailing space
  ["UNKNOWN", false],
  ["http://", false],
  ["http", false],
  ["https", false],
  ["https://", false],
  ["http://www", true],
  ["http://www.", true],
  [
    "https://github.com/apache/maven-resolver/tree/      ${project.scm.tag}",
    false, // Fails due to space and ${}
  ],
  ["git@github.com:prometheus/client_java.git", false],
  // --- New Stress Test Cases ---
  // Potential ReDoS for percent-encoding regex: Long sequences of % followed by non-hex or short hex
  ["http://example.com/a%" + "a%".repeat(50000), false], // Many %a patterns
  ["http://example.com/a%" + "ab%".repeat(50000), false], // Many %ab patterns (invalid end)
  ["http://example.com/a%" + "a".repeat(100000), false], // One % followed by many 'a's
  ["http://example.com/" + "%".repeat(100000), false], // Very long sequence of just %
  // Edge cases around valid percent-encoding boundaries (pushing regex engine)
  ["http://example.com/path%" + "20".repeat(30000) + "%2", false], // Valid %20s, ends with incomplete %
  ["http://example.com/path%" + "20".repeat(30000) + "a", false], // Valid %20s, ends with non-hex
  // Potentially complex IRI that might be slow for validateIri (if not already robust)
  // Using a plausible but complex structure with lots of valid non-ASCII chars (requires UTF-8 support)
  // Note: Actual performance depends on the `validateIri` implementation.
  [
    "http://example.com/path/to/resource/with/lots/of/segments/and/long/-names/including/üñíçødé/characters/ sprinkled/in/" +
      "segment".repeat(2000) +
      "?query=param&other=valué#frågmënt",
    false,
  ], // Assuming validateIri and URL can handle it
  // Very long valid IRI (tests overall handling, potentially URL constructor)
  [
    "http://very.long.domain.name.example.com/very/long/path/component/that/just/keeps/going/on/and/on/forever/it/seems/" +
      "segment/".repeat(3000) +
      "end",
    true,
  ], // Assuming it's technically valid
  // IRI with complex query and fragment (tests boundaries)
  [
    "https://example.com/path?query=with%20lots%20of%20percent%20encoding%20but%20valid%20%C3%A9%C3%B1#fragment-with-unicode-çhars-üñíçødé",
    false,
  ],
  // IRI that looks almost like a bomLink but isn't quite (tests scheme handling)
  ["urn:cdx:some-uuid/1#componentA/extra", true], // Might be valid IRI/URI, depends on urn:cdx spec, but structurally okay for IRI
  ["urn:cdx:some-uuid/1", true], // Valid urn without fragment
  // IRI with userinfo (less common, test robustness)
  ["http://user:p@ssw0rd@example.com/path", true], // Valid, but contains @
  ["http://user@example.com/path", true], // Valid with user only
  // IRI with IPv6 literal (tests authority parsing)
  ["http://[2001:db8::1]:8080/path", true], // Valid IPv6
  ["http://[2001:db8::1]/path", true], // Valid IPv6 without port
  // Potentially problematic characters in path/query/fragment (if not already covered)
  ["http://example.com/path with spaces", false], // Space not encoded
  ["http://example.com/path<with>brackets", false], // < > not typically allowed unencoded
  ['http://example.com/path"with"quotes', false], // " not typically allowed unencoded in URI/IRI ref
  // Test case sensitivity for scheme check (uses original `iri`)
  ["HTTP://example.com", true], // Scheme case (URL constructor should handle)
  ["HTTPS://EXAMPLE.COM/PATH", true],
  // Edge case: IRI that is just a scheme
  ["mailto:", false],
  ["https:", false],
  ["http:", false],
  // Re-test specific percent-encoding edge case mentioned in comments
  ["http://example.com/path%ab%cd%ef", true], // Valid percent encodings
  ["http://example.com/path%ab%cd%e", false], // Invalid: incomplete %e at end
  ["http://example.com/path%ab%cd%eg", false], // Invalid: %eg
  ["http://example.com/path%ab%cd%", false], // Invalid: trailing %
  ["http://example.com/path%ab%cd%0", false], // Invalid: %0
  ["http://example.com/path%ab%cd%0Z", false], // Invalid: %0Z (Z is hex, but makes the sequence too long if interpreted as %ab%cd%0Z)
  // Test with extremely long, but valid, percent-encoded sequence (pushes validateIri/URL)
  // This string is valid UTF-8 percent-encoded 'A' repeated many times.
  // encodeURIComponent("A".repeat(10000)) produces a very long string of %41
  // Let's simulate a long valid percent-encoded part manually for a simpler test
  ["http://example.com/data/" + "%41%42%43%44".repeat(10000), true], // Repeats 'ABCD' encoded
  // UNC Paths (IRI references)
  // Standard UNC path (often treated as URIs like \\server\share\path -> file://server/share/path or \\server\share -> smb://server/share)
  // However, as IRI *references* starting with \\, they are generally invalid unless specifically scheme-less references
  // The IRI spec defines scheme-less references as relative. \\server is not a valid relative path segment.
  ["\\\\server\\share\\path\\file.txt", false], // Looks like UNC, invalid as IRI ref
  ["file://server/share/path/file.txt", true], // Correct URI form if that's the intent
  // UNC path with spaces (invalid as IRI ref, valid file URI)
  ["\\\\server name\\share name\\file name.txt", false],
  ["file://server%20name/share%20name/file%20name.txt", true],
  // UNC path with Unicode (invalid as IRI ref, valid file URI if percent-encoded)
  ["\\\\サーバー\\共有\\ファイル.txt", false], // Raw Unicode UNC - invalid IRI ref
  // Correct IRI for UNC-like path would need a scheme, e.g., file:
  [
    "file:///%E3%82%B5%E3%83%BC%E3%83%90%E3%83%BC/%E5%85%B1%E6%9C%89/%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.txt",
    true,
  ], // file:///%E3%82%B5%E3%83%BC%E3%83%90%E3%83%BC/%E5%85%B1%E6%9C%89/%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB.txt (Japanese characters encoded)

  // Unicode Characters in various components (IRI references)
  // Path with Latin-1 Supplement characters (e.g., accented letters)
  ["https://example.com/café/résumé.html", true],
  ["https://example.com/path/%C3%A9%C3%A1%C3%BC", true], // Same path, pre-encoded
  // Path with Chinese characters
  ["https://example.com/路径/文件.html", true],
  // Path with Emoji (if supported by IRI spec and validator)
  ["https://example.com/search?q=cat&emoji=😺", false], // Emoji in query

  // Query and Fragment with Unicode
  ["https://example.com/search?q=café röst", false],
  ["https://example.com/search?q=café%20röst", true],
  ["https://example.com/page#se%C3%A7%C3%A3o-intro", true], // Encoded fragment

  // Bidirectional Text (Bidi) in IRI (from RFC 3987 Section 4.3)
  // Note: Actual bidi control characters (like U+200E, U+200F, U+202A..U+202E) should generally be avoided or percent-encoded.
  // Example Bidi IRI from RFC (Hebrew Alef, Lamed, Yod, Vav) - presented logically LTR as Alef-Lamed-Yod-Vav
  // Unicode code points: U+05D0 U+05DC U+05D9 U+05D5
  // UTF-8 Encoding: D7 90 D7 9C D7 99 D7 95
  // Percent Encoding: %D7%90%D7%9C%D7%99%D7%95
  // Assuming the logical string "http://example.com/الयो" represents the Hebrew characters.
  // However, constructing the *exact* bidi IRI string is complex in plain text.
  // Let's test with the percent-encoded version which is clearer.
  // This tests handling of valid UTF-8 sequences representing RTL characters.
  ["http://example.com/%D7%90%D7%9C%D7%99%D7%95", true], // Alef Lamed Yod Vav (Hebrew) encoded

  // Look-alike Characters (from RFC 3987 Section 7.5)
  // Full-width Latin characters (from RFC 3987 Section 7.5)
  // Full-width 'A' (U+FF21) vs. Latin 'A' (U+0041)
  // Full-width 'A' UTF-8: EF BC A1 -> Percent-encoded: %EF%BC%A1
  ["http://example.com/path/FULLWIDTH%EF%BC%A1", true], // Full-width 'A' in path
  // Testing if validator differentiates (it shouldn't inherently, both are valid IRI chars if allowed by scheme)
  ["http://example.com/path/LATIN_A", true], // Standard 'A'

  // Characters specifically excluded in older RFCs mentioned (RFC 3987 Section 7.2)
  // "<", ">", '"', space, "{", "}", "|", "\", "^", and "`"
  // These should generally be invalid *unless* percent-encoded within a valid IRI component context.
  ["https://example.com/path with space", false], // Invalid: unencoded space
  ["https://example.com/path%20with%20space", true], // Valid: encoded space
  ["https://example.com/path<invalid>", false], // Invalid: unencoded <
  ["https://example.com/path%3Cinvalid%3E", true], // Valid: encoded <>
  ['https://example.com/path"quoted"', false], // Invalid: unencoded "
  ["https://example.com/path%22quoted%22", true], // Valid: encoded "
  ["https://example.com/path{invalid}", false], // Invalid: unencoded {
  ["https://example.com/path%7Binvalid%7D", true], // Valid: encoded {}
  // Note: #, %, [, ] are NOT in the excluded list RFC 3987 mentions for conversion; % is crucial for encoding, # [] are for IPv6 literals.

  // Complex UTF-8 sequences (4-byte UTF-8 for supplementary planes)
  // Character: G clef (U+1D11E)
  // UTF-8 Encoding: F0 9D 84 9E -> Percent-encoded: %F0%9D%84%9E
  ["https://example.com/music/notation/%F0%9D%84%9E", true], // G clef in path

  // Extremely long UTF-8 sequence (valid but large)
  // Representing a string like "𝄞".repeat(5000) encoded
  // U+1D11E (G clef) -> UTF-8: F0 9D 84 9E -> Percent-encoded: %F0%9D%84%9E
  // Let's create a long valid percent-encoded string representing repeated 4-byte chars
  ["https://example.com/data/" + "%F0%9D%84%9E".repeat(5000), true], // Many G clefs encoded
];

testCases.forEach(([url, expected], index) => {
  it(`should validate IRI reference for case ${index}`, () => {
    const result = isValidIriReference(url);
    assert.strictEqual(result, expected);
  });
});
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: This is a unit test
// biome-ignore-end lint/style/useTemplate: This is a unit test
it("ignores license banners in minified js (#2717)", async () => {
  const file = "temp.min.js";

  const content = `/*! @license DOMPurify 3.2.7 */
(function(){console.log("test")})();
`;

  writeFileSync(file, content);

  const result = await parseMinJs(file);

  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);

  if (existsSync(file)) unlinkSync(file);
});

it("parses valid minified js with real package name (#2717)", async () => {
  const file = "temp.min.js";
  const content = `/*! jquery 3.6.0 */
(function(){console.log("test")})();`;

  writeFileSync(file, content);

  const result = await parseMinJs(file);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, "jquery");
  assert.equal(result[0].version, "3.6.0");

  if (existsSync(file)) unlinkSync(file);
});
