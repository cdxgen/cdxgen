$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$commonSbomArgs = @(
  "-t",
  "caxa",
  "-t",
  "jar",
  "-t",
  "php",
  "-t",
  "ruby",
  "--lifecycle",
  "post-build",
  "--include-formulation",
  "--no-install-deps"
)

function Invoke-BinaryBuild {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Output,
    [Parameter(Mandatory = $true)]
    [string]$MetadataFile,
    [Parameter(Mandatory = $true)]
    [string]$EntryPoint
  )

  pnpm --package=@appthreat/caxa dlx caxa --input . --metadata-file $MetadataFile --output "$Output.exe" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/$EntryPoint"
  node bin/cdxgen.js @commonSbomArgs -o ".${Output}-postbuild.cdx.json"
  & ".\$Output.exe" --version
  & ".\$Output.exe" --help
}

$cleanupTargets = @(
  "ADVANCED.md",
  "ci",
  "contrib",
  "devenv.*",
  "pyproject.toml",
  "renovate.json",
  "test",
  "tools_config",
  "uv.lock",
  "pnpm-workspace.yaml"
)

foreach ($target in $cleanupTargets) {
  Remove-Item -Path $target -Force -Recurse -ErrorAction SilentlyContinue
}

pnpm install:prod --config.node-linker=hoisted
Remove-Item -Path .pnpm-store -Force -Recurse -ErrorAction SilentlyContinue

Invoke-BinaryBuild -Output "cdxgen" -MetadataFile ".cdxgen-metadata.json" -EntryPoint "bin/cdxgen.js"
Invoke-BinaryBuild -Output "cdx-audit" -MetadataFile ".cdx-audit-metadata.json" -EntryPoint "bin/audit.js"
Invoke-BinaryBuild -Output "cdx-verify" -MetadataFile ".cdx-verify-metadata.json" -EntryPoint "bin/verify.js"
Invoke-BinaryBuild -Output "cdx-sign" -MetadataFile ".cdx-sign-metadata.json" -EntryPoint "bin/sign.js"
Invoke-BinaryBuild -Output "cdx-validate" -MetadataFile ".cdx-validate-metadata.json" -EntryPoint "bin/validate.js"
Invoke-BinaryBuild -Output "cdx-convert" -MetadataFile ".cdx-convert-metadata.json" -EntryPoint "bin/convert.js"

Remove-Item -Path node_modules -Force -Recurse -ErrorAction SilentlyContinue
pnpm install:prod --config.node-linker=hoisted --no-optional
Remove-Item -Path .pnpm-store -Force -Recurse -ErrorAction SilentlyContinue

Invoke-BinaryBuild -Output "cdxgen-slim" -MetadataFile ".cdxgen-slim-metadata.json" -EntryPoint "bin/cdxgen.js"

