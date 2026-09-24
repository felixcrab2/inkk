// crypto.randomUUID only exists in a secure context, so it is missing whenever
// the app is served over plain http — a LAN address during device testing, for
// instance. Falling back keeps documents creatable there instead of taking the
// whole editor down with a TypeError.
export function uid() {
  try {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch { /* fall through */ }
  const r = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${r(8)}-${r(4)}-4${r(3)}-${((Math.random() * 4) | 8).toString(16)}${r(3)}-${r(12)}`;
}

export function createDoc() {
  const now = Date.now();
  return {
    id: uid(), title: "", content: "",
    updatedAt: now, createdAt: now,
    writingTimeSecs: 0, revisionCount: 0,
    keystrokes: 0, deletions: 0, pastes: 0,
    humanScore: null, scoreTier: null, scoreFeatures: null,
    verifyCode: null, contentHash: null,
  };
}

export const DOC_DEFAULTS = {
  title: "", writingTimeSecs: 0, revisionCount: 0,
  keystrokes: 0, deletions: 0, pastes: 0,
  humanScore: null, scoreTier: null, scoreFeatures: null,
  verifyCode: null, contentHash: null,
};

export function normaliseDoc(d) {
  return {
    ...DOC_DEFAULTS, ...d,
    createdAt: d.createdAt || d.updatedAt || Date.now(),
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem("inkk_v1");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveState(docs, activeId) {
  try { localStorage.setItem("inkk_v1", JSON.stringify({ docs, activeId })); } catch {}
}

// Which signed-in user the on-device docs belong to (null = anonymous). Used to
// stop one account's drafts from being merged into another on a shared device.
export function loadOwner() {
  try { return localStorage.getItem("inkk_owner") || null; } catch { return null; }
}

export function saveOwner(id) {
  try {
    if (id) localStorage.setItem("inkk_owner", id);
    else localStorage.removeItem("inkk_owner");
  } catch {}
}

export function initState() {
  const saved = loadState();
  if (!saved?.docs?.length) {
    const doc = createDoc();
    return { docs: [doc], activeId: doc.id };
  }
  const docs = saved.docs.map(normaliseDoc);
  const validId = docs.find(d => d.id === saved.activeId) ? saved.activeId : docs[0].id;
  return { docs, activeId: validId };
}

export function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<\/div>/gi, "\n").replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<img[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// Defence-in-depth: strip script-bearing markup before HTML is placed into a
// live editable node. Parses in an inert <template> (no execution), removes
// <script>/<iframe>/etc, on* handlers and javascript: URLs, and keeps all
// formatting and data:image content intact.
export function sanitizeContentHtml(html) {
  if (!html) return "";
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll("script,style,iframe,object,embed,link,meta,base,form,svg").forEach(n => n.remove());
  tpl.content.querySelectorAll("*").forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if ((name === "href" || name === "src" || name === "xlink:href") && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  });
  return tpl.innerHTML;
}

export function setEditorHtml(el, content) {
  if (!content) { el.innerHTML = ""; return; }
  if (/<(div|br|img|p)\b/i.test(content)) { el.innerHTML = sanitizeContentHtml(content); }
  else { el.innerText = content; }
}

export function setTitleHtml(el, content) {
  if (!content) { el.innerHTML = ""; return; }
  if (/<\w+/.test(content) || /&\w+;/.test(content)) { el.innerHTML = sanitizeContentHtml(content); }
  else { el.innerText = content; }
}

export function docTitle(content) {
  const first = stripHtml(content || "").trim().split("\n")[0].trim();
  return first.length > 0 ? first : "Untitled";
}

export function wordCount(content) {
  const t = stripHtml(content || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

export function loadStreak() {
  try {
    const raw = localStorage.getItem("inkk_streak");
    return raw ? JSON.parse(raw) : { count: 0, lastDate: null };
  } catch { return { count: 0, lastDate: null }; }
}

export function touchStreak() {
  const today = new Date().toDateString();
  const s = loadStreak();
  if (s.lastDate === today) return s.count;
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  const count = s.lastDate === yesterday ? s.count + 1 : 1;
  try { localStorage.setItem("inkk_streak", JSON.stringify({ count, lastDate: today })); } catch {}
  return count;
}

// ─── cloud sync ───────────────────────────────────────────────────────────────
