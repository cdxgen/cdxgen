import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, it } from "poku";

import {
  applyCargoDependencyKindMetadata,
  buildCargoNativeLibraryComponents,
  cargoPurlToComponentKey,
  cargoUpstreamVersionFromCrateVersion,
  normalizeCargoDepKind,
  parseCargoMetadataResolve,
  parseCargoPackageId,
  resolveCargoVendoredLibraryVersion,
  rollupCargoDependencyKinds,
} from "./parsers-rust.js";
import {
  parseCargoAuditableData,
  parseCargoData,
  parseCargoDependencyData,
  parseCargoManifestDependencyData,
  parseCargoTomlData,
} from "./utils.js";

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
        alg: "SHA-256",
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
        name: "internal:SrcFile",
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
        alg: "SHA-256",
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
        name: "internal:SrcFile",
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
  // The lock file also lists base64 0.11.0, which depends on nothing.
  const base64 = dependencyData.find(
    (dependency) => dependency.ref === "pkg:cargo/base64@0.5.1",
  );
  assert.deepStrictEqual(purlIsPackage(base64.dependsOn[0], "byteorder"), true);
  assert.deepStrictEqual(base64.dependsOn[0], "pkg:cargo/byteorder@1.3.1");
  assert.deepStrictEqual(
    dependencyData.find(
      (dependency) => dependency.ref === "pkg:cargo/base64@0.11.0",
    )?.dependsOn,
    [],
  );

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

it("parse cargo lock dependencies keeps the edges of every version of a crate", () => {
  // Cargo names the version when a crate appears more than once. Every
  // version needs its own entry: keying the packages by name left only the
  // last one's edges and orphaned r-efi 5.3.0 and wasip2.
  const cargoFileContent = `version = 4

[[package]]
name = "cfg-if"
version = "1.0.5"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "getrandom"
version = "0.2.17"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = ["cfg-if"]

[[package]]
name = "getrandom"
version = "0.3.4"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = ["cfg-if", "r-efi 5.3.0", "wasip2"]

[[package]]
name = "getrandom"
version = "0.4.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = ["cfg-if", "r-efi 6.0.0"]

[[package]]
name = "r-efi"
version = "5.3.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "r-efi"
version = "6.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "wasip2"
version = "1.0.4+wasi-0.2.12"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "app"
version = "0.1.0"
dependencies = ["getrandom 0.2.17", "getrandom 0.3.4", "getrandom 0.4.3", "r-efi"]
`;
  const dependencyData = parseCargoDependencyData(cargoFileContent);
  const edges = Object.fromEntries(
    dependencyData.map((entry) => [entry.ref, [...entry.dependsOn].sort()]),
  );
  assert.strictEqual(dependencyData.length, 8);
  assert.deepStrictEqual(edges["pkg:cargo/getrandom@0.2.17"], [
    "pkg:cargo/cfg-if@1.0.5",
  ]);
  assert.deepStrictEqual(edges["pkg:cargo/getrandom@0.3.4"], [
    "pkg:cargo/cfg-if@1.0.5",
    "pkg:cargo/r-efi@5.3.0",
    "pkg:cargo/wasip2@1.0.4+wasi-0.2.12",
  ]);
  assert.deepStrictEqual(edges["pkg:cargo/getrandom@0.4.3"], [
    "pkg:cargo/cfg-if@1.0.5",
    "pkg:cargo/r-efi@6.0.0",
  ]);
  // A bare name that matches more than one version cannot be resolved.
  assert.deepStrictEqual(edges["pkg:cargo/app@0.1.0"], [
    "pkg:cargo/getrandom@0.2.17",
    "pkg:cargo/getrandom@0.3.4",
    "pkg:cargo/getrandom@0.4.3",
  ]);
});

it("parse cargo toml", async () => {
  assert.deepStrictEqual(await parseCargoTomlData(null), []);
  let dep_list = await parseCargoTomlData("./test/data/Cargo1.toml");
  assert.ok(dep_list.length >= 6);
  assert.strictEqual(dep_list[0].name, "unwind");
  const coreDep = dep_list.find((pkg) => pkg.name === "core");
  assert.ok(coreDep);
  assert.strictEqual(coreDep.version, "path+../core");
  assert.strictEqual(
    coreDep.properties.find((property) => property.name === "cdx:cargo:path")
      ?.value,
    "../core",
  );
  assert.strictEqual(
    coreDep.properties.find(
      (property) => property.name === "cdx:cargo:dependencyKind",
    )?.value,
    "runtime",
  );
  const libcDep = dep_list.find((pkg) => pkg.name === "libc");
  assert.ok(libcDep);
  assert.strictEqual(
    libcDep.properties.find(
      (property) => property.name === "cdx:cargo:defaultFeatures",
    )?.value,
    "false",
  );
  assert.strictEqual(
    libcDep.properties.find(
      (property) => property.name === "cdx:cargo:dependencyFeatures",
    )?.value,
    '["rustc-dep-of-std"]',
  );
  const ccDep = dep_list.find((pkg) => pkg.name === "cc");
  assert.ok(ccDep);
  assert.strictEqual(
    ccDep.properties.find(
      (property) => property.name === "cdx:cargo:dependencyKind",
    )?.value,
    "build",
  );
  dep_list = await parseCargoTomlData("./test/data/Cargo2.toml");
  assert.deepStrictEqual(dep_list.length, 4);
  assert.strictEqual(dep_list[0].name, "quiche-fuzz");
  const quicheDep = dep_list.find((pkg) => pkg.name === "quiche");
  assert.ok(quicheDep);
  assert.strictEqual(quicheDep.version, "path+../quiche");
  assert.strictEqual(
    quicheDep.properties.find((property) => property.name === "cdx:cargo:path")
      ?.value,
    "../quiche",
  );
  assert.strictEqual(
    quicheDep.properties.find(
      (property) => property.name === "cdx:cargo:dependencyFeatures",
    )?.value,
    '["fuzzing"]',
  );
  const libfuzzerDep = dep_list.find((pkg) => pkg.name === "libfuzzer-sys");
  assert.ok(libfuzzerDep);
  assert.strictEqual(
    libfuzzerDep.properties.find(
      (property) => property.name === "cdx:cargo:git",
    )?.value,
    "https://github.com/rust-fuzz/libfuzzer-sys.git",
  );
  dep_list = await parseCargoTomlData("./test/data/Cargo3.toml", true);
  assert.ok(dep_list.length >= 10);
});

it("parse cargo toml target and dev dependency metadata", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-cargo-"));
  const cargoTomlFile = path.join(tmpDir, "Cargo.toml");
  writeFileSync(
    cargoTomlFile,
    `[package]
name = "demo"
version = "1.0.0"

[dependencies]
serde = { version = "1.0.0", optional = true }

[dev-dependencies]
insta = "1.0.0"

[target.'cfg(target_os = "linux")'.dependencies]
nix = "0.29.0"

[target.'cfg(target_os = "linux")'.build-dependencies]
bindgen = { version = "0.70.0", default-features = false }
`,
  );
  try {
    const depList = await parseCargoTomlData(cargoTomlFile);
    const serdeDep = depList.find((pkg) => pkg.name === "serde");
    const instaDep = depList.find((pkg) => pkg.name === "insta");
    const bindgenDep = depList.find((pkg) => pkg.name === "bindgen");
    assert.strictEqual(serdeDep.scope, "optional");
    assert.strictEqual(
      serdeDep.properties.find(
        (property) => property.name === "cdx:cargo:optional",
      )?.value,
      "true",
    );
    assert.strictEqual(instaDep.scope, "excluded");
    assert.strictEqual(
      bindgenDep.properties.find(
        (property) => property.name === "cdx:cargo:dependencyKind",
      )?.value,
      "build",
    );
    assert.strictEqual(
      bindgenDep.properties.find(
        (property) => property.name === "cdx:cargo:target",
      )?.value,
      'cfg(target_os = "linux")',
    );
    assert.strictEqual(
      bindgenDep.properties.find(
        (property) => property.name === "cdx:cargo:defaultFeatures",
      )?.value,
      "false",
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("parse cargo toml captures git dependency metadata", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-cargo-git-"));
  const cargoTomlFile = path.join(tmpDir, "Cargo.toml");
  writeFileSync(
    cargoTomlFile,
    `[package]
name = "demo"
version = "1.0.0"

[dependencies]
git-crate = { git = "https://github.com/acme/git-crate.git", branch = "main" }
`,
  );
  try {
    const depList = await parseCargoTomlData(cargoTomlFile);
    const gitDep = depList.find((pkg) => pkg.name === "git-crate");
    assert.ok(gitDep);
    assert.strictEqual(
      gitDep.version,
      "git+https://github.com/acme/git-crate.git",
    );
    assert.strictEqual(
      gitDep.properties.find((property) => property.name === "cdx:cargo:git")
        ?.value,
      "https://github.com/acme/git-crate.git",
    );
    assert.strictEqual(
      gitDep.properties.find(
        (property) => property.name === "cdx:cargo:gitBranch",
      )?.value,
      "main",
    );
    assert.strictEqual(
      gitDep.properties.find(
        (property) => property.name === "cdx:cargo:dependencyKind",
      )?.value,
      "runtime",
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("parse cargo virtual workspace with inherited package and dependency metadata", async () => {
  const workspaceDir = "./test/data/cargo-workspace-repotest";
  const workspaceToml = path.join(workspaceDir, "Cargo.toml");
  const normalizePathForAssertion = (value) => value?.replaceAll("\\", "/");
  const depList = await parseCargoTomlData(workspaceToml);
  assert.strictEqual(depList[0].name, "cargo-workspace-repotest");
  assert.strictEqual(depList[0].version, "workspace");
  assert.strictEqual(
    depList[0].properties.find(
      (property) => property.name === "cdx:cargo:manifestMode",
    )?.value,
    "virtual-workspace",
  );
  const memberPackage = depList.find((pkg) => pkg.name === "cli");
  assert.ok(memberPackage);
  assert.strictEqual(memberPackage.version, "1.2.3");
  assert.strictEqual(memberPackage.license, "Apache-2.0");
  assert.strictEqual(
    memberPackage.repository?.url,
    "https://github.com/example/cargo-workspace-repotest",
  );
  const coreDep = depList.find(
    (pkg) =>
      pkg.name === "core" &&
      pkg.properties.some(
        (property) => property.name === "cdx:cargo:workspaceDependency",
      ),
  );
  assert.ok(coreDep);
  assert.strictEqual(coreDep.version, "path+crates/core");
  assert.strictEqual(
    coreDep.properties.find(
      (property) => property.name === "cdx:cargo:workspaceDependency",
    )?.value,
    "true",
  );
  assert.strictEqual(
    coreDep.properties.find(
      (property) => property.name === "cdx:cargo:workspaceDependencyResolved",
    )?.value,
    "true",
  );
  assert.strictEqual(
    coreDep.properties.find(
      (property) => property.name === "cdx:cargo:resolvedWorkspaceMember",
    )?.value,
    "core",
  );
  assert.ok(
    normalizePathForAssertion(
      coreDep.properties.find(
        (property) => property.name === "cdx:cargo:resolvedMemberPath",
      )?.value,
    )?.endsWith("/test/data/cargo-workspace-repotest/crates/core/Cargo.toml"),
  );
  const buildHelperDep = depList.find(
    (pkg) =>
      pkg.name === "build-helper" &&
      pkg.properties.some(
        (property) => property.name === "cdx:cargo:workspaceDependency",
      ),
  );
  assert.ok(buildHelperDep);
  assert.strictEqual(buildHelperDep.version, "path+crates/build-helper");
  assert.strictEqual(
    buildHelperDep.properties.find(
      (property) => property.name === "cdx:cargo:dependencyKind",
    )?.value,
    "build",
  );
  assert.strictEqual(
    buildHelperDep.properties.find(
      (property) => property.name === "cdx:cargo:workspaceDependencyResolved",
    )?.value,
    "true",
  );
  assert.strictEqual(
    buildHelperDep.properties.find(
      (property) => property.name === "cdx:cargo:resolvedWorkspaceMember",
    )?.value,
    "build-helper",
  );
  assert.ok(
    normalizePathForAssertion(
      buildHelperDep.properties.find(
        (property) => property.name === "cdx:cargo:resolvedMemberPath",
      )?.value,
    )?.endsWith(
      "/test/data/cargo-workspace-repotest/crates/build-helper/Cargo.toml",
    ),
  );
  const ccDep = depList.find((pkg) => pkg.name === "cc");
  assert.ok(ccDep);
  // `cc = "1.2.0"` is a caret requirement, not a pin, so the component keeps
  // no version and a version-less purl (cdxgen issue #4716).
  assert.strictEqual(ccDep.version, undefined);
  assert.strictEqual(ccDep.purl, "pkg:cargo/cc");
});

it("parse cargo manifest keeps a requirement range out of the component version", async () => {
  const depList = await parseCargoTomlData(
    path.join("test", "data", "cargo-manifest-ranges", "Cargo.toml"),
    false,
  );
  const requirementMap = Object.fromEntries(
    depList.map((pkg) => [pkg.name, { version: pkg.version, purl: pkg.purl }]),
  );
  assert.deepStrictEqual(requirementMap, {
    repro: { version: "0.1.0", purl: "pkg:cargo/repro@0.1.0" },
    serde: { version: undefined, purl: "pkg:cargo/serde" },
    tokio: { version: undefined, purl: "pkg:cargo/tokio" },
    regex: { version: undefined, purl: "pkg:cargo/regex" },
    tracing: { version: undefined, purl: "pkg:cargo/tracing" },
    itoa: { version: "1.0.11", purl: "pkg:cargo/itoa@1.0.11" },
    either: { version: undefined, purl: "pkg:cargo/either" },
    prerel: { version: "1.0.0-beta.2", purl: "pkg:cargo/prerel@1.0.0-beta.2" },
    memchr: { version: undefined, purl: "pkg:cargo/memchr" },
    local: { version: undefined, purl: "pkg:cargo/local" },
    gitonly: {
      version: "git+https://github.com/acme/gitonly.git",
      purl: "pkg:cargo/gitonly@git%2Bhttps:%2F%2Fgithub.com%2Facme%2Fgitonly.git",
    },
  });
  // A duplicated name would otherwise be hidden by the name-keyed map.
  assert.strictEqual(
    depList.length,
    Object.keys(requirementMap).length,
    "each manifest dependency must appear exactly once",
  );
  const tokioDep = depList.find((pkg) => pkg.name === "tokio");
  assert.ok(
    tokioDep.properties.some(
      (property) =>
        property.name === "cdx:cargo:dependencyFeatures" &&
        property.value === '["rt"]',
    ),
  );
  const memchrDep = depList.find((pkg) => pkg.name === "memchr");
  assert.ok(
    memchrDep.properties.some(
      (property) =>
        property.name === "cdx:cargo:git" &&
        property.value === "https://github.com/BurntSushi/memchr",
    ),
  );
});

it("normalize visited cargo manifest paths across relative and absolute inputs", async () => {
  const workspaceToml = "./test/data/cargo-workspace-repotest/Cargo.toml";
  const absoluteWorkspaceToml = path.resolve(workspaceToml);
  const parsedPackages = await parseCargoTomlData(
    absoluteWorkspaceToml,
    false,
    {},
    {
      visitedCargoTomlFiles: new Set([workspaceToml]),
    },
  );
  assert.deepStrictEqual(parsedPackages, []);
  const dependencyGraph = parseCargoManifestDependencyData(
    absoluteWorkspaceToml,
    {
      visitedCargoTomlDependencyGraphFiles: new Set([workspaceToml]),
    },
  );
  assert.deepStrictEqual(dependencyGraph, []);
});

it("build cargo workspace manifest dependency graph with member-to-member edges", () => {
  const tmpDir = mkdtempSync(
    path.join(tmpdir(), "cdxgen-cargo-workspace-graph-"),
  );
  const workspaceToml = path.join(tmpDir, "Cargo.toml");
  const coreDir = path.join(tmpDir, "crates", "core");
  const cliDir = path.join(tmpDir, "crates", "cli");
  mkdirSync(coreDir, { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    workspaceToml,
    `[workspace]
members = ["crates/*"]

[workspace.package]
version = "1.2.3"

[workspace.dependencies]
core = { path = "crates/core" }
`,
  );
  writeFileSync(
    path.join(coreDir, "Cargo.toml"),
    `[package]
name = "core"
version.workspace = true
`,
  );
  writeFileSync(
    path.join(cliDir, "Cargo.toml"),
    `[package]
name = "cli"
version.workspace = true

[dependencies]
core = { workspace = true }
`,
  );

  try {
    const dependencyGraph = parseCargoManifestDependencyData(workspaceToml);
    const workspaceRef = `pkg:cargo/${path.basename(tmpDir)}@workspace`;
    const cliRef = "pkg:cargo/cli@1.2.3";
    const coreRef = "pkg:cargo/core@1.2.3";
    const workspaceNode = dependencyGraph.find(
      (dependency) => dependency.ref === workspaceRef,
    );
    const cliNode = dependencyGraph.find(
      (dependency) => dependency.ref === cliRef,
    );
    assert.ok(workspaceNode);
    assert.deepStrictEqual(workspaceNode.dependsOn, [cliRef, coreRef]);
    assert.ok(cliNode);
    assert.deepStrictEqual(cliNode.dependsOn, [coreRef]);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
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

it("parse cargo lock integrity using matching sha256 and sha384 hash algorithms", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-cargo-lock-"));
  const cargoLockFile = path.join(tmpDir, "Cargo.lock");
  writeFileSync(
    cargoLockFile,
    `version = 3

[[package]]
name = "sha256-demo"
version = "1.0.0"
checksum = "${"a".repeat(64)}"

[[package]]
name = "sha384-demo"
version = "2.0.0"
checksum = "${"b".repeat(96)}"
`,
  );
  try {
    const depList = await parseCargoData(cargoLockFile, true);
    const sha256Demo = depList.find((pkg) => pkg.name === "sha256-demo");
    const sha384Demo = depList.find((pkg) => pkg.name === "sha384-demo");
    assert.deepStrictEqual(sha256Demo.hashes, [
      {
        alg: "SHA-256",
        content: "a".repeat(64),
      },
    ]);
    assert.deepStrictEqual(sha384Demo.hashes, [
      {
        alg: "SHA-384",
        content: "b".repeat(96),
      },
    ]);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("parse local cargo packages without version as 0.0.0 like cargo does (issue #4327)", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-cargo-unversioned-"));
  const helperDir = path.join(tmpDir, "crates", "helper");
  const appDir = path.join(tmpDir, "crates", "app");
  mkdirSync(helperDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    path.join(tmpDir, "Cargo.toml"),
    `[workspace]
members = ["crates/*"]

[workspace.dependencies]
helper = { path = "crates/helper" }
`,
  );
  writeFileSync(
    path.join(helperDir, "Cargo.toml"),
    `[package]
name = "helper"

[dependencies]
libc = "0.2.159"
`,
  );
  writeFileSync(
    path.join(appDir, "Cargo.toml"),
    `[package]
name = "app"

[dependencies]
helper = { workspace = true }
`,
  );
  try {
    const depList = await parseCargoTomlData(path.join(tmpDir, "Cargo.toml"));
    // The workspace root stays a synthetic component.
    assert.strictEqual(depList[0].name, path.basename(tmpDir));
    assert.strictEqual(depList[0].version, "workspace");
    // Unversioned members are defaulted to 0.0.0 without warnings, the way
    // cargo records them in Cargo.lock.
    for (const memberName of ["app", "helper"]) {
      const memberPackage = depList.find(
        (pkg) =>
          pkg.name === memberName &&
          pkg.purl === `pkg:cargo/${memberName}@0.0.0`,
      );
      assert.ok(memberPackage, `expected member ${memberName}`);
      assert.strictEqual(memberPackage.version, "0.0.0");
    }
    // Unversioned members participate in workspace dependency resolution.
    const helperDependency = depList.find(
      (pkg) =>
        pkg.name === "helper" &&
        pkg.properties?.some(
          (property) => property.name === "cdx:cargo:workspaceDependency",
        ),
    );
    assert.ok(helperDependency);
    assert.strictEqual(
      helperDependency.properties.find(
        (property) => property.name === "cdx:cargo:workspaceDependencyResolved",
      )?.value,
      "true",
    );
    const dependencyGraph = parseCargoManifestDependencyData(
      path.join(tmpDir, "Cargo.toml"),
    );
    const helperRef = "pkg:cargo/helper@0.0.0";
    const appNode = dependencyGraph.find(
      (dependency) => dependency.ref === "pkg:cargo/app@0.0.0",
    );
    assert.ok(appNode);
    assert.ok(appNode.dependsOn.includes(helperRef));
    // A manifest without any name is still rejected with a warning.
    writeFileSync(
      path.join(helperDir, "Cargo.toml"),
      `[package]
version = "1.0.0"
`,
    );
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(msg);
    try {
      const missingNameList = await parseCargoTomlData(
        path.join(helperDir, "Cargo.toml"),
      );
      assert.deepStrictEqual(missingNameList, []);
      assert.ok(
        warnings.some((warning) =>
          String(warning).includes("Failed to parse package"),
        ),
        "package without a name must still warn",
      );
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("normalize cargo dependency kinds", () => {
  // cargo metadata spells a normal dependency `null`, not "normal".
  assert.deepStrictEqual(normalizeCargoDepKind(null), "runtime");
  assert.deepStrictEqual(normalizeCargoDepKind(undefined), "runtime");
  assert.deepStrictEqual(normalizeCargoDepKind(""), "runtime");
  assert.deepStrictEqual(normalizeCargoDepKind("normal"), "runtime");
  assert.deepStrictEqual(normalizeCargoDepKind("dev"), "dev");
  assert.deepStrictEqual(normalizeCargoDepKind("build"), "build");
});

it("parse cargo package ids", () => {
  assert.deepStrictEqual(
    parseCargoPackageId(
      "registry+https://github.com/rust-lang/crates.io-index#libc@0.2.189",
    ),
    { name: "libc", version: "0.2.189" },
  );
  assert.deepStrictEqual(
    parseCargoPackageId("path+file:///work/crates/app#0.1.0"),
    { name: "app", version: "0.1.0" },
  );
  assert.deepStrictEqual(
    parseCargoPackageId(
      "git+https://github.com/org/repo?branch=main#serde@1.0.0",
    ),
    { name: "serde", version: "1.0.0" },
  );
  // cargo releases before 1.77 spell the same identity differently.
  assert.deepStrictEqual(
    parseCargoPackageId(
      "libc 0.2.189 (registry+https://github.com/rust-lang/crates.io-index)",
    ),
    { name: "libc", version: "0.2.189" },
  );
  assert.deepStrictEqual(parseCargoPackageId(""), undefined);
  assert.deepStrictEqual(parseCargoPackageId(null), undefined);
});

it("component keys from purls", () => {
  assert.deepStrictEqual(
    cargoPurlToComponentKey("pkg:cargo/libc@0.2.189"),
    "libc@0.2.189",
  );
  assert.deepStrictEqual(
    cargoPurlToComponentKey("pkg:cargo/libc@0.2.189?repository_url=x"),
    "libc@0.2.189",
  );
  assert.deepStrictEqual(cargoPurlToComponentKey(""), "");
});

it("rollup cargo dependency kinds", () => {
  const edges = new Map([
    [
      "app@0.1.0",
      [
        { to: "cfg-if@1.0.0", kind: "dev" },
        { to: "lib1@0.1.0", kind: "runtime" },
        { to: "cc@1.0.0", kind: "build" },
        { to: "libc@0.2.0", kind: "runtime", target: "cfg(unix)" },
        { to: "hex@0.4.0", kind: "dev" },
      ],
    ],
    ["lib1@0.1.0", [{ to: "cfg-if@1.0.0", kind: "runtime" }]],
    ["cc@1.0.0", [{ to: "shlex@1.0.0", kind: "runtime" }]],
    ["libc@0.2.0", [{ to: "libc-sys@0.1.0", kind: "runtime" }]],
    // A dependency's own dev dependencies are never built.
    ["hex@0.4.0", [{ to: "criterion@0.5.0", kind: "dev" }]],
  ]);
  const rollup = rollupCargoDependencyKinds({
    rootKeys: ["app@0.1.0"],
    edges,
  });
  assert.deepStrictEqual(rollup.get("app@0.1.0").kind, "root");
  // Reached by a dev edge and a runtime edge; the runtime path wins.
  assert.deepStrictEqual(rollup.get("cfg-if@1.0.0").kind, "runtime");
  assert.deepStrictEqual(rollup.get("hex@0.4.0").kind, "dev");
  assert.deepStrictEqual(rollup.get("cc@1.0.0").kind, "build");
  assert.deepStrictEqual(rollup.get("shlex@1.0.0").kind, "build");
  assert.deepStrictEqual(rollup.get("criterion@0.5.0"), undefined);
  const libc = rollup.get("libc@0.2.0");
  assert.deepStrictEqual(libc.kind, "runtime");
  assert.deepStrictEqual(libc.targetGated, true);
  assert.deepStrictEqual([...libc.targets], ["cfg(unix)"]);
  // The gate is inherited by everything below a gated edge.
  assert.deepStrictEqual(rollup.get("libc-sys@0.1.0").targetGated, true);
});

it("parse cargo metadata resolve", () => {
  const metadata = {
    workspace_members: ["path+file:///w/crates/app#0.1.0"],
    packages: [
      {
        id: "path+file:///w/crates/app#0.1.0",
        name: "app",
        version: "0.1.0",
        targets: [{ kind: ["bin"] }],
      },
      {
        id: "registry+https://x#serde_derive@1.0.0",
        name: "serde_derive",
        version: "1.0.0",
        targets: [{ kind: ["proc-macro"] }],
      },
      {
        id: "registry+https://x#hex@0.4.0",
        name: "hex",
        version: "0.4.0",
        targets: [{ kind: ["lib"] }],
      },
    ],
    resolve: {
      root: null,
      nodes: [
        {
          id: "path+file:///w/crates/app#0.1.0",
          deps: [
            {
              pkg: "registry+https://x#serde_derive@1.0.0",
              dep_kinds: [{ kind: null, target: null }],
            },
            {
              pkg: "registry+https://x#hex@0.4.0",
              dep_kinds: [{ kind: "dev", target: null }],
            },
          ],
        },
      ],
    },
  };
  const graph = parseCargoMetadataResolve(metadata);
  // A virtual workspace has no resolve.root, so the roots come from the members.
  assert.deepStrictEqual(graph.rootKeys, ["app@0.1.0"]);
  assert.deepStrictEqual(
    graph.packageInfo.get("serde_derive@1.0.0").procMacro,
    true,
  );
  assert.deepStrictEqual(graph.edges.get("app@0.1.0"), [
    { to: "serde_derive@1.0.0", kind: "runtime", target: undefined },
    { to: "hex@0.4.0", kind: "dev", target: undefined },
  ]);
  const rollup = rollupCargoDependencyKinds(graph);
  const pkgList = [
    { name: "app", version: "0.1.0" },
    { name: "serde_derive", version: "1.0.0" },
    { name: "hex", version: "0.4.0" },
    { name: "itoa", version: "1.0.0" },
  ];
  applyCargoDependencyKindMetadata(pkgList, rollup, graph.packageInfo, {
    resolveIsComplete: true,
  });
  assert.deepStrictEqual(pkgList[0].scope, undefined);
  assert.deepStrictEqual(pkgList[1].scope, undefined);
  assert.ok(
    pkgList[1].properties.some(
      (property) => property.name === "cdx:cargo:procMacro",
    ),
  );
  assert.deepStrictEqual(pkgList[2].scope, "excluded");
  // Locked but activated by no feature.
  assert.deepStrictEqual(pkgList[3].scope, "optional");
});

it("annotate cargo build and target excluded components", () => {
  const rollup = new Map([
    [
      "app@0.1.0",
      {
        kind: "root",
        kinds: new Set(["root"]),
        targets: new Set(),
        targetGated: false,
      },
    ],
    [
      "cc@1.0.0",
      {
        kind: "build",
        kinds: new Set(["build"]),
        targets: new Set(),
        targetGated: false,
      },
    ],
    [
      "winapi-util@0.1.0",
      {
        kind: "runtime",
        kinds: new Set(["runtime"]),
        targets: new Set(["cfg(windows)"]),
        targetGated: true,
      },
    ],
    [
      "libc@0.2.0",
      {
        kind: "runtime",
        kinds: new Set(["runtime"]),
        targets: new Set(["cfg(unix)"]),
        targetGated: true,
      },
    ],
  ]);
  const packageInfo = new Map([["serde_derive@1.0.0", { procMacro: true }]]);
  const pkgList = [
    { name: "app", version: "0.1.0" },
    { name: "cc", version: "1.0.0" },
    { name: "serde_derive", version: "1.0.0" },
    { name: "winapi-util", version: "0.1.0" },
    { name: "libc", version: "0.2.0" },
  ];
  applyCargoDependencyKindMetadata(pkgList, rollup, packageInfo, {
    resolveIsComplete: true,
    filterPlatform: "armv5te-unknown-linux-gnueabi",
    targetIncludedKeys: new Set(["app@0.1.0", "cc@1.0.0", "libc@0.2.0"]),
  });
  // A build dependency stays required; the host-only marker is what moves it
  // to the formulation section.
  assert.deepStrictEqual(pkgList[1].scope, undefined);
  assert.ok(
    pkgList[1].properties.some(
      (property) =>
        property.name === "cdx:cargo:hostOnly" && property.value === "true",
    ),
  );
  // A proc-macro is a host artefact even without a rollup entry.
  assert.ok(
    pkgList[2].properties.some(
      (property) =>
        property.name === "cdx:cargo:hostOnly" && property.value === "true",
    ),
  );
  // Dropped by the resolver for the requested triple.
  assert.deepStrictEqual(pkgList[3].scope, "excluded");
  assert.ok(
    pkgList[3].properties.some(
      (property) =>
        property.name === "cdx:cargo:filterPlatform" &&
        property.value === "armv5te-unknown-linux-gnueabi",
    ),
  );
  // Gated on cfg(unix), which the requested triple matches.
  assert.deepStrictEqual(pkgList[4].scope, undefined);
  // The workspace member itself is never marked.
  assert.deepStrictEqual(pkgList[0].scope, undefined);
  assert.deepStrictEqual(pkgList[0].properties, undefined);
});

it("upstream version from a sys crate version", () => {
  assert.deepStrictEqual(
    cargoUpstreamVersionFromCrateVersion("300.6.1+3.6.3"),
    "3.6.3",
  );
  assert.deepStrictEqual(
    cargoUpstreamVersionFromCrateVersion("0.4.74+curl-8.9.0"),
    "8.9.0",
  );
  assert.deepStrictEqual(
    cargoUpstreamVersionFromCrateVersion("2.0.13+zstd.1.5.6"),
    "1.5.6",
  );
  // A crate whose version carries no build metadata says nothing about the
  // library it bundles.
  assert.deepStrictEqual(cargoUpstreamVersionFromCrateVersion("1.1.29"), "");
  assert.deepStrictEqual(cargoUpstreamVersionFromCrateVersion(""), "");
  assert.deepStrictEqual(cargoUpstreamVersionFromCrateVersion(null), "");
});

it("native library components from links crates", () => {
  const packageInfo = new Map([
    [
      "openssl-sys@0.9.117",
      {
        links: "openssl",
        name: "openssl-sys",
        version: "0.9.117",
        resolvedFeatures: ["openssl-src", "vendored"],
      },
    ],
    [
      "openssl-src@300.6.1+3.6.3",
      { name: "openssl-src", version: "300.6.1+3.6.3" },
    ],
    [
      "libz-sys@1.1.29",
      {
        links: "z",
        name: "libz-sys",
        version: "1.1.29",
        resolvedFeatures: ["default", "libc"],
      },
    ],
    [
      "unreached-sys@1.0.0",
      { links: "unreached", name: "unreached-sys", version: "1.0.0" },
    ],
    ["serde@1.0.0", { name: "serde", version: "1.0.0" }],
  ]);
  const edges = new Map([
    [
      "openssl-sys@0.9.117",
      [{ to: "openssl-src@300.6.1+3.6.3", kind: "runtime" }],
    ],
  ]);
  const rollup = new Map([
    ["openssl-sys@0.9.117", { kind: "runtime" }],
    ["openssl-src@300.6.1+3.6.3", { kind: "runtime" }],
    ["libz-sys@1.1.29", { kind: "runtime" }],
    ["serde@1.0.0", { kind: "runtime" }],
  ]);
  const { components, dependencies } = buildCargoNativeLibraryComponents(
    packageInfo,
    edges,
    rollup,
  );
  const byName = new Map(components.map((comp) => [comp.name, comp]));
  // A crate with no `links` contributes nothing, and one no build reaches is
  // skipped even though it declares links.
  assert.deepStrictEqual([...byName.keys()].sort(), ["openssl", "zlib"]);
  const openssl = byName.get("openssl");
  // The version comes from the companion -src crate's build metadata.
  assert.deepStrictEqual(openssl.version, "3.6.3");
  assert.deepStrictEqual(openssl.purl, "pkg:generic/openssl@3.6.3");
  const propertyValue = (comp, name) =>
    (comp.properties || [])
      .filter((property) => property.name === name)
      .map((property) => property.value);
  assert.deepStrictEqual(propertyValue(openssl, "cdx:cargo:linkage"), [
    "static",
  ]);
  assert.deepStrictEqual(propertyValue(openssl, "cdx:cargo:providedBy"), [
    "pkg:cargo/openssl-sys@0.9.117",
  ]);
  // `z` is the linker name; the library is published as zlib.
  const zlib = byName.get("zlib");
  assert.deepStrictEqual(propertyValue(zlib, "cdx:cargo:nativeLibrary"), ["z"]);
  assert.deepStrictEqual(zlib.version, undefined);
  // Without a vendoring feature the library comes from the environment, so no
  // version is invented for it, and it is marked external rather than bundled.
  assert.deepStrictEqual(propertyValue(zlib, "cdx:cargo:linkage"), ["dynamic"]);
  assert.deepStrictEqual(zlib.isExternal, true);
  assert.deepStrictEqual(openssl.isExternal, undefined);
  assert.ok(
    dependencies.some(
      (relationship) =>
        relationship.ref === "pkg:cargo/openssl-sys@0.9.117" &&
        relationship.dependsOn.includes("pkg:generic/openssl@3.6.3"),
    ),
  );
});

it("vendored library version from the shipped headers", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-vendored-"));
  try {
    mkdirSync(path.join(tmpDir, "src", "zlib"), { recursive: true });
    mkdirSync(path.join(tmpDir, "src", "zlib-ng"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, "src", "zlib", "zlib.h"),
      '#define ZLIB_VERSION "1.3.1"\n',
    );
    writeFileSync(
      path.join(tmpDir, "src", "zlib-ng", "zlib.h"),
      '#define ZLIB_VERSION "2.2.2.zlib-ng"\n',
    );
    // `zlib-ng` is declared but not enabled, so that variant is not built.
    const resolved = resolveCargoVendoredLibraryVersion({
      crateDir: tmpDir,
      declaredFeatures: ["default", "zlib-ng", "static"],
      libraryName: "zlib",
      links: "z",
      resolvedFeatures: new Set(["default", "static"]),
    });
    assert.deepStrictEqual(resolved.version, "1.3.1");
    assert.ok(resolved.evidence.endsWith("zlib.h"));
    // With both variants in play, naming one of them would be a guess.
    const ambiguous = resolveCargoVendoredLibraryVersion({
      crateDir: tmpDir,
      declaredFeatures: ["default", "zlib-ng", "static"],
      libraryName: "zlib",
      links: "z",
      resolvedFeatures: new Set(["default", "static", "zlib-ng"]),
    });
    assert.deepStrictEqual(ambiguous.version, "");
    assert.deepStrictEqual(ambiguous.candidates, ["1.3.1", "2.2.2.zlib-ng"]);
    assert.deepStrictEqual(
      resolveCargoVendoredLibraryVersion({
        crateDir: path.join(tmpDir, "missing"),
        libraryName: "zlib",
        links: "z",
      }).version,
      "",
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

it("alternate registry crates carry the registry in their identity", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "cdxgen-cargo-registry-"));
  try {
    const cargoLockFile = path.join(tmpDir, "Cargo.lock");
    writeFileSync(
      cargoLockFile,
      [
        "version = 3",
        "",
        "[[package]]",
        'name = "internal-lib"',
        'version = "1.0.0"',
        'source = "registry+https://cargo.internal.example.com/index"',
        "",
        "[[package]]",
        'name = "public-lib"',
        'version = "2.0.0"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        "",
        "[[package]]",
        'name = "git-lib"',
        'version = "0.1.0"',
        'source = "git+https://github.com/org/repo?branch=main#abc123"',
        "",
      ].join("\n"),
    );
    const componentList = await parseCargoData(cargoLockFile);
    const byName = new Map(componentList.map((comp) => [comp.name, comp]));
    const propertyValue = (comp, name) =>
      (comp.properties || []).find((property) => property.name === name)?.value;
    // A private registry can publish any name, so the registry is part of the
    // component's identity.
    assert.deepStrictEqual(
      byName.get("internal-lib").purl,
      "pkg:cargo/internal-lib@1.0.0?repository_url=https:%2F%2Fcargo.internal.example.com%2Findex",
    );
    assert.deepStrictEqual(
      propertyValue(byName.get("internal-lib"), "cdx:cargo:alternateRegistry"),
      "true",
    );
    // crates.io is the default and needs no qualifier or property.
    assert.deepStrictEqual(
      byName.get("public-lib").purl,
      "pkg:cargo/public-lib@2.0.0",
    );
    assert.deepStrictEqual(
      propertyValue(byName.get("public-lib"), "cdx:cargo:sourceKind"),
      undefined,
    );
    assert.deepStrictEqual(
      propertyValue(byName.get("git-lib"), "cdx:cargo:sourceKind"),
      "git",
    );
    assert.deepStrictEqual(
      propertyValue(byName.get("git-lib"), "cdx:cargo:sourceUrl"),
      "https://github.com/org/repo?branch=main",
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});
