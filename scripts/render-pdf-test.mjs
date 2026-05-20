// One-off smoke test: open the dev server in headless Chrome, type a fake
// document, click PDF, intercept the download, and save it for visual
// inspection. Exits non-zero on console errors.

import puppeteer from "puppeteer-core";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.join(__dirname, "_pdf-out");
fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL    = process.env.URL || "http://localhost:3456/";

const SAMPLE = `Robin was already on the bridge when the lamps were lit. She watched the lighter boats come in, one by one, their oars dipping the river. The town was quiet now, after the bells. A man with a leather satchel passed her without looking up, and the smell of woodsmoke went with him into the dark.

She thought of the letter, folded twice in her pocket. She had not opened it again since she left her mother's house, three days walking through wet country. Whatever it said, it could not say more than the man's hand had said when he wrote it.

This is a poem that should keep its line breaks:
Roses are red,
Violets are blue,
Sugar is sweet,
And so are you.

Below, the river ran the colour of slate. She rested her elbows on the parapet and watched a single leaf travel under the bridge, turning slowly, until it disappeared into the shadow on the other side.

The bell at the cathedral struck the half hour. She straightened up and pulled her shawl tighter against the river wind. There was an inn at the end of the lane — the Bell and Anchor — where she might find a room for the night, and if she was lucky, a fire and someone disposed to silence.`;

// Title is intentionally long so we can verify wrapping.
const TITLE = "The Bridge at Dusk, and a Letter Carried Across Three Days of Rain";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });

const errors = [];
page.on("pageerror", (e) => { errors.push(`pageerror: ${e.message}`); console.error("[pageerror]", e.message); });
page.on("console", (m) => { console.log(`[${m.type()}]`, m.text()); if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });

// Catch the PDF download via response interception.
let pdfBytes = null;
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT_DIR });

await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
// Skip landing.
await page.evaluate(() => localStorage.setItem("inkk_visited", "1"));
await page.reload({ waitUntil: "networkidle2" });

// Type the sample content into the editor's contenteditable.
await page.waitForSelector("#text", { timeout: 10000 });
await page.click("#text");

// Type line-by-line, hitting Enter between each line so single \n is
// preserved as a line break and \n\n as a paragraph break.
const sampleLines = SAMPLE.split("\n");
for (let i = 0; i < sampleLines.length; i++) {
  const line = sampleLines[i];
  if (line) {
    await page.evaluate((t) => document.execCommand("insertText", false, t), line);
  }
  if (i < sampleLines.length - 1) {
    await page.keyboard.press("Enter");
  }
}

// Inject a small test image so we exercise the image-blend path.
await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 480; c.height = 320;
  const ctx = c.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 480, 320);
  grad.addColorStop(0, "#3c5a78");
  grad.addColorStop(1, "#7a3a26");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 480, 320);
  ctx.fillStyle = "#fff";
  ctx.font = "italic 28px Georgia";
  ctx.textAlign = "center";
  ctx.fillText("a photograph", 240, 170);
  const url = c.toDataURL("image/jpeg", 0.9);
  const editor = document.getElementById("text");
  // Insert at the very end.
  const img = document.createElement("img");
  img.src = url;
  editor.appendChild(img);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
});

// Set a title via the title field.
await page.evaluate(() => {
  const btn = document.getElementById("add-title-btn");
  if (btn) btn.click();
});
await page.waitForSelector("#title-input", { timeout: 5000 });
await page.type("#title-input", "The Bridge at Dusk, and a Letter Carried Across Three Days of Rain Through Country I Had Never Walked Before");
await page.keyboard.press("Enter");

// Give the editor a moment to settle.
await new Promise(r => setTimeout(r, 1200));

// Diagnose: is the PDF button there?
const btnState = await page.evaluate(() => {
  const btn = document.getElementById("pdf-btn");
  return {
    present: !!btn,
    visible: btn ? getComputedStyle(btn).opacity !== "0" : false,
    text: document.getElementById("text")?.innerText?.slice(0, 80),
    wordCount: document.getElementById("text")?.innerText?.split(/\s+/).filter(Boolean).length,
  };
});
console.log("Button state:", JSON.stringify(btnState));

// Trigger the PDF export.
if (btnState.present) await page.click("#pdf-btn");
else { console.error("pdf-btn not found"); }

// Wait for the download to appear in OUT_DIR.
const downloadName = await new Promise((resolve, reject) => {
  const start = Date.now();
  const interval = setInterval(() => {
    const files = fs.readdirSync(OUT_DIR).filter(f => f.toLowerCase().endsWith(".pdf"));
    if (files.length) {
      // Wait until file size is stable (not actively being written).
      const f = files[0];
      const size = fs.statSync(path.join(OUT_DIR, f)).size;
      setTimeout(() => {
        const newSize = fs.statSync(path.join(OUT_DIR, f)).size;
        if (newSize === size && size > 0) { clearInterval(interval); resolve(f); }
      }, 300);
    }
    if (Date.now() - start > 30000) { clearInterval(interval); reject(new Error("PDF not produced in 30s")); }
  }, 250);
});

await browser.close();

const pdfPath = path.join(OUT_DIR, downloadName);
const stat = fs.statSync(pdfPath);
console.log(`PDF saved: ${pdfPath} (${(stat.size / 1024).toFixed(1)} KB)`);

if (errors.length) {
  console.error("Errors during render:");
  for (const e of errors) console.error("  " + e);
  process.exit(2);
}
process.exit(0);
