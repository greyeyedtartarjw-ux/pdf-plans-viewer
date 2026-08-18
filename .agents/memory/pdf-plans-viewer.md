---
name: PDF Plans Viewer
description: Architecture and critical decisions for the PDF Plans Viewer artifact, its API backend, and the Plans Mobile Expo app.
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

## Plans Mobile (Expo)
Expo mobile companion at `artifacts/plans-mobile`. Key decisions:

**PDF rendering:** Uses WebView with embedded PDF.js 3.11.174 from cdnjs CDN.
HTML template is a string constant exported from `constants/viewerHtml.ts`.
WebView and RN communicate via `injectJavaScript` (RN→WebView) and
`ReactNativeWebView.postMessage` / `window.dispatchEvent` (WebView→RN).
Android needs `document.addEventListener('message')`, iOS uses `window.addEventListener('message')`.

**Coordinate system:** Measurement points are in WebView canvas pixels (not normalized).
Canvas size (`width`, `height`) is reported in each `measurementComplete` event so RN
can compute real-world distance/area. The WebView auto-scales PDF to viewport width.

**Local document storage:** AsyncStorage key `@plans_mobile_documents_v1` stores
`{id, name, localPath, hash, addedAt}[]`. `localPath` is under `FileSystem.documentDirectory`.
API's `upsertDocument({name, hash})` is called on import to register the document and
get back the stable `id` used for API measurements calls.

**Scale mismatch:** `pixelsPerUnit` from the API was calibrated in the web app's canvas pixels.
Mobile renders at a different scale (viewport-width-based). For now, scale is applied to
mobile canvas pixels too — measurements stored as `realWorldValue` are the source of truth.

**Packages pinned:** `react-native-webview@13.15.0`, `expo-document-picker@~14.0.8`,
`expo-file-system@~19.0.24` (Expo 54 compatible). Installing newer versions without
pinning causes Metro bundler warnings.

**No tabs UI:** Uses Stack navigation only (no tab bar). The `(tabs)` group is repurposed
as a plain Stack group — `app/(tabs)/_layout.tsx` renders a `<Stack>` instead of `<Tabs>`.

**UUID generation:** Used `Date.now().toString(36) + Math.random().toString(36).slice(2, 9)`.
Do NOT use the `uuid` package (crashes on iOS/Android).
