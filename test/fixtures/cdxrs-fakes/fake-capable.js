#!/usr/bin/env node
// Fake cdxrs binary that advertises the fetch-github-token capability. Every
// probe fails when GITHUB_TOKEN reached its environment, and fetch echoes
// which requests carried a githubToken field.
import process from "node:process";

const args = process.argv.slice(2);
const tokenInEnv = Object.keys(process.env).some(
  (name) => name.toUpperCase() === "GITHUB_TOKEN",
);

if (tokenInEnv) {
  process.exit(1);
}

if (args.includes("--version")) {
  process.stdout.write("cdxrs 4.3.1\n");
  process.exit(0);
}

if (args[0] === "schema-version") {
  process.stdout.write(
    JSON.stringify({
      supportedSpecVersions: ["1.6", "1.7"],
      capabilities: ["fetch-github-token"],
    }) + "\n",
  );
  process.exit(0);
}

process.exit(0);
