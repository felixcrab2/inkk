import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import "@fontsource/eb-garamond/400.css";
import { jsPDF } from "jspdf";
import garamondTTF from "./assets/EBGaramond-Regular.ttf";
import { supabase } from "./supabase";

// ─── local storage ────────────────────────────────────────────────────────────

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
  const validId = saved.docs.find(d => d.id === saved.activeId)
    ? saved.activeId : saved.docs[0].id;
  return { docs: saved.docs, activeId: validId };
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

// ─── cloud sync ───────────────────────────────────────────────────────────────

async function fetchCloudDocs() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("documents")
    .select("id, content, updated_at");
  if (error || !data) return [];
  return data.map(r => ({
    id: r.id,
    content: r.content,
    updatedAt: new Date(r.updated_at).getTime(),
  }));
}

async function pushDocToCloud(doc, userId) {
  if (!supabase || !userId) return;
  const { error } = await supabase.from("documents").upsert({
    id: doc.id,
    user_id: userId,
    content: doc.content,
    updated_at: new Date(doc.updatedAt).toISOString(),
  });
  if (error) console.error("Cloud save failed:", error.message);
}

async function deleteDocFromCloud(docId) {
  if (!supabase) return;
  await supabase.from("documents").delete().eq("id", docId);
}

function mergeDocs(local, cloud) {
  const map = new Map();
  for (const doc of local) map.set(doc.id, doc);
  for (const doc of cloud) {
    const existing = map.get(doc.id);
    if (!existing || doc.updatedAt > existing.updatedAt) map.set(doc.id, doc);
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ─── publications ─────────────────────────────────────────────────────────────

async function fetchFeed() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("publications")
    .select("id, title, content, published_at, author_name")
    .order("published_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data;
}

async function fetchMyPublications(userId) {
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from("publications")
    .select("id, doc_id, title, content, published_at")
    .eq("user_id", userId)
    .order("published_at", { ascending: false });
  if (error || !data) return [];
  return data;
}

async function doPublish(doc, user, title, authorName) {
  if (!supabase || !user) return false;
  const { error } = await supabase.from("publications").upsert({
    doc_id: doc.id,
    user_id: user.id,
    title,
    content: doc.content,
    author_name: authorName,
    published_at: new Date().toISOString(),
  }, { onConflict: "doc_id" });
  if (error) { console.error("Publish failed:", error.message); return false; }
  return true;
}

async function doUnpublish(docId) {
  if (!supabase) return;
  await supabase.from("publications").delete().eq("doc_id", docId);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function pubPreview(content) {
  const lines = (content || "").trim().split("\n").filter(l => l.trim());
  const body = lines.slice(1).join(" ").trim();
  return body.length > 130 ? body.slice(0, 130).trimEnd() + "…" : body;
}

// ─── AuthModal ────────────────────────────────────────────────────────────────

function AuthModal({ onClose }) {
  const [mode, setMode]         = useState("signin");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [message, setMessage]   = useState("");
  const [loading, setLoading]   = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
      else if (!data.session) setMessage("Check your email to confirm your account.");
    }
    setLoading(false);
  };

  const googleSignIn = async () => {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
  };

  return (
    <div id="auth-overlay" onClick={onClose}>
      <div id="auth-modal" onClick={e => e.stopPropagation()}>
        <button id="auth-close" onClick={onClose}>×</button>
        {message ? (
          <p id="auth-message">{message}</p>
        ) : (
          <>
            <div id="auth-tabs">
              <button className={mode === "signin" ? "active" : ""} onClick={() => { setMode("signin"); setError(""); }}>sign in</button>
              <button className={mode === "signup" ? "active" : ""} onClick={() => { setMode("signup"); setError(""); }}>create account</button>
            </div>
            <form onSubmit={submit}>
              <input type="email" placeholder="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              <input type="password" placeholder="password" value={password} onChange={e => setPassword(e.target.value)} required />
              {error && <p className="auth-error">{error}</p>}
              <button id="auth-submit" type="submit" disabled={loading}>
                {loading ? "…" : mode === "signin" ? "sign in" : "create account"}
              </button>
            </form>
            <div id="auth-divider"><span>or</span></div>
            <button id="google-btn" onClick={googleSignIn}>continue with Google</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── PublishModal ─────────────────────────────────────────────────────────────

function PublishModal({ doc, user, onConfirm, onClose }) {
  const rawTitle  = docTitle(doc.content);
  const rawAuthor = user.user_metadata?.full_name || user.email.split("@")[0];

  const [title, setTitle]   = useState(rawTitle === "Untitled" ? "" : rawTitle);
  const [author, setAuthor] = useState(rawAuthor);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");

  const submit = async (e) => {
    e.preventDefault();
    const t = title.trim();
    const a = author.trim() || rawAuthor;
    if (!t) return;
    setLoading(true);
    setError("");
    const ok = await onConfirm(t, a);
    if (!ok) setError("Publishing failed — check your connection and try again.");
    setLoading(false);
  };

  return (
    <div id="auth-overlay" onClick={onClose}>
      <div id="auth-modal" onClick={e => e.stopPropagation()}>
        <button id="auth-close" onClick={onClose}>×</button>
        <div id="auth-tabs">
          <button className="active" style={{ cursor: "default" }}>publish</button>
        </div>
        <form onSubmit={submit}>
          <input
            type="text"
            placeholder="article title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            required
            autoFocus
          />
          <input
            type="text"
            placeholder="author name"
            value={author}
            onChange={e => setAuthor(e.target.value)}
          />
          {error && <p className="auth-error">{error}</p>}
          <button id="auth-submit" type="submit" disabled={loading || !title.trim()}>
            {loading ? "publishing…" : "publish to feed"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Feed ─────────────────────────────────────────────────────────────────────

function Feed({ onRead }) {
  const [pubs, setPubs]     = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFeed().then(data => { setPubs(data); setLoading(false); });
  }, []);

  return (
    <div id="feed-container">
      <div id="feed-list">
        {loading && <p className="feed-empty">loading…</p>}
        {!loading && pubs.length === 0 && (
          <p className="feed-empty">nothing published yet.</p>
        )}
        {pubs.map(pub => (
          <article key={pub.id} className="pub-card" onClick={() => onRead(pub)}>
            <div className="pub-card-meta">
              <span className="pub-author">{pub.author_name}</span>
              <span className="pub-card-dot">·</span>
              <span className="pub-card-date">{formatDate(pub.published_at)}</span>
            </div>
            <h2 className="pub-card-title">{pub.title}</h2>
            {pubPreview(pub.content) && (
              <p className="pub-card-preview">{pubPreview(pub.content)}</p>
            )}
            <span className="pub-card-words">{wordCount(pub.content)}w</span>
          </article>
        ))}
      </div>
    </div>
  );
}

// ─── Profile ──────────────────────────────────────────────────────────────────

function Profile({ user, onRead, onUnpublish }) {
  const [pubs, setPubs]       = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMyPublications(user.id).then(data => { setPubs(data); setLoading(false); });
  }, [user]);

  const handleUnpublish = async (pub, e) => {
    e.stopPropagation();
    await doUnpublish(pub.doc_id);
    setPubs(prev => prev.filter(p => p.id !== pub.id));
    if (onUnpublish) onUnpublish(pub.doc_id);
  };

  return (
    <div id="feed-container">
      <div id="feed-list">
        {loading && <p className="feed-empty">loading…</p>}
        {!loading && pubs.length === 0 && (
          <p className="feed-empty">you haven't published anything yet.</p>
        )}
        {pubs.map(pub => (
          <article key={pub.id} className="pub-card" onClick={() => onRead(pub)}>
            <div className="pub-card-meta">
              <span className="pub-card-date">{formatDate(pub.published_at)}</span>
              <button className="pub-remove" onClick={e => handleUnpublish(pub, e)}>remove</button>
            </div>
            <h2 className="pub-card-title">{pub.title}</h2>
            {pubPreview(pub.content) && (
              <p className="pub-card-preview">{pubPreview(pub.content)}</p>
            )}
            <span className="pub-card-words">{wordCount(pub.content)}w</span>
          </article>
        ))}
      </div>
    </div>
  );
}

// ─── ReadingView ──────────────────────────────────────────────────────────────

function ReadingView({ pub }) {
  return (
    <div id="reading-container">
      <div id="reading-byline">
        {pub.author_name} · {formatDate(pub.published_at)} · {wordCount(pub.content)}w
      </div>
      <div id="reading-text">{pub.content}</div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const { docs: initDocs, activeId: initActiveId } = initState();

  const [docs, setDocs]               = useState(initDocs);
  const [activeId, setActiveId]       = useState(initActiveId);
  const [menuVisible, setMenuVisible] = useState(true);
  const [panelOpen, setPanelOpen]     = useState(false);
  const [saveStatus, setSaveStatus]   = useState("saved");
  const [words, setWords]             = useState(() =>
    wordCount(initDocs.find(d => d.id === initActiveId)?.content)
  );
  const [user, setUser]               = useState(null);
  const [authOpen, setAuthOpen]       = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [view, setView]               = useState("editor");
  const [readingPub, setReadingPub]   = useState(null);
  const [publishedDocIds, setPublishedDocIds] = useState(new Set());
  const [publishModalDoc, setPublishModalDoc] = useState(null);

  const editorRef    = useRef(null);
  const containerRef = useRef(null);
  const contentRef   = useRef("");
  const isMobileRef  = useRef(false);
  const mountedRef   = useRef(false);
  const idleTimerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const rafRef       = useRef(null);
  const userRef      = useRef(null);

  useEffect(() => { userRef.current = user; }, [user]);

  const IDLE_MS = 1200;

  // ─ load doc into DOM ────────────────────────────────────────────────────────

  const loadDocIntoEditor = useCallback((doc) => {
    const el = editorRef.current;
    if (!el) return;
    contentRef.current = doc.content;
    el.innerText = doc.content;
    setWords(wordCount(doc.content));
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    el.focus();
  }, []);

  // ─ auth + cloud sync ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!supabase) return;

    const syncOnLogin = async (signedInUser) => {
      setUser(signedInUser);
      userRef.current = signedInUser;
      setAuthOpen(false);

      const cloudDocs = await fetchCloudDocs();
      const saved = loadState();
      const localDocs = saved?.docs || [];

      const hasLocalContent = localDocs.some(d => d.content.trim());
      let merged = (hasLocalContent || !cloudDocs.length)
        ? mergeDocs(localDocs, cloudDocs)
        : cloudDocs;
      if (!merged.length) merged = [createDoc()];

      const cloudIds = new Set(cloudDocs.map(d => d.id));
      for (const doc of merged) {
        if (!cloudIds.has(doc.id) && doc.content.trim()) {
          await pushDocToCloud(doc, signedInUser.id);
        }
      }

      const savedActiveId = saved?.activeId;
      const newActiveId = merged.find(d => d.id === savedActiveId)
        ? savedActiveId : merged[0].id;

      setDocs(merged);
      saveState(merged, newActiveId);
      setActiveId(newActiveId);

      const docToLoad = merged.find(d => d.id === newActiveId);
      if (docToLoad) loadDocIntoEditor(docToLoad);

      const myPubs = await fetchMyPublications(signedInUser.id);
      setPublishedDocIds(new Set(myPubs.map(p => p.doc_id).filter(Boolean)));
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) syncOnLogin(session.user);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN"  && session?.user) syncOnLogin(session.user);
      if (event === "SIGNED_OUT") {
        setUser(null);
        setAccountMenuOpen(false);
        setPublishedDocIds(new Set());
      }
    });

    return () => subscription.unsubscribe();
  }, [loadDocIntoEditor]);

  // ─ switch document ──────────────────────────────────────────────────────────

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

  useEffect(() => {
    if (!mountedRef.current) return;
    const doc = docs.find(d => d.id === activeId);
    if (doc) loadDocIntoEditor(doc);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ─ new / delete ─────────────────────────────────────────────────────────────

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
    if (userRef.current) deleteDocFromCloud(id);
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

  // ─ publish ──────────────────────────────────────────────────────────────────

  const openPublishModal = useCallback((doc, e) => {
    if (e) e.stopPropagation();
    if (!userRef.current) return;
    const content = doc.id === activeId ? contentRef.current : doc.content;
    if (!content?.trim()) return;
    if (publishedDocIds.has(doc.id)) {
      // unpublish immediately — no modal needed
      doUnpublish(doc.id).then(() =>
        setPublishedDocIds(prev => { const s = new Set(prev); s.delete(doc.id); return s; })
      );
    } else {
      setPublishModalDoc({ ...doc, content });
    }
  }, [activeId, publishedDocIds]);

  const confirmPublish = useCallback(async (title, authorName) => {
    if (!publishModalDoc) return false;
    const ok = await doPublish(publishModalDoc, userRef.current, title, authorName);
    if (ok) {
      setPublishedDocIds(prev => new Set([...prev, publishModalDoc.id]));
      setPublishModalDoc(null);
    }
    return ok;
  }, [publishModalDoc]);

  // ─ sign out ─────────────────────────────────────────────────────────────────

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setAccountMenuOpen(false);
  }, []);

  // ─ typing ───────────────────────────────────────────────────────────────────

  const scheduleMenuReturn = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setMenuVisible(true), IDLE_MS);
  }, []);

  const scrollToCursor = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (!sel?.rangeCount) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const container = containerRef.current;
      if (!container) return;
      const cb = container.getBoundingClientRect().bottom;
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

    setSaveStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const capturedId      = activeId;
    const capturedContent = text;
    saveTimerRef.current = setTimeout(() => {
      const capturedUpdatedAt = Date.now();
      setDocs(prev => {
        const next = prev.map(d =>
          d.id === capturedId
            ? { ...d, content: capturedContent, updatedAt: capturedUpdatedAt }
            : d
        );
        saveState(next, capturedId);
        return next;
      });
      if (userRef.current) {
        pushDocToCloud(
          { id: capturedId, content: capturedContent, updatedAt: capturedUpdatedAt },
          userRef.current.id
        );
      }
      setSaveStatus("saved");
    }, 500);
  }, [activeId, scheduleMenuReturn, scrollToCursor]);

  // ─ PDF export ───────────────────────────────────────────────────────────────

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
    const isTitleDoc = paras.length > 1 && paras[0].trim().length < 80 && !paras[0].includes("\n");
    let y = mt;

    const newPage = () => { doc.addPage(); y = mt; doc.setFont("EBGaramond", "normal"); };

    for (let pi = 0; pi < paras.length; pi++) {
      const para = paras[pi].trim();
      if (!para) continue;
      if (pi === 0 && isTitleDoc) {
        doc.setFontSize(20);
        for (const line of doc.splitTextToSize(para, maxW)) {
          if (y > pageH - mb) newPage();
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
          if (y > pageH - mb) newPage();
          if (line.trim()) doc.text(line, mx, y);
          y += lh;
        }
      }
      y += paraGap;
    }

    const fname = docTitle(text).replace(/[^a-zA-Z0-9\s\-_]/g, "").trim() || "inkk";
    doc.save(`${fname}.pdf`);
  }, []);

  // ─ keyboard shortcuts ───────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (view === "editor") exportToPdf();
      }
      if (e.key === "Escape") {
        setPanelOpen(false);
        setAccountMenuOpen(false);
        setAuthOpen(false);
        if (view !== "editor") { setView("editor"); setReadingPub(null); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [exportToPdf, view]);

  // ─ mount ────────────────────────────────────────────────────────────────────

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

  // re-focus editor when returning to editor view
  useEffect(() => {
    if (view === "editor" && !isMobileRef.current) editorRef.current?.focus();
  }, [view]);

  // ─ render ───────────────────────────────────────────────────────────────────

  const metaText = words > 0
    ? `${words} word${words === 1 ? "" : "s"} · ${saveStatus === "saving" ? "saving…" : "saved"}`
    : "";

  const sortedDocs = [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
  const menuClass  = menuVisible ? "menu-visible" : "menu-hidden";
  const isEditor   = view === "editor";

  const goToEditor = useCallback(() => { setView("editor"); setReadingPub(null); }, []);
  const openReading = useCallback((pub) => { setReadingPub(pub); setView("reading"); }, []);

  const subLabel =
    view === "feed"    ? "feed" :
    view === "profile" ? "your profile" :
    view === "reading" ? (readingPub?.author_name || "") :
    metaText;

  return (
    <>
      {/* ── doc panel (editor only) ── */}
      {isEditor && panelOpen && <div id="panel-backdrop" onClick={() => setPanelOpen(false)} />}
      {isEditor && (
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
                {user && (
                  <button
                    className={`doc-publish${publishedDocIds.has(d.id) ? " published" : ""}`}
                    title={publishedDocIds.has(d.id) ? "Remove from feed" : "Publish to feed"}
                    onClick={e => openPublishModal(d, e)}
                  >
                    {publishedDocIds.has(d.id) ? "live" : "publish"}
                  </button>
                )}
                {docs.length > 1 && (
                  <button className="doc-delete" onClick={e => deleteDoc(d.id, e)}>×</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── top-left: hamburger (editor) or back arrow ── */}
      {isEditor ? (
        <button id="panel-toggle" className={menuClass} onClick={() => setPanelOpen(v => !v)} title="Documents">
          <svg width="15" height="11" viewBox="0 0 15 11" fill="none">
            <rect y="0"   width="15" height="1.5" rx="0.75" fill="currentColor" />
            <rect y="4.8" width="15" height="1.5" rx="0.75" fill="currentColor" />
            <rect y="9.6" width="15" height="1.5" rx="0.75" fill="currentColor" />
          </svg>
        </button>
      ) : (
        <button id="back-btn" onClick={goToEditor}>←</button>
      )}

      {/* ── top-right: feed link + account ── */}
      {supabase && (
        <div id="top-right">
          {view !== "feed" && (
            <button
              id="feed-link"
              className={isEditor ? menuClass : ""}
              onClick={() => { setView("feed"); setAccountMenuOpen(false); }}
            >
              feed
            </button>
          )}
          <button
            id="account-btn"
            className={isEditor ? menuClass : ""}
            onClick={() => user ? setAccountMenuOpen(v => !v) : setAuthOpen(true)}
            title={user ? user.email : "Sign in"}
          >
            {user ? user.email[0].toUpperCase() : "sign in"}
          </button>
        </div>
      )}

      {/* ── account dropdown ── */}
      {accountMenuOpen && user && (
        <>
          <div id="account-backdrop" onClick={() => setAccountMenuOpen(false)} />
          <div id="account-menu">
            <span id="account-email">{user.email}</span>
            <button onClick={() => { setView("profile"); setAccountMenuOpen(false); }}>my profile</button>
            {isEditor && (
              <button onClick={() => {
                setAccountMenuOpen(false);
                const doc = docs.find(d => d.id === activeId);
                if (doc) openPublishModal(doc);
              }}>
                {publishedDocIds.has(activeId) ? "unpublish" : "publish this document"}
              </button>
            )}
            <button onClick={signOut}>sign out</button>
          </div>
        </>
      )}

      {/* ── centred brand ── */}
      <div id="menu" className={isEditor ? menuClass : ""}>
        <button
          id="brand"
          onClick={isEditor ? exportToPdf : goToEditor}
          title={isEditor ? "Export PDF  ⌘S" : "Back to editor"}
        >
          inkk.
        </button>
        <div id="menu-meta">{subLabel}</div>
      </div>

      {/* ── editor (always mounted to preserve scroll; hidden when not active) ── */}
      <div
        id="text-container"
        ref={containerRef}
        style={{ display: isEditor ? "" : "none" }}
        onClick={() => editorRef.current?.focus()}
      >
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

      {view === "feed" && <Feed onRead={openReading} />}

      {view === "profile" && user && (
        <Profile
          user={user}
          onRead={openReading}
          onUnpublish={(docId) =>
            setPublishedDocIds(prev => { const s = new Set(prev); s.delete(docId); return s; })
          }
        />
      )}

      {view === "reading" && readingPub && <ReadingView pub={readingPub} />}

      {/* ── publish modal ── */}
      {publishModalDoc && user && (
        <PublishModal
          doc={publishModalDoc}
          user={user}
          onConfirm={confirmPublish}
          onClose={() => setPublishModalDoc(null)}
        />
      )}

      {/* ── auth modal ── */}
      {authOpen && supabase && <AuthModal onClose={() => setAuthOpen(false)} />}
    </>
  );
}
