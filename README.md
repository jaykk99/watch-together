# Watch Together

Watch together on two devices with a 4-digit room code. No install, no account, no API keys. Runs on Vercel.

## Two modes

**`/` — browser**
The host shares a link. It opens in a real `<iframe>` on the host's and every viewer's device, and the viewer's copy is shielded so only the host can click. No backend, no signup.

**`/player` — synced player**
The host loads a direct `.mp4` / `.m3u8` link or a local file. Play, pause, seek and rewind/forward 10s sync to the viewer, with drift correction every 2s.

Use only sources you have the rights to watch.

## Known limits

- **Some sites block embedding.** Sites that send `X-Frame-Options` or a `Content-Security-Policy: frame-ancestors` header refuse to load inside an iframe and will stay blank. There's no way around this without a real backend browser (which needs a paid API key, e.g. Browserbase) — try a different link, or use `/player` if you have a direct video URL.
- **Only the host's typed URL syncs.** Since each device loads its own iframe of the real site, the viewer can't see clicks or in-page navigation the host makes *inside* that site — only the link the host explicitly enters and hits Go on.

## Setup

None — no environment variables, no API keys. Room codes and sync go over Supabase Realtime (broadcast + presence): no tables needed. The Supabase URL and publishable key in the pages are safe to expose.
