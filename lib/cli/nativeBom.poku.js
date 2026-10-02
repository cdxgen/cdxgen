import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { resetRecordedActivities, setDryRunMode } from "../ecosystems/utils.js";
import { auditBom } from "../stages/postgen/auditBom.js";
import { postProcess } from "../stages/postgen/postgen.js";
import { validateBom } from "../validator/bomValidator.js";
import {
  buildMinimalCliEnv,
  cargoCacheFixtureDir,
  cargoFixtureDir,
  repoDir,
} from "./bomTestHelpers.poku.js";
import { createBom } from "./index.js";
import { createRustBom } from "./nativeBom.js";

describe("nativeBom", () => {
  describe("createGoBom() with USE_GOSUM", () => {
    const gosumFixtureDir = join("test", "data", "gosum-mod-why");
    const whyConfirmed = (module, pkg = module) => ({
      status: 0,
      stdout: `# ${module}\nexample.com/gosum-mod-why\n${pkg}\n`,
    });
    const whyNotNeeded = (module) => ({
      status: 0,
      stdout: `# ${module}\n(main module does not need to vendor module ${module})\n`,
    });
    const whyFailed = {
      status: 1,
      stdout: "",
      stderr: "go: updates to go.mod needed",
    };

    const scanWithGoModWhy = async (answers) => {
      const actualFs = await import("../core/fs.js");
      const goModWhyCalls = [];
      const safeSpawnSync = sinon.stub().callsFake((cmd, args, opts) => {
        if (cmd === "go" && args?.[0] === "mod" && args?.[1] === "why") {
          const module = args[args.length - 1];
          goModWhyCalls.push(module);
          return answers[module];
        }
        return actualFs.safeSpawnSync(cmd, args, opts);
      });
      const { createGoBom } = await esmock("./nativeBom.js", {
        "../core/fs.js": { ...actualFs, safeSpawnSync },
      });
      const previousUseGosum = process.env.USE_GOSUM;
      process.env.USE_GOSUM = "true";
      try {
        const bomNSData = await createGoBom(gosumFixtureDir, {
          multiProject: false,
          installDeps: false,
          specVersion: 1.7,
        });
        const scopeOf = (name) =>
          bomNSData.bomJson.components.find((component) =>
            component.purl?.includes(name),
          )?.scope;
        return { goModWhyCalls, scopeOf };
      } finally {
        if (previousUseGosum === undefined) {
          delete process.env.USE_GOSUM;
        } else {
          process.env.USE_GOSUM = previousUseGosum;
        }
      }
    };

    it("scopes modules go mod why confirms as required and the rest as optional", async () => {
      const { goModWhyCalls, scopeOf } = await scanWithGoModWhy({
        "github.com/pkg/errors": whyConfirmed("github.com/pkg/errors"),
        "github.com/stretchr/testify": whyNotNeeded(
          "github.com/stretchr/testify",
        ),
        // Confirmed through a package of the module
        "golang.org/x/sys": whyConfirmed(
          "golang.org/x/sys",
          "golang.org/x/sys/unix",
        ),
      });

      assert.deepStrictEqual(goModWhyCalls, [
        "github.com/pkg/errors",
        "github.com/stretchr/testify",
        "golang.org/x/sys",
      ]);
      assert.strictEqual(scopeOf("github.com/pkg/errors"), "required");
      assert.strictEqual(scopeOf("github.com/stretchr/testify"), "optional");
      assert.strictEqual(scopeOf("golang.org/x/sys"), "required");
    });

    it("demotes nothing when go mod why fails part way", async () => {
      const { goModWhyCalls, scopeOf } = await scanWithGoModWhy({
        "github.com/pkg/errors": whyConfirmed("github.com/pkg/errors"),
        "github.com/stretchr/testify": whyNotNeeded(
          "github.com/stretchr/testify",
        ),
        "golang.org/x/sys": whyFailed,
      });

      assert.deepStrictEqual(goModWhyCalls, [
        "github.com/pkg/errors",
        "github.com/stretchr/testify",
        "golang.org/x/sys",
      ]);
      assert.strictEqual(scopeOf("github.com/pkg/errors"), "required");
      // go said testify is not needed, but the run is incomplete
      assert.strictEqual(scopeOf("github.com/stretchr/testify"), undefined);
      assert.strictEqual(scopeOf("golang.org/x/sys"), undefined);
    });

    it("stops calling go mod why after the first failure", async () => {
      const { goModWhyCalls, scopeOf } = await scanWithGoModWhy({
        "github.com/pkg/errors": whyFailed,
      });

      assert.deepStrictEqual(goModWhyCalls, ["github.com/pkg/errors"]);
      assert.strictEqual(scopeOf("github.com/pkg/errors"), undefined);
      assert.strictEqual(scopeOf("github.com/stretchr/testify"), undefined);
      assert.strictEqual(scopeOf("golang.org/x/sys"), undefined);
    });

    it("does not confirm a module from a package of a longer module path", async () => {
      const { scopeOf } = await scanWithGoModWhy({
        "github.com/pkg/errors": whyConfirmed(
          "github.com/pkg/errors",
          "github.com/pkg/errorsx/wrap",
        ),
        "github.com/stretchr/testify": whyNotNeeded(
          "github.com/stretchr/testify",
        ),
        "golang.org/x/sys": whyNotNeeded("golang.org/x/sys"),
      });

      assert.strictEqual(scopeOf("github.com/pkg/errors"), undefined);
    });
  });

  describe("createCocoaBom()", () => {
    it("should skip missing Podfile.lock when failOnError is false", async () => {
      const { createCocoaBom } = await import("./index.js");
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-cocoa-"));
      const podFile = join(tempDir, "Podfile");
      writeFileSync(
        podFile,
        "platform :ios, '14.0'\n\ntarget 'TestApp' do\nend\n",
        "utf-8",
      );
      const consoleLogStub = sinon.stub(console, "log");
      try {
        const bomData = await createCocoaBom(tempDir, {
          deep: false,
          failOnError: false,
          installDeps: false,
          multiProject: false,
        });
        assert.equal(bomData, undefined);
        sinon.assert.calledWithMatch(
          consoleLogStub,
          sinon.match("No 'Podfile.lock' found"),
        );
      } finally {
        consoleLogStub.restore();
        rmSync(tempDir, { force: true, recursive: true });
      }
    });

    it("should not warn or exit for deep mode when Podfile.lock exists", async () => {
      const { createCocoaBom } = await import("./index.js");
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-cocoa-deep-"));
      const podFile = join(tempDir, "Podfile");
      const lockFile = join(tempDir, "Podfile.lock");
      writeFileSync(
        podFile,
        "platform :ios, '14.0'\n\ntarget 'TestApp' do\nend\n",
        "utf-8",
      );
      writeFileSync(lockFile, "PODS: []\nDEPENDENCIES: []\n", "utf-8");
      const processExitStub = sinon.stub(process, "exit");
      try {
        await createCocoaBom(tempDir, {
          deep: true,
          failOnError: true,
          installDeps: false,
          multiProject: false,
        });
        sinon.assert.notCalled(processExitStub);
      } finally {
        processExitStub.restore();
        rmSync(tempDir, { force: true, recursive: true });
      }
    });
  });

  describe("createBom() cargo cache support", () => {
    it("catalogs cached cargo crate archives via the cargo-cache project type", async () => {
      const originalCargoCacheDir = process.env.CARGO_CACHE_DIR;
      try {
        process.env.CARGO_CACHE_DIR = cargoCacheFixtureDir;
        const bomNSData = await createBom(cargoCacheFixtureDir, {
          deep: false,
          failOnError: true,
          installDeps: false,
          multiProject: false,
          projectType: ["cargo-cache"],
          specVersion: 1.6,
        });
        const bomJson = bomNSData?.bomJson || {};
        const components = bomJson.components || [];
        const serdeComponent = components.find(
          (component) => component.name === "serde",
        );
        assert.ok(serdeComponent);
        assert.strictEqual(serdeComponent.version, "1.0.217");
        assert.strictEqual(
          serdeComponent.properties.find(
            (property) => property.name === "cdx:cargo:cacheSource",
          )?.value,
          "registry-cache",
        );
      } finally {
        if (originalCargoCacheDir === undefined) {
          delete process.env.CARGO_CACHE_DIR;
        } else {
          process.env.CARGO_CACHE_DIR = originalCargoCacheDir;
        }
      }
    });

    it("creates a Cargo workspace BOM with workflow signals and matching audit findings", async () => {
      const options = {
        bomAudit: true,
        bomAuditCategories: "package-integrity",
        bomAuditMinSeverity: "low",
        failOnError: true,
        includeFormulation: true,
        installDeps: false,
        multiProject: true,
        projectType: ["cargo", "github"],
        specVersion: 1.7,
      };
      const bomNSData = await createBom(cargoFixtureDir, options);
      const processedBomNSData = await postProcess(
        bomNSData,
        options,
        cargoFixtureDir,
      );
      const bomJson = processedBomNSData?.bomJson || {};
      const coreComponent = (bomJson.components || []).find(
        (component) =>
          component.name === "core" &&
          component.properties?.some(
            (property) =>
              property.name === "cdx:cargo:workspaceDependencyResolved" &&
              property.value === "true",
          ),
      );
      const buildHelperComponent = (bomJson.components || []).find(
        (component) =>
          component.name === "build-helper" &&
          component.properties?.some(
            (property) =>
              property.name === "cdx:cargo:workspaceDependencyResolved" &&
              property.value === "true",
          ),
      );
      const cargoToolchainComponent = (bomJson.components || []).find(
        (component) =>
          component.properties?.some(
            (property) =>
              property.name === "cdx:github:action:role" &&
              property.value === "toolchain",
          ),
      );
      const cargoRunComponent = (bomJson.components || []).find((component) =>
        component.properties?.some(
          (property) =>
            property.name === "cdx:github:step:usesCargo" &&
            property.value === "true",
        ),
      );
      assert.strictEqual(
        coreComponent?.properties?.find(
          (property) =>
            property.name === "cdx:cargo:workspaceDependencyResolved",
        )?.value,
        "true",
      );
      assert.strictEqual(
        buildHelperComponent?.properties?.find(
          (property) => property.name === "cdx:cargo:dependencyKind",
        )?.value,
        "build",
      );
      assert.strictEqual(
        buildHelperComponent?.properties?.find(
          (property) => property.name === "cdx:cargo:resolvedWorkspaceMember",
        )?.value,
        "build-helper",
      );
      assert.strictEqual(
        cargoToolchainComponent?.properties?.find(
          (property) => property.name === "cdx:github:action:ecosystem",
        )?.value,
        "cargo",
      );
      assert.strictEqual(
        cargoRunComponent?.properties?.find(
          (property) => property.name === "cdx:github:step:cargoSubcommands",
        )?.value,
        "build,test",
      );
      const findings = await auditBom(bomJson, {
        bomAuditCategories: "package-integrity",
        bomAuditMinSeverity: "low",
      });
      assert.ok(findings.some((finding) => finding.ruleId === "INT-012"));
      assert.ok(findings.some((finding) => finding.ruleId === "INT-013"));
    });

    it("nests only manifest package components under the Rust parent component", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-rust-parent-"));
      const helperDir = join(tmpDir, "crates", "helper");
      mkdirSync(helperDir, { recursive: true });
      writeFileSync(
        join(tmpDir, "Cargo.toml"),
        `[package]
name = "demo-app"
version = "1.0.0"

[workspace]
members = ["crates/helper"]

[dependencies]
helper = { path = "crates/helper" }
serde = "1.0.0"
`,
      );
      writeFileSync(
        join(helperDir, "Cargo.toml"),
        `[package]
name = "helper"
version = "0.1.0"

[dependencies]
serde = "1.0.0"
`,
      );
      writeFileSync(
        join(tmpDir, "Cargo.lock"),
        `version = 3

[[package]]
name = "demo-app"
version = "1.0.0"
dependencies = ["helper", "serde"]

[[package]]
name = "helper"
version = "0.1.0"
dependencies = ["serde"]

[[package]]
name = "serde"
version = "1.0.0"
checksum = "${"a".repeat(64)}"
`,
      );
      try {
        const bomData = await createRustBom(tmpDir, {
          installDeps: false,
          multiProject: true,
          specVersion: 1.7,
        });
        const parentComponent = bomData.parentComponent;
        const nestedComponentNames = parentComponent.components.map(
          (component) => component.name,
        );
        assert.strictEqual(parentComponent.name, "demo-app");
        assert.deepStrictEqual(nestedComponentNames, ["helper"]);
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });

    it("converts transient keys on nested workspace members into schema-valid fields (issues #4326, #4327)", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-rust-nested-"));
      const appDir = join(tmpDir, "crates", "amphora");
      const helperDir = join(tmpDir, "crates", "helper");
      mkdirSync(appDir, { recursive: true });
      mkdirSync(helperDir, { recursive: true });
      writeFileSync(
        join(tmpDir, "Cargo.toml"),
        `[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.package]
repository = "https://github.com/example/amphora"
`,
      );
      writeFileSync(
        join(appDir, "Cargo.toml"),
        `[package]
name = "amphora"
version = "1.8.6-rc.1"
homepage = "https://example.com/amphora"
repository = "https://github.com/example/amphora"
license = "Apache-2.0"

[dependencies]
serde = "1.0.0"
`,
      );
      writeFileSync(
        join(helperDir, "Cargo.toml"),
        `[package]
name = "helper"

[dependencies]
libc = "0.2.159"
`,
      );
      writeFileSync(
        join(tmpDir, "Cargo.lock"),
        `# This file is automatically @generated by Cargo.
version = 3

[[package]]
name = "amphora"
version = "1.8.6-rc.1"
dependencies = ["serde"]

[[package]]
name = "helper"
version = "0.0.0"
dependencies = ["libc"]

[[package]]
name = "libc"
version = "0.2.159"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "7065ecac245ccd827f4f93d1a94e9a5b3b2c69b0a07b7f045ad78a82e1706a29c"

[[package]]
name = "serde"
version = "1.0.210"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "c8ab6ac9ca0e0b2f04e4c5552841e1c950c456d196d5e5c68c36e6e7b4410e2"
`,
      );
      const consoleWarnStub = sinon.stub(console, "warn");
      try {
        const bomData = await createBom(tmpDir, {
          installDeps: false,
          multiProject: true,
          projectType: ["rust"],
          projectName: "amphora",
          projectVersion: "1.8.6-rc.1",
          specVersion: 1.6,
        });
        // Unversioned local packages must not raise parse warnings (#4327).
        const parseWarnings = consoleWarnStub
          .getCalls()
          .map((call) => String(call.args[0] || ""))
          .filter((message) => message.includes("Failed to parse package"));
        assert.deepStrictEqual(
          parseWarnings,
          [],
          "unversioned cargo packages must parse without warnings",
        );
        const bomJson = bomData.bomJson;
        const collectNested = () => {
          const nested = [];
          for (const component of bomJson.components || []) {
            if (Array.isArray(component.components)) {
              nested.push(...component.components);
            }
          }
          if (Array.isArray(bomJson.metadata?.component?.components)) {
            nested.push(...bomJson.metadata.component.components);
          }
          return nested;
        };
        const nested = collectNested();
        assert.ok(nested.length >= 2, "expected nested workspace members");
        const nestedAmphora = nested.find((c) => c.name === "amphora");
        const nestedHelper = nested.find((c) => c.name === "helper");
        assert.ok(nestedAmphora, "expected amphora nested under the parent");
        assert.ok(nestedHelper, "expected helper nested under the parent");
        // Raw parser keys must never reach nested components (#4326).
        for (const component of nested) {
          for (const transientKey of [
            "homepage",
            "repository",
            "license",
            "bugs",
            "distribution",
            "_integrity",
            "qualifiers",
          ]) {
            assert.strictEqual(
              component[transientKey],
              undefined,
              `nested component ${component.name} must not carry ${transientKey}`,
            );
          }
        }
        // The data must be converted, not dropped.
        assert.ok(
          nestedAmphora.licenses?.some(
            (license) => license.license?.id === "Apache-2.0",
          ),
          "expected license converted into a licenses entry",
        );
        assert.ok(
          nestedAmphora.externalReferences?.some(
            (ref) =>
              ref.type === "website" &&
              ref.url === "https://example.com/amphora",
          ),
          "expected homepage converted to a website external reference",
        );
        assert.ok(
          nestedAmphora.externalReferences?.some(
            (ref) =>
              ref.type === "vcs" &&
              ref.url === "https://github.com/example/amphora",
          ),
          "expected repository converted to a vcs external reference",
        );
        // Cargo records unversioned packages as 0.0.0 (#4327).
        assert.strictEqual(nestedHelper.version, "0.0.0");
        assert.strictEqual(nestedHelper.purl, "pkg:cargo/helper@0.0.0");
        const flatHelper = bomJson.components.find(
          (component) => component.name === "helper",
        );
        assert.strictEqual(flatHelper?.purl, "pkg:cargo/helper@0.0.0");
        // The full document must survive strict schema validation.
        assert.ok(
          await validateBom(bomJson),
          "cargo workspace BOM must pass CycloneDX schema validation",
        );
      } finally {
        consoleWarnStub.restore();
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  if (process.platform !== "win32") {
    describe("HBOM support", () => {
      it("delegates hbom project types to the hbom helper", async () => {
        const actualHbomHelpers = await import("../inventory/hbom.js");
        const createHbomDocument = sinon.stub().resolves({
          bomFormat: "CycloneDX",
          components: [],
          metadata: {
            component: {
              name: "Demo Board",
              type: "device",
              version: "rev-a",
            },
          },
          specVersion: "1.7",
        });
        const { createBom: createBomMocked } = await esmock("./index.js", {
          "../inventory/hbom.js": {
            ...actualHbomHelpers,
            createHbomDocument,
          },
        });

        const bomNSData = await createBomMocked(repoDir, {
          projectType: ["hbom"],
          specVersion: 1.7,
        });

        sinon.assert.calledOnce(createHbomDocument);
        assert.strictEqual(
          bomNSData?.bomJson?.metadata?.component?.name,
          "Demo Board",
        );
        assert.strictEqual(bomNSData?.parentComponent?.type, "device");
      });

      it("supports dry-run mode for hbom project types in the main CLI flow", async () => {
        setDryRunMode(true);
        resetRecordedActivities();

        try {
          const bomNSData = await createBom(repoDir, {
            projectType: ["hbom"],
            specVersion: 1.7,
          });

          assert.strictEqual(bomNSData?.bomJson?.bomFormat, "CycloneDX");
          assert.strictEqual(bomNSData?.bomJson?.specVersion, "1.7");
          assert.ok(Array.isArray(bomNSData?.bomJson?.components));
          assert.ok(bomNSData?.bomJson?.components.length >= 1);
          assert.ok(Array.isArray(bomNSData?.dependencies));
        } finally {
          setDryRunMode(false);
          resetRecordedActivities();
        }
      });

      it("shows dedicated hbom command help", () => {
        const result = spawnSync(
          process.execPath,
          [join(repoDir, "bin", "hbom.js"), "--help"],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          },
        );
        const output = `${result.stdout}${result.stderr}`;

        assert.strictEqual(result.status, 0);
        assert.match(output, /Output file\.\s+Default\s+hbom\.json/u);
        assert.match(output, /--include-runtime/u);
        assert.match(output, /--privileged/u);
        assert.match(output, /diagnostics/u);
      });

      it("uses the invoked hbom binary name in help output", () => {
        const tempDir = mkdtempSync(join(repoDir, ".cdxgen-hbom-help-name-"));
        try {
          const slimScript = join(tempDir, "hbom-slim");
          copyFileSync(join(repoDir, "bin", "hbom.js"), slimScript);
          const result = spawnSync(process.execPath, [slimScript, "--help"], {
            cwd: tempDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          });
          const output = `${result.stdout}${result.stderr}`;

          assert.strictEqual(result.status, 0);
          assert.match(output, /hbom-slim \[command\] \[options\]/u);
        } finally {
          rmSync(tempDir, { force: true, recursive: true });
        }
      });

      it("fails early when hbom include-runtime lacks osquery support", () => {
        const emptyPluginsDir = mkdtempSync(
          join(tmpdir(), "cdxgen-empty-plugins-"),
        );
        try {
          const result = spawnSync(
            process.execPath,
            [join(repoDir, "bin", "hbom.js"), "--include-runtime"],
            {
              cwd: repoDir,
              encoding: "utf8",
              env: buildMinimalCliEnv({
                CDXGEN_PLUGINS_DIR: emptyPluginsDir,
              }),
            },
          );
          const output = `${result.stdout}${result.stderr}`;

          assert.strictEqual(result.status, 1);
          assert.match(output, /--include-runtime/u);
          assert.match(output, /cdxgen-plugins-bin/u);
          assert.match(
            output,
            /'hbom' is the bundled option required for '--include-runtime' support/u,
          );
          assert.doesNotMatch(output, /About to generate OBOM/u);
        } finally {
          rmSync(emptyPluginsDir, { force: true, recursive: true });
        }
      });

      it("guides hbom-slim users to the standard binary for include-runtime", () => {
        const tempDir = mkdtempSync(
          join(repoDir, ".cdxgen-hbom-runtime-check-"),
        );
        const emptyPluginsDir = mkdtempSync(
          join(tmpdir(), "cdxgen-empty-plugins-"),
        );
        try {
          const slimScript = join(tempDir, "hbom-slim");
          copyFileSync(join(repoDir, "bin", "hbom.js"), slimScript);
          const result = spawnSync(
            process.execPath,
            [slimScript, "--include-runtime"],
            {
              cwd: tempDir,
              encoding: "utf8",
              env: buildMinimalCliEnv({
                CDXGEN_PLUGINS_DIR: emptyPluginsDir,
              }),
            },
          );
          const output = `${result.stdout}${result.stderr}`;

          assert.strictEqual(result.status, 1);
          assert.match(output, /'hbom-slim' is hardware-only by default/u);
          assert.match(
            output,
            /Use 'hbom' for bundled '--include-runtime' support/u,
          );
        } finally {
          rmSync(tempDir, { force: true, recursive: true });
          rmSync(emptyPluginsDir, { force: true, recursive: true });
        }
      });

      it("supports the hbom diagnostics subcommand for existing BOM files", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-hbom-diagnostics-"));
        try {
          const inputFile = join(tempDir, "hbom.json");
          writeFileSync(
            inputFile,
            JSON.stringify({
              bomFormat: "CycloneDX",
              components: [],
              metadata: {
                component: {
                  name: "demo-host",
                  properties: [
                    { name: "cdx:hbom:platform", value: "linux" },
                    { name: "cdx:hbom:architecture", value: "amd64" },
                  ],
                  type: "device",
                },
              },
              properties: [
                { name: "cdx:hbom:collectorProfile", value: "linux-amd64-v1" },
                {
                  name: "cdx:hbom:evidence:commandDiagnosticCount",
                  value: "2",
                },
                {
                  name: "cdx:hbom:evidence:commandDiagnostic",
                  value: JSON.stringify({
                    command: "lsusb",
                    installHint:
                      "Command not found: install the Linux package providing lsusb (commonly `usbutils`).",
                    issue: "missing-command",
                    message: "lsusb failed with missing-command",
                  }),
                },
                {
                  name: "cdx:hbom:evidence:commandDiagnostic",
                  value: JSON.stringify({
                    command: "drm_info",
                    issue: "permission-denied",
                    message: "drm_info failed with permission-denied",
                    privilegeHint:
                      "Retry with --privileged to allow a non-interactive sudo attempt for permission-sensitive Linux commands.",
                  }),
                },
              ],
              specVersion: "1.7",
              version: 1,
            }),
          );
          const result = spawnSync(
            process.execPath,
            [
              join(repoDir, "bin", "hbom.js"),
              "diagnostics",
              "--input",
              inputFile,
            ],
            {
              cwd: tempDir,
              encoding: "utf8",
              env: buildMinimalCliEnv(),
            },
          );
          const output = `${result.stdout}${result.stderr}`;

          assert.strictEqual(result.status, 0);
          assert.match(output, /HBOM diagnostics summary/u);
          assert.match(output, /Missing commands:\n- lsusb/u);
          assert.match(output, /Permission-sensitive enrichments:/u);
          assert.match(output, /--privileged/u);
        } finally {
          rmSync(tempDir, { force: true, recursive: true });
        }
      });

      it("supports dry-run mode in the dedicated hbom command", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-hbom-dry-run-"));
        try {
          const outputFile = join(tempDir, "hbom.json");
          const result = spawnSync(
            process.execPath,
            [join(repoDir, "bin", "hbom.js"), "--dry-run"],
            {
              cwd: tempDir,
              encoding: "utf8",
              env: buildMinimalCliEnv(),
            },
          );
          const output = `${result.stdout}${result.stderr}`;

          assert.strictEqual(result.status, 0);
          assert.match(output, /cdxgen dry-run activity summary/u);
          assert.strictEqual(existsSync(outputFile), false);
        } finally {
          rmSync(tempDir, { force: true, recursive: true });
        }
      });

      it("rejects mixed hbom and sbom project types in the main CLI", () => {
        const result = spawnSync(
          process.execPath,
          [
            join(repoDir, "bin", "cdxgen.js"),
            "-t",
            "hbom",
            "-t",
            "js",
            "--no-banner",
          ],
          {
            cwd: repoDir,
            encoding: "utf8",
            env: buildMinimalCliEnv(),
          },
        );
        const output = `${result.stdout}${result.stderr}`;

        assert.strictEqual(result.status, 1);
        assert.match(output, /HBOM project types cannot be mixed/u);
      });
    });
  }

  describe("createBom() CMake cache and submodule resolution", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable syntax
    it("strips unresolved ${VAR} from purls when no CMakeCache is available", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-cmake-"));
      writeFileSync(
        join(tempDir, "CMakeLists.txt"),
        // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake variable syntax
        'project(boost_algorithm VERSION "${BOOST_SUPERPROJECT_VERSION}" LANGUAGES CXX)\nfind_package(Boost ${BOOST_SUPERPROJECT_VERSION} REQUIRED)\n',
        "utf-8",
      );
      try {
        const bomData = await createBom(tempDir, {
          projectType: ["c"],
          deep: false,
          failOnError: false,
          installDeps: false,
          multiProject: false,
        });
        const bom = bomData?.bomJson;
        assert.ok(bom, "BOM should be generated");
        const json = JSON.stringify(bom);
        assert.ok(
          !json.includes("%24%7B"),
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal CMake variable syntax
          "no percent-encoded ${...} should appear in any purl",
        );
        assert.ok(
          !json.includes("${"),
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal CMake variable syntax
          "no literal ${...} should appear in any purl or version",
        );
        const pc = bom.metadata?.component;
        assert.ok(pc.version === "" || !pc.version?.includes("$"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("keeps the root project the parent and one component per fetched dependency", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-cmake-"));
      mkdirSync(join(tempDir, "src"));
      mkdirSync(join(tempDir, "tools"));
      // a sub-project reusing the root name, read before the root file
      writeFileSync(
        join(tempDir, "src", "CMakeLists.txt"),
        "PROJECT(demo)\nfind_package(googletest REQUIRED)\n",
        "utf-8",
      );
      writeFileSync(
        join(tempDir, "tools", "CMakeLists.txt"),
        "project(demo_tools)\n",
        "utf-8",
      );
      writeFileSync(
        join(tempDir, "CMakeLists.txt"),
        [
          "cmake_minimum_required(VERSION 3.24)",
          "PROJECT(demo VERSION 1.0.0)",
          "include(FetchContent)",
          "FetchContent_Declare(googletest",
          "  GIT_REPOSITORY https://github.com/google/googletest.git",
          "  GIT_TAG v1.14.0)",
          "FetchContent_MakeAvailable(googletest)",
          "add_subdirectory(src)",
          "add_subdirectory(tools)",
          "",
        ].join("\n"),
        "utf-8",
      );
      try {
        // the scan root as given on the command line, absolute or relative
        for (const scanPath of [tempDir, relative(process.cwd(), tempDir)]) {
          const bomData = await createBom(scanPath, {
            projectType: ["c"],
            deep: false,
            failOnError: false,
            installDeps: false,
            multiProject: true,
          });
          const bom = bomData?.bomJson;
          assert.strictEqual(bom.metadata.component.name, "demo");
          assert.strictEqual(bom.metadata.component.version, "1.0.0");
          const names = bom.components.map((c) => c.name).sort();
          assert.deepStrictEqual(names, ["demo_tools", "googletest"]);
          const gtest = bom.components.find((c) => c.name === "googletest");
          assert.strictEqual(
            gtest.purl,
            "pkg:github/google/googletest@v1.14.0",
          );
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("records the build's presets, compilers and hardening, and keeps its own headers out", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-cmake-"));
      const buildDir = join(tempDir, "build", "release");
      mkdirSync(join(buildDir, "CMakeFiles", "3.30.2"), { recursive: true });
      mkdirSync(join(tempDir, "include", "demo"), { recursive: true });
      mkdirSync(join(tempDir, "src"));
      writeFileSync(
        join(tempDir, "CMakeLists.txt"),
        "project(demo VERSION 2.0.0 LANGUAGES C)\nadd_executable(demo src/main.c)\n",
      );
      writeFileSync(
        join(tempDir, "CMakePresets.json"),
        JSON.stringify({
          version: 3,
          configurePresets: [
            {
              name: "release",
              generator: "Ninja",
              // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake preset macro
              binaryDir: "${sourceDir}/build/release",
              cacheVariables: { CMAKE_BUILD_TYPE: "Release" },
            },
          ],
        }),
      );
      writeFileSync(
        join(buildDir, "CMakeCache.txt"),
        "CMAKE_BUILD_TYPE:STRING=Release\nCMAKE_EXE_LINKER_FLAGS:STRING=-Wl,-z,relro\n",
      );
      writeFileSync(
        join(buildDir, "CMakeFiles", "3.30.2", "CMakeCCompiler.cmake"),
        'set(CMAKE_C_COMPILER "/opt/no-such-toolchain/bin/gcc")\nset(CMAKE_C_COMPILER_ID "GNU")\nset(CMAKE_C_COMPILER_VERSION "14.1.0")\n',
      );
      writeFileSync(
        join(buildDir, "compile_commands.json"),
        JSON.stringify([
          {
            directory: buildDir,
            file: join(tempDir, "src", "main.c"),
            arguments: [
              "/opt/no-such-toolchain/bin/gcc",
              `-I${join(tempDir, "include")}`,
              "-D_FORTIFY_SOURCE=2",
              "-c",
              join(tempDir, "src", "main.c"),
            ],
          },
        ]),
      );
      writeFileSync(
        join(tempDir, "include", "demo", "api.h"),
        "int api(void);\n",
      );
      writeFileSync(
        join(tempDir, "src", "main.c"),
        '#include "demo/api.h"\nint main(void) { return api(); }\n',
      );
      try {
        const bomData = await createBom(tempDir, {
          projectType: ["c"],
          deep: false,
          failOnError: false,
          installDeps: false,
          multiProject: false,
        });
        const formulation = bomData.formulationList || [];
        const preset = formulation.find(
          (c) => c["bom-ref"] === "cmake-preset:release",
        );
        assert.strictEqual(preset?.type, "data");
        const compiler = formulation.find(
          (c) => c["bom-ref"] === "cpp-compiler:gcc@14.1.0",
        );
        assert.strictEqual(compiler?.type, "platform");
        const props = Object.fromEntries(
          bomData.bomJson.metadata.component.properties.map((p) => [
            p.name,
            p.value,
          ]),
        );
        assert.strictEqual(props["cdx:cmake:buildType"], "Release");
        assert.strictEqual(props["cdx:cpp:hardening:fortifySource"], "2");
        assert.strictEqual(props["cdx:cpp:hardening:relro"], "partial");
        assert.ok(
          !(bomData.bomJson.components || []).some((c) => c.name === "api"),
          "the project's own header is not a component",
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
