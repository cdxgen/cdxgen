import { generateKeyPairSync } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import { safeSpawnSync } from "../core/fs.js";

const FIXTURES = join("test", "data", "cbom-certs");
const KEYSTORE_LOCATION = "/usr/lib/jvm/java-21/lib/security/cacerts";

const prop = (component, name) =>
  component.properties?.find((p) => p.name === name)?.value;

const PLUGIN = "/stand-in/trustinspector";

// Builds a rootfs holding the committed PKCS#12 truststore at the path the
// committed plugin reports use.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cdxgen-cryptocerts-"));
  const root = join(dir, "root");
  const keystoreDir = join(root, "usr/lib/jvm/java-21/lib/security");
  mkdirSync(keystoreDir, { recursive: true });
  cpSync(
    join(FIXTURES, "generated", "cacerts.p12"),
    join(keystoreDir, "cacerts"),
  );
  return { dir, root };
}

// Runs createCryptoCertsBom with a stand-in for the trustinspector binary
// that prints the given report. The stand-in is an in-process replacement
// for safeSpawnSync rather than a script on disk: executing a file written
// a moment earlier fails at random on busy CI runners (a failed spawn sends
// cdxgen down the Node fallback, which these tests would report as a
// wrong BOM). The calls are recorded so tests can check what the plugin was
// given.
async function run({ root }, report) {
  const calls = [];
  const { createCryptoCertsBom } = await esmock(
    "./managedBom.js",
    {
      "../inventory/plugins.js": {
        resolvePluginBinary: (name) =>
          name === "trustinspector" ? PLUGIN : undefined,
        getPluginToolComponents: () => [],
      },
    },
    {
      "../core/fs.js": {
        safeSpawnSync: (command, args, options) => {
          if (command !== PLUGIN) {
            return safeSpawnSync(command, args, options);
          }
          calls.push({ args, input: options?.input });
          return { status: 0, stdout: JSON.stringify(report), stderr: "" };
        },
      },
    },
  );
  const bom = await createCryptoCertsBom(root, {
    multiProject: true,
    allLayersExplodedDir: root,
  });
  return { bom, calls };
}

const report2 = () =>
  JSON.parse(readFileSync(join(FIXTURES, "report-2-rootfs.json"), "utf-8"));

describe("createCryptoCertsBom with the plugin: keystores", () => {
  it("emits a keystore component linked to the certificates it holds", async () => {
    const env = setup();
    try {
      const { bom, calls } = await run(env, report2());
      assert.strictEqual(calls.length, 1, "the plugin runs once");
      assert.deepStrictEqual(calls[0].args, [
        "certs",
        "--stdin",
        "--root",
        env.root,
      ]);
      assert.ok(
        calls[0].input.includes(join(env.root, KEYSTORE_LOCATION)),
        "the plugin is given the truststore",
      );
      const keystore = bom.bomJson.components.find(
        (c) =>
          c["bom-ref"] ===
          `crypto/related-crypto-material/keystore/${encodeURIComponent(KEYSTORE_LOCATION)}`,
      );
      assert.ok(keystore, "keystore component present");
      assert.strictEqual(
        prop(keystore, "cdx:crypto:sourceType"),
        "java-truststore",
      );
      assert.strictEqual(
        prop(keystore, "cdx:crypto:keystoreReadable"),
        undefined,
      );
      assert.deepStrictEqual(keystore.evidence.occurrences, [
        { location: KEYSTORE_LOCATION },
      ]);
      const held = bom.bomJson.components.filter(
        (c) =>
          c.cryptoProperties?.assetType === "certificate" &&
          c.evidence.occurrences.some((o) => o.location === KEYSTORE_LOCATION),
      );
      assert.ok(held.length > 0);
      const edge = bom.dependencies.find((d) => d.ref === keystore["bom-ref"]);
      assert.deepStrictEqual(
        edge.dependsOn,
        held.map((c) => c["bom-ref"]).sort(),
      );
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("still gives an unreadable keystore a component, without certificates or secrets", async () => {
    // Synthesized from the committed report: the certificate materials of the
    // truststore are replaced by the keystore material the plugin emits for
    // a keystore it cannot open. This input is not plugin output.
    const report = report2();
    report.materials = report.materials
      .filter((m) => m.path !== KEYSTORE_LOCATION)
      .concat({
        kind: "keystore",
        path: KEYSTORE_LOCATION,
        sourceType: "java-truststore",
        format: "PKCS12",
        properties: [{ name: "cdx:crypto:keystoreReadable", value: "false" }],
      });
    const env = setup();
    try {
      const { bom } = await run(env, report);
      const keystore = bom.bomJson.components.find((c) =>
        c["bom-ref"].startsWith("crypto/related-crypto-material/keystore/"),
      );
      assert.strictEqual(
        prop(keystore, "cdx:crypto:keystoreReadable"),
        "false",
      );
      assert.ok(
        !bom.dependencies.some((d) => d.ref === keystore["bom-ref"]),
        "no certificate edges",
      );
      const json = JSON.stringify(bom);
      assert.ok(!json.includes("changeit"));
      assert.ok(!json.includes(env.dir), "no host paths");
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("without a plugin the keystore component carries keystoreReadable=false", async () => {
    const env = setup(report2());
    try {
      const { createCryptoCertsBom } = await esmock("./managedBom.js", {
        "../inventory/plugins.js": {
          resolvePluginBinary: () => undefined,
          getPluginToolComponents: () => [],
        },
      });
      const bom = await createCryptoCertsBom(env.root, {
        multiProject: true,
        allLayersExplodedDir: env.root,
      });
      const keystore = bom.bomJson.components.find((c) =>
        c["bom-ref"].startsWith("crypto/related-crypto-material/keystore/"),
      );
      assert.strictEqual(
        prop(keystore, "cdx:crypto:keystoreReadable"),
        "false",
      );
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("a report-1 plugin falls back to the same producer as no plugin", async () => {
    const report1 = JSON.parse(
      readFileSync(join(FIXTURES, "report-1-rootfs.json"), "utf-8"),
    );
    const env = setup();
    try {
      const { bom } = await run(env, report1);
      const keystore = bom.bomJson.components.find((c) =>
        c["bom-ref"].startsWith("crypto/related-crypto-material/keystore/"),
      );
      assert.strictEqual(
        prop(keystore, "cdx:crypto:keystoreReadable"),
        "false",
      );
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });
});

describe("createCryptoCertsBom with a report-2 plugin: keys it does not build", () => {
  it("still lists a PEM public key and an OpenPGP key the plugin gives no certificate for", async () => {
    // trustinspector 4.2.0's certs mode reports nothing for a PEM public key
    // and only public-key material for an OpenPGP key; plugins 4.1.1 spoke
    // report-1, so these files always took the Node path.
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-cryptocerts-keys-"));
    try {
      const root = join(dir, "root");
      mkdirSync(join(root, "etc/apk/keys"), { recursive: true });
      mkdirSync(join(root, "usr/share/keyrings"), { recursive: true });
      const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      writeFileSync(
        join(root, "etc/apk/keys/builder.rsa.pub"),
        publicKey.export({ type: "spki", format: "pem" }),
      );
      writeFileSync(
        join(root, "usr/share/keyrings/example-archive-keyring.gpg"),
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQENBGexample\n-----END PGP PUBLIC KEY BLOCK-----\n",
      );
      const report = {
        schema: "trustinspector/report-2",
        tool: "trustinspector",
        toolVersion: "4.2.0",
        materials: [
          {
            kind: "public-key",
            path: "/usr/share/keyrings/example-archive-keyring.gpg",
            paths: ["/usr/share/keyrings/example-archive-keyring.gpg"],
          },
        ],
      };

      const { bom } = await run({ root }, report);
      const refs = bom.bomJson.components.map((c) => c["bom-ref"]);
      assert.ok(
        refs.some((ref) =>
          ref.startsWith(
            "crypto/related-crypto-material/public-key/builder.rsa.pub@sha256:",
          ),
        ),
        refs.join("\n"),
      );
      const gpg = bom.bomJson.components.find((c) =>
        c["bom-ref"].startsWith(
          "crypto/related-crypto-material/public-key/example-archive-keyring.gpg@sha256:",
        ),
      );
      assert.ok(gpg, refs.join("\n"));
      assert.strictEqual(
        gpg.cryptoProperties.relatedCryptoMaterialProperties.format,
        "OpenPGP",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not read again a file the plugin built a certificate from", async () => {
    const env = setup();
    try {
      const { bom } = await run(env, report2());
      const certificateRefs = bom.bomJson.components
        .filter((c) => c.cryptoProperties?.assetType === "certificate")
        .map((c) => c["bom-ref"]);
      assert.ok(certificateRefs.length > 0);
      assert.strictEqual(new Set(certificateRefs).size, certificateRefs.length);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });
});

describe("createCryptoCertsBom: PEM public keys", () => {
  it("hashes the file, so version and bom-ref carry a digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdxgen-pubkey-"));
    try {
      const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      writeFileSync(
        join(dir, "key.pub"),
        publicKey.export({ type: "spki", format: "pem" }),
      );
      const { createCryptoCertsBom } = await esmock("./managedBom.js", {
        "../inventory/plugins.js": {
          resolvePluginBinary: () => undefined,
          getPluginToolComponents: () => [],
        },
      });
      const bom = await createCryptoCertsBom(dir, { multiProject: true });
      const key = bom.bomJson.components.find((c) =>
        c["bom-ref"].startsWith("crypto/related-crypto-material/public-key/"),
      );
      assert.ok(key);
      assert.match(key.version, /^[0-9a-f]{64}$/);
      assert.ok(!key["bom-ref"].includes("[object"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
