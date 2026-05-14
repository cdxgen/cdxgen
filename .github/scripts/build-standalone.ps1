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

function Get-OptionalDependencyVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  $packageJson = Get-Content -Path package.json -Raw | ConvertFrom-Json
  $packageVersion = $packageJson.optionalDependencies.PSObject.Properties[$PackageName].Value
  if (-not $packageVersion) {
    throw "Missing optional dependency version for $PackageName"
  }
  return $packageVersion
}

function Install-OptionalDependency {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  $packageVersion = Get-OptionalDependencyVersion -PackageName $PackageName
  pnpm add --prod --config.node-linker=hoisted --config.strict-dep-builds=true --package-import-method copy "$PackageName@$packageVersion"
}

function Remove-HbomOnlyPlugins {
  Get-ChildItem -Path node_modules -Directory -Recurse -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @("dosai", "sourcekitten", "trivy") -and
      $_.FullName -match '[\\/]plugins[\\/](dosai|sourcekitten|trivy)$'
    } |
    ForEach-Object {
      Remove-Item -Path $_.FullName -Force -Recurse -ErrorAction SilentlyContinue
    }
}

function Assert-HbomOnlyPluginsPruned {
  $remainingPlugins = Get-ChildItem -Path node_modules -Directory -Recurse -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @("dosai", "sourcekitten", "trivy") -and
      $_.FullName -match '[\\/]plugins[\\/](dosai|sourcekitten|trivy)$'
    } |
    Select-Object -ExpandProperty FullName

  if ($remainingPlugins) {
    Write-Error "HBOM SEA preflight failed: expected dosai, sourcekitten, and trivy plugin directories to be pruned before packaging hbom."
    $remainingPlugins | ForEach-Object { Write-Error $_ }
    throw "HBOM SEA plugin pruning verification failed"
  }
}

$cleanupTargets = @(
  "*.md",
  "ci",
  "contrib",
  "devenv.*",
  "pyproject.toml",
  "renovate.json",
  "test",
  "types",
  "tools_config",
  "uv.lock",
  "pnpm-workspace.yaml"
)

foreach ($target in $cleanupTargets) {
  Remove-Item -Path $target -Force -Recurse -ErrorAction SilentlyContinue
}

Get-ChildItem -Path lib -Filter "*.poku.js" -Recurse | ForEach-Object {
  Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
}

pnpm install:prod --config.node-linker=hoisted
Remove-Item -Path .pnpm-store -Force -Recurse -ErrorAction SilentlyContinue

Invoke-BinaryBuild -Output "cdxgen" -MetadataFile ".cdxgen-metadata.json" -EntryPoint "bin/cdxgen.js"
Invoke-BinaryBuild -Output "cdx-audit" -MetadataFile ".cdx-audit-metadata.json" -EntryPoint "bin/audit.js"
Invoke-BinaryBuild -Output "cdx-verify" -MetadataFile ".cdx-verify-metadata.json" -EntryPoint "bin/verify.js"
Invoke-BinaryBuild -Output "cdx-sign" -MetadataFile ".cdx-sign-metadata.json" -EntryPoint "bin/sign.js"
Invoke-BinaryBuild -Output "cdx-validate" -MetadataFile ".cdx-validate-metadata.json" -EntryPoint "bin/validate.js"
Invoke-BinaryBuild -Output "cdx-convert" -MetadataFile ".cdx-convert-metadata.json" -EntryPoint "bin/convert.js"
Remove-HbomOnlyPlugins
Assert-HbomOnlyPluginsPruned
Invoke-BinaryBuild -Output "hbom" -MetadataFile ".hbom-metadata.json" -EntryPoint "bin/hbom.js"

Remove-Item -Path node_modules -Force -Recurse -ErrorAction SilentlyContinue
pnpm install:prod --config.node-linker=hoisted --no-optional
Remove-Item -Path .pnpm-store -Force -Recurse -ErrorAction SilentlyContinue

Invoke-BinaryBuild -Output "cdxgen-slim" -MetadataFile ".cdxgen-slim-metadata.json" -EntryPoint "bin/cdxgen.js"

Install-OptionalDependency -PackageName "@cdxgen/cdx-hbom"
Remove-Item -Path .pnpm-store -Force -Recurse -ErrorAction SilentlyContinue

Invoke-BinaryBuild -Output "hbom-slim" -MetadataFile ".hbom-slim-metadata.json" -EntryPoint "bin/hbom.js"
