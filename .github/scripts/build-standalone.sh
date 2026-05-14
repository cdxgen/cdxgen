#!/usr/bin/env bash
set -euo pipefail

COMMON_SBOM_ARGS=(
  -t caxa
  -t jar
  -t php
  -t ruby
  --lifecycle post-build
  --include-formulation
  --no-install-deps
)

build_binary() {
  local output="$1"
  local metadata_file="$2"
  local entry_point="$3"
  local caxa_args=(
    --input .
    --metadata-file "$metadata_file"
    --output "$output"
  )

  if [[ "$(uname -s)" == "Linux" ]]; then
    caxa_args+=(--upx)
  fi

  caxa_args+=(-- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/$entry_point")

  pnpm --package=@appthreat/caxa dlx caxa "${caxa_args[@]}"
  node bin/cdxgen.js "${COMMON_SBOM_ARGS[@]}" -o ".${output}-postbuild.cdx.json"
  chmod +x "$output"
  "./$output" --version
  "./$output" --help
}

read_optional_dependency_version() {
  local package_name="$1"

  node --input-type=module -e '
    import { readFileSync } from "node:fs";

    const packageName = process.argv[1];
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const packageVersion = packageJson.optionalDependencies?.[packageName];

    if (!packageVersion) {
      console.error(`Missing optional dependency version for ${packageName}`);
      process.exit(1);
    }

    console.log(packageVersion);
  ' "$package_name"
}

install_optional_dependency() {
  local package_name="$1"
  local package_version

  package_version="$(read_optional_dependency_version "$package_name")"
  pnpm add --prod \
    --config.node-linker=hoisted \
    --config.strict-dep-builds=true \
    --package-import-method copy \
    "$package_name@$package_version"
}

prune_hbom_only_plugins() {
  find node_modules -type d \( -path "*/plugins/dosai" -o -path "*/plugins/sourcekitten" -o -path "*/plugins/trivy" \) -prune -exec rm -rf {} +
}

verify_hbom_only_plugins_pruned() {
  local remaining_plugins

  remaining_plugins="$(find node_modules -type d \( -path "*/plugins/dosai" -o -path "*/plugins/sourcekitten" -o -path "*/plugins/trivy" \) -print)"

  if [[ -n "$remaining_plugins" ]]; then
    echo "HBOM SEA preflight failed: expected dosai, sourcekitten, and trivy plugin directories to be pruned before packaging hbom." >&2
    echo "$remaining_plugins" >&2
    exit 1
  fi
}

rm -rf \
  *.cdx.json \
  *.md \
  ci \
  contrib \
  devenv.* \
  pyproject.toml \
  renovate.json \
  semicolon_delimited_script \
  test \
  tools_config \
  uv.lock \
  pnpm-workspace.yaml \
  .versions \
  upx-5.1.0*

find lib -name "*.poku.js" -exec rm -f {} +
rm -rf types

pnpm install:prod --config.node-linker=hoisted
rm -rf .pnpm-store

build_binary cdxgen .cdxgen-metadata.json bin/cdxgen.js
build_binary cdx-audit .cdx-audit-metadata.json bin/audit.js
build_binary cdx-verify .cdx-verify-metadata.json bin/verify.js
build_binary cdx-sign .cdx-sign-metadata.json bin/sign.js
build_binary cdx-validate .cdx-validate-metadata.json bin/validate.js
build_binary cdx-convert .cdx-convert-metadata.json bin/convert.js

prune_hbom_only_plugins
verify_hbom_only_plugins_pruned

build_binary hbom .hbom-metadata.json bin/hbom.js

rm -rf node_modules
pnpm install:prod --config.node-linker=hoisted --no-optional
rm -rf .pnpm-store

build_binary cdxgen-slim .cdxgen-slim-metadata.json bin/cdxgen.js

install_optional_dependency @cdxgen/cdx-hbom
rm -rf .pnpm-store

build_binary hbom-slim .hbom-slim-metadata.json bin/hbom.js
