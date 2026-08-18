---
name: PDF Plans Viewer
description: Architecture and critical decisions for the PDF Plans Viewer artifact and its API backend.
---

# PDF Plans Viewer — Key Decisions

## pdfjs-dist version
Use **3.11.174** (not 4.x or 6.x). v6 broke Vite/worker in this proxy env.
Worker is copied to `artifacts/pdf-plans-viewer/public/pdf.worker.min.js` and
referenced as `${import.meta.env.BASE_URL}pdf.worker.min.js` in `pdfUtils.ts`.
Render API: `canvasContext` (v3 style, not the v6 `canvas` style).

**Why:** pdfjs-dist 6.x could not load its worker through the Replit proxy's
Vite bundler. v3 worker served as a static file bypasses all module-resolution issues.

## API routing
API server (`artifacts/api-server`) is registered at preview path `/api` in its
`artifact.toml`. The Replit router at port 80 forwards `/api/*` to the API server.
No Vite proxy is needed — the browser calls `/api/...` and the platform routes it.

## DB schema tables
`documents`, `document_scales`, `annotations`, `measurements`, `shares`
All in `lib/db/src/schema/`. Annotations and measurements use client-supplied UUIDs as PK.

## Share links
Share token stored in `shares.token` (UUID). Frontend appends `?share=TOKEN` to URL.
On startup Shell.tsx checks URL params and loads via `getShare(token)`.

## Fabric → API type bridge
`fabric.Object.toObject()` returns a typed shape without an index signature.
Must double-cast: `obj.toObject() as unknown as Record<string, unknown>` before
passing to API `fabricData` fields.

## Electron
Config lives in `artifacts/pdf-plans-viewer/electron/` (main.ts + preload.ts)
and `electron-builder.yml`. Build via `pnpm run electron:build` in that package.
Requires `electron` and `electron-builder` devDeps installed locally.
API base URL for the packaged app must be set at build time via `VITE_API_BASE_URL`.
