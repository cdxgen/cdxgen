import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

[profile.release]
lto = true
`,
    );
    writeFileSync(path.join(tmpDir, "build.rs"), "fn main() {}\n");
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
        "cc",
      );
      assert.strictEqual(
        getProp(cargoComponent, "cdx:cargo:hasBuildScript"),
        "true",
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
});
