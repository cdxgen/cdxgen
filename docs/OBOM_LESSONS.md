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

## 2) SOC triage lesson: rapid suspicious persistence sweep

### Why

Most early compromise persistence techniques show up in host startup surfaces.

### What to review first

- Linux: `systemd_units`, `sudoers_snapshot`, `authorized_keys_snapshot`, `elevated_processes`, `sudo_executions`, `privilege_transitions`, `privileged_listening_ports`
- Windows: `windows_run_keys`, `scheduled_tasks`, `services_snapshot`, `startup_items`, `appcompat_shims`, WMI tables, `processes`, `listening_ports`
- macOS: `launchd_services`, `launchd_overrides`, `alf_exceptions`

### REPL quick flow

```bash
cdxi obom.json
.osinfocategories
.scheduled_tasks
.windows_run_keys
.launchd_services
.elevated_processes
.sudo_executions
.privileged_listening_ports
```

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
- **Endpoint protection and hardening**: `windows_security_center`, `windows_security_products`, `alf`, `windows_bitlocker_info`
- **Data protection**: drive encryption posture from BitLocker and related host controls

Current built-in OBOM runtime rules directly cover endpoint security center health (including antivirus/firewall/UAC posture) and disk encryption posture (BitLocker). Dedicated lock-screen/screensaver control checks are not currently part of the built-in `obom-runtime` ruleset.

## 5) BOM audit lesson: category-driven enforcement

Use category-level gating to fail builds/pipelines on host posture issues:

```bash
obom -o obom.json --bom-audit --bom-audit-categories obom-runtime --bom-audit-fail-severity high
```

Suggested policy profile:

- **critical/high**: block deployment and open incident
- **medium**: ticket + SLA remediation
- **low**: backlog and trend over time

For Windows-heavy fleets, specifically review `OBOM-WIN-006` through `OBOM-WIN-010` to catch LOLBAS-backed persistence and ATT&CK-aligned proxy-execution patterns.

## 6) Recommended analyst operating model

1. Generate OBOM with audit enabled.
2. Triage high/critical findings.
3. Use REPL to inspect matched categories/components.
4. Export findings into incident/compliance workflows.
5. Track baseline drift by comparing periodic OBOMs.

## 7) Privileged package exposure workflow

Use this when you want BOM audit to spotlight packages and services that run with elevated privileges:

1. Generate an OBOM with audit enabled.
2. Review `obom-runtime` findings for `OBOM-LNX-006` through `OBOM-LNX-011`.
3. Inspect `elevated_processes`, `sudo_executions`, `privilege_transitions`, and `privileged_listening_ports` in the REPL.
4. Confirm whether the package, listener, or privilege transition maps to an approved change.
5. Compare periodic OBOMs to catch newly introduced privileged packages and admin surfaces.

## 8) Windows LOLBAS and ATT&CK workflow

Use this when you want host BOM audit to prioritize Windows living-off-the-land tradecraft:

1. Generate an OBOM with `--bom-audit`.
2. Review `OBOM-WIN-006` through `OBOM-WIN-010`.
3. In the REPL, inspect `windows_run_keys`, `scheduled_tasks`, `startup_items`, `appcompat_shims`, `wmi_cli_event_consumers`, `processes`, and `listening_ports`.
4. Search the matched component properties for `cdx:lolbas:names`, `cdx:lolbas:attackTechniques`, and `cdx:lolbas:riskTags`.
5. Escalate findings that combine persistence surfaces with ATT&CK techniques such as `T1218`, `T1546`, or `T1548.002`.
