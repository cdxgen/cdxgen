# cdx: Custom Properties

This page documents the current `cdx:` custom properties emitted by cdxgen, the ecosystems they map to, and practical supply-chain security/assurance use cases.

## Scope

- Source of truth: non-test source files under `lib/**` (including `lib/helpers/utils.js` and `lib/helpers/ciParsers/*`).
- These are cdxgen-specific properties added to CycloneDX objects (components, workflows, tasks, metadata, and services).
- They are intended to enrich analysis and policy decisions; they are not CycloneDX core fields.

## How to read these properties

Some CI/CD properties are derived from a workflow or job context but may also be duplicated onto related components/tasks to support policy engines that primarily scan `input.components`. In those cases, treat the `Scope` column as indicating the primary origin plus common duplicated locations used for policy consumption.

### Value semantics and normalization

CycloneDX custom properties are emitted as name/value pairs, so consumers should assume that **all values are serialized as strings** even when they represent booleans, numbers, timestamps, or structured data.

| Shape               | Typical encoding                             | Examples                                                                                  | Policy note                                                                                                                                                       |
| ------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boolean             | `"true"`, `"false"`                          | `cdx:github:workflow:hasWritePermissions`, `cdx:npm:hasInstallScript`, `cdx:maven:shaded` | Compare as strings in OPA/CEL unless your ingestion layer normalizes values first                                                                                 |
| Number-like         | decimal string                               | `cdx:github:job:timeoutMinutes`, `cdx:pixi:build_number`                                  | Treat as strings unless your policy engine performs numeric coercion                                                                                              |
| Lists               | comma-separated or newline-separated strings | `cdx:github:workflow:triggers`, `cdx:npm:risky_scripts`, `cdx:bom:componentSrcFiles`      | Component-level lists are typically comma-separated; BOM-level metadata lists are typically newline-separated. Split explicitly before matching multi-value logic |
| Paths / URLs        | plain string                                 | `cdx:github:workflow:file`, `cdx:swift:localCheckoutPath`, `cdx:pypi:registry`            | Useful as provenance and source-of-truth signals                                                                                                                  |
| Timestamps          | ISO 8601 string                              | `cdx:go:creation_time`, `cdx:nix:last_modified`                                           | Suitable for recency or reproducibility gates                                                                                                                     |
| Structured payloads | JSON-serialized string                       | `cdx:pip:structuredMarkers`, `cdx:cargo:features`                                         | Parse the JSON string before field-level inspection; do not compare nested fields as raw text unless your policy engine lacks JSON parsing                        |

### Policy readiness shorthand

- **Hard deny**: good primary candidate for blocking policies.
- **Warning / triage**: useful for prioritization, human review, or score weighting.
- **Context only**: useful for evidence, provenance, explainability, or enrichment, but usually weak as a standalone gate.

## Property families, ecosystems, and assurance use cases

| Family                                                                     | Ecosystem / context                                       | What it captures                                                                                                    | Security & assurance use cases                                                                                                                                   | Inventory                                                            | Example rules                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------- |
| `cdx:github:*`, `cdx:actions:*`                                            | GitHub Actions workflows                                  | Workflow/job/step metadata, action references, version pinning style, permission posture, triggers, runner context  | Detect unpinned actions, flag workflows/jobs with write privileges, validate OIDC (`id-token`) usage boundaries, review exposure by trigger type and environment | [CI/CD and workflow provenance](#inventory-cicd)                     | [1](#example-1), [6](#example-6) |
| `cdx:gitlab:*`                                                             | GitLab CI                                                 | Pipeline/job stage/image/environment/services/needs metadata                                                        | Review pipeline trust boundaries, identify risky service/image usage, validate stage/order dependency intent                                                     | [CI/CD and workflow provenance](#inventory-cicd)                     | [1](#example-1)                  |
| `cdx:azure:*`                                                              | Azure Pipelines                                           | Pipeline file, pool image, trigger branches, stage/job dependencies and conditions                                  | Detect privileged runner pools, verify deployment gating/conditions, ensure branch-scoped execution policy                                                       | [CI/CD and workflow provenance](#inventory-cicd)                     | [1](#example-1)                  |
| `cdx:circleci:*`                                                           | CircleCI                                                  | Config/workflow/job relationships, branch filters, orb/executor references                                          | Verify job execution constraints (branch-only), inspect third-party orb use, map build graph for provenance review                                               | [CI/CD and workflow provenance](#inventory-cicd)                     | [1](#example-1)                  |
| `cdx:jenkins:*`                                                            | Jenkins declarative pipelines                             | Jenkinsfile source, agent selection, stage metadata (`when`, `parallel`)                                            | Audit build agent trust model, identify conditional/parallel execution complexity and potential bypass paths                                                     | [CI/CD and workflow provenance](#inventory-cicd)                     | [1](#example-1)                  |
| `cdx:npm:*`, `cdx:pnpm:alias`                                              | Node.js (npm/pnpm)                                        | Binary/script execution surfaces, native addon signals, lock/runtime mismatches, local/path/workspace/alias details | Prioritize packages with install-time execution risk, detect name/version spoofing indicators, identify non-registry or file-based dependencies                  | [Package manager and language ecosystems](#inventory-packages)       | [2](#example-2)                  |
| `cdx:pypi:*`, `cdx:pip:*`, `cdx:pyproject:*`, `cdx:python:*`, `cdx:pixi:*` | Python (pip/requirements, pyproject, lock formats, pixi)  | Version constraints, extras, environment markers, registry origin, interpreter constraints, pixi build metadata     | Enforce allowed index/registry policy, evaluate conditional dependency exposure by marker, detect drift from latest known version and unresolved naming          | [Package manager and language ecosystems](#inventory-packages)       | [3](#example-3)                  |
| `cdx:gem:*`                                                                | RubyGems/Bundler                                          | Gem platform/source/revision/tag/branch, ruby constraints, executable presence, prerelease/yanked status            | Detect mutable VCS-sourced gems, platform-specific attack surface, and yanked/prerelease risk in resolved dependency sets                                        | [Package manager and language ecosystems](#inventory-packages)       | [3](#example-3)                  |
| `cdx:cargo:*`                                                              | Rust crates.io                                            | Crate metadata linkage (id/latest/rust version/features)                                                            | Validate Rust toolchain compatibility, flag feature-driven attack surface changes, monitor lag from newest upstream version                                      | [Package manager and language ecosystems](#inventory-packages)       | [4](#example-4)                  |
| `cdx:go:*`                                                                 | Go modules                                                | Toolchain, indirect/deprecated/local replacement timing metadata                                                    | Detect local replacements/non-hermetic resolution, track deprecated modules, validate direct vs indirect risk posture                                            | [Package manager and language ecosystems](#inventory-packages)       | [4](#example-4)                  |
| `cdx:dotnet:*`                                                             | .NET / NuGet / assemblies                                 | Target framework, project guid, assembly identity/version, hint path, Azure Functions version                       | Verify framework support policy, detect assembly/package identity mismatches, analyze implicit GAC/hint-path sourced dependencies                                | [Package manager and language ecosystems](#inventory-packages)       | [5](#example-5)                  |
| `cdx:maven:*`, `cdx:gradle:*`                                              | Java (Maven/Gradle)                                       | Effective component scope, shaded namespace evidence, Gradle root path context                                      | Identify shadowed/relocated classes (obfuscation or vendoring risk), enforce dependency-scope policy, track monorepo/root provenance                             | [Package manager and language ecosystems](#inventory-packages)       | [5](#example-5)                  |
| `cdx:nix:*`                                                                | Nix flakes                                                | Input source URLs, lock revision/ref/hash/time, flake directory                                                     | Validate immutable lock intent, detect unexpected source URL changes, support reproducibility/provenance checks                                                  | [Package manager and language ecosystems](#inventory-packages)       | [4](#example-4)                  |
| `cdx:swift:*`                                                              | Swift Package Manager                                     | Logical package naming and local checkout paths                                                                     | Identify local checkout dependencies vs remote source dependencies; enforce source-origin controls                                                               | [Package manager and language ecosystems](#inventory-packages)       | [3](#example-3)                  |
| `cdx:pods:*`                                                               | CocoaPods                                                 | Podspec location, project directory, pod/subspec mapping                                                            | Distinguish local/path/git pod sourcing, trace subspec-enabled feature surface, improve provenance for iOS supply chains                                         | [Package manager and language ecosystems](#inventory-packages)       | [3](#example-3)                  |
| `cdx:pub:*`                                                                | Dart pub                                                  | Non-default registry URL                                                                                            | Enforce approved package registry policy and detect mirror/private feed usage                                                                                    | [Package manager and language ecosystems](#inventory-packages)       | [3](#example-3)                  |
| `cdx:bom:*`                                                                | BOM-level metadata                                        | Component type set, discovered namespaces, source manifest files                                                    | Measure BOM completeness, identify broad component diversity, and support attestable “evidence-of-origin” for manifest inputs                                    | [Cross-cutting BOM/service/build metadata](#inventory-cross-cutting) | [5](#example-5)                  |
| `cdx:build:versionSpecifiers`                                              | Build/manifest parsing (for example C/C++ build metadata) | Non-exact version constraints captured from build descriptors                                                       | Highlight non-pinned dependency constraints and prioritize hardening toward deterministic builds                                                                 | [Cross-cutting BOM/service/build metadata](#inventory-cross-cutting) | [5](#example-5)                  |
| `cdx:osquery:category`                                                     | Host/package discovery via osquery                        | Query/source category for discovered packages                                                                       | Separate inventory confidence by collection method and tune host-level evidence policies                                                                         | [Cross-cutting BOM/service/build metadata](#inventory-cross-cutting) | [5](#example-5)                  |
| `cdx:vscode-extension:*`                                                   | VS Code / IDE extensions (`.vsix` and installed dirs)     | Activation events, extension kind, contributed features, lifecycle scripts, workspace trust posture                 | Detect always-on extensions, flag install-time script execution, audit host/filesystem access, enforce workspace trust and virtual workspace policies            | [IDE and editor extensions](#inventory-ide-extensions)               | [7](#example-7)                  |
| `cdx:chrome-extension:*`                                                   | Chromium browser extensions (`-t chrome-extension`, `-t os`) | Browser/profile context, Chrome/Edge/Brave manifest metadata, capability signals from manifest + Babel source analysis | Flag broad host permissions, web-request interception capability, file/device/network/bluetooth/accessibility/code-injection/fingerprinting exposure             | [IDE and editor extensions](#inventory-ide-extensions)               | [7](#example-7)                  |
| `cdx:service:httpMethod`                                                   | OpenAPI/service evidence                                  | HTTP method associated with discovered service endpoints                                                            | Support API exposure reviews (method-level attack surface and access-control assurance)                                                                          | [Cross-cutting BOM/service/build metadata](#inventory-cross-cutting) | [5](#example-5)                  |

## Useful keys

These are the highest-leverage keys for first-pass policy authoring.

| Key                                        | Why it matters                                                                     | Policy readiness |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------- |
| `cdx:github:action:isShaPinned`            | Distinguishes immutable commit-pinned actions from mutable tag/branch references   | Hard deny        |
| `cdx:github:workflow:hasWritePermissions`  | Quickly identifies workflows that can modify repository or packages                | Hard deny        |
| `cdx:github:workflow:hasIdTokenWrite`      | Flags OIDC token issuance capability                                               | Hard deny        |
| `cdx:npm:hasInstallScript`                 | Captures install-time execution surface                                            | Hard deny        |
| `cdx:npm:isRegistryDependency`             | Detects git/file/local sources vs standard registry resolution                     | Hard deny        |
| `cdx:pypi:registry`                        | Indicates non-default Python package index usage                                   | Hard deny        |
| `cdx:gem:remoteRevision`                   | Lets policies distinguish immutable git revisions from mutable branch/tag sourcing | Warning / triage |
| `cdx:nix:nar_hash`                         | Important reproducibility and content-integrity signal for flakes                  | Hard deny        |
| `cdx:go:local_dir`                         | Detects local module replacements and non-hermetic resolution                      | Hard deny        |
| `cdx:bom:componentSrcFiles`                | Useful gate for BOM completeness and downstream attestability                      | Warning / triage |
| `cdx:vscode-extension:lifecycleScripts`    | Captures install-time execution surface from extension lifecycle hooks             | Hard deny        |
| `cdx:vscode-extension:activationEvents`    | Wildcard (`*`) activation means always-on; broad trigger surface is higher risk    | Warning / triage |
| `cdx:vscode-extension:untrustedWorkspaces` | Controls whether the extension operates in untrusted workspace contexts            | Warning / triage |
| `cdx:vscode-extension:contributes`         | Reveals contributed features such as terminal access, debuggers, auth providers    | Warning / triage |
| `cdx:vscode-extension:executesCode`        | Explicit declaration that the extension executes code; always-true is higher risk  | Warning / triage |
| `cdx:vscode-extension:vscodeEngine`        | Minimum VS Code version required; older engines may lack security features         | Context only     |
| `cdx:chrome-extension:permissions`         | Captures primary Chrome extension API permission requests                          | Hard deny        |
| `cdx:chrome-extension:hostPermissions`     | Captures effective site scope from host permissions and content-script matches      | Hard deny        |
| `cdx:chrome-extension:contentScriptsRunAt` | Captures content script injection timing such as `document_start`                  | Warning / triage |
| `cdx:chrome-extension:contentScriptsMatches` | Captures URL match patterns declared under `content_scripts[*].matches`          | Hard deny        |
| `cdx:chrome-extension:hasAutofill`         | Signals autofill-related capability detected from manifest content                 | Warning / triage |
| `cdx:chrome-extension:capability:codeInjection` | Signals explicit code-injection capability from manifest/source analysis       | Hard deny        |
| `cdx:chrome-extension:capability:fingerprinting` | Signals fingerprinting-relevant APIs/permissions from manifest/source analysis | Warning / triage |

## Current key inventory (grouped)

The grouped lists below remain the authoritative inventory. The compact tables, decision categories, and combinations that follow are intended to make those keys easier to operationalize.

<a id="inventory-cicd"></a>

### CI/CD and workflow provenance

#### Authoritative grouped index

- **GitHub Actions:** `cdx:github:action:isShaPinned`, `cdx:github:action:uses`, `cdx:github:action:versionPinningType`, `cdx:github:cache:key`, `cdx:github:cache:path`, `cdx:github:cache:restoreKeys`, `cdx:github:checkout:persistCredentials`, `cdx:github:job:environment`, `cdx:github:job:timeoutMinutes`, `cdx:github:job:hasWritePermissions`, `cdx:github:job:name`, `cdx:github:job:needs`, `cdx:github:job:runner`, `cdx:github:job:services`, `cdx:github:job:timeoutMinutes`, `cdx:github:run:line`, `cdx:github:step:command`, `cdx:github:step:condition`, `cdx:github:step:continueOnError`, `cdx:github:step:hasUntrustedInterpolation`, `cdx:github:step:interpolatedVars`, `cdx:github:step:name`, `cdx:github:step:timeout`, `cdx:github:step:type`, `cdx:github:workflow:concurrencyGroup`, `cdx:github:workflow:file`, `cdx:github:workflow:hasHighRiskTrigger`, `cdx:github:workflow:hasIdTokenWrite`, `cdx:github:workflow:hasWritePermissions`, `cdx:github:workflow:name`, `cdx:github:workflow:triggers`
- **GitHub action trust tags:** `cdx:actions:isOfficial`, `cdx:actions:isVerified`
- **GitLab CI:** `cdx:gitlab:config`, `cdx:gitlab:job:environment`, `cdx:gitlab:job:image`, `cdx:gitlab:job:name`, `cdx:gitlab:job:needs`, `cdx:gitlab:job:services`, `cdx:gitlab:job:stage`, `cdx:gitlab:stages`
- **Azure Pipelines:** `cdx:azure:config`, `cdx:azure:job:environment`, `cdx:azure:job:name`, `cdx:azure:job:pool:vmImage`, `cdx:azure:pool:vmImage`, `cdx:azure:stage:condition`, `cdx:azure:stage:dependsOn`, `cdx:azure:stage:name`, `cdx:azure:trigger:branches`
- **CircleCI:** `cdx:circleci:config`, `cdx:circleci:executor:name`, `cdx:circleci:job:branch:only`, `cdx:circleci:job:name`, `cdx:circleci:job:requires`, `cdx:circleci:orb:alias`, `cdx:circleci:workflow:name`
- **Jenkins:** `cdx:jenkins:agent`, `cdx:jenkins:agent:image`, `cdx:jenkins:file`, `cdx:jenkins:stage:name`, `cdx:jenkins:stage:parallel`, `cdx:jenkins:stage:when`

#### Decision-oriented sub-groups

- **Privilege / trust:** `cdx:github:workflow:hasWritePermissions`, `cdx:github:job:hasWritePermissions`, `cdx:github:workflow:hasIdTokenWrite`, `cdx:actions:isOfficial`, `cdx:actions:isVerified`
- **Execution surface:** `cdx:github:step:command`, `cdx:github:step:type`, `cdx:gitlab:job:image`, `cdx:gitlab:job:services`, `cdx:azure:job:pool:vmImage`, `cdx:circleci:orb:alias`, `cdx:jenkins:agent:image`
- **Reproducibility / control flow:** `cdx:github:workflow:triggers`, `cdx:github:job:needs`, `cdx:azure:stage:dependsOn`, `cdx:azure:stage:condition`, `cdx:circleci:job:requires`, `cdx:jenkins:stage:when`, `cdx:jenkins:stage:parallel`
- **Environment / targeting:** `cdx:github:job:environment`, `cdx:github:job:runner`, `cdx:gitlab:job:environment`, `cdx:azure:job:environment`, `cdx:azure:trigger:branches`, `cdx:circleci:job:branch:only`

#### Compact operational reference

| Key                                         | Scope                | Value type     | Typical values                               | When emitted                                                                                 | Why it matters                                                                                  | Policy readiness |
| ------------------------------------------- | -------------------- | -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------- |
| `cdx:github:action:isShaPinned`             | step                 | boolean string | `"true"`, `"false"`                          | On `uses:` steps in GitHub Actions workflows                                                 | Primary mutable-vs-immutable trust signal for third-party actions                               | Hard deny        |
| `cdx:github:action:versionPinningType`      | step                 | enum string    | `sha`, `tag`, `branch`                       | On `uses:` steps in GitHub Actions workflows                                                 | More expressive companion to `isShaPinned`; lets policies distinguish branch and tag references | Warning / triage |
| `cdx:github:workflow:hasWritePermissions`   | workflow + component | boolean string | `"true"`, `"false"`                          | When workflow permissions are parsed                                                         | Privilege amplifier for other risky signals                                                     | Hard deny        |
| `cdx:github:workflow:hasIdTokenWrite`       | workflow + component | boolean string | `"true"`, `"false"`                          | When `id-token: write` is present                                                            | High-signal OIDC issuance capability                                                            | Hard deny        |
| `cdx:github:job:hasWritePermissions`        | job                  | boolean string | `"true"`, `"false"`                          | When job-level permissions are parsed                                                        | Captures narrower but still powerful write scope                                                | Hard deny        |
| `cdx:github:step:command`                   | step                 | string         | `npm ci && npm test`                         | On `run:` steps                                                                              | Direct execution surface useful for review and explainability                                   | Context only     |
| `cdx:github:workflow:triggers`              | workflow + component | list string    | `push,pull_request`                          | When workflow triggers are present                                                           | Helps constrain where other risks are reachable                                                 | Warning / triage |
| `cdx:github:checkout:persistCredentials`    | step                 | boolean string | `"true"`,`"false"`                           | When `actions/checkout` step lacks `persist-credentials` or sets the attribute to true       | Exposes GITHUB_TOKEN to subsequent steps                                                        | Warning / triage |
| `cdx:github:cache:key`                      | step                 | string         | npm-${{ hashFiles('**/package-lock.json') }} | Cache key used in `actions/cache`                                                            |                                                                                                 | Context only     |
| `cdx:github:cache:path`                     | step                 | string         | ~/.npm,node_modules                          | Cache path                                                                                   |                                                                                                 | Context only     |
| `cdx:github:cache:restoreKeys`              | step                 | list string    | `npm-,node-modules-`                         | Comma-separated restore-key fallback patterns from `actions/cache`                           | Cache poisoning risk context                                                                    | Context only     |
| `cdx:github:step:hasUntrustedInterpolation` | step                 | boolean string | `"true"`,`"false"`                           | Direct interpolation of github.event._ or inputs._ into run: blocks.                         | Enables command injection                                                                       | Hard deny        |
| `cdx:github:step:interpolatedVars`          | step                 | list string    | github.event.pull_request.title              |                                                                                              |                                                                                                 | Warning / triage |
| `cdx:github:workflow:hasHighRiskTrigger`    | workflow + component | boolean string | `"true"`,`"false"`                           | When workflow has these triggers: `"pull_request_target"`,`"issue_comment"`,`"workflow_run"` | Enables privilege escalation                                                                    | Hard deny        |
| `cdx:actions:isOfficial`                    | step                 | boolean string | `"true"`, `"false"`                          | On GitHub action components                                                                  | Distinguishes first-party from third-party action sources                                       | Warning / triage |
| `cdx:actions:isVerified`                    | step                 | boolean string | `"true"`, `"false"`                          | On GitHub action components                                                                  | Helpful trust signal but not sufficient on its own                                              | Warning / triage |
| `cdx:gitlab:job:image`                      | job                  | string         | `node:20-alpine`                             | When GitLab job images are defined                                                           | Exposes execution environment and provenance                                                    | Warning / triage |
| `cdx:gitlab:job:services`                   | job                  | list string    | `postgres:14,redis:7`                        | When GitLab service sidecars are declared                                                    | Highlights additional runtime trust edges                                                       | Warning / triage |
| `cdx:azure:pool:vmImage`                    | workflow             | string         | `ubuntu-latest`                              | When a workflow-level pool is set                                                            | Baseline runner selection for all jobs                                                          | Warning / triage |
| `cdx:azure:job:pool:vmImage`                | job                  | string         | `windows-latest`                             | When a job overrides the workflow-level pool                                                 | Important job-level override; match both Azure pool keys in policy                              | Warning / triage |
| `cdx:circleci:orb:alias`                    | step                 | string         | `node/default`                               | When CircleCI orbs are used                                                                  | Third-party execution surface and trust boundary                                                | Warning / triage |
| `cdx:jenkins:agent:image`                   | stage                | string         | `maven:3.9-eclipse-temurin-21`               | When Jenkins stages use Docker agents                                                        | Useful for runtime provenance and image policy gates                                            | Warning / triage |

#### High-value combinations

- `cdx:github:action:isShaPinned=false` + `cdx:github:workflow:hasWritePermissions=true`
- `cdx:github:action:isShaPinned=false` + `cdx:github:job:hasWritePermissions=true`
- `cdx:github:workflow:hasIdTokenWrite=true` + `cdx:actions:isOfficial=false`
- `cdx:github:step:type=run` + `cdx:github:job:hasWritePermissions=true`
- `cdx:gitlab:job:image` present + `cdx:gitlab:job:services` present for untrusted pipeline paths
- `cdx:azure:trigger:branches` absent + self-hosted or privileged pool policy match
- `cdx:circleci:orb:alias` present + `cdx:circleci:job:branch:only` absent
- `cdx:jenkins:agent:image` present + `cdx:jenkins:stage:when` absent for deployment stages

#### Example payload fragment

```json
{
  "name": "actions/setup-node",
  "type": "application",
  "purl": "pkg:github/actions/setup-node@v3",
  "properties": [
    { "name": "cdx:github:action:uses", "value": "actions/setup-node@v3" },
    { "name": "cdx:github:action:versionPinningType", "value": "tag" },
    { "name": "cdx:github:action:isShaPinned", "value": "false" },
    { "name": "cdx:github:workflow:hasWritePermissions", "value": "true" },
    { "name": "cdx:actions:isOfficial", "value": "true" }
  ]
}
```

#### Alias and overlap notes

- Prefer matching **both** `cdx:github:action:isShaPinned` and `cdx:github:action:versionPinningType` when possible; the former is the convenience boolean and the latter carries more nuance.
- Match both `cdx:azure:pool:vmImage` (workflow-level default) and `cdx:azure:job:pool:vmImage` (job-level override). Job-level settings take precedence when present.

<a id="inventory-packages"></a>

### Package manager and language ecosystems

#### Authoritative grouped index

- **npm/pnpm:** `cdx:npm:bin`, `cdx:npm:binPaths`, `cdx:npm:cpu`, `cdx:npm:deprecated`, `cdx:npm:deprecation_notice`, `cdx:npm:gypfile`, `cdx:npm:hasInstallScript`, `cdx:npm:has_binary`, `cdx:npm:inBundle`, `cdx:npm:inDepBundle`, `cdx:npm:installLinks`, `cdx:npm:isLink`, `cdx:npm:isRegistryDependency`, `cdx:npm:isWorkspace`, `cdx:npm:is_workspace`, `cdx:npm:libc`, `cdx:npm:nameMismatchError`, `cdx:npm:native_addon`, `cdx:npm:native_deps`, `cdx:npm:os`, `cdx:npm:package:development`, `cdx:npm:package_json`, `cdx:npm:resolvedPath`, `cdx:npm:risky_scripts`, `cdx:npm:scripts`, `cdx:npm:versionMismatchError`, `cdx:pnpm:alias`
- **Python:** `cdx:pip:markers`, `cdx:pip:structuredMarkers`, `cdx:pypi:extras`, `cdx:pypi:latest_version`, `cdx:pypi:registry`, `cdx:pypi:requiresPython`, `cdx:pypi:resolved_from`, `cdx:pypi:versionSpecifiers`, `cdx:pyproject:group`, `cdx:python:requires_python`, `cdx:pixi:build`, `cdx:pixi:build_number`, `cdx:pixi:operating_system`
- **Ruby:** `cdx:gem:executables`, `cdx:gem:gemUri`, `cdx:gem:platform`, `cdx:gem:prerelease`, `cdx:gem:remote`, `cdx:gem:remoteBranch`, `cdx:gem:remoteRevision`, `cdx:gem:remoteTag`, `cdx:gem:rubyVersionSpecifiers`, `cdx:gem:versionSpecifiers`, `cdx:gem:yanked`
- **Rust:** `cdx:cargo:crate_id`, `cdx:cargo:features`, `cdx:cargo:latest_version`, `cdx:cargo:rust_version`
- **Go:** `cdx:go:creation_time`, `cdx:go:deprecated`, `cdx:go:indirect`, `cdx:go:local_dir`, `cdx:go:toolchain`
- **.NET:** `cdx:dotnet:assembly_name`, `cdx:dotnet:assembly_version`, `cdx:dotnet:azure_functions_version`, `cdx:dotnet:hint_path`, `cdx:dotnet:project_guid`, `cdx:dotnet:target_framework`
- **Java:** `cdx:maven:component_scope`, `cdx:maven:shaded`, `cdx:maven:unshadedNamespaces`, `cdx:gradle:GradleRootPath`
- **Nix:** `cdx:nix:flake_dir`, `cdx:nix:input_url`, `cdx:nix:last_modified`, `cdx:nix:nar_hash`, `cdx:nix:ref`, `cdx:nix:revision`
- **Swift:** `cdx:swift:localCheckoutPath`, `cdx:swift:packageName`
- **CocoaPods:** `cdx:pods:PodName`, `cdx:pods:Subspec`, `cdx:pods:podspecLocation`, `cdx:pods:projectDir`
- **Dart pub:** `cdx:pub:registry`

#### Decision-oriented sub-groups

- **Provenance / source:** `cdx:npm:isRegistryDependency`, `cdx:npm:resolvedPath`, `cdx:pypi:registry`, `cdx:pypi:resolved_from`, `cdx:gem:remote`, `cdx:gem:remoteRevision`, `cdx:go:local_dir`, `cdx:nix:input_url`, `cdx:swift:localCheckoutPath`, `cdx:pods:projectDir`, `cdx:pub:registry`
- **Execution surface:** `cdx:npm:hasInstallScript`, `cdx:npm:risky_scripts`, `cdx:npm:native_addon`, `cdx:npm:native_deps`, `cdx:gem:executables`, `cdx:cargo:features`
- **Privilege / trust:** `cdx:npm:nameMismatchError`, `cdx:npm:versionMismatchError`, `cdx:gem:yanked`, `cdx:go:deprecated`, `cdx:maven:shaded`
- **Reproducibility / drift:** `cdx:pypi:latest_version`, `cdx:gem:remoteBranch`, `cdx:gem:remoteTag`, `cdx:nix:nar_hash`, `cdx:nix:revision`, `cdx:nix:last_modified`, `cdx:go:creation_time`
- **Environment / targeting:** `cdx:npm:cpu`, `cdx:npm:os`, `cdx:npm:libc`, `cdx:pip:markers`, `cdx:python:requires_python`, `cdx:pypi:requiresPython`, `cdx:pixi:operating_system`, `cdx:dotnet:target_framework`, `cdx:dotnet:azure_functions_version`, `cdx:gem:platform`, `cdx:cargo:rust_version`

#### Compact operational reference

| Key                            | Scope              | Value type     | Typical values                             | When emitted                                           | Why it matters                                                            | Policy readiness |
| ------------------------------ | ------------------ | -------------- | ------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------- |
| `cdx:npm:hasInstallScript`     | component          | boolean string | `"true"`, `"false"`                        | When risky npm lifecycle hooks are present             | Captures install-time code execution risk                                 | Hard deny        |
| `cdx:npm:risky_scripts`        | component          | list string    | `preinstall,postinstall`                   | When risky lifecycle hooks are detected                | Human-readable explanation for why `hasInstallScript` was set             | Warning / triage |
| `cdx:npm:isRegistryDependency` | component          | boolean string | `"true"`, `"false"`                        | For npm components with resolvable source type         | Distinguishes registry dependencies from git/file/local/workspace sources | Hard deny        |
| `cdx:npm:native_addon`         | component          | boolean string | `"true"`, `"false"`                        | When a package builds native code                      | Highlights additional build and execution surface                         | Warning / triage |
| `cdx:npm:nameMismatchError`    | component          | string         | `Expected 'foo', found 'foo-esm'`          | When name resolution mismatches are detected           | Useful dependency-confusion and tampering signal                          | Hard deny        |
| `cdx:npm:versionMismatchError` | component          | string         | `Resolved 3.0.0, expected ^2.0`            | When locked/resolved version diverges from expectation | Flags drift, corruption, or surprising resolution                         | Hard deny        |
| `cdx:npm:package:development`  | component          | boolean string | `"true"`                                   | When an npm package is marked as `dev: true` or `devOptional: true` in package-lock metadata | Distinguishes development-only npm packages from optional runtime packages | Context only     |
| `cdx:npm:isWorkspace`          | component          | boolean string | `"true"`, `"false"`                        | For workspace members                                  | Preferred workspace indicator                                             | Context only     |
| `cdx:npm:is_workspace`         | component          | boolean string | `"true"`, `"false"`                        | Legacy/alternate workspace spelling                    | Keep in policy allowlists for compatibility                               | Context only     |
| `cdx:pypi:registry`            | component          | URL string     | `https://internal-pypi.example.com/simple` | When a non-default Python registry is used             | Strong allowlist / denylist input for dependency origin policy            | Hard deny        |
| `cdx:pypi:versionSpecifiers`   | component          | string         | `>=1.0,<2.0`, `==2.31.0`                   | When Python constraints are parsed                     | Important for pinning strictness and drift analysis                       | Warning / triage |
| `cdx:pip:markers`              | component          | string         | `python_version >= "3.11"`                 | When marker-based conditional deps are present         | Reveals conditional attack surface and environment sensitivity            | Warning / triage |
| `cdx:pip:structuredMarkers`    | component          | JSON string    | serialized marker AST                      | When structured markers are available                  | Better machine-readable alternative to raw marker strings                 | Warning / triage |
| `cdx:python:requires_python`   | component/metadata | string         | `>=3.9`                                    | When root interpreter constraints are known            | Lets policies detect unsupported or mismatched environments               | Warning / triage |
| `cdx:gem:remoteRevision`       | component          | string         | git commit SHA                             | When a gem is pinned to a git revision                 | Preferred immutable Ruby VCS source signal                                | Warning / triage |
| `cdx:gem:remoteBranch`         | component          | string         | `main`                                     | When a gem tracks a git branch                         | Mutable source indicator                                                  | Hard deny        |
| `cdx:gem:remoteTag`            | component          | string         | `v1.2.3`                                   | When a gem tracks a git tag                            | Mutable source indicator unless combined with revision                    | Warning / triage |
| `cdx:gem:yanked`               | component          | boolean string | `"true"`, `"false"`                        | When registry metadata shows the gem was yanked        | Useful integrity and availability signal                                  | Hard deny        |
| `cdx:cargo:features`           | component          | JSON string    | serialized feature map                     | When Cargo features are present                        | Indicates additional code paths and feature-based exposure                | Warning / triage |
| `cdx:go:local_dir`             | component          | path string    | `../local-module`                          | When Go `replace` points to a local path               | Strong non-hermetic build signal                                          | Hard deny        |
| `cdx:go:deprecated`            | component          | string         | deprecation message                        | When Go module metadata is deprecated                  | Good triage and lifecycle signal                                          | Warning / triage |
| `cdx:dotnet:hint_path`         | component          | path string    | `..\\..\\lib\\external.dll`                | When .NET assembly references use `HintPath`           | Useful for local/GAC/side-loaded binary provenance                        | Warning / triage |
| `cdx:maven:component_scope`    | component          | enum string    | `compile`, `runtime`, `test`, `system`     | For Maven-derived components                           | Useful scope-based filtering and deployment risk analysis                 | Context only     |
| `cdx:maven:shaded`             | component          | boolean string | `"true"`, `"false"`                        | When shaded/relocated bytecode is detected             | Can signal vendoring, obfuscation, or namespace relocation risk           | Warning / triage |
| `cdx:nix:revision`             | component          | string         | git commit SHA                             | When flake lock contains a revision                    | Important reproducibility anchor                                          | Hard deny        |
| `cdx:nix:nar_hash`             | component          | string         | `sha256-...`                               | When flake lock contains content hash                  | Important integrity and reproducibility anchor                            | Hard deny        |
| `cdx:nix:input_url`            | component          | URL string     | `github:nixos/nixpkgs/nixos-24.05`         | When flake input URLs are parsed                       | Provenance signal for source origin policy                                | Warning / triage |
| `cdx:swift:localCheckoutPath`  | component          | path string    | `checkouts/MyDep-1.0.0`                    | When SwiftPM uses a local checkout                     | Detects local or developer-only dependency provenance                     | Hard deny        |
| `cdx:pods:projectDir`          | component          | path string    | `/path/to/project`                         | When CocoaPods uses a local project directory          | Local provenance signal for pod sourcing                                  | Warning / triage |
| `cdx:pub:registry`             | component          | URL string     | `https://pub.company.example`              | When Dart pub uses a non-default registry              | Useful for registry allowlists                                            | Hard deny        |

#### High-value combinations

- `cdx:npm:hasInstallScript=true` + `cdx:npm:isRegistryDependency=false`
- `cdx:npm:native_addon=true` + platform constraints (`cdx:npm:cpu`, `cdx:npm:os`, `cdx:npm:libc`)
- `cdx:npm:isLink=true` + `cdx:npm:resolvedPath` present + `cdx:npm:isWorkspace=false`
- `cdx:npm:nameMismatchError` or `cdx:npm:versionMismatchError` present
- `cdx:pypi:registry` non-allowlisted + unpinned `cdx:pypi:versionSpecifiers`
- `cdx:pip:markers` present + incompatible `cdx:python:requires_python`
- `cdx:gem:remote=git` + `cdx:gem:remoteBranch` without `cdx:gem:remoteRevision`
- `cdx:gem:yanked=true`
- `cdx:go:local_dir` present + repository policy forbids local replacement
- `cdx:nix:ref` present without `cdx:nix:revision` or `cdx:nix:nar_hash`
- `cdx:swift:localCheckoutPath` present + production release profile
- `cdx:pods:projectDir` present + remote podspec source mismatch

#### Example payload fragments

**npm / pnpm execution risk**

```json
{
  "name": "example-pkg",
  "version": "1.0.0",
  "purl": "pkg:npm/example-pkg@1.0.0",
  "properties": [
    { "name": "cdx:npm:hasInstallScript", "value": "true" },
    { "name": "cdx:npm:risky_scripts", "value": "postinstall" },
    { "name": "cdx:npm:isRegistryDependency", "value": "false" },
    { "name": "cdx:npm:resolvedPath", "value": "file:../local-pkg" }
  ]
}
```

**Nix reproducibility evidence**

```json
{
  "name": "nixpkgs",
  "purl": "pkg:nix/nixos/nixpkgs@24.05",
  "properties": [
    {
      "name": "cdx:nix:input_url",
      "value": "github:nixos/nixpkgs/nixos-24.05"
    },
    {
      "name": "cdx:nix:revision",
      "value": "1234567890abcdef1234567890abcdef12345678"
    },
    { "name": "cdx:nix:nar_hash", "value": "sha256-abc123..." },
    { "name": "cdx:nix:ref", "value": "nixos-24.05" }
  ]
}
```

#### Alias and overlap notes

- Prefer `cdx:npm:isWorkspace`, but match **both** `cdx:npm:isWorkspace` and `cdx:npm:is_workspace` in policies for compatibility.
- `cdx:pip:structuredMarkers` is the more machine-friendly companion to `cdx:pip:markers`; when both exist, parse the JSON string and prefer the structured form for policy logic, while keeping the raw form for explainability.
- `cdx:gem:remoteBranch` and `cdx:gem:remoteTag` are weaker, mutable source indicators than `cdx:gem:remoteRevision`.
- `cdx:nix:ref` is descriptive context; use `cdx:nix:revision` and `cdx:nix:nar_hash` as the stronger reproducibility gates.

<a id="inventory-cross-cutting"></a>

### Cross-cutting BOM/service/build metadata

#### Authoritative grouped index

- `cdx:bom:componentNamespaces`
- `cdx:bom:componentSrcFiles`
- `cdx:bom:componentTypes`
- `cdx:build:versionSpecifiers`
- `cdx:osquery:category`
- `cdx:service:httpMethod`

#### Compact operational reference

| Key                           | Scope     | Value type  | Typical values                                | When emitted                                     | Why it matters                                                    | Policy readiness |
| ----------------------------- | --------- | ----------- | --------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- | ---------------- |
| `cdx:bom:componentNamespaces` | metadata  | list string | `pkg:npm`, `pkg:pypi`, `pkg:maven`            | After BOM post-processing                        | Shows ecosystem breadth and helps explain mixed-language outputs  | Context only     |
| `cdx:bom:componentSrcFiles`   | metadata  | list string | `package.json`, `requirements.txt`, `pom.xml` | After BOM post-processing                        | Useful for completeness gates and evidence-of-origin attestations | Warning / triage |
| `cdx:bom:componentTypes`      | metadata  | list string | `library`, `application`, `container`         | After BOM post-processing                        | Helps identify unexpectedly narrow or broad BOM composition       | Warning / triage |
| `cdx:build:versionSpecifiers` | component | string      | `>=1.0,<2.0`                                  | When build metadata yields non-exact constraints | Good pinning strictness signal for build ecosystems               | Warning / triage |
| `cdx:osquery:category`        | component | string      | `packages`, `system`                          | When packages are discovered through osquery     | Indicates evidence source and confidence context                  | Context only     |
| `cdx:service:httpMethod`      | service   | string      | `GET`, `POST`, `DELETE`                       | When OpenAPI/service endpoints are captured      | Useful for API exposure reviews and method-specific policy        | Context only     |

#### High-value combinations

- `cdx:bom:componentTypes` present + `cdx:bom:componentSrcFiles` present before allowing downstream signing
- Missing `cdx:bom:componentSrcFiles` for a BOM that otherwise claims broad language coverage
- `cdx:build:versionSpecifiers` present + policy requires exact pinning in build metadata
- `cdx:service:httpMethod=DELETE` or `PATCH` + public service exposure policy outside this document

#### Example payload fragment

```json
{
  "metadata": {
    "properties": [
      {
        "name": "cdx:bom:componentNamespaces",
        "value": "pkg:npm\npkg:pypi\npkg:maven"
      },
      { "name": "cdx:bom:componentTypes", "value": "library\napplication" },
      {
        "name": "cdx:bom:componentSrcFiles",
        "value": "package.json\nrequirements.txt\npom.xml"
      }
    ]
  }
}
```

<a id="inventory-ide-extensions"></a>

### IDE and editor extensions

#### Authoritative grouped index

- **VS Code extensions:** `cdx:vscode-extension:activationEvents`, `cdx:vscode-extension:browser`, `cdx:vscode-extension:contributes`, `cdx:vscode-extension:executesCode`, `cdx:vscode-extension:extensionDependencies`, `cdx:vscode-extension:extensionKind`, `cdx:vscode-extension:extensionPack`, `cdx:vscode-extension:ide`, `cdx:vscode-extension:lifecycleScripts`, `cdx:vscode-extension:main`, `cdx:vscode-extension:untrustedWorkspaces`, `cdx:vscode-extension:virtualWorkspaces`, `cdx:vscode-extension:vscodeEngine`
- **Chromium browser extensions:** `cdx:chrome-extension:browser`, `cdx:chrome-extension:channel`, `cdx:chrome-extension:profile`, `cdx:chrome-extension:profilePath`, `cdx:chrome-extension:manifestVersion`, `cdx:chrome-extension:updateUrl`, `cdx:chrome-extension:minimumChromeVersion`, `cdx:chrome-extension:versionName`, `cdx:chrome-extension:incognito`, `cdx:chrome-extension:offlineEnabled`, `cdx:chrome-extension:permissions`, `cdx:chrome-extension:optionalPermissions`, `cdx:chrome-extension:hostPermissions`, `cdx:chrome-extension:optionalHostPermissions`, `cdx:chrome-extension:commands`, `cdx:chrome-extension:contentScriptsRunAt`, `cdx:chrome-extension:contentScriptsMatches`, `cdx:chrome-extension:contentSecurityPolicy`, `cdx:chrome-extension:storageManagedSchema`, `cdx:chrome-extension:webAccessibleResourceMatches`, `cdx:chrome-extension:externallyConnectableMatches`, `cdx:chrome-extension:capabilities`, `cdx:chrome-extension:capability:fileAccess`, `cdx:chrome-extension:capability:deviceAccess`, `cdx:chrome-extension:capability:network`, `cdx:chrome-extension:capability:bluetooth`, `cdx:chrome-extension:capability:accessibility`, `cdx:chrome-extension:capability:codeInjection`, `cdx:chrome-extension:capability:fingerprinting`, `cdx:chrome-extension:hasAutofill`, `cdx:chrome-extension:edge:minimumVersion`, `cdx:chrome-extension:edge:urlOverrides`, `cdx:chrome-extension:brave:maybeBackground`, `cdx:chrome-extension:brave:permissions`

#### Decision-oriented sub-groups

- **Execution surface:** `cdx:vscode-extension:lifecycleScripts`, `cdx:vscode-extension:main`, `cdx:vscode-extension:browser`, `cdx:vscode-extension:contributes`, `cdx:vscode-extension:executesCode`
- **Privilege / trust:** `cdx:vscode-extension:untrustedWorkspaces`, `cdx:vscode-extension:virtualWorkspaces`, `cdx:vscode-extension:activationEvents`
- **Dependency chain:** `cdx:vscode-extension:extensionDependencies`, `cdx:vscode-extension:extensionPack`
- **Context / provenance:** `cdx:vscode-extension:ide`, `cdx:vscode-extension:extensionKind`, `cdx:vscode-extension:vscodeEngine`
- **Browser extension execution surface:** `cdx:chrome-extension:contentScriptsRunAt`, `cdx:chrome-extension:contentScriptsMatches`, `cdx:chrome-extension:commands`, `cdx:chrome-extension:contentSecurityPolicy`, `cdx:chrome-extension:capability:codeInjection`, `cdx:chrome-extension:hasAutofill`
- **Browser extension privilege / scope:** `cdx:chrome-extension:permissions`, `cdx:chrome-extension:optionalPermissions`, `cdx:chrome-extension:hostPermissions`, `cdx:chrome-extension:optionalHostPermissions`
- **Browser extension context / provenance:** `cdx:chrome-extension:browser`, `cdx:chrome-extension:channel`, `cdx:chrome-extension:profile`, `cdx:chrome-extension:profilePath`, `cdx:chrome-extension:manifestVersion`, `cdx:chrome-extension:updateUrl`, `cdx:chrome-extension:minimumChromeVersion`, `cdx:chrome-extension:versionName`, `cdx:chrome-extension:storageManagedSchema`, `cdx:chrome-extension:edge:minimumVersion`, `cdx:chrome-extension:brave:maybeBackground`

#### Compact operational reference

| Key                                          | Scope     | Value type                    | Typical values                                                                     | When emitted                                                           | Why it matters                                                                                                                                                                                                                                                        | Policy readiness |
| -------------------------------------------- | --------- | ----------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `cdx:vscode-extension:activationEvents`      | component | list string (comma-separated) | `onLanguage:python, onCommand:ext.run, *`                                          | When extension declares activation events in package.json              | Wildcard `*` means the extension activates on every workspace open, increasing attack surface. Use `$contains($split(value, ','), '*')` in JSONata to detect always-on extensions.                                                                                    | Warning / triage |
| `cdx:vscode-extension:extensionKind`         | component | list string                   | `ui`, `workspace`, `ui, workspace`                                                 | When extension declares where it can run                               | `workspace` extensions execute in the remote host context and can access the filesystem                                                                                                                                                                               | Context only     |
| `cdx:vscode-extension:extensionDependencies` | component | list string                   | `ms-python.vscode-pylance, ms-toolsai.jupyter`                                     | When extension declares dependencies on other extensions               | Transitive trust chain; a compromised dependency extension can affect all dependants                                                                                                                                                                                  | Warning / triage |
| `cdx:vscode-extension:extensionPack`         | component | list string                   | `ms-python.python, ms-python.vscode-pylance`                                       | When extension bundles other extensions as a pack                      | Pack extensions install additional extensions implicitly                                                                                                                                                                                                              | Warning / triage |
| `cdx:vscode-extension:untrustedWorkspaces`   | component | string                        | `true`, `false`, `limited`                                                         | When extension declares workspace trust configuration                  | `true` means the extension runs in untrusted workspaces; `limited` restricts some features                                                                                                                                                                            | Warning / triage |
| `cdx:vscode-extension:virtualWorkspaces`     | component | string                        | `true`, `false`                                                                    | When extension declares virtual workspace support                      | Extensions supporting virtual workspaces may operate without direct filesystem access                                                                                                                                                                                 | Context only     |
| `cdx:vscode-extension:contributes`           | component | list string (comma-separated) | `commands:count:42, terminal-access, filesystem-provider, authentication-provider` | When extension package.json declares contributed features              | Summary of privileged capabilities; use `:count:` suffix to identify quantity of contribution points (e.g., `commands:count:12` means 12 commands contributed). Match specific capability keywords (`terminal-access`, `filesystem-provider`, etc.) for policy rules. | Warning / triage |
| `cdx:vscode-extension:main`                  | component | path string                   | `./dist/extension.js`, `./out/main.js`                                             | When extension declares a Node.js entry point                          | Identifies the primary executable entry point for security review                                                                                                                                                                                                     | Context only     |
| `cdx:vscode-extension:browser`               | component | path string                   | `./dist/web/extension.js`                                                          | When extension declares a browser/web entry point in package.json      | Indicates the extension can run in web/VS Code for Web contexts. Browser extensions run in a sandboxed environment with reduced permissions compared to Node.js (`main`) entry points. Use to differentiate web-safe vs. host-executing extensions.                   | Context only     |
| `cdx:vscode-extension:lifecycleScripts`      | component | list string                   | `postinstall, vscode:prepublish`, `vscode:uninstall`                               | When extension package.json contains lifecycle hooks                   | Install-time script execution risk; `postinstall` can run arbitrary code during extension installation                                                                                                                                                                | Hard deny        |
| `cdx:vscode-extension:executesCode`          | component | string                        | `true`, `false`                                                                    | When vsixmanifest Properties declares `ExecutesCode`                   | Explicitly declares whether the extension executes code; `true` confirms the extension runs arbitrary code                                                                                                                                                            | Warning / triage |
| `cdx:vscode-extension:vscodeEngine`          | component | semver range string           | `^1.94.0`, `>=1.80.0`                                                              | When vsixmanifest Properties declares the required VS Code engine      | Minimum VS Code version required; older engines may lack security features like workspace trust                                                                                                                                                                       | Context only     |
| `cdx:vscode-extension:ide`                   | component | string                        | `vscode`, `cursor`, `vscodium`, `windsurf`                                         | When extension is discovered from a specific IDE's extension directory | Indicates which IDE the extension was found in; useful for fleet-wide inventory                                                                                                                                                                                       | Context only     |

#### High-value combinations

- `cdx:vscode-extension:lifecycleScripts` present + `cdx:vscode-extension:activationEvents` contains `*` — always-on extension with install-time execution
- `cdx:vscode-extension:untrustedWorkspaces=true` + `cdx:vscode-extension:contributes` contains `filesystem-provider` — extension operates in untrusted contexts with filesystem access
- `cdx:vscode-extension:extensionKind` contains `workspace` + `cdx:vscode-extension:executesCode=true` — extension executes arbitrary code on remote hosts
- `cdx:vscode-extension:extensionPack` present + any member has `lifecycleScripts` — pack implicitly installs extensions with install-time risks
- `cdx:vscode-extension:browser` present + `cdx:vscode-extension:contributes` contains `terminal-access` — potential cross-context capability confusion

> **Value normalization note for workspace trust properties:**  
> The `cdx:vscode-extension:untrustedWorkspaces` and `cdx:vscode-extension:virtualWorkspaces` properties may originate from either a boolean or an object with a `supported` field in `package.json`. cdxgen normalizes these to string values:
>
> - `"true"` → extension explicitly supports untrusted/virtual workspaces
> - `"false"` → extension does not support untrusted/virtual workspaces
> - `"limited"` → extension supports untrusted workspaces with reduced functionality (only for `untrustedWorkspaces`)
>
> Policy authors should compare against these string values, not booleans.

> **JSONata tip for VS Code extension rules:**  
> List-valued properties like `cdx:vscode-extension:activationEvents`, `contributes`, and `extensionKind` are comma-separated strings. Use the following pattern to match individual values:
>
> ```jsonata
> $nullSafeProp($, 'cdx:vscode-extension:activationEvents') ~> $contains('*')
> ```
>
> The `$trim()` step removes whitespace around comma-separated values for reliable matching.

#### Example payload fragment

```json
{
  "name": "python",
  "publisher": "ms-python",
  "version": "2024.8.1",
  "type": "application",
  "purl": "pkg:vscode-extension/ms-python/python@2024.8.1",
  "properties": [
    { "name": "cdx:vscode-extension:ide", "value": "vscode" },
    {
      "name": "cdx:vscode-extension:activationEvents",
      "value": "onLanguage:python, onCommand:python.runLinting"
    },
    { "name": "cdx:vscode-extension:extensionKind", "value": "workspace" },
    {
      "name": "cdx:vscode-extension:extensionDependencies",
      "value": "ms-python.vscode-pylance"
    },
    { "name": "cdx:vscode-extension:untrustedWorkspaces", "value": "limited" },
    {
      "name": "cdx:vscode-extension:contributes",
      "value": "commands:count:42, debuggers:1, terminal-access"
    },
    { "name": "cdx:vscode-extension:main", "value": "./dist/extension.js" },
    {
      "name": "cdx:vscode-extension:lifecycleScripts",
      "value": "postinstall, vscode:prepublish"
    }
  ]
}
```

#### Alias and overlap notes

- The `cdx:vscode-extension:ide` property is set to the IDE name where the extension was discovered (for example `vscode`, `cursor`, `vscodium`, `windsurf`, `positron`). Extensions found from `.vsix` files do not have this property.
- `cdx:vscode-extension:lifecycleScripts` is analogous to `cdx:npm:risky_scripts` for npm packages — both capture install-time execution risk.
- `cdx:vscode-extension:contributes` is a summary list, not a full enumeration. The count suffix (for example `commands:count:42`) indicates how many contribution points exist in that category.
- Extensions discovered via osquery (`-t os`) use the same `pkg:vscode-extension` purl type and may also carry `cdx:osquery:category`.
- Chromium-browser extensions discovered via `-t chrome-extension` can include `cdx:chrome-extension:browser`, `cdx:chrome-extension:channel`, `cdx:chrome-extension:profile`, `cdx:chrome-extension:profilePath`, `cdx:chrome-extension:manifestVersion`, and `cdx:chrome-extension:updateUrl`.
- Chromium-browser extensions discovered via `-t chrome-extension` can include security-sensitive fields from real manifests: `cdx:chrome-extension:permissions`, `cdx:chrome-extension:optionalPermissions`, `cdx:chrome-extension:hostPermissions`, `cdx:chrome-extension:optionalHostPermissions`, `cdx:chrome-extension:commands`, `cdx:chrome-extension:contentScriptsRunAt`, `cdx:chrome-extension:contentScriptsMatches`, `cdx:chrome-extension:contentSecurityPolicy`, `cdx:chrome-extension:storageManagedSchema`, `cdx:chrome-extension:webAccessibleResourceMatches`, `cdx:chrome-extension:externallyConnectableMatches`, and `cdx:chrome-extension:hasAutofill`.
- Chromium-browser extensions can include capability booleans derived from manifest + Babel source analysis: `cdx:chrome-extension:capability:fileAccess`, `cdx:chrome-extension:capability:deviceAccess`, `cdx:chrome-extension:capability:network`, `cdx:chrome-extension:capability:bluetooth`, `cdx:chrome-extension:capability:accessibility`, `cdx:chrome-extension:capability:codeInjection`, and `cdx:chrome-extension:capability:fingerprinting`.
- Vendor-specific fields are namespaced explicitly: Edge (`cdx:chrome-extension:edge:*`) and Brave (`cdx:chrome-extension:brave:*`).
- Chrome extensions discovered via osquery (`-t os`) use `pkg:chrome-extension` and may also carry `cdx:osquery:category`.

## Consumer-oriented views

### CI/CD trust

- `cdx:github:action:isShaPinned`
- `cdx:github:workflow:hasWritePermissions`
- `cdx:github:workflow:hasIdTokenWrite`
- `cdx:actions:isOfficial`
- `cdx:actions:isVerified`
- `cdx:gitlab:job:image`
- `cdx:azure:job:pool:vmImage`
- `cdx:circleci:orb:alias`
- `cdx:jenkins:agent:image`

### Dependency execution risk

- `cdx:npm:hasInstallScript`
- `cdx:npm:risky_scripts`
- `cdx:npm:native_addon`
- `cdx:npm:native_deps`
- `cdx:gem:executables`
- `cdx:cargo:features`

### Non-registry or local source detection

- `cdx:npm:isRegistryDependency`
- `cdx:npm:isLink`
- `cdx:npm:resolvedPath`
- `cdx:pypi:registry`
- `cdx:gem:remote`
- `cdx:gem:remoteRevision`
- `cdx:go:local_dir`
- `cdx:nix:input_url`
- `cdx:swift:localCheckoutPath`
- `cdx:pods:projectDir`
- `cdx:pub:registry`

### Reproducibility and drift

- `cdx:github:action:versionPinningType`
- `cdx:pypi:latest_version`
- `cdx:gem:remoteRevision`
- `cdx:gem:remoteBranch`
- `cdx:nix:revision`
- `cdx:nix:nar_hash`
- `cdx:go:creation_time`
- `cdx:build:versionSpecifiers`

### BOM completeness and explainability

- `cdx:bom:componentNamespaces`
- `cdx:bom:componentSrcFiles`
- `cdx:bom:componentTypes`
- `cdx:osquery:category`
- `cdx:service:httpMethod`

### IDE extension trust

- `cdx:vscode-extension:lifecycleScripts`
- `cdx:vscode-extension:activationEvents`
- `cdx:vscode-extension:untrustedWorkspaces`
- `cdx:vscode-extension:virtualWorkspaces`
- `cdx:vscode-extension:contributes`
- `cdx:vscode-extension:extensionDependencies`
- `cdx:vscode-extension:extensionPack`
- `cdx:vscode-extension:extensionKind`
- `cdx:vscode-extension:ide`

### Browser extension trust

- `cdx:chrome-extension:permissions`
- `cdx:chrome-extension:optionalPermissions`
- `cdx:chrome-extension:hostPermissions`
- `cdx:chrome-extension:optionalHostPermissions`
- `cdx:chrome-extension:contentScriptsRunAt`
- `cdx:chrome-extension:contentScriptsMatches`
- `cdx:chrome-extension:commands`
- `cdx:chrome-extension:capability:fileAccess`
- `cdx:chrome-extension:capability:deviceAccess`
- `cdx:chrome-extension:capability:network`
- `cdx:chrome-extension:capability:bluetooth`
- `cdx:chrome-extension:capability:accessibility`
- `cdx:chrome-extension:capability:codeInjection`
- `cdx:chrome-extension:capability:fingerprinting`
- `cdx:chrome-extension:hasAutofill`

## Entry template for future additions

When a new `cdx:` property is introduced, document it using this template so the inventory stays operational instead of becoming another flat list.

| Key               | Scope                                                  | Value type                                                          | Typical values                 | When emitted                          | Common policy use                     | Policy readiness                   | Notes                                        |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------ | ------------------------------------- | ------------------------------------- | ---------------------------------- | -------------------------------------------- |
| `cdx:example:key` | component / workflow / job / step / metadata / service | boolean string / list string / path / URL / timestamp / JSON string | `"true"`, `main`, `sha256-...` | Trigger or parser stage that emits it | What policy authors should do with it | Hard deny / Warning / Context only | Aliases, overlaps, or compatibility guidance |

## Practical use-case patterns with policy examples

Below are realistic examples showing how to use attributes individually and in combination.

<a id="example-1"></a>

### 1) Block unpinned GitHub Actions in privileged workflows

**Individual signal**

- `cdx:github:action:isShaPinned=false` means the action reference is tag/branch-based, not commit-SHA pinned.

**Combined signal**

- Escalate severity when both are true:
  - `cdx:github:action:isShaPinned=false`
  - `cdx:github:workflow:hasWritePermissions=true` (or `cdx:github:job:hasWritePermissions=true`)

**JSONata**

```
components[
  $prop($, 'cdx:github:action:isShaPinned') = 'false'
  and (
    $prop($, 'cdx:github:workflow:hasWritePermissions') = 'true'
    or $prop($, 'cdx:github:job:hasWritePermissions') = 'true'
  )
]
```

**OPA (Rego)**

```rego
package cdxgen.policies

has_prop(c, name, value) {
  some p in c.properties
  p.name == name
  p.value == value
}

deny[msg] {
  some c in input.components
  has_prop(c, "cdx:github:action:isShaPinned", "false")
  msg := sprintf("Unpinned GitHub Action: %s", [c.purl])
}

deny[msg] {
  some c in input.components
  has_prop(c, "cdx:github:action:isShaPinned", "false")
  has_prop(c, "cdx:github:workflow:hasWritePermissions", "true")
  msg := sprintf("Unpinned action in write-permission workflow: %s", [c.purl])
}
```

**CEL**

```cel
// any unpinned action
input.components.exists(c,
  c.properties.exists(p, p.name == "cdx:github:action:isShaPinned" && p.value == "false")
)

// unpinned action + write permissions
input.components.exists(c,
  c.properties.exists(p, p.name == "cdx:github:action:isShaPinned" && p.value == "false") &&
  (
    c.properties.exists(p, p.name == "cdx:github:workflow:hasWritePermissions" && p.value == "true") ||
    c.properties.exists(p, p.name == "cdx:github:job:hasWritePermissions" && p.value == "true")
  )
)
```

<a id="example-2"></a>

### 2) Flag npm packages with install-time execution risk

**Individual signals**

- `cdx:npm:hasInstallScript=true`
- `cdx:npm:risky_scripts` contains lifecycle hooks (for example `preinstall`, `postinstall`)

**Combined signal**

- Raise priority when execution risk combines with non-registry source:
  - `cdx:npm:hasInstallScript=true` (or `cdx:npm:risky_scripts` present)
  - `cdx:npm:isRegistryDependency=false`

**JSONata**

```
components[
  $prop($, 'cdx:npm:hasInstallScript') = 'true'
  and $prop($, 'cdx:npm:isRegistryDependency') = 'false'
]
```

**OPA (Rego)**

```rego
package cdxgen.policies

has_prop(c, name, value) {
  some p in c.properties
  p.name == name
  p.value == value
}

warn[msg] {
  some c in input.components
  has_prop(c, "cdx:npm:hasInstallScript", "true")
  msg := sprintf("npm package has install script: %s", [c.purl])
}

deny[msg] {
  some c in input.components
  has_prop(c, "cdx:npm:hasInstallScript", "true")
  has_prop(c, "cdx:npm:isRegistryDependency", "false")
  msg := sprintf("npm package executes install script from non-registry source: %s", [c.purl])
}
```

**CEL**

```cel
input.components.exists(c,
  c.properties.exists(p, p.name == "cdx:npm:hasInstallScript" && p.value == "true") &&
  c.properties.exists(p, p.name == "cdx:npm:isRegistryDependency" && p.value == "false")
)
```

<a id="example-3"></a>

### 3) Enforce approved package registries and local-source policy

**Individual signals**

- `cdx:pypi:registry` appears when a non-default Python registry is used.
- `cdx:pub:registry` appears when a non-default Dart registry is used.
- `cdx:swift:localCheckoutPath` and `cdx:pods:projectDir` identify local dependency sources.

**Combined signal**

- Combine non-approved registries or local checkouts with environment-specific release policy.

**JSONata**

```
components[
  $hasProp($, 'cdx:pypi:registry')
  and not(
    $prop($, 'cdx:pypi:registry') = 'https://pypi.org/simple'
    or $prop($, 'cdx:pypi:registry') = 'https://pypi.org'
  )
]
```

**OPA (Rego)**

```rego
package cdxgen.policies

approved_registries := {
  "https://pypi.org/simple",
  "https://pypi.org",
}

deny[msg] {
  some c in input.components
  some p in c.properties
  p.name == "cdx:pypi:registry"
  not approved_registries[p.value]
  msg := sprintf("Unapproved PyPI registry for %s: %s", [c.purl, p.value])
}

deny[msg] {
  some c in input.components
  c.properties[_].name == "cdx:swift:localCheckoutPath"
  msg := sprintf("Swift local checkout is not allowed in release BOMs: %s", [c.purl])
}
```

**CEL**

```cel
input.components.exists(c,
  c.properties.exists(p, p.name == "cdx:pypi:registry" &&
    !(p.value in ["https://pypi.org/simple", "https://pypi.org"]))
)
```

<a id="example-4"></a>

### 4) Require reproducibility metadata for Nix and Go

**Individual signals**

- `cdx:nix:revision`
- `cdx:nix:nar_hash`
- `cdx:go:local_dir`

**Combined signal**

- Consider a Nix dependency policy-compliant only when both lock properties are present.
- Treat Go local replacements as non-hermetic unless explicitly allowed.

**JSONata**

```
components[
  $startsWith(purl, 'pkg:nix/')
  and (
    not($hasProp($, 'cdx:nix:revision'))
    or not($hasProp($, 'cdx:nix:nar_hash'))
  )
]
```

For go, use `$hasProp($, 'cdx:go:local_dir')`

**OPA (Rego)**

```rego
package cdxgen.policies

has_prop(c, name) {
  some p in c.properties
  p.name == name
}

deny[msg] {
  some c in input.components
  startswith(c.purl, "pkg:nix/")
  not has_prop(c, "cdx:nix:revision")
  msg := sprintf("Nix component missing revision: %s", [c.purl])
}

deny[msg] {
  some c in input.components
  startswith(c.purl, "pkg:nix/")
  not has_prop(c, "cdx:nix:nar_hash")
  msg := sprintf("Nix component missing nar_hash: %s", [c.purl])
}

deny[msg] {
  some c in input.components
  has_prop(c, "cdx:go:local_dir")
  msg := sprintf("Go component uses local replacement: %s", [c.purl])
}
```

**CEL**

```cel
input.components.exists(c,
  c.purl.startsWith("pkg:nix/") &&
  (
    !c.properties.exists(p, p.name == "cdx:nix:revision") ||
    !c.properties.exists(p, p.name == "cdx:nix:nar_hash")
  )
) ||
input.components.exists(c,
  c.properties.exists(p, p.name == "cdx:go:local_dir")
)
```

<a id="example-5"></a>

### 5) Gate BOM completeness before downstream signing/attestation

**Individual signals**

- `cdx:bom:componentTypes`
- `cdx:bom:componentSrcFiles`

**Combined signal**

- Require both metadata properties to exist before generating a “trusted” attestation.

**JSONata**

```
not(
  $count(metadata.properties[name = 'cdx:bom:componentTypes']) > 0
  and $count(metadata.properties[name = 'cdx:bom:componentSrcFiles']) > 0
)
```

**OPA (Rego)**

```rego
package cdxgen.policies

meta_has(name) {
  some p in input.metadata.properties
  p.name == name
}

deny[msg] {
  not meta_has("cdx:bom:componentTypes")
  msg := "BOM metadata missing cdx:bom:componentTypes"
}

deny[msg] {
  not meta_has("cdx:bom:componentSrcFiles")
  msg := "BOM metadata missing cdx:bom:componentSrcFiles"
}
```

**CEL**

```cel
!(input.metadata.properties.exists(p, p.name == "cdx:bom:componentTypes") &&
  input.metadata.properties.exists(p, p.name == "cdx:bom:componentSrcFiles"))
```

<a id="example-6"></a>

### 6) Tighten OIDC use to trusted GitHub actions only

**Individual signals**

- `cdx:github:workflow:hasIdTokenWrite=true`
- `cdx:actions:isOfficial`
- `cdx:actions:isVerified`

**Combined signal**

- Escalate when a workflow can mint OIDC tokens and the action is neither official nor otherwise trusted by organization policy.

**JSONata**

```
components[
  $prop($, 'cdx:github:workflow:hasIdTokenWrite') = 'true'
  and $prop($, 'cdx:actions:isOfficial') = 'false'
]
```

**OPA (Rego)**

```rego
package cdxgen.policies

has_prop(c, name, value) {
  some p in c.properties
  p.name == name
  p.value == value
}

deny[msg] {
  some c in input.components
  has_prop(c, "cdx:github:workflow:hasIdTokenWrite", "true")
  has_prop(c, "cdx:actions:isOfficial", "false")
  msg := sprintf("OIDC-enabled workflow references non-official action: %s", [c.purl])
}
```

**CEL**

```cel
input.components.exists(c,
  c.properties.exists(p, p.name == "cdx:github:workflow:hasIdTokenWrite" && p.value == "true") &&
  c.properties.exists(p, p.name == "cdx:actions:isOfficial" && p.value == "false")
)
```

<a id="example-7"></a>

### 7) Audit VS Code extensions for install-time execution and host access

**Individual signals**

- `cdx:vscode-extension:lifecycleScripts` present (especially containing `postinstall`) means the extension runs scripts during installation.
- `cdx:vscode-extension:activationEvents` containing `*` means the extension activates on every workspace open.
- `cdx:vscode-extension:contributes` containing `terminal-access`, `filesystem-provider`, or `authentication-provider` indicates privileged host interaction capabilities.

**Combined signal**

- Escalate when an always-on extension also has terminal access or lifecycle scripts:
  - `cdx:vscode-extension:activationEvents` contains `*`
  - `cdx:vscode-extension:contributes` contains `terminal-access`
  - `cdx:vscode-extension:lifecycleScripts` present

**JSONata**

```
components[
  $startsWith(purl, 'pkg:vscode-extension/')
  and $hasProp($, 'cdx:vscode-extension:lifecycleScripts')
]
```

**OPA (Rego)**

```rego
package cdxgen.policies

has_prop(c, name) {
  some p in c.properties
  p.name == name
}

prop_value(c, name) := v {
  some p in c.properties
  p.name == name
  v := p.value
}

deny[msg] {
  some c in input.components
  startswith(c.purl, "pkg:vscode-extension/")
  has_prop(c, "cdx:vscode-extension:lifecycleScripts")
  msg := sprintf("VS Code extension has lifecycle scripts: %s", [c.purl])
}

warn[msg] {
  some c in input.components
  startswith(c.purl, "pkg:vscode-extension/")
  v := prop_value(c, "cdx:vscode-extension:activationEvents")
  contains(v, "*")
  msg := sprintf("VS Code extension uses wildcard activation (always-on): %s", [c.purl])
}

deny[msg] {
  some c in input.components
  startswith(c.purl, "pkg:vscode-extension/")
  v := prop_value(c, "cdx:vscode-extension:activationEvents")
  contains(v, "*")
  cv := prop_value(c, "cdx:vscode-extension:contributes")
  contains(cv, "terminal-access")
  msg := sprintf("Always-on VS Code extension with terminal access: %s", [c.purl])
}
```

**CEL**

```cel
// extension with lifecycle scripts
input.components.exists(c,
  c.purl.startsWith("pkg:vscode-extension/") &&
  c.properties.exists(p, p.name == "cdx:vscode-extension:lifecycleScripts")
)

// always-on extension with terminal access
input.components.exists(c,
  c.purl.startsWith("pkg:vscode-extension/") &&
  c.properties.exists(p, p.name == "cdx:vscode-extension:activationEvents" && p.value.contains("*")) &&
  c.properties.exists(p, p.name == "cdx:vscode-extension:contributes" && p.value.contains("terminal-access"))
)
```

## Notes for policy authors

- Prefer evaluating these as **context enrichers** rather than strict truth assertions unless you explicitly normalize missing-vs-false semantics.
- Treat workspace/local path indicators (`isLink`, `resolvedPath`, `localCheckoutPath`, `projectDir`, `flake_dir`, `local_dir`) as provenance signals that may require stronger trust controls.
- Treat execution-related indicators (`risky_scripts`, `hasInstallScript`, CI write permissions, OIDC enablement, action pinning type) as high-priority triage fields for software supply chain risk.
- Treat VS Code extension lifecycle scripts (`cdx:vscode-extension:lifecycleScripts`) with the same urgency as npm install scripts (`cdx:npm:hasInstallScript`); both represent install-time code execution risk. Wildcard activation events (`*`) combined with terminal access or filesystem provider contributions indicate extensions with broad host access capabilities.
- In Rego examples, use helper predicates such as `has_prop(c, name, value)` to ensure all property checks evaluate against the same component instance, avoiding unintended cross-component matches from repeated `c.properties[_]` array iteration.
- Match overlapping keys where noted (`cdx:npm:isWorkspace` and `cdx:npm:is_workspace`; Azure pool defaults and job overrides) so older and newer BOMs behave consistently in policy engines.
