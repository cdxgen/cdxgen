import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import toml from "@iarna/toml";

import { safeExistsSync } from "./utils.js";

// Keep this list conservative and high-signal: it is meant to surface common
// Rust native build helpers for audit triage, not to exhaustively model every
// crate that may participate in a native build pipeline.
const NATIVE_BUILD_DEPENDENCIES = [
  "autocfg",
  "bindgen",
  "cc",
  "cbindgen",
  "cmake",
  "cxx-build",
  "grpcio-compiler",
  "nasm-rs",
  "openssl-sys",
  "pkg-config",
  "prost-build",
  "protobuf-src",
  "pyo3-build-config",
  "ring",
  "tauri-build",
  "tonic-build",
];

const BUILD_SCRIPT_CAPABILITY_PATTERNS = [
  ["process-execution", /\b(?:std::process::Command|Command::new|duct::cmd)\b/],
  [
    "native-tooling",
    /\b(?:cc::Build|bindgen::Builder|cmake::Config|pkg_config::Config|autocfg::)/,
  ],
  [
    "linker-directives",
    /cargo:rustc-link-(?:lib|search|arg|arg-bins|arg-bin|arg-tests|arg-examples)/,
  ],
  [
    "file-generation",
    /\b(?:std::fs::(?:write|copy|create_dir_all)|include_bytes!|include_str!)\b/,
  ],
  ["network-access", /\b(?:reqwest|ureq|curl|git2)\b/],
];

function appendProperty(properties, name, value) {
  if (!name || value === undefined || value === null || value === "") {
    return;
  }
  properties.push({
    name,
    value: typeof value === "string" ? value : String(value),
  });
}

function createFormulationComponent(name, filePath, toolName) {
  return {
    type: "application",
    name,
    version: "config",
    "bom-ref": `urn:cdxgen:formulation:${toolName}:${filePath}`,
    properties: [{ name: "SrcFile", value: filePath }],
  };
}

function parseCargoManifest(filePath) {
  let cargoData;
  try {
    cargoData = toml.parse(readFileSync(filePath, { encoding: "utf-8" }));
  } catch {
    return undefined;
  }
  if (!cargoData || typeof cargoData !== "object") {
    return undefined;
  }
  const packageName =
    cargoData?.package?.name || basename(dirname(filePath)) || "cargo-project";
  const component = createFormulationComponent(packageName, filePath, "cargo");
  const properties = component.properties;
  const buildDependencies = cargoData?.["build-dependencies"];
  const devDependencies = cargoData?.["dev-dependencies"];
  const targetBlocks =
    cargoData?.target && typeof cargoData.target === "object"
      ? Object.values(cargoData.target)
      : [];
  const targetDependencyBlocks = targetBlocks.filter(
    (block) => block && typeof block === "object",
  );
  const packageNode = cargoData?.package || {};
  const buildScriptPath =
    typeof packageNode.build === "string"
      ? join(dirname(filePath), packageNode.build)
      : join(dirname(filePath), "build.rs");
  const hasBuildScript =
    typeof packageNode.build === "string" || safeExistsSync(buildScriptPath);
  const buildDependencyNames = Object.keys(buildDependencies || {});
  const targetBuildDependencyNames = targetDependencyBlocks.flatMap((block) =>
    Object.keys(block?.["build-dependencies"] || {}),
  );
  const allBuildDependencyNames = [
    ...new Set([...buildDependencyNames, ...targetBuildDependencyNames]),
  ];
  const nativeBuildIndicators = buildDependencyNames.filter((dependencyName) =>
    NATIVE_BUILD_DEPENDENCIES.includes(dependencyName),
  );
  const targetNativeBuildIndicators = targetBuildDependencyNames.filter(
    (dependencyName) =>
      NATIVE_BUILD_DEPENDENCIES.includes(dependencyName) ||
      dependencyName.endsWith("-sys"),
  );
  const expandedNativeBuildIndicators = [
    ...new Set([
      ...nativeBuildIndicators,
      ...targetNativeBuildIndicators,
      ...allBuildDependencyNames.filter((dependencyName) =>
        dependencyName.endsWith("-sys"),
      ),
    ]),
  ];
  const releaseProfiles = Object.keys(cargoData?.profile || {});
  let buildScriptCapabilities = [];
  let buildScriptIndicators = [];
  if (hasBuildScript) {
    try {
      const buildScriptContent = readFileSync(buildScriptPath, {
        encoding: "utf-8",
      });
      buildScriptCapabilities = BUILD_SCRIPT_CAPABILITY_PATTERNS.filter(
        ([, pattern]) => pattern.test(buildScriptContent),
      ).map(([capability]) => capability);
      if (/println!\s*\(\s*"cargo:/.test(buildScriptContent)) {
        buildScriptIndicators.push("cargo-directives");
      }
      if (/include_bytes!|include_str!/.test(buildScriptContent)) {
        buildScriptIndicators.push("embedded-assets");
      }
    } catch {
      buildScriptCapabilities = [];
      buildScriptIndicators = [];
    }
  }

  appendProperty(properties, "cdx:rust:buildTool", "cargo");
  appendProperty(
    properties,
    "cdx:cargo:manifestMode",
    cargoData?.workspace ? "workspace" : "package",
  );
  appendProperty(
    properties,
    "cdx:cargo:hasWorkspaceMembers",
    Array.isArray(cargoData?.workspace?.members) ? "true" : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:workspaceMembers",
    Array.isArray(cargoData?.workspace?.members)
      ? cargoData.workspace.members.join(", ")
      : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:hasBuildDependencies",
    allBuildDependencyNames.length ? "true" : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:hasDevDependencies",
    Object.keys(devDependencies || {}).length ? "true" : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:hasTargetDependencies",
    targetDependencyBlocks.some(
      (block) =>
        Object.keys(block?.dependencies || {}).length ||
        Object.keys(block?.["build-dependencies"] || {}).length ||
        Object.keys(block?.["dev-dependencies"] || {}).length,
    )
      ? "true"
      : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:hasBuildScript",
    hasBuildScript ? "true" : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:buildScript",
    hasBuildScript ? buildScriptPath : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:publish",
    packageNode.publish === false ? "false" : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:rustVersion",
    packageNode["rust-version"],
  );
  appendProperty(
    properties,
    "cdx:cargo:releaseProfiles",
    releaseProfiles.length ? releaseProfiles.join(", ") : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:nativeBuildIndicators",
    expandedNativeBuildIndicators.length
      ? expandedNativeBuildIndicators.join(", ")
      : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:buildDependencyNames",
    allBuildDependencyNames.length
      ? allBuildDependencyNames.join(", ")
      : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:buildScriptCapabilities",
    buildScriptCapabilities.length
      ? buildScriptCapabilities.join(", ")
      : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:buildScriptIndicators",
    buildScriptIndicators.length ? buildScriptIndicators.join(", ") : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:hasNativeBuild",
    hasBuildScript ||
      expandedNativeBuildIndicators.length ||
      buildScriptCapabilities.length
      ? "true"
      : undefined,
  );
  appendProperty(
    properties,
    "cdx:cargo:usesMaturin",
    cargoData?.package?.metadata?.maturin ? "true" : undefined,
  );
  return component;
}

function parsePyProject(filePath) {
  let pyprojectData;
  try {
    pyprojectData = toml.parse(readFileSync(filePath, { encoding: "utf-8" }));
  } catch {
    return undefined;
  }
  const buildBackend = pyprojectData?.["build-system"]?.["build-backend"];
  const toolMaturin = pyprojectData?.tool?.maturin;
  if (
    !toolMaturin &&
    (typeof buildBackend !== "string" || !buildBackend.includes("maturin"))
  ) {
    return undefined;
  }
  const component = createFormulationComponent(
    pyprojectData?.project?.name ||
      basename(dirname(filePath)) ||
      "maturin-project",
    filePath,
    "maturin",
  );
  const properties = component.properties;
  appendProperty(properties, "cdx:rust:buildTool", "maturin");
  appendProperty(properties, "cdx:maturin:buildBackend", buildBackend);
  appendProperty(
    properties,
    "cdx:maturin:moduleName",
    toolMaturin?.["module-name"] || toolMaturin?.module_name,
  );
  appendProperty(properties, "cdx:maturin:bindings", toolMaturin?.bindings);
  appendProperty(
    properties,
    "cdx:maturin:compatibility",
    toolMaturin?.compatibility,
  );
  appendProperty(
    properties,
    "cdx:maturin:features",
    Array.isArray(toolMaturin?.features)
      ? toolMaturin.features.join(", ")
      : undefined,
  );
  appendProperty(
    properties,
    "cdx:maturin:manifestPath",
    toolMaturin?.manifest_path || toolMaturin?.["manifest-path"],
  );
  appendProperty(
    properties,
    "cdx:maturin:strip",
    toolMaturin?.strip === true ? "true" : undefined,
  );
  return component;
}

export const rustFormulationParser = {
  id: "rust-build",
  patterns: ["**/Cargo.toml", "**/pyproject.toml"],
  parse(files) {
    const components = [];
    for (const filePath of files || []) {
      if (filePath.endsWith("Cargo.toml")) {
        const cargoComponent = parseCargoManifest(filePath);
        if (cargoComponent) {
          components.push(cargoComponent);
        }
        continue;
      }
      if (filePath.endsWith("pyproject.toml")) {
        const pyprojectComponent = parsePyProject(filePath);
        if (pyprojectComponent) {
          components.push(pyprojectComponent);
        }
      }
    }
    return { components };
  },
};
