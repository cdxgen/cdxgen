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

rm -rf \
  *.cdx.json \
  ADVANCED.md \
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

pnpm install:prod --config.node-linker=hoisted
rm -rf .pnpm-store

build_binary cdxgen .cdxgen-metadata.json bin/cdxgen.js
build_binary cdx-audit .cdx-audit-metadata.json bin/audit.js
build_binary cdx-verify .cdx-verify-metadata.json bin/verify.js
build_binary cdx-sign .cdx-sign-metadata.json bin/sign.js
build_binary cdx-validate .cdx-validate-metadata.json bin/validate.js
build_binary cdx-convert .cdx-convert-metadata.json bin/convert.js

rm -rf node_modules
pnpm install:prod --config.node-linker=hoisted --no-optional
rm -rf .pnpm-store

build_binary cdxgen-slim .cdxgen-slim-metadata.json bin/cdxgen.js

