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

## 2) SOC triage lesson: rapid suspicious persistence sweep

### Why

Most early compromise persistence techniques show up in host startup surfaces.

### What to review first

- Linux: `systemd_units`, `sudoers_snapshot`, `authorized_keys_snapshot`, `elevated_processes`, `sudo_executions`, `privilege_transitions`, `privileged_listening_ports`
- Windows: `windows_run_keys`, `scheduled_tasks`, `services_snapshot`, WMI tables
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
