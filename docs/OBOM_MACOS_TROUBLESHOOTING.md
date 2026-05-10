# macOS OBOM troubleshooting

This guide covers common issues when generating an OBOM on macOS with `cdxgen -t os` / `obom`.

## What changed with osquery 5.23.0

The bundled osquery was updated to `5.23.0`, which made a few macOS-specific improvements relevant to OBOM collection:

- `gatekeeper` works again on macOS 15+
- `apps` has better coverage via additional directory scanning
- `npm_packages` has better modern package manager coverage
- `wifi_status.network_name` is more reliable when Full Disk Access is granted

cdxgen now invokes the bundled osquery binary in **shell mode** (`--S`) with the persistent database disabled. This avoids the older daemon-style startup problem that tried to create `/var/osquery` and could fail with:

```text
Could not initialize db directory: Could not create directory "/var/osquery": Permission denied
```

If you still see that error while running osquery manually, use shell mode instead of daemon mode.

## What was validated on macOS

A local end-to-end run from this workspace completed successfully and produced a non-empty OBOM after switching osquery to shell mode.

Observed categories in the generated OBOM included:

- `alf`
- `alf_exceptions`
- `apps`
- `chrome_extensions`
- `gatekeeper`
- `homebrew_packages`
- `launchd_overrides`
- `launchd_services`
- `listening_ports`
- `logged_in_users_snapshot`
- `npm_packages`
- `running_apps`
- `safari_extensions`
- `shell_history_snapshot`
- `startup_items`
- `users_snapshot`
- `xprotect_entries`
- `xprotect_meta`

## Quick run

```bash
cd /path/to/cdxgen
CDXGEN_PLUGINS_DIR=/path/to/cdxgen-plugins-bin/packages/darwin-arm64/plugins \
node ./bin/cdxgen.js -t os -o obom.json
```

If you installed cdxgen normally rather than from a workspace checkout, you usually do **not** need to set `CDXGEN_PLUGINS_DIR`.

## Full Disk Access (FDA)

Several macOS tables depend on privacy-protected locations or system frameworks. If a category is unexpectedly empty, first grant **Full Disk Access** to the terminal or runner launching cdxgen.

Typical examples include:

- browser extension/profile tables such as `safari_extensions`
- shell and user-history style tables such as `shell_history_snapshot`
- Wi-Fi metadata such as `wifi_status.network_name`
- app/package metadata that lives under protected directories for other users

### Recommended FDA workflow

1. Open **System Settings**.
2. Go to **Privacy & Security** → **Full Disk Access**.
3. Add the terminal you use to run cdxgen, for example:
   - Terminal
   - iTerm
   - Warp
   - your CI/automation runner app
4. Restart that application.
5. Re-run `obom`.

## When to use sudo

With the shell-mode change, many macOS tables now work without `sudo`. However, local policy, TCC state, or enterprise controls can still block some tables.

If you need the broadest host view and your environment allows it, retry with elevation:

```bash
sudo env CDXGEN_PLUGINS_DIR=/path/to/cdxgen-plugins-bin/packages/darwin-arm64/plugins \
node ./bin/cdxgen.js -t os -o obom.json
```

Use `sudo` only when your local security policy permits it.

## If `--bom-audit` prints npm parser warnings

During local macOS validation, `obom --bom-audit` completed successfully but also emitted follow-on warnings while auditing the locally installed `npm` package tree. This happened after OBOM generation, not during osquery collection.

Practical guidance:

- treat this as a **child package audit/parsing** issue rather than an osquery/macOS collection failure
- confirm the OBOM file was still written and contains host categories such as `gatekeeper`, `apps`, or `npm_packages`
- if you only want host inventory first, generate the OBOM without `--bom-audit`, then audit selectively afterward

## If categories are still missing

Check these in order:

1. **Bundled plugin path**
   - Confirm cdxgen is using the expected osquery binary.
2. **FDA / TCC permissions**
   - Empty results are often permission-related rather than query-related.
3. **Host content actually exists**
   - Some categories legitimately return no rows on a clean host.
4. **Platform/architecture match**
   - Ensure the plugin package matches your macOS CPU architecture.
5. **Debug logging**
   - Re-run with `CDXGEN_DEBUG_MODE=debug` to see the exact osquery invocations.

Example:

```bash
CDXGEN_DEBUG_MODE=debug \
CDXGEN_PLUGINS_DIR=/path/to/cdxgen-plugins-bin/packages/darwin-arm64/plugins \
node ./bin/cdxgen.js -t os -o obom.json
```

## Useful REPL pivots after collection

```bash
cdxi obom.json
.osinfocategories
.gatekeeper
.launchd_services
.launchd_overrides
.alf
.apps
.npm_packages
```

## Notes

- `gatekeeper` is now part of the default macOS query pack and feeds the built-in `OBOM-MAC-005` audit rule.
- `apps` coverage improved upstream in osquery `5.23.0`; cdxgen benefits automatically from the newer bundled binary.
- `npm_packages` can now surface modern package manager layouts more reliably than older osquery releases.
