import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "poku";

import { resetRunState } from "../core/runState.js";
import { createContainerSpecLikeBom } from "./index.js";

const COMPOSE = [
  "services:",
  "  web:",
  "    annotations:",
  "      org.opencontainers.image.title: web",
  "    build:",
  "      dockerfile: ./ci/Dockerfile",
  "",
].join("\n");

async function noteLines(options) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-compose-exclude-"));
  const logged = [];
  const originalLog = console.log;
  try {
    mkdirSync(join(root, "ci"));
    writeFileSync(join(root, "docker-compose.yml"), COMPOSE);
    writeFileSync(join(root, "ci", "Dockerfile"), "FROM scratch\n");
    resetRunState();
    console.log = (...args) => logged.push(args.join(" "));
    await createContainerSpecLikeBom(root, {
      projectType: ["oci"],
      multiProject: true,
      specVersion: 1.6,
      ...options,
    });
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
  return logged.filter((line) => line.startsWith("NOTE:"));
}

it("names a build file a compose file declares", async () => {
  const notes = await noteLines({});
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0], /ci[\\/]Dockerfile/);
});

it("does not name a build file the exclude patterns match", async () => {
  const notes = await noteLines({ exclude: ["ci/**"] });
  assert.deepStrictEqual(notes, []);
});
