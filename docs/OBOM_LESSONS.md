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

For Windows-heavy fleets, specifically review `OBOM-WIN-006` through `OBOM-WIN-013` to catch LOLBAS-backed persistence, Public-profile inbound exposure, invalid signing posture, and missing WDAC policy coverage.

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
