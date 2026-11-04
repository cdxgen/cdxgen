# Threat model

This file guides Anthropic's OSS Scanner. The full threat model is in `docs/THREAT_MODEL.md` and the disclosure policy, including what we treat as out of scope, is in `SECURITY.md`. Where this file and those disagree, `SECURITY.md` wins.

## What this project does and where untrusted input enters

cdxgen generates CycloneDX documents (SBOM, CBOM, OBOM, SaaSBOM, AI-BOM and others) from source trees, container images, archives, binaries and live hosts. It ships as the `@cdxgen/cdxgen` npm package, container images and single-file binaries. It runs as a CLI (`bin/cdxgen.js`), a library (`lib/cli/index.js`), an HTTP server (`cdxgen --server`, `lib/server/server.js`) and a family of companion commands: `cdx-audit`, `cdx-convert`, `cdx-validate`, `cdx-sign`, `cdx-verify`, `evinse`, `cdxi`, `hbom` and `tracebom`. People run it in CI and in hosted services against code they did not write, so treat everything it is pointed at as hostile.

Untrusted input:

- The project being scanned. That means manifests, lockfiles, build files and configs for more than 30 ecosystems (`lib/ecosystems/`, `lib/parsers/`, `lib/inventory/`), and also the names of files and directories in the tree, which flow into paths, purls and the arguments of commands cdxgen runs.
- Archives and images: Docker and OCI image archives and their layers (`lib/managers/docker.js`, `lib/managers/oci.js`, `lib/managers/binary.js`), jars and wars, wheels, nupkgs, VSIX and Chrome extensions, Electron ASAR archives (`lib/ecosystems/asarutils.js`), caxa executables (`lib/ecosystems/caxa.js`), and model files such as GGUF, ONNX and safetensors (`lib/parsers/`).
- Network responses: registry metadata from npm, PyPI, Maven Central, crates.io, the Go proxy, NuGet, Hugging Face and others, fetched through `cdxgenAgent` (`lib/core/httpClient.js`, `lib/inventory/fetchBatch.js`), and git repositories cloned for remote scans and by `cdx-audit`.
- Requests to the HTTP server. Every query and body field of `/sbom` is attacker controlled, including `path`, git URLs, purls and the scan options.
- BOM documents read back by `cdx-verify`, `cdx-validate`, `cdx-convert`, `cdx-audit`, `cdxi` and `evinse`, including every field of their signature blocks.
- The output of helper binaries (trivy, osquery, golem and others from `cdxgen-plugins-bin`, and atom) produced from scanned content.

Trusted input: CLI flags, environment variables and config files set by the operator, including glob and regex options such as `--exclude` and `--include-regex`. The operator owns the machine cdxgen runs on.

## What cdxgen must guarantee

In its default mode cdxgen runs the project's own build tools (npm, pnpm, Maven, Gradle, pip, Go, Cargo, dotnet and others) to resolve dependencies, and those tools can run code from the project through install scripts, plugins or `setup.py`. That is documented behaviour and not a vulnerability. The guarantees we make are narrower, and breaking any of them is in scope.

Commands go through `safeSpawnSync` (`lib/core/fs.js`) as argument arrays. Scanned content must never choose the command, add options or flags the operator did not ask for, or reach a shell. GHSA-5vwr-qchf-q4pf was a directory name with shell metacharacters reaching Maven through `shell: true`. Look for other places where project-controlled names, versions, URLs or paths become arguments, especially arguments that start with `-`.

Secure mode (`CDXGEN_SECURE_MODE=true`, or Node.js `--permission`) turns off package installation and enforces `CDXGEN_ALLOWED_COMMANDS`, `CDXGEN_ALLOWED_HOSTS`, `CDXGEN_ALLOWED_PATHS`, HTTPS only and no redirects. Getting past any of these from scanned content or a server request is in scope, and so is getting a build tool to run project code while secure mode is on.

Archive and image extraction stays inside the temporary directory cdxgen created for it. Reading or writing outside it through `..`, absolute paths, symlinks, hard links or device entries is in scope.

In server mode, `isAllowedPath`, `isAllowedWinPath`, `validateAndRejectGitSource`, `hardenedGitCommand` and the host allowlists in `lib/inventory/source.js` are the boundary. Escaping a configured path or host allowlist, cloning over a disallowed protocol, or running hooks or config from a cloned repository is in scope. The server has no authentication by design, and when `CDXGEN_SERVER_ALLOWED_PATHS` is unset any local path can be scanned. Neither of those is a finding.

Credentials such as registry tokens, the Dependency-Track API key, Docker registry auth and the values of secret-like environment variables must not end up in BOMs, in normal logs, or in requests to a host they were not configured for. GHSA-qhh4-458h-xwh2 was a substring host match that forwarded Docker registry credentials to a different registry.

`cdx-verify`, `cdx-validate --require-signature`, `verifyBom` and `verifyNode` (`lib/helpers/bomSigner.js`) must reject any BOM that the key holder did not sign or that was changed after signing. GHSA-7m2v-pj5r-fjww was an algorithm confusion that let anyone holding the public key forge an HMAC signature.

BOM properties, annotations and evidence must not copy secrets or secret-bearing values from scanned content: URLs with userinfo or signed query strings, full command lines, environment values. The shared sanitizers are in `lib/core/propertySanitizer.js`.

## Components that matter most / least

Most important:

- `lib/core/fs.js` (`safeSpawnSync`, `safeExtractArchive` and the other safe wrappers), `lib/core/activity.js` (secure mode, `hasDangerousUnicode`) and `lib/core/httpClient.js`.
- `lib/inventory/source.js` and `lib/server/server.js`.
- Command construction in the BOM builders under `lib/cli/` (`jvmBom.js`, `jsBom.js`, `managedBom.js`, `nativeBom.js`, `index.js`), together with `lib/ecosystems/gradleutils.js`, `lib/managers/piptree.js` and `lib/stages/pregen/pregen.js`, which installs toolchains.
- Archive and image handling: `lib/managers/docker.js`, `lib/managers/oci.js`, `lib/managers/binary.js`, `lib/managers/containerutils.js`, `lib/inventory/deps.js`, `lib/ecosystems/ecosystems.js`, `lib/ecosystems/asarutils.js`, `lib/ecosystems/caxa.js`, `lib/ecosystems/chromextutils.js` and `lib/helpers/vsixutils.js`.
- Signing and verification: `lib/helpers/bomSigner.js`, `bin/sign.js`, `bin/verify.js`.
- Binary parsers that size buffers or loops from header fields, such as `lib/parsers/gguf.js`, `lib/parsers/onnx.js` and `lib/parsers/safetensors.js`.
- `lib/stages/pregen/envAudit.js`, which inspects `NODE_OPTIONS` and similar variables at startup.

Everything else under `lib/` and `bin/` is in scope too, including `lib/audit/`, which clones and scores third-party packages, and `lib/helpers/remote/dependency-track.js`, which uploads BOMs with an API key.

Lower priority: `lib/third-party/arborist/` is a fork of npm's arborist and matters only where cdxgen's changes or usage cause the problem. Out of scope: `contrib/`, `ci/`, `docs/`, `test/`, the generated `types/`, and `.github/`. Bugs inside external tools and helper binaries (npm, Maven, trivy, osquery, atom, golem) belong to those projects, although how cdxgen invokes them and parses their output is ours.

## How you rate severity

- **critical**: code execution in the cdxgen process, or a command of the attacker's choosing run by cdxgen, triggered by scanned content, a registry or git response, or a server request, without relying on a build tool's documented ability to run project code. Credentials sent to a host the attacker controls.
- **high**: argument or option injection into a command cdxgen runs. Reading or writing files outside the scanned tree or cdxgen's temporary directory. Escaping a configured server path or host allowlist. Bypassing a secure-mode control. Defeating the git clone hardening. Signature verification accepting a forged or altered BOM. Credentials written into a BOM.
- **medium**: secrets or secret-bearing values from scanned content copied into BOM output or normal logs. Requests to a host outside a configured `CDXGEN_ALLOWED_HOSTS`. Algorithmic denial of service (ReDoS, exponential parsing) or huge allocations from small untrusted input. Prototype pollution with no impact shown beyond the current process.
- **low**: a crash or hang on malformed input that ends with the process and leaves nothing behind.

These are not vulnerabilities:

- Code run by a build tool that cdxgen invokes in default mode. In secure mode it is in scope, as above.
- A BOM that is incomplete or wrong because the scanned content lies about itself, unless the lie defeats a check cdxgen presents as a security control, such as signature verification.
- Anything that needs control of the operator's CLI flags, environment variables or config, including ReDoS through operator-supplied patterns.
- Details printed only with `CDXGEN_DEBUG_MODE`, `CDXGEN_TRACE_MODE` or `CDXGEN_THINK_MODE`.
- Time and memory that grow with the size of a large project.
- CVEs in dependencies with no reachable path in cdxgen.

A report should include the input that triggers the issue or a script that builds it, the exact command or request, and the commit.

## How to exercise it

The checkout is built at `/src` and the package's commands are on `PATH`: `cdxgen`, `cdx-audit`, `cdx-convert`, `cdx-validate`, `cdx-sign`, `cdx-verify`, `cdxi`, `evinse`, `hbom`, `tracebom` and the mode aliases such as `obom`. For example, `cdxgen -t js -o /tmp/bom.json /src/test/data/package-json/legacy-licenses`. Image archives produced by `docker save` can be scanned with `cdxgen -t docker -o /tmp/bom.json /path/to/image.tar`.

The image has Node.js 26, pnpm, Python 3 and git. It has no JDK, Maven, Gradle, Go, .NET or Cargo, and there is no network. To see the commands cdxgen would run against a crafted project, put a stub with the tool's name first on `PATH` that logs its arguments, or run with `--dry-run`, which blocks command execution and writes and prints a table of the commands, paths and hosts cdxgen would have touched. `CDXGEN_DEBUG_MODE=debug` logs commands as they run. Registry lookups fail offline and cdxgen falls back to local data. To serve crafted registry responses, run a local HTTP server and point cdxgen at it with the override variables in `docs/ENV.md`, such as `NPM_URL`.

Secure mode is `CDXGEN_SECURE_MODE=true` plus the allowlist variables, and the Node.js permission model is set through `NODE_OPTIONS` as shown in `docs/PERMISSIONS.md`. The server starts with `cdxgen --server --server-host 127.0.0.1 --server-port 9090` and answers `curl 'http://127.0.0.1:9090/sbom?path=/src/test/data&type=js'`. The request options are described in `docs/SERVER.md` and `lib/server/openapi.yaml`.

`pnpm test` runs every poku suite in under a minute. A single suite runs with `node lib/core/fs.poku.js`. Fixtures, many of them crafted edge cases, live under `test/`. Two suites need network access and fail here for that reason alone: `lib/ecosystems/ecosystems.poku.js` and `lib/inventory/licenseFetchJourney.repo.poku.js`. Any other failure is worth a look.

## Anything to leave alone

Findings in `lib/third-party/arborist/` that also exist in upstream npm arborist should go to npm. Warnings that `auditEnvironment` prints about the scanner's own environment (running as root, debug variables) are expected here.
