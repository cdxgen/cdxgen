$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$defaultTargets = @(
  "aibom",
  "cdxgen",
  "cdxgen-slim",
  "cbom",
  "obom",
  "saasbom",
  "cdx-audit",
  "cdx-verify",
  "cdx-sign",
  "cdx-validate",
  "cdx-convert",
  "hbom",
  "hbom-slim"
)

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

$caxaPackage = if ($env:CAXA_PACKAGE) { $env:CAXA_PACKAGE } else { "@cdxgen/caxa@^3.0.3" }
$stagingDirs = [System.Collections.Generic.List[string]]::new()
$sharedPnpmStore = if ($env:STANDALONE_PNPM_STORE) { $env:STANDALONE_PNPM_STORE } else { Join-Path ([System.IO.Path]::GetTempPath()) "cdxgen-standalone-pnpm-store-$PID" }
$slimMaxBytes = if ($env:STANDALONE_SLIM_MAX_BYTES) { [int64]$env:STANDALONE_SLIM_MAX_BYTES } else { 104857600 }
$fatMaxBytes = if ($env:STANDALONE_FAT_MAX_BYTES) { [int64]$env:STANDALONE_FAT_MAX_BYTES } else { 251658240 }

function Remove-StagingDirs {
  foreach ($stagingDir in $stagingDirs) {
    if ($stagingDir -and (Test-Path $stagingDir)) {
      Remove-Item -Path $stagingDir -Force -Recurse -ErrorAction SilentlyContinue
    }
  }
  if (-not $env:STANDALONE_PNPM_STORE -and $sharedPnpmStore -and (Test-Path $sharedPnpmStore)) {
    Remove-Item -Path $sharedPnpmStore -Force -Recurse -ErrorAction SilentlyContinue
  }
}

function Assert-BinarySizeLimit {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Output
  )

  $maxBytes = if ($Output.EndsWith("-slim")) { $slimMaxBytes } else { $fatMaxBytes }
  $outputFile = "$Output.exe"
  $sizeBytes = (Get-Item -Path $outputFile).Length
  if ($sizeBytes -gt $maxBytes) {
    throw "Standalone binary size check failed: $outputFile is $sizeBytes bytes, limit is $maxBytes bytes."
  }
  Write-Host "Standalone binary size check passed: $outputFile is $sizeBytes bytes (limit $maxBytes)."
}

function Invoke-BinaryBuildFromStage {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StagingDir,
    [Parameter(Mandatory = $true)]
    [string]$Output,
    [Parameter(Mandatory = $true)]
    [string]$MetadataFile,
    [Parameter(Mandatory = $true)]
    [string]$EntryPoint
  )

  pnpm --package=$caxaPackage dlx caxa --input $StagingDir --metadata-file $MetadataFile --output "$Output.exe" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/$EntryPoint"
  node (Join-Path $StagingDir "bin/cdxgen.js") @commonSbomArgs -o ".${Output}-postbuild.cdx.json"
  & ".\$Output.exe" --version
  & ".\$Output.exe" --help
  Assert-BinarySizeLimit -Output $Output
}

function Promote-OptionalDependencies {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StagingDir,
    [Parameter(Mandatory = $true)]
    [string[]]$PackageNames
  )

  if (-not $PackageNames -or $PackageNames.Count -eq 0) {
    return
  }

  $packageJsonFile = Join-Path $StagingDir "package.json"
  $packageJson = Get-Content -Path $packageJsonFile -Raw | ConvertFrom-Json -AsHashtable
  if (-not $packageJson.ContainsKey("dependencies")) {
    $packageJson["dependencies"] = [ordered]@{}
  }
  foreach ($packageName in $PackageNames) {
    $packageVersion = $packageJson["optionalDependencies"][$packageName]
    if (-not $packageVersion) {
      throw "Missing optional dependency version for $packageName"
    }
    $packageJson["dependencies"][$packageName] = $packageVersion
    $packageJson["optionalDependencies"].Remove($packageName)
  }
  $packageJson | ConvertTo-Json -Depth 20 | Set-Content -Path $packageJsonFile -Encoding utf8
}

function Resolve-PlatformPluginPackageName {
  $packageJson = Get-Content -Path package.json -Raw | ConvertFrom-Json
  $targetOs = if ($env:TARGET_OS) { $env:TARGET_OS } else { "windows" }
  $targetArch = if ($env:TARGET_ARCH) { $env:TARGET_ARCH } else {
    if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) { "arm64" } else { "amd64" }
  }
  $targetLibc = if ($env:TARGET_LIBC) { $env:TARGET_LIBC } else { "gnu" }
  $packageName = "@cdxgen/cdxgen-plugins-bin-$targetOs-$targetArch"

  if ($targetOs -eq "linux" -and $targetLibc -eq "musl") {
    $packageName = "@cdxgen/cdxgen-plugins-bin-linuxmusl-$targetArch"
  }

  if (-not $packageJson.optionalDependencies.PSObject.Properties[$packageName].Value) {
    throw "Missing platform plugin optional dependency for $targetOs/$targetArch/$targetLibc`: $packageName"
  }

  return $packageName
}

function Copy-RuntimeSources {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StagingDir
  )

  New-Item -Path $StagingDir -ItemType Directory -Force | Out-Null
  Copy-Item -Path package.json, pnpm-lock.yaml -Destination $StagingDir -Force
  if (Test-Path .pnpmfile.cjs) {
    Copy-Item -Path .pnpmfile.cjs -Destination $StagingDir -Force
  }
  Copy-Item -Path bin, data, lib -Destination $StagingDir -Force -Recurse
  if (Test-Path plugins) {
    Copy-Item -Path plugins -Destination $StagingDir -Force -Recurse
  }
  if (Test-Path index.cjs) {
    Copy-Item -Path index.cjs -Destination $StagingDir -Force
  }
  Get-ChildItem -Path (Join-Path $StagingDir "lib") -Filter "*.poku.js" -Recurse | ForEach-Object {
    Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
  }
}

function New-CdxgenAliasEntryPoint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StagingDir,
    [Parameter(Mandatory = $true)]
    [string]$CommandName
  )

  $wrapperFile = Join-Path $StagingDir "bin/$CommandName.js"
  @'
#!/usr/bin/env node
process.argv[1] = new URL(import.meta.url).pathname;
await import("./cdxgen.js");
'@ | Set-Content -Path $wrapperFile -Encoding utf8
}

function Install-ProfileDependencies {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StagingDir,
    [Parameter(Mandatory = $true)]
    [string]$Profile
  )

  $selectedOptionalPackages = @()

  $installArgs = @(
    "--dir", $StagingDir,
    "install",
    "--config.strict-dep-builds=true",
    "--config.node-linker=hoisted",
    "--package-import-method", "copy",
    "--prod",
    "--store-dir", $sharedPnpmStore
  )

  if ($Profile -eq "cdxgen-full") {
    pnpm @installArgs --frozen-lockfile
  } else {
    switch ($Profile) {
      "audit" { $selectedOptionalPackages = @("jsonata") }
      "proto-reader" { $selectedOptionalPackages = @("@cdxgen/cdx-proto", "@bufbuild/protobuf") }
      "hbom-runtime" { $selectedOptionalPackages = @("@cdxgen/cdx-hbom", "@cdxgen/cdx-proto", "@bufbuild/protobuf", (Resolve-PlatformPluginPackageName)) }
      "hbom-slim" { $selectedOptionalPackages = @("@cdxgen/cdx-hbom") }
      "atom-analysis" { $selectedOptionalPackages = @("@appthreat/atom", "@appthreat/atom-parsetools", "@cdxgen/cdx-proto", "@bufbuild/protobuf") }
      "os-runtime" { $selectedOptionalPackages = @("@cdxgen/cdx-proto", "@bufbuild/protobuf", (Resolve-PlatformPluginPackageName)) }
      { $_ -in @("no-optional", "json-signature") } { }
      default { throw "Unknown standalone dependency profile: $Profile" }
    }
    if ($selectedOptionalPackages.Count -gt 0) {
      Promote-OptionalDependencies -StagingDir $StagingDir -PackageNames $selectedOptionalPackages
      pnpm @installArgs --no-optional --no-frozen-lockfile
    } else {
      pnpm @installArgs --no-optional --frozen-lockfile
    }
  }
}

function Get-ModulePathForPackage {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StagingDir,
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  return Join-Path (Join-Path $StagingDir "node_modules") $PackageName
}

function Assert-PackagePresent {
  param([string]$StagingDir, [string]$PackageName)
  $packagePath = Get-ModulePathForPackage -StagingDir $StagingDir -PackageName $PackageName
  if (-not (Test-Path $packagePath)) {
    throw "Standalone profile preflight failed: expected $PackageName in $StagingDir"
  }
}

function Assert-PackageAbsent {
  param([string]$StagingDir, [string]$PackageName)
  $packagePath = Get-ModulePathForPackage -StagingDir $StagingDir -PackageName $PackageName
  if (Test-Path $packagePath) {
    throw "Standalone profile preflight failed: did not expect $PackageName in $StagingDir"
  }
}

function Remove-PlatformPlugins {
  param([string]$StagingDir)
  $cdxgenScopeDir = Join-Path $StagingDir "node_modules/@cdxgen"
  if (Test-Path $cdxgenScopeDir) {
    Get-ChildItem -Path $cdxgenScopeDir -Directory -Filter "cdxgen-plugins-bin*" -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item -Path $_.FullName -Force -Recurse -ErrorAction SilentlyContinue
    }
  }
}

function Prune-PluginsToAllowlist {
  param([string]$StagingDir, [string[]]$AllowedPlugins)
  $cdxgenScopeDir = Join-Path $StagingDir "node_modules/@cdxgen"
  if (-not (Test-Path $cdxgenScopeDir)) { return }
  Get-ChildItem -Path $cdxgenScopeDir -Directory -Filter "cdxgen-plugins-bin*" -ErrorAction SilentlyContinue | ForEach-Object {
    $pluginRoot = Join-Path $_.FullName "plugins"
    if (Test-Path $pluginRoot) {
      Get-ChildItem -Path $pluginRoot -Force | ForEach-Object {
        if ($_.Name -ne "plugins-manifest.json" -and $AllowedPlugins -notcontains $_.Name) {
          Remove-Item -Path $_.FullName -Force -Recurse -ErrorAction SilentlyContinue
        }
      }
    }
  }
}

function Assert-PluginAllowlist {
  param([string]$StagingDir, [string[]]$AllowedPlugins)
  $cdxgenScopeDir = Join-Path $StagingDir "node_modules/@cdxgen"
  if (-not (Test-Path $cdxgenScopeDir)) { return }
  Get-ChildItem -Path $cdxgenScopeDir -Directory -Filter "cdxgen-plugins-bin*" -ErrorAction SilentlyContinue | ForEach-Object {
    $pluginRoot = Join-Path $_.FullName "plugins"
    if (Test-Path $pluginRoot) {
      Get-ChildItem -Path $pluginRoot -Force | ForEach-Object {
        if ($_.Name -ne "plugins-manifest.json" -and $AllowedPlugins -notcontains $_.Name) {
          throw "Standalone profile preflight failed: unexpected plugin directory $($_.FullName)"
        }
      }
    }
  }
}

function Invoke-ProfilePruningAndPreflight {
  param([string]$StagingDir, [string]$Profile)
  switch ($Profile) {
    "cdxgen-full" {
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-proto"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-hbom"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "jsonata"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName (Resolve-PlatformPluginPackageName)
    }
    "audit" {
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "jsonata"
      Remove-PlatformPlugins -StagingDir $StagingDir
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "@appthreat/atom"
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-proto"
    }
    "proto-reader" {
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-proto"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@bufbuild/protobuf"
      Remove-PlatformPlugins -StagingDir $StagingDir
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "jsonata"
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "@appthreat/atom"
    }
    "hbom-runtime" {
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-hbom"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-proto"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName (Resolve-PlatformPluginPackageName)
      Prune-PluginsToAllowlist -StagingDir $StagingDir -AllowedPlugins @("osquery", "trustinspector")
      Assert-PluginAllowlist -StagingDir $StagingDir -AllowedPlugins @("osquery", "trustinspector")
    }
    "hbom-slim" {
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-hbom"
      Remove-PlatformPlugins -StagingDir $StagingDir
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-proto"
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "jsonata"
    }
    "atom-analysis" {
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@appthreat/atom"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@appthreat/atom-parsetools"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-proto"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@bufbuild/protobuf"
      Remove-PlatformPlugins -StagingDir $StagingDir
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-hbom"
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "jsonata"
    }
    "os-runtime" {
      Assert-PackagePresent -StagingDir $StagingDir -PackageName (Resolve-PlatformPluginPackageName)
      Prune-PluginsToAllowlist -StagingDir $StagingDir -AllowedPlugins @("osquery", "trustinspector")
      Assert-PluginAllowlist -StagingDir $StagingDir -AllowedPlugins @("osquery", "trustinspector")
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "@appthreat/atom"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-proto"
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@bufbuild/protobuf"
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-hbom"
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "jsonata"
    }
    { $_ -in @("no-optional", "json-signature") } {
      Remove-PlatformPlugins -StagingDir $StagingDir
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "@appthreat/atom"
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-proto"
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "@cdxgen/cdx-hbom"
      Assert-PackageAbsent -StagingDir $StagingDir -PackageName "jsonata"
    }
    default { throw "Unknown standalone dependency profile: $Profile" }
  }
}

function Get-TargetEntryPoint {
  param([string]$Target)
  switch ($Target) {
    { $_ -in @("aibom", "cdxgen", "cdxgen-slim") } { return "bin/cdxgen.js" }
    { $_ -in @("cbom", "obom", "saasbom") } { return "bin/$Target.js" }
    "cdx-audit" { return "bin/audit.js" }
    "cdx-verify" { return "bin/verify.js" }
    "cdx-sign" { return "bin/sign.js" }
    "cdx-validate" { return "bin/validate.js" }
    "cdx-convert" { return "bin/convert.js" }
    { $_ -in @("hbom", "hbom-slim") } { return "bin/hbom.js" }
    default { throw "Unknown standalone target: $Target" }
  }
}

function Get-TargetProfile {
  param([string]$Target)
  switch ($Target) {
    "aibom" { return "no-optional" }
    "cdxgen" { return "cdxgen-full" }
    "cdxgen-slim" { return "no-optional" }
    { $_ -in @("cbom", "saasbom") } { return "atom-analysis" }
    "obom" { return "os-runtime" }
    "cdx-audit" { return "audit" }
    { $_ -in @("cdx-verify", "cdx-sign") } { return "json-signature" }
    { $_ -in @("cdx-validate", "cdx-convert") } { return "proto-reader" }
    "hbom" { return "hbom-runtime" }
    "hbom-slim" { return "hbom-slim" }
    default { throw "Unknown standalone target: $Target" }
  }
}

function Get-SelectedTargets {
  if (-not $env:STANDALONE_TARGETS) {
    return $defaultTargets
  }
  return $env:STANDALONE_TARGETS -split '[,\s]+' | Where-Object { $_ }
}

function Invoke-StandaloneTargetBuild {
  param([string]$Target)
  $profile = Get-TargetProfile -Target $Target
  $entryPoint = Get-TargetEntryPoint -Target $Target
  $stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) "cdxgen-standalone-$Target-$PID-$([System.Guid]::NewGuid().ToString('N'))"
  $stagingDirs.Add($stagingDir)

  Write-Host "Building $Target with standalone profile $profile"
  Copy-RuntimeSources -StagingDir $stagingDir
  if ($Target -in @("aibom", "cbom", "obom", "saasbom")) {
    New-CdxgenAliasEntryPoint -StagingDir $stagingDir -CommandName $Target
  }
  Install-ProfileDependencies -StagingDir $stagingDir -Profile $profile
  Invoke-ProfilePruningAndPreflight -StagingDir $stagingDir -Profile $profile
  Invoke-BinaryBuildFromStage -StagingDir $stagingDir -Output $Target -MetadataFile ".$Target-metadata.json" -EntryPoint $entryPoint
  Remove-Item -Path $stagingDir -Force -Recurse -ErrorAction SilentlyContinue
}

try {
  Remove-Item -Path aibom.exe, cdxgen.exe, cdxgen-slim.exe, cbom.exe, obom.exe, saasbom.exe, cdx-audit.exe, cdx-verify.exe, cdx-sign.exe, cdx-validate.exe, cdx-convert.exe, hbom.exe, hbom-slim.exe -Force -ErrorAction SilentlyContinue
  Remove-Item -Path .aibom-postbuild.cdx.json, .cdxgen-postbuild.cdx.json, .cdxgen-slim-postbuild.cdx.json, .cbom-postbuild.cdx.json, .obom-postbuild.cdx.json, .saasbom-postbuild.cdx.json, .cdx-audit-postbuild.cdx.json, .cdx-verify-postbuild.cdx.json, .cdx-sign-postbuild.cdx.json, .cdx-validate-postbuild.cdx.json, .cdx-convert-postbuild.cdx.json, .hbom-postbuild.cdx.json, .hbom-slim-postbuild.cdx.json -Force -ErrorAction SilentlyContinue
  foreach ($target in Get-SelectedTargets) {
    Invoke-StandaloneTargetBuild -Target $target
  }
} finally {
  Remove-StagingDirs
}
