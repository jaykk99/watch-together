# Watch Together

Watch together on two devices with a 4-digit room code. No install, no account, no API keys. Runs on Vercel.

## Two modes

**`/` — browser**
The host shares a link. `api/proxy.js` fetches it server-side, strips common ad/tracker tags and popup-redirect scripts, and serves it back from our own domain so it can be embedded even on sites that normally block framing. It loads in a real, sandboxed `<iframe>` (no popups, no top-level redirects) on the host's and every viewer's device; the viewer's copy is shielded so only the host can click. No signup, no API keys.

**`/player` — synced player**
The host loads a direct `.mp4` / `.m3u8` link or a local file. Play, pause, seek and rewind/forward 10s sync to the viewer, with drift correction every 2s.

Use only sources you have the rights to watch.

## Known limits

- **It's a filter, not a full ad blocker.** `api/proxy.js` strips `<script>`/`<iframe>` tags from a curated list of common ad/tracker domains, known inline ad-loader signatures, and `adsbygoogle` blocks, plus hides common ad-container classes with CSS. Ads injected later by a site's own first-party JavaScript (very common on modern ad networks) aren't caught — only what's present in, or directly loaded from, the initial HTML.
- **Popups and page-hijack redirects are blocked categorically.** The iframe is sandboxed without `allow-popups` or top-navigation, so `window.open()`, `target="_blank"`, and frame-busting redirect scripts can't fire — this alone kills most of the "ads appear immediately" experience on shady streaming sites, independent of the filter list above.
- **Some JS-heavy sites will partially break.** Only the top-level HTML is proxied; other resources (scripts, images, the page's own API calls) still load directly from the real site via an injected `<base>` tag. A site's own AJAX/fetch calls to its own domain become cross-origin from the browser's point of view once served from our domain, so they can fail if that site doesn't send permissive CORS headers — this can break dynamic content (video players that fetch sources via AJAX, comment sections, infinite scroll, etc.) even though the initial page renders.
- **Logins/sessions usually won't work.** The proxy doesn't persist cookies per visitor, so sites that require being signed in generally won't function correctly.
- **Only the host's typed URL syncs.** Since each device loads its own iframe, the viewer can't see clicks or in-page navigation the host makes *inside* the site — only the link the host explicitly enters and hits Go on.
- **This is effectively an open proxy.** `api/proxy.js` has no auth and will fetch any public http(s) URL (it blocks localhost/private IP ranges as a basic SSRF guard, but nothing else). Anyone who finds the endpoint could use it to fetch arbitrary pages through your Vercel deployment.

## Setup

None — no environment variables, no API keys. Room codes and sync go over Supabase Realtime (broadcast + presence): no tables needed. The Supabase URL and publishable key in the pages are safe to expose.
