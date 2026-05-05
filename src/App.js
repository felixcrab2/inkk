import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import "@fontsource/eb-garamond/400.css";
import { jsPDF } from "jspdf";
import garamondTTF from "./assets/EBGaramond-Regular.ttf";

// ─── utils ────────────────────────────────────────────────────────────────────

function createDoc() {
  return { id: crypto.randomUUID(), content: "", updatedAt: Date.now() };
}

function loadState() {
  try {
    const raw = localStorage.getItem("inkk_v1");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveState(docs, activeId) {
  try { localStorage.setItem("inkk_v1", JSON.stringify({ docs, activeId })); } catch {}
}

function initState() {
  const saved = loadState();
  if (!saved?.docs?.length) {
    const doc = createDoc();
    return { docs: [doc], activeId: doc.id };
  }
  const activeId = saved.docs.find(d => d.id === saved.activeId)
    ? saved.activeId
    : saved.docs[0].id;
  return { docs: saved.docs, activeId };
}

function docTitle(content) {
  const first = (content || "").trim().split("\n")[0].trim();
  return first.length > 0 ? first : "Untitled";
}

function wordCount(content) {
  const t = (content || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

function isMobile() {
  return (
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
  );
}

async function fetchBase64(url) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const { docs: initDocs, activeId: initActiveId } = initState();

  const [docs, setDocs] = useState(initDocs);
  const [activeId, setActiveId] = useState(initActiveId);
  const [menuVisible, setMenuVisible] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState("saved");
  const [words, setWords] = useState(() =>
    wordCount(initDocs.find(d => d.id === initActiveId)?.content)
  );

  const editorRef   = useRef(null);
  const containerRef = useRef(null);
  const contentRef  = useRef("");       // live editor content
  const isMobileRef = useRef(false);
  const mountedRef  = useRef(false);
  const idleTimerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const rafRef       = useRef(null);

  const IDLE_MS = 1200;

  // ─ load a doc into the DOM ─────────────────────────────────────────────────

  const loadDocIntoEditor = useCallback((doc) => {
    const el = editorRef.current;
    if (!el) return;
    contentRef.current = doc.content;
    el.innerText = doc.content;
    setWords(wordCount(doc.content));
    // move cursor to end
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    el.focus();
  }, []);

  // ─ switch document ─────────────────────────────────────────────────────────

  const switchDoc = useCallback((id) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setDocs(prev => {
      const flushed = prev.map(d =>
        d.id === activeId ? { ...d, content: contentRef.current, updatedAt: Date.now() } : d
      );
      saveState(flushed, id);
      return flushed;
    });
    setSaveStatus("saved");
    setActiveId(id);
    setPanelOpen(false);
  }, [activeId]);

  // load new doc whenever activeId changes (skip on initial mount)
  useEffect(() => {
    if (!mountedRef.current) return;
    const doc = docs.find(d => d.id === activeId);
    if (doc) loadDocIntoEditor(doc);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ─ new / delete document ───────────────────────────────────────────────────

  const newDoc = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const doc = createDoc();
    setDocs(prev => {
      const flushed = prev.map(d =>
        d.id === activeId ? { ...d, content: contentRef.current, updatedAt: Date.now() } : d
      );
      const next = [...flushed, doc];
      saveState(next, doc.id);
      return next;
    });
    setActiveId(doc.id);
    setPanelOpen(false);
  }, [activeId]);

  const deleteDoc = useCallback((id, e) => {
    e.stopPropagation();
    setDocs(prev => {
      if (prev.length === 1) {
        const fresh = createDoc();
        saveState([fresh], fresh.id);
        setActiveId(fresh.id);
        return [fresh];
      }
      const next = prev.filter(d => d.id !== id);
      const newActive = id === activeId ? next[0].id : activeId;
      if (id === activeId) setActiveId(newActive);
      saveState(next, newActive);
      return next;
    });
  }, [activeId]);

  // ─ typing ──────────────────────────────────────────────────────────────────

  const scheduleMenuReturn = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setMenuVisible(true), IDLE_MS);
  }, []);

  // keep cursor visible without jumping to bottom when editing mid-document
  const scrollToCursor = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (!sel?.rangeCount) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const container = containerRef.current;
      if (!container) return;
      const { bottom: cb } = container.getBoundingClientRect();
      if (rect.bottom > cb - 80) container.scrollTop += rect.bottom - cb + 100;
    });
  }, []);

  const onInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.innerText;
    contentRef.current = text;
    setWords(wordCount(text));
    setMenuVisible(false);
    scheduleMenuReturn();
    scrollToCursor();

    // debounced autosave
    setSaveStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const capturedId = activeId;
    const capturedContent = text;
    saveTimerRef.current = setTimeout(() => {
      setDocs(prev => {
        const next = prev.map(d =>
          d.id === capturedId ? { ...d, content: capturedContent, updatedAt: Date.now() } : d
        );
        saveState(next, capturedId);
        return next;
      });
      setSaveStatus("saved");
    }, 500);
  }, [activeId, scheduleMenuReturn, scrollToCursor]);

  // ─ PDF export ──────────────────────────────────────────────────────────────

  const exportToPdf = useCallback(async () => {
    const text = contentRef.current || "";
    if (!text.trim()) return;

    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const b64 = await fetchBase64(garamondTTF);
    doc.addFileToVFS("EBGaramond-Regular.ttf", b64);
    doc.addFont("EBGaramond-Regular.ttf", "EBGaramond", "normal");
    doc.setFont("EBGaramond", "normal");

    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const mx = 72, mt = 96, mb = 72;
    const maxW = pageW - mx * 2;
    const fs = 12, lh = 21, paraGap = 10;

    const paras = text.split(/\n{2,}/);
    // treat first paragraph as a title if it's short and there's body text after
    const isTitleDoc = paras.length > 1 && paras[0].trim().length < 80 && !paras[0].includes("\n");
    let y = mt;

    const ensureSpace = () => {
      if (y > pageH - mb) {
        doc.addPage();
        y = mt;
        doc.setFont("EBGaramond", "normal");
      }
    };

    for (let pi = 0; pi < paras.length; pi++) {
      const para = paras[pi].trim();
      if (!para) continue;

      if (pi === 0 && isTitleDoc) {
        doc.setFontSize(20);
        for (const line of doc.splitTextToSize(para, maxW)) {
          ensureSpace();
          doc.text(line, mx, y);
          y += 30;
        }
        y += 20;
        doc.setFontSize(fs);
        continue;
      }

      doc.setFontSize(fs);
      for (const rawLine of para.split("\n")) {
        for (const line of doc.splitTextToSize(rawLine || " ", maxW)) {
          ensureSpace();
          if (line.trim()) doc.text(line, mx, y);
          y += lh;
        }
      }
      y += paraGap;
    }

    const fname = docTitle(text).replace(/[^a-zA-Z0-9\s\-_]/g, "").trim() || "inkk";
    doc.save(`${fname}.pdf`);
  }, []);

  // ─ keyboard shortcuts ──────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); exportToPdf(); }
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [exportToPdf]);

  // ─ mount ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    isMobileRef.current = isMobile();
    const doc = initDocs.find(d => d.id === initActiveId) || initDocs[0];
    if (doc) {
      contentRef.current = doc.content;
      const el = editorRef.current;
      if (el) {
        el.innerText = doc.content;
        if (!isMobileRef.current) el.focus();
      }
    }
    mountedRef.current = true;
    return () => {
      [idleTimerRef, saveTimerRef].forEach(r => { if (r.current) clearTimeout(r.current); });
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─ render ──────────────────────────────────────────────────────────────────

  const metaText = words > 0
    ? `${words} word${words === 1 ? "" : "s"} · ${saveStatus === "saving" ? "saving…" : "saved"}`
    : "";

  const sortedDocs = [...docs].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <>
      {panelOpen && <div id="panel-backdrop" onClick={() => setPanelOpen(false)} />}

      <div id="doc-panel" className={panelOpen ? "open" : ""}>
        <button className="new-doc-btn" onClick={newDoc}>+ New document</button>
        <div id="doc-list">
          {sortedDocs.map(d => (
            <div
              key={d.id}
              className={`doc-item${d.id === activeId ? " active" : ""}`}
              onClick={() => switchDoc(d.id)}
            >
              <span className="doc-item-title">{docTitle(d.content)}</span>
              <span className="doc-item-meta">{wordCount(d.content)}w</span>
              {docs.length > 1 && (
                <button className="doc-delete" onClick={e => deleteDoc(d.id, e)}>×</button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div id="menu" className={menuVisible ? "visible" : "hidden"}>
        <div id="menu-left">
          <button id="panel-toggle" onClick={() => setPanelOpen(v => !v)} title="Documents">
            <svg width="15" height="11" viewBox="0 0 15 11" fill="none">
              <rect y="0"   width="15" height="1.4" rx="0.7" fill="currentColor" />
              <rect y="4.8" width="15" height="1.4" rx="0.7" fill="currentColor" />
              <rect y="9.6" width="15" height="1.4" rx="0.7" fill="currentColor" />
            </svg>
          </button>
        </div>
        <div id="menu-center">
          <button id="brand" onClick={exportToPdf} title="Export PDF  ⌘S">inkk.</button>
          <div id="menu-meta">{metaText}</div>
        </div>
        <div id="menu-right" />
      </div>

      <div id="text-container" ref={containerRef} onClick={() => editorRef.current?.focus()}>
        <div
          id="text"
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onInput={onInput}
        />
      </div>
    </>
  );
}
