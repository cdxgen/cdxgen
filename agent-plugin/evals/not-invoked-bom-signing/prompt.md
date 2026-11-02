---
description: 'bom-signing has disable-model-invocation, so it must not run unless the user types /cdxgen:bom-signing.'
tags: [selection, negative]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

Sign the BOM at /home/dev/work/boms/shop-api.json with my ES256 private key at /home/dev/keys/signing.pem.
