import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { assert, it } from "poku";

import {
  collectBuildSymbols,
  collectSwiftBuildPlan,
  extractCompilerParamsFromBuild,
  isTestOrAggregateModule,
  mergeSwiftModuleArgs,
  moduleFromDemangledName,
  moduleFromMangledPrefix,
  parseClangModuleMap,
  parseDumpPackage,
  parseIndex,
  parseModuleInfo,
  parseOutputFileMap,
  parseStructure,
  parseSwiftBuildDescription,
  parseSwiftBuildManifest,
  parseSwiftImports,
  parseSwiftModuleInvocations,
  parseSwiftTargetInfo,
  parseSwiftWorkspaceState,
  resolveUsrModules,
  sanitizeSwiftModuleArgs,
  sourcekittenEnvForToolchain,
  splitSwiftCommandArgs,
  toModuleName,
  withoutSwiftPluginArgs,
} from "./swiftsem.js";

/**
 * Assert that every -Xcc is followed by a value and that clang flags taking a
 * separate value (-I, -F, -isysroot) are followed by their value.
 */
function assertClangPairsIntact(args) {
  const xccValues = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-Xcc") {
      assert.ok(i + 1 < args.length, "-Xcc without a value");
      xccValues.push(args[i + 1]);
      i++;
    }
  }
  for (let i = 0; i < xccValues.length; i++) {
    if (["-I", "-F", "-isysroot"].includes(xccValues[i])) {
      assert.ok(
        xccValues[i + 1] && !xccValues[i + 1].startsWith("-"),
        `clang ${xccValues[i]} lost its value`,
      );
      i++;
    } else {
      assert.ok(
        xccValues[i].startsWith("-"),
        `orphan clang argument ${xccValues[i]}`,
      );
    }
  }
}

/**
 * Materialise a fixture build tree whose absolute paths use a placeholder
 * prefix, creating every source file it lists. The placeholder is replaced
 * with the directory in forward-slash form (`root`), which keeps the JSON
 * fixtures valid on Windows; Windows APIs accept either separator.
 */
function materialiseTree(files, placeholder, sources) {
  const baseDir = mkdtempSync(join(tmpdir(), "swiftsem-plan-"));
  const root = baseDir.split(sep).join("/");
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(baseDir, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content.split(placeholder).join(root));
  }
  for (const source of sources) {
    const target = source.split(placeholder).join(root);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "// fixture\n");
  }
  return { baseDir, root };
}

it("extractCompilerParamsFromBuild test", () => {
  // llbuild: one driver invocation per module
  let paramsObj = extractCompilerParamsFromBuild(
    readFileSync("./test/data/swiftsem/swift-build-output1.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(Object.keys(paramsObj.params).sort(), [
    "HAKit",
    "HAKit_Mocks",
    "HAKit_PromiseKit",
    "PromiseKit",
    "Starscream",
  ]);
  let args = paramsObj.compilerArgs;
  assert.strictEqual(args.filter((a) => a === "-target").length, 1);
  assert.ok(
    args.includes(
      "/Volumes/Work/sandbox/HAKit/.build/x86_64-apple-macosx/debug/Modules",
    ),
  );
  // Outputs, bookkeeping, and the build's module cache are never forwarded
  for (const dropped of [
    "-module-name",
    "-module-cache-path",
    "-output-file-map",
    "-emit-module-path",
    "-o",
    "-c",
  ]) {
    assert.ok(!args.includes(dropped), `${dropped} leaked`);
  }
  assertClangPairsIntact(args);
  // Restricting to the root package's modules uses only their invocations
  paramsObj = extractCompilerParamsFromBuild(
    readFileSync("./test/data/swiftsem/swift-build-output1.txt", {
      encoding: "utf-8",
    }),
    ["HAKit"],
  );
  assert.deepStrictEqual(Object.keys(paramsObj.params), ["HAKit"]);
  // The root module's deployment target, not the 10.13 of its dependencies
  args = paramsObj.compilerArgs;
  assert.strictEqual(
    args[args.indexOf("-target") + 1],
    "x86_64-apple-macosx10.14",
  );
  // llbuild frontend jobs (-frontend -c -primary-file) of a single module
  paramsObj = extractCompilerParamsFromBuild(
    readFileSync("./test/data/swiftsem/swift-build-output2.txt", {
      encoding: "utf-8",
    }),
  );
  assert.deepStrictEqual(Object.keys(paramsObj.params), ["SymbolKit"]);
  args = paramsObj.compilerArgs;
  assert.ok(args.includes("arm64-apple-macosx10.13"));
  assert.ok(
    args.includes(
      "/Users/prabhu/sandbox/swift-docc-symbolkit/.build/arm64-apple-macosx/debug/Modules",
    ),
  );
  assertClangPairsIntact(args);
  // The Package.swift manifest compilation (-module-name main) is skipped
  assert.ok(!args.some((a) => a.includes("ManifestAPI")));
  assert.deepStrictEqual(
    extractCompilerParamsFromBuild(undefined).compilerArgs,
    [],
  );
});

it("parseDumpPackage", () => {
  const metadata = parseDumpPackage(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-dump-package.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.deepStrictEqual(metadata.rootModule, "HAKit");
  assert.deepStrictEqual(metadata.dependencies, [
    {
      dependsOn: ["Starscream"],
      ref: "HAKit",
    },
    {
      dependsOn: ["HAKit", "PromiseKit"],
      ref: "HAKit_PromiseKit",
    },
    {
      dependsOn: ["HAKit"],
      ref: "HAKit_Mocks",
    },
    {
      dependsOn: ["HAKit", "HAKit_PromiseKit", "HAKit_Mocks"],
      ref: "Tests",
    },
  ]);
});

it("collectBuildSymbols", () => {
  const metadata = parseOutputFileMap(
    "./test/data/swiftsem/output-file-map.json",
  );
  assert.strictEqual(metadata.moduleName, "swiftsem");
  assert.ok(metadata.sourceFiles.every((f) => f.endsWith(".swift")));
  assert.deepStrictEqual(metadata.sourceFiles.length, 21);
  assert.deepStrictEqual(metadata.moduleSymbols, [
    "Compression",
    "WSCompression",
    "Data_Extensions",
    "Engine",
    "NativeEngine",
    "WSEngine",
    "FoundationHTTPHandler",
    "FoundationHTTPServerHandler",
    "FrameCollector",
    "Framer",
    "HTTPHandler",
    "StringHTTPHandler",
    "FoundationSecurity",
    "Security",
    "Server",
    "WebSocketServer",
    "WebSocket",
    "FoundationTransport",
    "TCPTransport",
    "Transport",
    "resource_bundle_accessor",
  ]);
});

it("parseModuleInfo", () => {
  let metadata = parseModuleInfo(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-module-info2.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.classes.length, 13);
  assert.deepStrictEqual(metadata.protocols.length, 25);
  assert.deepStrictEqual(metadata.enums.length, 16);
  assert.deepStrictEqual(metadata.importedModules, [
    "CommonCrypto",
    "Foundation",
    "Network",
    "SwiftOnoneSupport",
    "_Concurrency",
    "_StringProcessing",
    "_SwiftConcurrencyShims",
    "zlib",
  ]);
  metadata = parseModuleInfo(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-module-info.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.classes.length, 8);
  assert.deepStrictEqual(metadata.protocols.length, 14);
  assert.deepStrictEqual(metadata.enums.length, 15);
  assert.deepStrictEqual(metadata.importedModules, [
    "Dispatch",
    "Foundation",
    "Network",
    "Starscream",
    "SwiftOnoneSupport",
    "_Concurrency",
    "_StringProcessing",
    "_SwiftConcurrencyShims",
  ]);
});

it("parseStructure", () => {
  let metadata = parseStructure(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-structure-starscream2.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.referredTypes, [
    "DispatchQueue",
    "Equatable",
    "HAData",
    "HARequestIdentifier",
    "HAResponseController",
    "HAResponseControllerDelegate?",
    "HAResponseControllerPhase",
    "HAWebSocketResponse",
    "Result<(HTTPURLResponse, Data?), Error>",
    "Result<HAData, HAError>",
    "Starscream.WebSocketEvent",
  ]);
  metadata = parseStructure(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-structure-starscream.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.referredTypes, [
    "@escaping () -> Void",
    "@escaping (HACancellable, T) -> Void",
    "@escaping (Result<T, HAError>) -> Void",
    "@escaping (Result<Void, Error>) -> Void",
    "@escaping RequestCompletion",
    "@escaping SubscriptionHandler",
    "@escaping SubscriptionInitiatedHandler",
    "Data",
    "DispatchQueue",
    "Error",
    "HACachesContainer",
    "HACancellable",
    "HAConnection",
    "HAConnectionConfiguration",
    "HAConnectionDelegate?",
    "HAConnectionState",
    "HAHTTPMethod",
    "HAReconnectManager",
    "HAReconnectManagerDelegate",
    "HARequest",
    "HARequestController",
    "HARequestIdentifier",
    "HARequestIdentifier?",
    "HAResponseController",
    "HATypedRequest<T>",
    "HATypedSubscription<T>",
    "Result<T, HAError>",
    "SubscriptionInitiatedHandler?",
    "UInt8",
    "URLSession",
    "WebSocket",
    "WebSocket?",
    "[HAEventType]",
    "[String: Any]",
  ]);
  metadata = parseStructure(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-structure-speech.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.referredTypes, [
    "AVSpeechSynthesizer",
    "AVSpeechSynthesizerDelegate",
    "AVSpeechUtterance",
    "NSObject",
  ]);
  metadata = parseStructure(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-structure-grdb.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.deepStrictEqual(metadata.referredTypes, [
    "(URL, URL) throws -> Void",
    "@escaping (GRDBWriteTransaction) throws -> Result<Void, Error>",
    "CaseIterable",
    "Database",
    "DatabaseMigrator",
    "DatabaseMigratorWrapper",
    "DatabaseWriter",
    "GRDBReadTransaction",
    "GRDBWriteTransaction",
    "MigrationId",
    "NSObject",
    "Result<Void, Error>",
    "SDSAnyWriteTransaction",
    "SDSDatabaseStorage",
    "Set<SignalAccount>",
    "SignalRecipient.RowId",
    "StaticString",
    "TSThread",
    "TableAlteration",
    "TableDefinition",
    "UInt",
    "UInt32",
    "URL",
    "UnsafeMutablePointer<ObjCBool>",
    "[SignalServiceAddress: [String]]",
  ]);
});

it("parseIndex", () => {
  let metadata = parseIndex(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-index-starscream.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.ok(metadata.obfuscatedSymbols);
  assert.ok(metadata.symbolLocations);
  assert.deepStrictEqual(metadata.swiftModules, [
    "Combine",
    "CoreFoundation",
    "Darwin",
    "Dispatch",
    "Foundation",
    "ObjectiveC",
    "Observation",
    "Swift",
    "System",
    "_Builtin_float",
    "_Concurrency",
    "_StringProcessing",
    "_errno",
    "_math",
    "_signal",
    "_stdio",
    "_time",
    "sys_time",
    "unistd",
  ]);
  assert.deepStrictEqual(metadata.clangModules, [
    "CoreFoundation",
    "Darwin",
    "Dispatch",
    "Foundation",
    "Mach",
    "ObjectiveC",
    "SwiftShims",
    "_Builtin_float",
    "_SwiftConcurrencyShims",
    "_errno",
    "_math",
    "_signal",
    "_stdio",
    "_time",
    "sys_time",
    "sysdir",
    "timeval",
    "unistd",
    "uuid",
  ]);
  metadata = parseIndex(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-index-starscream2.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.ok(metadata.obfuscatedSymbols);
  assert.ok(metadata.symbolLocations);
  assert.deepStrictEqual(metadata.swiftModules, [
    "Combine",
    "CoreFoundation",
    "Darwin",
    "Dispatch",
    "Foundation",
    "ObjectiveC",
    "Observation",
    "Swift",
    "System",
    "_Builtin_float",
    "_Concurrency",
    "_StringProcessing",
    "_errno",
    "_math",
    "_signal",
    "_stdio",
    "_time",
    "sys_time",
    "unistd",
  ]);
  assert.deepStrictEqual(metadata.clangModules, [
    "CoreFoundation",
    "Darwin",
    "Dispatch",
    "Foundation",
    "Mach",
    "ObjectiveC",
    "SwiftShims",
    "_Builtin_float",
    "_SwiftConcurrencyShims",
    "_errno",
    "_math",
    "_signal",
    "_stdio",
    "_time",
    "sys_time",
    "sysdir",
    "timeval",
    "unistd",
    "uuid",
  ]);

  metadata = parseIndex(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-index-speech.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(metadata);
  assert.ok(metadata.obfuscatedSymbols);
  assert.ok(metadata.symbolLocations);
  assert.deepStrictEqual(metadata.swiftModules, [
    "Swift",
    "_Concurrency",
    "_StringProcessing",
  ]);
  assert.deepStrictEqual(metadata.clangModules, [
    "AVFAudio",
    "SwiftShims",
    "_SwiftConcurrencyShims",
  ]);
});

it("sanitizeSwiftModuleArgs keeps what type-checking needs, in order", () => {
  const args = sanitizeSwiftModuleArgs([
    "/usr/bin/swiftc",
    "-module-name",
    "App",
    "-emit-dependencies",
    "-emit-module-path",
    "/b/App.swiftmodule",
    "-output-file-map",
    "/b/output-file-map.json",
    "-incremental",
    "-c",
    "@/b/sources",
    "-I",
    "/b/Modules",
    "-I",
    "/b/Modules",
    "-target",
    "arm64-apple-macosx13.0",
    "-sdk",
    "/sdk",
    "-DSWIFT_PACKAGE",
    "-D",
    "DEBUG",
    "-Xcc",
    "-fmodule-map-file=/c/CNIOAtomics/module.modulemap",
    "-Xcc",
    "-I",
    "-Xcc",
    "/c/CNIOAtomics/include",
    "-Xcc",
    "-I",
    "-Xcc",
    "/c/CNIOLinux/include",
    "-module-cache-path",
    "/b/ModuleCache",
    "-index-store-path",
    "/b/index/store",
    "-Xfrontend",
    "-entry-point-function-name",
    "-Xfrontend",
    "app_main",
    "-Xfrontend",
    "-load-plugin-executable",
    "-Xfrontend",
    "/b/CasePathsMacros-tool#CasePathsMacros",
    "-Xllvm",
    "-aarch64-use-tbi",
    "-parse-as-library",
    "-disable-clang-spi",
    "-enable-upcoming-feature",
    "ExistentialAny",
    "-package-name",
    "hello",
    "-j14",
    "-num-threads",
    "8",
  ]);
  assert.deepStrictEqual(args, [
    "-module-name",
    "App",
    "-I",
    "/b/Modules",
    "-target",
    "arm64-apple-macosx13.0",
    "-sdk",
    "/sdk",
    "-D",
    "SWIFT_PACKAGE",
    "-D",
    "DEBUG",
    "-Xcc",
    "-fmodule-map-file=/c/CNIOAtomics/module.modulemap",
    "-Xcc",
    "-I",
    "-Xcc",
    "/c/CNIOAtomics/include",
    "-Xcc",
    "-I",
    "-Xcc",
    "/c/CNIOLinux/include",
    "-Xfrontend",
    "-load-plugin-executable",
    "-Xfrontend",
    "/b/CasePathsMacros-tool#CasePathsMacros",
    "-parse-as-library",
    "-enable-upcoming-feature",
    "ExistentialAny",
    "-package-name",
    "hello",
  ]);
});

it("mergeSwiftModuleArgs merges clang argument groups without splitting them", () => {
  // Merging per -Xcc value turned `-Xcc -I -Xcc /b` into a bare `/b` clang
  // input once `-I` had been seen, and clang then failed with "unable to
  // handle compilation, expected exactly one compiler job"
  const merged = mergeSwiftModuleArgs([
    [
      "-module-name",
      "App",
      "-target",
      "arm64-apple-macosx13.0",
      "-Xcc",
      "-I",
      "-Xcc",
      "/a/include",
    ],
    [
      "-module-name",
      "Dep",
      "-target",
      "arm64-apple-macosx10.13",
      "-Xcc",
      "-I",
      "-Xcc",
      "/a/include",
      "-Xcc",
      "-I",
      "-Xcc",
      "/b/include",
    ],
  ]);
  assert.deepStrictEqual(merged, [
    "-target",
    "arm64-apple-macosx13.0",
    "-Xcc",
    "-I",
    "-Xcc",
    "/a/include",
    "-Xcc",
    "-I",
    "-Xcc",
    "/b/include",
  ]);
  assertClangPairsIntact(merged);
});

it("parseSwiftModuleInvocations reads Swift Build driver lines", () => {
  // The output was captured on macOS, so it is read with POSIX quoting on
  // every platform
  const invocations = parseSwiftModuleInvocations(
    readFileSync("./test/data/swiftsem/swiftbuild-verbose-output.txt", {
      encoding: "utf-8",
    }),
    "darwin",
  );
  // One entry per module; the manifest compilations (-module-name main) are
  // skipped
  assert.deepStrictEqual(Object.keys(invocations).sort(), [
    "ArgumentParser",
    "ArgumentParserToolInfo",
    "SWXMLHash",
    "Yams",
    "argparser_demo",
  ]);
  const rootArgs = invocations.argparser_demo.args;
  assert.strictEqual(
    rootArgs[rootArgs.indexOf("-target") + 1],
    "arm64-apple-macos12.0",
  );
  assert.ok(
    rootArgs.some(
      (a, i) =>
        a === "-I" && rootArgs[i + 1].endsWith(".build/out/Products/Debug"),
    ),
  );
  // Escaped `=` in the verbose output is unescaped
  assert.ok(
    rootArgs.includes(
      "-fmodule-map-file=/Users/appthreat/sandbox/swift4415/argparser-demo/.build/checkouts/Yams/Sources/CYaml/include/module.modulemap",
    ),
  );
  assertClangPairsIntact(rootArgs);
  assert.ok(!rootArgs.includes("-disable-clang-spi"));
  assert.ok(!rootArgs.includes("-index-store-path"));
});

it("parseSwiftModuleInvocations reads Windows driver lines", () => {
  const invocations = parseSwiftModuleInvocations(
    [
      'C:\\Swift\\bin\\swiftc.exe -module-name Demo -emit-dependencies -target aarch64-unknown-windows-msvc -sdk C:\\Swift\\Platforms\\Windows.platform\\Developer\\SDKs\\Windows.sdk -I "C:\\Users\\dev\\My Project\\.build\\debug\\Modules" C:\\Users\\dev\\proj\\Sources\\Demo\\main.swift "C:\\Users\\dev\\My Project\\Sources\\Demo\\Other.swift"',
      "C:\\Swift\\bin\\swiftc.exe -module-name main -package-description-version 6.0 C:\\proj\\Package.swift",
    ].join("\r\n"),
    "win32",
  );
  assert.deepStrictEqual(Object.keys(invocations), ["Demo"]);
  assert.deepStrictEqual(invocations.Demo.sources, [
    "C:\\Users\\dev\\proj\\Sources\\Demo\\main.swift",
    "C:\\Users\\dev\\My Project\\Sources\\Demo\\Other.swift",
  ]);
  const args = invocations.Demo.args;
  assert.strictEqual(
    args[args.indexOf("-I") + 1],
    "C:\\Users\\dev\\My Project\\.build\\debug\\Modules",
  );
  assert.strictEqual(
    args[args.indexOf("-sdk") + 1],
    "C:\\Swift\\Platforms\\Windows.platform\\Developer\\SDKs\\Windows.sdk",
  );
});

it("parseSwiftBuildDescription reads the llbuild build description", () => {
  const modules = parseSwiftBuildDescription(
    JSON.parse(
      readFileSync("./test/data/swiftsem/llbuild/description.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.deepStrictEqual(Object.keys(modules).sort(), [
    "ArgumentParser",
    "SWXMLHash",
    "Yams",
    "argparser_demo",
    "argparser_demoTests",
  ]);
  // The regular variant wins over the host-tool variant built for plugins
  assert.ok(
    modules.ArgumentParser.sources.every((s) => s.startsWith("__BASE__")),
  );
  assert.deepStrictEqual(modules.argparser_demo.sources, [
    "__BASE__/Sources/argparser-demo/main.swift",
  ]);
  const args = modules.argparser_demo.args;
  assert.deepStrictEqual(args.slice(0, 2), ["-module-name", "argparser_demo"]);
  assert.ok(args.includes("__BASE__/.build/arm64-apple-macosx/debug/Modules"));
  assertClangPairsIntact(args);
});

it("collectSwiftBuildPlan attributes llbuild modules to their packages", () => {
  const description = readFileSync(
    "./test/data/swiftsem/llbuild/description.json",
    { encoding: "utf-8" },
  );
  const sources = Object.values(JSON.parse(description).swiftCommands).flatMap(
    (c) => c.sources,
  );
  const { baseDir } = materialiseTree(
    {
      ".build/arm64-apple-macosx/debug/description.json": description,
      ".build/workspace-state.json": readFileSync(
        "./test/data/swiftsem/llbuild/workspace-state.json",
        { encoding: "utf-8" },
      ),
      ".build/checkouts/Yams/Sources/CYaml/include/module.modulemap":
        'module CYaml {\n  header "yaml.h"\n}\n',
      // Generated Objective-C interface map of a Swift module
      ".build/arm64-apple-macosx/debug/Yams.build/include/module.modulemap":
        'module Yams {\n  header "Yams-Swift.h"\n  requires objc\n}\n',
    },
    "__BASE__",
    sources,
  );
  try {
    const rootMetadata = parseDumpPackage(
      JSON.parse(
        readFileSync(
          "./test/data/swiftsem/swift-dump-package-argparser-demo.json",
          { encoding: "utf-8" },
        ),
      ),
    );
    const plan = collectSwiftBuildPlan(baseDir, undefined, {}, rootMetadata);
    assert.strictEqual(plan.modules.argparser_demo.isRoot, true);
    assert.strictEqual(plan.modules.argparser_demo.isTest, false);
    assert.strictEqual(plan.modules.argparser_demoTests.isTest, true);
    assert.strictEqual(
      plan.modules.ArgumentParser.package,
      "swift-argument-parser",
    );
    assert.strictEqual(plan.modules.SWXMLHash.package, "swxmlhash");
    assert.strictEqual(plan.modules.Yams.isRoot, false);
    assert.deepStrictEqual(plan.clangModules, { CYaml: "yams" });
    const packages = Object.fromEntries(
      plan.packages.map((p) => [p.identity, Array.from(p.modules).sort()]),
    );
    assert.deepStrictEqual(packages, {
      "swift-argument-parser": ["ArgumentParser"],
      swxmlhash: ["SWXMLHash"],
      yams: ["CYaml", "Yams"],
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

it("collectSwiftBuildPlan reads Swift Build output and file maps", () => {
  const placeholder = "/Users/appthreat/sandbox/swift4415/argparser-demo";
  const fileMaps = {
    ".build/out/Intermediates.noindex/argparser-demo.build/Debug/argparser-demo-p.build/Objects-normal/arm64/argparser-demo-OutputFileMap.json":
      "./test/data/swiftsem/swiftbuild/argparser-demo-OutputFileMap.json",
    ".build/out/Intermediates.noindex/swift-argument-parser.build/Debug/ArgumentParser-t.build/Objects-normal/arm64/ArgumentParser-OutputFileMap.json":
      "./test/data/swiftsem/swiftbuild/ArgumentParser-OutputFileMap.json",
  };
  const files = {
    ".build/workspace-state.json": readFileSync(
      "./test/data/swiftsem/swiftbuild-workspace-state.json",
      { encoding: "utf-8" },
    ),
  };
  const sources = [];
  for (const [relPath, fixture] of Object.entries(fileMaps)) {
    const content = readFileSync(fixture, { encoding: "utf-8" });
    files[relPath] = content;
    sources.push(
      ...Object.keys(JSON.parse(content)).filter((k) => k.endsWith(".swift")),
    );
  }
  const { baseDir, root: treeRoot } = materialiseTree(
    files,
    placeholder,
    sources,
  );
  try {
    const buildOutput = readFileSync(
      "./test/data/swiftsem/swiftbuild-verbose-output.txt",
      { encoding: "utf-8" },
    )
      .split(placeholder)
      .join(treeRoot);
    const plan = collectSwiftBuildPlan(baseDir, buildOutput, {}, undefined);
    const root = plan.modules.argparser_demo;
    assert.strictEqual(root.isRoot, true);
    assert.deepStrictEqual(root.sources, [
      `${treeRoot}/Sources/argparser-demo/main.swift`,
    ]);
    assert.ok(root.args.includes("arm64-apple-macos12.0"));
    assert.strictEqual(
      plan.modules.ArgumentParser.package,
      "swift-argument-parser",
    );
    assert.ok(plan.modules.ArgumentParser.sources.length > 40);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

it("parseSwiftWorkspaceState maps packages to their directories", () => {
  const packages = parseSwiftWorkspaceState(
    {
      object: {
        dependencies: [
          {
            packageRef: {
              identity: "swift-argument-parser",
              kind: "remoteSourceControl",
              location: "https://github.com/apple/swift-argument-parser",
              name: "swift-argument-parser",
            },
            state: { name: "sourceControlCheckout" },
            subpath: "swift-argument-parser",
          },
          {
            packageRef: {
              identity: "localkit",
              kind: "fileSystem",
              location: "/src/LocalKit",
              name: "LocalKit",
            },
            state: { name: "fileSystem", path: "/src/LocalKit" },
            subpath: "localkit",
          },
          {
            packageRef: {
              identity: "mona.linkedlist",
              kind: "registry",
              location: "mona.LinkedList",
              name: "mona.LinkedList",
            },
            state: { name: "registryDownload" },
            subpath: "mona/LinkedList/1.2.0",
          },
        ],
      },
    },
    "/src/app",
  );
  assert.deepStrictEqual(
    packages.map((p) => [p.identity, p.dir]),
    [
      [
        "swift-argument-parser",
        join("/src/app", ".build", "checkouts", "swift-argument-parser"),
      ],
      ["localkit", "/src/LocalKit"],
      [
        "mona.linkedlist",
        join(
          "/src/app",
          ".build",
          "registry",
          "downloads",
          "mona/LinkedList/1.2.0",
        ),
      ],
    ],
  );
});

it("parseClangModuleMap reads top-level modules and headers", () => {
  assert.deepStrictEqual(
    parseClangModuleMap('module CYaml {\n  header "yaml.h"\n}\n'),
    { modules: ["CYaml"], headerPaths: ["yaml.h"] },
  );
  assert.deepStrictEqual(
    parseClangModuleMap(
      'framework module Foo {\n  umbrella header "/p/Foo.h"\n  module Sub { header "s.h" }\n  export *\n}\nexplicit module Bar { header "b.h" }\n',
    ),
    { modules: ["Foo", "Bar"], headerPaths: ["/p/Foo.h", "s.h", "b.h"] },
  );
});

it("parseSwiftBuildManifest names the modules of every package", () => {
  const packageModules = parseSwiftBuildManifest(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swiftbuild-manifest.pif", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.ok(packageModules["swift-argument-parser"].includes("ArgumentParser"));
  assert.deepStrictEqual(packageModules.yams, ["CYaml", "Yams"]);
  assert.deepStrictEqual(packageModules.swxmlhash, ["SWXMLHash"]);
  assert.deepStrictEqual(packageModules["argparser-demo"], ["argparser_demo"]);
});

it("parseSwiftImports ignores imports inside comments and strings", () => {
  const imports = parseSwiftImports(
    [
      "import Foundation",
      "/*",
      " import Vapor",
      " /* nested */ import Stillcommented",
      "*/ import Logging",
      'let doc = """',
      "import Vapor",
      '"""',
      'let raw = #"import Vapor \\" still raw"#',
      'let s = "import Vapor"; import NIO',
      "import Crypto // import Vapor",
    ].join("\n"),
  );
  assert.deepStrictEqual(imports, [
    { module: "Foundation", line: 1 },
    { module: "Logging", line: 5 },
    { module: "NIO", line: 10 },
    { module: "Crypto", line: 11 },
  ]);
});

it("splitSwiftCommandArgs keeps Windows paths intact", () => {
  assert.deepStrictEqual(
    splitSwiftCommandArgs(
      'swiftc -module-name Demo C:\\Users\\proj\\Sources\\Demo\\main.swift -I C:\\deps "C:\\Program Files\\Swift\\lib" \'C:\\a b\\c.swift\' -DQ=\\"x\\"',
      "win32",
    ),
    [
      "swiftc",
      "-module-name",
      "Demo",
      "C:\\Users\\proj\\Sources\\Demo\\main.swift",
      "-I",
      "C:\\deps",
      "C:\\Program Files\\Swift\\lib",
      "C:\\a b\\c.swift",
      '-DQ="x"',
    ],
  );
  // Shell quoting and escapes elsewhere
  assert.deepStrictEqual(
    splitSwiftCommandArgs("swiftc -I /a\\ b '/c d' \"e\"", "linux"),
    ["swiftc", "-I", "/a b", "/c d", "e"],
  );
  assert.deepStrictEqual(splitSwiftCommandArgs(undefined, "win32"), []);
});

it("parseSwiftImports finds import declarations", () => {
  const imports = parseSwiftImports(
    [
      "import Foundation",
      "@testable import App",
      "@_implementationOnly import cmark_gfm",
      "public import struct Collections.OrderedSet",
      "@preconcurrency @_spi(Internal) import NIOCore",
      "// import Commented",
      "#if canImport(Darwin)",
      "import Darwin; import Dispatch",
      "let important = 1",
    ].join("\n"),
  );
  assert.deepStrictEqual(imports, [
    { module: "Foundation", line: 1 },
    { module: "App", line: 2 },
    { module: "cmark_gfm", line: 3 },
    { module: "Collections", line: 4 },
    { module: "NIOCore", line: 5 },
    { module: "Darwin", line: 8 },
    { module: "Dispatch", line: 8 },
  ]);
});

it("parseIndex records the lines of every resolved USR", () => {
  const metadata = parseIndex(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-index-argparser-demo.json", {
        encoding: "utf-8",
      }),
    ),
  );
  // Import declarations reference clang-style module USRs
  assert.deepStrictEqual(metadata.usrLines["c:@M@ArgumentParser"], [1]);
  assert.deepStrictEqual(metadata.usrLines["c:@M@Yams"], [3, 15]);
  assert.deepStrictEqual(
    metadata.usrLines["s:9SWXMLHash7XMLHashC5parseyAA10XMLIndexerOSSFZ"],
    [12],
  );
});

it("resolveUsrModules and the demangled-name parser attribute USRs to modules", () => {
  // Real `swift demangle --compact` outputs
  assert.strictEqual(moduleFromDemangledName("SWXMLHash.XMLHash"), "SWXMLHash");
  assert.strictEqual(
    moduleFromDemangledName(
      "static (extension in ArgumentParser):ArgumentParser.ParsableCommand.configuration : ArgumentParser.CommandConfiguration",
    ),
    "ArgumentParser",
  );
  assert.strictEqual(
    moduleFromDemangledName(
      "(extension in Yams):Swift.String.yaml : Swift.String?",
    ),
    "Yams",
  );
  assert.strictEqual(
    moduleFromDemangledName(
      "(extension in Yams):Swift.Array<A where A: Swift.Decodable>.foo() -> ()",
    ),
    "Yams",
  );
  assert.strictEqual(
    moduleFromDemangledName(
      "static SWXMLHash.XMLHash.parse(Swift.String) -> SWXMLHash.XMLIndexer",
    ),
    "SWXMLHash",
  );
  assert.strictEqual(
    moduleFromDemangledName(
      "default argument 0 of Yams.dump(object: Any?) -> Swift.String",
    ),
    "Yams",
  );
  assert.strictEqual(
    moduleFromDemangledName("Swift.print(_: Any...) -> ()"),
    "Swift",
  );
  assert.strictEqual(moduleFromDemangledName("$s4Yams4dumpSSyF"), undefined);
  assert.strictEqual(moduleFromDemangledName(""), undefined);
  // Mangled-prefix fallback when the demangler is unavailable
  assert.strictEqual(
    moduleFromMangledPrefix("$s9SWXMLHash7XMLHashC"),
    "SWXMLHash",
  );
  assert.strictEqual(
    moduleFromMangledPrefix("$s11SwiftSyntax015UnexpectedNodesB0V"),
    "SwiftSyntax",
  );
  assert.strictEqual(moduleFromMangledPrefix("$ss5print"), "Swift");
  assert.strictEqual(moduleFromMangledPrefix("$sSS"), "Swift");
  assert.strictEqual(moduleFromMangledPrefix("$sSo8NSObjectC"), "__C");
  assert.strictEqual(moduleFromMangledPrefix("$s0A4Help"), undefined);
  // Works with or without a swift toolchain on the test host
  const usrModules = resolveUsrModules(
    [
      "c:@M@Yams",
      "s:9SWXMLHash7XMLHashC5parseyAA10XMLIndexerOSSFZ",
      "c:@F@yaml_parser_initialize",
    ],
    ".",
  );
  assert.strictEqual(usrModules.get("c:@M@Yams"), "Yams");
  assert.strictEqual(
    usrModules.get("s:9SWXMLHash7XMLHashC5parseyAA10XMLIndexerOSSFZ"),
    "SWXMLHash",
  );
  assert.strictEqual(usrModules.has("c:@F@yaml_parser_initialize"), false);
});

it("parseSwiftTargetInfo and sourcekittenEnvForToolchain align sourcekitten", () => {
  const swiftly = parseSwiftTargetInfo({
    compilerVersion: "Apple Swift version 6.4 (swift-6.4-RELEASE)",
    target: { triple: "arm64-apple-macosx15.0" },
    paths: {
      runtimeResourcePath:
        "/Users/u/Library/Developer/Toolchains/swift-6.4.0-RELEASE.xctoolchain/usr/lib/swift",
    },
  });
  assert.strictEqual(
    swiftly.toolchainDir,
    "/Users/u/Library/Developer/Toolchains/swift-6.4.0-RELEASE.xctoolchain",
  );
  const xcode = parseSwiftTargetInfo({
    compilerVersion:
      "Apple Swift version 6.1.2 (swiftlang-6.1.2.1.2 clang-1700.0.13.5)",
    paths: {
      runtimeResourcePath:
        "/Applications/Xcode-16.4.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift",
    },
  });
  assert.strictEqual(
    xcode.toolchainDir,
    "/Applications/Xcode-16.4.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain",
  );
  // sourcekitten is pointed at any toolchain that ships the in-process
  // SourceKit: swiftly and Xcode bundles, and the Command Line Tools
  const toolchainsDir = mkdtempSync(join(tmpdir(), "swiftsem-toolchains-"));
  try {
    const layouts = {
      swiftly: "swift-6.4.0-RELEASE.xctoolchain",
      clt: "CommandLineTools",
      old: "swift-5.10-RELEASE.xctoolchain",
    };
    for (const [name, dir] of Object.entries(layouts)) {
      mkdirSync(
        join(
          toolchainsDir,
          dir,
          "usr",
          "lib",
          name === "old" ? "swift" : "sourcekitdInProc.framework",
        ),
        { recursive: true },
      );
    }
    for (const name of ["swiftly", "clt"]) {
      const toolchainDir = join(toolchainsDir, layouts[name]);
      assert.deepStrictEqual(
        sourcekittenEnvForToolchain({ toolchainDir }, "darwin"),
        { XCODE_DEFAULT_TOOLCHAIN_OVERRIDE: toolchainDir },
      );
    }
    // Toolchains before Swift 6.1 have no in-process SourceKit to point at;
    // the warning that says so is captured rather than printed
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args.join(" "));
    let oldEnv;
    try {
      oldEnv = sourcekittenEnvForToolchain(
        { toolchainDir: join(toolchainsDir, layouts.old) },
        "darwin",
      );
    } finally {
      console.log = originalLog;
    }
    assert.strictEqual(oldEnv, undefined);
    assert.ok(logged.some((l) => l.includes("no sourcekitdInProc.framework")));
  } finally {
    rmSync(toolchainsDir, { recursive: true, force: true });
  }
  // Linux tarball installs under /usr; the library lookup is only set when
  // the toolchain ships sourcekitd
  const linux = parseSwiftTargetInfo({
    compilerVersion: "Swift version 6.3.3 (swift-6.3.3-RELEASE)",
    paths: { runtimeResourcePath: "/usr/lib/swift" },
  });
  assert.strictEqual(linux.toolchainDir, "/");
  assert.strictEqual(
    sourcekittenEnvForToolchain({ toolchainDir: "/nonexistent" }, "linux"),
    undefined,
  );
  assert.strictEqual(
    sourcekittenEnvForToolchain(undefined, "darwin"),
    undefined,
  );
  assert.strictEqual(
    parseSwiftTargetInfo({ paths: { runtimeResourcePath: "/opt/swift" } })
      .toolchainDir,
    undefined,
  );
  assert.strictEqual(parseSwiftTargetInfo({}), undefined);
});

it("module name helpers", () => {
  assert.deepStrictEqual(toModuleName("argparser-demo"), "argparser_demo");
  assert.deepStrictEqual(toModuleName("generate-manual"), "generate_manual");
  assert.deepStrictEqual(toModuleName("Yams"), "Yams");
  assert.strictEqual(isTestOrAggregateModule("argparser_demoTests"), true);
  assert.strictEqual(isTestOrAggregateModule("ArgumentParser"), false);
  assert.strictEqual(isTestOrAggregateModule("SWXMLHash-product"), true);
  assert.strictEqual(
    isTestOrAggregateModule("argparser_demoTests_test_runner"),
    true,
  );
  assert.strictEqual(isTestOrAggregateModule(""), true);
});

it("collectBuildSymbols supports both build engines", () => {
  let metadata = parseOutputFileMap(
    "./test/data/swiftsem/build-tree/.build/arm64-apple-macosx/debug/ArgumentParser-tool.build/output-file-map.json",
  );
  assert.deepStrictEqual(metadata.moduleName, "ArgumentParser");
  assert.ok(metadata.moduleSymbols.length > 0);
  metadata = parseOutputFileMap(
    "./test/data/swiftsem/swiftbuild/argparser-demo-OutputFileMap.json",
  );
  assert.deepStrictEqual(metadata.moduleName, "argparser_demo");
  assert.deepStrictEqual(metadata.moduleSymbols, ["main"]);
  const symbolsMap = collectBuildSymbols("./test/data/swiftsem/build-tree", {});
  assert.deepStrictEqual(Object.keys(symbolsMap).sort(), [
    "ArgumentParser",
    "Yams",
    "argparser_demo",
  ]);
});

it("parseModuleInfo collects only top-level functions", () => {
  const metadata = parseModuleInfo(
    JSON.parse(
      readFileSync("./test/data/swiftsem/swift-module-info-yams.json", {
        encoding: "utf-8",
      }),
    ),
  );
  // Members of types and extensions are indented in the interface and are
  // not free functions; treating them as such matched `encode(to:)` and
  // friends in every module
  assert.deepStrictEqual(metadata.functions, [
    "compose",
    "compose_all",
    "dump",
    "load",
    "load_all",
    "serialize",
  ]);
  assert.ok(metadata.importedModules.includes("CYaml"));
});

it("parseDumpPackage treats test-support libraries like tests", () => {
  // scope-lab: TestSupport is a regular library target that only the tests
  // depend on, so its sources are not indexed for evidence
  const metadata = parseDumpPackage(
    JSON.parse(
      readFileSync("./test/data/swift-scope/dump-scope-lab.json", {
        encoding: "utf-8",
      }),
    ),
  );
  assert.deepStrictEqual(metadata.rootModules, ["App", "Core"]);
  assert.deepStrictEqual(metadata.testModules, ["CoreTests", "TestSupport"]);
});

it("withoutSwiftPluginArgs drops the arguments that load project-named code", () => {
  const args = [
    "-module-name",
    "App",
    "-I",
    "/work/.build/debug/Modules",
    "-load-plugin-library",
    "/work/.build/debug/libMacros.dylib",
    "-D",
    "DEBUG",
    "-load-plugin-executable",
    "/work/.build/debug/MacrosPlugin#Macros",
    "-plugin-path",
    "/work/plugins",
    "-external-plugin-path",
    "/work/ext#/work/ext-server",
    "-in-process-plugin-server-path",
    "/work/libSwiftInProcPluginServer.dylib",
    "-Xfrontend",
    "-load-plugin-executable",
    "-Xfrontend",
    "/work/.build/debug/Other#Other",
    "-Xfrontend",
    "-strict-concurrency=complete",
    "-Xfrontend",
    "-plugin-path",
    "-Xfrontend",
    "/work/more-plugins",
    "-Xcc",
    "-fplugin=/work/evil.so",
    "-Xcc",
    "-I/work/include",
    "-sdk",
    "/sdk/MacOSX.sdk",
  ];
  const original = [...args];
  assert.deepStrictEqual(withoutSwiftPluginArgs(args), [
    "-module-name",
    "App",
    "-I",
    "/work/.build/debug/Modules",
    "-D",
    "DEBUG",
    "-Xfrontend",
    "-strict-concurrency=complete",
    "-sdk",
    "/sdk/MacOSX.sdk",
  ]);
  // The input is left as it was
  assert.deepStrictEqual(args, original);
});

it("withoutSwiftPluginArgs keeps arguments without plugins and tolerates no input", () => {
  const args = [
    "-module-name",
    "Core",
    "-I",
    "inc",
    "-D",
    "FEATURE",
    "-swift-version",
    "5",
  ];
  assert.deepStrictEqual(withoutSwiftPluginArgs(args), args);
  assert.deepStrictEqual(withoutSwiftPluginArgs(undefined), []);
  assert.deepStrictEqual(withoutSwiftPluginArgs([]), []);
});

it("withoutSwiftPluginArgs never reads a value as a flag", () => {
  // Values spelled like flags must not shift the list: `-I -Xcc` followed by
  // `-Xfrontend -enable-upcoming-feature -Xfrontend -load-resolved-plugin`
  // keeps every value in its value position
  const args = sanitizeSwiftModuleArgs([
    "-I",
    "-Xcc",
    "-Xfrontend",
    "-enable-upcoming-feature",
    "-Xfrontend",
    "-load-resolved-plugin",
    "-F",
    "-Xcc",
    "-Xfrontend",
    "-enable-upcoming-feature",
    "-Xfrontend",
    "/work/libEvil.so##Evil",
    "-I",
    "-Xfrontend",
    "-plugin-path",
    "-Xfrontend",
    "/work/plugins",
    "-D",
    "-load-plugin-library",
    "-parse-as-library",
    "-I",
    "@/work/args.resp",
    "-Xcc",
    "-fplugin=/work/evil.so",
    "-swift-version",
    "5",
  ]);
  assert.deepStrictEqual(withoutSwiftPluginArgs(args), [
    "-I",
    "-Xcc",
    "-Xfrontend",
    "-enable-upcoming-feature",
    "-Xfrontend",
    "-load-resolved-plugin",
    "-F",
    "-Xcc",
    "-Xfrontend",
    "-enable-upcoming-feature",
    "-Xfrontend",
    "/work/libEvil.so##Evil",
    "-I",
    "-Xfrontend",
    "-D",
    "-load-plugin-library",
    "-parse-as-library",
    "-swift-version",
    "5",
  ]);
});
