import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "poku";

import { azurePipelinesParser } from "./azurePipelines.js";
import { circleCiParser } from "./circleCi.js";
import { githubActionsParser } from "./githubActions.js";
import { gitlabCiParser } from "./gitlabCi.js";
import { jenkinsParser } from "./jenkins.js";

const FILES = {
  jenkins: [
    "Jenkinsfile",
    "pipeline {\n  agent any\n  stages {\n    stage('Build') { steps { sh 'make' } }\n  }\n}\n",
  ],
  github: [
    ".github/workflows/ci.yml",
    "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n",
  ],
  gitlab: [".gitlab-ci.yml", "build:\n  script:\n    - make\n"],
  circle: [
    ".circleci/config.yml",
    "version: 2.1\njobs:\n  build:\n    docker:\n      - image: cimg/base:stable\n    steps:\n      - checkout\nworkflows:\n  main:\n    jobs:\n      - build\n",
  ],
  azure: [
    "azure-pipelines.yml",
    "trigger:\n  - main\npool:\n  vmImage: ubuntu-latest\nsteps:\n  - script: make\n",
  ],
};

const PARSERS = {
  jenkins: jenkinsParser,
  github: githubActionsParser,
  gitlab: gitlabCiParser,
  circle: circleCiParser,
  azure: azurePipelinesParser,
};

describe("CI parsers and links out of the scanned tree", () => {
  it("reads a link that stays inside the tree and skips one that leaves it", () => {
    if (process.platform === "win32") {
      return;
    }
    const work = mkdtempSync(path.join(tmpdir(), "cdxgen-ci-links-"));
    try {
      const outside = path.join(work, "outside");
      const repo = path.join(work, "repo");
      const inside = path.join(repo, "real");
      for (const [key, [name, text]] of Object.entries(FILES)) {
        for (const dir of [outside, inside, repo]) {
          mkdirSync(path.join(dir, key, path.dirname(name)), {
            recursive: true,
          });
        }
        writeFileSync(path.join(outside, key, name), text);
        writeFileSync(path.join(inside, key, name), text);
        const linkOut = path.join(repo, key, name);
        symlinkSync(path.join(outside, key, name), linkOut);
        const parser = PARSERS[key];
        const left = parser.parse([linkOut], {}, { rootDir: repo });
        assert.strictEqual(
          left.workflows.length,
          0,
          `${key}: a link out of the tree must not be read`,
        );
        const linkIn = path.join(repo, `${key}-in`, name);
        mkdirSync(path.dirname(linkIn), { recursive: true });
        symlinkSync(path.join(inside, key, name), linkIn);
        const stayed = parser.parse([linkIn], {}, { rootDir: repo });
        assert.ok(
          stayed.workflows.length > 0,
          `${key}: a link inside the tree is read`,
        );
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
