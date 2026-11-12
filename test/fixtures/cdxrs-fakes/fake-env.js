#!/usr/bin/env node
// Fake cdxrs binary that reports which credential variables reached it.
import process from "node:process";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("cdxrs 4.0.0\n");
  process.exit(0);
}

if (args[0] === "fetch") {
  process.stdout.write(
    JSON.stringify({
      githubToken: Object.keys(process.env).some(
        (name) => name.toUpperCase() === "GITHUB_TOKEN",
      ),
      marker: process.env.CDXGEN_FAKE_MARKER || null,
    }) + "\n",
  );
  process.exit(0);
}

process.exit(0);
