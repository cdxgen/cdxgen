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

// Runs createJavaBom with a stand-in mvn on PATH that records its arguments.
// PATH and the Maven variables are process-wide, so this file holds one
// sequential test.

const ENV_NAMES = [
  "PATH",
  "MVN_CMD",
  "MAVEN_CMD",
  "MVN_ARGS",
  "MAVEN_ARGS",
  "MAVEN_HOME",
  "M2_HOME",
];

it("a project's settings.xml reaches every dependency:tree run as global settings", async () => {
  if (process.platform === "win32") {
    // The stand-in is a POSIX shell script.
    return;
  }
  const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  const root = mkdtempSync(join(tmpdir(), "cdxgen-mvn-project-settings-"));
  try {
    const binDir = join(root, "bin");
    const project = join(root, "project");
    const argsLog = join(root, "args.log");
    mkdirSync(binDir);
    mkdirSync(project);
    writeFileSync(
      join(project, "pom.xml"),
      "<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>app</artifactId><version>1.0.0</version></project>",
    );
    writeFileSync(join(project, "settings.xml"), "<settings/>");
    const fakeMvn = join(binDir, "mvn");
    writeFileSync(
      fakeMvn,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}
for arg do
case "$arg" in
  -DoutputFile=*)
    output="\${arg#-DoutputFile=}"
    mkdir -p "$(dirname "$output")"
    printf 'org.example:app:jar:1.0.0\\n' > "$output"
    ;;
esac
done
`,
    );
    chmodSync(fakeMvn, 0o755);
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env.PATH = [binDir, saved.PATH].filter(Boolean).join(delimiter);

    const { createJavaBom } = await import("./jvmBom.js");
    await createJavaBom(project, {
      multiProject: true,
      projectType: ["java"],
      specVersion: 1.6,
    });

    const runs = readFileSync(argsLog, "utf-8")
      .split("\n")
      .filter((line) => line.startsWith("dependency:tree"));
    assert.ok(runs.length >= 2, `dependency:tree ran ${runs.length} time(s)`);
    const settingsFile = join(project, "settings.xml");
    for (const run of runs) {
      assert.ok(run.includes(`-gs ${settingsFile}`), run);
      assert.ok(!run.split(" ").includes("-s"), run);
    }
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
});
