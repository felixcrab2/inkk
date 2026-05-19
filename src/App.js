import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/cormorant-garamond/400.css";
import "@fontsource/cormorant-garamond/600.css";
import "@fontsource/cormorant-garamond/400-italic.css";
import { jsPDF } from "jspdf";
import cormorantTTF from "./assets/CormorantGaramond-Regular.ttf";
import { supabase } from "./supabase";
import {
  Menu, ArrowLeft, PenLine, Globe, User,
  Share2, Check, Download, Maximize2, Minimize2,
  Copy, CheckCheck, Plus, Trash2, Type, Search,
} from "lucide-react";
import { createRecorder } from "./telemetry/recorder";
import { extractFeatures } from "./telemetry/features";
import { computeScore } from "./telemetry/score";
import {
  startSync, stopSync,
  setResearchOptIn as remoteSetResearchOptIn,
  getResearchOptIn,
  deleteMyEvents, dumpMyEvents,
} from "./telemetry/sync";
import { claimAnonymous as claimAnonymousEvents } from "./telemetry/store";
import { HumanSignalLine, HumanSignalBadge, HumanSignalPanel } from "./components/HumanSignal";

// ─── local storage ────────────────────────────────────────────────────────────

function createDoc() {
  const now = Date.now();
  return {
    id: crypto.randomUUID(), title: "", content: "",
    updatedAt: now, createdAt: now,
    writingTimeSecs: 0, revisionCount: 0,
    keystrokes: 0, deletions: 0, pastes: 0,
    humanScore: null, scoreTier: null, scoreFeatures: null,
  };
}

const DOC_DEFAULTS = {
  title: "", writingTimeSecs: 0, revisionCount: 0,
  keystrokes: 0, deletions: 0, pastes: 0,
  humanScore: null, scoreTier: null, scoreFeatures: null,
};

function normaliseDoc(d) {
  return {
    ...DOC_DEFAULTS, ...d,
    createdAt: d.createdAt || d.updatedAt || Date.now(),
  };
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
  const docs = saved.docs.map(normaliseDoc);
  const validId = docs.find(d => d.id === saved.activeId) ? saved.activeId : docs[0].id;
  return { docs, activeId: validId };
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<\/div>/gi, "\n").replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<img[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function renderHtml(content) {
  if (!content) return "";
  if (/<(div|br|img|p)\b/i.test(content)) {
    const d = document.createElement("div");
    d.innerHTML = content;
    d.querySelectorAll("script,style,link,meta,iframe,object,embed,form").forEach(n => n.remove());
    d.querySelectorAll("*").forEach(el => {
      for (const a of [...el.attributes])
        if (a.name.startsWith("on") || (a.name === "href" && /javascript:/i.test(a.value))) el.removeAttribute(a.name);
    });
    return d.innerHTML;
  }
  return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

function setEditorHtml(el, content) {
  if (!content) { el.innerHTML = ""; return; }
  if (/<(div|br|img|p)\b/i.test(content)) { el.innerHTML = content; }
  else { el.innerText = content; }
}

function caretRangeAt(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  const pos = document.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const r = document.createRange();
  r.setStart(pos.offsetNode, pos.offset);
  r.collapse(true);
  return r;
}

async function compressImage(file, maxDim = 1600) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new window.Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.88));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function docTitle(content) {
  const first = stripHtml(content || "").trim().split("\n")[0].trim();
  return first.length > 0 ? first : "Untitled";
}

function wordCount(content) {
  const t = stripHtml(content || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

function isMobile() {
  return (
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
  );
}

function dropCapSrc(letter, images) {
  if (!letter || !images) return null;
  const l = letter.toLowerCase();
  const list = images[l];
  return list?.length ? `/drop_caps/${l}/${list[0]}.png` : null;
}

async function compressAvatar(file, size = 240) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext("2d");
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.88));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
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

// Tier helper used by the PDF export.
function tierFromScore(score) {
  return score?.tier || "Faint";
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
  const lines = stripHtml(content || "").trim().split("\n").filter(l => l.trim());
  const body = lines.slice(1).join(" ").trim();
  return body.length > 140 ? body.slice(0, 140).trimEnd() + "…" : body;
}

function openingLine(content) {
  const lines = stripHtml(content || "").trim().split("\n").filter(l => l.trim());
  const body = lines.slice(1).join(" ").trim();
  if (!body) return "";
  const m = body.match(/^(.{20,160}?[.!?])(?:\s|$)/);
  if (m) return m[1];
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
    .select("id, content, updated_at, total_writing_secs, revision_count, keystrokes, deletions, pastes, human_score, score_tier, score_features");
  if (error || !data) return [];
  return data.map(r => ({
    id: r.id,
    content: r.content,
    updatedAt: new Date(r.updated_at).getTime(),
    writingTimeSecs: r.total_writing_secs ?? 0,
    revisionCount: r.revision_count ?? 0,
    keystrokes: r.keystrokes ?? 0,
    deletions: r.deletions ?? 0,
    pastes: r.pastes ?? 0,
    humanScore: r.human_score,
    scoreTier: r.score_tier,
    scoreFeatures: r.score_features || null,
  }));
}

async function pushDocToCloud(doc, userId) {
  if (!supabase || !userId) return;
  await supabase.from("documents").upsert({
    id: doc.id, user_id: userId,
    content: doc.content,
    updated_at: new Date(doc.updatedAt).toISOString(),
    total_writing_secs: doc.writingTimeSecs || 0,
    revision_count:     doc.revisionCount  || 0,
    keystrokes:         doc.keystrokes     || 0,
    deletions:          doc.deletions      || 0,
    pastes:             doc.pastes         || 0,
    human_score:        doc.humanScore     ?? null,
    score_tier:         doc.scoreTier      ?? null,
    score_features:     doc.scoreFeatures  ?? null,
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

const PUB_SELECT = "id, title, content, published_at, author_name, author_username, user_id, writing_time_seconds, revision_count, human_score, score_tier, score_features, keystrokes, deletions, pastes";

async function fetchFeed() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("publications")
    .select(PUB_SELECT)
    .order("published_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data;
}

async function fetchMyPublications(userId) {
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from("publications")
    .select("id, doc_id, " + PUB_SELECT.replace(/^id, /, ""))
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
    keystrokes:     doc.keystrokes     || 0,
    deletions:      doc.deletions      || 0,
    pastes:         doc.pastes         || 0,
    human_score:    doc.humanScore     ?? null,
    score_tier:     doc.scoreTier      ?? null,
    score_features: doc.scoreFeatures  ?? null,
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
    .from("profiles").select("id, username, display_name, avatar_data").eq("id", userId).maybeSingle();
  return data || null;
}

async function upsertProfile(userId, username, displayName) {
  if (!supabase || !userId) return "Not signed in.";
  const { error } = await supabase
    .from("profiles").upsert({ id: userId, username, display_name: displayName || null });
  return error ? error.message : null;
}

async function updateAvatar(userId, avatarData) {
  if (!supabase || !userId) return "Not signed in.";
  const { error } = await supabase
    .from("profiles").update({ avatar_data: avatarData }).eq("id", userId);
  return error ? error.message : null;
}

async function fetchPublicationById(id) {
  if (!supabase || !id) return null;
  const { data } = await supabase
    .from("publications")
    .select(PUB_SELECT)
    .eq("id", id).maybeSingle();
  return data || null;
}

async function fetchProfileByUsername(username) {
  if (!supabase || !username) return null;
  const { data } = await supabase
    .from("profiles").select("id, username, display_name, avatar_data")
    .eq("username", username).maybeSingle();
  return data || null;
}

function viewToPath(view, pub, userProfile) {
  if (view === "feed")        return "/feed";
  if (view === "search")      return "/people";
  if (view === "profile")     return "/profile";
  if (view === "reading" && pub)          return `/read/${pub.id}`;
  if (view === "userProfile" && userProfile) return `/u/${userProfile.username}`;
  return "/";
}

function pathToView(path) {
  if (path.startsWith("/read/"))  return "reading";
  if (path.startsWith("/u/"))     return "userProfile";
  if (path === "/feed")   return "feed";
  if (path === "/people") return "search";
  if (path === "/profile") return "profile";
  return "editor";
}

async function searchProfiles(query) {
  if (!supabase || !query.trim()) return [];
  const q = query.trim();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, display_name, avatar_data")
    .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
    .limit(20);
  if (error || !data) return [];
  return data;
}

async function fetchUserPublications(userId) {
  if (!supabase || !userId) return [];
  const { data, error } = await supabase
    .from("publications")
    .select(PUB_SELECT)
    .eq("user_id", userId)
    .order("published_at", { ascending: false });
  if (error || !data) return [];
  return data;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

// ─── DropCapAvatar ────────────────────────────────────────────────────────────

function DropCapAvatar({ letter, avatarData, dropCapImages, size = 36 }) {
  const [imgErr, setImgErr] = useState(false);
  const src = !imgErr ? dropCapSrc(letter, dropCapImages) : null;
  const circleStyle = {
    width: size, height: size, borderRadius: "50%", overflow: "hidden",
    flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
  };
  if (avatarData) {
    return (
      <div style={circleStyle}>
        <img src={avatarData} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  if (src) {
    return (
      <div style={{ ...circleStyle, background: "#f0ece6" }}>
        <img src={src} alt={letter?.toUpperCase()} onError={() => setImgErr(true)}
          style={{ width: "72%", height: "72%", objectFit: "contain" }} />
      </div>
    );
  }
  return (
    <div style={{ ...circleStyle, background: "var(--text)", color: "var(--bg)",
      fontFamily: '"Cormorant Garamond", serif', fontSize: size * 0.44 }}>
      {(letter || "?").toUpperCase()}
    </div>
  );
}

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

// ─── Build a score-shape from publication/document record fields ─────────────

function scoreFromRecord(rec) {
  if (!rec) return null;
  // Prefer the new schema fields if present.
  if (rec.human_score != null && rec.score_tier) {
    return {
      score: rec.human_score,
      tier:  rec.score_tier,
      confidence: 1,
      contributors: rec.score_features?.contributors || [],
      paste_ratio: rec.score_features?.paste_ratio || 0,
    };
  }
  // Legacy fallback for older publications (writing_time_seconds + revision_count).
  const wt = rec.writing_time_seconds || 0;
  const rv = rec.revision_count || 0;
  if (!wt && !rv) return null;
  let tier = "Faint";
  if (wt >= 480 || rv >= 5)      tier = "Strong";
  else if (wt >= 90 || rv >= 2)  tier = "Developing";
  const score = Math.min(100, Math.round((Math.min(wt, 600) / 600) * 60 + Math.min(rv, 10) * 4));
  return { score, tier, confidence: 0.5, contributors: [], paste_ratio: 0, legacy: true };
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
  const rawTitle  = doc.title || docTitle(doc.content);
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

function Feed({ onRead, onHsModal, onAuthorClick, dropCapImages }) {
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
        {pubs.map((pub, i) => {
          const hook = openingLine(pub.content);
          const avatarLetter = pub.author_name?.[0] || "?";
          return (
            <article key={pub.id} className="pub-card" style={{ "--card-index": i }} onClick={() => onRead(pub)}>
              <div className="pub-card-meta">
                <DropCapAvatar letter={avatarLetter} avatarData={pub.avatar_data} dropCapImages={dropCapImages} size={22} />
                <button className="pub-author-btn" onClick={e => { e.stopPropagation(); if (pub.user_id) onAuthorClick(pub.user_id); }}>
                  {pub.author_name}
                </button>
                <span className="pub-dot">·</span>
                <span className="pub-date">{formatDate(pub.published_at)}</span>
                <span className="pub-dot">·</span>
                <span className="pub-read-time">{readingTime(pub.content)}</span>
              </div>
              <h2 className="pub-card-title">{pub.title}</h2>
              {hook && <p className="pub-card-opening">{hook}</p>}
              {(() => {
                const sc = scoreFromRecord(pub);
                return sc
                  ? <HumanSignalBadge score={sc} />
                  : <span className="pub-card-words">{wordCount(pub.content)} words</span>;
              })()}
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ─── Profile ──────────────────────────────────────────────────────────────────

function Profile({ user, profile, localDocs, streak, dropCapImages, onRead, onUnpublish, onSignIn, onSignOut, onAvatarChange, researchOptIn, onToggleOptIn, onDownloadData, onDeleteData }) {
  const [pubs, setPubs]           = useState([]);
  const [loading, setLoading]     = useState(!!user);
  const [uploading, setUploading] = useState(false);
  const [optBusy, setOptBusy]     = useState(false);
  const [delBusy, setDelBusy]     = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const fileInputRef              = useRef(null);

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

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const data = await compressAvatar(file);
    await onAvatarChange(data);
    setUploading(false);
    e.target.value = "";
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
  const avatarLetter = profile?.username?.[0] || user.email[0];

  return (
    <div id="profile-container">
      <div id="profile-header">
        <div id="profile-avatar-wrap">
          <DropCapAvatar letter={avatarLetter} avatarData={profile?.avatar_data} dropCapImages={dropCapImages} size={44} />
          <button id="avatar-upload-btn" onClick={() => fileInputRef.current?.click()} title="Change photo">
            {uploading ? "…" : "✎"}
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFileChange} />
        </div>
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
            {(() => {
              const sc = scoreFromRecord(pub);
              return sc
                ? <HumanSignalBadge score={sc} />
                : <span className="pub-card-words">{wordCount(pub.content)} words</span>;
            })()}
          </article>
        ))}
      </div>

      <div id="research-section">
        <div id="research-head">
          <div id="research-title">Research mode</div>
          <p id="research-blurb">
            Inkk is studying how humans write — the rhythm, pauses, and revisions behind a piece of text.
            Opt in to share your anonymised writing patterns (never your text characters for letters or digits) with the research dataset.
          </p>
          <label className="research-toggle">
            <input
              type="checkbox"
              checked={!!researchOptIn}
              disabled={optBusy}
              onChange={async (e) => {
                setOptBusy(true);
                await onToggleOptIn(e.target.checked);
                setOptBusy(false);
              }}
            />
            <span className="research-toggle-track" aria-hidden="true"><span className="research-toggle-thumb" /></span>
            <span className="research-toggle-label">{researchOptIn ? "Participating" : "Not participating"}</span>
          </label>
        </div>
        {researchOptIn && (
          <div id="research-controls">
            <button className="research-btn" onClick={onDownloadData}>Download my data</button>
            {!confirmDel ? (
              <button className="research-btn research-btn-danger" onClick={() => setConfirmDel(true)}>Delete my data</button>
            ) : (
              <div className="research-confirm">
                <span>Delete all your captured writing-process data?</span>
                <button className="research-btn" onClick={() => setConfirmDel(false)}>Cancel</button>
                <button
                  className="research-btn research-btn-danger"
                  disabled={delBusy}
                  onClick={async () => { setDelBusy(true); await onDeleteData(); setDelBusy(false); setConfirmDel(false); }}
                >{delBusy ? "Deleting…" : "Yes, delete"}</button>
              </div>
            )}
          </div>
        )}
      </div>

      <button id="signout-btn" onClick={onSignOut}>Sign out</button>
    </div>
  );
}

// ─── SearchView ───────────────────────────────────────────────────────────────

function SearchView({ onViewUser, dropCapImages }) {
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
            <DropCapAvatar letter={p.username?.[0]} avatarData={p.avatar_data} dropCapImages={dropCapImages} size={38} />
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

function UserProfileView({ profile, onRead, dropCapImages }) {
  const [pubs, setPubs]       = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUserPublications(profile.id).then(data => { setPubs(data); setLoading(false); });
  }, [profile.id]);

  return (
    <div id="user-profile-container">
      <div id="user-profile-header">
        <DropCapAvatar letter={profile.username?.[0]} avatarData={profile.avatar_data} dropCapImages={dropCapImages} size={44} />
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
            {(() => {
              const sc = scoreFromRecord(pub);
              return sc ? <HumanSignalBadge score={sc} /> : null;
            })()}
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
  const pubScore = scoreFromRecord(pub);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 0 ? el.scrollTop / max : 0);
  }, []);

  const copyText = useCallback(() => {
    navigator.clipboard.writeText(pub.title + "\n\n" + stripHtml(pub.content)).then(() => {
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
          {pubScore && <HumanSignalBadge score={pubScore} />}
          <div id="reading-text" className={font === "arial" ? "font-arial" : ""} dangerouslySetInnerHTML={{ __html: renderHtml(pub.content) }} />
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
  const [view, setView]               = useState(() => pathToView(window.location.pathname));
  const [readingPub, setReadingPub]   = useState(null);
  const [publishedDocIds, setPublishedDocIds] = useState(new Set());
  const [publishModalDoc, setPublishModalDoc] = useState(null);
  const [font, setFont]               = useState(() => localStorage.getItem("inkk_font") || "garamond");
  const [showLanding, setShowLanding] = useState(() => !localStorage.getItem("inkk_visited"));
  const [hsModalOpen, setHsModalOpen] = useState(false);
  const [streak, setStreak]           = useState(() => loadStreak().count);
  const [toasts, setToasts]           = useState([]);
  const [focusMode, setFocusMode]     = useState(false);
  const [publishMenuOpen, setPublishMenuOpen] = useState(false);
  const [showTitleInput, setShowTitleInput] = useState(() => !!initDocs.find(d => d.id === initActiveId)?.title);
  const [profile, setProfile]         = useState(null);
  const [dropCapImages, setDropCapImages] = useState({});
  const [usernameModalOpen, setUsernameModalOpen] = useState(false);
  const [viewingUser, setViewingUser] = useState(null);
  const [liveScore, setLiveScore]     = useState(() => {
    const d = initDocs.find(x => x.id === initActiveId);
    if (!d?.humanScore || !d?.scoreTier) return null;
    return {
      score: d.humanScore, tier: d.scoreTier,
      confidence: d.scoreFeatures?.confidence ?? 0.5,
      contributors: d.scoreFeatures?.contributors || [],
      paste_ratio: d.scoreFeatures?.paste_ratio || 0,
    };
  });
  const [hsPanelOpen, setHsPanelOpen] = useState(false);
  const [researchOptIn, setResearchOptIn] = useState(false);

  const editorRef      = useRef(null);
  const titleEditorRef = useRef(null);
  const containerRef   = useRef(null);
  const contentRef     = useRef("");
  const titleRef       = useRef("");
  const isMobileRef  = useRef(false);
  const mountedRef   = useRef(false);
  const idleTimerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const rafRef       = useRef(null);
  const userRef      = useRef(null);

  const writingBaseRef         = useRef(initDocs.find(d => d.id === initActiveId)?.writingTimeSecs || 0);
  const writingSessionStartRef = useRef(null);
  const writingFlushRef        = useRef(0);
  const saveHintShownRef       = useRef(!!localStorage.getItem("inkk_save_hint"));
  const docsRef                = useRef(initDocs);
  const profileRef             = useRef(null);
  const syncedUserRef          = useRef(null);
  const recorderRef            = useRef(null);
  const activeIdRef            = useRef(initActiveId);
  const optInRef               = useRef(false);
  const scoreTimerRef          = useRef(null);

  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => { docsRef.current = docs; }, [docs]);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { optInRef.current = researchOptIn; }, [researchOptIn]);
  useEffect(() => { localStorage.setItem("inkk_font", font); }, [font]);
  useEffect(() => {
    fetch("/drop_caps/manifest.json").then(r => r.json()).then(setDropCapImages).catch(() => {});
  }, []);

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

  // ─── score recompute (debounced) ──────────────────────────────────────────
  const recomputeScore = useCallback(() => {
    const docId = activeIdRef.current;
    if (!docId) return;
    const rec = recorderRef.current;
    if (!rec) return;
    const { events } = rec.snapshot(docId);
    if (events.length < 8) return;        // very early — don't touch existing score
    const words = wordCount(contentRef.current || "");
    const features = extractFeatures(events, { words });
    const score = computeScore(features);

    // Don't overwrite a previously-persisted high-confidence score with a
    // low-confidence one (happens briefly after page reload before enough
    // post-reload telemetry has accumulated).
    const prevDoc = docsRef.current.find(d => d.id === docId);
    const prevConf = prevDoc?.scoreFeatures?.confidence ?? 0;
    if (prevDoc?.humanScore != null && score.confidence + 0.1 < prevConf) {
      return;
    }

    setLiveScore({
      score: score.score,
      tier: score.tier,
      confidence: score.confidence,
      contributors: score.contributors,
      paste_ratio: score.paste_ratio,
    });

    // Persist denormalised score + features to the active doc.
    let nextDoc = null;
    setDocs(prev => {
      const next = prev.map(d => d.id !== docId ? d : ({
        ...d,
        humanScore: score.score,
        scoreTier:  score.tier,
        keystrokes: features.typing_events,
        deletions:  features.deletion_events,
        pastes:     features.paste_events,
        revisionCount: features.mid_revisions + features.typo_corrections,
        scoreFeatures: {
          confidence: score.confidence,
          contributors: score.contributors,
          paste_ratio: score.paste_ratio,
          iki_cv: features.iki?.cv ?? 0,
          dwell_std: features.dwell?.std ?? 0,
          burst_count: features.burst_count,
          mid_revisions: features.mid_revisions,
          typo_corrections: features.typo_corrections,
          pause_count_500: features.pause_count_500,
        },
      }));
      nextDoc = next.find(d => d.id === docId);
      saveState(next, docId);
      return next;
    });
    // Debounced cloud push (the save-timer also pushes content; here we push score too).
    if (userRef.current && nextDoc) pushDocToCloud(nextDoc, userRef.current.id);
  }, []);

  const scheduleRecompute = useCallback(() => {
    if (scoreTimerRef.current) clearTimeout(scoreTimerRef.current);
    scoreTimerRef.current = setTimeout(recomputeScore, 700);
  }, [recomputeScore]);

  // ─── recorder lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    const rec = createRecorder({
      getContext: () => ({
        userId: userRef.current?.id || null,
        docId:  activeIdRef.current || null,
        optedIn: !!optInRef.current,
      }),
      onUpdate: () => scheduleRecompute(),
    });
    recorderRef.current = rec;
    if (editorRef.current) rec.attach(editorRef.current);
    return () => {
      if (scoreTimerRef.current) clearTimeout(scoreTimerRef.current);
      rec.detach();
    };
  }, [scheduleRecompute]);

  // ─── cloud event sync ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!supabase) return;
    startSync({
      supabase,
      getContext: () => ({
        userId:  userRef.current?.id || null,
        optedIn: !!optInRef.current,
      }),
    });
    return () => stopSync();
  }, []);

  const handleAvatarChange = useCallback(async (avatarData) => {
    if (!userRef.current) return;
    const err = await updateAvatar(userRef.current.id, avatarData);
    if (!err) {
      setProfile(prev => prev ? { ...prev, avatar_data: avatarData } : prev);
      addToast("Profile picture updated.");
    } else {
      addToast("Could not save picture.");
    }
  }, [addToast]);

  const navigate = useCallback((newView, opts = {}) => {
    const { pub, userProfile } = opts;
    const url = viewToPath(newView, pub, userProfile);
    if (window.location.pathname !== url)
      window.history.pushState({ view: newView, pubId: pub?.id, username: userProfile?.username }, "", url);
    setView(newView);
    if (pub       !== undefined) setReadingPub(pub);
    if (userProfile !== undefined) setViewingUser(userProfile);
  }, []);

  useEffect(() => {
    const handler = async (e) => {
      const s = e.state || {};
      const newView = s.view || "editor";
      setView(newView);
      if (newView !== "reading")     setReadingPub(null);
      if (newView !== "userProfile") setViewingUser(null);
      if (newView === "reading" && s.pubId) {
        const pub = await fetchPublicationById(s.pubId);
        if (pub) setReadingPub(pub);
      }
      if (newView === "userProfile" && s.username) {
        const prof = await fetchProfileByUsername(s.username);
        if (prof) setViewingUser(prof);
      }
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const IDLE_MS = 1200;

  // ─ load doc into DOM ────────────────────────────────────────────────────────

  const loadDocIntoEditor = useCallback((doc) => {
    const el = editorRef.current;
    if (!el) return;
    titleRef.current = doc.title || "";
    if (titleEditorRef.current) titleEditorRef.current.value = doc.title || "";
    contentRef.current = doc.content;
    setEditorHtml(el, doc.content);
    setWords(wordCount(doc.content));
    writingBaseRef.current = doc.writingTimeSecs || 0;
    writingFlushRef.current = 0;
    writingSessionStartRef.current = null;
    // Restore cached score for this doc if we have one.
    if (doc.humanScore != null && doc.scoreTier) {
      setLiveScore({
        score: doc.humanScore, tier: doc.scoreTier,
        confidence: doc.scoreFeatures?.confidence ?? 0.5,
        contributors: doc.scoreFeatures?.contributors || [],
        paste_ratio: doc.scoreFeatures?.paste_ratio || 0,
      });
    } else {
      setLiveScore(null);
    }
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
      if (syncedUserRef.current === signedInUser.id) return;
      syncedUserRef.current = signedInUser.id;
      setUser(signedInUser); userRef.current = signedInUser; setAuthOpen(false);
      const cloudDocs = await fetchCloudDocs();
      const saved = loadState();
      const localDocs = saved?.docs || [];
      const hasLocalContent = localDocs.some(d => stripHtml(d.content).trim());
      let merged = (hasLocalContent || !cloudDocs.length)
        ? mergeDocs(localDocs, cloudDocs) : cloudDocs;
      if (!merged.length) merged = [createDoc()];
      merged = merged.map(normaliseDoc);
      const cloudIds = new Set(cloudDocs.map(d => d.id));
      for (const doc of merged)
        if (!cloudIds.has(doc.id) && stripHtml(doc.content).trim())
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
      // Load research opt-in flag.
      const opt = await getResearchOptIn(supabase, signedInUser.id);
      optInRef.current = opt;
      setResearchOptIn(opt);
      recorderRef.current?.recordUserChange(signedInUser.id);
      // Claim any pre-signed-in events captured on this device so they sync too.
      claimAnonymousEvents(signedInUser.id);
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) syncOnLogin(session.user);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user) syncOnLogin(session.user);
      if (event === "SIGNED_OUT") {
        syncedUserRef.current = null;
        setUser(null); setPublishedDocIds(new Set()); setProfile(null); setUsernameModalOpen(false);
        setResearchOptIn(false); optInRef.current = false;
        recorderRef.current?.recordUserChange(null);
      }
    });
    return () => subscription.unsubscribe();
  }, [loadDocIntoEditor]);

  // ─ switch document ──────────────────────────────────────────────────────────

  const switchDoc = useCallback((id) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (scoreTimerRef.current) { clearTimeout(scoreTimerRef.current); scoreTimerRef.current = null; }
    let timeToSave = writingBaseRef.current + writingFlushRef.current;
    if (writingSessionStartRef.current !== null) {
      timeToSave += (Date.now() - writingSessionStartRef.current) / 1000;
      writingSessionStartRef.current = null;
    }
    writingFlushRef.current = 0;
    setDocs(prev => {
      const flushed = prev.map(d =>
        d.id === activeId ? { ...d, title: titleRef.current, content: contentRef.current, updatedAt: Date.now(), writingTimeSecs: timeToSave } : d
      );
      saveState(flushed, id);
      return flushed;
    });
    setSaveStatus("saved");
    recorderRef.current?.recordDocSwitch(id);
    setActiveId(id);
    // Hydrate liveScore from the target doc immediately.
    const target = docsRef.current.find(d => d.id === id);
    if (target?.humanScore != null && target?.scoreTier) {
      setLiveScore({
        score: target.humanScore, tier: target.scoreTier,
        confidence: target.scoreFeatures?.confidence ?? 0.5,
        contributors: target.scoreFeatures?.contributors || [],
        paste_ratio:  target.scoreFeatures?.paste_ratio || 0,
      });
    } else {
      setLiveScore(null);
    }
    setPanelOpen(false);
  }, [activeId]);

  useEffect(() => {
    if (!mountedRef.current) return;
    const doc = docs.find(d => d.id === activeId);
    if (doc) { loadDocIntoEditor(doc); setShowTitleInput(!!doc.title); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ─ new / delete ─────────────────────────────────────────────────────────────

  const newDoc = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (scoreTimerRef.current) { clearTimeout(scoreTimerRef.current); scoreTimerRef.current = null; }
    let timeToSave = writingBaseRef.current + writingFlushRef.current;
    if (writingSessionStartRef.current !== null) {
      timeToSave += (Date.now() - writingSessionStartRef.current) / 1000;
      writingSessionStartRef.current = null;
    }
    writingFlushRef.current = 0;
    const doc = createDoc();
    setDocs(prev => {
      const flushed = prev.map(d =>
        d.id === activeId ? { ...d, title: titleRef.current, content: contentRef.current, updatedAt: Date.now(), writingTimeSecs: timeToSave } : d
      );
      const next = [...flushed, doc];
      saveState(next, doc.id);
      return next;
    });
    recorderRef.current?.recordDocSwitch(doc.id);
    setActiveId(doc.id);
    setLiveScore(null);
    setPanelOpen(false);
  }, [activeId]);

  const deleteDoc = useCallback((id, e) => {
    e.stopPropagation();
    if (userRef.current) deleteDocFromCloud(id);
    setDocs(prev => {
      if (prev.length === 1) {
        const fresh = createDoc();
        saveState([fresh], fresh.id);
        recorderRef.current?.recordDocSwitch(fresh.id);
        setActiveId(fresh.id);
        setLiveScore(null);
        return [fresh];
      }
      const next = prev.filter(d => d.id !== id);
      const newActive = id === activeId ? next[0].id : activeId;
      if (id === activeId) {
        if (scoreTimerRef.current) { clearTimeout(scoreTimerRef.current); scoreTimerRef.current = null; }
        recorderRef.current?.recordDocSwitch(newActive);
        setActiveId(newActive);
        const target = next.find(d => d.id === newActive);
        if (target?.humanScore != null && target?.scoreTier) {
          setLiveScore({
            score: target.humanScore, tier: target.scoreTier,
            confidence: target.scoreFeatures?.confidence ?? 0.5,
            contributors: target.scoreFeatures?.contributors || [],
            paste_ratio:  target.scoreFeatures?.paste_ratio || 0,
          });
        } else setLiveScore(null);
      }
      saveState(next, newActive);
      return next;
    });
  }, [activeId]);

  // ─ publish ──────────────────────────────────────────────────────────────────

  const openPublishModal = useCallback((doc, e) => {
    if (e) e.stopPropagation();
    if (!userRef.current) { setAuthOpen(true); return; }
    const content = doc.id === activeId ? contentRef.current : doc.content;
    if (!stripHtml(content || "").trim()) return;
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

  const openUserProfile = useCallback(async (userIdOrProfile) => {
    const prof = typeof userIdOrProfile === "string"
      ? await fetchProfile(userIdOrProfile)
      : userIdOrProfile;
    if (!prof) { addToast("This writer hasn't set up their profile."); return; }
    navigate("userProfile", { userProfile: prof });
  }, [navigate, addToast]);

  // ─ sign out ─────────────────────────────────────────────────────────────────

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    addToast("Signed out.");
  }, [addToast]);

  // ─ research mode controls ──────────────────────────────────────────────────

  const toggleResearchOptIn = useCallback(async (next) => {
    if (!supabase || !userRef.current) { addToast("Sign in first."); return; }
    const err = await remoteSetResearchOptIn(supabase, userRef.current.id, next);
    if (err) { addToast("Could not update."); return; }
    optInRef.current = next;
    setResearchOptIn(next);
    addToast(next ? "Joined the research study." : "Left the study.");
  }, [addToast]);

  const downloadResearchData = useCallback(async () => {
    if (!supabase || !userRef.current) return;
    const data = await dumpMyEvents(supabase, userRef.current.id);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = `inkk-writing-events-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    addToast(`Downloaded ${data.length} events.`);
  }, [addToast]);

  const deleteResearchData = useCallback(async () => {
    if (!supabase || !userRef.current) return;
    const err = await deleteMyEvents(supabase);
    if (err) addToast("Could not delete.");
    else addToast("Research data deleted.");
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
    const fullContent = el.innerHTML;
    contentRef.current = fullContent;
    setWords(wordCount(fullContent));
    setMenuVisible(false);

    if (writingSessionStartRef.current === null) writingSessionStartRef.current = Date.now();

    scheduleMenuReturn();
    scrollToCursor();
    setSaveStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    const capturedId = activeId;
    const capturedContent = contentRef.current;
    const capturedTitle = titleRef.current;
    saveTimerRef.current = setTimeout(() => {
      const capturedUpdatedAt = Date.now();
      const capturedTime = writingBaseRef.current + writingFlushRef.current +
        (writingSessionStartRef.current !== null ? (Date.now() - writingSessionStartRef.current) / 1000 : 0);
      setDocs(prev => {
        const next = prev.map(d =>
          d.id === capturedId
            ? { ...d, title: capturedTitle, content: capturedContent, updatedAt: capturedUpdatedAt, writingTimeSecs: capturedTime }
            : d
        );
        saveState(next, capturedId);
        return next;
      });
      if (stripHtml(capturedContent).trim()) {
        const newStreak = touchStreak();
        setStreak(newStreak);
      }
      if (userRef.current)
        pushDocToCloud({ id: capturedId, content: capturedContent, updatedAt: capturedUpdatedAt }, userRef.current.id);
      setSaveStatus("saved");
    }, 500);
  }, [activeId, scheduleMenuReturn, scrollToCursor, addToast]);

  const onTitleInput = useCallback(() => {
    const el = titleEditorRef.current;
    if (!el) return;
    titleRef.current = el.value;
    setSaveStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const capturedId = activeId;
    const capturedTitle = el.value;
    saveTimerRef.current = setTimeout(() => {
      const capturedUpdatedAt = Date.now();
      setDocs(prev => {
        const next = prev.map(d =>
          d.id === capturedId ? { ...d, title: capturedTitle, updatedAt: capturedUpdatedAt } : d
        );
        saveState(next, capturedId);
        return next;
      });
      setSaveStatus("saved");
    }, 500);
  }, [activeId]);


  const handleEditorDrop = useCallback(async (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    const range = caretRangeAt(e.clientX, e.clientY);
    for (const file of files) {
      const src = await compressImage(file);
      const img = document.createElement("img");
      img.src = src;
      if (range) { range.insertNode(img); range.collapse(false); }
      else { editorRef.current?.appendChild(img); }
    }
    onInput();
  }, [onInput]);

  const handleEditorPaste = useCallback(async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find(item => item.type.startsWith("image/"));
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) return;
      const src = await compressImage(file);
      const img = document.createElement("img");
      img.src = src;
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(img);
        range.collapse(false);
      } else {
        editorRef.current?.appendChild(img);
      }
      onInput();
      return;
    }
    // Strip formatting on paste — insert as plain text only
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") || "";
    if (text) document.execCommand("insertText", false, text);
  }, [onInput]);

  // ─ PDF export ───────────────────────────────────────────────────────────────

  const exportToPdf = useCallback(async () => {
    const text = contentRef.current || "";
    if (!stripHtml(text).trim()) return;
    try {

    // metadata
    const sourceDoc = docsRef.current.find(d => d.id === activeId);
    const prof      = profileRef.current;
    const u         = userRef.current;
    const titleStr  = titleRef.current.trim() || docTitle(text);
    const authorStr = prof?.username
      ? `@${prof.username}`
      : (u?.user_metadata?.full_name || u?.email?.split("@")[0] || "");
    const dateStr   = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const wtSecs    = sourceDoc?.writingTimeSecs || 0;
    const docScore  = (sourceDoc?.humanScore != null && sourceDoc?.scoreTier)
      ? { score: sourceDoc.humanScore, tier: sourceDoc.scoreTier } : null;
    const hasHS     = !!docScore || wtSecs > 0;

    // page geometry
    const pdf = new jsPDF({ unit: "pt", format: "a4" });
    const b64 = await fetchBase64(cormorantTTF);
    pdf.addFileToVFS("CormorantGaramond-Regular.ttf", b64);
    pdf.addFont("CormorantGaramond-Regular.ttf", "CormorantGaramond", "normal");
    pdf.setFont("CormorantGaramond", "normal");

    const pW = pdf.internal.pageSize.getWidth();   // 595.28
    const pH = pdf.internal.pageSize.getHeight();  // 841.89
    const mx = 88;
    const tW = pW - mx * 2;                        // 419.28

    const bodyBottom = pH - 64;
    const footerY    = pH - 34;

    const C_BLACK = [26,  26,  26];
    const C_MUTED = [140, 137, 133];
    const C_FAINT = [185, 183, 179];
    const C_RULE  = [210, 208, 204];

    const setC = (rgb) => pdf.setTextColor(rgb[0], rgb[1], rgb[2]);

    let pageNum = 1;
    const drawFooter = () => {
      pdf.setFont("CormorantGaramond", "normal");
      pdf.setFontSize(8);
      setC(C_FAINT);
      pdf.text("inkk.", mx, footerY);
      pdf.text(String(pageNum), pW / 2, footerY, { align: "center" });
      pageNum++;
    };
    const newPage = () => {
      drawFooter();
      pdf.addPage();
      pdf.setFont("CormorantGaramond", "normal");
    };

    // ── title block ──────────────────────────────────────────────────────────
    let y = 108;

    pdf.setFontSize(23);
    setC(C_BLACK);
    const titleLines = pdf.splitTextToSize(titleStr, tW);
    for (const ln of titleLines) {
      pdf.text(ln, pW / 2, y, { align: "center" });
      y += 31;
    }
    y += 8;

    // byline: author · date
    pdf.setFontSize(9);
    setC(C_MUTED);
    const byline = [authorStr, dateStr].filter(Boolean).join("  ·  ");
    if (byline) { pdf.text(byline, pW / 2, y, { align: "center" }); y += 16; }

    // human signal
    if (hasHS) {
      pdf.setFontSize(8);
      setC(C_FAINT);
      const tier = tierFromScore(docScore);
      const scoreStr = docScore?.score != null ? `  ·  ${docScore.score}/100` : "";
      const hs = `Human Signal: ${tier}${scoreStr}  ·  ${formatWritingTime(wtSecs)}  ·  ${wordCount(text)} words`;
      pdf.text(hs, pW / 2, y, { align: "center" });
      y += 14;
    }

    // rule
    y += 16;
    pdf.setLineWidth(0.3);
    pdf.setDrawColor(C_RULE[0], C_RULE[1], C_RULE[2]);
    pdf.line(mx, y, pW - mx, y);
    y += 32;

    // ── body ─────────────────────────────────────────────────────────────────
    const BFS = 12, LH = 18, PGAP = 12;
    pdf.setFontSize(BFS);
    setC(C_BLACK);

    // if using the old first-line-as-title pattern, strip it from body
    const bodyText  = stripHtml(text).trim();
    const bodyParas = bodyText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

    const renderLines = (lines, startX) => {
      for (const ln of lines) {
        if (y > bodyBottom) { newPage(); y = 72; pdf.setFontSize(BFS); setC(C_BLACK); }
        if (ln.trim()) pdf.text(ln, startX, y);
        y += LH;
      }
    };

    for (let pi = 0; pi < bodyParas.length; pi++) {
      const para = bodyParas[pi];

      const lines = para.split("\n").flatMap(r => pdf.splitTextToSize(r || " ", tW));
      renderLines(lines, mx);

      if (pi < bodyParas.length - 1) y += PGAP;
    }

    drawFooter();
    pdf.save(`${titleStr.replace(/[^a-zA-Z0-9\s\-_]/g, "").trim() || "inkk"}.pdf`);
    } catch (err) {
      console.error("PDF export failed:", err);
      addToast("PDF export failed.");
    }
  }, [activeId, addToast]);

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
        if (view !== "editor") { window.history.back(); return; }
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
      titleRef.current = doc.title || "";
      contentRef.current = doc.content;
      writingBaseRef.current = doc.writingTimeSecs || 0;
      if (titleEditorRef.current) titleEditorRef.current.value = doc.title || "";
      setShowTitleInput(!!doc.title);
      const el = editorRef.current;
      if (el) {
        setEditorHtml(el, doc.content);
        if (!isMobileRef.current && localStorage.getItem("inkk_visited")) el.focus();
      }
    }
    // Establish initial history state so popstate can always restore view
    const initPath = window.location.pathname;
    const initView = pathToView(initPath);
    // Preserve hash — Supabase reads #access_token from it during OAuth callback
    const initUrl = initPath + window.location.search + window.location.hash;
    window.history.replaceState({ view: initView, pubId: initPath.startsWith("/read/") ? initPath.slice(6) : undefined, username: initPath.startsWith("/u/") ? initPath.slice(3) : undefined }, "", initUrl);
    // If landing directly on a reading or user-profile URL, load the data
    if (initView === "reading") {
      const pubId = initPath.slice(6);
      fetchPublicationById(pubId).then(pub => { if (pub) setReadingPub(pub); });
    }
    if (initView === "userProfile") {
      const username = initPath.slice(3);
      fetchProfileByUsername(username).then(prof => { if (prof) setViewingUser(prof); });
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

  const sortedDocs   = [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
  const hasContent   = words > 0;
  const isPublished  = publishedDocIds.has(activeId);

  const openReading = useCallback((pub) => {
    navigate("reading", { pub });
  }, [navigate]);

  const goBack = useCallback(() => {
    window.history.back();
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
          <span id="brand" onClick={() => navigate("editor")} style={{ cursor: view === "editor" ? "default" : "pointer" }}>inkk.</span>
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
          {isEditor && hasContent && (
            <button id="pdf-btn" className={menuClass} onClick={exportToPdf} title="Export PDF  ⌘S">
              <Download size={13} />
              <span className="btn-label">PDF</span>
            </button>
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
                  <span className="doc-item-title">{d.title || docTitle(d.content)}</span>
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

      {/* ── human signal indicator (editor) ── */}
      {isEditor && hasContent && (
        <div id="hs-editor-status" className={menuClass}>
          <HumanSignalLine
            score={liveScore}
            words={words}
            saveStatus={saveStatus}
            onClick={() => setHsPanelOpen(true)}
          />
        </div>
      )}
      {hsPanelOpen && <HumanSignalPanel score={liveScore} onClose={() => setHsPanelOpen(false)} />}

      {/* ── editor (always mounted) ── */}
      <div
        id="text-container"
        ref={containerRef}
        style={{ display: isEditor ? "" : "none" }}
      >
        {showTitleInput ? (
          <input
            id="title-input"
            ref={titleEditorRef}
            type="text"
            placeholder="Title"
            className={font === "arial" ? "font-arial" : ""}
            onInput={onTitleInput}
            onBlur={() => { if (!titleRef.current.trim()) { titleRef.current = ""; setShowTitleInput(false); } }}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); editorRef.current?.focus(); } }}
          />
        ) : (
          <button
            id="add-title-btn"
            className={menuClass}
            onClick={() => { setShowTitleInput(true); setTimeout(() => titleEditorRef.current?.focus(), 20); }}
          >
            add title
          </button>
        )}
        <div id="writing-area">
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
            onDrop={handleEditorDrop}
            onDragOver={e => { if (Array.from(e.dataTransfer?.items || []).some(i => i.type.startsWith("image/"))) e.preventDefault(); }}
            onPaste={handleEditorPaste}
          />
        </div>
      </div>

      {/* ── views ── */}
      {view === "feed" && (
        <Feed
          onRead={openReading}
          onHsModal={() => setHsModalOpen(true)}
          onAuthorClick={openUserProfile}
          dropCapImages={dropCapImages}
        />
      )}
      {view === "profile" && (
        <Profile
          user={user}
          profile={profile}
          localDocs={docs}
          streak={streak}
          dropCapImages={dropCapImages}
          onRead={openReading}
          onUnpublish={docId => setPublishedDocIds(prev => { const s = new Set(prev); s.delete(docId); return s; })}
          onSignIn={() => setAuthOpen(true)}
          onSignOut={signOut}
          onAvatarChange={handleAvatarChange}
          researchOptIn={researchOptIn}
          onToggleOptIn={toggleResearchOptIn}
          onDownloadData={downloadResearchData}
          onDeleteData={deleteResearchData}
        />
      )}
      {view === "search" && (
        <SearchView onViewUser={openUserProfile} dropCapImages={dropCapImages} />
      )}
      {view === "userProfile" && viewingUser && (
        <UserProfileView profile={viewingUser} onRead={openReading} dropCapImages={dropCapImages} />
      )}
      {view === "reading" && readingPub && <ReadingView pub={readingPub} font={font} />}

      {/* ── bottom nav ── */}
      {view !== "reading" && view !== "userProfile" && (
        <nav id="bottom-nav" className={isEditor ? menuClass : ""}>
          <button className={`nav-tab ${isEditor ? "active" : ""}`} onClick={() => navigate("editor")}>
            <PenLine size={18} strokeWidth={1.75} />
            <span className="nav-label">Write</span>
          </button>
          <button className={`nav-tab ${view === "feed" ? "active" : ""}`} onClick={() => navigate("feed")}>
            <Globe size={18} strokeWidth={1.75} />
            <span className="nav-label">Feed</span>
          </button>
          <button className={`nav-tab ${view === "search" ? "active" : ""}`} onClick={() => navigate("search")}>
            <Search size={18} strokeWidth={1.75} />
            <span className="nav-label">People</span>
          </button>
          <button
            className={`nav-tab ${view === "profile" ? "active" : ""}`}
            onClick={() => navigate("profile")}
          >
            {user ? (
              <DropCapAvatar
                letter={profile?.username?.[0] || user.email[0]}
                avatarData={profile?.avatar_data}
                dropCapImages={dropCapImages}
                size={22}
              />
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
