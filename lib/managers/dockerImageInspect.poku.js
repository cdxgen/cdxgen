import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";

import { assert, it } from "poku";

// Runs getImage against a recording stand-in docker CLI on PATH, which
// replays the recorded `image inspect` output and logs every argument list
// it receives. A local image named by tag, by its fully qualified
// docker.io/library form or by digest must be answered by the reference
// itself, so no pull runs; only an absent image is pulled, once.
// PATH, HOME and the container CLI variables are process-wide, so the cases
// run one after the other inside a single it.

const IMAGE_DIGEST =
  "postgres@sha256:f7d23353e1b15400d22ebe31189f4d314b87a4c129cc400c8c2d8d4ca127bf81";
const PRESENT_REFS = [
  "postgres:15-alpine",
  "docker.io/library/postgres:15-alpine",
  IMAGE_DIGEST,
];
const IMAGE_ID =
  "sha256:f7d23353e1b15400d22ebe31189f4d314b87a4c129cc400c8c2d8d4ca127bf81";

/**
 * Prepare a stand-in docker on PATH and a fresh state file of present refs,
 * then run fn with only that bin directory reachable.
 *
 * @param {(getImage: Function, take: () => string[]) => Promise<void>} fn
 *   Test body, handed getImage plus a reader that returns the argument lines
 *   recorded since its previous call.
 */
async function withRecordingDocker(fn) {
  const names = ["PATH", "HOME", "DOCKER_CMD", "DOCKER_USE_CLI", "DOCKER_HOST"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-docker-inspect-"));
  const dataDir = join(
    import.meta.dirname,
    "..",
    "..",
    "test",
    "data",
    "docker-image-inspect",
  );
  try {
    const binDir = join(root, "bin");
    const emptyHome = join(root, "home");
    mkdirSync(binDir);
    mkdirSync(emptyHome);
    const argsLog = join(root, "args.log");
    // The refs the recorded image store holds. A pull the stand-in runs adds
    // its reference, so the inspect after a successful pull finds the image.
    const state = join(root, "present-refs.log");
    writeFileSync(state, `${PRESENT_REFS.join("\n")}\n`);
    const fakeDocker = join(binDir, "docker");
    writeFileSync(
      fakeDocker,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
        'if [ "$1" = "pull" ]; then',
        `  printf '%s\\n' "$2" >> ${JSON.stringify(state)}`,
        "  exit 0",
        "fi",
        'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
        `  if grep -Fxq "$3" ${JSON.stringify(state)} 2>/dev/null; then`,
        `    cat ${JSON.stringify(join(dataDir, "present.json"))}`,
        "    exit 0",
        "  fi",
        `  cat ${JSON.stringify(join(dataDir, "absent.txt"))} >&2`,
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fakeDocker, 0o755);
    for (const name of names) {
      delete process.env[name];
    }
    // Only the stand-in and the system shell are reachable, so the CLI
    // selection cannot pick up colima, nerdctl or a real docker of the host.
    process.env.PATH = [binDir, "/usr/bin:/bin"].join(delimiter);
    process.env.HOME = emptyHome;
    process.env.DOCKER_USE_CLI = "1";
    const { getImage } = await import("./docker.js");
    let read = 0;
    const take = () => {
      const lines = readFileSync(argsLog, "utf-8")
        .split("\n")
        .filter(Boolean);
      const fresh = lines.slice(read);
      read = lines.length;
      return fresh;
    };
    await fn(getImage, take);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
}

await it("the container CLI is asked about the reference before pulling", async () => {
  if (process.platform === "win32") {
    // The stand-in is a POSIX shell script.
    return;
  }
  await withRecordingDocker(async (getImage, take) => {
    // A local image found by its plain tag.
    let imageData = await getImage("postgres:15-alpine");
    assert.strictEqual(imageData?.Id, IMAGE_ID);
    assert.deepStrictEqual(imageData?.RepoTags, ["postgres:15-alpine"]);
    assert.deepStrictEqual(take(), ["image inspect postgres:15-alpine"]);

    // The same image named with its fully qualified form. The Repository:Tag
    // comparison missed it and pulled a present image.
    imageData = await getImage("docker.io/library/postgres:15-alpine");
    assert.strictEqual(imageData?.Id, IMAGE_ID);
    assert.deepStrictEqual(take(), [
      "image inspect docker.io/library/postgres:15-alpine",
    ]);

    // The same image named by digest, which has no Repository:Tag form at all.
    imageData = await getImage(IMAGE_DIGEST);
    assert.strictEqual(imageData?.Id, IMAGE_ID);
    assert.deepStrictEqual(take(), [`image inspect ${IMAGE_DIGEST}`]);

    // An image the store does not hold is pulled once, and the inspect after
    // the pull reads what the pull brought in.
    imageData = await getImage("alpine:3.19");
    assert.strictEqual(imageData?.Id, IMAGE_ID);
    assert.deepStrictEqual(take(), [
      "image inspect alpine:3.19",
      "pull alpine:3.19",
      "image inspect alpine:3.19",
    ]);

    // Positive control: the stand-in still sees calls, and a second absent
    // reference is pulled again.
    await getImage("busybox:latest");
    assert.deepStrictEqual(take(), [
      "image inspect busybox:latest",
      "pull busybox:latest",
      "image inspect busybox:latest",
    ]);
  });
});
