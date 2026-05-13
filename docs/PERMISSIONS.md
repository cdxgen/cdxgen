# Node.js Permissions Model

cdxgen supports the Node.js permission [model](https://nodejs.org/api/permissions.html). We also offer a custom container image with the tag `ghcr.io/cyclonedx/cdxgen-secure` that uses permissions by default.

## Secure mode vs dry-run mode

- **Secure mode** hardens how cdxgen runs and narrows the permissions it should receive.
- **Dry-run mode** (`cdxgen --dry-run` or `CDXGEN_DRY_RUN=true`) makes cdxgen read-only. It reads local files, blocks writes, child processes, temp directories, repository cloning, and remote submission, then prints an activity summary table for review. `--bom-audit` remains available, but only the in-memory formulation audit runs fully; the predictive dependency audit is reduced to target planning.
- You can combine the two when you want both hardened execution guidance and a read-only review workflow.

## Benefits of Permissions Model

Permissions can be used to control what system resources cdxgen has access to or what actions it can take with those resources. cdxgen would disable automatic package installations when run in secure mode by default.

## Limitations of Permissions Model

Secure mode only restricts cdxgen from performing certain activities such as package installation. It does not provide security guarantees in the presence of malicious code.

## Required permissions

| Argument              | Comment                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| --allow-fs-read       | Read permission to the application, tools, and temp directory             |
| --allow-fs-write      | Write permission to the output and temp directory                         |
| --allow-child-process | For some languages, ChildProcess permission is required to spawn commands |

Dry-run mode reduces these requirements because cdxgen does not need write or child-process permissions for its blocked operations.

## Limitations of dry-run mode

- Dry-run traces intent, decisions, classified reads, archive extraction attempts, child-process I/O volume, and followed symlink resolutions when available, but it still avoids side effects by design.
- Predictive dependency audit targets can be planned in dry-run mode, but upstream registry metadata fetches, repository cloning, and child SBOM generation remain blocked.
- Findings that depend on generated child SBOMs or upstream source inspection are therefore incomplete in dry-run mode.
- Secret-bearing environment-variable and file classification is heuristic. cdxgen records presence, counts, and categories conservatively, but unusual credential naming conventions may not be recognized automatically.
- Secret-bearing values are never emitted in the activity summary; cdxgen records only redacted presence, count, and category metadata.
- In secure mode, CLI submission paths such as `--server-url` also honor `CDXGEN_ALLOWED_HOSTS`; disallowed Dependency-Track hosts are rejected before submission.
- In secure mode, HBOM live collection reuses the HBOM dry-run plan as a preflight check: when `CDXGEN_ALLOWED_COMMANDS` and/or `CDXGEN_ALLOWED_PATHS` are configured, cdxgen aborts the live host run before continuing if the declared HBOM commands or filesystem paths fall outside those allowlists.

Example invocations:

```shell
export NODE_OPTIONS='--permission --allow-fs-read="/home/almalinux/work*" --allow-fs-write="/tmp/*" --allow-child-process'
node bin/cdxgen.js -o /tmp/bom.json /home/almalinux/work/sandbox/vuln-spring -t java
```

The above command is too simple. For example, below is a command I use on my macOS machine. When sdkman, nvm, etc. are used, more `--allow-fs-read` arguments are required. Use "\*" to get things working.

```shell
export NODE_OPTIONS='--permission --allow-fs-read=\* --allow-fs-write="/tmp/*" --allow-fs-write="/Volumes/Work/sandbox/pnpm 2/*.json" --allow-fs-write="/var/folders/h5/43_6kqvs4w7cclqtdbpj_7g80000gn/T/*" --allow-child-process --allow-addons'
node /Volumes/Work/CycloneDX/cdxgen/bin/cdxgen.js --evidence -o bom.json -t js "$(pwd)"
```

Use the custom container image `ghcr.io/cyclonedx/cdxgen-secure` which comes configured with `NODE_OPTIONS` environment variable.

```shell
docker run --rm -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cyclonedx/cdxgen-secure cdxgen -r /app -o /app/bom.json -t java
```

### Identifying NODE_OPTIONS

Run cdxgen with the environment variable `CDXGEN_SECURE_MODE=true` to obtain a suggested value for the `NODE_OPTIONS` environment variable.

Example:

```text
cdxgen -t pnpm --no-recurse -o bom.json $(pwd) --exclude "**/__fixtures__/**" --lifecycle pre-build

Secure mode requires permission-related arguments. These can be passed as CLI arguments directly to the node runtime or set the NODE_OPTIONS environment variable as shown below.
export NODE_OPTIONS='--permission --allow-fs-read="/var/folders/h5/43_6kqvs4w7cclqtdbpj_7g80000gn/T/*" --allow-fs-write="/var/folders/h5/43_6kqvs4w7cclqtdbpj_7g80000gn/T/*" --allow-fs-read="/Volumes/Work/sandbox/pnpm/*" --allow-fs-write="/Volumes/Work/sandbox/pnpm/bom.json"'
```

## Controlling the permissions for external commands

Use the environment variable `CDXGEN_NODE_OPTIONS` to control the permissions for the external node-based commands such as npm, atom, and yarn etc.

```shell
export CDXGEN_NODE_OPTIONS="--permission --allow-fs-read<more restricted directories> --allow-fs-write=/foo/usages.slices.json"
```

## HBOM secure-mode preflight

HBOM is slightly different from language package managers because the optional `@cdxgen/cdx-hbom` collector declares its planned commands and local file reads during dry-run mode.

Recommended workflow:

```shell
hbom --dry-run
export CDXGEN_SECURE_MODE=true
export CDXGEN_ALLOWED_COMMANDS="sysctl,system_profiler,networksetup,pmset"
export CDXGEN_ALLOWED_PATHS="/proc,/sys,/etc"
hbom -o hbom.json
```

Notes:

- The exact command set is platform-specific.
- For Linux `hbom --privileged` runs with `@cdxgen/cdx-hbom`, allowlist `sudo` as well when you want the collector's explicit non-interactive retry path to remain available for permission-sensitive commands.
- Linux hosts often need `CDXGEN_ALLOWED_PATHS` entries such as `/proc`, `/sys`, and `/etc` because the collector reads hardware metadata directly from those trees.
- If the secure-mode preflight reports a disallowed command or path, rerun with `--dry-run`, review the declaration, and only expand the allowlist if the additional host surface is acceptable for that environment.

## GitHub Action Workflow sample

Our repotests include a working configuration to enable secure mode in GitHub Action Workflows. Below is a snippet.

```yaml
- name: repotests
  run: |
    bin/cdxgen.js -p -t java ${GITHUB_WORKSPACE}/repotests/java-sec-code -o ${GITHUB_WORKSPACE}/bomresults/bom-java-sec-code-1.json --fail-on-error
    bin/cdxgen.js -p -r -t quarkus ${GITHUB_WORKSPACE}/repotests/quarkus-quickstarts -o ${GITHUB_WORKSPACE}/bomresults/bom-quarkus-quickstarts-quarkus.json --no-recurse --fail-on-error
    bin/cdxgen.js -p -t js -o ${GITHUB_WORKSPACE}/bomresults/bom-iot.json ${GITHUB_WORKSPACE}/repotests/iot-device-simulator --fail-on-error
  shell: bash
  env:
    NODE_OPTIONS: "--permission --allow-fs-read=/home/runner/* --allow-fs-read=/tmp/* --allow-fs-read=/run/user/1001/* --allow-fs-read=/opt/hostedtoolcache/* --allow-fs-write=/tmp/* --allow-fs-read=/Users/runner/* --allow-fs-read=${{ github.workspace }}/* --allow-fs-write=${{ github.workspace }}/bomresults/*.json --allow-fs-read=${{ runner.temp }}/* --allow-fs-write=${{ runner.temp }}/* --allow-child-process --trace-warnings"
    CDXGEN_TEMP_DIR: ${{ runner.temp }}/cdxgen-repotests
```

NOTE the following:

- Use of absolute path in the arguments.
- Numerous `--allow-fs-read` arguments to the various directories in the build agent.
- Limited use of `--allow-fs-write` to only the output and temp directories

Depending on your project and the build agent configuration, additional directories might be needed. The use of `--trace-warnings` in NODE_OPTIONS would help identify these directories.

Example:

```text
Error: Access to this API has been restricted
    at existsSync (node:fs:293:18)
    at file:///home/runner/work/cdxgen/cdxgen/lib/managers/docker.js:51:7
    at ModuleJob.run (node:internal/modules/esm/module_job:272:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:580:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:98:5) {
  code: 'ERR_ACCESS_DENIED',
  permission: 'FileSystemRead',
  resource: '/run/user/1001/containerd-rootless/api.sock'
}

Node.js v23.6.1
```

To resolve this, pass the argument `--allow-fs-read=/run/user/1001/*`. Start with using wildcard characters and over time make them very specific based on your workflows. Please share a final workflow if you get it working without any wildcards.

## Warning messages

Warning message like the one below could be ignored, if the particular language requires executing external commands.

```
SecurityWarning: The flag --allow-child-process must be used with extreme caution. It could invalidate the permission model.
```
