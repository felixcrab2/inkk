import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import "@fontsource/eb-garamond/400.css";
import { jsPDF } from "jspdf";
import garamondTTF from "./assets/EBGaramond-Regular.ttf";
import { supabase } from "./supabase";
import {
  Menu, ArrowLeft, PenLine, Globe, User,
  Share2, Check, Download, Maximize2, Minimize2,
  Copy, CheckCheck, Plus, Trash2, Type, Search,
} from "lucide-react";

// ─── local storage ────────────────────────────────────────────────────────────

function createDoc() {
  const now = Date.now();
  return { id: crypto.randomUUID(), content: "", updatedAt: now, createdAt: now, writingTimeSecs: 0, revisionCount: 0 };
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
  const docs = saved.docs.map(d => ({
    ...d,
    createdAt: d.createdAt || d.updatedAt || Date.now(),
    writingTimeSecs: d.writingTimeSecs || 0,
    revisionCount: d.revisionCount || 0,
  }));
  const validId = docs.find(d => d.id === saved.activeId) ? saved.activeId : docs[0].id;
  return { docs, activeId: validId };
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

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatWritingTime(secs) {
  if (!secs || secs < 60) return secs ? `${Math.round(secs)}s` : "0s";
  return `${Math.round(secs / 60)} min`;
}

function humanSignalStatus(writingTimeSecs, revisionCount) {
  if (!writingTimeSecs && !revisionCount) return "quiet";
  if (writingTimeSecs < 90 || revisionCount < 2) return "beginning";
  if (writingTimeSecs < 480 || revisionCount < 5) return "building";
  return "strong";
}

function readingTime(content) {
  const mins = Math.ceil(wordCount(content) / 220);
  return `${mins} min read`;
}

function formatDate(iso) {
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  const weeks = Math.floor(diffDays / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(diffDays / 30);
  if (months < 12) return `${months}mo ago`;
  return new Date(iso).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

function pubPreview(content) {
  const lines = (content || "").trim().split("\n").filter(l => l.trim());
  const body = lines.slice(1).join(" ").trim();
  return body.length > 140 ? body.slice(0, 140).trimEnd() + "…" : body;
}

function formatJoined(isoOrDate) {
  if (!isoOrDate) return "";
  return new Date(isoOrDate).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

// ─── streak ───────────────────────────────────────────────────────────────────

function loadStreak() {
  try {
    const raw = localStorage.getItem("inkk_streak");
    return raw ? JSON.parse(raw) : { count: 0, lastDate: null };
  } catch { return { count: 0, lastDate: null }; }
}

function touchStreak() {
  const today = new Date().toDateString();
  const s = loadStreak();
  if (s.lastDate === today) return s.count;
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  const count = s.lastDate === yesterday ? s.count + 1 : 1;
  try { localStorage.setItem("inkk_streak", JSON.stringify({ count, lastDate: today })); } catch {}
  return count;
}

// ─── cloud sync ───────────────────────────────────────────────────────────────

async function fetchCloudDocs() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("documents")
    .select("id, content, updated_at");
  if (error || !data) return [];
  return data.map(r => ({
    id: r.id, content: r.content,
    updatedAt: new Date(r.updated_at).getTime(),
  }));
}

async function pushDocToCloud(doc, userId) {
  if (!supabase || !userId) return;
  await supabase.from("documents").upsert({
    id: doc.id, user_id: userId,
    content: doc.content,
    updated_at: new Date(doc.updatedAt).toISOString(),
  });
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
    .select("id, title, content, published_at, author_name, author_username, user_id, writing_time_seconds, revision_count")
    .order("published_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data;
}

async function fetchMyPublications(userId) {
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from("publications")
    .select("id, doc_id, title, content, published_at, writing_time_seconds, revision_count")
    .eq("user_id", userId)
    .order("published_at", { ascending: false });
  if (error || !data) return [];
  return data;
}

async function doPublish(doc, user, title, authorName, authorUsername) {
  if (!supabase || !user) return "Not signed in.";
  const { data: existing, error: fetchErr } = await supabase
    .from("publications").select("id").eq("doc_id", doc.id).maybeSingle();
  if (fetchErr) return fetchErr.message;
  const payload = {
    title, content: doc.content, author_name: authorName,
    author_username: authorUsername || null,
    published_at: new Date().toISOString(),
    writing_time_seconds: Math.round(doc.writingTimeSecs || 0),
    revision_count: doc.revisionCount || 0,
  };
  let error;
  if (existing) {
    ({ error } = await supabase.from("publications").update(payload).eq("id", existing.id));
  } else {
    ({ error } = await supabase.from("publications").insert({ ...payload, doc_id: doc.id, user_id: user.id }));
  }
  return error ? error.message : null;
}

async function doUnpublish(docId) {
  if (!supabase) return;
  await supabase.from("publications").delete().eq("doc_id", docId);
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

async function fetchProfile(userId) {
  if (!supabase || !userId) return null;
  const { data } = await supabase
    .from("profiles").select("id, username, display_name").eq("id", userId).maybeSingle();
  return data || null;
}

async function upsertProfile(userId, username, displayName) {
  if (!supabase || !userId) return "Not signed in.";
  const { error } = await supabase
    .from("profiles").upsert({ id: userId, username, display_name: displayName || null });
  return error ? error.message : null;
}

async function searchProfiles(query) {
  if (!supabase || !query.trim()) return [];
  const q = query.trim();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, display_name")
    .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
    .limit(20);
  if (error || !data) return [];
  return data;
}

async function fetchUserPublications(userId) {
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from("publications")
    .select("id, title, content, published_at, author_name, writing_time_seconds, revision_count")
    .eq("user_id", userId)
    .order("published_at", { ascending: false });
  if (error || !data) return [];
  return data;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toasts({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div id="toast-stack">
      {toasts.map(t => (
        <div key={t.id} className={t.type === "hint" ? "toast toast-hint" : "toast"}>{t.message}</div>
      ))}
    </div>
  );
}

// ─── LandingScreen ────────────────────────────────────────────────────────────

function LandingScreen({ onDone }) {
  const FULL1 = "Write Human.";
  const FULL2 = "Write Simple.";
  const [display, setDisplay] = useState("");
  const [phase, setPhase] = useState(0);
  const [showSubtitle, setShowSubtitle] = useState(false);
  const [fading, setFading] = useState(false);

  const skip = useCallback(() => {
    localStorage.setItem("inkk_visited", "1");
    onDone();
  }, [onDone]);

  useEffect(() => {
    let t;
    if (phase === 0) {
      if (display.length < FULL1.length) {
        t = setTimeout(() => setDisplay(FULL1.slice(0, display.length + 1)), 80);
      } else { t = setTimeout(() => setPhase(1), 800); }
    } else if (phase === 1) {
      t = setTimeout(() => setPhase(2), 700);
    } else if (phase === 2) {
      const keep = "Write ";
      if (display.length > keep.length) {
        t = setTimeout(() => setDisplay(display.slice(0, -1)), 45);
      } else { t = setTimeout(() => setPhase(3), 150); }
    } else if (phase === 3) {
      if (display.length < FULL2.length) {
        t = setTimeout(() => setDisplay(FULL2.slice(0, display.length + 1)), 80);
      } else { t = setTimeout(() => setPhase(4), 800); }
    } else if (phase === 4) {
      t = setTimeout(() => setPhase(5), 700);
    } else if (phase === 5) {
      setShowSubtitle(true);
      t = setTimeout(() => setPhase(6), 3200);
    } else if (phase === 6) {
      setFading(true);
      t = setTimeout(() => { localStorage.setItem("inkk_visited", "1"); onDone(); }, 600);
    }
    return () => clearTimeout(t);
  }, [phase, display, onDone]);

  return (
    <div id="landing" className={fading ? "fading" : ""} onClick={skip}>
      <div id="landing-inner">
        <div id="landing-headline">{display}<span id="landing-cursor" /></div>
        <p id="landing-subtitle" style={{ opacity: showSubtitle ? 1 : 0 }}>
          Inkk records the writing process — drafts, revisions, and time spent — so readers can see signs of real human thought.
        </p>
      </div>
    </div>
  );
}

// ─── HumanSignalModal ─────────────────────────────────────────────────────────

function HumanSignalModal({ onClose }) {
  return (
    <div id="auth-overlay" onClick={onClose}>
      <div id="auth-modal" onClick={e => e.stopPropagation()}>
        <button id="auth-close" onClick={onClose}>×</button>
        <div id="hs-modal-title">Human Signal</div>
        <p id="hs-modal-body">
          Inkk does not claim to perfectly detect AI. Instead it shows the process behind a piece of writing: time spent drafting, number of revisions, and word count.
        </p>
        <p id="hs-modal-body" style={{ marginTop: "12px" }}>
          This is Human Signal — a quiet record of thought in progress.
        </p>
      </div>
    </div>
  );
}

// ─── HumanSignalBadge ─────────────────────────────────────────────────────────

function HumanSignalBadge({ writingTimeSecs, revisionCount, content }) {
  if (!writingTimeSecs && !revisionCount) return null;
  const status = humanSignalStatus(writingTimeSecs, revisionCount);
  return (
    <div className="hs-badge">
      <span className="hs-badge-dot" data-status={status} />
      <span className="hs-badge-text">
        Human Signal · {formatWritingTime(writingTimeSecs)} · {revisionCount} rev · {wordCount(content)}w
      </span>
    </div>
  );
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
    e.preventDefault(); setError(""); setLoading(true);
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
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
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

// ─── UsernameModal ────────────────────────────────────────────────────────────

function UsernameModal({ user, onDone }) {
  const [username, setUsername]       = useState("");
  const [displayName, setDisplayName] = useState(user.user_metadata?.full_name || "");
  const [error, setError]             = useState("");
  const [loading, setLoading]         = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const u = username.trim();
    if (u.length < 3) { setError("At least 3 characters."); return; }
    setLoading(true); setError("");
    const errMsg = await upsertProfile(user.id, u, displayName.trim());
    if (errMsg) {
      setError(errMsg.includes("unique") || errMsg.includes("duplicate") ? "Username taken." : errMsg);
      setLoading(false);
    } else {
      onDone({ id: user.id, username: u, display_name: displayName.trim() });
    }
  };

  return (
    <div id="auth-overlay">
      <div id="auth-modal" onClick={e => e.stopPropagation()}>
        <div id="auth-tabs">
          <button className="active" style={{ cursor: "default" }}>choose a username</button>
        </div>
        <form onSubmit={submit}>
          <input
            type="text"
            placeholder="username"
            value={username}
            onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
            required
            autoFocus
            maxLength={20}
          />
          <input
            type="text"
            placeholder="display name (optional)"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            maxLength={50}
          />
          {error && <p className="auth-error">{error}</p>}
          <button id="auth-submit" type="submit" disabled={loading || username.length < 3}>
            {loading ? "saving…" : "continue"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── PublishModal ─────────────────────────────────────────────────────────────

function PublishModal({ doc, user, profile, onConfirm, onClose }) {
  const rawTitle  = docTitle(doc.content);
  const rawAuthor = profile?.username || user.user_metadata?.full_name || user.email.split("@")[0];
  const [title, setTitle]     = useState(rawTitle === "Untitled" ? "" : rawTitle);
  const [author, setAuthor]   = useState(rawAuthor);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");

  const submit = async (e) => {
    e.preventDefault();
    const t = title.trim(); const a = author.trim() || rawAuthor;
    if (!t) return;
    setLoading(true); setError("");
    const errMsg = await onConfirm(t, a);
    if (errMsg) setError(errMsg);
    setLoading(false);
  };

  return (
    <div id="auth-overlay">
      <div id="auth-modal">
        <button id="auth-close" onClick={onClose}>×</button>
        <div id="auth-tabs">
          <button className="active" style={{ cursor: "default" }}>publish to feed</button>
        </div>
        <form onSubmit={submit}>
          <input type="text" placeholder="article title" value={title} onChange={e => setTitle(e.target.value)} required autoFocus />
          <input type="text" placeholder="author name" value={author} onChange={e => setAuthor(e.target.value)} />
          {error && <p className="auth-error">{error}</p>}
          <button id="auth-submit" type="submit" disabled={loading || !title.trim()}>
            {loading ? "publishing…" : "publish"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Feed ─────────────────────────────────────────────────────────────────────

function Feed({ onRead, onHsModal, onAuthorClick }) {
  const [pubs, setPubs]       = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFeed().then(data => { setPubs(data); setLoading(false); });
  }, []);

  return (
    <div id="feed-container">
      <div id="feed-header">
        <h1 id="feed-title">Explore human writing.</h1>
        <button id="hs-link" onClick={onHsModal}>What is Human Signal?</button>
      </div>
      <div id="feed-list">
        {loading && <p className="feed-empty">loading…</p>}
        {!loading && pubs.length === 0 && (
          <p className="feed-empty">nothing published yet — be the first.</p>
        )}
        {pubs.map(pub => (
          <article key={pub.id} className="pub-card" onClick={() => onRead(pub)}>
            <div className="pub-card-meta">
              <button className="pub-author-btn" onClick={e => { e.stopPropagation(); if (pub.user_id) onAuthorClick(pub.user_id); }}>
                {pub.author_name}
              </button>
              <span className="pub-dot">·</span>
              <span className="pub-date">{formatDate(pub.published_at)}</span>
              <span className="pub-dot">·</span>
              <span className="pub-read-time">{readingTime(pub.content)}</span>
            </div>
            <h2 className="pub-card-title">{pub.title}</h2>
            {pubPreview(pub.content) && (
              <p className="pub-card-preview">{pubPreview(pub.content)}</p>
            )}
            {(pub.writing_time_seconds > 0 || pub.revision_count > 0) ? (
              <HumanSignalBadge
                writingTimeSecs={pub.writing_time_seconds}
                revisionCount={pub.revision_count}
                content={pub.content}
              />
            ) : (
              <span className="pub-card-words">{wordCount(pub.content)} words</span>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

// ─── Profile ──────────────────────────────────────────────────────────────────

function Profile({ user, profile, localDocs, streak, onRead, onUnpublish, onSignIn, onSignOut }) {
  const [pubs, setPubs]       = useState([]);
  const [loading, setLoading] = useState(!!user);

  useEffect(() => {
    if (!user) { setPubs([]); setLoading(false); return; }
    fetchMyPublications(user.id).then(data => { setPubs(data); setLoading(false); });
  }, [user]);

  const handleUnpublish = async (pub, e) => {
    e.stopPropagation();
    await doUnpublish(pub.doc_id);
    setPubs(prev => prev.filter(p => p.id !== pub.id));
    if (onUnpublish) onUnpublish(pub.doc_id);
  };

  if (!user) {
    return (
      <div id="profile-container">
        <div id="profile-signin">
          <div id="profile-signin-icon"><User size={28} strokeWidth={1.5} /></div>
          <h2 id="profile-signin-title">Join the conversation.</h2>
          <p id="profile-signin-sub">Write privately, or publish to the feed — all with Human Signal tracking.</p>
          <button className="profile-cta" onClick={onSignIn}>Sign in</button>
          <button className="profile-cta-ghost" onClick={onSignIn}>Create account</button>
        </div>
      </div>
    );
  }

  const totalWords = localDocs.reduce((sum, d) => sum + wordCount(d.content), 0);
  const initial = user.email[0].toUpperCase();

  return (
    <div id="profile-container">
      <div id="profile-header">
        <div id="profile-avatar">{initial}</div>
        <div id="profile-info">
          {profile?.username
            ? <div id="profile-username">@{profile.username}</div>
            : <div id="profile-email">{user.email}</div>
          }
          {profile?.display_name && <div id="profile-email">{profile.display_name}</div>}
          {user.created_at && (
            <div id="profile-joined">Member since {formatJoined(user.created_at)}</div>
          )}
        </div>
      </div>

      <div id="profile-stats">
        {streak > 0 && (
          <div className="stat-chip">
            <span className="stat-chip-icon">🔥</span>
            <span className="stat-chip-value">{streak}</span>
            <span className="stat-chip-label">day streak</span>
          </div>
        )}
        <div className="stat-chip">
          <span className="stat-chip-value">{pubs.length}</span>
          <span className="stat-chip-label">published</span>
        </div>
        <div className="stat-chip">
          <span className="stat-chip-value">{totalWords.toLocaleString()}</span>
          <span className="stat-chip-label">words written</span>
        </div>
      </div>

      <div id="profile-section-label">Your writing</div>

      <div id="profile-list">
        {loading && <p className="feed-empty">loading…</p>}
        {!loading && pubs.length === 0 && (
          <p className="feed-empty">nothing published yet.</p>
        )}
        {pubs.map(pub => (
          <article key={pub.id} className="pub-card" onClick={() => onRead(pub)}>
            <div className="pub-card-meta">
              <span className="pub-date">{formatDate(pub.published_at)}</span>
              <span className="pub-dot">·</span>
              <span className="pub-read-time">{readingTime(pub.content)}</span>
              <button className="pub-remove" onClick={e => handleUnpublish(pub, e)}>remove</button>
            </div>
            <h2 className="pub-card-title">{pub.title}</h2>
            {pubPreview(pub.content) && (
              <p className="pub-card-preview">{pubPreview(pub.content)}</p>
            )}
            {(pub.writing_time_seconds > 0 || pub.revision_count > 0) ? (
              <HumanSignalBadge
                writingTimeSecs={pub.writing_time_seconds}
                revisionCount={pub.revision_count}
                content={pub.content}
              />
            ) : (
              <span className="pub-card-words">{wordCount(pub.content)} words</span>
            )}
          </article>
        ))}
      </div>

      <button id="signout-btn" onClick={onSignOut}>Sign out</button>
    </div>
  );
}

// ─── SearchView ───────────────────────────────────────────────────────────────

function SearchView({ onViewUser }) {
  const [query, setQuery]       = useState("");
  const [results, setResults]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!query.trim()) { setResults([]); setSearched(false); return; }
      setLoading(true);
      const data = await searchProfiles(query);
      setResults(data); setSearched(true); setLoading(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div id="search-container">
      <div id="search-bar">
        <Search size={14} id="search-icon" />
        <input
          ref={inputRef}
          id="search-input"
          type="text"
          placeholder="Find writers by username…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {query && <button id="search-clear" onClick={() => setQuery("")}>×</button>}
      </div>
      <div id="search-results">
        {loading && <p className="feed-empty">searching…</p>}
        {!loading && searched && results.length === 0 && <p className="feed-empty">no writers found.</p>}
        {!loading && !searched && <p className="feed-empty search-prompt">Search for a writer by username.</p>}
        {results.map(p => (
          <div key={p.id} className="user-card" onClick={() => onViewUser(p)}>
            <div className="user-card-avatar">{(p.username || "?")[0].toUpperCase()}</div>
            <div className="user-card-info">
              <div className="user-card-username">@{p.username}</div>
              {p.display_name && <div className="user-card-name">{p.display_name}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── UserProfileView ──────────────────────────────────────────────────────────

function UserProfileView({ profile, onRead }) {
  const [pubs, setPubs]       = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUserPublications(profile.id).then(data => { setPubs(data); setLoading(false); });
  }, [profile.id]);

  const initial = (profile.username || "?")[0].toUpperCase();

  return (
    <div id="user-profile-container">
      <div id="user-profile-header">
        <div className="user-profile-avatar">{initial}</div>
        <div>
          <div id="user-profile-username">@{profile.username}</div>
          {profile.display_name && <div id="user-profile-name">{profile.display_name}</div>}
        </div>
      </div>
      <div id="user-profile-list">
        {loading && <p className="feed-empty">loading…</p>}
        {!loading && pubs.length === 0 && <p className="feed-empty">nothing published yet.</p>}
        {pubs.map(pub => (
          <article key={pub.id} className="pub-card" onClick={() => onRead(pub)}>
            <div className="pub-card-meta">
              <span className="pub-date">{formatDate(pub.published_at)}</span>
              <span className="pub-dot">·</span>
              <span className="pub-read-time">{readingTime(pub.content)}</span>
            </div>
            <h2 className="pub-card-title">{pub.title}</h2>
            {pubPreview(pub.content) && <p className="pub-card-preview">{pubPreview(pub.content)}</p>}
            {(pub.writing_time_seconds > 0 || pub.revision_count > 0) && (
              <HumanSignalBadge writingTimeSecs={pub.writing_time_seconds} revisionCount={pub.revision_count} content={pub.content} />
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

// ─── ReadingView ──────────────────────────────────────────────────────────────

function ReadingView({ pub, font }) {
  const containerRef = useRef(null);
  const [progress, setProgress]   = useState(0);
  const [copied, setCopied]       = useState(false);
  const hasHS = pub.writing_time_seconds > 0 || pub.revision_count > 0;

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 0 ? el.scrollTop / max : 0);
  }, []);

  const copyText = useCallback(() => {
    navigator.clipboard.writeText(pub.title + "\n\n" + pub.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [pub]);

  return (
    <>
      <div id="reading-progress" style={{ width: `${progress * 100}%` }} />
      <div id="reading-container" ref={containerRef} onScroll={handleScroll}>
        <div id="reading-inner">
          <div id="reading-meta">
            <span>{pub.author_name}</span>
            <span className="reading-dot">·</span>
            <span>{formatDate(pub.published_at)}</span>
            <span className="reading-dot">·</span>
            <span>{readingTime(pub.content)}</span>
            <button id="reading-copy" onClick={copyText} title="Copy text">
              {copied ? <CheckCheck size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <h1 id="reading-headline">{pub.title}</h1>
          {hasHS && (
            <HumanSignalBadge
              writingTimeSecs={pub.writing_time_seconds}
              revisionCount={pub.revision_count}
              content={pub.content}
            />
          )}
          <div id="reading-text" className={font === "arial" ? "font-arial" : ""}>{pub.content}</div>
        </div>
      </div>
    </>
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
  const [words, setWords]             = useState(() => wordCount(initDocs.find(d => d.id === initActiveId)?.content));
  const [user, setUser]               = useState(null);
  const [authOpen, setAuthOpen]       = useState(false);
  const [view, setView]               = useState("editor");
  const [readingPub, setReadingPub]   = useState(null);
  const [publishedDocIds, setPublishedDocIds] = useState(new Set());
  const [publishModalDoc, setPublishModalDoc] = useState(null);
  const [font, setFont]               = useState(() => localStorage.getItem("inkk_font") || "garamond");
  const [showLanding, setShowLanding] = useState(() => !localStorage.getItem("inkk_visited"));
  const [hsModalOpen, setHsModalOpen] = useState(false);
  const [liveWritingTimeSecs, setLiveWritingTimeSecs] = useState(() =>
    initDocs.find(d => d.id === initActiveId)?.writingTimeSecs || 0
  );
  const [streak, setStreak]           = useState(() => loadStreak().count);
  const [toasts, setToasts]           = useState([]);
  const [focusMode, setFocusMode]     = useState(false);
  const [publishMenuOpen, setPublishMenuOpen] = useState(false);
  const [profile, setProfile]         = useState(null);
  const [usernameModalOpen, setUsernameModalOpen] = useState(false);
  const [viewingUser, setViewingUser] = useState(null);

  const editorRef    = useRef(null);
  const containerRef = useRef(null);
  const contentRef   = useRef("");
  const isMobileRef  = useRef(false);
  const mountedRef   = useRef(false);
  const idleTimerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const rafRef       = useRef(null);
  const userRef      = useRef(null);
  const prevViewRef  = useRef("editor");

  const writingBaseRef         = useRef(initDocs.find(d => d.id === initActiveId)?.writingTimeSecs || 0);
  const writingSessionStartRef = useRef(null);
  const writingFlushRef        = useRef(0);
  const saveHintShownRef       = useRef(!!localStorage.getItem("inkk_save_hint"));

  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { localStorage.setItem("inkk_font", font); }, [font]);

  useEffect(() => {
    if (focusMode) document.body.classList.add("focus-mode");
    else document.body.classList.remove("focus-mode");
  }, [focusMode]);

  useEffect(() => {
    if (!showLanding && !isMobileRef.current) editorRef.current?.focus();
  }, [showLanding]);

  const addToast = useCallback((message, type) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 2800);
  }, []);

  const IDLE_MS = 1200;

  // ─ load doc into DOM ────────────────────────────────────────────────────────

  const loadDocIntoEditor = useCallback((doc) => {
    const el = editorRef.current;
    if (!el) return;
    contentRef.current = doc.content;
    el.innerText = doc.content;
    setWords(wordCount(doc.content));
    writingBaseRef.current = doc.writingTimeSecs || 0;
    writingFlushRef.current = 0;
    writingSessionStartRef.current = null;
    setLiveWritingTimeSecs(doc.writingTimeSecs || 0);
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
      setUser(signedInUser); userRef.current = signedInUser; setAuthOpen(false);
      const cloudDocs = await fetchCloudDocs();
      const saved = loadState();
      const localDocs = saved?.docs || [];
      const hasLocalContent = localDocs.some(d => d.content.trim());
      let merged = (hasLocalContent || !cloudDocs.length)
        ? mergeDocs(localDocs, cloudDocs) : cloudDocs;
      if (!merged.length) merged = [createDoc()];
      merged = merged.map(d => ({
        ...d,
        createdAt: d.createdAt || d.updatedAt || Date.now(),
        writingTimeSecs: d.writingTimeSecs || 0,
        revisionCount: d.revisionCount || 0,
      }));
      const cloudIds = new Set(cloudDocs.map(d => d.id));
      for (const doc of merged)
        if (!cloudIds.has(doc.id) && doc.content.trim())
          await pushDocToCloud(doc, signedInUser.id);
      const savedActiveId = saved?.activeId;
      const newActiveId = merged.find(d => d.id === savedActiveId) ? savedActiveId : merged[0].id;
      setDocs(merged); saveState(merged, newActiveId); setActiveId(newActiveId);
      const docToLoad = merged.find(d => d.id === newActiveId);
      if (docToLoad) loadDocIntoEditor(docToLoad);
      const myPubs = await fetchMyPublications(signedInUser.id);
      setPublishedDocIds(new Set(myPubs.map(p => p.doc_id).filter(Boolean)));
      const prof = await fetchProfile(signedInUser.id);
      if (prof) setProfile(prof);
      else setUsernameModalOpen(true);
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) syncOnLogin(session.user);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user) syncOnLogin(session.user);
      if (event === "SIGNED_OUT") { setUser(null); setPublishedDocIds(new Set()); setProfile(null); setUsernameModalOpen(false); }
    });
    return () => subscription.unsubscribe();
  }, [loadDocIntoEditor]);

  // ─ switch document ──────────────────────────────────────────────────────────

  const switchDoc = useCallback((id) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    let timeToSave = writingBaseRef.current + writingFlushRef.current;
    if (writingSessionStartRef.current !== null) {
      timeToSave += (Date.now() - writingSessionStartRef.current) / 1000;
      writingSessionStartRef.current = null;
    }
    writingFlushRef.current = 0;
    setDocs(prev => {
      const flushed = prev.map(d =>
        d.id === activeId ? { ...d, content: contentRef.current, updatedAt: Date.now(), writingTimeSecs: timeToSave } : d
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
    let timeToSave = writingBaseRef.current + writingFlushRef.current;
    if (writingSessionStartRef.current !== null) {
      timeToSave += (Date.now() - writingSessionStartRef.current) / 1000;
      writingSessionStartRef.current = null;
    }
    writingFlushRef.current = 0;
    const doc = createDoc();
    setDocs(prev => {
      const flushed = prev.map(d =>
        d.id === activeId ? { ...d, content: contentRef.current, updatedAt: Date.now(), writingTimeSecs: timeToSave } : d
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
    if (!userRef.current) { setAuthOpen(true); return; }
    const content = doc.id === activeId ? contentRef.current : doc.content;
    if (!content?.trim()) return;
    setPublishModalDoc({ ...doc, content });
  }, [activeId]);

  const confirmPublish = useCallback(async (title, authorName) => {
    if (!publishModalDoc) return "No document selected.";
    const wasAlreadyPublished = publishedDocIds.has(publishModalDoc.id);
    const errMsg = await doPublish(publishModalDoc, userRef.current, title, authorName, profile?.username);
    if (!errMsg) {
      setPublishedDocIds(prev => new Set([...prev, publishModalDoc.id]));
      setPublishModalDoc(null);
      addToast(wasAlreadyPublished ? "Updated." : "Published to feed.");
    }
    return errMsg;
  }, [publishModalDoc, publishedDocIds, profile, addToast]);

  const openUserProfile = useCallback(async (userIdOrProfile, from) => {
    const prof = typeof userIdOrProfile === "string"
      ? await fetchProfile(userIdOrProfile)
      : userIdOrProfile;
    if (!prof) { addToast("This writer hasn't set up their profile."); return; }
    prevViewRef.current = from || view;
    setViewingUser(prof);
    setView("userProfile");
  }, [view, addToast]);

  // ─ sign out ─────────────────────────────────────────────────────────────────

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    addToast("Signed out.");
  }, [addToast]);

  // ─ typing ───────────────────────────────────────────────────────────────────

  const scheduleMenuReturn = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      if (writingSessionStartRef.current !== null) {
        writingFlushRef.current += (Date.now() - writingSessionStartRef.current) / 1000;
        writingSessionStartRef.current = null;
      }
      setMenuVisible(true);
    }, IDLE_MS);
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
    if (!saveHintShownRef.current) {
      saveHintShownRef.current = true;
      localStorage.setItem("inkk_save_hint", "1");
      setTimeout(() => addToast("Saves automatically.", "hint"), 1500);
    }
    const el = editorRef.current;
    if (!el) return;
    const text = el.innerText;
    contentRef.current = text;
    setWords(wordCount(text));
    setMenuVisible(false);

    if (writingSessionStartRef.current === null) writingSessionStartRef.current = Date.now();
    const liveTime = writingBaseRef.current + writingFlushRef.current +
      (Date.now() - writingSessionStartRef.current) / 1000;
    setLiveWritingTimeSecs(liveTime);

    scheduleMenuReturn();
    scrollToCursor();
    setSaveStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    const capturedId = activeId;
    const capturedContent = text;
    saveTimerRef.current = setTimeout(() => {
      const capturedUpdatedAt = Date.now();
      const capturedTime = writingBaseRef.current + writingFlushRef.current +
        (writingSessionStartRef.current !== null ? (Date.now() - writingSessionStartRef.current) / 1000 : 0);
      setDocs(prev => {
        const next = prev.map(d =>
          d.id === capturedId
            ? { ...d, content: capturedContent, updatedAt: capturedUpdatedAt, writingTimeSecs: capturedTime, revisionCount: (d.revisionCount || 0) + 1 }
            : d
        );
        saveState(next, capturedId);
        return next;
      });
      if (capturedContent.trim()) {
        const newStreak = touchStreak();
        setStreak(newStreak);
      }
      if (userRef.current)
        pushDocToCloud({ id: capturedId, content: capturedContent, updatedAt: capturedUpdatedAt }, userRef.current.id);
      setSaveStatus("saved");
    }, 500);
  }, [activeId, scheduleMenuReturn, scrollToCursor, addToast]);

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
    const mx = 72, mt = 96, mb = 72, maxW = pageW - mx * 2;
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
        for (const line of doc.splitTextToSize(para, maxW)) { if (y > pageH - mb) newPage(); doc.text(line, mx, y); y += 30; }
        y += 20; doc.setFontSize(fs); continue;
      }
      doc.setFontSize(fs);
      for (const rawLine of para.split("\n"))
        for (const line of doc.splitTextToSize(rawLine || " ", maxW)) { if (y > pageH - mb) newPage(); if (line.trim()) doc.text(line, mx, y); y += lh; }
      y += paraGap;
    }
    doc.save(`${docTitle(text).replace(/[^a-zA-Z0-9\s\-_]/g, "").trim() || "inkk"}.pdf`);
  }, []);

  // ─ keyboard shortcuts ───────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (view === "editor") exportToPdf(); }
      if ((e.metaKey || e.ctrlKey) && e.key === ".") { e.preventDefault(); if (view === "editor") setFocusMode(v => !v); }
      if (e.key === "Escape") {
        if (focusMode) { setFocusMode(false); return; }
        if (publishMenuOpen) { setPublishMenuOpen(false); return; }
        if (publishModalDoc) { setPublishModalDoc(null); return; }
        if (usernameModalOpen) return;
        setPanelOpen(false); setAuthOpen(false); setHsModalOpen(false);
        if (view === "userProfile") { setView(prevViewRef.current || "search"); setViewingUser(null); return; }
        if (view !== "editor") { setView("editor"); setReadingPub(null); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [exportToPdf, view, focusMode, publishMenuOpen, publishModalDoc, usernameModalOpen]);

  // ─ mount ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    isMobileRef.current = isMobile();
    const doc = initDocs.find(d => d.id === initActiveId) || initDocs[0];
    if (doc) {
      contentRef.current = doc.content;
      writingBaseRef.current = doc.writingTimeSecs || 0;
      const el = editorRef.current;
      if (el) {
        el.innerText = doc.content;
        if (!isMobileRef.current && localStorage.getItem("inkk_visited")) el.focus();
      }
    }
    mountedRef.current = true;
    return () => {
      [idleTimerRef, saveTimerRef].forEach(r => { if (r.current) clearTimeout(r.current); });
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view === "editor" && !isMobileRef.current) editorRef.current?.focus();
  }, [view]);

  // ─ render ───────────────────────────────────────────────────────────────────

  const isEditor  = view === "editor";
  const menuClass = menuVisible ? "menu-visible" : "menu-hidden";

  const activeDoc    = docs.find(d => d.id === activeId);
  const liveRevCount = activeDoc?.revisionCount || 0;
  const hsStatus     = humanSignalStatus(liveWritingTimeSecs, liveRevCount);
  const sortedDocs   = [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
  const hasContent   = words > 0;
  const isPublished  = publishedDocIds.has(activeId);

  const openReading = useCallback((pub, from) => {
    prevViewRef.current = from || view;
    setReadingPub(pub);
    setView("reading");
  }, [view]);

  const goBack = useCallback(() => {
    setView(prevViewRef.current || "editor");
    setReadingPub(null);
  }, []);

  return (
    <>
      {/* ── landing overlay ── */}
      {showLanding && <LandingScreen onDone={() => setShowLanding(false)} />}

      {/* ── top bar ── */}
      <header id="top-bar">
        <div id="top-bar-left">
          {isEditor && (
            <button className={`icon-btn ${menuClass}`} onClick={() => setPanelOpen(v => !v)} title="Documents">
              <Menu size={18} />
            </button>
          )}
          {(view === "reading" || view === "userProfile") && (
            <button className="icon-btn" onClick={goBack} title="Back">
              <ArrowLeft size={18} />
            </button>
          )}
        </div>
        <div id="top-bar-center">
          <span id="brand">inkk.</span>
        </div>
        <div id="top-bar-right">
          {isEditor && supabase && hasContent && (
            <div id="publish-menu-wrap">
              <button
                id="publish-btn"
                className={menuClass}
                onClick={() => {
                  const doc = docs.find(d => d.id === activeId);
                  if (!doc) return;
                  if (isPublished) setPublishMenuOpen(v => !v);
                  else openPublishModal(doc);
                }}
              >
                {isPublished
                  ? <><Check size={13} /><span className="btn-label">Published</span></>
                  : <><Share2 size={13} /><span className="btn-label">Publish</span></>
                }
              </button>
              {isPublished && publishMenuOpen && (
                <div id="publish-menu">
                  <button className="publish-menu-item" onClick={() => {
                    setPublishMenuOpen(false);
                    const doc = docs.find(d => d.id === activeId);
                    if (doc) openPublishModal(doc);
                  }}>Update</button>
                  <button className="publish-menu-item publish-menu-danger" onClick={() => {
                    setPublishMenuOpen(false);
                    doUnpublish(activeId).then(() => {
                      setPublishedDocIds(prev => { const s = new Set(prev); s.delete(activeId); return s; });
                      addToast("Removed from feed.");
                    });
                  }}>Remove from feed</button>
                </div>
              )}
            </div>
          )}
          {isEditor && (
            <button
              className={`icon-btn focus-btn ${menuClass}`}
              onClick={() => setFocusMode(v => !v)}
              title={focusMode ? "Exit focus mode  ⌘." : "Focus mode  ⌘."}
            >
              {focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          )}
        </div>
      </header>

      {/* ── doc panel ── */}
      {isEditor && panelOpen && <div id="panel-backdrop" onClick={() => setPanelOpen(false)} />}
      {isEditor && (
        <div id="doc-panel" className={panelOpen ? "open" : ""}>
          <button className="new-doc-btn" onClick={newDoc}>
            <Plus size={13} /> New document
          </button>
          <div id="doc-list">
            {sortedDocs.map(d => (
              <div key={d.id} className={`doc-item${d.id === activeId ? " active" : ""}`} onClick={() => switchDoc(d.id)}>
                <div className="doc-item-body">
                  <span className="doc-item-title">{docTitle(d.content)}</span>
                  <span className="doc-item-meta">
                    {wordCount(d.content)}w
                    {d.writingTimeSecs > 60 && ` · ${formatWritingTime(d.writingTimeSecs)}`}
                  </span>
                </div>
                <div className="doc-item-actions">
                  {user && (
                    <button
                      className={`doc-publish${publishedDocIds.has(d.id) ? " published" : ""}`}
                      title={publishedDocIds.has(d.id) ? "Remove from feed" : "Publish to feed"}
                      onClick={e => openPublishModal(d, e)}
                    >
                      {publishedDocIds.has(d.id) ? <Check size={11} /> : <Share2 size={11} />}
                    </button>
                  )}
                  <button className="doc-pdf" onClick={exportToPdf} title="Export PDF  ⌘S">
                    <Download size={11} />
                  </button>
                  {docs.length > 1 && (
                    <button className="doc-delete" onClick={e => deleteDoc(d.id, e)}>
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div id="panel-footer">
            <button id="font-toggle" onClick={() => setFont(f => f === "garamond" ? "arial" : "garamond")}>
              <Type size={13} />
              {font === "garamond" ? "Garamond" : "Arial"}
            </button>
          </div>
        </div>
      )}

      {/* ── human signal status (editor) ── */}
      {isEditor && hasContent && (
        <div id="hs-editor-status" className={menuClass}>
          <span id="hs-status-label">Human Signal: {hsStatus}</span>
          <span id="hs-status-sub">
            {formatWritingTime(liveWritingTimeSecs)} · {liveRevCount} rev · {words}w · {saveStatus === "saving" ? "saving…" : "saved"}
          </span>
        </div>
      )}

      {/* ── editor (always mounted) ── */}
      <div
        id="text-container"
        ref={containerRef}
        style={{ display: isEditor ? "" : "none" }}
        onClick={() => editorRef.current?.focus()}
      >
        <div
          id="text"
          ref={editorRef}
          className={font === "arial" ? "font-arial" : ""}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onInput={onInput}
        />
      </div>

      {/* ── views ── */}
      {view === "feed" && (
        <Feed
          onRead={pub => openReading(pub, "feed")}
          onHsModal={() => setHsModalOpen(true)}
          onAuthorClick={userId => openUserProfile(userId, "feed")}
        />
      )}
      {view === "profile" && (
        <Profile
          user={user}
          profile={profile}
          localDocs={docs}
          streak={streak}
          onRead={pub => openReading(pub, "profile")}
          onUnpublish={docId => setPublishedDocIds(prev => { const s = new Set(prev); s.delete(docId); return s; })}
          onSignIn={() => setAuthOpen(true)}
          onSignOut={signOut}
        />
      )}
      {view === "search" && (
        <SearchView onViewUser={p => openUserProfile(p, "search")} />
      )}
      {view === "userProfile" && viewingUser && (
        <UserProfileView profile={viewingUser} onRead={pub => openReading(pub, "userProfile")} />
      )}
      {view === "reading" && readingPub && <ReadingView pub={readingPub} font={font} />}

      {/* ── bottom nav ── */}
      {view !== "reading" && view !== "userProfile" && (
        <nav id="bottom-nav" className={isEditor ? menuClass : ""}>
          <button className={`nav-tab ${isEditor ? "active" : ""}`} onClick={() => setView("editor")}>
            <PenLine size={18} strokeWidth={1.75} />
            <span className="nav-label">Write</span>
          </button>
          <button className={`nav-tab ${view === "feed" ? "active" : ""}`} onClick={() => setView("feed")}>
            <Globe size={18} strokeWidth={1.75} />
            <span className="nav-label">Feed</span>
          </button>
          <button className={`nav-tab ${view === "search" ? "active" : ""}`} onClick={() => setView("search")}>
            <Search size={18} strokeWidth={1.75} />
            <span className="nav-label">People</span>
          </button>
          <button
            className={`nav-tab ${view === "profile" ? "active" : ""}`}
            onClick={() => setView("profile")}
          >
            {user ? (
              <div className="nav-avatar">{user.email[0].toUpperCase()}</div>
            ) : (
              <User size={18} strokeWidth={1.75} />
            )}
            <span className="nav-label">{user ? "Profile" : "Sign in"}</span>
            {streak > 1 && <span className="nav-streak">🔥{streak}</span>}
          </button>
        </nav>
      )}

      {/* ── modals ── */}
      {publishModalDoc && user && (
        <PublishModal doc={publishModalDoc} user={user} profile={profile} onConfirm={confirmPublish} onClose={() => setPublishModalDoc(null)} />
      )}
      {authOpen && supabase && <AuthModal onClose={() => setAuthOpen(false)} />}
      {hsModalOpen && <HumanSignalModal onClose={() => setHsModalOpen(false)} />}
      {usernameModalOpen && user && (
        <UsernameModal user={user} onDone={prof => { setProfile(prof); setUsernameModalOpen(false); }} />
      )}

      {/* ── focus mode exit ── */}
      {focusMode && (
        <button id="focus-exit" onClick={() => setFocusMode(false)} title="Exit focus mode  ⌘.">
          <Minimize2 size={14} />
        </button>
      )}

      {/* ── publish menu backdrop ── */}
      {publishMenuOpen && <div id="publish-menu-backdrop" onClick={() => setPublishMenuOpen(false)} />}

      {/* ── toasts ── */}
      <Toasts toasts={toasts} />
    </>
  );
}
