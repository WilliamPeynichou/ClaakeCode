// Usage: node render.mjs <portrait|landscape> <subframes> [startSec endSec]
// Captures sub-frames at t = (frame + (sub + 0.5) / N) / fps, then averages them (motion blur) with ffmpeg.
import { chromium } from '../../node_modules/playwright/index.mjs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [format = 'portrait', nArg = '4', a, b] = process.argv.slice(2);
const N = Number(nArg), FPS = 30, DUR = 24;
const [W, H] = format === 'landscape' ? [1920, 1080] : [1080, 1350];
const start = a ? Number(a) : 0, end = b ? Number(b) : DUR;
const dir = path.resolve('.');
const sub = `out/sub_${format}`;
await rm(sub, { recursive: true, force: true });
await mkdir(sub, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => { console.error(e); process.exitCode = 1; });
  await page.goto(`http://127.0.0.1:${port}/film.html?format=${format}`);
  await page.waitForFunction(() => window.ready);
  const frames = [];
  const f0 = Math.round(start * FPS), f1 = Math.round(end * FPS);
  for (let f = f0; f < f1; f++) {
    for (let s = 0; s < N; s++) {
      const t = (f + (s + 0.5) / N) / FPS;
      await page.evaluate((t) => window.seek(t), t);
      const name = `${String((f - f0) * N + s).padStart(6, '0')}.jpg`;
      await page.screenshot({ path: `${sub}/${name}`, type: 'jpeg', quality: 95 });
      frames.push(t);
    }
    if (f % 30 === 0) console.log(`frame ${f}/${f1}`);
  }
  await writeFile(`out/manifest_${format}.json`, JSON.stringify({ format, W, H, FPS, subframes: N, start, end, times: frames }, null, 1));
} finally { await browser.close(); server.close(); }

const out = `out/video_${format}.mp4`;
const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS * N), '-i', `${sub}/%06d.jpg`,
  '-vf', `tmix=frames=${N},select='eq(mod(n\\,${N})\\,${N - 1})',setpts=N/${FPS}/TB`,
  '-r', String(FPS), '-an', '-c:v', 'libx264', '-crf', '15', '-pix_fmt', 'yuv420p', out], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log('wrote', out);
