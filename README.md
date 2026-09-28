# Watch Together

A tiny web app for watching a video in sync on two devices. No install, no account.

- **Host** creates a room and gets a 4-digit code.
- **Viewer** opens the same page and enters the code.
- The host has all the controls (play, pause, seek, rewind/forward 10s). The viewer's player is locked and follows the host automatically, with drift correction every 2 seconds.
- Video source: the host pastes a direct `.mp4` / `.m3u8` link, or picks a local file (the viewer then picks the same file).

Use only sources you have the rights to watch.

## How it works

Static page (`index.html`) on Vercel. Room codes and sync messages go over Supabase Realtime (broadcast + presence), so there is no server code and no database tables.

## Deploy

Import the repo in Vercel (framework: Other, no build step). The Supabase URL and publishable key at the top of the script in `index.html` are safe to expose.

## Limits

A web page cannot embed and control other websites' players, so streaming sites can't be opened inside the app. Only direct video links and local files sync.
