# Desktop release builds

The Electron app packages the same viewer used by the web artifact. It stores the
immutable copies of imported PDFs and an atomic recovery snapshot that references
the matching copy in the operating system's per-user application-data directory.
An interrupted import therefore leaves the previous valid plan/state pair intact.
Pending server operations remain visible
and are removed only after a confirmed or idempotently confirmed API response.

## Prerequisites

- Node.js and pnpm versions supported by this workspace
- Dependencies installed with `pnpm install`
- Windows x64 for a conventional NSIS Windows build
- macOS for a conventional DMG build (Apple's tooling does not run on Linux)

## Commands

From the repository root:

```sh
VITE_DESKTOP_API_URL=https://plans.example.com pnpm --filter @workspace/pdf-plans-viewer run electron:build:windows
VITE_DESKTOP_API_URL=https://plans.example.com pnpm --filter @workspace/pdf-plans-viewer run electron:build:mac
```

`VITE_DESKTOP_API_URL` must be the HTTPS origin that serves the viewer's `/api`
routes. If it is omitted, the installed app opens local plans and saves edits
locally but intentionally remains offline.

The desktop web bundle is written to `dist/desktop-public`, separately from the
managed web release build, so both builds can run safely at the same time.
Installers are written to `artifacts/pdf-plans-viewer/dist-installer` with names
such as `PDF-Plans-Viewer-1.0.0-win-x64.exe` and
`PDF-Plans-Viewer-1.0.0-mac-x64.dmg`.

## Signing

Unsigned installers are intentional for local validation. Windows SmartScreen
and macOS Gatekeeper may warn about unsigned applications. A public release
should provide the appropriate Microsoft code-signing certificate and Apple
Developer ID/notarization credentials through the build environment; credentials
must never be committed to this repository.

## Security boundary

The renderer has Node integration disabled, context isolation enabled, and
sandboxing enabled. The preload bridge exposes only PDF selection and bounded
recovery-state reads/writes. External navigation is denied; HTTPS and mail links
may open only in the operating system browser.