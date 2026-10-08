import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

// The predictive audit resolves a target's repository only when the target
// will actually be cloned: a target whose workspace holds a cached child BOM
// is answered from it. The clone directories of a workspace are keyed by the
// repository and the ref, so the packages of one monorepo share a checkout
// while a different ref, a different snapshot of the tree, never does.

const MONO_REPO = "https://github.com/acme/mono.git";

const target = (name, version) => ({
  properties: [],
  type: "npm",
  name,
  namespace: "",
  version,
});

/** Mirror of the workspace directory name the audit builds for a target. */
function auditTargetSlug(aTarget) {
  const normalized = aTarget.name
    .toLowerCase()
    .replace(/[-_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const version = (aTarget.version || "latest")
    .toLowerCase()
    .replace(/[-_.]+/g, "-");
  const digest = createHash("sha256")
    .update(aTarget.purl)
    .digest("hex")
    .slice(0, 12);
  return `npm-${normalized}-${version}-${digest}`;
}

function writeJson(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

const inputBomFor = (names) => ({
  bomJson: {
    bomFormat: "CycloneDX",
    components: names.map((name) => ({
      "bom-ref": `pkg:npm/${name.name}@${name.version}`,
      name: name.name,
      purl: `pkg:npm/${name.name}@${name.version}`,
      type: "library",
      version: name.version,
    })),
    specVersion: "1.7",
    version: 1,
  },
  source: "input.json",
});

/**
 * Load the audit engine with the repository layer stubbed: prefetch and
 * resolution record their purls, and a clone through hardenedGitCommand
 * creates the checkout directory it was asked for.
 */
async function loadAuditModule() {
  const prefetchedPurls = [];
  const cloneCalls = [];
  const auditBomStub = sinon.stub().resolves([]);
  const createBomStub = sinon.stub().resolves({
    bomJson: {
      bomFormat: "CycloneDX",
      components: [],
      specVersion: "1.7",
      version: 1,
    },
  });
  const mod = await esmock("./index.js", {
    "../cli/index.js": { createBom: createBomStub },
    "../core/logger.js": { thoughtLog: sinon.stub() },
    "../core/paths.js": { dirNameStr: path.resolve(".") },
    "../inventory/source.js": {
      cleanupSourceDir: sinon.stub(),
      findGitRefForPurlVersion: (_repoUrl, resolution) =>
        `v${resolution.version}`,
      hardenedGitCommand: (args) => {
        const cloneIndex = args.indexOf("clone");
        if (cloneIndex === -1) {
          return { status: 0 };
        }
        const repoUrl = args[args.indexOf("--") + 1];
        const cloneDir = args[args.length - 1];
        cloneCalls.push({ cloneDir, repoUrl });
        mkdirSync(path.join(cloneDir, ".git"), { recursive: true });
        return { status: 0 };
      },
      prefetchGitUrlSources: async (purlStrings) => {
        prefetchedPurls.push(...purlStrings);
      },
      resolveGitUrlFromPurl: async (purl) => {
        const segments = String(purl).split("/");
        const version = segments[segments.length - 1].split("@").pop();
        return {
          name: segments[2] ? segments[2].split("@")[0] : String(purl),
          repoUrl: MONO_REPO,
          type: "npm",
          version,
        };
      },
      resolvePurlSourceDirectory: (cloneDir) => cloneDir,
      sanitizeRemoteUrlForLogs: (value) => value,
    },
    "../stages/postgen/auditBom.js": { auditBom: auditBomStub },
    "../stages/postgen/postgen.js": {
      postProcess: sinon.stub().callsFake((bomNSData) => bomNSData),
    },
  });
  return { auditBomStub, cloneCalls, createBomStub, mod, prefetchedPurls };
}

describe("predictive audit workspace", () => {
  it("resolves only the targets it will clone, and shares one checkout per repository and ref", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "cdx-audit-share-"));
    try {
      // A cached child BOM for the first target answers it without any
      // repository lookup.
      const cachedTarget = {
        ...target("one", "1.0.0"),
        purl: "pkg:npm/one@1.0.0",
      };
      const cacheDir = path.join(
        workspaceDir,
        auditTargetSlug(cachedTarget),
        ".cdx-audit",
      );
      writeJson(path.join(cacheDir, "source-bom.json"), {
        bomFormat: "CycloneDX",
        components: [],
        specVersion: "1.7",
        version: 1,
      });
      writeJson(path.join(cacheDir, "source-bom.meta.json"), {
        repoUrl: MONO_REPO,
        resolution: { repoUrl: MONO_REPO, type: "npm" },
        scanDirRelative: ".",
        sourceDirectoryConfidence: "high",
        versionMatched: true,
      });

      const { auditBomStub, cloneCalls, createBomStub, mod, prefetchedPurls } =
        await loadAuditModule();
      const report = await mod.runAuditFromBoms(
        [
          inputBomFor([
            { name: "one", version: "1.0.0" },
            { name: "two", version: "1.0.0" },
            { name: "three", version: "2.0.0" },
          ]),
        ],
        {
          maxTargets: 10,
          minSeverity: "low",
          // Registry enrichment of the input BOM is not under test.
          trusted: "include",
          workspaceDir,
        },
      );
      // The cached target took no part in the repository prefetch round; the
      // two targets that will be cloned did.
      assert.deepStrictEqual(prefetchedPurls.slice().sort(), [
        "pkg:npm/three@2.0.0",
        "pkg:npm/two@1.0.0",
      ]);
      // All three were audited, the cached one from its workspace cache.
      assert.strictEqual(report.results.length, 3);
      assert.strictEqual(report.results.filter((r) => r.cacheHit).length, 1);
      assert.strictEqual(auditBomStub.callCount, 3);
      assert.strictEqual(createBomStub.callCount, 2);
      // one and two share the checkout of the repository at v1.0.0; three,
      // at v2.0.0, has its own. Two clones for three targets.
      assert.strictEqual(cloneCalls.length, 2);
      assert.strictEqual(
        new Set(cloneCalls.map((call) => call.cloneDir)).size,
        2,
      );
      for (const call of cloneCalls) {
        assert.strictEqual(call.repoUrl, MONO_REPO);
        assert.ok(existsSync(path.join(call.cloneDir, ".git")));
      }
      // The shared checkout keeps its git directory, so a later run of the
      // same monorepo reuses it without cloning again.
      const secondRun = await mod.runAuditFromBoms(
        [inputBomFor([{ name: "four", version: "1.0.0" }])],
        {
          maxTargets: 10,
          minSeverity: "low",
          trusted: "include",
          workspaceDir,
        },
      );
      assert.strictEqual(secondRun.results.length, 1);
      assert.strictEqual(
        cloneCalls.length,
        2,
        `expected the existing checkout to be reused, got ${cloneCalls
          .map((call) => call.cloneDir)
          .join(", ")}`,
      );
    } finally {
      rmSync(workspaceDir, { force: true, recursive: true });
    }
  });
});
