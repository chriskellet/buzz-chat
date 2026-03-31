# ⚡ Buzz — Instant P2P Chat

A zero-config, peer-to-peer chat app that runs entirely on GitHub Pages. No server, no signup, no database — just share a room code and go.

## How it works

Buzz uses [Gun.js](https://gun.eco/) for decentralised, real-time data sync via public relay peers. Messages are synced peer-to-peer with no centralised server storing your data.

## Features

- **Room-based chat** — join via code or generate a random room
- **URL sharing** — room code lives in `?room=` query param, just share the link
- **Typing indicators** — see when others are typing
- **Presence** — live peer count with heartbeat
- **Zero config** — single HTML file, no build step, no dependencies to install
- **Modern UI** — dark theme, OKLCH colours, smooth animations

## Deploy

### GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages → Source → Deploy from branch** (`main`, root)
3. Your chat is live at `https://<you>.github.io/buzz-chat/?room=my-room`

### Anywhere else

It's a single `index.html`. Drop it on any static host — Netlify, Vercel, S3, a USB stick, whatever.

## Usage

Open the app, pick a name, enter or generate a room code, and start chatting. Share the URL with anyone you want in the room.

```
https://<you>.github.io/buzz-chat/?room=friday-standup
```

## Tech

- **Gun.js** — decentralised real-time database (loaded from CDN)
- **Vanilla JS** — no framework, no build step
- **OKLCH** — perceptually uniform colour space for the UI
- Single file: `index.html` (~11KB)

## Limitations

- Messages persist in the Gun.js network graph — there's no TTL/expiry built in (a relay-side concern)
- Public Gun relays can be flaky; add your own relay for production use
- No end-to-end encryption yet (Gun SEA is loaded but not wired up — PR welcome)

## Licence

MIT
