---
name: Offline mobile measurements
description: Reliability rules for the mobile measurement cache and offline retry queue.
---

Persist both pending *and confirmed* measurements locally. A retry queue alone only protects new offline drawings; field users must also be able to reopen plans with all previously confirmed measurements while no network is available.

**Why:** The PDF itself already lives on-device, so rendering it without its historical measurements produces a misleading incomplete plan. Network recovery can also overlap with a new drawing, and independent read-modify-write operations against AsyncStorage can overwrite that new pending item.

**How to apply:** Update the confirmed-measurement cache after API reads and mutations, hydrate it alongside remote data (not only after an error), and route every retry-queue mutation through one serialized operation. Make cache list writes merge-aware so an older in-flight list response cannot erase a later create/delete. Retain failed queue entries and only remove an item after a successful server response.

The mobile PDF renderer and its worker must be bundled as local app assets, never loaded from a runtime CDN.

**Why:** A cached PDF and measurements are still unusable on a cold offline launch if the WebView must fetch PDF.js before rendering.

**How to apply:** Keep the prebuilt library and worker registered as Metro assets, resolve their local URLs before constructing the WebView HTML, and verify an Android export includes both exact asset files.