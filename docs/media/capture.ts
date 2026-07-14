/**
 * Repo-showcase capture harness for Clarity.
 *
 * Drives the REAL running app with a headless system Chrome and produces the
 * README media into this directory (docs/media/):
 *
 *   stills : model-free screenshots — the Analyze landing and the Resume editor
 *            (seeded from apps/web/fixtures/resume/master-profile.json).
 *   demo   : a LIVE analyze run on apps/web/fixtures/listings/greenhouse-style.txt.
 *            Captures the agent working (steps -> coverage -> extracted profile),
 *            waits for the run to finish, then smooth-scrolls the finished
 *            deliverable — encoded to demo.gif, plus a finished-run still. Raw
 *            frames are saved to frames/ with a manifest.
 *   encode : re-encode demo.gif from the saved frames/ (re-tune pacing only —
 *            no browser, no model run).
 *
 * Nothing here is mocked: every frame comes from the app actually running against
 * the configured model provider. See README.md in this folder to regenerate.
 *
 * Usage (from docs/media/, with the app running on :3000):
 *   npm install
 *   npm run stills
 *   npm run demo
 */
import { chromium, type Browser, type Page } from "playwright-core";
import { PNG } from "pngjs";
import gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc as unknown as {
  GIFEncoder: () => {
    writeFrame: (index: Uint8Array, w: number, h: number, opts: object) => void;
    finish: () => void;
    bytes: () => Uint8Array;
  };
  quantize: (data: Uint8Array, n: number, opts: object) => number[][];
  applyPalette: (data: Uint8Array, palette: number[][], format: string) => Uint8Array;
};
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const FIXTURES = join(REPO, "apps", "web", "fixtures");

// Use "localhost" (not 127.0.0.1): Next dev binds its HMR WebSocket to the
// localhost host, and on 127.0.0.1 the failed HMR handshake stalls the client's
// health hook so the provider chip never leaves "checking model…".
const BASE = process.env.CLARITY_BASE_URL ?? "http://localhost:3000";
const CHROME =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const GREENHOUSE = readFileSync(
  join(FIXTURES, "listings", "greenhouse-style.txt"),
  "utf8",
);

// ----------------------------------------------------------------------------
// small utilities
// ----------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[capture] ${new Date().toISOString()} ${m}`);

async function launch(): Promise<Browser> {
  return chromium.launch({
    executablePath: CHROME,
    headless: true,
    // --no-proxy-server: the app's client-side fetches (/api/health, /api/profile)
    // are same-origin localhost; a system WinINET proxy would otherwise intercept
    // them and hang, leaving the provider chip stuck on "checking model…".
    args: ["--force-color-profile=srgb", "--hide-scrollbars", "--no-proxy-server"],
  });
}

async function shot(page: Page, fullPage = false): Promise<Buffer> {
  return (await page.screenshot({ type: "png", fullPage })) as Buffer;
}

/** hide the Next.js dev-mode indicator badge so it stays out of screenshots */
async function hideDevOverlay(page: Page): Promise<void> {
  await page
    .addStyleTag({
      content:
        "nextjs-portal,[data-nextjs-dev-tools-button],[data-next-badge-root],[data-next-badge],#__next-build-watcher{display:none !important;}",
    })
    .catch(() => {});
}

/** poll the provider chip until it resolves away from "checking model…" */
async function waitChip(page: Page, ms = 25000): Promise<string> {
  const chip = page.locator(".provider-chip").first();
  const start = Date.now();
  while (Date.now() - start < ms) {
    const t = (await chip.innerText().catch(() => "")).trim();
    if (t && !/checking/i.test(t)) {
      log(`provider chip: ${t}`);
      return t;
    }
    await sleep(500);
  }
  log("provider chip still 'checking' after wait");
  return "";
}

/** fraction of sampled pixels that differ meaningfully between two RGBA frames */
function diffRatio(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 1;
  const TOL = 16;
  const STRIDE = 4 * 4; // sample every 4th pixel
  let changed = 0;
  let total = 0;
  for (let i = 0; i < a.length; i += STRIDE) {
    total++;
    if (
      Math.abs(a[i] - b[i]) > TOL ||
      Math.abs(a[i + 1] - b[i + 1]) > TOL ||
      Math.abs(a[i + 2] - b[i + 2]) > TOL
    ) {
      changed++;
    }
  }
  return total ? changed / total : 0;
}

// ----------------------------------------------------------------------------
// GIF encoding (pure JS — no ffmpeg): kept PNG frames -> palettized GIF
// ----------------------------------------------------------------------------
type Frame = { png: Buffer; delay: number };

function encodeGif(frames: Frame[], outPath: string): void {
  if (frames.length === 0) throw new Error("no frames to encode");
  // Build one global palette from a sample of frames so colors stay stable.
  const sampleIdx = Array.from({ length: Math.min(8, frames.length) }, (_, k) =>
    Math.floor((k * (frames.length - 1)) / Math.max(1, Math.min(8, frames.length) - 1)),
  );
  const decoded = frames.map((f) => PNG.sync.read(f.png));
  const { width, height } = decoded[0];
  const sampleBytes: number[] = [];
  for (const i of sampleIdx) {
    const d = decoded[i].data;
    for (let p = 0; p < d.length; p += 4 * 3) {
      sampleBytes.push(d[p], d[p + 1], d[p + 2], 255);
    }
  }
  const palette = quantize(Uint8Array.from(sampleBytes), 128, { format: "rgb565" });

  const gif = GIFEncoder();
  for (let i = 0; i < decoded.length; i++) {
    const data = decoded[i].data;
    const index = applyPalette(data, palette, "rgb565");
    gif.writeFrame(index, width, height, {
      palette,
      delay: frames[i].delay,
      repeat: 0,
    });
  }
  gif.finish();
  writeFileSync(outPath, Buffer.from(gif.bytes()));
  log(`wrote ${outPath} (${frames.length} frames, ${width}x${height})`);
}

// ----------------------------------------------------------------------------
// STILLS — model-free screenshots
// ----------------------------------------------------------------------------
async function captureStills(browser: Browser): Promise<void> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();

  // --- Analyze landing (listing pasted, provider chip resolved) ---
  log("stills: analyze landing");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Analyze", exact: true }).waitFor();
  await hideDevOverlay(page);
  await page.getByLabel("Job listing text").fill(GREENHOUSE);
  await waitChip(page);
  // show the top of the pasted listing (fill() leaves it scrolled to the end)
  await page.locator("textarea").first().evaluate((el) => (el.scrollTop = 0));
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  writeFileSync(join(HERE, "analyze-landing.png"), await shot(page));

  // --- Resume editor (seeded master profile) ---
  log("stills: resume profile editor");
  await page.goto(`${BASE}/resume`, { waitUntil: "networkidle" });
  await hideDevOverlay(page);
  try {
    await page.getByRole("heading", { name: "Master profile" }).waitFor({ timeout: 30000 });
    // wait for a seeded entry's employer to render (confirms the profile loaded)
    await page.getByText("Acme Analytics", { exact: false }).first().waitFor({ timeout: 15000 });
  } catch {
    log("resume profile did not fully render in time (capturing whatever is present)");
  }
  await waitChip(page);
  await sleep(600);
  // full-page (whole structured profile) + a viewport crop that reads well inline
  writeFileSync(join(HERE, "resume-profile-full.png"), await shot(page, true));
  await page.setViewportSize({ width: 1280, height: 1180 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  writeFileSync(join(HERE, "resume-profile.png"), await shot(page));

  await ctx.close();
}

// ----------------------------------------------------------------------------
// DEMO — one live analyze run -> demo.gif + finished still
//
// Story: (A) capture a few "agent working" frames while the run streams, then
// (B) wait for the run to finish, then (C) smooth-scroll through the finished
// deliverable. The scroll-through is deterministic motion that shows the whole
// result regardless of how slow the local model was.
// ----------------------------------------------------------------------------
async function captureDemo(browser: Browser): Promise<void> {
  const TICK_MS = 1200;
  const SETUP_CAP_MS = 180_000; // capture "agent working" frames up to 3 min
  const DONE_CAP_MS = 780_000; // wait up to 13 min for the run to finish
  const DEDUP = 0.003; // keep a setup frame if >0.3% of sampled pixels changed

  const framesDir = join(HERE, "frames");
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const ctx = await browser.newContext({
    viewport: { width: 1120, height: 704 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const page = await ctx.newPage();

  log("demo: loading analyze page");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Analyze", exact: true }).waitFor();
  await hideDevOverlay(page);
  await page.getByLabel("Job listing text").fill(GREENHOUSE);
  await waitChip(page);
  await page.locator("textarea").first().evaluate((el) => (el.scrollTop = 0));
  await sleep(500);

  const frames: Frame[] = [];
  let lastKept: Buffer | null = null;
  const keep = (png: Buffer, delay: number) => {
    frames.push({ png, delay });
    lastKept = PNG.sync.read(png).data;
  };

  // opening frame: the filled form
  keep(await shot(page), 1400);

  log("demo: clicking Analyze listing");
  await page.getByRole("button", { name: /Analyze listing/i }).click();
  const started = Date.now();

  const has = async (sel: string) => (await page.locator(sel).count().catch(() => 0)) > 0;
  const isDone = async () =>
    (await page.getByRole("button", { name: /Analyze another listing/i }).count()) > 0;

  // Phase A — the agent working: steps -> coverage -> extracted profile card.
  log("demo: capturing setup frames");
  while (Date.now() - started < SETUP_CAP_MS) {
    await sleep(TICK_MS);
    let png: Buffer;
    try {
      png = await shot(page);
    } catch {
      continue;
    }
    if (!lastKept || diffRatio(lastKept, PNG.sync.read(png).data) >= DEDUP) keep(png, 650);
    // run setup capture through extraction + enrichment, ending once the
    // briefing begins (profile card + coverage chips are up by then)
    const briefingUp =
      (await page.locator("section.briefing h3").count().catch(() => 0)) >= 1;
    if (briefingUp && (await has(".profile-card"))) {
      log("demo: briefing started — ending setup capture");
      break;
    }
    if (await isDone().catch(() => false)) break;
  }

  // Phase B — let the run finish so the reveal shows the whole deliverable.
  log("demo: waiting for run to complete…");
  while (Date.now() - started < DONE_CAP_MS) {
    if (await isDone().catch(() => false)) {
      log("demo: run complete");
      break;
    }
    await sleep(4000);
  }
  await sleep(1500);

  // finished-run still (full page)
  writeFileSync(join(HERE, "analyze-completed.png"), await shot(page, true));
  log("demo: wrote analyze-completed.png");

  // Phase C — smooth scroll-through of the finished result.
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);
  keep(await shot(page), 1200); // hold at top
  const maxScroll = await page.evaluate(
    () => Math.max(0, document.body.scrollHeight - window.innerHeight),
  );
  const STEP = Math.max(150, Math.ceil(maxScroll / 42)); // <=~42 scroll frames
  for (let y = STEP; y <= maxScroll; y += STEP) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await sleep(110);
    keep(await shot(page), 170);
  }
  await page.evaluate((yy) => window.scrollTo(0, yy), maxScroll);
  await sleep(200);
  keep(await shot(page), 2600); // hold at bottom

  // save frames + manifest (so pacing can be re-tuned via `encode` without a
  // fresh model run) and encode the GIF
  const manifest: { frames: { file: string; delay: number }[] } = { frames: [] };
  frames.forEach((f, i) => {
    const file = `frame-${String(i).padStart(3, "0")}.png`;
    writeFileSync(join(framesDir, file), f.png);
    manifest.frames.push({ file, delay: f.delay });
  });
  writeFileSync(join(framesDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`demo: encoding GIF from ${frames.length} frames`);
  encodeGif(frames, join(HERE, "demo.gif"));

  await ctx.close();
}

/** re-encode demo.gif from the saved frames/ dir (tweak pacing, no model run) */
function encodeFromDir(): void {
  const framesDir = join(HERE, "frames");
  const manifest = JSON.parse(readFileSync(join(framesDir, "manifest.json"), "utf8")) as {
    frames: { file: string; delay: number }[];
  };
  const frames: Frame[] = manifest.frames.map((m) => ({
    png: readFileSync(join(framesDir, m.file)),
    delay: m.delay,
  }));
  log(`encode: ${frames.length} frames from ${framesDir}`);
  encodeGif(frames, join(HERE, "demo.gif"));
}

// ----------------------------------------------------------------------------
async function main() {
  const mode = process.argv[2] ?? "stills";
  log(`mode=${mode} base=${BASE}`);
  if (mode === "encode") {
    encodeFromDir();
    log("done");
    return;
  }
  if (!existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
  }
  const browser = await launch();
  try {
    if (mode === "stills") await captureStills(browser);
    else if (mode === "demo") await captureDemo(browser);
    else throw new Error(`unknown mode: ${mode} (use "stills", "demo", or "encode")`);
  } finally {
    await browser.close();
  }
  log("done");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
