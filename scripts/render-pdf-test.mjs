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

Below, the river ran the colour of slate. She rested her elbows on the parapet and watched a single leaf travel under the bridge, turning slowly, until it disappeared into the shadow on the other side.

The bell at the cathedral struck the half hour. She straightened up and pulled her shawl tighter against the river wind. There was an inn at the end of the lane — the Bell and Anchor — where she might find a room for the night, and if she was lucky, a fire and someone disposed to silence.

She walked. The cobbles were uneven beneath her boots; she had grown used to it, the way you grow used to a body after a long illness. Her steps were quiet against the stones, and the lamps cast small yellow circles on the wet ground.

Three doors before the inn, a cat watched her from a low wall. It did not move as she passed. The cat's eyes followed her, and she felt, for a moment, the absurd certainty that something was about to begin.

Inside the Bell and Anchor the air was thick and warm, smelling of beer and woodsmoke and wet wool. A handful of men sat at the long table near the fire; none looked up. The landlord, a heavy man with a moustache stained from his pipe, met her at the bar.

"A room," she said. "One night. And something hot to drink."

He named a price. She paid him. He gave her a key with a tag of leather worn smooth from a hundred hands before hers, and pointed up the stairs without speaking. She climbed.

The room was small and clean. There was a bed, a chair, a wash-basin on a stand by the window. She set her bag down and sat on the edge of the bed, and for a long time she did not move.

Then she took the letter from her pocket, smoothed it flat on her knee, and read it through, slowly, beginning to end.`;

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
await page.evaluate((text) => {
  const el = document.getElementById("text");
  el.focus();
  // Use execCommand insertText so input events fire naturally.
  document.execCommand("insertText", false, text);
}, SAMPLE);

// Set a title via the title field.
await page.evaluate(() => {
  const btn = document.getElementById("add-title-btn");
  if (btn) btn.click();
});
await page.waitForSelector("#title-input", { timeout: 5000 });
await page.type("#title-input", "The Bridge at Dusk");
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
