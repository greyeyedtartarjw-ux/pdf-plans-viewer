---
name: GitHub workflow writes
description: Connector limitation encountered when bootstrapping GitHub Actions in a new repository.
---

GitHub connector API writes to Actions workflow paths may be blocked by the connector edge even when ordinary repository administration and file writes succeed.

**Why:** Both the contents API and lower-level Git-object approaches failed while branch protection, branch creation, ordinary file writes, and pull-request operations worked.

**How to apply:** When bootstrapping a repository, use normal Git transport to push the project and its workflow files. Do not assume connector-based workflow writes can replace the initial source push.