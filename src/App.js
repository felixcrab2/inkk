import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/cormorant-garamond/400.css";
import "@fontsource/cormorant-garamond/600.css";
import "@fontsource/cormorant-garamond/400-italic.css";
import "@fontsource/cormorant-garamond/600-italic.css";
import { jsPDF } from "jspdf";
import { supabase } from "./supabase";
import { renderBookPdfPages, PAGE_PRESETS } from "./pdf/bookPage";
import {
  Menu, ArrowLeft, PenLine, Globe, User,
  Share2, Check, Download, Maximize2, Minimize2,
  Copy, CheckCheck, Plus, Trash2, Type, Search,
  Heart, MessageCircle, Eye, EyeOff,
} from "lucide-react";
import { createRecorder } from "./telemetry/recorder";
import { extractFeatures } from "./telemetry/features";
import { computeScore } from "./telemetry/score";
import {
  startSync, stopSync,
  setResearchOptIn as remoteSetResearchOptIn,
  deleteMyEvents, dumpMyEvents,
  flushNow as syncFlushNow,
} from "./telemetry/sync";
import { claimAnonymous as claimAnonymousEvents, clearForUser as clearLocalForUser } from "./telemetry/store";
import { HumanSignalBadge, HumanSignalPanel } from "./components/HumanSignal";
import { PrivacyModal, TermsModal, TOS_VERSION } from "./components/Legal";

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

// In-place smart typography on the contenteditable. Looks at the text around
// the caret and rewrites common ASCII sequences into proper book glyphs.
// Invisible to the user — no toolbar, no shortcuts.
function applySmartTypography() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return;
  const node = range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const offset = range.startOffset;
  const text = node.nodeValue;
  if (!text) return;
  const before = text.slice(0, offset);
  const after  = text.slice(offset);
  const setCaret = (n, off) => { try { sel.collapse(n, off); } catch {} };

  // Auto-list: "- " or "N. " at the very start of a paragraph.
  // Chrome sometimes places a <br> placeholder before the text node in a new
  // div, so we allow that as "first in paragraph" too.
  if (before === "- " || /^\d+\. $/.test(before)) {
    const parent = node.parentElement;
    const prevSib = node.previousSibling;
    const isFirstInPara = !prevSib ||
      (prevSib.nodeType === Node.ELEMENT_NODE && prevSib.tagName === "BR" && !prevSib.previousSibling);
    if (isFirstInPara && parent) {
      let listDiv = null;
      if (parent.id === "text") {
        // Bare text node directly in #text — wrap it in a div first
        const wrapper = document.createElement("div");
        parent.insertBefore(wrapper, node);
        wrapper.appendChild(node);
        listDiv = wrapper;
      } else if (["DIV","P"].includes(parent.tagName) && parent.parentElement?.id === "text") {
        listDiv = parent;
      }
      if (listDiv) {
        // Remove any <br> placeholder that was inside the div
        listDiv.querySelectorAll("br").forEach(br => br.remove());
        if (before === "- ") {
          node.nodeValue = "\u2022 " + after;
          listDiv.setAttribute("data-list", "bullet");
        } else {
          const num = before.match(/^(\d+)\. $/)[1];
          node.nodeValue = num + ". " + after;
          listDiv.setAttribute("data-list", "ordered");
        }
        setCaret(node, before.length);
        return;
      }
    }
  }

  // Em-dash: -- → —
  if (before.endsWith("--")) {
    node.nodeValue = before.slice(0, -2) + "—" + after;
    setCaret(node, offset - 1);
    return;
  }
  // Ellipsis: ... → …
  if (before.endsWith("...")) {
    node.nodeValue = before.slice(0, -3) + "…" + after;
    setCaret(node, offset - 2);
    return;
  }
  // Curly double quote.
  if (before.endsWith('"')) {
    const prev = before.length >= 2 ? before[before.length - 2] : "";
    const opening = !prev || /[\s([{—–]/.test(prev);
    const glyph = opening ? "“" : "”";
    node.nodeValue = before.slice(0, -1) + glyph + after;
    setCaret(node, offset);
    return;
  }
  // Curly single quote / apostrophe.
  if (before.endsWith("'")) {
    const prev = before.length >= 2 ? before[before.length - 2] : "";
    const opening = !prev || /[\s([{—–]/.test(prev);
    const glyph = opening ? "‘" : "’";
    node.nodeValue = before.slice(0, -1) + glyph + after;
    setCaret(node, offset);
    return;
  }
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

function setEditorHtml(el, content) {
  if (!content) { el.innerHTML = ""; return; }
  if (/<(div|br|img|p)\b/i.test(content)) { el.innerHTML = content; }
  else { el.innerText = content; }
}

function setTitleHtml(el, content) {
  if (!content) { el.innerHTML = ""; return; }
  if (/<\w+/.test(content) || /&\w+;/.test(content)) { el.innerHTML = content; }
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

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatWritingTime(secs) {
  if (!secs || secs < 60) return secs ? `${Math.round(secs)}s` : "0s";
  return `${Math.round(secs / 60)} min`;
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
const PUB_SELECT_WITH_COUNTS = PUB_SELECT + ", like_count:likes(count), comment_count:comments(count)";

function getRelCount(rel) {
  if (!rel) return 0;
  if (Array.isArray(rel)) return rel[0]?.count ?? 0;
  return rel?.count ?? 0;
}

// ─── Likes ─────────────────────────────────────────────────────────────────
async function togglePubLike(pubId, userId, currentlyLiked) {
  if (!supabase || !userId) return "Not signed in.";
  if (currentlyLiked) {
    const { error } = await supabase.from("likes").delete().eq("user_id", userId).eq("publication_id", pubId);
    return error?.message || null;
  }
  const { error } = await supabase.from("likes").insert({ user_id: userId, publication_id: pubId });
  return error?.message || null;
}

// ─── Comments ──────────────────────────────────────────────────────────────
async function fetchComments(pubId) {
  if (!supabase || !pubId) return [];
  const { data } = await supabase
    .from("comments")
    .select("id, user_id, body, created_at, updated_at, profiles!user_id(username, display_name, avatar_data)")
    .eq("publication_id", pubId)
    .order("created_at", { ascending: true });
  return data || [];
}

async function addComment(pubId, userId, body) {
  if (!supabase || !userId) return "Not signed in.";
  const trimmed = (body || "").trim();
  if (!trimmed) return "Empty comment.";
  if (trimmed.length > 2000) return "Comment is too long (max 2000 chars).";
  const { error } = await supabase.from("comments").insert({ user_id: userId, publication_id: pubId, body: trimmed });
  return error?.message || null;
}

// ─── Research contribution stats ───────────────────────────────────────────
async function fetchMyContribution(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from("my_writing_event_counts")
    .select("event_count, first_t, last_t")
    .maybeSingle();
  if (error) return null;
  return data || null;
}

async function deleteCommentRow(commentId) {
  if (!supabase || !commentId) return "Not signed in.";
  const { error } = await supabase.from("comments").delete().eq("id", commentId);
  return error?.message || null;
}

// ─── Follows ──────────────────────────────────────────────────────────────────

async function fetchFollowCounts(userId) {
  if (!supabase || !userId) return { followers: 0, following: 0 };
  try {
    const [frs, fng] = await Promise.all([
      supabase.from("follows").select("*", { count: "exact", head: true }).eq("following_id", userId),
      supabase.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", userId),
    ]);
    return { followers: frs.count || 0, following: fng.count || 0 };
  } catch { return { followers: 0, following: 0 }; }
}

async function fetchIsFollowing(followerId, followingId) {
  if (!supabase || !followerId || !followingId) return false;
  try {
    const { count } = await supabase.from("follows")
      .select("*", { count: "exact", head: true })
      .eq("follower_id", followerId).eq("following_id", followingId);
    return (count || 0) > 0;
  } catch { return false; }
}

async function toggleFollow(followerId, followingId, currentlyFollowing) {
  if (!supabase || !followerId) return "Not signed in.";
  try {
    if (currentlyFollowing) {
      const { error } = await supabase.from("follows").delete()
        .eq("follower_id", followerId).eq("following_id", followingId);
      return error?.message || null;
    }
    const { error } = await supabase.from("follows")
      .insert({ follower_id: followerId, following_id: followingId });
    return error?.message || null;
  } catch (e) { return e.message || "Error"; }
}

async function fetchFollowingFeed(userId) {
  if (!supabase || !userId) return [];
  try {
    const { data: follows } = await supabase.from("follows")
      .select("following_id").eq("follower_id", userId);
    const ids = (follows || []).map(f => f.following_id);
    if (!ids.length) return [];
    const { data } = await pubQuery(
      PUB_SELECT_WITH_COUNTS, PUB_SELECT,
      (sel) => supabase.from("publications").select(sel)
        .in("user_id", ids)
        .order("published_at", { ascending: false })
        .limit(50),
    );
    return data || [];
  } catch { return []; }
}

// Retry without the relation-count joins (likes/comments) if the schema
// hasn't been migrated yet — so the feed keeps working.
async function pubQuery(selectWithCounts, selectFallback, builderFn) {
  let { data, error } = await builderFn(selectWithCounts);
  if (error && /relation|schema|join|relationship|column/i.test(error.message || "")) {
    ({ data, error } = await builderFn(selectFallback));
  }
  return { data, error };
}

async function fetchFeed() {
  if (!supabase) return [];
  const { data, error } = await pubQuery(
    PUB_SELECT_WITH_COUNTS, PUB_SELECT,
    (sel) => supabase
      .from("publications")
      .select(sel)
      .order("published_at", { ascending: false })
      .limit(50),
  );
  if (error || !data) return [];
  return data;
}

async function fetchMyPublications(userId) {
  if (!supabase || !userId) return [];
  const { data, error } = await pubQuery(
    "id, doc_id, " + PUB_SELECT_WITH_COUNTS.replace(/^id, /, ""),
    "id, doc_id, " + PUB_SELECT.replace(/^id, /, ""),
    (sel) => supabase
      .from("publications")
      .select(sel)
      .eq("user_id", userId)
      .order("published_at", { ascending: false }),
  );
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
    .from("profiles").select("id, username, display_name, avatar_data, research_opt_in, tos_accepted_at").eq("id", userId).maybeSingle();
  return data || null;
}

async function upsertProfile(userId, username, displayName, { tosAccepted = false, tosVersion = null } = {}) {
  if (!supabase || !userId) return "Not signed in.";
  const row = { id: userId, username, display_name: displayName || null };
  if (tosAccepted) {
    row.research_opt_in = true;
    row.tos_accepted_at = new Date().toISOString();
    row.tos_version     = tosVersion;
  }
  const { error } = await supabase.from("profiles").upsert(row);
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
  const { data } = await pubQuery(
    PUB_SELECT_WITH_COUNTS, PUB_SELECT,
    (sel) => supabase.from("publications").select(sel).eq("id", id).maybeSingle(),
  );
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
  const { data, error } = await pubQuery(
    PUB_SELECT_WITH_COUNTS, PUB_SELECT,
    (sel) => supabase
      .from("publications")
      .select(sel)
      .eq("user_id", userId)
      .order("published_at", { ascending: false }),
  );
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
        <div id="hs-modal-title">A small study of writing.</div>
        <p id="hs-modal-body">
          When you write in Inkk, the rhythm of your typing — pauses, revisions, bursts — is recorded as anonymous, character-free metadata. We use it to study what human writing process looks like in latent space, so we can one day separate it from machine-written text on its own terms.
        </p>
        <p className="hs-modal-body" style={{ marginTop: "12px" }}>
          You can opt out, download, or delete your contribution at any time from your Profile.
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
  const [mode, setMode]         = useState("signin"); // signin | signup | reset
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
    } else if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
      else if (data.user?.identities?.length === 0) setError("An account with this email already exists — try signing in.");
      else if (!data.session) setMessage("Check your email to confirm your account.");
    } else if (mode === "reset") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/?recovery=1",
      });
      if (error) setError(error.message);
      else setMessage("Check your email for a link to reset your password.");
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
        ) : mode === "reset" ? (
          <>
            <div id="auth-tabs">
              <button className="active" style={{ cursor: "default" }}>reset password</button>
            </div>
            <p className="auth-blurb">Enter the email you signed up with — we'll send you a link to set a new password.</p>
            <form onSubmit={submit}>
              <input type="email" placeholder="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              {error && <p className="auth-error">{error}</p>}
              <button id="auth-submit" type="submit" disabled={loading}>
                {loading ? "…" : "Send reset link"}
              </button>
            </form>
            <button className="auth-back" onClick={() => { setMode("signin"); setError(""); }}>← back to sign in</button>
          </>
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
            {mode === "signin" && (
              <button className="auth-forgot" onClick={() => { setMode("reset"); setError(""); setPassword(""); }}>
                Forgot password?
              </button>
            )}
            <div id="auth-divider"><span>or</span></div>
            <button id="google-btn" onClick={googleSignIn}>continue with Google</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── UpdatePasswordModal ──────────────────────────────────────────────────────
// Shown after the user clicks a password-recovery link in their email, or
// from the Profile "Change password" entry. Calls supabase.auth.updateUser.

function UpdatePasswordModal({ onClose, onDone }) {
  const [password, setPassword]   = useState("");
  const [confirm, setConfirm]     = useState("");
  const [error, setError]         = useState("");
  const [loading, setLoading]     = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8)        { setError("At least 8 characters."); return; }
    if (password !== confirm)        { setError("Passwords don't match.");  return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) setError(error.message);
    else { onDone?.(); onClose?.(); }
  };

  return (
    <div id="auth-overlay">
      <div id="auth-modal" onClick={e => e.stopPropagation()}>
        {onClose && <button id="auth-close" onClick={onClose}>×</button>}
        <div id="auth-tabs">
          <button className="active" style={{ cursor: "default" }}>set new password</button>
        </div>
        <form onSubmit={submit}>
          <input type="password" placeholder="new password (min 8)" value={password} onChange={e => setPassword(e.target.value)} required autoFocus />
          <input type="password" placeholder="confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
          {error && <p className="auth-error">{error}</p>}
          <button id="auth-submit" type="submit" disabled={loading || !password || !confirm}>
            {loading ? "saving…" : "Set new password"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── UsernameModal ────────────────────────────────────────────────────────────

function UsernameModal({ user, onDone }) {
  const [username, setUsername]       = useState("");
  const [displayName, setDisplayName] = useState(user.user_metadata?.full_name || "");
  const [accepted, setAccepted]       = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms, setShowTerms]     = useState(false);
  const [error, setError]             = useState("");
  const [loading, setLoading]         = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const u = username.trim();
    if (u.length < 3) { setError("At least 3 characters."); return; }
    if (!accepted)   { setError("Please review and accept the Terms & Privacy Policy to continue."); return; }
    setLoading(true); setError("");
    const errMsg = await upsertProfile(user.id, u, displayName.trim(), { tosAccepted: true, tosVersion: TOS_VERSION });
    if (errMsg) {
      setError(errMsg.includes("unique") || errMsg.includes("duplicate") ? "Username taken." : errMsg);
      setLoading(false);
    } else {
      onDone({ id: user.id, username: u, display_name: displayName.trim(), research_opt_in: true, tos_accepted_at: new Date().toISOString() });
    }
  };

  return (
    <>
      <div id="auth-overlay">
        <div id="auth-modal" onClick={e => e.stopPropagation()}>
          <div id="auth-tabs">
            <button className="active" style={{ cursor: "default" }}>welcome to inkk</button>
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
            <label id="tos-consent">
              <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />
              <span id="tos-consent-text">
                I agree to the{" "}
                <button type="button" className="tos-link" onClick={() => setShowTerms(true)}>Terms</button>
                {" "}and{" "}
                <button type="button" className="tos-link" onClick={() => setShowPrivacy(true)}>Privacy Policy</button>
                , including contributing my anonymised writing-process data to Inkk's research dataset. I can opt out anytime from my Profile.
              </span>
            </label>
            {error && <p className="auth-error">{error}</p>}
            <button id="auth-submit" type="submit" disabled={loading || username.length < 3 || !accepted}>
              {loading ? "saving…" : "continue"}
            </button>
          </form>
        </div>
      </div>
      {showPrivacy && <PrivacyModal onClose={() => setShowPrivacy(false)} />}
      {showTerms   && <TermsModal   onClose={() => setShowTerms(false)} />}
    </>
  );
}

// ─── PublishModal ─────────────────────────────────────────────────────────────

function PublishModal({ doc, user, profile, onConfirm, onClose }) {
  const author = profile?.username || user.user_metadata?.full_name || user.email.split("@")[0];
  const [title, setTitle]     = useState(stripHtml(doc.title || ""));
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");

  const submit = async (e) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setLoading(true); setError("");
    const errMsg = await onConfirm(t, author);
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
          {error && <p className="auth-error">{error}</p>}
          <button id="auth-submit" type="submit" disabled={loading || !title.trim()}>
            {loading ? "publishing…" : "publish"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── DownloadModal ────────────────────────────────────────────────────────────

function DownloadModal({ onConfirm, onClose }) {
  const [format,          setFormat]          = useState("pdf");
  const [dropCap,         setDropCap]         = useState(true);
  const [justify,         setJustify]         = useState(true);
  const [paragraphIndent, setParagraphIndent] = useState(true);
  const [titleGap,        setTitleGap]        = useState("normal");
  const [paperTexture,    setPaperTexture]    = useState(true);
  const [busy,            setBusy]            = useState(false);

  const isPng = format !== "pdf";

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    await onConfirm({
      format,
      style: { dropCap, justify, paragraphIndent, titleGap, paperTexture: isPng ? paperTexture : true },
    });
    setBusy(false);
    onClose();
  };

  return (
    <div id="auth-overlay">
      <div id="auth-modal">
        <button id="auth-close" onClick={onClose}>×</button>
        <div id="auth-tabs"><button className="active" style={{ cursor: "default" }}>download</button></div>
        <form onSubmit={submit}>
          <div className="dl-section-label">Format</div>
          <div className="dl-radio-row">
            {[
              { v: "pdf",          l: "PDF" },
              { v: "png-square",   l: "PNG · square" },
              { v: "png-portrait", l: "PNG · portrait" },
            ].map(o => (
              <label key={o.v} className={`dl-radio${format === o.v ? " active" : ""}`}>
                <input type="radio" name="format" value={o.v} checked={format === o.v} onChange={() => setFormat(o.v)} />
                <span>{o.l}</span>
              </label>
            ))}
          </div>

          <div className="dl-section-label">Style</div>
          <label className="dl-check"><input type="checkbox" checked={dropCap}         onChange={e => setDropCap(e.target.checked)} /><span>Drop cap</span></label>
          <label className="dl-check"><input type="checkbox" checked={justify}         onChange={e => setJustify(e.target.checked)} /><span>Justify text</span></label>
          <label className="dl-check"><input type="checkbox" checked={paragraphIndent} onChange={e => setParagraphIndent(e.target.checked)} /><span>Paragraph indent</span></label>
          {isPng && (
            <label className="dl-check"><input type="checkbox" checked={paperTexture} onChange={e => setPaperTexture(e.target.checked)} /><span>Paper texture</span></label>
          )}

          <div className="dl-section-label">Title spacing</div>
          <div className="dl-radio-row">
            {[{ v: "tight", l: "Tight" }, { v: "normal", l: "Normal" }, { v: "loose", l: "Loose" }].map(o => (
              <label key={o.v} className={`dl-radio${titleGap === o.v ? " active" : ""}`}>
                <input type="radio" name="titleGap" value={o.v} checked={titleGap === o.v} onChange={() => setTitleGap(o.v)} />
                <span>{o.l}</span>
              </label>
            ))}
          </div>

          <button id="auth-submit" type="submit" disabled={busy}>
            {busy ? "preparing…" : `Download ${format === "pdf" ? "PDF" : "PNG"}`}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Feed ─────────────────────────────────────────────────────────────────────

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso), n = new Date();
  return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
}

// Word-boundary excerpt with an ellipsis when truncated.
function feedExcerpt(content, limit) {
  const raw = content ? stripHtml(content).replace(/\s+/g, " ").trim() : "";
  if (raw.length <= limit) return raw;
  return raw.slice(0, limit).replace(/\s+\S*$/, "") + "…";
}

// Shared engagement cluster — quiet diamond signal, likes, comments.
function FeedActions({ pub, sc, likeCount, commentCount, onRead, onLike }) {
  return (
    <div className="feed-entry-actions">
      {sc && <HumanSignalBadge score={sc} />}
      <button className="feed-engage" onClick={e => { e.stopPropagation(); onLike(pub); }} aria-label="Like">
        <Heart size={13} strokeWidth={1.5} fill="none" />
        <span>{likeCount}</span>
      </button>
      <button className="feed-engage" onClick={e => { e.stopPropagation(); onRead(pub, { focus: "comments" }); }} aria-label="Comments">
        <MessageCircle size={13} strokeWidth={1.5} />
        <span>{commentCount}</span>
      </button>
    </div>
  );
}

function FeedCard({ pub, index, featured, dropCapImages, onRead, onAuthorClick, onLike }) {
  const excerpt      = feedExcerpt(pub.content, featured ? 300 : 168);
  const likeCount    = getRelCount(pub.like_count);
  const commentCount = getRelCount(pub.comment_count);
  const sc           = scoreFromRecord(pub);
  const fresh        = isToday(pub.published_at);
  const initial      = (pub.author_name || "?")[0];

  const author = pub.author_name && (
    <button
      className="feed-entry-author"
      onClick={e => { e.stopPropagation(); pub.user_id && onAuthorClick(pub.user_id); }}
    >
      {pub.author_name}
    </button>
  );

  const dateline = (
    <span className="feed-entry-date">
      {fresh && <span className="feed-fresh-dot" title="Published today" />}
      {formatDate(pub.published_at)}
    </span>
  );

  if (featured) {
    return (
      <article className="feed-lead" style={{ "--card-index": index }} onClick={() => onRead(pub)}>
        <span className="feed-lead-kicker">{fresh ? "Today’s lead" : "Latest"}</span>
        <h2 className="feed-lead-title">{pub.title || "Untitled"}</h2>
        {excerpt && <p className="feed-lead-excerpt">{excerpt}</p>}
        <div className="feed-lead-byline">
          <span className="feed-mark">
            <DropCapAvatar letter={initial} avatarData={pub.avatar_data} dropCapImages={dropCapImages} size={44} />
          </span>
          <div className="feed-lead-byline-text">
            {author}
            <span className="feed-lead-sub">{readingTime(pub.content)} <span className="feed-dot">·</span> {dateline}</span>
          </div>
          <FeedActions pub={pub} sc={sc} likeCount={likeCount} commentCount={commentCount} onRead={onRead} onLike={onLike} />
        </div>
      </article>
    );
  }

  return (
    <article className="feed-entry" style={{ "--card-index": index }} onClick={() => onRead(pub)}>
      <span className="feed-mark feed-mark-sm">
        <DropCapAvatar letter={initial} avatarData={pub.avatar_data} dropCapImages={dropCapImages} size={34} />
      </span>
      <div className="feed-entry-body">
        <h2 className="feed-entry-title">{pub.title || "Untitled"}</h2>
        {excerpt && <p className="feed-entry-excerpt">{excerpt}</p>}
        <div className="feed-entry-meta">
          {author}
          <span className="feed-dot">·</span>
          <span>{readingTime(pub.content)}</span>
          <span className="feed-dot">·</span>
          {dateline}
          <FeedActions pub={pub} sc={sc} likeCount={likeCount} commentCount={commentCount} onRead={onRead} onLike={onLike} />
        </div>
      </div>
    </article>
  );
}

// Premium loading state — hairline shimmer rows that echo the entry shape.
function FeedSkeleton({ count = 4 }) {
  return (
    <div className="feed-skeleton" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="feed-skel-row" style={{ "--card-index": i }}>
          <div className="feed-skel-mark" />
          <div className="feed-skel-body">
            <div className="feed-skel-line feed-skel-title" />
            <div className="feed-skel-line w-92" />
            <div className="feed-skel-line w-74" />
            <div className="feed-skel-line feed-skel-meta w-40" />
          </div>
        </div>
      ))}
    </div>
  );
}

function FeedEmpty({ title, sub, action }) {
  return (
    <div className="feed-empty-state">
      <span className="feed-empty-mark" aria-hidden="true">◇</span>
      <p className="feed-empty-title">{title}</p>
      {sub && <p className="feed-empty-sub">{sub}</p>}
      {action}
    </div>
  );
}

function Feed({ user, onRead, onAuthorClick, dropCapImages, onRequestAuth }) {
  const [pubs, setPubs]               = useState([]);
  const [loading, setLoading]         = useState(true);
  const [feedTab, setFeedTab]         = useState("stories");
  const [followingPubs, setFollowingPubs]   = useState([]);
  const [followingLoading, setFollowingLoading] = useState(false);
  const [followingFetched, setFollowingFetched] = useState(false);
  const inflightLikes = useRef(new Set());

  useEffect(() => {
    fetchFeed().then(data => { setPubs(data); setLoading(false); });
  }, []);

  useEffect(() => {
    if (feedTab === "following" && user && !followingFetched) {
      setFollowingLoading(true);
      fetchFollowingFeed(user.id).then(data => {
        setFollowingPubs(data);
        setFollowingLoading(false);
        setFollowingFetched(true);
      });
    }
  }, [feedTab, user, followingFetched]);

  // Reset following cache when user changes
  useEffect(() => {
    setFollowingFetched(false);
    setFollowingPubs([]);
  }, [user]);

  const writers = useMemo(() => {
    const seen = new Set();
    return pubs.filter(p => {
      if (!p.user_id || seen.has(p.user_id)) return false;
      seen.add(p.user_id);
      return true;
    });
  }, [pubs]);

  const makeLikeHandler = useCallback((pubList, setPubList) => async (pub) => {
    if (!user) { onRequestAuth?.(); return; }
    if (inflightLikes.current.has(pub.id)) return;
    inflightLikes.current.add(pub.id);
    setPubList(prev => prev.map(p => p.id !== pub.id ? p : {
      ...p,
      like_count: [{ count: Math.max(0, getRelCount(p.like_count) + 1) }],
    }));
    const err = await togglePubLike(pub.id, user.id, false);
    inflightLikes.current.delete(pub.id);
    if (err) {
      setPubList(prev => prev.map(p => p.id !== pub.id ? p : {
        ...p,
        like_count: [{ count: Math.max(0, getRelCount(p.like_count) - 1) }],
      }));
    }
  }, [user, onRequestAuth]);

  const handleLike          = useMemo(() => makeLikeHandler(pubs, setPubs), [makeLikeHandler, pubs]);
  const handleFollowingLike = useMemo(() => makeLikeHandler(followingPubs, setFollowingPubs), [makeLikeHandler, followingPubs]);

  const editionDate = useMemo(() => {
    const d = new Date();
    const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
    const rest    = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    return `${weekday} · ${rest}`;
  }, []);

  const tagline = feedTab === "following"
    ? "New work from the writers you follow."
    : feedTab === "writers"
      ? "The people writing by hand on inkk."
      : "Fresh writing from the community — each piece still carrying the marks of its making.";

  return (
    <div id="feed-container">
      <div id="feed-masthead">
        <span className="feed-dateline">{editionDate}</span>
        <p className="feed-tagline">{tagline}</p>
      </div>

      <div id="feed-header">
        <div id="feed-tabs">
          {user && (
            <button className={`feed-tab${feedTab === "following" ? " active" : ""}`} onClick={() => setFeedTab("following")}>Following</button>
          )}
          <button className={`feed-tab${feedTab === "stories" ? " active" : ""}`} onClick={() => setFeedTab("stories")}>Stories</button>
          <button className={`feed-tab${feedTab === "writers" ? " active" : ""}`} onClick={() => setFeedTab("writers")}>Writers{writers.length > 0 && <span className="feed-tab-count">{writers.length}</span>}</button>
        </div>
      </div>

      {feedTab === "following" && (
        <div id="feed-list">
          {followingLoading && <FeedSkeleton />}
          {!followingLoading && followingFetched && followingPubs.length === 0 && (
            <FeedEmpty title="Your feed is quiet" sub="Follow writers and their newest work gathers here." />
          )}
          {!followingLoading && followingPubs.map((pub, i) => (
            <FeedCard key={pub.id} pub={pub} index={i} featured={i === 0} dropCapImages={dropCapImages}
              onRead={onRead} onAuthorClick={onAuthorClick} onLike={handleFollowingLike} />
          ))}
        </div>
      )}

      {feedTab === "writers" && (
        <div id="feed-list">
          {loading && <FeedSkeleton count={5} />}
          {!loading && writers.length === 0 && (
            <FeedEmpty title="No writers yet" sub="The first published piece will introduce its author here." />
          )}
          {!loading && writers.map((w, i) => {
            const pieceCount = pubs.filter(p => p.user_id === w.user_id).length;
            return (
              <div key={w.user_id} className="writer-card" style={{ "--card-index": i }} onClick={() => w.user_id && onAuthorClick(w.user_id)}>
                <DropCapAvatar letter={w.author_name?.[0] || "?"} avatarData={w.avatar_data} dropCapImages={dropCapImages} size={36} />
                <div className="writer-card-info">
                  <span className="writer-card-name">{w.author_name}</span>
                  <span className="writer-card-meta">{pieceCount} {pieceCount === 1 ? "piece" : "pieces"} · {formatDate(w.published_at)}</span>
                </div>
                <span className="writer-card-arrow">→</span>
              </div>
            );
          })}
        </div>
      )}

      {feedTab === "stories" && (
        <div id="feed-list">
          {loading && <FeedSkeleton />}
          {!loading && pubs.length === 0 && (
            <FeedEmpty title="Nothing published yet" sub="Be the first to share something written by hand." />
          )}
          {!loading && pubs.map((pub, i) => (
            <FeedCard key={pub.id} pub={pub} index={i} featured={i === 0} dropCapImages={dropCapImages}
              onRead={onRead} onAuthorClick={onAuthorClick} onLike={handleLike} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Profile ──────────────────────────────────────────────────────────────────

function Profile({ user, profile, localDocs, publishedDocIds, streak, dropCapImages, onRead, onUnpublish, onSignIn, onSignOut, onAvatarChange, onEditDoc, onNewDoc, onDeleteDoc, onPublishDoc, researchOptIn, onToggleOptIn, onDownloadData, onDeleteData, onChangePassword, onProfileUpdate }) {
  const [pubs, setPubs]           = useState([]);
  const [loading, setLoading]     = useState(!!user);
  const [uploading, setUploading] = useState(false);
  const [optBusy, setOptBusy]     = useState(false);
  const [delBusy, setDelBusy]     = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTerms,   setShowTerms]   = useState(false);
  const [confirmDeleteId, setConfirmDeleteId]         = useState(null);
  const [confirmUnpublishId, setConfirmUnpublishId]   = useState(null);
  const [confirmDeletePubId, setConfirmDeletePubId]   = useState(null);
  const [contribution, setContribution] = useState(null);
  const [editingProfile, setEditingProfile]   = useState(false);
  const [editUsername, setEditUsername]       = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [profileSaving, setProfileSaving]     = useState(false);
  const [profileError, setProfileError]       = useState("");
  const fileInputRef              = useRef(null);

  useEffect(() => {
    if (!user || !researchOptIn) { setContribution(null); return; }
    fetchMyContribution(user.id).then(setContribution);
  }, [user, researchOptIn]);

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

  const handleDeletePub = async (pub) => {
    await doUnpublish(pub.doc_id);
    onDeleteDoc(pub.doc_id);
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
          <div id="profile-signin-mark">Inkk</div>
          <h2 id="profile-signin-title">Join the conversation</h2>
          <p id="profile-signin-sub">Write privately, or publish to the feed — all with Human&nbsp;Signal tracking.</p>
          <div id="profile-signin-actions">
            <button className="profile-cta" onClick={onSignIn}>Sign in</button>
            <button className="profile-cta-ghost" onClick={onSignIn}>Create account</button>
          </div>
        </div>
      </div>
    );
  }

  const totalWords = localDocs.reduce((sum, d) => sum + wordCount(d.content), 0);
  const avatarLetter = profile?.username?.[0] || user.email[0];

  const hasCustomAvatar = !!profile?.avatar_data;
  const handleRemoveAvatar = async () => {
    if (!hasCustomAvatar || uploading) return;
    setUploading(true);
    await onAvatarChange(null);
    setUploading(false);
  };

  const startEditProfile = () => {
    setEditUsername(profile?.username || "");
    setEditDisplayName(profile?.display_name || "");
    setProfileError("");
    setEditingProfile(true);
  };

  const saveProfile = async () => {
    const newUsername = editUsername.trim();
    const newDisplayName = editDisplayName.trim();
    if (newUsername.length < 3) { setProfileError("Username must be at least 3 characters."); return; }
    setProfileSaving(true);
    setProfileError("");
    if (newUsername !== profile?.username) {
      const existing = await fetchProfileByUsername(newUsername);
      if (existing && existing.id !== user.id) {
        setProfileError("That username is already taken.");
        setProfileSaving(false);
        return;
      }
    }
    const err = await upsertProfile(user.id, newUsername, newDisplayName || null);
    setProfileSaving(false);
    if (err) {
      setProfileError(err.includes("unique") || err.includes("duplicate") ? "Username already taken." : err);
      return;
    }
    onProfileUpdate?.({ ...profile, username: newUsername, display_name: newDisplayName || null });
    setEditingProfile(false);
  };

  return (
    <div id="profile-container">
      <header id="profile-header">
        <div id="profile-avatar-wrap">
          <DropCapAvatar letter={avatarLetter} avatarData={profile?.avatar_data} dropCapImages={dropCapImages} size={78} />
          <button id="avatar-upload-btn" onClick={() => fileInputRef.current?.click()} title="Change photo">
            {uploading ? "…" : "✎"}
          </button>
          {hasCustomAvatar && (
            <button
              id="avatar-remove-btn"
              onClick={handleRemoveAvatar}
              title="Remove photo — revert to default"
              disabled={uploading}
            >×</button>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFileChange} />
        </div>

        {editingProfile ? (
          <div className="profile-edit-form">
            <input
              className="profile-edit-input"
              type="text"
              value={editUsername}
              onChange={e => setEditUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
              placeholder="username"
              maxLength={20}
              autoFocus
            />
            <input
              className="profile-edit-input"
              type="text"
              value={editDisplayName}
              onChange={e => setEditDisplayName(e.target.value)}
              placeholder="display name (optional)"
              maxLength={50}
            />
            {profileError && <p className="profile-edit-error">{profileError}</p>}
            <div className="profile-edit-actions">
              <button className="text-btn" onClick={() => { setEditingProfile(false); setProfileError(""); }} disabled={profileSaving}>Cancel</button>
              <button className="text-btn text-btn-accent" onClick={saveProfile} disabled={profileSaving || editUsername.length < 3}>{profileSaving ? "saving…" : "Save"}</button>
            </div>
          </div>
        ) : (
          <div id="profile-identity">
            <h1 id="profile-username">{profile?.username ? `@${profile.username}` : user.email}</h1>
            {profile?.display_name && <div id="profile-displayname">{profile.display_name}</div>}
            {user.created_at && (
              <div id="profile-joined">Member since {formatJoined(user.created_at)}</div>
            )}
            <button className="profile-edit-btn" onClick={startEditProfile}>Edit profile</button>
          </div>
        )}
      </header>

      <div id="profile-stats">
        {streak > 0 && (
          <div className="stat-fig">
            <span className="stat-fig-num">{streak}</span>
            <span className="stat-fig-label">Day streak</span>
          </div>
        )}
        <div className="stat-fig">
          <span className="stat-fig-num">{pubs.length}</span>
          <span className="stat-fig-label">Published</span>
        </div>
        <div className="stat-fig">
          <span className="stat-fig-num">{totalWords.toLocaleString()}</span>
          <span className="stat-fig-label">Words</span>
        </div>
      </div>

      {/* ── Drafts ─────────────────────────────────────────────────────── */}
      {(() => {
        const drafts = (localDocs || [])
          .filter(d => !publishedDocIds?.has(d.id) && stripHtml(d.content).trim().length > 0)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return (
          <section className="profile-section">
            <div className="profile-section-head">
              <h2 className="profile-section-label">Drafts<span className="section-count">{drafts.length}</span></h2>
              <button className="section-action" onClick={onNewDoc}>New draft</button>
            </div>
            <p className="profile-section-sub">Saved on your device and synced to your account. Only you can see them.</p>

            <div className="profile-list">
              {drafts.length === 0 && (
                <p className="feed-empty">No drafts yet. <button className="feed-empty-link" onClick={onNewDoc}>Start writing →</button></p>
              )}
              {drafts.map((d, idx) => {
                const title = stripHtml(d.title || "") || docTitle(d.content);
                const wc = wordCount(d.content);
                const confirming = confirmDeleteId === d.id;
                return (
                  <article key={d.id} className="profile-article-card" style={{ "--card-index": idx }} onClick={() => !confirming && onEditDoc(d.id)}>
                    <div className="pac-main">
                      <span className="pac-title">{title || "Untitled"}</span>
                      <span className="pac-meta">{wc} words · {formatDate(new Date(d.updatedAt).toISOString())}</span>
                    </div>
                    {!confirming ? (
                      <div className="pac-actions" onClick={e => e.stopPropagation()}>
                        <button className="pac-btn" onClick={e => { e.stopPropagation(); onPublishDoc(d); }}>Publish</button>
                        <button className="pac-btn pac-btn-danger" onClick={e => { e.stopPropagation(); setConfirmDeleteId(d.id); }}>Delete</button>
                      </div>
                    ) : (
                      <div className="pac-confirm" onClick={e => e.stopPropagation()}>
                        <button className="pac-btn" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                        <button className="pac-btn pac-btn-danger" onClick={() => { onDeleteDoc(d.id); setConfirmDeleteId(null); }}>Delete</button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        );
      })()}

      {/* ── Published ──────────────────────────────────────────────────── */}
      <section className="profile-section">
      <div className="profile-section-head">
        <h2 className="profile-section-label">Published<span className="section-count">{pubs.length}</span></h2>
      </div>
      <p className="profile-section-sub">Visible to anyone on the feed.</p>

      <div className="profile-list">
        {loading && <p className="feed-empty">loading…</p>}
        {!loading && pubs.length === 0 && (
          <p className="feed-empty">Nothing published yet.</p>
        )}
        {pubs.map((pub, idx) => {
          const confirmingUnpublish = confirmUnpublishId === pub.id;
          const confirmingDelete    = confirmDeletePubId === pub.id;
          return (
            <article key={pub.id} className="profile-article-card" style={{ "--card-index": idx }} onClick={() => !confirmingUnpublish && !confirmingDelete && onEditDoc(pub.doc_id)}>
              <div className="pac-main">
                <span className="pac-title">{pub.title || "Untitled"}</span>
                <span className="pac-meta">{readingTime(pub.content)} · {formatDate(pub.published_at)}</span>
              </div>
              {!confirmingUnpublish && !confirmingDelete && (
                <div className="pac-actions" onClick={e => e.stopPropagation()}>
                  <button className="pac-btn" onClick={e => { e.stopPropagation(); onRead(pub); }}>Read</button>
                  <button className="pac-btn pac-btn-danger" onClick={e => { e.stopPropagation(); setConfirmUnpublishId(pub.id); }}>Unpublish</button>
                  <button className="pac-btn pac-btn-danger" onClick={e => { e.stopPropagation(); setConfirmDeletePubId(pub.id); }}>Delete</button>
                </div>
              )}
              {confirmingUnpublish && (
                <div className="pac-confirm" onClick={e => e.stopPropagation()}>
                  <button className="pac-btn" onClick={() => setConfirmUnpublishId(null)}>Cancel</button>
                  <button className="pac-btn pac-btn-danger" onClick={async (e) => { await handleUnpublish(pub, e); setConfirmUnpublishId(null); }}>Remove</button>
                </div>
              )}
              {confirmingDelete && (
                <div className="pac-confirm" onClick={e => e.stopPropagation()}>
                  <button className="pac-btn" onClick={() => setConfirmDeletePubId(null)}>Cancel</button>
                  <button className="pac-btn pac-btn-danger" onClick={() => { handleDeletePub(pub); setConfirmDeletePubId(null); }}>Delete</button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      </section>

      <section id="research-section">
        <div className="profile-section-head">
          <h2 className="profile-section-label">Research</h2>
        </div>
        <p id="research-blurb">
          When you write in Inkk, the rhythm of your typing — pauses, revisions, bursts — is recorded as anonymous, character-free metadata. We use it to study what human writing looks like in latent space. You can turn this off at any time, and the editor keeps working exactly as before.
        </p>

        {researchOptIn && contribution && contribution.event_count > 0 && (
          <div id="contribution-card">
            <div id="contribution-num">{Number(contribution.event_count).toLocaleString()}</div>
            <div id="contribution-label">events contributed to the inkk writing study</div>
            {contribution.first_t && (
              <div id="contribution-since">since {formatDate(new Date(Number(contribution.first_t)).toISOString())}</div>
            )}
          </div>
        )}

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
          <span className="research-toggle-label">{researchOptIn ? "Sharing on" : "Sharing off"}</span>
        </label>

        {researchOptIn && (
          <div id="research-controls">
            <button className="text-btn" onClick={onDownloadData}>Download my data</button>
            {!confirmDel ? (
              <button className="text-btn text-btn-danger" onClick={() => setConfirmDel(true)}>Delete my data</button>
            ) : (
              <div className="research-confirm">
                <span>Delete all your captured writing-process data?</span>
                <button className="text-btn" onClick={() => setConfirmDel(false)}>Cancel</button>
                <button
                  className="text-btn text-btn-danger"
                  disabled={delBusy}
                  onClick={async () => { setDelBusy(true); await onDeleteData(); setDelBusy(false); setConfirmDel(false); }}
                >{delBusy ? "Deleting…" : "Yes, delete"}</button>
              </div>
            )}
          </div>
        )}

        <div id="research-legal-links">
          <button type="button" className="tos-link" onClick={() => setShowPrivacy(true)}>Privacy Policy</button>
          <span className="research-legal-dot">·</span>
          <button type="button" className="tos-link" onClick={() => setShowTerms(true)}>Terms</button>
        </div>
      </section>

      <div id="account-footer">
        <button className="account-link" onClick={onChangePassword}>Change password</button>
        <span className="account-dot">·</span>
        <a className="account-link" href="mailto:hello@inkk.example?subject=Hello%20Inkk">Contact</a>
        <span className="account-dot">·</span>
        <button className="account-link account-signout" onClick={onSignOut}>Sign out</button>
      </div>

      {showPrivacy && <PrivacyModal onClose={() => setShowPrivacy(false)} />}
      {showTerms   && <TermsModal   onClose={() => setShowTerms(false)} />}
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
        {results.map((p, i) => (
          <div key={p.id} className="writer-card" style={{ "--card-index": i }} onClick={() => onViewUser(p)}>
            <DropCapAvatar letter={p.username?.[0]} avatarData={p.avatar_data} dropCapImages={dropCapImages} size={36} />
            <div className="writer-card-info">
              <span className="writer-card-name">{p.display_name || `@${p.username}`}</span>
              <span className="writer-card-meta">@{p.username}</span>
            </div>
            <span className="writer-card-arrow">→</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── UserProfileView ──────────────────────────────────────────────────────────

function UserProfileView({ profile, onRead, dropCapImages, user, onRequestAuth }) {
  const [pubs, setPubs]                 = useState([]);
  const [loading, setLoading]           = useState(true);
  const [following, setFollowing]       = useState(false);
  const [followerCount, setFollowerCount] = useState(0);
  const [followBusy, setFollowBusy]     = useState(false);
  const inflightLikes                   = useRef(new Set());

  const isOwnProfile = user?.id === profile.id;

  useEffect(() => {
    fetchUserPublications(profile.id).then(data => { setPubs(data); setLoading(false); });
    fetchFollowCounts(profile.id).then(({ followers }) => setFollowerCount(followers));
  }, [profile.id]);

  useEffect(() => {
    if (user && !isOwnProfile) fetchIsFollowing(user.id, profile.id).then(setFollowing);
    else setFollowing(false);
  }, [user, profile.id, isOwnProfile]);

  const handleFollow = async () => {
    if (!user) { onRequestAuth?.(); return; }
    setFollowBusy(true);
    const wasFollowing = following;
    setFollowing(!wasFollowing);
    setFollowerCount(c => Math.max(0, c + (wasFollowing ? -1 : 1)));
    await toggleFollow(user.id, profile.id, wasFollowing);
    setFollowBusy(false);
  };

  const handleLike = useCallback(async (pub) => {
    if (!user) { onRequestAuth?.(); return; }
    if (inflightLikes.current.has(pub.id)) return;
    inflightLikes.current.add(pub.id);
    setPubs(prev => prev.map(p => p.id !== pub.id ? p : {
      ...p,
      like_count: [{ count: Math.max(0, getRelCount(p.like_count) + 1) }],
    }));
    const err = await togglePubLike(pub.id, user.id, false);
    inflightLikes.current.delete(pub.id);
    if (err) {
      setPubs(prev => prev.map(p => p.id !== pub.id ? p : {
        ...p,
        like_count: [{ count: Math.max(0, getRelCount(p.like_count) - 1) }],
      }));
    }
  }, [user, onRequestAuth]);

  return (
    <div id="user-profile-container">
      <div id="user-profile-header">
        <DropCapAvatar letter={profile.username?.[0]} avatarData={profile.avatar_data} dropCapImages={dropCapImages} size={52} />
        <div id="user-profile-info">
          <div id="user-profile-username">@{profile.username}</div>
          {profile.display_name && <div id="user-profile-name">{profile.display_name}</div>}
          <div id="user-profile-stats">
            <span className="user-profile-stat">{pubs.length} {pubs.length === 1 ? "piece" : "pieces"}</span>
            <span className="user-profile-stat-sep">·</span>
            <span className="user-profile-stat">{followerCount} {followerCount === 1 ? "follower" : "followers"}</span>
          </div>
        </div>
        {!isOwnProfile && (
          <button
            className={`follow-btn${following ? " following" : ""}`}
            onClick={handleFollow}
            disabled={followBusy}
          >
            {following ? "Following" : "Follow"}
          </button>
        )}
      </div>
      <div id="user-profile-list">
        {loading && <p className="feed-empty">loading…</p>}
        {!loading && pubs.length === 0 && <p className="feed-empty">nothing published yet.</p>}
        {pubs.map((pub, i) => (
          <FeedCard key={pub.id} pub={pub} index={i} onRead={onRead} onAuthorClick={() => {}} onLike={handleLike} />
        ))}
      </div>
    </div>
  );
}

// ─── ReadingView ──────────────────────────────────────────────────────────────

function ReadingView({ pub, user, dropCapImages, focus, onRequestAuth, onAuthorClick }) {
  const containerRef = useRef(null);
  const commentsRef  = useRef(null);
  const [progress, setProgress] = useState(0);
  const [copied, setCopied]     = useState(false);
  const [likeCount, setLikeCount]       = useState(getRelCount(pub.like_count));
  const [liked, setLiked]               = useState(false);
  const [likeBusy, setLikeBusy]         = useState(false);
  const [comments, setComments]         = useState([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [body, setBody]                 = useState("");
  const [posting, setPosting]           = useState(false);
  const [confirmDelId, setConfirmDelId] = useState(null);
  const [pages, setPages]               = useState([]);
  const [pagesLoading, setPagesLoading] = useState(true);
  const [zoom, setZoom]                 = useState(1.0);

  useEffect(() => {
    setPages([]);
    setPagesLoading(true);
    renderBookPdfPages({
      title: pub.title || "",
      byline: pub.author_name || "",
      html: pub.content || "",
      options: { dropCap: true, justify: true, paragraphIndent: true, paperTexture: true },
      async onPage(canvas) {
        const url = canvas.toDataURL("image/jpeg", 0.95);
        setPages(prev => [...prev, url]);
      },
    }).then(() => setPagesLoading(false))
      .catch(() => setPagesLoading(false));
  }, [pub.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLikeCount(getRelCount(pub.like_count));
    setCommentsLoading(true);
    fetchComments(pub.id).then(rows => { setComments(rows); setCommentsLoading(false); });
    if (user) {
      supabase
        .from("likes")
        .select("publication_id", { count: "exact", head: true })
        .eq("user_id", user.id).eq("publication_id", pub.id)
        .then(({ count }) => setLiked((count || 0) > 0));
    } else {
      setLiked(false);
    }
    supabase
      .from("likes")
      .select("publication_id", { count: "exact", head: true })
      .eq("publication_id", pub.id)
      .then(({ count }) => { if (count != null) setLikeCount(count); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pub.id, user]);

  // Optional scroll-to-comments when arriving via the comment-count button.
  useEffect(() => {
    if (focus === "comments" && commentsRef.current) {
      const t = setTimeout(() => commentsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
      return () => clearTimeout(t);
    }
  }, [focus, commentsLoading]);

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

  const toggleLike = useCallback(async () => {
    if (!user) { onRequestAuth?.(); return; }
    if (likeBusy) return;
    setLikeBusy(true);
    const wasLiked = liked;
    setLiked(!wasLiked);
    setLikeCount(c => Math.max(0, c + (wasLiked ? -1 : 1)));
    const err = await togglePubLike(pub.id, user.id, wasLiked);
    if (err) {
      setLiked(wasLiked);
      setLikeCount(c => Math.max(0, c + (wasLiked ? 1 : -1)));
    }
    setLikeBusy(false);
  }, [user, liked, likeBusy, pub.id, onRequestAuth]);

  const submitComment = useCallback(async (e) => {
    e.preventDefault();
    if (!user) { onRequestAuth?.(); return; }
    if (!body.trim() || posting) return;
    setPosting(true);
    const err = await addComment(pub.id, user.id, body);
    if (!err) {
      setBody("");
      const rows = await fetchComments(pub.id);
      setComments(rows);
    }
    setPosting(false);
  }, [user, body, posting, pub.id, onRequestAuth]);

  const removeComment = useCallback(async (commentId) => {
    const err = await deleteCommentRow(commentId);
    if (!err) setComments(prev => prev.filter(c => c.id !== commentId));
    setConfirmDelId(null);
  }, []);

  return (
    <>
      <div id="reading-progress" style={{ width: `${progress * 100}%` }} />
      <div id="reading-container" ref={containerRef} onScroll={handleScroll}>
        <div id="reading-meta">
          <button
            className="reading-author-btn"
            onClick={() => pub.user_id && onAuthorClick?.(pub.user_id)}
            disabled={!pub.user_id}
          >
            {pub.author_name}
          </button>
          <span className="reading-dot">·</span>
          <span>{formatDate(pub.published_at)}</span>
          <span className="reading-dot">·</span>
          <span>{readingTime(pub.content)}</span>
          <button id="reading-copy" onClick={copyText} title="Copy text">
            {copied ? <CheckCheck size={14} /> : <Copy size={14} />}
          </button>
          <div className="reading-zoom">
            <button className="zoom-btn" onClick={() => setZoom(z => Math.max(0.6, +(z - 0.2).toFixed(1)))} title="Zoom out">−</button>
            <button className="zoom-btn" onClick={() => setZoom(z => Math.min(2.4, +(z + 0.2).toFixed(1)))} title="Zoom in">+</button>
          </div>
        </div>
        <div id="reading-inner" style={{ maxWidth: `${700 * zoom}px` }}>
          <div id="reading-pages">
            {pagesLoading && pages.length === 0 && (
              <p className="reading-pages-loading">rendering…</p>
            )}
            {pages.map((url, i) => (
              <img key={i} className="reading-page-img" src={url} alt="" />
            ))}
          </div>

          {/* ── Like + Comments ──────────────────────────────────────────── */}
          <div id="reading-footer">
            <div className="reading-actions">
              <button
                className={`reading-like${liked ? " liked" : ""}`}
                onClick={toggleLike}
                disabled={likeBusy}
              >
                <Heart size={18} strokeWidth={1.6} fill={liked ? "currentColor" : "none"} />
                <span>{likeCount} {likeCount === 1 ? "like" : "likes"}</span>
              </button>
            </div>

            <div className="reading-comments" ref={commentsRef}>
              <h3 className="reading-comments-title">{comments.length} {comments.length === 1 ? "comment" : "comments"}</h3>

              {user ? (
                <form className="comment-form" onSubmit={submitComment}>
                  <textarea
                    className="comment-input"
                    placeholder="Leave a comment…"
                    value={body}
                    onChange={e => setBody(e.target.value)}
                    maxLength={2000}
                    rows={3}
                  />
                  <div className="comment-form-row">
                    <span className="comment-counter">{body.length}/2000</span>
                    <button type="submit" className="comment-post" disabled={!body.trim() || posting}>
                      {posting ? "posting…" : "Post"}
                    </button>
                  </div>
                </form>
              ) : (
                <p className="comment-signin">
                  <button className="tos-link" onClick={() => onRequestAuth?.()}>Sign in</button> to like and comment.
                </p>
              )}

              {commentsLoading && <p className="feed-empty">loading…</p>}
              {!commentsLoading && comments.length === 0 && (
                <p className="feed-empty">No comments yet.</p>
              )}

              <div className="comment-list">
                {comments.map(c => {
                  const username = c.profiles?.username || "anonymous";
                  const isMine   = user && c.user_id === user.id;
                  const isConfirming = confirmDelId === c.id;
                  return (
                    <div key={c.id} className="comment">
                      <DropCapAvatar
                        letter={username[0]}
                        avatarData={c.profiles?.avatar_data}
                        dropCapImages={dropCapImages}
                        size={28}
                      />
                      <div className="comment-body-wrap">
                        <div className="comment-header">
                          <span className="comment-author">@{username}</span>
                          <span className="comment-time">{formatDate(c.created_at)}</span>
                          {isMine && !isConfirming && (
                            <button className="comment-delete" onClick={() => setConfirmDelId(c.id)}>delete</button>
                          )}
                          {isMine && isConfirming && (
                            <span className="comment-confirm">
                              <button className="comment-delete" onClick={() => setConfirmDelId(null)}>cancel</button>
                              <button className="comment-delete comment-delete-yes" onClick={() => removeComment(c.id)}>yes, delete</button>
                            </span>
                          )}
                        </div>
                        <p className="comment-body">{c.body}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
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
  const [online, setOnline]           = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [words, setWords]             = useState(() => wordCount(initDocs.find(d => d.id === initActiveId)?.content));
  const [user, setUser]               = useState(null);
  const [authOpen, setAuthOpen]       = useState(false);
  const [view, setView]               = useState(() => pathToView(window.location.pathname));
  const [readingPub, setReadingPub]   = useState(null);
  const [readingFocus, setReadingFocus] = useState(null);
  const [publishedDocIds, setPublishedDocIds] = useState(new Set());
  const [publishModalDoc, setPublishModalDoc] = useState(null);
  const [font, setFont]               = useState(() => localStorage.getItem("inkk_font") || "garamond");
  const [showLanding, setShowLanding] = useState(() => !localStorage.getItem("inkk_visited"));
  const [hsModalOpen, setHsModalOpen] = useState(false);
  const [hsScoreOpen, setHsScoreOpen]   = useState(false);
  const [streak, setStreak]           = useState(() => loadStreak().count);
  const [toasts, setToasts]           = useState([]);
  const [focusMode, setFocusMode]     = useState(false);
  const [publishMenuOpen, setPublishMenuOpen] = useState(false);
  const [profile, setProfile]         = useState(null);
  const [dropCapImages, setDropCapImages] = useState({});
  const [usernameModalOpen, setUsernameModalOpen] = useState(false);
  const [updatePasswordOpen, setUpdatePasswordOpen] = useState(false);
  const [viewingUser, setViewingUser] = useState(null);
  const [researchOptIn, setResearchOptIn] = useState(false);
  const [liveStats, setLiveStats] = useState({ events: 0, sessionStartedAt: null });
  const [panelConfirmDeleteId, setPanelConfirmDeleteId] = useState(null);
  const [confirmUnpublishOpen, setConfirmUnpublishOpen] = useState(false);
  const [formatActive, setFormatActive] = useState({ bold: false, italic: false });
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [previewMode, setPreviewMode]     = useState(false);
  const [previewPages, setPreviewPages]   = useState([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  const editorRef      = useRef(null);
  const titleEditorRef = useRef(null);
  const containerRef   = useRef(null);
  const formatBarRef   = useRef(null);
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

  // Online/offline — drives the "offline — saved locally" indicator.
  useEffect(() => {
    const on  = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online",  on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online",  on);
      window.removeEventListener("offline", off);
    };
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
    const { events, startedAt } = rec.snapshot(docId);
    // Always update the visible live counter — even on tiny sample sizes,
    // so the research indicator ticks up in real time.
    const lastT = events.length ? events[events.length - 1].t : null;
    setLiveStats({
      events: events.length,
      sessionStartedAt: startedAt || null,
      lastEventAt: lastT,
    });
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
          velocity_series:   score.velocity_series  || [],
          avg_wpm:           score.avg_wpm          || 0,
          peak_wpm:          score.peak_wpm         || 0,
          active_time_ms:    score.active_time_ms   || 0,
          thinking_pauses:   score.thinking_pauses  || 0,
          active_ratio:      score.active_ratio     || 0,
          typed_chars:       features.typed_chars   || 0,
          words:             features.words         || 0,
          // Take the max so a page reload (which resets in-memory events) never
          // erases a previously observed higher session count.
          session_count: Math.max(
            prevDoc?.scoreFeatures?.session_count || 0,
            score.session_count || 0,
          ),
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
      addToast(avatarData ? "Profile picture updated." : "Profile picture removed.");
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

  const loadDocIntoEditor = useCallback((doc, { preserveLocalTitle = false } = {}) => {
    const el = editorRef.current;
    if (!el) return;
    const incomingTitle = doc.title || "";
    const finalTitle = (preserveLocalTitle && !incomingTitle && titleRef.current)
      ? titleRef.current : incomingTitle;
    titleRef.current = finalTitle;
    if (titleEditorRef.current) setTitleHtml(titleEditorRef.current, finalTitle);
    contentRef.current = doc.content;
    setEditorHtml(el, doc.content);
    setWords(wordCount(doc.content));
    writingBaseRef.current = doc.writingTimeSecs || 0;
    writingFlushRef.current = 0;
    writingSessionStartRef.current = null;
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
      // Use live in-memory docs/activeId — localStorage may be stale or empty for
      // a brand-new session where initState created a doc but saveState hasn't fired yet.
      const localDocs = docsRef.current.map(normaliseDoc);
      const hasLocalContent = localDocs.some(d => stripHtml(d.content).trim()) || !!stripHtml(titleRef.current).trim();
      let merged = (hasLocalContent || !cloudDocs.length)
        ? mergeDocs(localDocs, cloudDocs) : cloudDocs;
      if (!merged.length) merged = [createDoc()];
      merged = merged.map(normaliseDoc);
      const cloudIds = new Set(cloudDocs.map(d => d.id));
      for (const doc of merged)
        if (!cloudIds.has(doc.id) && stripHtml(doc.content).trim())
          await pushDocToCloud(doc, signedInUser.id);
      const currentActiveId = activeIdRef.current;
      const newActiveId = merged.find(d => d.id === currentActiveId) ? currentActiveId : merged[0].id;
      setDocs(merged); saveState(merged, newActiveId); setActiveId(newActiveId);
      const docToLoad = merged.find(d => d.id === newActiveId);
      if (docToLoad) loadDocIntoEditor(docToLoad, { preserveLocalTitle: true });
      const myPubs = await fetchMyPublications(signedInUser.id);
      setPublishedDocIds(new Set(myPubs.map(p => p.doc_id).filter(Boolean)));
      const prof = await fetchProfile(signedInUser.id);
      if (prof) {
        setProfile(prof);
        const opt = !!prof.research_opt_in;
        optInRef.current = opt;
        setResearchOptIn(opt);
      } else {
        setUsernameModalOpen(true);
        // New user — UsernameModal will set opt-in=true via T&C acceptance.
        optInRef.current = false;
        setResearchOptIn(false);
      }
      recorderRef.current?.recordUserChange(signedInUser.id);
      // Claim any pre-signed-in events captured on this device so they sync too.
      claimAnonymousEvents(signedInUser.id);
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) syncOnLogin(session.user);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session?.user) syncOnLogin(session.user);
      if (event === "PASSWORD_RECOVERY") {
        setUpdatePasswordOpen(true);
        setAuthOpen(false);
      }
      if (event === "SIGNED_OUT") {
        syncedUserRef.current = null;
        setUser(null); setPublishedDocIds(new Set()); setProfile(null); setUsernameModalOpen(false);
        setResearchOptIn(false); optInRef.current = false;
        recorderRef.current?.recordUserChange(null);
      }
    });

    // In Supabase v2 PKCE flow the PASSWORD_RECOVERY event fires during client
    // initialisation (module level), before React registers the listener above,
    // so we detect the recovery landing via the ?recovery=1 param we set in
    // redirectTo and open the modal directly.
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("recovery") === "1") {
        setUpdatePasswordOpen(true);
        setAuthOpen(false);
        params.delete("recovery");
        const qs = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
      }
    } catch {}
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
        return [fresh];
      }
      const next = prev.filter(d => d.id !== id);
      const newActive = id === activeId ? next[0].id : activeId;
      if (id === activeId) {
        if (scoreTimerRef.current) { clearTimeout(scoreTimerRef.current); scoreTimerRef.current = null; }
        recorderRef.current?.recordDocSwitch(newActive);
        setActiveId(newActive);
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
    if (next) {
      // Push the queued events right away so the user sees data flowing.
      syncFlushNow();
      addToast("Sharing turned on.");
    } else {
      // Drop pending local events so opt-out is immediate and complete.
      await clearLocalForUser(userRef.current.id);
      addToast("Sharing turned off.");
    }
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
    applySmartTypography();
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
    titleRef.current = el.innerHTML;
    setSaveStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const capturedId = activeId;
    const capturedTitle = el.innerHTML;
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
  //
  // Renders every page onto a high-DPI canvas (paper texture + ink in
  // multiply blend mode) and embeds each as a JPEG image in a custom-sized
  // PDF, so the result is visually indistinguishable from a scanned book.

  const downloadDoc = useCallback(async ({ format, style }) => {
    const text = contentRef.current || "";
    if (!stripHtml(text).trim()) return;
    const titleStr = stripHtml(titleRef.current).trim();
    const safeName = titleStr.replace(/[^a-zA-Z0-9\s\-_]/g, "").trim() || "inkk";
    const preset = PAGE_PRESETS[
      format === "png-square"   ? "square"   :
      format === "png-portrait" ? "portrait" :
      "book"
    ];
    // PNG outputs default to inkk background; user can override.
    const paperTexture = style.paperTexture ?? (format === "pdf");
    const renderOptions = {
      pageW: preset.w,
      pageH: preset.h,
      dropCap:         style.dropCap         ?? true,
      justify:         style.justify         ?? true,
      titleGap:        style.titleGap        ?? "normal",
      paragraphIndent: style.paragraphIndent ?? true,
      paperTexture,
    };

    try {
      if (format === "pdf") {
        const pdf = new jsPDF({ unit: "pt", format: [preset.w, preset.h], compress: true });
        const byline = profile?.display_name || profile?.username || "";
        await renderBookPdfPages({
          title: titleStr,
          byline,
          html: text,
          options: renderOptions,
          async onPage(canvas, pageIndex) {
            if (pageIndex > 0) pdf.addPage([preset.w, preset.h]);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
            pdf.addImage(dataUrl, "JPEG", 0, 0, preset.w, preset.h, undefined, "MEDIUM");
          },
        });
        pdf.save(`${safeName}.pdf`);
      } else {
        // PNG — only the first page becomes the image.
        const byline = profile?.display_name || profile?.username || "";
        let pngBlob = null;
        await renderBookPdfPages({
          title: titleStr,
          byline,
          html: text,
          options: renderOptions,
          async onPage(canvas, pageIndex) {
            if (pageIndex > 0 || pngBlob) return;
            pngBlob = await new Promise(res => canvas.toBlob(res, "image/png"));
          },
        });
        if (!pngBlob) { addToast("Nothing to export."); return; }
        const url = URL.createObjectURL(pngBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("Download failed:", err);
      addToast("Download failed.");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addToast, profile?.display_name, profile?.username]);

  const openDownloadModal = useCallback(() => {
    if (!stripHtml(contentRef.current || "").trim()) return;
    setDownloadModalOpen(true);
  }, []);

  // ─ keyboard shortcuts ───────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (view === "editor") openDownloadModal(); }
      if ((e.metaKey || e.ctrlKey) && e.key === ".") { e.preventDefault(); if (view === "editor") setFocusMode(v => !v); }
      if (e.key === "Escape") {
        if (focusMode) { setFocusMode(false); return; }
        if (publishMenuOpen) { setPublishMenuOpen(false); setConfirmUnpublishOpen(false); return; }
        if (publishModalDoc) { setPublishModalDoc(null); return; }
        if (downloadModalOpen) { setDownloadModalOpen(false); return; }
        if (usernameModalOpen) return;
        setPanelOpen(false); setAuthOpen(false); setHsModalOpen(false); setHsScoreOpen(false);
        if (view !== "editor") { window.history.back(); return; }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openDownloadModal, view, focusMode, publishMenuOpen, publishModalDoc, downloadModalOpen, usernameModalOpen]);

  // ─ mount ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    isMobileRef.current = isMobile();
    const doc = initDocs.find(d => d.id === initActiveId) || initDocs[0];
    if (doc) {
      titleRef.current = doc.title || "";
      contentRef.current = doc.content;
      writingBaseRef.current = doc.writingTimeSecs || 0;
      if (titleEditorRef.current) setTitleHtml(titleEditorRef.current, doc.title || "");
      const el = editorRef.current;
      if (el) {
        setEditorHtml(el, doc.content);
        if (!isMobileRef.current) el.focus();
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

  // ─ format toolbar ───────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = () => {
      const sel = window.getSelection();
      const bar = formatBarRef.current;
      if (!bar) return;
      const ed = editorRef.current;
      const ti = titleEditorRef.current;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        bar.classList.remove("format-bar-visible");
        bar.classList.add("format-bar-hidden");
        return;
      }
      const range = sel.getRangeAt(0);
      const anchor = range.commonAncestorContainer;
      const inEditor = ed && ed.contains(anchor);
      const inTitle  = ti && ti.contains(anchor);
      if (!inEditor && !inTitle) {
        bar.classList.remove("format-bar-visible");
        bar.classList.add("format-bar-hidden");
        return;
      }
      const rect = range.getBoundingClientRect();
      bar.classList.remove("format-bar-hidden");
      bar.classList.add("format-bar-visible");
      const w = bar.offsetWidth || 60;
      const cx = rect.left + rect.width / 2;
      bar.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, cx - w / 2))}px`;
      bar.style.top  = `${Math.max(8, rect.top - bar.offsetHeight - 8)}px`;
      try {
        setFormatActive({
          bold:   document.queryCommandState("bold"),
          italic: document.queryCommandState("italic"),
        });
      } catch {}
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, []);

  const applyFormat = useCallback((cmd) => {
    document.execCommand(cmd);
    // Trigger save by re-firing input on whichever editor has focus
    const active = document.activeElement;
    if (active === titleEditorRef.current) onTitleInput();
    else if (active === editorRef.current) onInput();
    try {
      setFormatActive({
        bold:   document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
      });
    } catch {}
  }, [onTitleInput, onInput]);

  // ─ editor preview canvas rendering ─────────────────────────────────────────
  useEffect(() => {
    if (!previewMode) { setPreviewPages([]); return; }
    setPreviewPages([]);
    setPreviewLoading(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    renderBookPdfPages({
      title: stripHtml(titleRef.current) || "Untitled",
      byline: profileRef.current?.display_name || profileRef.current?.username || "",
      html: contentRef.current || "",
      options: { dropCap: true, justify: true, paragraphIndent: true, paperTexture: true },
      async onPage(canvas) {
        const url = canvas.toDataURL("image/jpeg", 0.95);
        setPreviewPages(prev => [...prev, url]);
      },
    }).then(() => setPreviewLoading(false))
      .catch(() => setPreviewLoading(false));
  }, [previewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─ render ───────────────────────────────────────────────────────────────────

  const isEditor  = view === "editor";
  if (!isEditor && previewMode) setPreviewMode(false);
  const menuClass = menuVisible ? "menu-visible" : "menu-hidden";

  const sortedDocs   = [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
  const hasContent   = words > 0;
  const isPublished  = publishedDocIds.has(activeId);

  const openReading = useCallback((pub, opts = {}) => {
    setReadingFocus(opts.focus || null);
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
      {/* ── offline banner ── */}
      {!online && (
        <div id="offline-banner" role="status">
          Offline · changes are saved on this device and will sync when you reconnect.
        </div>
      )}

      <header id="top-bar">
        <div id="top-bar-left">
          {isEditor && (
            <button
              className="icon-btn icon-btn-labelled"
              onClick={() => setPanelOpen(v => !v)}
              title="Open documents"
              aria-label="Open documents"
            >
              <Menu size={18} />
              <span className="icon-btn-label">Drafts</span>
              {docs.length > 1 && <span className="icon-btn-count">{docs.length}</span>}
            </button>
          )}
          {(view === "reading" || view === "userProfile") && (
            <button className="icon-btn" onClick={goBack} title="Back">
              <ArrowLeft size={18} />
            </button>
          )}
        </div>
        <div id="top-bar-center">
          <span id="brand" onClick={() => navigate("editor")} style={{ cursor: "pointer" }} role="button" tabIndex={0}>inkk.</span>
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
                  if (isPublished) { setConfirmUnpublishOpen(false); setPublishMenuOpen(v => !v); }
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
                  {!confirmUnpublishOpen ? (
                    <>
                      <button className="publish-menu-item" onClick={() => {
                        setPublishMenuOpen(false);
                        const doc = docs.find(d => d.id === activeId);
                        if (doc) openPublishModal(doc);
                      }}>Update</button>
                      <button
                        className="publish-menu-item publish-menu-danger"
                        onClick={() => setConfirmUnpublishOpen(true)}
                      >Remove from feed</button>
                    </>
                  ) : (
                    <>
                      <div className="publish-menu-prompt">Remove this piece from the public feed?</div>
                      <button className="publish-menu-item" onClick={() => { setConfirmUnpublishOpen(false); setPublishMenuOpen(false); }}>Cancel</button>
                      <button
                        className="publish-menu-item publish-menu-danger"
                        onClick={() => {
                          setConfirmUnpublishOpen(false);
                          setPublishMenuOpen(false);
                          doUnpublish(activeId).then(() => {
                            setPublishedDocIds(prev => { const s = new Set(prev); s.delete(activeId); return s; });
                            addToast("Removed from feed.");
                          });
                        }}
                      >Yes, remove</button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {isEditor && hasContent && (
            <button
              className={`icon-btn icon-btn-preview${previewMode ? " active" : ""}`}
              onClick={() => setPreviewMode(v => !v)}
              title={previewMode ? "Back to editing" : "Preview as published"}
            >
              {previewMode ? <EyeOff size={14} /> : <Eye size={14} />}
              <span className="btn-label">{previewMode ? "Edit" : "Preview"}</span>
            </button>
          )}
          {isEditor && hasContent && (
            <button id="pdf-btn" className={menuClass} onClick={openDownloadModal} title="Download  ⌘S">
              <Download size={13} />
              <span className="btn-label">Download</span>
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
                  <span className="doc-item-title">{stripHtml(d.title || "") || docTitle(d.content)}</span>
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
                  <button className="doc-pdf" onClick={openDownloadModal} title="Download  ⌘S">
                    <Download size={11} />
                  </button>
                  {docs.length > 1 && (
                    panelConfirmDeleteId === d.id ? (
                      <span className="doc-confirm" onClick={e => e.stopPropagation()}>
                        <span className="doc-confirm-text">Delete?</span>
                        <button
                          className="doc-confirm-cancel"
                          onClick={e => { e.stopPropagation(); setPanelConfirmDeleteId(null); }}
                        >Cancel</button>
                        <button
                          className="doc-confirm-yes"
                          onClick={e => { deleteDoc(d.id, e); setPanelConfirmDeleteId(null); }}
                        >Delete</button>
                      </span>
                    ) : (
                      <button
                        className="doc-delete"
                        title="Delete document"
                        onClick={e => { e.stopPropagation(); setPanelConfirmDeleteId(d.id); }}
                      >
                        <Trash2 size={11} />
                      </button>
                    )
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

      {/* ── writing stats (editor) ── data about the piece, no score ── */}
      {isEditor && (
        <div id="hs-editor-status" className={menuClass}>
          {(() => {
            const doc = docs.find(d => d.id === activeId);
            const wtSecs = doc?.writingTimeSecs || 0;
            const saving = saveStatus === "saving";
            const statusText = saving
              ? (user && online ? "saving…" : "saving locally…")
              : (!user
                ? "saved on this device"
                : (online ? "saved" : "offline — saved locally, will sync"));
            return (
              <div className="writing-stats">
                <span className="ws-stat">{words.toLocaleString()} {words === 1 ? "word" : "words"}</span>
                {wtSecs >= 30 && (<>
                  <span className="ws-sep">·</span>
                  <span className="ws-stat">{formatWritingTime(wtSecs)} writing</span>
                </>)}
                {liveStats.events > 0 && researchOptIn && user && (<>
                  <span className="ws-sep">·</span>
                  <span className="ws-stat">{liveStats.events.toLocaleString()} events</span>
                </>)}
                {isPublished && (<>
                  <span className="ws-sep">·</span>
                  <span className="ws-stat ws-published">published</span>
                </>)}
                {(() => {
                  const sf = doc?.scoreFeatures;
                  const hasScore = doc?.humanScore != null && doc?.scoreTier && (sf?.confidence || 0) > 0.08;
                  if (!hasScore) return null;
                  const tierList = ["Faint","Developing","Strong","Distinct"];
                  const filled = tierList.indexOf(doc.scoreTier) + 1;
                  return (<>
                    <span className="ws-sep">·</span>
                    <button className="ws-stat ws-process-btn" onClick={() => setHsScoreOpen(true)} title="View writing process signal">
                      {tierList.map((_, i) => (
                        <span key={i} className={`hs-dot-xs ${i < filled ? "on" : "off"}`} />
                      ))}
                      <span style={{ marginLeft: 5 }}>{doc.scoreTier}</span>
                      <span className="ws-process-expand">↗</span>
                    </button>
                  </>);
                })()}
                <span className="ws-sep">·</span>
                <span className={`ws-status ${saving ? "saving" : (online ? "ok" : "off")}`}>
                  <span className="hs-status-dot" aria-hidden="true" />
                  {statusText}
                </span>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── Research participation indicator (only when opted in) ── */}
      {isEditor && user && researchOptIn && (
        <button
          id="research-strip"
          className={menuClass}
          onClick={() => setHsModalOpen(true)}
          aria-label="About inkk research"
          title="Click for info — your typing patterns contribute to a research study (no characters stored)"
        >
          <span className="research-pulse" aria-hidden="true" />
          <span className="research-strip-text">
            recording · {liveStats.events.toLocaleString()} {liveStats.events === 1 ? "event" : "events"}
            {liveStats.sessionStartedAt && ` · ${Math.max(1, Math.round((Date.now() - liveStats.sessionStartedAt) / 60000))}m`}
          </span>
        </button>
      )}

      {/* ── editor (always mounted) ── */}
      <div
        id="text-container"
        ref={containerRef}
        style={{ display: isEditor ? "" : "none" }}
      >
        <div
          id="title-input"
          ref={titleEditorRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          data-placeholder="Title"
          className={font === "arial" ? "font-arial" : ""}
          onInput={onTitleInput}
          onBlur={() => { titleRef.current = titleEditorRef.current?.innerHTML ?? ""; }}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); titleRef.current = titleEditorRef.current?.innerHTML ?? ""; editorRef.current?.focus(); } }}
          onPaste={e => {
            e.preventDefault();
            const text = (e.clipboardData?.getData("text/plain") || "").replace(/\s*\n\s*/g, " ");
            document.execCommand("insertText", false, text);
          }}
        />
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

      {/* ── floating format toolbar (appears on selection in title/body) ── */}
      <div id="format-toolbar" ref={formatBarRef} className="format-bar-hidden">
        <button
          type="button"
          className={`format-btn${formatActive.bold ? " active" : ""}`}
          onMouseDown={e => { e.preventDefault(); applyFormat("bold"); }}
          title="Bold  ⌘B"
        ><b>B</b></button>
        <button
          type="button"
          className={`format-btn${formatActive.italic ? " active" : ""}`}
          onMouseDown={e => { e.preventDefault(); applyFormat("italic"); }}
          title="Italic  ⌘I"
        ><i>I</i></button>
      </div>

      {/* ── editor preview overlay ── */}
      {isEditor && previewMode && (
        <div id="editor-preview-container">
          <div id="reading-pages">
            {previewLoading && previewPages.length === 0 && (
              <p className="reading-pages-loading">rendering…</p>
            )}
            {previewPages.map((url, i) => (
              <img key={i} className="reading-page-img" src={url} alt="" />
            ))}
          </div>
        </div>
      )}

      {/* ── views ── */}
      {view === "feed" && (
        <Feed
          user={user}
          onRead={openReading}
          onAuthorClick={openUserProfile}
          dropCapImages={dropCapImages}
          onRequestAuth={() => setAuthOpen(true)}
        />
      )}
      {view === "profile" && (
        <Profile
          user={user}
          profile={profile}
          localDocs={docs}
          publishedDocIds={publishedDocIds}
          streak={streak}
          dropCapImages={dropCapImages}
          onRead={openReading}
          onUnpublish={docId => setPublishedDocIds(prev => { const s = new Set(prev); s.delete(docId); return s; })}
          onSignIn={() => setAuthOpen(true)}
          onSignOut={signOut}
          onAvatarChange={handleAvatarChange}
          onEditDoc={(id) => { switchDoc(id); navigate("editor"); }}
          onNewDoc={() => { newDoc(); navigate("editor"); }}
          onDeleteDoc={(id) => deleteDoc(id, { stopPropagation: () => {} })}
          onPublishDoc={(d) => openPublishModal(d)}
          researchOptIn={researchOptIn}
          onToggleOptIn={toggleResearchOptIn}
          onDownloadData={downloadResearchData}
          onDeleteData={deleteResearchData}
          onChangePassword={() => setUpdatePasswordOpen(true)}
          onProfileUpdate={(updatedProfile) => setProfile(updatedProfile)}
        />
      )}
      {view === "search" && (
        <SearchView onViewUser={openUserProfile} dropCapImages={dropCapImages} />
      )}
      {view === "userProfile" && viewingUser && (
        <UserProfileView
          profile={viewingUser}
          onRead={openReading}
          dropCapImages={dropCapImages}
          user={user}
          onRequestAuth={() => setAuthOpen(true)}
        />
      )}
      {view === "reading" && readingPub && (
        <ReadingView
          pub={readingPub}
          user={user}
          dropCapImages={dropCapImages}
          focus={readingFocus}
          onRequestAuth={() => setAuthOpen(true)}
          onAuthorClick={openUserProfile}
        />
      )}

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
      {downloadModalOpen && (
        <DownloadModal onConfirm={downloadDoc} onClose={() => setDownloadModalOpen(false)} />
      )}
      {authOpen && supabase && <AuthModal onClose={() => setAuthOpen(false)} />}
      {hsModalOpen && <HumanSignalModal onClose={() => setHsModalOpen(false)} />}
      {hsScoreOpen && (() => {
        const doc = docs.find(d => d.id === activeId);
        if (!doc?.scoreFeatures) return null;
        const scoreObj = { score: doc.humanScore, tier: doc.scoreTier, ...doc.scoreFeatures };
        return <HumanSignalPanel score={scoreObj} onClose={() => setHsScoreOpen(false)} />;
      })()}
      {usernameModalOpen && user && (
        <UsernameModal user={user} onDone={prof => {
          setProfile(prof);
          setUsernameModalOpen(false);
          if (prof.research_opt_in) {
            optInRef.current = true;
            setResearchOptIn(true);
            syncFlushNow();
          }
        }} />
      )}
      {updatePasswordOpen && (
        <UpdatePasswordModal
          onClose={() => setUpdatePasswordOpen(false)}
          onDone={() => addToast("Password updated.")}
        />
      )}

      {/* ── focus mode exit ── */}
      {focusMode && (
        <button id="focus-exit" onClick={() => setFocusMode(false)} title="Exit focus mode  ⌘.">
          <Minimize2 size={14} />
        </button>
      )}

      {/* ── publish menu backdrop ── */}
      {publishMenuOpen && <div id="publish-menu-backdrop" onClick={() => { setPublishMenuOpen(false); setConfirmUnpublishOpen(false); }} />}

      {/* ── toasts ── */}
      <Toasts toasts={toasts} />
    </>
  );
}
