// node docs/claaky2d/shoot.mjs  → docs/claaky2d/claaky2d-preview.png
import { chromium } from "../../node_modules/playwright/index.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp" };
const server = createServer(async (req, res) => {
  try {
    const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
    res.writeHead(200, { "content-type": types[path.extname(p)] ?? "application/octet-stream" });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${port}/docs/claaky2d/preview.html?t=${process.argv[2] ?? 450}`);
await page.waitForFunction(() => window.ready);
await page.waitForTimeout(400);
await page.locator("#sheet").screenshot({ path: path.join(root, "docs/claaky2d/claaky2d-preview.png") });
await browser.close(); server.close();
console.log("ok");
