---
name: runtime-trace-bom
description: Produces a dynamic CycloneDX BOM by executing a command under the cdxgen safer-exec sandbox with tracebom on Linux, macOS, or Windows, tracing shared-library and DLL loads, eBPF HTTP URL access, egress hosts, cryptographic library and cipher-suite usage, child process execution, and filesystem mutations. Use when asked what a program actually loads or calls at runtime, for a dynamic or runtime SBOM, to observe a binary's real behaviour, or to trace network and crypto usage of a process.
---

# Runtime-traced BOM

`tracebom` runs a command under the `@cdxgen/safer-exec` sandbox and records
what it actually does: which shared libraries it `dlopen`s, which HTTP URLs it
reaches, which crypto primitives it exercises, which children it spawns, and
which files it mutates. The output is a CycloneDX BOM with library components
and enumerated services.

It runs on Linux, macOS, and Windows 11. On Windows, recording DLL loads needs
an elevated prompt; without one the BOM has no library components but still
gets egress services and TLS assets through `--proxy-egress`. See the Windows
section of the tracebom reference for the full list.

This is observation of real execution, not static inference. It complements
`sbom-generate` rather than replacing it: a trace shows only what the traced run
exercised, so it under-reports by design.

Read [reference/safety.md](../../reference/safety.md) first.

## Confirm before executing

`tracebom` **executes the user's command**. Treat every invocation as a
confirm-first action:

1. Show the user the exact `--cmd` you intend to run and the sandbox limits.
2. Confirm the command is one they want executed now.
3. Never trace a command whose source you have not seen, and never trace something the user has described as untrusted without saying plainly what the sandbox does and does not contain.

The sandbox restricts filesystem, network, and process behaviour. It is a
containment boundary, not a guarantee against malicious code.

## Basic use

```bash
tracebom --cmd "node app.js" -o /absolute/path/to/bom.json
```

Aliases as a project type: `-t dynamic` / `-t trace`.

Evidence recorded on traced components uses
`technique=instrumentation`, `scope=required`, confidence `0.8`/`0.5`, plus
hashes and OS package attribution. A library that a deb, rpm, apk or Homebrew
package owns gets that package's purl, the same one an OBOM or a container scan
gives the package.

## Sandbox limits

| Flag                  | Default        | Purpose                                        |
| --------------------- | -------------- | ---------------------------------------------- |
| `-d, --working-dir`   | cwd            | Working directory for the traced process       |
| `--timeout`           | `60000` ms     | Trace timeout                                  |
| `--trace-period`      | —              | Stop tracing after N seconds                   |
| `--max-memory`        | `512` MB       | Memory ceiling                                 |
| `--max-cpu`           | —              | CPU cores, fractional (`0.5` = half a core)    |
| `--max-processes`     | `64`           | Process count ceiling                          |
| `--strict`            | `false`        | Treat sandbox setup warnings as hard errors    |

Use `--trace-period` for long-running or persistent commands — a server will
otherwise run until `--timeout`. Use `--strict` in CI so a degraded sandbox
fails loudly instead of silently tracing less.

## Filesystem access

| Flag              | Default      | Purpose                                          |
| ----------------- | ------------ | ------------------------------------------------ |
| `--read-paths`    | —            | Extra read paths, comma-separated                |
| `--write-paths`   | OS tmpdir    | Sandbox write paths                              |
| `--allow-hidden`  | `true`       | Allow hidden files and directories               |
| `--diff`          | `false`      | Track files created, modified, or deleted        |

`--diff` is the flag to reach for when the user's question is "what did this
installer/build script change?"

## Network

| Flag                | Default  | Purpose                                                        |
| ------------------- | -------- | -------------------------------------------------------------- |
| `--disable-network` | `true`   | Network off inside the sandbox                                 |
| `--trace-http-urls` | `false`  | eBPF HTTP URL tracing; **automatically enables network**       |
| `--allow-host`      | —        | Hostnames the process may reach                                |
| `--allow-port`      | —        | TCP ports allowed                                              |
| `--allow-url`       | —        | Fine-grained URL allow rules                                   |
| `--allow-listen`    | —        | IPs or `ip:port` the process may bind                          |
| `--proxy-egress`    | `false`  | Hostname-pinning egress proxy; **enables network** (all OSes)  |

Network is **off by default**, and `--trace-http-urls` turns it on. Say that out
loud when enabling it — the user is choosing to let the traced process reach the
network.

```bash
tracebom --cmd "node app.js" \
  --trace-http-urls \
  --allow-host api.example.com --allow-port 443 \
  -o /absolute/path/to/bom.json
```

Keep the allowlist narrow, consistent with the host-allowlist rule in
[reference/safety.md](../../reference/safety.md).

**Platform constraint:** eBPF HTTP URL tracing is Linux-only, needs kernel
>= 5.8, and requires `CAP_BPF`. On macOS or Windows it will not work — do not
present its absence as a cdxgen failure. Offer `--proxy-egress` with
`--allow-host` instead: it records every allowed and denied host as a service
on every platform, without paths.

## Crypto tracing

| Flag                  | Default     | Purpose                                                       |
| --------------------- | ----------- | ------------------------------------------------------------- |
| `--trace-crypto`      | `true`      | Crypto libraries, cipher suites, and TLS key-exchange groups  |
| `--crypto-probe-mode` | `tls-only`  | `tls-only`, or `operations` for digest, encrypt, sign         |

```bash
tracebom --cmd "node app.js" \
  --trace-crypto --crypto-probe-mode operations \
  -o /absolute/path/to/bom.json
```

eBPF crypto tracing and `operations` are Linux-only with kernel >= 5.8. On
every platform, `--proxy-egress` adds the TLS version, cipher suite, and
key-exchange group of each connection (post-quantum hybrids appear as their
`ml-kem-*` half), and on Windows an elevated run adds the crypto DLLs with their
versions. Use `operations` when the user wants observed cryptographic operations
rather than just negotiated TLS; pair it with `crypto-bom` for the static side
of the same question.

## Process execution

| Flag            | Default  | Purpose                                          |
| --------------- | -------- | ------------------------------------------------ |
| `--trace-exec`  | `false`  | Log every child process spawned                  |
| `--allow-exec`  | —        | Executables the command may run                  |
| `--block-exec`  | —        | Executables to block                             |
| `--block-fork`  | `false`  | Prevent forking new processes                    |
| `--allow-envs`  | —        | Host env vars allowed through the sandbox        |

`--trace-exec` is valuable for build scripts and postinstall hooks, where the
interesting behaviour is what gets spawned.

`--allow-envs` passes host environment variables into the sandbox. **Do not pass
credential-bearing variables** unless the user explicitly asks and understands
they will be available to the traced process.

## Output

| Flag                | Default      |
| ------------------- | ------------ |
| `-o, --output`      | `bom.json`   |
| `--spec-version`    | `1.7`        |
| `--project-name`    | —            |
| `--project-version` | —            |
| `--print`           | `false`      |

## Interpreting a trace

- A trace records **one execution path**. A library not loaded during the trace may still be loaded on a different input. Never present a trace as a complete dependency inventory.
- Conversely, everything in a trace was genuinely loaded — that is stronger evidence than a manifest entry.
- Compare a trace against a static SBOM to find declared-but-unloaded dependencies. Combine with `bom-evidence` for reachability before concluding a dependency is unused.
- In `cdxi`, `.instrumented` isolates the trace-derived components.

## Reference

- tracebom: <https://cdxgen.github.io/cdxgen/#/TRACEBOM>
- Project types: <https://cdxgen.github.io/cdxgen/#/PROJECT_TYPES>
