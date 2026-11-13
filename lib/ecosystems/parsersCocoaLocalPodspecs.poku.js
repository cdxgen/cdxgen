import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

// A checked out pod reads the podspec `pod install` wrote under
// Pods/Local Podspecs, a pod the lockfile pinned to a commit asks for that
// commit's podspec alone, and only a pod with no pinned revision probes the
// default branch names. The requests are counted by a local stub registry
// serving the raw repository paths, and `pod ipc spec` runs against a
// stand-in that prints the podspec file. The environment it changes is
// process-wide, so everything runs inside a single it.

const PODSPEC = (name, summary) =>
  `${JSON.stringify({
    authors: { "Acme Engineers": "dev@acme.example" },
    homepage: "https://acme.example",
    license: { type: "MIT" },
    name,
    summary,
    version: "1.0.0",
  })}\n`;

await it("cocoapods reads local podspecs and the pinned commit before any branch probe", async () => {
  const envNames = ["POD_CMD", "COCOA_FULL_SCAN", "CDXGEN_RS_DISABLE"];
  const saved = Object.fromEntries(envNames.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-cocoa-local-"));
  const server = http.createServer((req, res) => {
    if (req.url === "/acme/pinned/0123456789abcdef/Pinned.podspec") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(PODSPEC("Pinned", "pinned summary"));
      return;
    }
    if (req.url === "/acme/default/refs/heads/main/Default.podspec") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(PODSPEC("Default", "default branch summary"));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  const requested = [];
  server.on("request", (req) => requested.push(req.url));
  await new Promise((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    delete process.env.COCOA_FULL_SCAN;
    process.env.CDXGEN_RS_DISABLE = "fetch";
    const project = join(root, "project");
    mkdirSync(project);
    // The podspec of a checked out development pod, as pod install writes it.
    const localPodspecs = join(project, "Pods", "Local Podspecs");
    mkdirSync(localPodspecs, { recursive: true });
    writeFileSync(
      join(localPodspecs, "LocalSpec.podspec.json"),
      PODSPEC("LocalSpec", "local summary"),
    );
    // A stand-in pod that answers `ipc spec --silent <file>` by printing the
    // file, which is the JSON form CocoaPods prints for a .podspec.json.
    const fakePod = join(root, "fakepod");
    writeFileSync(
      fakePod,
      [
        "#!/bin/sh",
        'if [ "$1" = "ipc" ]; then cat "$4"; fi',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fakePod, 0o755);
    process.env.POD_CMD = fakePod;

    const { parsePodfileLock, buildObjectForCocoaPod } = await import(
      "./parsers-misc.js"
    );
    const pods = await parsePodfileLock(
      {
        PODS: ["LocalSpec (1.0.0)", "Pinned (2.0.0)", "Default (3.0.0)"],
        "EXTERNAL SOURCES": {
          LocalSpec: { ":git": `${base}/acme/local-spec.git` },
          // A branch whose head may have moved: the pinned commit wins.
          Pinned: { ":git": `${base}/acme/pinned.git`, ":branch": "develop" },
          Default: { ":git": `${base}/acme/default.git` },
        },
        "CHECKOUT OPTIONS": {
          Pinned: {
            ":git": `${base}/acme/pinned.git`,
            ":commit": "0123456789abcdef",
          },
        },
        "SPEC REPOS": { trunk: [] },
        DEPENDENCIES: ["LocalSpec", "Pinned", "Default"],
      },
      project,
    );
    const components = new Map();
    for (const pod of pods.values()) {
      components.set(
        pod.metadata.name,
        await buildObjectForCocoaPod(pod.metadata, {}),
      );
    }
    // One request for the pod pinned to a commit, one for the pod that only
    // has a default branch. The checked out pod's podspec came from disk,
    // and no main or master probe ran for the pinned pod.
    assert.deepStrictEqual(requested.sort(), [
      "/acme/default/refs/heads/main/Default.podspec",
      "/acme/pinned/0123456789abcdef/Pinned.podspec",
    ]);
    // Positive control: the stub served both requests, and the components
    // carry what their podspecs said. The stand-in pod that turns a podspec
    // into JSON is a POSIX shell script, so the podspec contents are only
    // checked off Windows; the request list above holds everywhere.
    if (process.platform !== "win32") {
      const local = components.get("LocalSpec");
      assert.deepStrictEqual(local?.licenses, [{ license: { id: "MIT" } }]);
      assert.strictEqual(local?.description, "local summary");
      const pinned = components.get("Pinned");
      assert.deepStrictEqual(pinned?.licenses, [{ license: { id: "MIT" } }]);
      assert.strictEqual(pinned?.description, "pinned summary");
      const def = components.get("Default");
      assert.strictEqual(def?.description, "default branch summary");
    }
  } finally {
    server.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
});

await it("a pod path or podspec location that leaves the scanned directory is refused", async () => {
  const project = mkdtempSync(join(tmpdir(), "cdxgen-cocoa-path-"));
  try {
    const { parsePodfileLock } = await import("./parsers-misc.js");
    // A React Native app: the Podfile lives in ios/ and names its pods from
    // ../node_modules, which is inside the scanned repository.
    const ios = join(project, "ios");
    const rnPodDir = join(project, "node_modules", "react-native");
    mkdirSync(ios, { recursive: true });
    mkdirSync(rnPodDir, { recursive: true });
    writeFileSync(join(rnPodDir, "React-Core.podspec"), "Pod::Spec.new\n");
    const rnPods = await parsePodfileLock(
      {
        PODS: ["React-Core (0.76.0)", "../../Escape (1.0.0)"],
        "EXTERNAL SOURCES": {
          "React-Core": { ":path": "../node_modules/react-native" },
          "../../Escape": { ":git": "https://github.com/acme/escape.git" },
        },
        DEPENDENCIES: ["React-Core"],
      },
      ios,
      project,
    );
    const rnProps = Object.fromEntries(
      (rnPods.get("React-Core")?.metadata.properties || []).map((p) => [
        p.name,
        p.value,
      ]),
    );
    assert.strictEqual(rnProps["cdx:pods:projectDir"], rnPodDir);
    assert.strictEqual(
      rnProps["cdx:pods:podspecLocation"],
      join(rnPodDir, "React-Core.podspec"),
    );
    // A pod name is joined onto directories, so one that is a path is not
    // given a podspec location.
    assert.deepStrictEqual(
      rnPods.get("../../Escape")?.metadata.properties || [],
      [],
    );

    const pods = await parsePodfileLock(
      {
        PODS: ["Outside (1.0.0)", "Absolute (1.0.0)", "Inside (1.0.0)"],
        "EXTERNAL SOURCES": {
          Outside: { ":path": "../../outside" },
          Absolute: { ":podspec": "/etc/passwd" },
          Inside: { ":path": "vendor/inside" },
        },
        DEPENDENCIES: ["Outside", "Absolute", "Inside"],
      },
      project,
    );
    const propertiesOf = (name) =>
      pods.get(name)?.metadata.properties?.map((p) => p.name) || [];
    // The climbing and absolute paths contribute nothing, while a path that
    // stays inside the project is resolved as before.
    assert.deepStrictEqual(propertiesOf("Outside"), []);
    assert.deepStrictEqual(propertiesOf("Absolute"), []);
    assert.ok(
      propertiesOf("Inside").includes("cdx:pods:projectDir"),
      `expected a projectDir for Inside, got ${propertiesOf("Inside").join(", ")}`,
    );
  } finally {
    rmSync(project, { force: true, recursive: true });
  }
});

await it("only a web :git URL yields a podspec location, and other git pods are not looked up by name", async () => {
  const project = mkdtempSync(join(tmpdir(), "cdxgen-cocoa-git-"));
  const envNames = ["POD_CMD", "COCOA_FULL_SCAN"];
  const saved = Object.fromEntries(envNames.map((n) => [n, process.env[n]]));
  // A command name that exists nowhere, so every pod call is recorded and
  // fails without running anything.
  const podCmd = `cdxgen-absent-pod-${process.pid}`;
  try {
    process.env.POD_CMD = podCmd;
    delete process.env.COCOA_FULL_SCAN;
    const { parsePodfileLock, buildObjectForCocoaPod } = await import(
      "./parsers-misc.js"
    );
    const { commandsExecuted } = await import("../core/fs.js");
    const pods = await parsePodfileLock(
      {
        PODS: [
          "Web (1.0.0)",
          "Flag (1.0.0)",
          "Local (1.0.0)",
          "Ssh (1.0.0)",
          "Plain (1.0.0)",
          "Private (1.0.0)",
        ],
        "EXTERNAL SOURCES": {
          Web: { ":git": "https://github.com/acme/web.git", ":tag": "1.0.0" },
          Private: {
            ":git":
              "https://ci-bot:Vb8nexusQz41mX@git.example.com/acme/private.git",
            ":tag": "1.0.0",
          },
          // An option, a path that climbs out of the project and an ssh
          // remote are not web URLs, so none of them names a podspec.
          Flag: { ":git": "--allow-root" },
          Local: { ":git": project, ":tag": "../../../outside" },
          Ssh: { ":git": "git@github.com:acme/ssh.git" },
        },
        DEPENDENCIES: ["Web", "Flag", "Local", "Ssh", "Plain"],
      },
      project,
    );
    const locationOf = (name) =>
      pods
        .get(name)
        ?.metadata.properties?.find(
          (p) => p.name === "cdx:pods:podspecLocation",
        )?.value;
    assert.strictEqual(
      locationOf("Web"),
      "https://raw.githubusercontent.com/acme/web/refs/tags/1.0.0/Web.podspec",
    );
    assert.strictEqual(
      locationOf("Private"),
      "https://git.example.com/acme/private/refs/tags/1.0.0/Private.podspec",
    );
    assert.strictEqual(locationOf("Flag"), undefined);
    assert.strictEqual(locationOf("Local"), undefined);
    assert.strictEqual(locationOf("Ssh"), undefined);
    // The pods from other git sources keep what the lockfile says: a spec
    // repository pod of the same name may be a different project.
    for (const name of ["Flag", "Local", "Ssh"]) {
      const component = await buildObjectForCocoaPod(
        pods.get(name).metadata,
        {},
      );
      assert.strictEqual(component.purl, `pkg:cocoapods/${name}@1.0.0`);
    }
    assert.strictEqual(commandsExecuted.has(podCmd), false);
    // Control: a pod with no external source is looked up by name.
    await buildObjectForCocoaPod(pods.get("Plain").metadata, {});
    assert.strictEqual(commandsExecuted.has(podCmd), true);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(project, { force: true, recursive: true });
  }
});
