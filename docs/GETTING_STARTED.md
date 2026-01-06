---
position: 2
title: Getting Started with Development
---

# Getting Started (Development)

This is a comprehensive guide to contributing for developers of all experience level.

## Setting up the Development Environment

Here are steps to clone and run cdxgen locally.

Clone `CycloneDX/cdxgen` project repository.

```bash
git clone https://github.com/cdxgen/cdxgen
cd cdxgen

corepack enable pnpm
pnpm install --config.strict-dep-builds=true
pnpm test
```

## devenv setup

Install devenv by following the official [instructions](https://devenv.sh/getting-started/).

```shell
devenv shell
pnpm test
```

### Language-specific profile

```shell
# deno environment
devenv --option config.profile:string deno shell

# Ruby environment
devenv --option config.profile:string ruby shell

# dotnet environment
devenv --option config.profile:string dotnet shell

# android environment
devenv --option config.profile:string android shell

# flutter environment
devenv --option config.profile:string flutter shell
```

### Tasks

```shell
# Prepare to contribute a PR
devenv tasks run pr:prepare

# Check for outdated dependencies
devenv tasks run pnpm:outdated

# Prepare a deno-based environment
devenv tasks run deno:prepare

# Check if cdxgen and evinse command can work
devenv tasks run deno:checks

# Create SEA binary
devenv tasks run deno:compile:macos
```
