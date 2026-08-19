---
name: Pending sync semantics
description: Durable delivery rules for PDF annotation and measurement operations that survive a connectivity gap.
---

# Pending sync semantics

Persist annotation, measurement, and scale operations at user-action time in
causal order using a monotonic sequence. A queued delete must never cancel or
overtake a queued create for the same item; for a page scale, retain only the
latest pending value for that document-page pair.

**Why:** A transport failure can happen after the server has committed a create
but before the browser receives its response. Dropping the later delete under
the assumption that the create failed causes a deleted item to reappear after
reload.

**How to apply:** Do not persist operations only after their network requests
fail: a later delete may appear successful while an earlier create is still
unresolved. Record every intent before sending it, flush one operation at a
time, and stop at a real failure. Treat a duplicate create (HTTP 409) and an
already-absent delete (HTTP 404) as successful idempotent outcomes, then
advance the queue. Give replaceable page-level settings a document-page queue
identity and sequence-aware acknowledgement so an older response cannot remove
a newer user choice. Any UI that shows a pending count must subscribe to queue
mutations rather than only refreshing on reload.

## Offline reopen

Cache the server document ID against a SHA-256 digest of the PDF bytes when a
document first loads successfully.

**Why:** An offline reopen cannot call the API to discover a document ID, so it
otherwise has no way to find and render that PDF's locally queued work. A
filename-and-size key is unsafe: different PDFs can collide and a rename would
lose the mapping.

**How to apply:** On a failed remote load, recover the cached ID by content
digest, merge the local queue over an empty remote snapshot, and render it
immediately. Do not migrate legacy filename-and-size mappings; discard them
because they cannot be safely attributed. When connectivity returns, hydrate
the remote snapshot first and then flush the queue. A manual retry must invoke
this persistent-queue path too, not only in-memory callbacks from the current
session.