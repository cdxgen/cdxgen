---
name: os-hardware-inventory
description: Collects live operating-system inventory (OBOM) and host hardware inventory (HBOM) as CycloneDX documents using the cdxgen obom and hbom commands, including osquery-backed runtime artifacts, apk packages on Alpine, Wolfi and Chainguard, Linux hardening snapshots, GTFOBins enrichment, firmware and bus topology, and macOS permission troubleshooting. Use when asked to inventory a live machine, audit a running host's packages or services, compare a host's packages with a container scan of the same image, produce a hardware BOM, or check host trust posture.
---

# Live OS and hardware inventory

Two distinct documents, two distinct commands. Do not mix them.

| Want                              | Command                          |
| --------------------------------- | -------------------------------- |
| Software on a running machine     | `obom` (`cdxgen -t os`)          |
| Physical hardware of the host     | `hbom`                           |
| Offline host from a mounted disk  | `-t rootfs` (see `container-sbom`) |

Read [reference/safety.md](../../reference/safety.md) first. Live host
collection reads far more of the machine than a project scan, so the
dry-run-and-confirm step matters more here, not less.

## The hard rule

Never combine `hbom` / `hardware` with software project types such as `js`,
`java`, `python`, `os`, or `oci` in one invocation. Generate them separately. If
the user wants one merged host document, use `hbom --include-runtime` rather
than stacking `-t` flags.

## OBOM: live operating-system inventory

```bash
obom -o /absolute/path/to/obom.json --deep
```

`obom` is an alias for `cdxgen -t os`. Aliases `osquery`, `windows`, `linux`,
`mac`, `macos`, `darwin` reach the same pipeline.

With a runtime audit:

```bash
obom -o /absolute/path/to/obom.json --deep \
  --bom-audit --bom-audit-categories obom-runtime
```

### What Linux OBOM adds

- osquery-derived runtime artifacts: processes, listening ports, users, services, scheduled jobs
- `sysctl_hardening` and `mount_hardening` snapshots
- packages of pacman (Arch and its derivatives), snap, flatpak and Homebrew on Linux, alongside deb and rpm
- AI agent skills installed for each user and system-wide (`ai_agent_skills`), and GPUs with their driver versions (`gpu_info`)
- GTFOBins enrichment on privileged and network-active runtime rows — a shell-escape-capable binary running privileged or listening on the network is the signal worth escalating

### Alpine, Wolfi and Chainguard hosts

osquery has no apk table, and the plugin bundle for musl systems such as
Alpine ships no osquery at all. On these hosts `obom` reads the apk installed
database instead (`/lib/apk/db/installed`, `/usr/lib/apk/db/installed` or
`/var/lib/apk/db/installed`).

- Expect the packages and little else: no runtime categories, no hardening
  snapshots, and no OS component in `metadata.component`. That is the reach of
  the tool on these hosts, not a failed run.
- Run it as a user that can read the database, usually root. If the database
  exists but cannot be read, the OBOM has no packages, and with `--introspect`
  the `os.apk-installed-db.unreadable` degradation says why. Report that rather
  than presenting an empty inventory as a clean host.

### macOS OBOM

Collection uses the bundled osquery binary in **shell mode**, which avoids the
older `/var/osquery` startup failure. Some tables still require Full Disk Access
or elevated privileges.

If tables come back empty or permission-gated, that is a host configuration
issue, not a cdxgen bug. Point the user at
<https://cdxgen.github.io/cdxgen/#/OBOM_MACOS_TROUBLESHOOTING> rather than
retrying the same command.

For live-host triage patterns generally, see
<https://cdxgen.github.io/cdxgen/#/OBOM_LESSONS>.

### Package identity

An OBOM names a package the way a container scan of the same system does, so
findings and vulnerability matches carry over between the two.

| Package          | Purl in an OBOM                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| deb              | `pkg:deb/ubuntu/php8.3-cli@8.3.6-0ubuntu0.24.04.13?arch=amd64&distro=ubuntu-24.04&distro_name=noble`; `&epoch=N` when the version has one |
| rpm              | `pkg:rpm/almalinux/openssl-libs@1:3.5.8-1.el9_8?arch=x86_64&distro=almalinux-9.8&epoch=1`; the version is `[epoch:]version-release` |
| apk              | `pkg:apk/alpine/php84@8.4.27-r0?arch=x86_64&distro=alpine-3.24.3&distro_name=alpine-3.24`                |
| pacman           | `pkg:alpm/arch/zlib@1:1.3.2-4?arch=x86_64`; the vendor and `arch` only, the version as pacman reports it  |
| Homebrew         | `pkg:brew/php@8.5.11_1`; a cask has the same form, and `cdx:homebrew:type` says `formula` or `cask`      |
| MacPorts         | `pkg:macports/openssl3@3.6.0_0`; the version is `version_revision`                                       |
| snap             | `pkg:snap/core22@20250408`; the revision, channel and confinement are `cdx:snap:*` properties            |
| flatpak          | `pkg:flatpak/org.gnome.Calculator@48.1?arch=x86_64&branch=stable`; named by the application ID           |
| npm and pypi     | `pkg:npm/%40npmcli/agent@4.0.2`, `pkg:pypi/pyyaml@6.0`                                                   |
| Firefox add-on   | `pkg:swid/uBlock%2BOrigin@1.75.0?tag_id=uBlock0%40raymondhill.net`; the `tag_id` is the add-on ID        |
| Chromium ext.    | `pkg:chrome-extension/nmmhkkegccagdldgiimedpiccmgmieda@1.0.0.6`; as `-t chrome-extension` names it       |
| VS Code ext.     | `pkg:vscode-extension/redhat/vscode-yaml@2.0.0`; as `-t vscode-extension` names it                       |

- None of these purls has a subpath. Where a package was found is evidence,
  not identity: it is in `evidence.occurrences` (and the `path` property), and
  a package installed in several places, such as under two Node.js versions,
  two browser profiles or two editors, is one component with an occurrence for
  each.
- `cdx:deb:source`, `cdx:rpm:sourceRpm`, `cdx:apk:origin` and `cdx:alpm:pkgbase`
  name the source package, which advisories are often keyed by.
- An AI agent skill from `ai_agent_skills` is a `file` component with no purl;
  its bom-ref is the SHA-256 of its SKILL.md, and each place it is installed is
  an occurrence.
- To compare a host with an image, run `obom` inside a container of the image
  and `cdxgen -t docker <image>`, then diff the package purls. Leave out the
  container scan's components tagged `source`; an OBOM has none:

  ```bash
  jq -r '.components[] | select((.tags // []) | index("source") | not) | (.purl // empty)
    | select(test("^pkg:(deb|rpm|apk)/"))' image.json | sort -u > image-purls.txt
  jq -r '.components[] | (.purl // empty) | select(test("^pkg:(deb|rpm|apk)/"))' host.json \
    | sort -u > host-purls.txt
  diff image-purls.txt host-purls.txt
  ```

- An OBOM from cdxgen 13.4.0 or earlier named these packages differently:
  subpaths such as `#var/lib/dpkg` or a browser profile path, no qualifiers,
  `pkg:swid` for Homebrew, and the publisher's display name as the namespace
  of a VS Code extension.
  Regenerate it before diffing it with a newer one. Never rewrite its purls by
  hand.

### OS trust inventory modelling

Understand the split before interpreting the output:

- **Repository sources** are ordinary `data` components.
- **Trusted keys and certificates** are `cryptographic-asset` components, and they **have no purls**. A missing purl here is correct, not a gap.

## HBOM: host hardware inventory

```bash
hbom -o /absolute/path/to/hbom.json
```

Hardware collection comes from the optional `@cdxgen/cdx-hbom` library, loaded
only when requested. Supported hosts:

- `darwin/arm64` (Apple Silicon macOS)
- `linux/amd64`
- `linux/arm64`
- `windows/amd64` and `windows/arm64` (`@cdxgen/cdx-hbom` 0.6.0 or later; uses the
  Windows PowerShell 5.1 that ships with Windows)

On an unsupported host, say so directly rather than producing an empty document
and calling it a success.

### Windows

Run `hbom` from a **local** session. `hbom` never elevates or prompts for UAC.

- A normal local user gets nearly the whole inventory.
- `--privileged` from an **Administrator** prompt adds TPM, BitLocker, the
  firmware-confirmed Secure Boot state, and disk reliability counters. From a
  normal prompt it still succeeds and records `permission-denied` diagnostics.
- A non-administrator over SSH or WinRM is denied every WMI query: only the
  processor and memory baseline comes back, with a
  `windows-cim-platform:network-logon` diagnostic. The fix is a local session or
  an administrator, not a retry.
- In secure mode the allowlist entry is `powershell.exe`, matched exactly and
  case-sensitively. No path allowlist is needed.

Details: <https://cdxgen.github.io/cdxgen/#/PERMISSIONS>

The equivalent library path is `cdxgen -t hbom .`, but prefer the dedicated
command.

### Merged hardware plus runtime host view

```bash
hbom --include-runtime -o /absolute/path/to/host-view.json
```

This is the supported way to get one document covering both. It also extends the
default audit categories to include `host-topology`.

### Diagnosing missing collectors

```bash
hbom diagnostics
```

Reports missing native utilities and permission-sensitive enrichments. Run this
first when an HBOM comes back sparse — the usual cause is an absent host
command, not a collection bug.

### Useful hbom flags

| Flag                      | Effect                                                     |
| ------------------------- | ---------------------------------------------------------- |
| `--include-runtime`       | Merge runtime host inventory into the hardware document    |
| `--privileged`            | Linux: `sudo -n` retries and `dmidecode`. Windows: the elevated-only TPM, BitLocker and reliability batch (needs an already-elevated session; never prompts). No effect on macOS |
| `--sensitive`             | Include sensitive identifiers (ask the user first)        |
| `--plist-enrichment`      | macOS property-list enrichment (ignored on Linux and Windows) |
| `--no-command-enrichment` | Skip optional host commands (Linux runs none; Windows still runs `windows-cim-platform`; macOS ignores it) |
| `--timeout`               | Bound collector runtime                                    |
| `--export-proto`          | Protobuf output via `--proto-bin-file`                     |
| `--dry-run`               | Preview collection without writing                         |

Treat `--sensitive` as a confirm-first flag. It widens what lands in a document
the user may share.

### HBOM audit behaviour

For `hbom` / `hardware` targets, cdxgen **skips the predictive dependency audit
entirely** and defaults the audit categories to
`hbom-security,hbom-performance,hbom-compliance`. With `--include-runtime` it
adds `host-topology`.

```bash
cdxgen -t hbom -o /absolute/path/to/hbom.json --bom-audit .
cdx-audit --bom /absolute/path/to/hbom.json --direct-bom-audit --categories hbom
```

`hbom` itself has no `--bom-audit` flag (it would be accepted and ignored), so
audit through `cdxgen -t hbom` or `cdx-audit`. The `hbom` alias expands to the
full HBOM review pack in one switch.

## Exploring the results

`cdxi` has dedicated commands for both document types (see `bom-explore`):

- OBOM: `.osinfocategories`, `.obomtips`, `.trusted`, `.instrumented`
- HBOM: `.hbomsummary`, `.hbomclasses`, `.hbomevidence`, `.hbomdiagnostics`, `.hbomfirmware`, `.hbombuses`, `.hbompower`, `.hbomtips`

Start with `.hbomsummary` or `.osinfocategories` before drilling into specifics.

## Reference

- HBOM guide: <https://cdxgen.github.io/cdxgen/#/HBOM>
- HBOM permissions (Linux, macOS, and the three Windows session types): <https://cdxgen.github.io/cdxgen/#/PERMISSIONS>
- macOS OBOM troubleshooting: <https://cdxgen.github.io/cdxgen/#/OBOM_MACOS_TROUBLESHOOTING>
- OBOM triage patterns: <https://cdxgen.github.io/cdxgen/#/OBOM_LESSONS>
- Audit rules: <https://cdxgen.github.io/cdxgen/#/BOM_AUDIT>
