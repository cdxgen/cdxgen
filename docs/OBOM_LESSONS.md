# OBOM Lessons for SOC/IR and Compliance Teams

This guide focuses on **Operations Bill of Materials (OBOM)** workflows for:

- SOC analysts triaging suspicious host behavior
- Incident responders building host-level evidence timelines
- Compliance teams validating SOC2/GDPR control evidence

## 1) Build an OBOM with runtime and policy context

```bash
obom -o obom.json --deep --bom-audit --bom-audit-categories obom-runtime
```

Use this as your default host collection profile when you need:

- process/network/service/startup visibility
- endpoint control posture (firewall, encryption, security products)
- immediate high/critical runtime findings from built-in OBOM rules
- Windows LOLBAS / ATT&CK-enriched context for run keys, tasks, WMI, services, and live processes
- Linux GTFOBins-enriched context for sudo, privilege-transition, elevated-process, reverse-shell, and privileged-listener telemetry
- Linux hardening drift checks based on `sysctl_hardening` and `mount_hardening` query-pack entries
- platform trust evidence such as macOS code-sign/notarization state and Windows Authenticode / WDAC policy inventory

## 2) SOC triage lesson: rapid suspicious persistence sweep

### Why

Most early compromise persistence techniques show up in host startup surfaces.

### What to review first

- Linux: `systemd_units`, `sudoers_snapshot`, `authorized_keys_snapshot`, `elevated_processes`, `sudo_executions`, `privilege_transitions`, `privileged_listening_ports`, `behavioral_reverse_shell`, `ld_preload`, `crontab_snapshot`, `sysctl_hardening`, `mount_hardening`, `secureboot_certificates`
- Windows: `windows_run_keys`, `scheduled_tasks`, `services_snapshot`, `startup_items`, `appcompat_shims`, WMI tables, `processes`, `listening_ports`, `process_open_handles_snapshot`, plus Authenticode and WDAC trust properties on discovered binaries/components
- macOS: `launchd_services`, `launchd_overrides`, `alf_exceptions`, `gatekeeper`, `apps`, `npm_packages`, plus code-signing and notarization properties on discovered apps/components

### REPL quick flow

```bash
cdxi obom.json
.osinfocategories
.scheduled_tasks
.windows_run_keys
.launchd_services
.gatekeeper
.elevated_processes
.sudo_executions
.privileged_listening_ports
```

For container or rootfs BOMs, follow with `.unpackagedbins` and `.unpackagedlibs` when you want to isolate native files that were not traced to OS package ownership.

## 3) IR lesson: build a “possible initial access” shortlist

Focus on runtime records that often correlate with intrusion playbooks:

- shells/processes with network sockets (`process_open_sockets`, `listening_ports`)
- privileged listeners and admin surfaces (`privileged_listening_ports`, `elevated_processes`)
- interactive privilege changes (`sudo_executions`, `privilege_transitions`)
- suspicious startup references to temp/user-writable paths
- encoded script launches (`-enc`) and script interpreters from startup keys/tasks
- Windows LOLBAS helpers such as `powershell.exe`, `certutil.exe`, `regsvr32.exe`, `rundll32.exe`, `mshta.exe`, and `cmstp.exe`

Then map findings to:

- process lineage in `processes` + `process_events`
- user/session inventory (`users_snapshot`, `logged_in_users_snapshot`, `logon_sessions`)

## 4) Compliance lesson: evidence mapping for SOC2/GDPR controls

Use OBOM sections as auditable evidence artifacts:

- **Access control / privileged operations**: `sudoers_snapshot`, account/session tables
- **Privileged package exposure**: `elevated_processes`, `sudo_executions`, `privilege_transitions`, `privileged_listening_ports`
- **Change and configuration management**: startup/task/service/launchd/run-key tables
- **Endpoint protection and hardening**: `windows_security_center`, `windows_security_products`, `alf`, `windows_bitlocker_info`, `sysctl_hardening`, `mount_hardening`
- **Platform trust and execution policy**: `gatekeeper`, `secureboot_certificates`, macOS code-sign/notarization properties, Windows Authenticode / WDAC properties
- **Data protection**: drive encryption posture from BitLocker and related host controls

Current built-in OBOM runtime rules directly cover endpoint security center health, macOS Gatekeeper posture, disk encryption posture, Linux reverse-shell and cron triage, Linux GTFOBins-backed privileged activity, Linux sysctl and mount hardening drift, Windows Authenticode and WDAC trust posture, and macOS notarization review. Dedicated lock-screen or screensaver control checks are still outside the built-in `obom-runtime` ruleset.

## 5) BOM audit lesson: category-driven enforcement

Use category-level gating to fail builds/pipelines on host posture issues:

```bash
obom -o obom.json --bom-audit --bom-audit-categories obom-runtime --bom-audit-fail-severity high
```

Suggested policy profile:

- **critical/high**: block deployment and open incident
- **medium**: ticket + SLA remediation
- **low**: backlog and trend over time

For Windows-heavy fleets, specifically review `OBOM-WIN-006` through `OBOM-WIN-013` to catch LOLBAS-backed persistence, Public-profile inbound exposure, invalid signing posture, and missing WDAC policy coverage. Do not auto-trust managed, vendor-owned, or maintenance-related startup surfaces purely because they originate from a familiar platform image; treat them as breachable targets until provenance and hardening are confirmed.

## 6) Recommended analyst operating model

1. Generate OBOM with audit enabled.
2. Triage high/critical findings.
3. Use REPL to inspect matched categories/components.
4. Export findings into incident/compliance workflows.
5. Track baseline drift by comparing periodic OBOMs.

## 7) Privileged package exposure workflow

Use this when you want BOM audit to spotlight packages and services that run with elevated privileges:

1. Generate an OBOM with audit enabled.
2. Review `obom-runtime` findings for `OBOM-LNX-006` through `OBOM-LNX-019`.
3. Inspect `elevated_processes`, `sudo_executions`, `privilege_transitions`, `privileged_listening_ports`, `behavioral_reverse_shell`, `ld_preload`, `sysctl_hardening`, and `mount_hardening` in the REPL.
4. Confirm whether the package, listener, or privilege transition maps to an approved change.
5. Compare periodic OBOMs to catch newly introduced privileged packages and admin surfaces.

## 8) Windows LOLBAS and ATT&CK workflow

Use this when you want host BOM audit to prioritize Windows living-off-the-land tradecraft:

1. Generate an OBOM with `--bom-audit`.
2. Review `OBOM-WIN-006` through `OBOM-WIN-013`.
3. In the REPL, inspect `windows_run_keys`, `scheduled_tasks`, `startup_items`, `appcompat_shims`, `wmi_cli_event_consumers`, `processes`, `listening_ports`, and `process_open_handles_snapshot`.
4. Search the matched component properties for `cdx:lolbas:names`, `cdx:lolbas:attackTechniques`, and `cdx:lolbas:riskTags`.
5. Escalate findings that combine persistence surfaces with ATT&CK techniques such as `T1218`, `T1546`, or `T1548.002`.

## 9) macOS hardening workflow

Use this when you want to validate Apple execution-policy and persistence posture on developer endpoints:

1. Generate an OBOM with `--deep --bom-audit --bom-audit-categories obom-runtime`.
2. Review `OBOM-MAC-001` through `OBOM-MAC-007`.
3. In the REPL, inspect `gatekeeper`, `launchd_services`, `launchd_overrides`, `alf`, `alf_exceptions`, and `apps`, then pivot into app properties such as `cdx:darwin:codesign:*` and `cdx:darwin:notarization:*`.
4. Correlate weak Gatekeeper or launchd findings with `package_receipts`, `homebrew_packages`, and `npm_packages` to understand how software landed on the host.
5. If `gatekeeper` or browser-extension tables are empty, follow the macOS troubleshooting guide for sudo/TCC/FDA caveats.

## 10) Trust review workflow for signed software

Use this when you want to review whether execution policy and signing context match platform expectations:

1. Generate an OBOM with `--deep`.
2. On macOS, pivot through app properties such as `cdx:darwin:codesign:teamIdentifier`, `cdx:darwin:codesign:authority`, and `cdx:darwin:notarization:assessment`.
3. On Windows, review `cdx:windows:authenticode:*` properties and the additional WDAC data components carrying `cdx:windows:wdac:*` properties.
4. Compare those trust signals with persistence surfaces (`launchd`, Run keys, scheduled tasks, services) before approving or suppressing suspicious software.

## 11) Offline rootfs hardening workflow

Use this when you want golden-image and offline-host drift detection without relying on live osquery collection:

```bash
cdxgen /absolute/path/to/rootfs -t rootfs -o rootfs-bom.json --bom-audit --bom-audit-categories rootfs-hardening
```

1. Review `RFS-001` through `RFS-006` for repository transport, disabled signature checks, stale trust anchors, GTFOBins-capable privileged helpers, and suspicious service definitions.
2. Pivot into repository source components with `cdx:os:repo:*` properties and trusted key material with `cdx:crypto:*` properties.
3. Inspect systemd or init-service entries that reference `cdx:service:ExecStart` or `cdx:service:ExecStartPre` paths under writable directories.
4. Review the metadata annotation summary and `cdx:container:unpackagedExecutableCount` / `cdx:container:unpackagedSharedLibraryCount` properties to gauge how much native inventory sits outside OS package ownership.
5. Import the BOM into `cdxi` and run `.unpackagedbins` plus `.unpackagedlibs` to inspect those native files directly.
6. Compare the offline findings with your image baseline and package-ownership expectations before promotion.

## 12) Unpackaged PHP workflow

osquery's package tables list what dpkg, rpm and the like installed, so a PHP built from source, such as the Docker Official `php` images, FrankenPHP or a `/usr/local` build, is not in them. An OBOM reads the version from the files themselves:

```bash
cdxgen -t os -o obom.json --bom-audit --bom-audit-categories php-security
jq -r '.components[] | select(.type=="file") | select((.properties // [])[] | select(.name=="cdx:php:buildVersion"))
  | [.name, ([.properties[] | select(.name=="cdx:php:sapi")][0].value), ([.properties[] | select(.name=="cdx:php:buildVersion")][0].value)] | @tsv' obom.json
```

1. The probe looks in fixed directories, one level deep, and nowhere else: `/usr/local/{bin,sbin}`, `/usr/local/lib`, the Apache module directories (`/usr/lib/apache2/modules`, `/usr/lib/httpd/modules`, `/usr/lib64/httpd/modules`) and `/opt/<name>/{bin,sbin}` on Linux; `/usr/local/{bin,sbin}` and `/opt/homebrew/{bin,sbin}` on macOS; `C:\php*`, `C:\tools\php*` and `%ProgramFiles%\PHP*` on Windows. PHP in `/usr/bin` is not a candidate: a distro package owns it, and its package is its identity. At most 64 files are looked at, and nothing is executed.
2. Before a file is opened, the package databases are asked whether they own it: dpkg's lists, the apk database, osquery's `rpm_package_files`, a link into a Homebrew `Cellar`, a Nix or Guix store, and, on Windows, Chocolatey's `php` package under `C:\tools`. Owned PHP produces nothing new; its package row is its identity.
3. What no package owns becomes a `file` component with `cdx:php:buildVersion`, `cdx:php:buildVersionSource` and `cdx:php:sapi`, plus one `pkg:generic/php@<version>` platform component with a CPE per version. That is what lets `PHP-RCE-001` and `PHP-RCE-002` fire on a host. An OBOM has no dependency graph, so unlike a container BOM it does not link the files to the runtime with edges.
4. A package database that exists but cannot be read, for example because the scan does not run as root, leaves ownership unknown. The probe then emits nothing for those files, and the `php.host-probe.package-db-unreadable` degradation is recorded when introspection is on. Re-run as a user that can read the database.
5. PHP bundled inside an application (MAMP, Laravel Herd), PHP deeper under `/opt` than `/opt/<name>/bin` (Remi SCL, cPanel `ea-php`), and Windows installs outside the roots above are not probed.

## 12a) Unpackaged Node.js, Python environments and embedded Brotli decoders

The release tarballs, the nodejs.org installer and the version managers put
Node.js where no package database records it, and osquery's `python_packages`
table reads only the interpreter's own site-packages. An OBOM fills both gaps
from the files, which is what CVE-2026-111497 (the Brotli decoder bug that
Node.js, the Python `Brotli` and `brotlicffi` wheels and others carry) needs:

```bash
cdxgen -t os -o obom.json --bom-audit --bom-audit-categories brotli-security
jq -r '.components[] | select((.properties // [])[] | select(.name=="cdx:brotli:c:blockSwitchFix"))
  | [.name, (.purl // ""), ([.properties[] | select(.name=="cdx:brotli:c:blockSwitchFix")][0].value)] | @tsv' obom.json
```

1. Node.js candidates are `node` files in `/usr/local/bin`, `/opt/<name>/bin` and `/usr/local/n/versions/node/*/bin`, plus each home directory's nvm, fnm, volta, asdf and mise trees (`~/.nvm/versions/node/*/bin`, `~/.local/share/fnm/node-versions/*/installation/bin`, `~/.volta/tools/image/node/*/bin`, `~/.asdf/installs/nodejs/*/bin`, `~/.local/share/mise/installs/node/*/bin`), and `%ProgramFiles%\nodejs` and `%APPDATA%\nvm\*` on Windows. The same package-ownership rules as the PHP probe apply: a Homebrew or distro `node` is identified by its package. On Windows a `node.exe` is owned when Chocolatey lists `nodejs`, `nodejs-lts` or `nodejs.install` (whose MSI installs into `%ProgramFiles%\nodejs`, outside Chocolatey's folder), or when a Windows Installer product's `install_location` contains it; an install location that is a shared folder such as `C:\Program Files\` claims nothing.
2. Each unpackaged `node` becomes a `file` component named by its path, with `cdx:node:buildVersion` read from the release URL compiled into it, a `pkg:generic/node@<version>` platform component with a CPE, and `cdx:brotli:c:blockSwitchFix` for the decoder inside it. `process.versions.brotli` cannot be used for this: Node.js 24.22.1 still reports `1.2.0` after the fix.
3. Python packages in virtual environments (directories holding `pyvenv.cfg` under `/opt`, `/srv`, `/app`, `/usr/local` and the home directories, including `.venv`, `.virtualenvs`, pipenv and Poetry environments) and pyenv interpreters are read from their `*.dist-info/METADATA`. Each package is one component with an occurrence per installation and `cdx:python:environment`; a package the system site-packages also holds keeps its osquery component and gains the occurrence.
4. A Homebrew or distro Node.js that links brotli as a shared library carries no decoder of its own: check the `brotli` / `libbrotli1` package instead, or the formulation section of a source scan, which records the shared library's state.

## 12b) Ruby runtimes and gems

osquery has no table for RubyGems and its package tables cannot see a Ruby
that ruby-build, rbenv, rvm, asdf, mise, chruby, frum or a toolcache tarball
installed. Both matter for advisories such as the Ruby 3.3.13, 3.4.12 and 4.0.9
releases, whose Onigmo fixes are in the interpreter core and whose `resolv`
fixes are in a default gem. An OBOM names each Ruby by its upstream version
and lists the gems of every gem home:

```bash
cdxgen -t os -o obom.json
jq -r '.components[] | select(.purl // "" | startswith("pkg:generic/ruby@"))
  | [.version, (.cpe // "no CPE"), ([.properties[]? | select(.name=="cdx:os:installedBy")][0].value // "unpackaged")] | @tsv' obom.json
jq -r '.components[] | select(.name=="resolv") | [.purl, (.evidence.occurrences // [] | map(.location) | join(" "))] | @tsv' obom.json
```

1. Ruby candidates are `ruby` files in `/usr/local/bin`, `/opt/<name>/bin`, `/opt/rubies/*/bin`, `/opt/hostedtoolcache/Ruby/*/*/bin`, `/usr/local/rbenv/versions/*/bin` and `/usr/local/rvm/rubies/*/bin`, plus each home directory's rbenv, rvm, asdf, mise, chruby, frum and rv trees; on Windows, `C:\Ruby*`, `C:\tools\ruby*` and the hosted toolcache.
2. A file a package owns is skipped, under the same ownership rules as the PHP probe. What no package owns is read without being run: the version comes from the MAJOR, MINOR and TEENY entries of the install's `rbconfig.rb` (its `RUBY_PROGRAM_VERSION` is an unexpanded template), with the description compiled into libruby naming a preview or release candidate. Each version becomes `pkg:generic/ruby@<version>` with `cpe:2.3:a:ruby-lang:ruby:<version>`.
3. A Ruby a package manager installed keeps its package (`pkg:deb/ubuntu/libruby3.2@3.2.3-1ubuntu0.24.04.8`) and also gets `pkg:generic/ruby@3.2.3`, with `cdx:os:installedBy` naming the package. A distro's carries no CPE, since distros backport fixes under the old upstream version; Homebrew's, Chocolatey's and the RubyInstaller's do.
4. Gems are read from the `specifications` directory of each gem home: the distro and `gem install` homes (`/usr/lib/ruby/gems/*`, `/usr/share/gems`, Debian's `/usr/share/rubygems-integration/*` and `/usr/lib/*/rubygems-integration/*`, `/var/lib/gems/*`, `/usr/local/lib/ruby/gems/*`), each version manager's install, and `~/.gem/ruby/*`. Only regular gemspec files are read, each under a size cap, so a link to a device left in a user's gem home cannot stall a root scan. Default gems carry `cdx:gem:defaultGem`, and a gem a package database lists carries `cdx:os:installedBy` with that package's purl. rpm is asked about the paths in chunks. Each gem is one component with an occurrence per gem home.
5. A package database that cannot be read leaves ownership unknown and records `ruby.host-probe.package-db-unreadable`.

## 13) Package identity: the same package, the same purl

An OBOM names the OS packages of a host the way `cdxgen -t docker` names the packages of an image, so findings, vulnerability matches and diffs carry over from one to the other:

- a deb, rpm or apk package has the vendor of the distro as its namespace (`ubuntu`, `almalinux`, `alpine`, `wolfi`), the `arch`, `distro` and `distro_name` qualifiers, and `epoch` when it has one; it has no subpath
- an rpm's version is `[epoch:]version-release`, and a deb's is as dpkg reports it, epoch included
- a pacman package is `pkg:alpm/<vendor>/<name>@<version>?arch=<arch>`, with the vendor of the distro (`arch`, `manjaro`) and the version as pacman reports it, epoch and release included (`pkg:alpm/arch/zlib@1:1.3.2-4?arch=x86_64`). The alpm type defines no other qualifier, and an Arch system is rolling, so there is no release to name
- a Homebrew package is `pkg:brew/<name>@<version>`, formula and cask alike, on macOS and Linux; `cdx:homebrew:type` says which. Every version in the Cellar is a component
- a MacPorts port is `pkg:macports/<name>@<version>_<revision>`, a snap `pkg:snap/<name>@<version>` at its current revision, and a flatpak `pkg:flatpak/<application id>@<version>?arch=<arch>&branch=<branch>`, without a version when AppStream gives none. These three types are not in the purl specification; cdxgen builds them as it builds `pkg:chocolatey`
- an AI agent skill that osquery finds (`ai_agent_skills`) is a `file` component with no purl. Its bom-ref is the SHA-256 of its SKILL.md, so the same skill installed under several roots is one component with an occurrence for each
- an npm or pypi package that osquery finds (`npm_packages`, `python_packages`) is `pkg:npm/<name>@<version>` or `pkg:pypi/<name>@<version>`, and a scoped npm package keeps its scope as the namespace (`pkg:npm/%40npmcli/agent@4.0.2`, group `@npmcli`). Where the package was found is an entry in `evidence.occurrences`, and stays in the `path` property, but is not part of the purl: a home directory never ends up in a purl or bom-ref, and a package installed in several places is one component with one occurrence for each place
- a Firefox add-on (`firefox_addons`) is `pkg:swid/<name>@<version>?tag_id=<add-on ID>`, for example `pkg:swid/uBlock%2BOrigin@1.75.0?tag_id=uBlock0%40raymondhill.net`. An ID that is a GUID is written in lower case and without its braces, as the swid type asks; the `identifier` property keeps it as Firefox gives it. Each profile the add-on is installed in is an occurrence, so an add-on in several profiles, or installed by several users, is one component, and a flag that differs between them, such as `active`, is listed once for each value. A built-in add-on has no path, and so no occurrence. On Linux, osquery 5.24.0 also reads the profiles that Firefox 147 and later create under `~/.config/mozilla/firefox`. Of a user's three profile folders (`~/.mozilla/firefox`, `~/snap/firefox/common/.mozilla/firefox` and `~/.config/mozilla/firefox`), osquery reads only the last one that exists, so the add-ons in the others are missing
- an extension of Chrome or another Chromium-based browser (`chrome_extensions`) is `pkg:chrome-extension/<extension ID>@<version>`, and a VS Code extension (`vscode_extensions`) is `pkg:vscode-extension/<publisher>/<name>@<version>`, split from the extension ID: `redhat.vscode-yaml` is `pkg:vscode-extension/redhat/vscode-yaml@2.0.0`. These are the purls `-t chrome-extension` and `-t vscode-extension` give the same extensions. Each browser profile or editor extensions folder the extension is installed in is an occurrence, so one extension in several profiles, browsers, editors (VS Code, VSCodium, Cursor, code-server and the others osquery knows) or users is one component. The `profile`, `browser_type` and `vscode_edition` properties list where it is, and the VS Code publisher's display name is the component's `publisher`
- `cdx:deb:source`, `cdx:rpm:sourceRpm`, `cdx:apk:origin` and `cdx:alpm:pkgbase` link a binary package to the source package that advisories are often keyed by

osquery has no apk table, so on an Alpine, Wolfi or Chainguard host the packages are read from the apk installed database (`/lib/apk/db/installed`, `/usr/lib/apk/db/installed` or `/var/lib/apk/db/installed`, whichever exists first). That works where osquery itself cannot run: the plugin bundles for musl systems such as Alpine ship no osquery, so there no other category is collected and the OBOM has no OS component. If the database exists and cannot be read, for example because the scan does not run as root, the packages are missing and the `os.apk-installed-db.unreadable` degradation is recorded when introspection is on; run `obom` as a user that can read it.

To check one against the other, scan an image with `cdxgen -t docker` and run `obom` inside the same image, then compare the package purls. The container scan also lists the source package of each binary package, tagged `source`, which an OBOM does not, so leave those out:

```bash
cdxgen -t docker my-image -o image.json
# ... run obom inside a container of my-image, writing host.json ...

jq -r '.components[] | select((.tags // []) | index("source") | not) | (.purl // empty)
  | select(startswith("pkg:deb/") or startswith("pkg:rpm/") or startswith("pkg:apk/"))' image.json | sort -u > image-purls.txt
jq -r '.components[] | (.purl // empty)
  | select(startswith("pkg:deb/") or startswith("pkg:rpm/") or startswith("pkg:apk/"))' host.json | sort -u > host-purls.txt
diff image-purls.txt host-purls.txt && echo identical
```

An OBOM generated by cdxgen 13.4.0 or earlier named these packages differently: a deb or rpm purl had a subpath (`#var/lib/dpkg` or the source rpm file name) and no qualifiers, an rpm version had no release, a Homebrew package was `pkg:swid/<name>@<version>?tag_id=<name>`, an npm or pypi purl had the path it was found at as its subpath (one component per path), a scoped npm package lost its `@` (`pkg:npm/npmcli%2Fagent@4.0.2`), a Firefox add-on had its name as its `tag_id` and the path of its XPI file as its subpath (one component per profile), a Chromium or VS Code extension had its folder as its subpath (one component per profile or editor), a VS Code extension had its publisher's display name as its namespace and its whole ID as its name (`pkg:vscode-extension/red%2Bhat/redhat.vscode-yaml@2.0.0`), and a Safari extension's subpath was the glob pattern osquery 5.23.1 reported instead of its `.appex` bundle. pacman, snap, flatpak and MacPorts packages, and Homebrew on Linux, were not inventoried at all. Re-generate such an OBOM before comparing it with a newer one.
