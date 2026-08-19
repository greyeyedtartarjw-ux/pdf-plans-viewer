---
name: Playwright WebKit on Nix
description: How the cross-browser release check runs WebKit reliably in the Replit Nix environment.
---

The WebKit release check must bootstrap its Playwright browser revision and give
WebKit the runtime library directories resolved from the active Nix package
index. Its Ubuntu-focused dependency preflight should not be treated as the
source of truth when those Nix paths are present; the actual browser launch and
rendered-PDF assertions are the proof that matters.

**Why:** Playwright's standard Linux dependency detector expects distribution
library locations and reports false missing libraries for Nix-provided WebKit
dependencies, even when the browser can render successfully with the Nix
runtime paths.

**How to apply:** Keep browser installation coupled to the release check and
keep the WebKit-specific runtime setup. If updating Playwright or Nix packages,
run the full cross-browser check and require the rendered page and deferred
asset assertions to pass in WebKit.