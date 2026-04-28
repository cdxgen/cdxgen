---
position: 2
title: Getting Started with Development
---

# Getting Started (Development)

This is a comprehensive guide to contributing for developers of all experience level.

## Setting up the Development Environment

Here are steps to clone and run cdxgen locally.

Clone `cdxgen/cdxgen` project repository.

```bash
git clone https://github.com/cdxgen/cdxgen
cd cdxgen

corepack enable pnpm
pnpm install --config.strict-dep-builds=true
pnpm test
```
