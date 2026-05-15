#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '..', 'OpenDownloader', '.browser-data', 'profile');

const ITAG_HEIGHT = {
  272: 2160, 313: 2160, 271: 1440, 308: 1440,
  137: 1080, 299: 1080, 248: 1080, 303: 1080,
  136: 720,  298: 720,  247: 720,  302: 720,  22: 720,
  135: 480,  244: 480,  134: 360,  243: 360,  18: 360,
  133: 240,  242: 240,  160: 144,  278: 144,
};
const AUDIO_PRIO = { 141: 1, 251: 2, 140: 3, 250: 4, 139: 5, 249: 6, 171: 7 };
const CHUNK = 4 * 1024 * 1024;

function extractFileId(url) {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : url.trim();
}

function parseStreams(text) {
  const params = new URLSearchParams(text);
  const title = params.get('title') ?? 'video';
  const streams = [];
  for (const key of ['url_encoded_fmt_stream_map', 'adaptive_fmts']) {
    const raw = params.get(key) ?? '';
    if (!raw) continue;
    for (const entry of raw.split(',')) {
      const sp = new URLSearchParams(entry);
      const rawUrl = sp.get('url');
      if (!rawUrl) continue;
      const url = decodeURIComponent(rawUrl);
      const itag = parseInt(sp.get('itag') ?? '0');
      const mime = decodeURIComponent(sp.get('type') ?? sp.get('mime') ?? '');
      const isAudio = mime.includes('audio');
      const isMuxed = key === 'url_encoded_fmt_stream_map';
      streams.push({ url, itag, mime, type: isMuxed ? 'muxed' : (isAudio ? 'audio' : 'video') });
    }
  }
  return { title, streams };
}

function pickBest(streams) {
  const video = streams
    .filter(s => s.type === 'video' || s.type === 'muxed')
    .sort((a, b) => (ITAG_HEIGHT[b.itag] ?? 0) - (ITAG_HEIGHT[a.itag] ?? 0))[0];
  const audio = streams
    .filter(s => s.type === 'audio')
    .sort((a, b) => (AUDIO_PRIO[a.itag] ?? 99) - (AUDIO_PRIO[b.itag] ?? 99))[0];
  return { video, audio };
}

function waitForEnter(msg) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); resolve(); });
  });
}

async function downloadViaPageFetch(page, streamUrl, outPath, label) {
  const totalSize = await page.evaluate(async (url) => {
    try {
      const r = await fetch(url, { method: 'HEAD', credentials: 'include' });
      return parseInt(r.headers.get('content-length') ?? '0', 10);
    } catch { return 0; }
  }, streamUrl).catch(() => 0);

  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  let offset = 0, downloaded = 0;

  while (true) {
    const end = totalSize > 0 ? Math.min(offset + CHUNK - 1, totalSize - 1) : offset + CHUNK - 1;

    const b64 = await page.evaluate(async ({ url, start, end }) => {
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, credentials: 'include' });
        if (!r.ok && r.status !== 206) return `ERR:${r.status}`;
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      } catch (e) { return `ERR:${e.message}`; }
    }, { url: streamUrl, start: offset, end });

    if (!b64 || b64.startsWith('ERR:')) {
      if (b64) console.error(`\n  Fetch error: ${b64}`);
      break;
    }

    const chunk = Buffer.from(b64, 'base64');
    if (chunk.length === 0) break;

    fs.appendFileSync(outPath, chunk);
    downloaded += chunk.length;
    offset += chunk.length;

    if (totalSize > 0) {
      const pct = Math.round(downloaded / totalSize * 100);
      process.stdout.write(`\r  ${label}: ${pct}%  (${(downloaded / 1024 / 1024).toFixed(1)} / ${(totalSize / 1024 / 1024).toFixed(1)} MB)   `);
    } else {
      process.stdout.write(`\r  ${label}: ${(downloaded / 1024 / 1024).toFixed(1)} MB   `);
    }

    if (totalSize > 0 && downloaded >= totalSize) break;
    if (totalSize === 0 && chunk.length < CHUNK) break;
  }

  console.log();
  return fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
}

function mergeWithFfmpeg(vPath, aPath, outPath) {
  return new Promise((resolve, reject) => {
    const hasAudio = fs.existsSync(aPath) && fs.statSync(aPath).size > 0;
    const args = hasAudio
      ? ['-hide_banner', '-loglevel', 'error', '-i', vPath, '-i', aPath,
         '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', outPath, '-y']
      : ['-hide_banner', '-loglevel', 'error', '-i', vPath, '-c', 'copy', outPath, '-y'];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', e => reject(e));
    proc.on('close', code => code === 0
      ? resolve()
      : reject(new Error(stderr.split('\n').filter(Boolean).pop() ?? 'ffmpeg failed')));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
const input = process.argv[2];
if (!input) { console.error('\nUsage: node dl.mjs <google-drive-url>\n'); process.exit(1); }

const fileId = extractFileId(input);
const driveUrl = `https://drive.google.com/file/d/${fileId}/view`;
const outDir = process.cwd();

console.log('\n  Google Drive View-Only Downloader');
console.log(`  File ID: ${fileId}\n`);

if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: 'chrome',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  viewport: { width: 1280, height: 720 },
});

const page = context.pages()[0] || await context.newPage();
console.log('  Opening Chrome…');
await page.goto(driveUrl, { waitUntil: 'load', timeout: 60_000 });
await page.waitForTimeout(2000);

if (page.url().includes('accounts.google.com') || page.url().includes('ServiceLogin')) {
  console.log('\n  Sign in to Google in the Chrome window.\n');
  await page.waitForURL(
    u => !u.href.includes('accounts.google.com') && !u.href.includes('ServiceLogin'),
    { timeout: 300_000 }
  );
  await page.goto(driveUrl, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(2000);
}

await waitForEnter('\n  Press Enter once you can see the file in Chrome… ');

console.log('\n  Fetching stream info…');
const apiUrl = `https://drive.google.com/u/0/get_video_info?docid=${fileId}&drive_originator_app=303`;
const { ok, text: infoText } = await page.evaluate(async (url) => {
  try {
    const r = await fetch(url, { credentials: 'include' });
    return { ok: r.ok, text: await r.text() };
  } catch (e) { return { ok: false, text: e.message }; }
}, apiUrl);

if (!ok || !infoText.includes('videoplayback')) {
  console.error('  Failed to get stream info:', infoText.slice(0, 400));
  await context.close();
  process.exit(1);
}

const { title, streams } = parseStreams(infoText);
const { video: vStream, audio: aStream } = pickBest(streams);

if (!vStream) {
  console.error('  No video stream found.');
  await context.close();
  process.exit(1);
}

const height = ITAG_HEIGHT[vStream.itag] ?? '?';
const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
const ts = Date.now();
const vPath = path.join(outDir, `_tmp_v_${ts}`);
const aPath = path.join(outDir, `_tmp_a_${ts}`);
const outPath = path.join(outDir, `${safeTitle}.mp4`);

console.log(`  Title:   ${title}`);
console.log(`  Quality: ${height}p  (itag ${vStream.itag})`);
if (aStream && vStream.type !== 'muxed') console.log(`  Audio:   itag ${aStream.itag}`);
console.log(`  Output:  ${outPath}\n`);

// Test fetch from drive.google.com context (this is the working approach)
const test = await page.evaluate(async (url) => {
  try {
    const r = await fetch(url, { method: 'HEAD', credentials: 'include' });
    return { ok: true, status: r.status, cl: r.headers.get('content-length') };
  } catch (e) { return { ok: false, err: e.message }; }
}, vStream.url).catch(e => ({ ok: false, err: e.message }));

console.log(`  Fetch test (drive.google.com → video): ${JSON.stringify(test)}\n`);

// If drive page can't fetch, open a new tab navigated to the video URL (same-origin fetch)
async function getDownloadPage(context, streamUrl, drivePageOk, drivePage) {
  if (drivePageOk) return { page: drivePage, ownPage: false };
  console.log('  Drive page fetch blocked — navigating Chrome to video URL…');
  const p = await context.newPage();
  await p.goto(streamUrl, { waitUntil: 'commit', timeout: 60_000 }).catch(() => {});
  await p.waitForTimeout(1000);
  return { page: p, ownPage: true };
}

const cleanup = () => {
  [vPath, aPath].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} });
};

try {
  const { page: vPage, ownPage: vOwn } = await getDownloadPage(context, vStream.url, test.ok, page);

  console.log(`  Capturing video (${height}p)…`);
  const vSize = await downloadViaPageFetch(vPage, vStream.url, vPath, `Video ${height}p`);
  if (vOwn) await vPage.close();

  if (vSize === 0) throw new Error('No video data captured.');
  console.log(`  Video: ${(vSize / 1024 / 1024).toFixed(1)} MB`);

  let aSize = 0;
  if (aStream && vStream.type !== 'muxed') {
    const { page: aPage, ownPage: aOwn } = await getDownloadPage(context, aStream.url, test.ok, page);
    console.log('  Capturing audio…');
    aSize = await downloadViaPageFetch(aPage, aStream.url, aPath, 'Audio');
    if (aOwn) await aPage.close();
    console.log(`  Audio: ${(aSize / 1024 / 1024).toFixed(1)} MB`);
  }

  await context.close();

  console.log('\n  Merging with ffmpeg…');
  await mergeWithFfmpeg(vPath, aPath, outPath);

  cleanup();
  const finalMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n  Done! ${finalMB} MB saved to:\n  ${outPath}\n`);
} catch (err) {
  cleanup();
  try { await context.close(); } catch {}
  console.error('\n  Error:', err.message);
  process.exit(1);
}
