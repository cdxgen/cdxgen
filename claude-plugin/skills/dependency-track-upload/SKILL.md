---
name: dependency-track-upload
description: Publishes CycloneDX BOMs to Dependency-Track or a TEA (Transparency Exchange API) server from cdxgen, and runs cdxgen in HTTP server mode to generate BOMs on demand for local paths, Git URLs, or package URLs. Use when asked to upload or submit an SBOM to Dependency-Track, register a project or parent-child project hierarchy, publish to a TEA collection, or run cdxgen as an SBOM service or API.
disable-model-invocation: true
---

# Publish BOMs and run cdxgen as a service

Two related capabilities: pushing a BOM to a platform, and exposing cdxgen over
HTTP.

Read [reference/safety.md](../../reference/safety.md) first. Both halves of this
skill touch the network and credentials, so the constraints below are not
optional.

## Confirm before uploading

Uploading a BOM **publishes it to an external system**. Before any submission:

1. Confirm the destination URL with the user.
2. Confirm the project name, version, and parent, since a wrong value creates or overwrites the wrong project.
3. Confirm the BOM contents are safe to send — a BOM may carry AI/MCP configuration, host inventory, or trust material. Review emitted properties first.

Never invent a server URL, project ID, or API key. If a value is missing, ask.

## Credentials

**Never ask the user to paste an API key into the conversation, and never write
one into a command line or a file.** Pass credentials through the environment
that cdxgen already reads, and let the user set it in their own shell:

```bash
cdxgen -o /absolute/path/to/bom.json \
  --server-url https://deptrack.example.com \
  --project-name my-app --project-version 1.2.3 \
  /absolute/path/to/project
```

with `CDXGEN_*`/`TEA_TOKEN`-style variables set by the user beforehand. The TEA
bearer token in particular is designed for this: it is sent only as an
`Authorization` header, never logged, and can come from `TEA_TOKEN`.

If a key does appear in your context anyway, do not echo it back.

## Dependency-Track submission

```bash
cdxgen -o /absolute/path/to/bom.json \
  --server-url https://deptrack.example.com \
  --project-name my-app \
  --project-version 1.2.3 \
  /absolute/path/to/project
```

| Flag                       | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `--server-url`             | Dependency-Track URL                                                 |
| `--api-key`                | API key (prefer the environment; see above)                          |
| `--project-name`           | Project name; defaults to the directory name                         |
| `--project-version`        | Project version                                                      |
| `--project-id`             | Project ID — supply this **or** name and version together            |
| `--project-tag`            | Project tag; repeatable                                              |
| `--project-group`          | Project group                                                        |
| `--parent-project-id`      | Parent project ID                                                    |
| `--parent-project-name`    | Parent project name                                                  |
| `--parent-project-version` | Parent project version                                               |
| `--auto-create`            | Let Dependency-Track create the project if absent                    |
| `--is-latest`              | Mark this version as latest                                          |
| `--skip-dt-tls-check`      | Skip TLS verification                                                |

Identify the project **either** by `--project-id` **or** by
`--project-name` plus `--project-version` together. Half of the latter pair is
not enough.

`--skip-dt-tls-check` disables certificate verification. Only suggest it for a
known-internal host with a self-signed certificate, and say what it turns off.

### Monorepo hierarchies

Use the parent flags to nest per-module projects under one parent, so
Dependency-Track shows the aggregate:

```bash
cdxgen -o /absolute/path/to/module-bom.json \
  --server-url https://deptrack.example.com \
  --parent-project-name my-platform --parent-project-version 2026.1 \
  --project-name my-platform-api --project-version 1.2.3 \
  /absolute/path/to/module
```

### Host allowlisting

Keep `CDXGEN_ALLOWED_HOSTS` narrow. Server-side Dependency-Track submission
interprets a wildcard entry such as `*.example.com` as **real subdomains only**,
never as a suffix match — so `*.example.com` will not match
`evil-example.com`, and it also will not match `example.com` itself. Prefer
exact hosts.

## TEA publishing

Publish the BOM as a TEA Artifact in a Collection (draft publisher API):

```bash
cdxgen -o /absolute/path/to/bom.json \
  --tea-publish https://tea.example.com \
  --tea-collection-name "my-app sbom" \
  --tea-author-name "Prabhu Subramanian" \
  --tea-author-email prabhu@appthreat.com \
  /absolute/path/to/project
```

| Flag                     | Purpose                                                    |
| ------------------------ | ---------------------------------------------------------- |
| `--tea-publish`          | TEA server URL                                             |
| `--tea-collection-name`  | Artifact name; defaults to `<project> sbom`                |
| `--tea-leaf-identifier`  | Leaf identifier                                            |
| `--tea-artifact-url`     | Artifact URL                                               |
| `--tea-author-name`, `--tea-author-email` | Attribution                               |
| `--tea-reason`           | Reason recorded with the publication                       |
| `--tea-token`            | Bearer token; prefer `TEA_TOKEN` in the environment        |
| `--tea-fetch`            | Fetch from a TEA server                                    |

This is a **draft** publisher API. Tell the user it may change.

## Server mode

```bash
cdxgen --server
cdxgen --server --server-host 0.0.0.0 --server-port 8080
```

Default bind is `127.0.0.1:9090`. Via the container image:

```bash
docker run --rm -v /tmp:/tmp -p 9090:9090 -v $(pwd):/app:rw \
  -t ghcr.io/cdxgen/cdxgen -r /app --server --server-host 0.0.0.0
```

`--server-host 0.0.0.0` exposes the service on every interface. Only suggest it
for a container or a host where that is intended, and say so — the default
loopback bind exists for a reason.

### Using the API

Poll `/health` first, then POST to `/sbom` with a JSON body or query
parameters. Arguments mirror the CLI: `path`, `url`, `type`, and the rest.

`url` accepts Git URLs (`https://...git`, `ssh://...`, `git@...`) and package
URLs (`pkg:npm/...`, `pkg:pypi/...`, `pkg:gem/...`, `pkg:cargo/...`,
`pkg:pub/...`, `pkg:github/...`, `pkg:bitbucket/...`, `pkg:maven/...` with a
version, `pkg:composer/...`, `pkg:generic/...` with `vcs_url` or
`download_url`).

Pass `GITHUB_TOKEN` via the environment when scanning private repositories.

API specification: `lib/server/openapi.yaml` in the repository, viewable in
Swagger Editor.

### Server mode is a remote code path

The server generates BOMs for paths and URLs it is given, which means it clones
repositories and may run package managers on request. Treat it as a privileged
service:

- keep it bound to loopback unless there is a reason not to
- keep `CDXGEN_ALLOWED_HOSTS` narrow
- do not expose it to untrusted callers

## Reference

- Server usage: <https://cdxgen.github.io/cdxgen/#/SERVER>
- Environment variables: <https://cdxgen.github.io/cdxgen/#/ENV>
- Allowed hosts and commands: <https://cdxgen.github.io/cdxgen/#/ALLOWED_HOSTS_AND_COMMANDS>
