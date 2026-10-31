import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { assert, describe, it } from "poku";

import {
  collectIdeInventory,
  collectObomIdeInventory,
  discoverIdeExtensionDirs,
  findIdeProductInfo,
  getIdeExtensionDirs,
  IDE_PRODUCTS,
  identifyIdeFromExtensionsDir,
  isInstalledExtensionDir,
  isInstalledExtensionsDir,
  isReadableVsix,
  mergeExtensionComponents,
  parseInstalledExtensionDir,
  parseVsixFile,
  readIdeProductInfo,
  readInstalledExtensionsRegistry,
} from "./vsixutils.js";

const FIXTURES = resolve("test", "data", "ide-extensions");
const MAC_HOME = join(FIXTURES, "cursor-macos-home");
const REMOTE_HOME = join(FIXTURES, "remote-linux-home");
const CURSOR_EXTENSIONS = join(MAC_HOME, ".cursor", "extensions");
const VSCODE_EXTENSIONS = join(MAC_HOME, ".vscode", "extensions");

const sha256 = (filePath) =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");
const prop = (component, name) =>
  component?.properties?.find((p) => p.name === name)?.value;
const byPurl = (components, purl) =>
  components.find((component) => component.purl === purl);

describe("getIdeExtensionDirs()", () => {
  it("puts every editor's extensions under <home>/<dataFolderName>/extensions", () => {
    const home = join(tmpdir(), "cdxgen-ide-home");
    const entries = getIdeExtensionDirs(home);
    const cursor = entries.find((entry) => entry.id === "cursor");
    assert.deepStrictEqual(cursor.dirs, [join(home, ".cursor", "extensions")]);
    const cursorServer = entries.find((entry) => entry.id === "cursor-server");
    assert.strictEqual(cursorServer.kind, "server");
    assert.deepStrictEqual(cursorServer.dirs, [
      join(home, ".cursor-server", "extensions"),
    ]);
    for (const entry of entries) {
      for (const dir of entry.dirs) {
        // On Windows the temporary home itself sits under AppData\Local\Temp.
        const underHome = dir.startsWith(home) ? dir.slice(home.length) : dir;
        assert.ok(
          !underHome.includes("Application Support") &&
            !underHome.includes("AppData"),
          `${entry.name} must not look for extensions in its settings folder: ${dir}`,
        );
      }
    }
  });

  it("covers the AI editors and the remote servers", () => {
    const ids = getIdeExtensionDirs(tmpdir()).map((entry) => entry.id);
    for (const id of [
      "vscode",
      "vscode-server",
      "vscode-insiders",
      "vscodium",
      "cursor",
      "cursor-server",
      "windsurf",
      "windsurf-server",
      "devin-desktop",
      "kiro",
      "trae",
      "antigravity",
      "qoder",
      "positron",
      "void",
      "code-server",
      "openvscode-server",
    ]) {
      assert.ok(ids.includes(id), `expected ${id}`);
    }
    const dataFolders = IDE_PRODUCTS.map((product) => product.dataFolderName);
    assert.strictEqual(
      new Set(dataFolders).size,
      dataFolders.length,
      "each editor has its own data folder",
    );
  });
});

describe("discoverIdeExtensionDirs()", () => {
  it("finds the Cursor and VS Code folders of a macOS home", () => {
    const found = discoverIdeExtensionDirs(MAC_HOME);
    assert.deepStrictEqual(
      found.map((entry) => [entry.id, entry.dir]),
      [
        ["vscode", VSCODE_EXTENSIONS],
        ["cursor", CURSOR_EXTENSIONS],
      ],
    );
  });

  it("finds the remote server folders of a Linux host", () => {
    const found = discoverIdeExtensionDirs(REMOTE_HOME);
    assert.deepStrictEqual(
      found.map((entry) => entry.id),
      ["vscode-server", "cursor-server"],
    );
  });
});

describe("identifyIdeFromExtensionsDir()", () => {
  it("names the editor from the folder", () => {
    assert.strictEqual(
      identifyIdeFromExtensionsDir(CURSOR_EXTENSIONS)?.id,
      "cursor",
    );
    assert.strictEqual(
      identifyIdeFromExtensionsDir(
        join(REMOTE_HOME, ".cursor-server", "extensions"),
      )?.name,
      "Cursor Server",
    );
    assert.strictEqual(
      identifyIdeFromExtensionsDir(
        join(tmpdir(), ".local", "share", "code-server", "extensions"),
      )?.id,
      "code-server",
    );
    assert.strictEqual(
      identifyIdeFromExtensionsDir(join(tmpdir(), "extensions")),
      undefined,
    );
    assert.strictEqual(identifyIdeFromExtensionsDir(MAC_HOME), undefined);
  });
});

describe("installed extension folders", () => {
  it("recognises an extensions folder and an extension folder", () => {
    assert.ok(isInstalledExtensionsDir(CURSOR_EXTENSIONS));
    assert.ok(!isInstalledExtensionsDir(MAC_HOME));
    assert.ok(
      isInstalledExtensionDir(
        join(CURSOR_EXTENSIONS, "anthropic.claude-code-2.1.313-darwin-arm64"),
      ),
    );
    assert.ok(!isInstalledExtensionDir(CURSOR_EXTENSIONS));
  });

  it("reads the registry and the obsolete list", () => {
    const { records, obsolete } =
      readInstalledExtensionsRegistry(CURSOR_EXTENSIONS);
    assert.deepStrictEqual([...records.keys()].sort(), [
      "anthropic.claude-code-2.1.313-darwin-arm64",
      "redhat.vscode-yaml-1.19.0",
    ]);
    assert.deepStrictEqual([...obsolete], ["redhat.vscode-yaml-1.18.0"]);
  });

  it("takes the target platform from the .vsixmanifest beside package.json", () => {
    const component = parseInstalledExtensionDir(
      join(CURSOR_EXTENSIONS, "anthropic.claude-code-2.1.313-darwin-arm64"),
      "Cursor",
    );
    assert.strictEqual(
      component.purl,
      "pkg:vscode-extension/anthropic/claude-code@2.1.313?platform=darwin-arm64",
    );
    assert.strictEqual(
      prop(component, "cdx:vscode-extension:executesCode"),
      "true",
    );
    assert.strictEqual(
      prop(component, "cdx:vscode-extension:extensionKind"),
      "workspace",
    );
  });

  it("falls back to the platform in the folder name", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-ide-ext-"));
    try {
      const extDir = join(root, "anthropic.claude-code-2.1.313-win32-x64");
      mkdirSync(extDir);
      writeFileSync(
        join(extDir, "package.json"),
        JSON.stringify({
          name: "claude-code",
          publisher: "Anthropic",
          version: "2.1.313",
          engines: { vscode: "^1.94.0" },
        }),
      );
      assert.strictEqual(
        parseInstalledExtensionDir(extDir)?.purl,
        "pkg:vscode-extension/anthropic/claude-code@2.1.313?platform=win32-x64",
      );
      rmSync(join(extDir, "package.json"));
      assert.strictEqual(
        parseInstalledExtensionDir(extDir)?.version,
        "2.1.313",
        "the folder name alone keeps the version without the platform",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("collectIdeInventory()", () => {
  const ideDirs = discoverIdeExtensionDirs(MAC_HOME);
  const { components, dependencies } = collectIdeInventory(ideDirs, {
    home: MAC_HOME,
  });

  it("emits a component for each editor and links it to its extensions", () => {
    const cursor = byPurl(components, "pkg:generic/cdxgen-ide/cursor");
    assert.ok(cursor, "Cursor component");
    assert.strictEqual(cursor.type, "application");
    assert.strictEqual(prop(cursor, "cdx:ide:extensionCount"), "4");
    // The path is relative to the scanned home, so the BOM carries no user
    // name.
    assert.strictEqual(
      prop(cursor, "cdx:ide:extensionsDir"),
      "~/.cursor/extensions",
    );
    const cursorDeps = dependencies.find(
      (d) => d.ref === "pkg:generic/cdxgen-ide/cursor",
    );
    assert.deepStrictEqual(cursorDeps.dependsOn, [
      "pkg:vscode-extension/acme/sideloaded@0.1.0",
      "pkg:vscode-extension/anthropic/claude-code@2.1.313?platform=darwin-arm64",
      "pkg:vscode-extension/redhat/vscode-yaml@1.18.0",
      "pkg:vscode-extension/redhat/vscode-yaml@1.19.0",
    ]);
    const vscodeDeps = dependencies.find(
      (d) => d.ref === "pkg:generic/cdxgen-ide/vscode",
    );
    assert.deepStrictEqual(vscodeDeps.dependsOn, [
      "pkg:vscode-extension/anthropic/claude-code@2.1.312?platform=darwin-arm64",
      "pkg:vscode-extension/redhat/vscode-yaml@1.19.0",
    ]);
  });

  it("records the install source and time an incident window is checked against", () => {
    const claude = byPurl(
      components,
      "pkg:vscode-extension/anthropic/claude-code@2.1.313?platform=darwin-arm64",
    );
    assert.strictEqual(prop(claude, "cdx:vscode-extension:ide"), "Cursor");
    assert.strictEqual(
      prop(claude, "cdx:vscode-extension:installSource"),
      "gallery",
    );
    assert.strictEqual(
      prop(claude, "cdx:vscode-extension:installedAt"),
      "2026-10-29T09:40:00.000Z",
    );
    assert.strictEqual(prop(claude, "cdx:vscode-extension:updated"), "true");
    assert.deepStrictEqual(claude.evidence.occurrences, [
      {
        location: join(
          CURSOR_EXTENSIONS,
          "anthropic.claude-code-2.1.313-darwin-arm64",
        ),
      },
    ]);
  });

  it("hashes the entry files the extension host runs", () => {
    const claudeDir = join(
      CURSOR_EXTENSIONS,
      "anthropic.claude-code-2.1.313-darwin-arm64",
    );
    const claude = byPurl(
      components,
      "pkg:vscode-extension/anthropic/claude-code@2.1.313?platform=darwin-arm64",
    );
    assert.deepStrictEqual(
      claude.components.map((file) => [
        file.type,
        file.name,
        file.hashes[0].alg,
        file.hashes[0].content,
        prop(file, "cdx:vscode-extension:entryPoint"),
      ]),
      [
        [
          "file",
          "extension.js",
          "SHA-256",
          sha256(join(claudeDir, "extension.js")),
          "main",
        ],
      ],
    );
    const yaml = byPurl(
      components,
      "pkg:vscode-extension/redhat/vscode-yaml@1.19.0",
    );
    assert.deepStrictEqual(
      yaml.components.map((file) => [
        file.name,
        prop(file, "cdx:vscode-extension:entryPoint"),
      ]),
      [
        ["dist/extension.js", "main"],
        ["dist/extension-web.js", "browser"],
      ],
    );
  });

  it("merges one extension installed in two editors", () => {
    const yaml = components.filter(
      (c) => c.purl === "pkg:vscode-extension/redhat/vscode-yaml@1.19.0",
    );
    assert.strictEqual(yaml.length, 1);
    assert.strictEqual(
      prop(yaml[0], "cdx:vscode-extension:ide"),
      "VS Code, Cursor",
    );
    assert.deepStrictEqual(
      yaml[0].evidence.occurrences.map((o) => o.location),
      [
        join(VSCODE_EXTENSIONS, "redhat.vscode-yaml-1.19.0"),
        join(CURSOR_EXTENSIONS, "redhat.vscode-yaml-1.19.0"),
      ],
    );
  });

  it("flags folders pending removal and folders the editor never registered", () => {
    const oldYaml = byPurl(
      components,
      "pkg:vscode-extension/redhat/vscode-yaml@1.18.0",
    );
    assert.strictEqual(
      prop(oldYaml, "cdx:vscode-extension:pendingRemoval"),
      "true",
    );
    assert.strictEqual(
      prop(oldYaml, "cdx:vscode-extension:registered"),
      undefined,
    );
    const sideloaded = byPurl(
      components,
      "pkg:vscode-extension/acme/sideloaded@0.1.0",
    );
    assert.strictEqual(
      prop(sideloaded, "cdx:vscode-extension:registered"),
      "false",
    );
    assert.strictEqual(
      prop(sideloaded, "cdx:vscode-extension:activationEvents"),
      "*",
    );
  });

  it("never copies the MCP token from the editor's config", () => {
    assert.ok(!JSON.stringify(components).includes("fixture-not-a-token"));
  });
});

describe("editor versions", () => {
  it("reads a fork's own version ahead of the VS Code release it is based on", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-ide-app-"));
    try {
      writeFileSync(
        join(root, "product.json"),
        JSON.stringify({
          nameLong: "Kiro",
          dataFolderName: ".kiro",
          version: "1.2.37",
          commit: "0123456789abcdef",
          quality: "stable",
        }),
      );
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ version: "1.103.0" }),
      );
      const info = readIdeProductInfo(root);
      assert.strictEqual(info.version, "1.2.37");
      assert.strictEqual(info.vscodeVersion, "1.103.0");
      assert.strictEqual(info.commit, "0123456789abcdef");
      assert.strictEqual(readIdeProductInfo(join(root, "missing")), undefined);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reads the newest remote server a host keeps", () => {
    const home = mkdtempSync(join(tmpdir(), "cdxgen-ide-server-"));
    try {
      for (const [commit, version] of [
        ["aaaa", "1.104.0"],
        ["bbbb", "1.105.1"],
      ]) {
        const serverDir = join(
          home,
          ".vscode-server",
          "cli",
          "servers",
          `Stable-${commit}`,
          "server",
        );
        mkdirSync(serverDir, { recursive: true });
        writeFileSync(
          join(serverDir, "product.json"),
          JSON.stringify({
            commit,
            quality: "stable",
            serverDataFolderName: ".vscode-server",
          }),
        );
        writeFileSync(
          join(serverDir, "package.json"),
          JSON.stringify({ version }),
        );
      }
      const info = findIdeProductInfo(
        { id: "vscode-server", kind: "server" },
        home,
      );
      assert.strictEqual(info.version, "1.105.1");
      assert.strictEqual(info.commit, "bbbb");
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

describe("collectObomIdeInventory()", () => {
  it("adds what osquery missed and enriches the rows it reported", () => {
    const osqueryRow = {
      name: "vscode-yaml",
      group: "redhat",
      version: "1.19.0",
      purl: "pkg:vscode-extension/redhat/vscode-yaml@1.19.0",
      "bom-ref": "pkg:vscode-extension/redhat/vscode-yaml@1.19.0",
      type: "application",
      properties: [{ name: "vscode_edition", value: "vscode" }],
      evidence: {
        occurrences: [
          { location: join(VSCODE_EXTENSIONS, "redhat.vscode-yaml-1.19.0") },
        ],
      },
    };
    const pkgList = [osqueryRow];
    const additions = collectObomIdeInventory(pkgList, { home: MAC_HOME });
    assert.ok(
      !additions.some((c) => c["bom-ref"] === osqueryRow["bom-ref"]),
      "an extension osquery reported is not added twice",
    );
    assert.strictEqual(
      prop(osqueryRow, "cdx:vscode-extension:ide"),
      "VS Code, Cursor",
    );
    assert.strictEqual(osqueryRow.evidence.occurrences.length, 2);
    assert.strictEqual(osqueryRow.components.length, 2);
    assert.ok(
      byPurl(
        additions,
        "pkg:vscode-extension/anthropic/claude-code@2.1.313?platform=darwin-arm64",
      ),
    );
    assert.ok(byPurl(additions, "pkg:generic/cdxgen-ide/cursor"));
  });

  it("returns nothing for a home without editors", () => {
    const home = mkdtempSync(join(tmpdir(), "cdxgen-ide-empty-"));
    try {
      assert.deepStrictEqual(collectObomIdeInventory([], { home }), []);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

describe("parseVsixFile() hashes", () => {
  it("records the SHA-256 of the .vsix that a security notice publishes", async () => {
    const vsix = join(
      FIXTURES,
      "vsix",
      "Anthropic.claude-code-2.1.313@darwin-arm64.vsix",
    );
    const component = await parseVsixFile(vsix);
    assert.strictEqual(
      component.purl,
      "pkg:vscode-extension/anthropic/claude-code@2.1.313?platform=darwin-arm64",
    );
    assert.deepStrictEqual(component.hashes, [
      { alg: "SHA-256", content: sha256(vsix) },
    ]);
  });
});

describe("collectIdeInventory() on a copied folder", () => {
  it("still names the editor when the folder is scanned outside a home", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-ide-copy-"));
    try {
      const copy = join(root, ".cursor", "extensions");
      cpSync(CURSOR_EXTENSIONS, copy, { recursive: true });
      const ide = identifyIdeFromExtensionsDir(copy);
      const { components } = collectIdeInventory([{ ...ide, dir: copy }], {
        home: root,
      });
      assert.ok(byPurl(components, "pkg:generic/cdxgen-ide/cursor"));
      assert.strictEqual(
        components.filter((c) => c.purl?.startsWith("pkg:vscode-extension/"))
          .length,
        4,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

const LAB_HOME = join(FIXTURES, "linux-ide-lab-home");
const PRODUCTS = join(FIXTURES, "products");

describe("real editor releases", () => {
  it("reads each product's own version from its product.json and package.json", () => {
    const expected = {
      cursor: ["3.27.22", "1.128.0"],
      vscode: ["1.144.0", "1.144.0"],
      "vscode-server": ["1.144.0", "1.144.0"],
      vscodium: ["1.143.17232", "1.143.17232"],
      "code-server": ["4.144.0", "1.144.0"],
      "openvscode-server": ["1.109.5", "1.109.5"],
      "windsurf-devin": ["3.11.234", "1.126.0"],
      kiro: ["1.4.62", "1.4.62"],
      positron: ["2026.10.2", "1.134.0"],
      trae: ["3.6.4", "1.107.1"],
    };
    for (const [name, [version, vscodeVersion]] of Object.entries(expected)) {
      const info = readIdeProductInfo(join(PRODUCTS, name));
      assert.strictEqual(info?.version, version, `${name} version`);
      assert.strictEqual(
        info?.vscodeVersion,
        vscodeVersion,
        `${name} VS Code base version`,
      );
    }
  });

  it("matches each product's data folder to an entry in IDE_PRODUCTS", () => {
    for (const name of [
      "cursor",
      "vscode",
      "vscodium",
      "windsurf-devin",
      "kiro",
      "positron",
      "trae",
    ]) {
      const info = readIdeProductInfo(join(PRODUCTS, name));
      const product = IDE_PRODUCTS.find(
        (p) => p.dataFolderName === info.dataFolderName,
      );
      assert.ok(product, `${name} uses ${info.dataFolderName}`);
      assert.strictEqual(
        product.serverDataFolderName,
        info.serverDataFolderName,
        `${name} server folder`,
      );
    }
  });

  it("reads the version of each remote server installed on a host", () => {
    const { components } = collectIdeInventory(
      discoverIdeExtensionDirs(REMOTE_HOME),
      { home: REMOTE_HOME },
    );
    const cursorServer = byPurl(
      components,
      "pkg:generic/cdxgen-ide/cursor-server@3.27.22",
    );
    assert.ok(cursorServer, "Cursor Server with its release");
    assert.strictEqual(
      prop(cursorServer, "cdx:ide:commit"),
      "b1aa50cb6db84fd3e8c808259cb172ea73425c10",
    );
    assert.strictEqual(prop(cursorServer, "cdx:ide:vscodeVersion"), "1.128.0");
    assert.strictEqual(prop(cursorServer, "cdx:ide:kind"), "server");
    assert.ok(
      byPurl(components, "pkg:generic/cdxgen-ide/vscode-server@1.144.0"),
    );
    assert.ok(
      byPurl(
        components,
        "pkg:vscode-extension/anthropic/claude-code@2.1.313?platform=linux-x64",
      ),
    );
  });
});

describe("extensions installed by ten real editors on one Linux host", () => {
  const ideDirs = discoverIdeExtensionDirs(LAB_HOME);
  const { components, dependencies } = collectIdeInventory(ideDirs, {
    home: LAB_HOME,
  });

  it("finds every editor's folder", () => {
    assert.deepStrictEqual(
      ideDirs.map((entry) => entry.id),
      [
        "vscode",
        "vscode-server",
        "vscodium",
        "cursor",
        "devin-desktop",
        "positron",
        "kiro",
        "trae",
        "code-server",
        "openvscode-server",
      ],
    );
  });

  it("names one build the same whether a folder says -universal or nothing", () => {
    const yaml = components.filter(
      (c) => c.purl === "pkg:vscode-extension/redhat/vscode-yaml@2.0.0",
    );
    assert.strictEqual(yaml.length, 1);
    assert.strictEqual(yaml[0].evidence.occurrences.length, 10);
  });

  it("keeps the marketplace each editor took claude-code from apart by version", () => {
    const claude = components
      .filter((c) => c.name === "claude-code")
      .map((c) => [c.purl, prop(c, "cdx:vscode-extension:ide")]);
    assert.deepStrictEqual(claude, [
      [
        "pkg:vscode-extension/anthropic/claude-code@2.1.314?platform=linux-x64",
        "VS Code, VS Code Server, VSCodium, Cursor, Positron, Kiro, code-server, OpenVSCode Server",
      ],
      ["pkg:vscode-extension/anthropic/claude-code@2.1.89", "Devin Desktop"],
      ["pkg:vscode-extension/anthropic/claude-code@1.0.127", "Trae"],
    ]);
  });

  it("marks the build an update replaced as pending removal", () => {
    const old = byPurl(
      components,
      "pkg:vscode-extension/redhat/vscode-yaml@1.15.0",
    );
    assert.strictEqual(
      prop(old, "cdx:vscode-extension:pendingRemoval"),
      "true",
    );
    assert.strictEqual(old.evidence.occurrences.length, 2);
    const current = byPurl(
      components,
      "pkg:vscode-extension/redhat/vscode-yaml@2.0.0",
    );
    assert.strictEqual(prop(current, "cdx:vscode-extension:pinned"), "true");
  });

  it("links every editor to its own extensions", () => {
    const cursorDeps = dependencies.find(
      (d) => d.ref === "pkg:generic/cdxgen-ide/cursor",
    );
    assert.deepStrictEqual(cursorDeps.dependsOn, [
      "pkg:vscode-extension/anthropic/claude-code@2.1.314?platform=linux-x64",
      "pkg:vscode-extension/anysphere/cursorpyright@1.0.12",
      "pkg:vscode-extension/ms-python/debugpy@2026.6.0?platform=linux-x64",
      "pkg:vscode-extension/ms-python/python@2025.6.1?platform=linux-x64",
      "pkg:vscode-extension/redhat/vscode-yaml@1.15.0",
      "pkg:vscode-extension/redhat/vscode-yaml@2.0.0",
    ]);
    assert.strictEqual(
      dependencies.filter((d) => d.ref.startsWith("pkg:generic/cdxgen-ide/"))
        .length,
      10,
    );
  });

  it("gives an extension the purl an OBOM gives the same install", async () => {
    const { convertOSQueryResults } = await import(
      "../inventory/evidenceUtils.js"
    );
    const rows = [];
    for (const { dir } of ideDirs) {
      const registry = JSON.parse(
        readFileSync(join(dir, "extensions.json"), "utf-8"),
      );
      for (const record of registry) {
        rows.push({
          name: record.identifier.id,
          uuid: record.identifier.uuid || record.metadata.id,
          version: record.version,
          path: join(dir, record.relativeLocation),
          publisher: record.metadata.publisherDisplayName,
          installed_at: String(record.metadata.installedTimestamp),
          uid: "1000",
        });
      }
    }
    const obom = convertOSQueryResults(
      "vscode_extensions",
      { purlType: "vscode-extension", componentType: "application" },
      rows,
      false,
    );
    const obomRefs = new Set(obom.map((c) => c["bom-ref"]));
    const scanRefs = new Set(
      components
        .filter(
          (c) =>
            c.purl?.startsWith("pkg:vscode-extension/") &&
            !prop(c, "cdx:vscode-extension:pendingRemoval"),
        )
        .map((c) => c["bom-ref"]),
    );
    assert.strictEqual(scanRefs.size, 13);
    assert.deepStrictEqual([...obomRefs].sort(), [...scanRefs].sort());
  });
});

const writeJson = (filePath, data) => {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data));
};

const extensionPackage = (name, extra = {}) => ({
  name,
  publisher: "acme",
  version: "1.0.0",
  main: "./ext.js",
  engines: { vscode: "^1.90.0" },
  ...extra,
});

const installRecord = (folder, metadata = {}) => ({
  identifier: { id: `acme.${folder.split("-")[0].split(".")[1]}` },
  version: "1.0.0",
  relativeLocation: folder,
  metadata: {
    source: "gallery",
    installedTimestamp: 1793266800000,
    ...metadata,
  },
});

describe("folders that are not an editor's extensions folder", () => {
  it("does not read a source repository that contains an extension as one", () => {
    const repo = mkdtempSync(join(tmpdir(), "cdxgen-ide-repo-"));
    try {
      writeJson(
        join(repo, "client", "package.json"),
        extensionPackage("client"),
      );
      writeJson(join(repo, "server", "package.json"), {
        name: "my-language-server",
        version: "1.0.0",
      });
      writeJson(join(repo, "docs", "package.json"), {
        name: "docs-site",
        version: "1.0.0",
      });
      assert.strictEqual(isInstalledExtensionsDir(repo), false);
      assert.strictEqual(isInstalledExtensionsDir(join(repo, "client")), false);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("skips folders that are neither extensions nor named like one", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-ide-mixed-"));
    try {
      writeFileSync(join(dir, "extensions.json"), "[]");
      writeJson(join(dir, "notes", "package.json"), { name: "notes" });
      writeJson(
        join(dir, "acme.real-1.0.0", "package.json"),
        extensionPackage("real"),
      );
      const { components } = collectIdeInventory([{ dir }], {
        includeIdeComponents: false,
      });
      assert.deepStrictEqual(
        components.map((c) => c.purl),
        ["pkg:vscode-extension/acme/real@1.0.0"],
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("editor versions come from the scanned folder, not this machine", () => {
  it("never reports this machine's installed editor for a fixture home", () => {
    const { components } = collectIdeInventory(
      discoverIdeExtensionDirs(LAB_HOME),
      { home: LAB_HOME },
    );
    const editors = components.filter((c) =>
      c.purl?.startsWith("pkg:generic/cdxgen-ide/"),
    );
    assert.strictEqual(editors.length, 10);
    for (const editor of editors) {
      assert.strictEqual(editor.version, "", editor.purl);
      assert.strictEqual(prop(editor, "cdx:ide:installDir"), undefined);
    }
  });

  it("reads a desktop editor's version from the application folders it is given", () => {
    const info = findIdeProductInfo(
      { id: "cursor", kind: "desktop" },
      LAB_HOME,
      {
        appDirs: [join(PRODUCTS, "cursor"), join(PRODUCTS, "vscode")],
      },
    );
    assert.strictEqual(info.version, "3.27.22");
    assert.strictEqual(info.dataFolderName, ".cursor");
  });

  it("reads a copied remote server folder's version from beside it", () => {
    const dir = join(REMOTE_HOME, ".cursor-server", "extensions");
    const ide = identifyIdeFromExtensionsDir(dir);
    assert.strictEqual(ide.home, REMOTE_HOME);
    const { components } = collectIdeInventory([
      { ...ide, dir, probeApps: false },
    ]);
    assert.ok(
      byPurl(components, "pkg:generic/cdxgen-ide/cursor-server@3.27.22"),
    );
  });

  it("finds the home of a code-server folder", () => {
    const dir = join(LAB_HOME, ".local", "share", "code-server", "extensions");
    assert.strictEqual(identifyIdeFromExtensionsDir(dir).home, LAB_HOME);
  });
});

describe("one extension build in several editor folders", () => {
  const home = mkdtempSync(join(tmpdir(), "cdxgen-ide-copies-"));
  const vscode = join(home, ".vscode", "extensions");
  const cursor = join(home, ".cursor", "extensions");
  writeJson(
    join(vscode, "acme.tool-1.0.0", "package.json"),
    extensionPackage("tool"),
  );
  writeFileSync(join(vscode, "acme.tool-1.0.0", "ext.js"), "exports.a = 1;\n");
  writeJson(join(vscode, "extensions.json"), []);
  writeJson(join(vscode, ".obsolete"), { "acme.tool-1.0.0": true });
  writeJson(
    join(cursor, "acme.tool-1.0.0", "package.json"),
    extensionPackage("tool"),
  );
  writeFileSync(join(cursor, "acme.tool-1.0.0", "ext.js"), "exports.a = 2;\n");
  writeJson(join(cursor, "extensions.json"), [
    installRecord("acme.tool-1.0.0"),
  ]);
  const { components } = collectIdeInventory(discoverIdeExtensionDirs(home), {
    home,
  });
  rmSync(home, { force: true, recursive: true });
  const tool = byPurl(components, "pkg:vscode-extension/acme/tool@1.0.0");

  it("is pending removal only when every copy is", () => {
    assert.strictEqual(
      prop(tool, "cdx:vscode-extension:ide"),
      "VS Code, Cursor",
    );
    assert.strictEqual(
      prop(tool, "cdx:vscode-extension:pendingRemoval"),
      undefined,
    );
    assert.strictEqual(
      prop(tool, "cdx:vscode-extension:installSource"),
      "gallery",
    );
  });

  it("hashes every copy and flags copies that run different code", () => {
    assert.strictEqual(
      prop(tool, "cdx:vscode-extension:entryHashMismatch"),
      "true",
    );
    assert.strictEqual(tool.components.length, 2);
    const refs = tool.components.map((c) => c["bom-ref"]);
    assert.strictEqual(new Set(refs).size, 2);
    for (const ref of refs) {
      assert.ok(
        ref.startsWith("pkg:vscode-extension/acme/tool@1.0.0#ext.js@sha256:"),
      );
    }
  });
});

describe("symlinked extension folders", () => {
  it("reads a folder linked into the extensions folder and marks it", () => {
    if (platform() === "win32" || process.getuid?.() === 0) {
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "cdxgen-ide-link-"));
    try {
      const target = join(root, "src", "linked");
      writeJson(join(target, "package.json"), extensionPackage("linked"));
      const dir = join(root, ".cursor", "extensions");
      mkdirSync(dir, { recursive: true });
      symlinkSync(target, join(dir, "acme.linked-1.0.0"), "dir");
      const { components } = collectIdeInventory([{ dir }], {
        includeIdeComponents: false,
      });
      const linked = byPurl(
        components,
        "pkg:vscode-extension/acme/linked@1.0.0",
      );
      assert.ok(linked);
      assert.strictEqual(prop(linked, "cdx:vscode-extension:symlink"), "true");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("mergeExtensionComponents()", () => {
  it("keeps the .vsix hash and the installed folder's evidence for one build", () => {
    const ref = "pkg:vscode-extension/acme/tool@1.0.0";
    const merged = mergeExtensionComponents([
      {
        "bom-ref": ref,
        purl: ref,
        hashes: [{ alg: "SHA-256", content: "aa" }],
        properties: [{ name: "cdx:vscode-extension:main", value: "./ext.js" }],
      },
      {
        "bom-ref": ref,
        purl: ref,
        properties: [{ name: "cdx:vscode-extension:ide", value: "Cursor" }],
        evidence: { occurrences: [{ location: "/x/acme.tool-1.0.0" }] },
        components: [
          { "bom-ref": `${ref}#ext.js`, type: "file", name: "ext.js" },
        ],
      },
      { "bom-ref": "pkg:npm/left-pad@1.0.0", purl: "pkg:npm/left-pad@1.0.0" },
    ]);
    assert.strictEqual(merged.length, 2);
    assert.deepStrictEqual(merged[0].hashes, [
      { alg: "SHA-256", content: "aa" },
    ]);
    assert.strictEqual(merged[0].evidence.occurrences.length, 1);
    assert.strictEqual(merged[0].components.length, 1);
    assert.strictEqual(prop(merged[0], "cdx:vscode-extension:ide"), "Cursor");
  });
});

describe("hostile extension folders", () => {
  const skipSpecialFiles = platform() === "win32";

  it("does not hash an entry file that links outside the extension", () => {
    if (skipSpecialFiles || process.getuid?.() === 0) {
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "cdxgen-ide-escape-"));
    try {
      const outside = join(root, "secret.txt");
      writeFileSync(outside, "root only\n");
      const dir = join(root, "extensions");
      const ext = join(dir, "acme.escape-1.0.0");
      writeJson(
        join(ext, "package.json"),
        extensionPackage("escape", {
          main: "./out/ext.js",
          browser: "./linked/secret.txt",
        }),
      );
      mkdirSync(join(ext, "out"), { recursive: true });
      symlinkSync(outside, join(ext, "out", "ext.js"));
      symlinkSync(root, join(ext, "linked"), "dir");
      writeFileSync(join(dir, "extensions.json"), "[]");
      const { components } = collectIdeInventory([{ dir }], {
        includeIdeComponents: false,
      });
      const ext1 = byPurl(components, "pkg:vscode-extension/acme/escape@1.0.0");
      assert.ok(ext1);
      assert.strictEqual(ext1.components, undefined);
      assert.ok(!JSON.stringify(components).includes(sha256(outside)));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not block on a FIFO or read a device named like a metadata file", () => {
    if (skipSpecialFiles) {
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "cdxgen-ide-fifo-"));
    try {
      const dir = join(root, "extensions");
      const ext = join(dir, "acme.fifo-1.0.0");
      mkdirSync(ext, { recursive: true });
      execFileSync("mkfifo", [join(ext, "package.json")]);
      symlinkSync("/dev/zero", join(dir, "extensions.json"));
      symlinkSync("/dev/zero", join(ext, ".vsixmanifest"));
      const started = Date.now();
      const { components } = collectIdeInventory([{ dir }], {
        includeIdeComponents: false,
      });
      assert.ok(Date.now() - started < 5000, "the scan must not block");
      assert.deepStrictEqual(
        components.map((c) => c.purl),
        ["pkg:vscode-extension/acme/fifo@1.0.0"],
      );
      assert.strictEqual(isReadableVsix(join(ext, "package.json")), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps only enumerated and well-formed install metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-ide-hygiene-"));
    try {
      const folder = "acme.noisy-1.0.0";
      writeJson(
        join(dir, folder, "package.json"),
        extensionPackage("noisy", {
          main: { not: "a string" },
          activationEvents: [
            "onStartupFinished",
            { evil: true },
            "x".repeat(5000),
          ],
          repository: {
            url: "https://user:secret@example.com/acme/noisy.git?token=abc",
          },
        }),
      );
      writeJson(join(dir, "extensions.json"), [
        installRecord(folder, {
          source: "https://u:p@host/x?sig=SECRET",
          id: "Bearer abc",
          installedTimestamp: 1e30,
        }),
      ]);
      const { components } = collectIdeInventory([{ dir }], {
        includeIdeComponents: false,
      });
      const noisy = components[0];
      const serialized = JSON.stringify(noisy);
      for (const secret of ["secret", "SECRET", "Bearer", "token=abc"]) {
        assert.ok(!serialized.includes(secret), secret);
      }
      assert.strictEqual(
        prop(noisy, "cdx:vscode-extension:installSource"),
        undefined,
      );
      assert.strictEqual(
        prop(noisy, "cdx:vscode-extension:galleryId"),
        undefined,
      );
      assert.strictEqual(
        prop(noisy, "cdx:vscode-extension:installedAt"),
        undefined,
      );
      assert.strictEqual(prop(noisy, "cdx:vscode-extension:main"), undefined);
      assert.strictEqual(
        prop(noisy, "cdx:vscode-extension:activationEvents"),
        "onStartupFinished",
      );
      assert.deepStrictEqual(noisy.externalReferences, [
        { type: "vcs", url: "https://example.com/acme/noisy.git" },
      ]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
