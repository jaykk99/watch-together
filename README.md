# Watch Together

Watch together on two devices with a 4-digit room code. No install, no account, no API keys. Runs on Vercel.

## Two modes

**`/` — browser**
The host shares a link. `api/proxy.js` fetches it server-side, strips common ad/tracker tags and popup-redirect scripts, and serves it back from our own domain so it can be embedded even on sites that normally block framing. It loads in a real, sandboxed `<iframe>` (no popups, no top-level redirects) on the host's and every viewer's device; the viewer's copy is shielded so only the host can click. No signup, no API keys.

**`/player` — synced player**
The host loads a direct `.mp4` / `.m3u8` link or a local file. Play, pause, seek and rewind/forward 10s sync to the viewer. Sync snapshots carry a wall-clock timestamp, so viewers project the host's true position instead of guessing network delay; drift correction is handled by the tested pure module `assets/sync.js` (hard seek beyond 2.5s, ±6% rate nudge beyond 0.6s, live Δ indicator). Viewers report drift back every 5s and the host sees an "N in sync" count. The host can attach a `.vtt` subtitle track that syncs to viewers. If the host leaves, the longest-present viewer is promoted automatically. If the realtime link drops, the client retries with backoff and rejoins the same room. A stall watchdog re-asks the host for state if no update arrives.

Both rooms now include: display names, a live participant roster, room chat, emoji reactions, copy-code / copy-invite-link buttons (`?room=1234` deep links), toasts, and a modern responsive layout.

Use only sources you have the rights to watch.

## Proxy guardrails (`api/proxy.js`)

- **Rate limited:** 60 requests/minute per client IP per instance → `429` with `Retry-After: 30` when exceeded.
- **SSRF hardened:** blocks private/loopback/link-local/multicast/reserved/documentation IPv4 ranges in every encoding — dotted (`127.0.0.1`), short (`127.1`), decimal (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`) — plus `localhost` names and IPv6 unique-local/link-local. The final URL is re-checked after every redirect chain.
- **Method guard:** non-GET returns `405` with `Allow: GET`.
- Responses carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## Known limits

- **It's a filter, not a full ad blocker.** `api/proxy.js` strips `<script>`/`<iframe>` tags from a curated list of common ad/tracker domains, known inline ad-loader signatures, and `adsbygoogle` blocks, plus hides common ad-container classes with CSS. Ads injected later by a site's own first-party JavaScript (very common on modern ad networks) aren't caught — only what's present in, or directly loaded from, the initial HTML.
- **Popups and page-hijack redirects are blocked categorically.** The iframe is sandboxed without `allow-popups` or top-navigation, so `window.open()`, `target="_blank"`, and frame-busting redirect scripts can't fire — this alone kills most of the "ads appear immediately" experience on shady streaming sites, independent of the filter list above.
- **Some JS-heavy sites will partially break.** Only the top-level HTML is proxied; other resources (scripts, images, the page's own API calls) still load directly from the real site via an injected `<base>` tag. A site's own AJAX/fetch calls to its own domain become cross-origin from the browser's point of view once served from our domain, so they can fail if that site doesn't send permissive CORS headers — this can break dynamic content (video players that fetch sources via AJAX, comment sections, infinite scroll, etc.) even though the initial page renders.
- **Logins/sessions usually won't work.** The proxy doesn't persist cookies per visitor, so sites that require being signed in generally won't function correctly.
- **Only the host's typed URL syncs.** Since each device loads its own iframe, the viewer can't see clicks or in-page navigation the host makes *inside* the site — only the link the host explicitly enters and hits Go on.
- **This is effectively an open proxy.** `api/proxy.js` has no auth and will fetch any public http(s) URL (it blocks localhost/private IP ranges as a basic SSRF guard, but nothing else). Anyone who finds the endpoint could use it to fetch arbitrary pages through your Vercel deployment. It is rate-limited to 60 req/min per IP (429 beyond that) to blunt casual abuse — raise, lower, or add auth if that doesn't fit your threat model.

## Tests

`npm test` — proxy suite (47 tests for `api/proxy.js`: SSRF host blocking in dotted/octal/hex/decimal forms, ad stripping, 405/400/429 paths, per-IP rate limiting, live end-to-end fetch) plus `tests/sync.test.mjs` (19 tests for the sync math in `assets/sync.js`: timestamp projection, drift-decision boundaries, snapshot building, status text).

## Setup

None — no environment variables, no API keys. Room codes and sync go over Supabase Realtime (broadcast + presence): no tables needed. The Supabase URL and publishable key in the pages are safe to expose.
