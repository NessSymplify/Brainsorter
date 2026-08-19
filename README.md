# Brainsorter

## What this is

A real Vite + React project — different from the single-file version you've
been testing inside Claude chat. That version relies on two things that only
exist inside Claude's artifact sandbox:

- `window.storage` for persistence
- A proxied, pre-authenticated connection to the Anthropic API

Neither exists on a normal website, so this copy has:

- **Real persistence** via `localStorage` (see `storeGet`/`storeSet` near the
  top of `src/App.jsx`)
- **AI features turned off** (`AI_ENABLED = false` near the top of
  `src/App.jsx`) — splitting a brain dump falls back to the local
  word/punctuation splitter, and photo capture adds the photo as a single
  item you fill in by hand, since there's no offline substitute for reading
  a photo

Everything else — every card style, gesture, filter, the whole feed — is
identical.

## Test it on your phone right now (no deploy needed)

```
npm install
npm run dev -- --host
```

That prints a `Network:` URL like `http://192.168.1.23:5173`. Open that on
your phone's browser as long as it's on the same wifi as this computer.

## Deploy to GitHub Pages

1. Create a new GitHub repo. **Note the name** — if you don't call it
   `brainsorter`, edit `base` in `vite.config.js` to match (e.g. a repo named
   `my-app` needs `base: "/my-app/"`).
2. Push this whole folder to it:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo-name>.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source → GitHub
   Actions**. The included workflow (`.github/workflows/deploy.yml`) builds
   and deploys automatically on every push to `main` — no further setup.
4. First deploy takes a minute or two. Your app will be at
   `https://<you>.github.io/<repo-name>/`.
5. On your phone: open that URL in Safari → Share → **Add to Home Screen**.
   You get a real icon and it opens full-screen, no browser bar.

## Turning AI features back on later

You'll need a small backend that holds your Anthropic API key server-side —
never put a real key in this client code, since anyone can read it straight
out of the deployed JS bundle. Once you have one:

1. Set `AI_ENABLED = true` in `src/App.jsx`.
2. Point `extractItemsFromText` and `extractItemsFromImage` at your backend's
   URL instead of `https://api.anthropic.com/v1/messages` directly.

## Known limitation

Photos are stored as base64 in `localStorage`, which most browsers cap
around 5–10MB total. Fine for testing; if you take a lot of photos you'll
eventually want IndexedDB instead (higher limits, but more code — happy to
build that when you're ready).
