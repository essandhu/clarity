# Showcase media

Screenshots and the demo GIF used by the top-level `README.md`. **Everything here is
captured from the app actually running** — nothing is mocked or hand-drawn.

| File | What it is | Needs a model? |
| --- | --- | --- |
| `demo.gif` | A live `qwen3:4b` analyze run on `greenhouse-style.txt`: agent steps → coverage → extracted profile → streaming briefing | yes |
| `analyze-completed.png` | The finished analyze run (briefing + hooks) | yes |
| `analyze-landing.png` | The Analyze landing with a listing pasted and the provider chip resolved | no |
| `resume-profile.png` | The master-profile editor, seeded from the Maya Chen fixture (viewport crop) | no |
| `resume-profile-full.png` | The same editor, full page | no |

## Regenerating

`capture.ts` drives a **headless system Chrome** (via `playwright-core`) against the
running dev server and writes the media into this folder. The GIF is encoded in pure JS
(`pngjs` + `gifenc`) — no `ffmpeg` required.

1. **Run the app** with a reachable model. From `apps/web/`:

   ```bash
   # .env.local: MODEL_PROVIDER=ollama  (and `ollama pull qwen3:4b`)
   npm run dev
   ```

   Drive it via **`http://localhost:3000`**, not `127.0.0.1` — Next's dev HMR socket is
   bound to the `localhost` host, and on `127.0.0.1` the failed HMR handshake stalls the
   client so the provider chip never leaves “checking model…”.

2. **(Optional) seed the resume editor** so the `resume-*` stills show a populated
   profile instead of the empty state. This overwrites your local profile, so back it up
   first:

   ```bash
   cp apps/web/data/profile/master.json /tmp/master.json.backup   # if you have one
   cp apps/web/fixtures/resume/master-profile.json apps/web/data/profile/master.json
   # …capture…            then restore:
   cp /tmp/master.json.backup apps/web/data/profile/master.json
   ```

3. **Capture.** From this folder:

   ```bash
   npm install
   npm run stills   # analyze-landing.png, resume-profile*.png   (seconds)
   npm run demo     # demo.gif + analyze-completed.png           (a live run — minutes)
   ```

   Overrides: `CLARITY_BASE_URL` (default `http://localhost:3000`) and `CHROME_PATH`
   (default the standard Windows Chrome path).

The `demo` run is a genuine CPU-Ollama analysis, so it takes several minutes; the script
captures the streaming phase into the GIF, then waits for the run to finish before taking
the completed still.
