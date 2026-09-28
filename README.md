# Watch Together

Watch together on two devices with a 4-digit room code. No install, no account. Runs on Vercel.

## Two modes

**`/browser` — cloud browser (host drives, viewer watches)**
The host taps *Start browser*: a Browserbase cloud Chrome (ad blocker on) opens in the page. The host controls it directly. The viewer sees the same live browser with a shield over it, so they cannot click anything.

**`/` — synced player**
The host loads a direct `.mp4` / `.m3u8` link or a local file. Play, pause, seek and rewind/forward 10s sync to the viewer, with drift correction every 2s.

Use only sources you have the rights to watch.

## Setup (Vercel env vars)

| Name | What |
|---|---|
| `BROWSERBASE_API_KEY` | from browserbase.com |
| `BROWSERBASE_PROJECT_ID` | from browserbase.com |
| `HOST_PIN` | optional; if set, hosts must enter it (protects your Browserbase credits) |

Room codes and sync go over Supabase Realtime (broadcast + presence): no tables needed. The Supabase URL and publishable key in the pages are safe to expose.

## Known limits

- Browserbase's live view streams video; sound may not come through. If it doesn't, movie audio won't play in `/browser`, and the synced player at `/` is the option with sound.
- Browserbase sessions are billed per minute; leaving the room releases the session.
