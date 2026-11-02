---
description: 'dependency-track-upload has disable-model-invocation, so it must not run unless the user types /cdxgen:dependency-track-upload.'
tags: [selection, negative]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

Upload the BOM at /home/dev/work/boms/shop-api.json to our Dependency-Track server at https://deptrack.example.com.
