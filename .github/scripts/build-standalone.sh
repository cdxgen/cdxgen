#!/usr/bin/env bash
set -euo pipefail

STAGING_DIRS=()
SHARED_PNPM_STORE="${STANDALONE_PNPM_STORE:-$(mktemp -d)}"
SLIM_MAX_BYTES="${STANDALONE_SLIM_MAX_BYTES:-104857600}"
FAT_MAX_BYTES="${STANDALONE_FAT_MAX_BYTES:-301989888}"
DEFAULT_TARGETS=(
  aibom
  cdxgen
  cdxgen-slim
  cbom
  obom
  saasbom
  cdx-audit
  cdx-verify
  cdx-sign
  cdx-validate
  cdx-convert
  hbom
  hbom-slim
  tracebom
)

COMMON_SBOM_ARGS=(
  -t caxa
  -t jar
  -t php
  -t ruby
  --lifecycle post-build
  --include-formulation
  --no-install-deps
)

CAXA_PACKAGE="${CAXA_PACKAGE:-@cdxgen/caxa@^3.1.0}"

cleanup_staging_dirs() {
  for staging_dir in "${STAGING_DIRS[@]:-}"; do
    if [[ -n "$staging_dir" && -d "$staging_dir" ]]; then
      rm -rf "$staging_dir"
    fi
  done
  if [[ -z "${STANDALONE_PNPM_STORE:-}" && -n "$SHARED_PNPM_STORE" && -d "$SHARED_PNPM_STORE" ]]; then
    rm -rf "$SHARED_PNPM_STORE"
  fi
}

trap cleanup_staging_dirs EXIT

run_caxa() {
  pnpm --package="$CAXA_PACKAGE" dlx caxa "$@"
}

file_size_bytes() {
  local file_path="$1"

  if stat -f %z "$file_path" >/dev/null 2>&1; then
    stat -f %z "$file_path"
  else
    stat -c %s "$file_path"
  fi
}

assert_binary_size_limit() {
  local output="$1"
  local max_bytes="$FAT_MAX_BYTES"
  local size_bytes

  if [[ "$output" == *-slim ]]; then
    max_bytes="$SLIM_MAX_BYTES"
  fi
  size_bytes="$(file_size_bytes "$output")"
  if (( size_bytes > max_bytes )); then
    echo "Standalone binary size check failed: $output is ${size_bytes} bytes, limit is ${max_bytes} bytes." >&2
    exit 1
  fi
  echo "Standalone binary size check passed: $output is ${size_bytes} bytes (limit ${max_bytes})."
}

run_binary_build() {
  local staging_dir="$1"
  local output="$2"
  local metadata_file="$3"
  local entry_point="$4"
  local caxa_args=(
    --input "$staging_dir"
    --metadata-file "$metadata_file"
    --output "$output"
  )

  if [[ "$(uname -s)" == "Linux" ]]; then
    caxa_args+=(--upx --upx-args '--best' '--lzma')
  fi

  caxa_args+=(-- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/$entry_point")

  run_caxa "${caxa_args[@]}"
  node "$staging_dir/bin/cdxgen.js" "${COMMON_SBOM_ARGS[@]}" -o ".${output}-postbuild.cdx.json"
  chmod +x "$output"
  "./$output" --version
  "./$output" --help
  if [[ "$output" == "cdxgen" || "$output" == "cbom" || "$output" == "saasbom" ]]; then
    run_atom_smoke_test "$output"
  fi
  if [[ "$output" == "aibom" ]]; then
    run_aibom_smoke_test "$output"
  fi
  assert_binary_size_limit "$output"
}

# Spawn atom through the freshly built caxa binary so a payload-less or
# non-executable dispatcher fails the build on the runner that produced it. The
# --version/--help checks above do not exercise atom; this does.
#
# The fixture is a header-only C source tree with no build manifest. Its whole
# component inventory comes from `atom parsedeps` (lib/ecosystems/cppEvidence.js
# -> findAppModules), so the component count is zero when atom cannot run and
# non-zero when it can. That property is what makes this a test rather than a
# formality, so the run is bracketed by a negative control: the same binary is
# first run with ATOM_CMD pointed at a command that always fails, and must
# produce nothing. If a future cdxgen learns to inventory C without atom, the
# control starts producing components and fails here, rather than leaving a
# green test that no longer proves anything.
ATOM_SMOKE_FIXTURE="test/data/evinse-cpp-repotest"

count_bom_components() {
  node --input-type=module - "$1" <<'NODE'
    import { existsSync, readFileSync } from "node:fs";
    const [, , file] = process.argv;
    if (!existsSync(file)) {
      console.log("0");
    } else {
      const bom = JSON.parse(readFileSync(file, "utf8"));
      console.log(`${(bom.components || []).length}`);
    }
NODE
}

count_bom_components_of_type() {
  node --input-type=module - "$1" "$2" <<'NODE'
    import { existsSync, readFileSync } from "node:fs";
    const [, , file, type] = process.argv;
    if (!existsSync(file)) {
      console.log("0");
    } else {
      const bom = JSON.parse(readFileSync(file, "utf8"));
      console.log(
        `${(bom.components || []).filter((c) => c.type === type).length}`,
      );
    }
NODE
}

run_atom_smoke_test() {
  local output="$1"
  local smoke_out=".${output}-atom-smoke.json"
  local control_out=".${output}-atom-smoke-control.json"
  local atom_pkg kind control_count smoke_count
  atom_pkg="$(resolve_atom_platform_package_name)"
  kind="$(atom_payload_kind_for_package "$atom_pkg")"
  if [[ "$kind" == "jar" ]] && ! command -v java >/dev/null 2>&1; then
    echo "atom smoke test: jar flavour ($atom_pkg), JDK unavailable, skipped."
    return
  fi
  echo "atom smoke test: ./$output against $ATOM_SMOKE_FIXTURE (provider=$atom_pkg, kind=$kind)"

  rm -f "$control_out"
  ATOM_CMD="$(command -v false)" "./$output" -t c "$ATOM_SMOKE_FIXTURE" -o "$control_out" >/dev/null 2>&1 || true
  control_count="$(count_bom_components "$control_out")"
  rm -f "$control_out"
  if [[ "$control_count" != "0" ]]; then
    echo "atom smoke test FAILED: the negative control produced $control_count component(s) with atom disabled, so this fixture no longer proves atom ran." >&2
    exit 1
  fi

  rm -f "$smoke_out"
  if ! "./$output" -t c "$ATOM_SMOKE_FIXTURE" -o "$smoke_out" --fail-on-error; then
    echo "atom smoke test FAILED: ./$output exited non-zero." >&2
    rm -f "$smoke_out"
    exit 1
  fi
  smoke_count="$(count_bom_components "$smoke_out")"
  rm -f "$smoke_out"
  if [[ "$smoke_count" == "0" ]]; then
    echo "atom smoke test FAILED: no components produced; the atom payload is missing or did not run." >&2
    exit 1
  fi
  echo "atom smoke test: $smoke_count component(s) from atom, 0 from the disabled-atom control."
}

# The fixture is a Hugging Face model repository. The aibom alias must apply
# the -t ai defaults on its own (applyCommandNameDefaults keyed off the invoked
# command name), and exactly that produces machine-learning-model components:
# the same fixture scanned without the AI defaults yields none. So a model
# count of zero means the alias entry point regressed to plain cdxgen (#4379)
# rather than the scan merely coming up empty.
AIBOM_SMOKE_FIXTURE="test/data/ai-huggingface/repos"

run_aibom_smoke_test() {
  local output="$1"
  local smoke_out=".${output}-ai-smoke.json"
  local model_count
  echo "aibom smoke test: ./$output against $AIBOM_SMOKE_FIXTURE"

  rm -f "$smoke_out"
  if ! "./$output" "$AIBOM_SMOKE_FIXTURE" -o "$smoke_out" --no-install-deps --fail-on-error >/dev/null 2>&1; then
    echo "aibom smoke test FAILED: ./$output exited non-zero." >&2
    rm -f "$smoke_out"
    exit 1
  fi
  model_count="$(count_bom_components_of_type "$smoke_out" machine-learning-model)"
  rm -f "$smoke_out"
  if [[ "$model_count" == "0" ]]; then
    echo "aibom smoke test FAILED: no machine-learning-model components; the AI-BOM defaults were not applied." >&2
    exit 1
  fi
  echo "aibom smoke test: $model_count machine-learning-model component(s)."
}

promote_optional_dependencies() {
  local staging_dir="$1"
  shift
  local packages=("$@")

  if [[ "${#packages[@]}" -eq 0 ]]; then
    return
  fi

  node --input-type=module - "$staging_dir/package.json" "${packages[@]}" <<'NODE'
    import { readFileSync, writeFileSync } from "node:fs";

    const [, , packageJsonFile, ...packageNames] = process.argv;
    const packageJson = JSON.parse(readFileSync(packageJsonFile, "utf8"));
    packageJson.dependencies ??= {};

    for (const packageName of packageNames) {
      if (packageName.includes("@cdxgen/safer-exec-")) {
        const packageVersion = packageJson.optionalDependencies["@cdxgen/safer-exec"];
        packageJson.dependencies["@cdxgen/safer-exec"] = packageVersion;
        packageJson.dependencies["@cdxgen/safer-exec-darwin-arm64"] = packageVersion;
        packageJson.dependencies["@cdxgen/safer-exec-darwin-amd64"] = packageVersion;
        packageJson.dependencies["@cdxgen/safer-exec-linux-amd64"] = packageVersion;
        packageJson.dependencies["@cdxgen/safer-exec-linux-arm64"] = packageVersion;
      } else {
        const packageVersion = packageJson.optionalDependencies?.[packageName];
        if (!packageVersion) {
          console.error(`Missing optional dependency version for ${packageName}`);
          process.exit(1);
        }
        packageJson.dependencies[packageName] = packageVersion;
        delete packageJson.optionalDependencies[packageName];
      }
    }
    // Everything still sitting in optionalDependencies is, by definition, not
    // wanted by this profile. Drop it rather than relying on `--no-optional`:
    // that flag also refuses to resolve the optional dependencies *of* a
    // promoted package, and atom 3 keeps its per-platform payload exactly
    // there, so `--no-optional` fails the install with
    // ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY. With the unwanted entries gone the
    // install can run with optional resolution enabled, which is also what lets
    // pnpm pick the atom payload matching the build target's os/cpu/libc.
    delete packageJson.optionalDependencies;
    writeFileSync(`${packageJsonFile}`, `${JSON.stringify(packageJson, null, 2)}\n`);
NODE
}

resolve_platform_plugin_package_name() {
  node --input-type=module <<'NODE'
    import { readFileSync } from "node:fs";

    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const normalizeOs = (value) => {
      const osValue = value || process.platform;
      if (osValue === "win32") return "windows";
      return osValue;
    };
    const normalizeArch = (value) => {
      const archValue = value || process.arch;
      if (archValue === "x64") return "amd64";
      if (archValue === "ppc64le") return "ppc64";
      return archValue;
    };
    const targetOs = normalizeOs(process.env.TARGET_OS);
    const targetArch = normalizeArch(process.env.TARGET_ARCH);
    const targetLibc = process.env.TARGET_LIBC || "gnu";
    let packageName = `@cdxgen/cdxgen-plugins-bin-${targetOs}-${targetArch}`;

    if (targetOs === "linux" && targetLibc === "musl") {
      packageName = `@cdxgen/cdxgen-plugins-bin-linuxmusl-${targetArch}`;
    }

    if (!packageJson.optionalDependencies?.[packageName]) {
      console.error(
        `Missing platform plugin optional dependency for ${targetOs}/${targetArch}/${targetLibc}: ${packageName}`,
      );
      process.exit(1);
    }

    console.log(packageName);
NODE
}

resolve_safer_exec_package_name() {
  node --input-type=module <<'NODE'
    import { readFileSync } from "node:fs";

    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const normalizeOs = (value) => {
      const osValue = value || process.platform;
      if (osValue === "win32") {
        process.exit(1);
      }
      return osValue;
    };
    const normalizeArch = (value) => {
      const archValue = value || process.arch;
      if (archValue === "x64") return "amd64";
      return archValue;
    };
    const targetOs = normalizeOs(process.env.TARGET_OS);
    const targetArch = normalizeArch(process.env.TARGET_ARCH);
    let packageName = `@cdxgen/safer-exec-${targetOs}-${targetArch}`;

    console.log(packageName);
NODE
}

# Resolve the atom 3 platform sub-package for the build target. Mirrors
# resolve_platform_plugin_package_name in shape and atom's own
# resolveAtomProvider in mapping. Used by the atom-analysis verification block
# to assert the payload sub-package and its contents are present.
resolve_atom_platform_package_name() {
  node --input-type=module <<'NODE'
    const normalizeOs = (value) => {
      const osValue = value || process.platform;
      if (osValue === "win32") return "windows";
      return osValue;
    };
    const normalizeArch = (value) => {
      const archValue = value || process.arch;
      if (archValue === "x64") return "amd64";
      if (archValue === "ppc64le") return "ppc64";
      return archValue;
    };
    const targetOs = normalizeOs(process.env.TARGET_OS);
    const targetArch = normalizeArch(process.env.TARGET_ARCH);
    const targetLibc = process.env.TARGET_LIBC || "gnu";
    let packageName;
    if (targetOs === "linux") {
      if (targetArch === "amd64") {
        packageName = targetLibc === "musl"
          ? "@appthreat/atom-linux-amd64-musl"
          : "@appthreat/atom-linux-amd64";
      } else if (targetArch === "arm64") {
        packageName = targetLibc === "musl"
          ? "@appthreat/atom-linux-arm64-musl"
          : "@appthreat/atom-linux-arm64";
      }
    } else if (targetOs === "darwin") {
      if (targetArch === "amd64") packageName = "@appthreat/atom-darwin-amd64";
      else if (targetArch === "arm64") packageName = "@appthreat/atom-darwin-arm64";
    } else if (targetOs === "windows") {
      if (targetArch === "amd64") packageName = "@appthreat/atom-windows-amd64";
      else if (targetArch === "arm64") packageName = "@appthreat/atom-windows-arm64";
    }
    if (!packageName) {
      console.error(
        `Unmapped atom platform triple: ${targetOs}/${targetArch}/${targetLibc}`,
      );
      process.exit(1);
    }
    console.log(packageName);
NODE
}

# Returns "native" or "jar" for an atom sub-package name. Must agree with
# ATOM_NATIVE_PACKAGES in lib/inventory/atomUtils.js.
atom_payload_kind_for_package() {
  case "$1" in
    @appthreat/atom-linux-amd64|@appthreat/atom-linux-arm64|@appthreat/atom-darwin-arm64|@appthreat/atom-linux-amd64-musl|@appthreat/atom-windows-amd64)
      echo "native" ;;
    *) echo "jar" ;;
  esac
}

# Assert that the atom sub-package payload actually exists in the staging tree.
# A payload-less dispatcher (the atom 3 failure mode under --no-optional) would
# otherwise pass assert_package_present while failing at runtime. On POSIX native
# targets the binary must also be executable (caxa must preserve the mode bit).
assert_atom_payload_present() {
  local staging_dir="$1"
  local package_name="$2"
  local kind
  local payload_path
  kind="$(atom_payload_kind_for_package "$package_name")"
  if [[ "$kind" == "native" ]]; then
    local exe_name="atom"
    if [[ "$(normalized_target_os)" == "windows" ]]; then
      exe_name="atom.exe"
    fi
    payload_path="$staging_dir/node_modules/${package_name}/bin/${exe_name}"
  else
    payload_path="$staging_dir/node_modules/${package_name}/plugins"
  fi
  if [[ ! -e "$payload_path" ]]; then
    echo "Standalone atom payload missing: $payload_path (kind=$kind). The dispatcher would be payload-less." >&2
    exit 1
  fi
  if [[ "$kind" == "native" && "$(normalized_target_os)" != "windows" ]]; then
    if [[ ! -x "$payload_path" ]]; then
      echo "Standalone atom native binary is not executable: $payload_path" >&2
      exit 1
    fi
  fi
  echo "Standalone atom payload present: $payload_path (kind=$kind)."
}

# @appthreat/atom lists the universal @appthreat/atom-jar as an optional
# dependency without an os/cpu constraint, so the install always brings it
# along (~70 MB of jars). atom's resolver only falls back to it when the
# target's own platform sub-package is missing, and the caller has just
# asserted that payload. So atom-jar can never be used here: it sits unused
# next to the native image, or duplicates the jars that the jar-flavoured
# platform packages (darwin-amd64, windows-arm64, linux-arm64-musl) already
# carry. Remove it, then re-assert the payload so a pruning mistake cannot ship
# a payload-less dispatcher.
remove_redundant_atom_jar() {
  local staging_dir="$1"
  local atom_pkg="$2"
  local entry

  if [[ "$atom_pkg" == "@appthreat/atom-jar" ]]; then
    return
  fi
  while IFS= read -r entry; do
    rm -rf "$entry"
  done < <(find "$staging_dir/node_modules" -type d -path "*/node_modules/@appthreat/atom-jar" -prune)
  if [[ -n "$(find "$staging_dir/node_modules" -type d -path "*/node_modules/@appthreat/atom-jar" -print -quit)" ]]; then
    echo "Standalone profile preflight failed: @appthreat/atom-jar is still present in $staging_dir" >&2
    exit 1
  fi
  echo "Removed @appthreat/atom-jar: the $atom_pkg payload is what atom resolves."
  assert_package_present "$staging_dir" "$atom_pkg"
  assert_atom_payload_present "$staging_dir" "$atom_pkg"
}

# Assert that the safer-exec platform sub-package and its Go runtime binary
# actually exist in the staging tree, and make the binary executable.
# assert_package_present alone accepts a payload-less dispatcher, which only
# fails later at runtime when every trace silently yields an empty BOM (#4378).
ensure_safer_exec_payload_present() {
  local staging_dir="$1"
  local package_name="$2"
  local payload_path="$staging_dir/node_modules/${package_name}/bin/safer-exec-rt"

  assert_package_present "$staging_dir" "$package_name"
  if [[ ! -e "$payload_path" ]]; then
    echo "Standalone safer-exec payload missing: $payload_path. The dispatcher would be payload-less." >&2
    exit 1
  fi
  # The platform package declares no bin entry, so the install leaves the Go
  # runtime without the executable bit. The library chmods it on resolve at
  # runtime, but set it here so the shipped payload works regardless.
  chmod +x "$payload_path"
  if [[ ! -x "$payload_path" ]]; then
    echo "Standalone safer-exec binary is not executable: $payload_path" >&2
    exit 1
  fi
  echo "Standalone safer-exec payload present: $payload_path."
}

normalized_target_os() {
  if [[ -n "${TARGET_OS:-}" ]]; then
    echo "$TARGET_OS"
    return
  fi
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) uname -s | tr '[:upper:]' '[:lower:]' ;;
  esac
}

copy_runtime_sources() {
  local staging_dir="$1"

  mkdir -p "$staging_dir"
  cp package.json pnpm-lock.yaml "$staging_dir/"
  if [[ -f .pnpmfile.cjs ]]; then
    cp .pnpmfile.cjs "$staging_dir/"
  fi
  # pnpm 11 and later read `overrides` from pnpm-workspace.yaml rather than the `pnpm`
  # field of package.json. Without it here the staging install disagrees with
  # the lockfile it was given (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH under
  # --frozen-lockfile) and produces an incomplete node_modules otherwise. The
  # `packages:` key is filtered defensively: the repo has no workspace members
  # today, but a staging tree can never have them, and a `packages:` glob that
  # matches nothing there fails the install.
  if [[ -f pnpm-workspace.yaml ]]; then
    awk '
      /^packages:/ { skip = 1; next }
      skip && /^[[:space:]]*-/ { next }
      { skip = 0; print }
    ' pnpm-workspace.yaml > "$staging_dir/pnpm-workspace.yaml"
  fi

  cp -R bin data lib "$staging_dir/"
  if [[ -d plugins ]]; then
    cp -R plugins "$staging_dir/"
  fi
  if [[ -f index.cjs ]]; then
    cp index.cjs "$staging_dir/"
  fi
  find "$staging_dir/lib" -name "*.poku.js" -type f -delete
}

create_cdxgen_alias_entry_point() {
  local staging_dir="$1"
  local command_name="$2"
  local wrapper_file="$staging_dir/bin/${command_name}.js"

  cat > "$wrapper_file" <<'NODE'
#!/usr/bin/env node
process.argv[1] = new URL(import.meta.url).pathname;
await import("./cdxgen.js");
NODE
}

install_profile_dependencies() {
  local staging_dir="$1"
  local profile="$2"
  local selected_optional_packages=()
  local install_args=(
    install
    --config.strict-dep-builds=true
    --config.node-linker=hoisted
    --package-import-method copy
    --prod
    --store-dir "$SHARED_PNPM_STORE"
  )

  if [[ "$profile" == "cdxgen-full" ]]; then
    pnpm --dir "$staging_dir" "${install_args[@]}" --frozen-lockfile
  else
    case "$profile" in
      audit)
        selected_optional_packages=(jsonata)
        ;;
      proto-reader)
        selected_optional_packages=(@cdxgen/cdx-proto @bufbuild/protobuf)
        ;;
      hbom-runtime)
        selected_optional_packages=(
          @cdxgen/cdx-hbom
          @cdxgen/cdx-proto
          @bufbuild/protobuf
          "$(resolve_platform_plugin_package_name)"
        )
        ;;
      hbom-slim)
        selected_optional_packages=(@cdxgen/cdx-hbom)
        ;;
      atom-analysis)
        # atom 3's payload is a per-platform sub-package of @appthreat/atom.
        # It is not named here: with optional resolution enabled, pnpm picks the
        # one matching the build target's os/cpu/libc on its own. The payload is
        # then asserted explicitly below, since a missing one is silent.
        selected_optional_packages=(
          @appthreat/atom
          @appthreat/atom-parsetools
          @cdxgen/cdx-proto
          @bufbuild/protobuf
        )
        ;;
      os-runtime)
        selected_optional_packages=(
          @cdxgen/cdx-proto
          @bufbuild/protobuf
          "$(resolve_platform_plugin_package_name)"
        )
        ;;
      trace-runtime)
        selected_optional_packages=(@cdxgen/cdx-proto "$(resolve_safer_exec_package_name)")
        ;;
      no-optional|json-signature)
        ;;
      *)
        echo "Unknown standalone dependency profile: $profile" >&2
        exit 1
        ;;
    esac
    if [[ "${#selected_optional_packages[@]}" -gt 0 ]]; then
      promote_optional_dependencies "$staging_dir" "${selected_optional_packages[@]}"
      pnpm --dir "$staging_dir" "${install_args[@]}" --no-frozen-lockfile
    else
      pnpm --dir "$staging_dir" "${install_args[@]}" --no-optional --frozen-lockfile
    fi
  fi
}

module_path_for_package() {
  local staging_dir="$1"
  local package_name="$2"

  if [[ "$package_name" == @*/* ]]; then
    echo "$staging_dir/node_modules/${package_name}"
  else
    echo "$staging_dir/node_modules/$package_name"
  fi
}

assert_package_present() {
  local staging_dir="$1"
  local package_name="$2"
  local package_path

  package_path="$(module_path_for_package "$staging_dir" "$package_name")"
  if [[ ! -e "$package_path" ]]; then
    echo "Standalone profile preflight failed: expected $package_name in $staging_dir" >&2
    exit 1
  fi
}

assert_package_absent() {
  local staging_dir="$1"
  local package_name="$2"
  local package_path

  package_path="$(module_path_for_package "$staging_dir" "$package_name")"
  if [[ -e "$package_path" ]]; then
    echo "Standalone profile preflight failed: did not expect $package_name in $staging_dir" >&2
    exit 1
  fi
}

remove_cdxgen_plugins_bin() {
  local staging_dir="$1"

  rm -rf "$staging_dir/node_modules/@cdxgen"/cdxgen-plugins-bin*
}

remove_safer_exec() {
  local staging_dir="$1"

  rm -rf "$staging_dir/node_modules/@cdxgen"/safer-exec*
}

# promote_optional_dependencies installs every safer-exec platform package so
# the lockfile resolves; only the build target's runtime can ever execute.
remove_non_target_safer_exec_platforms() {
  local staging_dir="$1"
  local keep_package="$2"
  local entry

  for entry in "$staging_dir/node_modules/@cdxgen"/safer-exec-*; do
    [[ -e "$entry" ]] || continue
    if [[ "@cdxgen/$(basename "$entry")" != "$keep_package" ]]; then
      rm -rf "$entry"
    fi
  done
}

remove_platform_plugins() {
  local staging_dir="$1"

  remove_cdxgen_plugins_bin "$staging_dir"
  remove_safer_exec "$staging_dir"
}

prune_plugins_to_allowlist() {
  local staging_dir="$1"
  shift
  local allowed_plugins=("$@")
  local plugin_root
  local entry
  local entry_name
  local allowed

  shopt -s nullglob
  for plugin_root in "$staging_dir"/node_modules/@cdxgen/cdxgen-plugins-bin*/plugins; do
    for entry in "$plugin_root"/*; do
      entry_name="$(basename "$entry")"
      if [[ "$entry_name" == "plugins-manifest.json" ]]; then
        continue
      fi
      allowed=false
      for plugin_name in "${allowed_plugins[@]}"; do
        if [[ "$entry_name" == "$plugin_name" ]]; then
          allowed=true
          break
        fi
      done
      if [[ "$allowed" != true ]]; then
        rm -rf "$entry"
      fi
    done
  done
  shopt -u nullglob
}

verify_plugin_allowlist() {
  local staging_dir="$1"
  shift
  local allowed_plugins=("$@")
  local plugin_root
  local entry
  local entry_name
  local allowed

  shopt -s nullglob
  for plugin_root in "$staging_dir"/node_modules/@cdxgen/cdxgen-plugins-bin*/plugins; do
    for entry in "$plugin_root"/*; do
      entry_name="$(basename "$entry")"
      if [[ "$entry_name" == "plugins-manifest.json" ]]; then
        continue
      fi
      allowed=false
      for plugin_name in "${allowed_plugins[@]}"; do
        if [[ "$entry_name" == "$plugin_name" ]]; then
          allowed=true
          break
        fi
      done
      if [[ "$allowed" != true ]]; then
        echo "Standalone profile preflight failed: unexpected plugin directory $entry" >&2
        exit 1
      fi
    done
  done
  shopt -u nullglob
}

apply_profile_pruning_and_preflight() {
  local staging_dir="$1"
  local profile="$2"
  local platform_plugin_package
  local target_os

  case "$profile" in
    cdxgen-full)
      assert_package_present "$staging_dir" @cdxgen/cdx-proto
      assert_package_present "$staging_dir" @cdxgen/cdx-hbom
      assert_package_present "$staging_dir" jsonata
      platform_plugin_package="$(resolve_platform_plugin_package_name)"
      assert_package_present "$staging_dir" "$platform_plugin_package"
      assert_package_present "$staging_dir" @appthreat/atom
      # Local builds may run on a host with no atom platform package, where
      # atom-jar is the only payload and must stay.
      local full_atom_pkg
      if full_atom_pkg="$(resolve_atom_platform_package_name 2>/dev/null)"; then
        assert_package_present "$staging_dir" "$full_atom_pkg"
        assert_atom_payload_present "$staging_dir" "$full_atom_pkg"
        remove_redundant_atom_jar "$staging_dir" "$full_atom_pkg"
      else
        echo "No atom platform package for this target; keeping @appthreat/atom-jar."
      fi
      ;;
    audit)
      assert_package_present "$staging_dir" jsonata
      remove_platform_plugins "$staging_dir"
      assert_package_absent "$staging_dir" @appthreat/atom
      assert_package_absent "$staging_dir" @cdxgen/cdx-proto
      assert_package_absent "$staging_dir" @cdxgen/safer-exec
      ;;
    proto-reader)
      assert_package_present "$staging_dir" @cdxgen/cdx-proto
      assert_package_present "$staging_dir" @bufbuild/protobuf
      remove_platform_plugins "$staging_dir"
      assert_package_absent "$staging_dir" jsonata
      assert_package_absent "$staging_dir" @appthreat/atom
      assert_package_absent "$staging_dir" @cdxgen/safer-exec
      ;;
    hbom-runtime)
      assert_package_present "$staging_dir" @cdxgen/cdx-hbom
      assert_package_present "$staging_dir" @cdxgen/cdx-proto
      platform_plugin_package="$(resolve_platform_plugin_package_name)"
      assert_package_present "$staging_dir" "$platform_plugin_package"
      target_os="$(normalized_target_os)"
      if [[ "$target_os" == "darwin" || "$target_os" == "windows" ]]; then
        prune_plugins_to_allowlist "$staging_dir" osquery trustinspector
        verify_plugin_allowlist "$staging_dir" osquery trustinspector
      else
        prune_plugins_to_allowlist "$staging_dir" osquery
        verify_plugin_allowlist "$staging_dir" osquery
      fi
      ;;
    hbom-slim)
      assert_package_present "$staging_dir" @cdxgen/cdx-hbom
      remove_platform_plugins "$staging_dir"
      assert_package_absent "$staging_dir" @cdxgen/cdx-proto
      assert_package_absent "$staging_dir" jsonata
      assert_package_absent "$staging_dir" @cdxgen/safer-exec
      ;;
    atom-analysis)
      assert_package_present "$staging_dir" @appthreat/atom
      assert_package_present "$staging_dir" @appthreat/atom-parsetools
      assert_package_present "$staging_dir" @cdxgen/cdx-proto
      assert_package_present "$staging_dir" @bufbuild/protobuf
      local atom_pkg
      atom_pkg="$(resolve_atom_platform_package_name)"
      assert_package_present "$staging_dir" "$atom_pkg"
      assert_atom_payload_present "$staging_dir" "$atom_pkg"
      remove_redundant_atom_jar "$staging_dir" "$atom_pkg"
      remove_platform_plugins "$staging_dir"
      assert_package_absent "$staging_dir" @cdxgen/cdx-hbom
      assert_package_absent "$staging_dir" jsonata
      assert_package_absent "$staging_dir" @cdxgen/safer-exec
      ;;
    os-runtime)
      platform_plugin_package="$(resolve_platform_plugin_package_name)"
      assert_package_present "$staging_dir" "$platform_plugin_package"
      target_os="$(normalized_target_os)"
      if [[ "$target_os" == "darwin" || "$target_os" == "windows" ]]; then
        prune_plugins_to_allowlist "$staging_dir" osquery trustinspector
        verify_plugin_allowlist "$staging_dir" osquery trustinspector
      else
        prune_plugins_to_allowlist "$staging_dir" osquery
        verify_plugin_allowlist "$staging_dir" osquery
      fi
      assert_package_absent "$staging_dir" @appthreat/atom
      assert_package_present "$staging_dir" @cdxgen/cdx-proto
      assert_package_present "$staging_dir" @bufbuild/protobuf
      assert_package_absent "$staging_dir" @cdxgen/cdx-hbom
      assert_package_absent "$staging_dir" jsonata
      assert_package_absent "$staging_dir" @cdxgen/safer-exec
      ;;
    trace-runtime)
      assert_package_present "$staging_dir" @cdxgen/safer-exec
      assert_package_present "$staging_dir" @cdxgen/cdx-proto
      # tracebom's native helper is safer-exec itself, so prune only the
      # plugins-bin payloads here. remove_platform_plugins would also delete
      # @cdxgen/safer-exec* after the preflight above passed, shipping a
      # binary that never runs the traced command yet still exits 0 with an
      # empty BOM (#4378).
      remove_cdxgen_plugins_bin "$staging_dir"
      remove_non_target_safer_exec_platforms "$staging_dir" "$(resolve_safer_exec_package_name)"
      assert_package_absent "$staging_dir" @appthreat/atom
      assert_package_absent "$staging_dir" @cdxgen/cdx-hbom
      assert_package_absent "$staging_dir" jsonata
      # The presence checks above ran before pruning, so they cannot catch a
      # pruning step deleting the tracer again. Re-assert the dispatcher, the
      # platform sub-package, and its payload binary after pruning.
      assert_package_present "$staging_dir" @cdxgen/safer-exec
      ensure_safer_exec_payload_present "$staging_dir" "$(resolve_safer_exec_package_name)"
      ;;
    no-optional|json-signature)
      remove_platform_plugins "$staging_dir"
      assert_package_absent "$staging_dir" @appthreat/atom
      assert_package_absent "$staging_dir" @cdxgen/cdx-proto
      assert_package_absent "$staging_dir" @cdxgen/cdx-hbom
      assert_package_absent "$staging_dir" jsonata
      assert_package_absent "$staging_dir" @cdxgen/safer-exec
      ;;
    *)
      echo "Unknown standalone dependency profile: $profile" >&2
      exit 1
      ;;
  esac
}

target_entry_point() {
  case "$1" in
    cdxgen|cdxgen-slim) echo "bin/cdxgen.js" ;;
    # The alias commands must launch through their alias entry point, not
    # bin/cdxgen.js: the alias rewrites process.argv[1] so cdxgen derives the
    # invoked command name and applies the per-command defaults (e.g. -t ai
    # for aibom). Pointing aibom at bin/cdxgen.js makes it behave like plain
    # cdxgen (#4379).
    aibom|cbom|obom|saasbom) echo "bin/$1.js" ;;
    cdx-audit) echo "bin/audit.js" ;;
    cdx-verify) echo "bin/verify.js" ;;
    cdx-sign) echo "bin/sign.js" ;;
    cdx-validate) echo "bin/validate.js" ;;
    cdx-convert) echo "bin/convert.js" ;;
    hbom|hbom-slim) echo "bin/hbom.js" ;;
    tracebom) echo "bin/tracebom.js" ;;
    *) echo "Unknown standalone target: $1" >&2; exit 1 ;;
  esac
}

target_profile() {
  case "$1" in
    cdxgen) echo "cdxgen-full" ;;
    aibom|cdxgen-slim) echo "no-optional" ;;
    cbom|saasbom) echo "atom-analysis" ;;
    obom) echo "os-runtime" ;;
    cdx-audit) echo "audit" ;;
    cdx-verify|cdx-sign) echo "json-signature" ;;
    cdx-validate|cdx-convert) echo "proto-reader" ;;
    hbom) echo "hbom-runtime" ;;
    hbom-slim) echo "hbom-slim" ;;
    tracebom) echo "trace-runtime" ;;
    *) echo "Unknown standalone target: $1" >&2; exit 1 ;;
  esac
}

selected_targets() {
  if [[ -z "${STANDALONE_TARGETS:-}" ]]; then
    printf '%s\n' "${DEFAULT_TARGETS[@]}"
    return
  fi
  printf '%s\n' "$STANDALONE_TARGETS" | tr ', ' '\n\n' | sed '/^$/d'
}

build_target() {
  local target="$1"
  local profile
  local entry_point
  local staging_dir

  profile="$(target_profile "$target")"
  entry_point="$(target_entry_point "$target")"
  staging_dir="$(mktemp -d)"
  STAGING_DIRS+=("$staging_dir")

  echo "Building $target with standalone profile $profile"
  copy_runtime_sources "$staging_dir"
  if [[ "$target" == "aibom" || "$target" == "cbom" || "$target" == "obom" || "$target" == "saasbom" ]]; then
    create_cdxgen_alias_entry_point "$staging_dir" "$target"
  fi
  install_profile_dependencies "$staging_dir" "$profile"
  apply_profile_pruning_and_preflight "$staging_dir" "$profile"
  run_binary_build "$staging_dir" "$target" ".$target-metadata.json" "$entry_point"
  rm -rf "$staging_dir"
}

rm -f \
  aibom cdxgen cdxgen-slim cbom obom saasbom cdx-audit cdx-verify cdx-sign cdx-validate cdx-convert hbom hbom-slim tracebom \
  .aibom-postbuild.cdx.json \
  .cdxgen-postbuild.cdx.json .cdxgen-slim-postbuild.cdx.json \
  .cbom-postbuild.cdx.json .obom-postbuild.cdx.json .saasbom-postbuild.cdx.json \
  .cdx-audit-postbuild.cdx.json .cdx-verify-postbuild.cdx.json \
  .cdx-sign-postbuild.cdx.json .cdx-validate-postbuild.cdx.json \
  .cdx-convert-postbuild.cdx.json .hbom-postbuild.cdx.json \
  .hbom-slim-postbuild.cdx.json .tracebom-postbuild.cdx.json

while IFS= read -r target; do
  build_target "$target"
done < <(selected_targets)
