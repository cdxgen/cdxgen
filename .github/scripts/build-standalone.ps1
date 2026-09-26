$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# `$ErrorActionPreference` governs PowerShell errors, not the exit codes of
# native commands. Without this, a failed `pnpm install` or a binary that
# crashes on `--version` is ignored and the script carries on to report some
# later, unrelated symptom. The bash sibling gets this from `set -e`.
$PSNativeCommandUseErrorActionPreference = $true

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

$caxaPackage = if ($env:CAXA_PACKAGE) { $env:CAXA_PACKAGE } else { "@cdxgen/caxa@^3.1.0" }
$stagingDirs = [System.Collections.Generic.List[string]]::new()
$sharedPnpmStore = if ($env:STANDALONE_PNPM_STORE) { $env:STANDALONE_PNPM_STORE } else { Join-Path ([System.IO.Path]::GetTempPath()) "cdxgen-standalone-pnpm-store-$PID" }
$slimMaxBytes = if ($env:STANDALONE_SLIM_MAX_BYTES) { [int64]$env:STANDALONE_SLIM_MAX_BYTES } else { 104857600 }
$fatMaxBytes = if ($env:STANDALONE_FAT_MAX_BYTES) { [int64]$env:STANDALONE_FAT_MAX_BYTES } else { 301989888 }

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
  if ($Output -in @("cdxgen", "cbom", "saasbom")) {
    Invoke-AtomSmokeTest -Output $Output
  }
  Assert-BinarySizeLimit -Output $Output
}

# See the run_atom_smoke_test comment in build-standalone.sh for why this
# fixture discriminates: the C tree carries no build manifest, so its entire
# component inventory comes from `atom parsedeps`. The disabled-atom control
# run keeps that property honest.
function Get-BomComponentCount {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path $Path)) { return 0 }
  $bom = Get-Content -Path $Path -Raw | ConvertFrom-Json
  return @($bom.components).Count
}

function Invoke-AtomSmokeTest {
  param([Parameter(Mandatory = $true)][string]$Output)

  $fixture = "test/data/evinse-cpp-repotest"
  $smokeOut = ".${Output}-atom-smoke.json"
  $controlOut = ".${Output}-atom-smoke-control.json"
  $atomPkg = Resolve-AtomPlatformPackageName
  $kind = Get-AtomPayloadKindForPackage -PackageName $atomPkg
  if ($kind -eq "jar") {
    $java = Get-Command java -ErrorAction SilentlyContinue
    if (-not $java) {
      Write-Host "atom smoke test: jar flavour ($atomPkg), JDK unavailable, skipped."
      return
    }
  }
  Write-Host "atom smoke test: .\$Output.exe against $fixture (provider=$atomPkg, kind=$kind)"

  if (Test-Path $controlOut) { Remove-Item $controlOut -Force }
  $previousAtomCmd = $env:ATOM_CMD
  try {
    $env:ATOM_CMD = "cmd.exe /c exit 1"
    & ".\$Output.exe" -t c $fixture -o $controlOut *> $null
  } finally {
    if ($null -eq $previousAtomCmd) { Remove-Item Env:\ATOM_CMD -ErrorAction SilentlyContinue }
    else { $env:ATOM_CMD = $previousAtomCmd }
  }
  $controlCount = Get-BomComponentCount -Path $controlOut
  if (Test-Path $controlOut) { Remove-Item $controlOut -Force }
  if ($controlCount -ne 0) {
    throw "atom smoke test FAILED: the negative control produced $controlCount component(s) with atom disabled, so this fixture no longer proves atom ran."
  }

  if (Test-Path $smokeOut) { Remove-Item $smokeOut -Force }
  & ".\$Output.exe" -t c $fixture -o $smokeOut --fail-on-error
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "atom smoke test FAILED: .$Output.exe exited with code $exitCode."
  }
  $smokeCount = Get-BomComponentCount -Path $smokeOut
  if (Test-Path $smokeOut) { Remove-Item $smokeOut -Force }
  if ($smokeCount -eq 0) {
    throw "atom smoke test FAILED: no components produced; the atom payload is missing or did not run."
  }
  Write-Host "atom smoke test: $smokeCount component(s) from atom, 0 from the disabled-atom control."
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
  # Everything still in optionalDependencies is not wanted by this profile.
  # Dropping it here is what lets the install run with optional resolution
  # enabled; see the comment in promote_optional_dependencies in
  # build-standalone.sh for why `--no-optional` cannot be used with atom 3.
  $packageJson.Remove("optionalDependencies")
  $packageJson | ConvertTo-Json -Depth 20 | Set-Content -Path $packageJsonFile -Encoding utf8
}

function Resolve-AtomPlatformPackageName {
  $targetOs = if ($env:TARGET_OS) { $env:TARGET_OS } else { "windows" }
  $targetArch = if ($env:TARGET_ARCH) { $env:TARGET_ARCH } else {
    if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) { "arm64" } else { "amd64" }
  }
  $targetLibc = if ($env:TARGET_LIBC) { $env:TARGET_LIBC } else { "gnu" }
  $packageName = $null
  if ($targetOs -eq "linux") {
    if ($targetArch -eq "amd64") {
      $packageName = if ($targetLibc -eq "musl") { "@appthreat/atom-linux-amd64-musl" } else { "@appthreat/atom-linux-amd64" }
    } elseif ($targetArch -eq "arm64") {
      $packageName = if ($targetLibc -eq "musl") { "@appthreat/atom-linux-arm64-musl" } else { "@appthreat/atom-linux-arm64" }
    }
  } elseif ($targetOs -eq "darwin") {
    if ($targetArch -eq "amd64") { $packageName = "@appthreat/atom-darwin-amd64" }
    elseif ($targetArch -eq "arm64") { $packageName = "@appthreat/atom-darwin-arm64" }
  } elseif ($targetOs -eq "windows") {
    if ($targetArch -eq "amd64") { $packageName = "@appthreat/atom-windows-amd64" }
    elseif ($targetArch -eq "arm64") { $packageName = "@appthreat/atom-windows-arm64" }
  }
  if (-not $packageName) {
    throw "Unmapped atom platform triple: $targetOs/$targetArch/$targetLibc"
  }
  return $packageName
}

function Get-AtomPayloadKindForPackage {
  param([string]$PackageName)
  switch ($PackageName) {
    { $_ -in @("@appthreat/atom-linux-amd64", "@appthreat/atom-linux-arm64", "@appthreat/atom-darwin-arm64", "@appthreat/atom-linux-amd64-musl", "@appthreat/atom-windows-amd64") } { return "native" }
    default { return "jar" }
  }
}

function Assert-AtomPayloadPresent {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StagingDir,
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )
  $kind = Get-AtomPayloadKindForPackage -PackageName $PackageName
  if ($kind -eq "native") {
    $payloadPath = Join-Path $StagingDir "node_modules/$PackageName/bin/atom.exe"
  } else {
    $payloadPath = Join-Path $StagingDir "node_modules/$PackageName/plugins"
  }
  if (-not (Test-Path $payloadPath)) {
    throw "Standalone atom payload missing: $payloadPath (kind=$kind). The dispatcher would be payload-less."
  }
  Write-Host "Standalone atom payload present: $payloadPath (kind=$kind)."
}

# See remove_redundant_atom_jar in build-standalone.sh: atom-jar is an
# unconstrained optional dependency of @appthreat/atom that the resolver only
# uses when the target's platform sub-package is missing, and that payload has
# just been asserted.
function Remove-RedundantAtomJar {
  param(
    [Parameter(Mandatory = $true)]
    [string]$StagingDir,
    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )
  if ($PackageName -eq "@appthreat/atom-jar") {
    return
  }
  $nodeModules = Join-Path $StagingDir "node_modules"
  $findAtomJar = {
    Get-ChildItem -Path $nodeModules -Directory -Recurse -Force -Filter "atom-jar" -ErrorAction SilentlyContinue |
      Where-Object { (Split-Path -Leaf (Split-Path -Parent $_.FullName)) -eq "@appthreat" }
  }
  & $findAtomJar | ForEach-Object { Remove-Item -Path $_.FullName -Force -Recurse }
  if (& $findAtomJar) {
    throw "Standalone profile preflight failed: @appthreat/atom-jar is still present in $StagingDir"
  }
  Write-Host "Removed @appthreat/atom-jar: the $PackageName payload is what atom resolves."
  Assert-PackagePresent -StagingDir $StagingDir -PackageName $PackageName
  Assert-AtomPayloadPresent -StagingDir $StagingDir -PackageName $PackageName
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
  # pnpm 11 and later read `overrides` from pnpm-workspace.yaml rather than the `pnpm`
  # field of package.json. Without it here the staging install disagrees with
  # the lockfile it was given (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH under
  # --frozen-lockfile) and produces an incomplete node_modules otherwise. The
  # `packages:` key is filtered defensively: the repo has no workspace members
  # today, but a staging tree can never have them, and a `packages:` glob that
  # matches nothing there fails the install. Kept in step with
  # copy_runtime_sources in build-standalone.sh.
  if (Test-Path pnpm-workspace.yaml) {
    $skippingPackages = $false
    $workspaceLines = foreach ($line in Get-Content -Path pnpm-workspace.yaml) {
      if ($line -match '^packages:') {
        $skippingPackages = $true
        continue
      }
      if ($skippingPackages -and $line -match '^\s*-') {
        continue
      }
      $skippingPackages = $false
      $line
    }
    Set-Content -Path (Join-Path $StagingDir "pnpm-workspace.yaml") -Value $workspaceLines -Encoding utf8
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
      # atom 3's payload is a per-platform sub-package of @appthreat/atom, not
      # named here: pnpm picks the one matching the target's os/cpu/libc once
      # optional resolution is enabled. Asserted explicitly below. Kept in step
      # with build-standalone.sh.
      "atom-analysis" { $selectedOptionalPackages = @("@appthreat/atom", "@appthreat/atom-parsetools", "@cdxgen/cdx-proto", "@bufbuild/protobuf") }
      "os-runtime" { $selectedOptionalPackages = @("@cdxgen/cdx-proto", "@bufbuild/protobuf", (Resolve-PlatformPluginPackageName)) }
      { $_ -in @("no-optional", "json-signature") } { }
      default { throw "Unknown standalone dependency profile: $Profile" }
    }
    if ($selectedOptionalPackages.Count -gt 0) {
      Promote-OptionalDependencies -StagingDir $StagingDir -PackageNames $selectedOptionalPackages
      pnpm @installArgs --no-frozen-lockfile
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
      Assert-PackagePresent -StagingDir $StagingDir -PackageName "@appthreat/atom"
      # Local builds may run on a host with no atom platform package, where
      # atom-jar is the only payload and must stay.
      $fullAtomPkg = $null
      try { $fullAtomPkg = Resolve-AtomPlatformPackageName } catch { $fullAtomPkg = $null }
      if ($fullAtomPkg) {
        Assert-PackagePresent -StagingDir $StagingDir -PackageName $fullAtomPkg
        Assert-AtomPayloadPresent -StagingDir $StagingDir -PackageName $fullAtomPkg
        Remove-RedundantAtomJar -StagingDir $StagingDir -PackageName $fullAtomPkg
      } else {
        Write-Host "No atom platform package for this target; keeping @appthreat/atom-jar."
      }
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
      $atomPkg = Resolve-AtomPlatformPackageName
      Assert-PackagePresent -StagingDir $StagingDir -PackageName $atomPkg
      Assert-AtomPayloadPresent -StagingDir $StagingDir -PackageName $atomPkg
      Remove-RedundantAtomJar -StagingDir $StagingDir -PackageName $atomPkg
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
