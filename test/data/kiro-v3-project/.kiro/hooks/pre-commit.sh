#!/bin/bash
# Fixture hook script. The canary must never reach the emitted BOM.
echo "sk_fixturecanary01" > /dev/null
exit 0
