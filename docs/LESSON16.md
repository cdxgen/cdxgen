# Tutorial: Dynamic Process Tracing and Library-Load SBOM Generation

This lesson shows how to generate a Software Bill of Materials (SBOM) by executing and tracing a target binary using process execution tracking and native OS sandboxing with `@cdxgen/safer-exec`.

## Goal

By the end of this lesson you should be able to answer:

1. How do I capture libraries loaded dynamically at runtime that static analysis cannot see?
2. How do I associate loaded shared objects or libraries with host operating system packages?
3. How do I generate an SBOM containing dynamically instrumented components?
4. How do I collect HTTP URL endpoints accessed by a process and enumerate them as services?
5. How do I inspect and query these instrumented components in the `cdxi` REPL?

## Step 1: Run a dynamic SBOM scan

Use the dedicated `tracebom` CLI:

```bash
tracebom --cmd "node app.js" -o bom.json
```

If you need to trace inside a specific directory, use `--working-dir`:

```bash
tracebom --cmd "node app.js" -d /path/to/app -o bom.json
```

> **Note:** Dynamic SBOM generation via `cdxgen -t dynamic --trace-cmd` is still available through the library API, but the CLI surface (`--trace-cmd`, `--trace-working-dir`) has moved to the dedicated `tracebom` binary.

## Step 2: Understand the component attributes

The dynamic tracing engine automatically:

- Captures runtime `dlopen`-ed libraries, platform libraries, and dynamic linkers.
- Queries host package managers (`dpkg`, `apk`, `rpm`, `brew`) to resolve the file paths to system package metadata.
- Calculates `SHA-256` hashes of the libraries.
- Tags components with `scope=required`.
- Populates the `evidence` field indicating the component identity was verified via `instrumentation` technique, setting the confidence to `0.8` if version is resolved or `0.5` if unknown.

Example component output in JSON:

```json
{
  "name": "libc6",
  "version": "2.35-0ubuntu3",
  "type": "library",
  "scope": "required",
  "purl": "pkg:deb/debian/libc6@2.35-0ubuntu3?arch=amd64",
  "hashes": [
    {
      "alg": "SHA-256",
      "content": "8b51d8b9487b35ff37651a2eb3a8a3a0e69882200f68d6fbb6b6b6b6b6b6b6b6"
    }
  ],
  "properties": [
    {
      "name": "cdx:file_path",
      "value": "/lib/x86_64-linux-gnu/libc.so.6"
    }
  ],
  "evidence": {
    "identity": [
      {
        "field": "purl",
        "confidence": 0.8,
        "methods": [
          {
            "technique": "instrumentation",
            "confidence": 0.8,
            "value": "pkg:deb/debian/libc6@2.35-0ubuntu3?arch=amd64"
          }
        ]
      }
    ]
  }
}
```

## Step 3: Collect HTTP services from URL tracing

When you add `--trace-http-urls`, tracebom enables eBPF-based HTTP URL tracing via `@cdxgen/safer-exec`. It intercepts TLS write calls and captures the plaintext HTTP request URLs before encryption.

```bash
# Trace a server for 30 seconds and collect both libraries and services
tracebom --cmd "node server.js" --trace-http-urls --trace-period 30 -o bom.json
```

For long-running or persistent commands, use `--trace-period` (in seconds). The trace will automatically stop after the specified period, and all collected data is used to generate the BOM.

Collected HTTP URLs are grouped by host and enumerated as CycloneDX `services`:

```json
{
  "services": [
    {
      "name": "dynamic-api.example.com-443",
      "bomRef": "urn:service:dynamic:dynamic-api.example.com-443",
      "endpoints": [
        "https://api.example.com/v1/users",
        "https://api.example.com/v1/items"
      ],
      "properties": [
        { "name": "cdx:service:httpMethod", "value": "GET" },
        { "name": "cdx:service:httpMethod", "value": "POST" }
      ]
    }
  ]
}
```

### Additional sandbox controls

tracebom exposes many of `@cdxgen/safer-exec`'s sandbox controls as CLI flags for advanced use cases:

```bash
# Restrict CPU usage and strip sensitive env vars
tracebom --cmd "npm install" --max-cpu 0.5 --sanitize-env -o bom.json

# Strict mode + filesystem diffing (useful in CI/CD)
tracebom --cmd "npm install" --strict --diff --write-paths /tmp/cache -o bom.json

# Network allow-lists with port and host restrictions
tracebom --cmd "node server.js" --allow-host registry.npmjs.org --allow-port 443 -o bom.json

# Prevent forking and restrict which executables can run
tracebom --cmd "npm install" --block-fork --allow-exec node,npm --block-exec sh,bash -o bom.json
```

> **Note:** HTTP URL tracing requires Linux kernel >= 5.8 with eBPF support and sufficient capabilities (CAP_BPF, CAP_PERFMON). It gracefully falls back with an empty service list on other platforms.

## Step 4: Inspect the Instrumented components in `cdxi`

Launch the REPL:

```bash
cdxi bom.json
```

To list all dynamically instrumented components along with their paths, technique details, and confidence values, run:

```text
.instrumented
```

This prints a formatted table of all dynamically tracked libraries.
