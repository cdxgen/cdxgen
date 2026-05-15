# Scanning Large and Complex Projects

This page covers strategies for getting accurate, performant BOM generation from large repositories, monorepos, and multi-language projects.

## Understanding recursive vs. non-recursive mode

By default cdxgen walks the entire directory tree under the path you provide, discovering every manifest and lock file it recognises. This is the right setting for most projects.

If you only want to scan the root-level manifest (for example a single `pom.xml` at the repository root), use `--no-recurse`:

```bash
cdxgen -t java --no-recurse -o bom.json .
```

This is useful in monorepos where each sub-project should be scanned independently.

## Include and exclude patterns

cdxgen provides three complementary filter arguments.

`--include-regex` narrows which manifest files are processed. Only files whose path matches the glob are included:

```bash
# scan only the manifests under services/ subdirectories
cdxgen -t java --include-regex "**/services/*/pom.xml" -o bom.json .
```

`--exclude` removes specific files or directories from consideration:

```bash
cdxgen -t js --exclude "**/test/**" --exclude "**/fixtures/**" -o bom.json .
```

`--exclude-type` skips an entire language type when a polyglot project contains tooling you do not want catalogued:

```bash
cdxgen --exclude-type github --exclude-type mcp -o bom.json .
```

## Splitting a multi-language monorepo

For large monorepos it is often better to generate one BOM per service or per language rather than one combined BOM. This keeps each output file focused and keeps generation time manageable.

```bash
# Java service
cdxgen -t java -o sbom-java.json services/java-service

# Node.js service
cdxgen -t js -o sbom-node.json services/node-service
```

You can later merge these with `cdx-convert` or supply them separately to a vulnerability scanner.

## Generating BOM for all types in one pass

If you need a single combined BOM, pass multiple `-t` flags:

```bash
cdxgen -t java -t js -t py -o bom.json .
```

cdxgen runs each language scan in parallel where possible and merges the results. Use `--exclude-type` for any type that is present but unwanted.

## Performance tuning

**Disable registry metadata fetching** when you do not need license or description enrichment:

```bash
FETCH_LICENSE=false cdxgen -t java -o bom.json .
```

**Reduce the HTTP timeout** to prevent slow registries from stalling the scan:

```bash
CDXGEN_TIMEOUT_MS=5000 cdxgen -t java -o bom.json .
```

**Skip dependency installation** when `node_modules` or a virtual environment is already present:

```bash
cdxgen -t js --no-install-deps -o bom.json .
```

**Use the required-only filter** to limit output to direct dependencies:

```bash
cdxgen -t java --required-only -o bom.json .
```

## Using server mode for repeated scans

When you need to scan many projects in a batch, cdxgen server mode avoids the Node.js startup cost on every invocation:

```bash
# start the server
cdxgen --server --server-port 9090

# scan projects via HTTP (in another terminal)
curl -s "http://localhost:9090/sbom?path=/workspace/project-a&type=java" -o bom-a.json
curl -s "http://localhost:9090/sbom?path=/workspace/project-b&type=js" -o bom-b.json
```

See [Server Usage](SERVER.md) for full documentation of the server API.

## Handling Maven or Gradle caches

For Java projects with many modules, scanning the Maven or Gradle local cache gives you a catalogue of all jars your build system has ever resolved:

```bash
cdxgen -t maven-cache -o bom-cache.json ~/.m2
```

This is particularly useful for air-gapped environments where you want to audit what is stored in the cache rather than what a specific project uses.

## Dealing with nested projects

Some repositories contain multiple independent sub-projects each with their own dependency manifests. A directory structure like:

```
repo/
  frontend/package.json
  backend/pom.xml
  infra/requirements.txt
```

works well with a single invocation from the repo root because cdxgen walks all subdirectories and merges the results. If you want separate BOMs per sub-project, invoke cdxgen once per directory and combine later.

## Configuration files for repeatable invocations

Rather than remembering many flags, commit a `.cdxgenrc` file to the repository root:

```json
{
  "type": ["java", "js"],
  "output": "bom.json",
  "exclude": ["**/test/**", "**/fixtures/**"],
  "fetchLicense": false
}
```

Every developer and CI pipeline that clones the repo then gets the same defaults automatically.

## Debugging a slow or incomplete scan

Enable debug output to see every manifest file discovered and every command executed:

```bash
CDXGEN_DEBUG_MODE=debug cdxgen -t java -o bom.json . 2>&1 | tee cdxgen-debug.log
```

Look for lines that mention "Skipping" to understand what was filtered, and lines containing "spawn" to see which package manager commands ran and what they returned.
