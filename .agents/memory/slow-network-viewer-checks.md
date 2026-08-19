---
name: Slow-network viewer checks
description: Constraints for validating deferred PDF viewer features under a throttled connection.
---

The slow-network release check must wait for an explicit successful PDF page
render, not merely for the viewer container to mount. It must also use the
normal successful document-open path with isolated API responses.

**Why:** The viewer shell mounts before its lazy renderer is downloaded or a
page has painted. A failed document-registry request can also trigger a
blocking browser alert, which hides the actual rendering behavior being
tested.

**How to apply:** Keep the browser check’s local API responses aligned with the
read-only open flow, and keep a render-complete signal that is set only after
the PDF page render promise resolves. Treat a nonzero rendered canvas plus that
signal as the readiness condition; deferred-tool request assertions remain
separate.