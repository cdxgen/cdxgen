---
description: 'Precedence is CLI, then CDXGEN_ variables, then rc files, and variables carry the CDXGEN_ prefix.'
tags: [safety]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

I set CDXGEN_TYPE=java in my environment but also pass -t python on the command line. Which one wins? And how do I turn on license fetching through an environment variable?
