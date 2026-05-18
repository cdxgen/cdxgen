#!/usr/bin/env bash
set -euo pipefail

STAGING_DIRS=()
SHARED_PNPM_STORE="${STANDALONE_PNPM_STORE:-$(mktemp -d)}"
SLIM_MAX_BYTES="${STANDALONE_SLIM_MAX_BYTES:-104857600}"
FAT_MAX_BYTES="${STANDALONE_FAT_MAX_BYTES:-251658240}"
DEFAULT_TARGETS=(
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

CAXA_PACKAGE="${CAXA_PACKAGE:-@appthreat/caxa@^3.0.1}"

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
  assert_binary_size_limit "$output"
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
      const packageVersion = packageJson.optionalDependencies?.[packageName];
      if (!packageVersion) {
        console.error(`Missing optional dependency version for ${packageName}`);
        process.exit(1);
      }
      packageJson.dependencies[packageName] = packageVersion;
      delete packageJson.optionalDependencies[packageName];
    }
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
        selected_optional_packages=(@appthreat/cdx-proto @bufbuild/protobuf)
        ;;
      hbom-runtime)
        selected_optional_packages=(
          @cdxgen/cdx-hbom
          @appthreat/cdx-proto
          @bufbuild/protobuf
          "$(resolve_platform_plugin_package_name)"
        )
        ;;
      hbom-slim)
        selected_optional_packages=(@cdxgen/cdx-hbom)
        ;;
      atom-analysis)
        selected_optional_packages=(
          @appthreat/atom
          @appthreat/atom-parsetools
          @appthreat/cdx-proto
          @bufbuild/protobuf
        )
        ;;
      os-runtime)
        selected_optional_packages=(
          @appthreat/cdx-proto
          @bufbuild/protobuf
          "$(resolve_platform_plugin_package_name)"
        )
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
      pnpm --dir "$staging_dir" "${install_args[@]}" --no-optional --no-frozen-lockfile
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

remove_platform_plugins() {
  local staging_dir="$1"

  rm -rf "$staging_dir/node_modules/@cdxgen"/cdxgen-plugins-bin*
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
      assert_package_present "$staging_dir" @appthreat/cdx-proto
      assert_package_present "$staging_dir" @cdxgen/cdx-hbom
      assert_package_present "$staging_dir" jsonata
      platform_plugin_package="$(resolve_platform_plugin_package_name)"
      assert_package_present "$staging_dir" "$platform_plugin_package"
      ;;
    audit)
      assert_package_present "$staging_dir" jsonata
      remove_platform_plugins "$staging_dir"
      assert_package_absent "$staging_dir" @appthreat/atom
      assert_package_absent "$staging_dir" @appthreat/cdx-proto
      ;;
    proto-reader)
      assert_package_present "$staging_dir" @appthreat/cdx-proto
      assert_package_present "$staging_dir" @bufbuild/protobuf
      remove_platform_plugins "$staging_dir"
      assert_package_absent "$staging_dir" jsonata
      assert_package_absent "$staging_dir" @appthreat/atom
      ;;
    hbom-runtime)
      assert_package_present "$staging_dir" @cdxgen/cdx-hbom
      assert_package_present "$staging_dir" @appthreat/cdx-proto
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
      assert_package_absent "$staging_dir" @appthreat/cdx-proto
      assert_package_absent "$staging_dir" jsonata
      ;;
    atom-analysis)
      assert_package_present "$staging_dir" @appthreat/atom
      assert_package_present "$staging_dir" @appthreat/atom-parsetools
      assert_package_present "$staging_dir" @appthreat/cdx-proto
      assert_package_present "$staging_dir" @bufbuild/protobuf
      remove_platform_plugins "$staging_dir"
      assert_package_absent "$staging_dir" @cdxgen/cdx-hbom
      assert_package_absent "$staging_dir" jsonata
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
      assert_package_present "$staging_dir" @appthreat/cdx-proto
      assert_package_present "$staging_dir" @bufbuild/protobuf
      assert_package_absent "$staging_dir" @cdxgen/cdx-hbom
      assert_package_absent "$staging_dir" jsonata
      ;;
    no-optional|json-signature)
      remove_platform_plugins "$staging_dir"
      assert_package_absent "$staging_dir" @appthreat/atom
      assert_package_absent "$staging_dir" @appthreat/cdx-proto
      assert_package_absent "$staging_dir" @cdxgen/cdx-hbom
      assert_package_absent "$staging_dir" jsonata
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
    cbom|obom|saasbom) echo "bin/$1.js" ;;
    cdx-audit) echo "bin/audit.js" ;;
    cdx-verify) echo "bin/verify.js" ;;
    cdx-sign) echo "bin/sign.js" ;;
    cdx-validate) echo "bin/validate.js" ;;
    cdx-convert) echo "bin/convert.js" ;;
    hbom|hbom-slim) echo "bin/hbom.js" ;;
    *) echo "Unknown standalone target: $1" >&2; exit 1 ;;
  esac
}

target_profile() {
  case "$1" in
    cdxgen) echo "cdxgen-full" ;;
    cdxgen-slim) echo "no-optional" ;;
    cbom|saasbom) echo "atom-analysis" ;;
    obom) echo "os-runtime" ;;
    cdx-audit) echo "audit" ;;
    cdx-verify|cdx-sign) echo "json-signature" ;;
    cdx-validate|cdx-convert) echo "proto-reader" ;;
    hbom) echo "hbom-runtime" ;;
    hbom-slim) echo "hbom-slim" ;;
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
  if [[ "$target" == "cbom" || "$target" == "obom" || "$target" == "saasbom" ]]; then
    create_cdxgen_alias_entry_point "$staging_dir" "$target"
  fi
  install_profile_dependencies "$staging_dir" "$profile"
  apply_profile_pruning_and_preflight "$staging_dir" "$profile"
  run_binary_build "$staging_dir" "$target" ".$target-metadata.json" "$entry_point"
  rm -rf "$staging_dir"
}

rm -f \
  cdxgen cdxgen-slim cbom obom saasbom cdx-audit cdx-verify cdx-sign cdx-validate cdx-convert hbom hbom-slim \
  .cdxgen-postbuild.cdx.json .cdxgen-slim-postbuild.cdx.json \
  .cbom-postbuild.cdx.json .obom-postbuild.cdx.json .saasbom-postbuild.cdx.json \
  .cdx-audit-postbuild.cdx.json .cdx-verify-postbuild.cdx.json \
  .cdx-sign-postbuild.cdx.json .cdx-validate-postbuild.cdx.json \
  .cdx-convert-postbuild.cdx.json .hbom-postbuild.cdx.json \
  .hbom-slim-postbuild.cdx.json

while IFS= read -r target; do
  build_target "$target"
done < <(selected_targets)
