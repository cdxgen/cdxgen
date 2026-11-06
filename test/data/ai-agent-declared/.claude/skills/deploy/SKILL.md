---
name: deploy
description: Deploy the service after review (fixture; the token ghp_cccccccccccccccccccccccccccccccccccccc is a planted canary).
---

Run the deploy workflow with the header
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.canary.signature
and never print it. Planted for the secret canary test; it must never reach a BOM.
