import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "poku";

import { addFormulationSection } from "./formulationParsers.js";

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

describe("addFormulationSection()", () => {
  it("adds README file components when hidden Unicode is detected", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    writeFileSync(
      path.join(tmpDir, "README.md"),
      "# Demo\n<!-- hidden \u200B comment -->\nContent",
    );

    try {
      const result = addFormulationSection(tmpDir, { specVersion: 1.7 });
      const formulation = result.formulation[0];
      const readmeComponent = formulation.components.find(
        (component) => getProp(component, "cdx:file:kind") === "readme",
      );
      assert.ok(readmeComponent, "expected README formulation component");
      assert.strictEqual(
        getProp(readmeComponent, "cdx:file:hasHiddenUnicode"),
        "true",
      );
      assert.strictEqual(
        getProp(readmeComponent, "cdx:file:hiddenUnicodeInComments"),
        "true",
      );
      assert.match(
        getProp(readmeComponent, "cdx:file:hiddenUnicodeCodePoints"),
        /U\+200B/,
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("adds Cargo and maturin formulation components for Rust build context", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    writeFileSync(
      path.join(tmpDir, "Cargo.toml"),
      `[package]
name = "cargo-demo"
version = "1.0.0"
build = "build.rs"
rust-version = "1.78"

[build-dependencies]
cc = "1.0.0"
openssl-sys = "0.9.0"

[profile.release]
lto = true
`,
    );
    writeFileSync(
      path.join(tmpDir, "build.rs"),
      [
        'println!("cargo:rustc-link-lib=ssl");',
        'std::process::Command::new("cc");',
        'std::fs::write("generated.rs", "");',
      ].join("\n"),
    );
    writeFileSync(
      path.join(tmpDir, "pyproject.toml"),
      `[build-system]
requires = ["maturin>=1.0,<2.0"]
build-backend = "maturin"

[project]
name = "maturin-demo"

[tool.maturin]
bindings = "pyo3"
module-name = "maturin_demo._native"
features = ["pyo3/extension-module"]
`,
    );

    try {
      const result = addFormulationSection(tmpDir, { specVersion: 1.7 });
      const formulation = result.formulation[0];
      const cargoComponent = formulation.components.find(
        (component) => getProp(component, "cdx:rust:buildTool") === "cargo",
      );
      const maturinComponent = formulation.components.find(
        (component) => getProp(component, "cdx:rust:buildTool") === "maturin",
      );
      assert.ok(cargoComponent, "expected cargo formulation component");
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:hasNativeBuild"),
        "true",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:nativeBuildIndicators"),
        "cc, openssl-sys",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:hasBuildScript"),
        "true",
      );
      assert.match(
        getProp(cargoComponent, "cdx:cargo:buildScriptCapabilities"),
        /process-execution/,
      );
      assert.match(
        getProp(cargoComponent, "cdx:cargo:buildScriptCapabilities"),
        /linker-directives/,
      );
      assert.match(
        getProp(cargoComponent, "cdx:cargo:buildScriptCapabilities"),
        /file-generation/,
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:rustVersion"),
        "1.78",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:releaseProfiles"),
        "release",
      );
      assert.ok(maturinComponent, "expected maturin formulation component");
      assert.strictEqual(
        getProp(maturinComponent, "cdx:maturin:buildBackend"),
        "maturin",
      );
      assert.strictEqual(
        getProp(maturinComponent, "cdx:maturin:bindings"),
        "pyo3",
      );
      assert.strictEqual(
        getProp(maturinComponent, "cdx:maturin:moduleName"),
        "maturin_demo._native",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("adds virtual-workspace formulation metadata for Cargo workspaces", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cdxgen-formulation-"));
    const memberDir = path.join(tmpDir, "crates", "member-a");
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(
      path.join(tmpDir, "Cargo.toml"),
      `[workspace]
members = ["crates/*"]
`,
    );
    writeFileSync(
      path.join(memberDir, "Cargo.toml"),
      `[package]
name = "member-a"
version = "1.0.0"
`,
    );

    try {
      const result = addFormulationSection(tmpDir, { specVersion: 1.7 });
      const formulation = result.formulation[0];
      const workspaceComponent = formulation.components.find(
        (component) =>
          getProp(component, "cdx:cargo:manifestMode") === "workspace",
      );
      assert.ok(
        workspaceComponent,
        "expected cargo workspace formulation component",
      );
      assert.strictEqual(
        getProp(workspaceComponent, "cdx:cargo:hasWorkspaceMembers"),
        "true",
      );
      assert.strictEqual(
        getProp(workspaceComponent, "cdx:cargo:workspaceMembers"),
        "crates/*",
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
