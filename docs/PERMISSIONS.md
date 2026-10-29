# Node.js Permissions Model

cdxgen supports the Node.js permission [model](https://nodejs.org/api/permissions.html). We also offer a custom container image with the tag `ghcr.io/cdxgen/cdxgen-secure` that uses permissions by default.

## Secure mode vs dry-run mode

- **Secure mode** hardens how cdxgen runs and narrows the permissions it should receive.
- **Dry-run mode** (`cdxgen --dry-run` or `CDXGEN_DRY_RUN=true`) makes cdxgen read-only. It reads local files, blocks writes, child processes, temp directories, repository cloning, and remote submission, then prints an activity summary table for review. `--bom-audit` remains available, but only the in-memory formulation audit runs fully; the predictive dependency audit is reduced to target planning.
- You can combine the two when you want both hardened execution guidance and a read-only review workflow.

### npm lockfile paths outside the project

A `package-lock.json` or `npm-shrinkwrap.json` can name `file:` and `link:` paths, and link targets, that point outside the directory holding the lockfile. Legitimate lockfiles do this for sibling `file:` and `npm link` dependencies; a crafted one can use it to point at arbitrary directories and to put traversal strings such as `file:../../../tmp/x` into purls. cdxgen warns once per lockfile when it sees such entries. Outside secure mode they are kept, so the SBOM is unchanged; in secure mode they are omitted together with the dependency edges into them, and a `js.lockfile-unsafe-path` event is recorded for the introspection report.

## Benefits of Permissions Model

Permissions can be used to control what system resources cdxgen has access to or what actions it can take with those resources. In secure mode cdxgen turns off package installations by default. With installs off it also skips the scanned project's own build tooling, such as Maven, Gradle, sbt, Mill, Leiningen, `poetry export`, `dotnet msbuild`, SwiftPM and CocoaPods, and reads manifests and lock files instead. The `cdxgen-secure` command and the `ghcr.io/cdxgen/cdxgen-secure` image both run in secure mode, so neither needs `--no-install-deps`. The `cdxgen-secure` command keeps installs off even when `--install-deps` is passed; with `CDXGEN_SECURE_MODE=true`, only an explicit `--install-deps` on the command line, or `CDXGEN_INSTALL_DEPS=true`, turns them back on. A config file such as `.cdxgenrc` in the working directory cannot.

## Limitations of Permissions Model

Secure mode only restricts cdxgen from performing certain activities such as package installation. If installs are turned back on with `--install-deps`, an allowed build tool evaluates the scanned project's files (build scripts, `.mvn/` configuration, MSBuild response files, SwiftPM manifests) as it normally would. It does not provide security guarantees in the presence of malicious code.

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

Use the custom container image `ghcr.io/cdxgen/cdxgen-secure` which comes configured with `NODE_OPTIONS` environment variable.

```shell
docker run --rm -v /tmp:/tmp -v $(pwd):/app:rw -t ghcr.io/cdxgen/cdxgen-secure cdxgen -r /app -o /app/bom.json -t java
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

## HBOM permissions

**Run `hbom` as a normal local user.** That gives nearly the whole hardware inventory on every supported operating system. Elevation (administrator or root) adds a few security- and health-related details. `hbom` never asks for elevation itself: there is no `sudo` password prompt and no UAC prompt.

| Platform                  | Normal user, local session                                             | Administrator or root                                                                                                     | Non-administrator over SSH or WinRM                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS** (Apple Silicon) | Full inventory; every collector command runs as a normal user          | Nothing extra; `--privileged` has no effect                                                                               | Not measured; expected to match a local session                                                                                         |
| **Linux**                 | `/proc` and `/sys` baseline plus the optional tools that are installed | `--privileged` runs `dmidecode` and retries `drm_info` with non-interactive `sudo -n`                                     | Not measured; expected to match a local session                                                                                         |
| **Windows**               | Nearly everything; see below                                           | `--privileged` adds TPM details, BitLocker status, the firmware-confirmed Secure Boot state and disk reliability counters | Every WMI query is denied; only the baseline (processors and memory) is produced, with one `permission-denied` diagnostic that says why |

On Linux, `--privileged` may require root or passwordless `sudo` for those commands, depending on the host; a password is never requested.

### Windows session types

`hbom` reads Windows hardware through WMI/CIM with the built-in Windows PowerShell 5.1. What you get depends on the session you start it from:

| Session                                                                              | Result                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal user, local session (interactive desktop, scheduled task, CI service account) | System, firmware, board, chassis, processors, memory modules; disks and volumes; network adapters; graphics adapters and monitors, audio, cameras; USB, PCI and Bluetooth devices with driver versions and signing; virtualization-based security status; the Secure Boot registry setting; batteries |
| Administrator (**Run as administrator**), with `--privileged`                        | Everything above plus TPM version, manufacturer and state; BitLocker protection per volume; Secure Boot confirmed through `Confirm-SecureBootUEFI`; disk wear, temperature and power-on hours                                                                                                         |
| Non-administrator over SSH or WinRM                                                  | Baseline only: every WMI query is denied                                                                                                                                                                                                                                                              |

What a standard user gets instead of the details that need `--privileged` **and** administrator rights:

| Detail                                                           | Without administrator                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TPM version, manufacturer and state                              | The TPM's presence, name and driver are still reported from the PnP tree                                                                                                                                                                                                              |
| BitLocker protection status per volume                           | Volumes are listed without encryption status                                                                                                                                                                                                                                          |
| Secure Boot confirmed by the firmware                            | The Windows Secure Boot registry setting is still reported, with `cdx:hbom:secureBootSource` set to `registry`                                                                                                                                                                        |
| Disk wear, temperature and power-on hours                        | Disks are listed without them                                                                                                                                                                                                                                                         |
| Disk bus type, SSD or HDD, and health (no `--privileged` needed) | Windows returns these to a standard user only while the Microsoft Storage Spaces SMP service (`smphost`) is already running, and a standard user cannot start it. Otherwise disks are still listed from the basic disk inventory and the BOM carries one `partial-support` diagnostic |

With `--privileged` and no administrator rights, `hbom` records one `permission-denied` diagnostic per denied class plus one summary diagnostic (`windows-cim-privileged`), each saying "Re-run from an elevated (Run as administrator) prompt; cdx-hbom never requests elevation on Windows", and finishes normally. It does not fail, with or without `--strict`.

**Remote shells as a non-administrator.** Windows treats WMI calls from a network logon (OpenSSH, WinRM, PowerShell remoting) as remote calls, which by default only administrators may make. Every hardware query is denied, each denied namespace costs about five seconds before `hbom` stops querying it, and the BOM carries one diagnostic, `windows-cim-platform:network-logon`, with the hint "WMI denied for a network logon (SSH/WinRM) without administrator rights; run cdx-hbom from a local session or elevated". Your options:

- run `hbom` in a local session, for example as a scheduled task or a CI service;
- run it as an administrator;
- grant the account WMI "Remote Enable" (`0x20`) on `root/cimv2`, `root/wmi`, `root/StandardCimv2`, `root/Microsoft/Windows/Storage` and `root/Microsoft/Windows/DeviceGuard`. This was measured on Windows 11 ARM64 build 26200 with a standard user over OpenSSH: it gives a network logon the local standard-user inventory, except monitors (the `WmiMonitor*` classes still deny network logons) and disk bus, media and health. `root/cimv2` alone is not enough, and the TPM and BitLocker classes stay administrator-only whatever you grant. Granting it widens who can query WMI over the network, so it is the administrator's security decision; the click path is in [cdx-hbom's Windows troubleshooting](https://github.com/cdxgen/cdx-hbom/blob/v0.6.0/windows-troubleshooting.md#remote-shells-as-a-non-administrator).

**PowerShell restrictions.** If AppLocker, WDAC or Constrained Language Mode restricts PowerShell, `hbom` still runs and records the language mode in `cdx:hbom:evidence:languageMode`; non-ASCII device names may be degraded, and a `partial-support` diagnostic says so. If `powershell.exe` is blocked entirely, only the Node baseline (processors and memory) is produced and each batch records a `missing-command` or `command-error` diagnostic. Nothing is retried through another shell.

### What cdxgen adds

- `hbom diagnostics` (and `.hbomdiagnostics` in `cdxi`) lists the diagnostics above with a recovery hint that matches the BOM's platform.
- With `--bom-audit`, HBC-007 reports permission-denied enrichments, HBC-009 reports board and BIOS provenance lost to a network logon, HBC-001 reports an HBOM with no board or firmware provenance, and HBC-004 reports volumes without encryption evidence. Their advice names the Windows steps above.
- Serial numbers, UUIDs, MAC addresses and device instance serials are redacted by default as `redacted:<last 4>`. Host names, user names and domain names are never collected. Pass `--sensitive` only if you need raw identifiers.

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

On Windows (PowerShell):

```powershell
hbom --dry-run
$env:CDXGEN_SECURE_MODE = "true"
$env:CDXGEN_ALLOWED_COMMANDS = "powershell.exe"
hbom -o hbom.json
```

Notes:

- The exact command set is platform-specific.
- For Linux `hbom --privileged` runs with `@cdxgen/cdx-hbom`, allowlist `sudo` as well when you want the collector's explicit non-interactive retry path to remain available for permission-sensitive commands.
- Linux hosts often need `CDXGEN_ALLOWED_PATHS` entries such as `/proc`, `/sys`, and `/etc` because the collector reads hardware metadata directly from those trees.
- On Windows every batch is one `powershell.exe` process and the collector reads no files, so the command allowlist entry `powershell.exe` is all that is needed. `hbom --dry-run` lists the batches by command id and script digest; the full scripts are in `getCommandPlan({ platform: "win32" })` from `@cdxgen/cdx-hbom`. Allowing `powershell.exe` is coarse because it admits any PowerShell invocation, but the scripts are static, readable and read-only, and no elevation path exists.
- Allowlist entries match the exact command or its file name, case-sensitively, because `@cdxgen/cdx-hbom` applies `CDXGEN_ALLOWED_COMMANDS` again when it starts a process. Use `powershell.exe`, or the full path exactly as the preflight message prints it.
- `--no-command-enrichment` does not remove the check on Windows and macOS: Windows always runs `windows-cim-platform` and the Darwin collector ignores the option. Only a Linux run without `--privileged` runs no commands at all.
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
    at file:///workspace/cdxgen/lib/managers/docker.js:51:7
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
