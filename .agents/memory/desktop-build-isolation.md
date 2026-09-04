---
name: Desktop build isolation
description: Why packaged desktop bundles use a separate Vite output directory.
---

Desktop packaging must consume a dedicated web output directory rather than the
managed web release directory.

**Why:** Replit's managed release check can rebuild the web artifact concurrently.
Hashed chunk filenames may change while Electron is copying them, producing a
nondeterministic missing-file packaging failure.

**How to apply:** Any future desktop packager or desktop smoke check should build
and read its own output directory. Keep the ordinary web release output reserved
for the managed web workflow.