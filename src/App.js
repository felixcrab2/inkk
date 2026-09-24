import "./styles/index.css";
import "@fontsource/im-fell-english/400.css";
import "@fontsource/im-fell-english/400-italic.css";
import "@fontsource/eb-garamond/400.css";
import "@fontsource/eb-garamond/400-italic.css";
import "@fontsource/eb-garamond/500.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Menu, Check, Download, Maximize2, Minimize2, Plus, Trash2, MoreHorizontal, X, Eye, EyeOff } from "lucide-react";
import { PenNib as PPen, Notebook as PNotes, SealCheck as PSeal } from "@phosphor-icons/react";
import { jsPDF } from "jspdf";
import { supabase } from "./supabase";
import { renderBookPdfPages, PAGE_PRESETS } from "./pdf/bookPage";
import { createRecorder } from "./telemetry/recorder";
import { extractFeatures } from "./telemetry/features";
import { computeScore } from "./telemetry/score";
import { startSync, stopSync, setResearchOptIn as remoteSetResearchOptIn, deleteMyEvents, dumpMyEvents, flushNow as syncFlushNow } from "./telemetry/sync";
import { claimAnonymous as claimAnonymousEvents, clearForUser as clearLocalForUser, dumpForUser as dumpLocalForUser } from "./telemetry/store";
import { HumanSignalPanel } from "./components/HumanSignal";
import { TOS_VERSION, PrivacyModal, TermsModal } from "./components/Legal";
import { isVerifiedTier, sealUrl } from "./verify/code";
import { NotesView } from "./views/Notes";
import { CertifyView } from "./views/Certify";
import { createDoc, normaliseDoc, saveState, loadOwner, saveOwner, initState, stripHtml, setEditorHtml, setTitleHtml, docTitle, wordCount, loadStreak, touchStreak } from "./lib/docs";
import { applySmartTypography, caretRangeAt, compressImage, titleCase, liveTitleCase, titleCaretOffset, setTitleCaret, isMobile } from "./lib/text";
import { formatWritingTime } from "./lib/format";
import { fetchCloudDocs, fetchCloudDoc, pushDocToCloud, deleteDocFromCloud, mergeDocs } from "./lib/cloud";
import { ensureCertificate, fingerprintOf, certMatches } from "./lib/certify";
import { docxOf } from "./lib/docx";
import { withTextChunks } from "./lib/png";
import { fetchProfile, upsertProfile, generateUniqueUsername } from "./lib/profile";
import { viewToPath, pathToView, pathToLegal } from "./lib/routes";
import { enterBrowserFullscreen, exitBrowserFullscreen } from "./lib/fullscreen";
import { Toasts } from "./components/Toasts";
import { imgForPub, Backdrop } from "./components/Backdrop";
import { LandingScreen } from "./components/Landing";
import { HumanSignalModal } from "./components/HumanSignalModal";
import { AuthModal, UpdatePasswordModal } from "./components/AuthModal";
import { DownloadModal } from "./components/DownloadModal";
import { ImageToolbar } from "./components/ImageToolbar";

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const { docs: initDocs, activeId: initActiveId } = initState();

  const [docs, setDocs]               = useState(initDocs);
  const [activeId, setActiveId]       = useState(initActiveId);
  const [menuVisible, setMenuVisible] = useState(true);
  const [verifyStatus, setVerifyStatus] = useState("idle"); // mirrors VerifyView (backdrop ring vs band)
  const [panelOpen, setPanelOpen]     = useState(false);
  const [saveStatus, setSaveStatus]   = useState("saved");
  const [online, setOnline]           = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );
  const [words, setWords]             = useState(() => wordCount(initDocs.find(d => d.id === initActiveId)?.content));
  const [user, setUser]               = useState(null);
  const [authOpen, setAuthOpen]       = useState(false);
  const [authMode, setAuthMode]       = useState("signin"); // which tab the modal opens on
  const [view, setView]               = useState(() => pathToView(window.location.pathname));
  const [legalPage, setLegalPage]     = useState(() => pathToLegal(window.location.pathname));
  const viewRef = useRef(pathToView(window.location.pathname));
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { if (view !== "editor") setToolsOpen(false); }, [view]);
  // inkk.site/signin (linked from the desktop companion) opens sign-in over
  // the Notes page; ?reset=1 opens the password reset.
  useEffect(() => {
    if (window.location.pathname !== "/signin") return;
    const reset = new URLSearchParams(window.location.search).get("reset") === "1";
    setAuthMode(reset ? "reset" : "signin");
    setAuthOpen(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const explicitSignOutRef = useRef(false);   // only a deliberate Sign out wipes local notes
  const inAppDepthRef = useRef(0);            // history entries this app pushed; Escape only goes back over those
  const [certMenuOpen, setCertMenuOpen] = useState(false);
  const [certStale, setCertStale]       = useState(false);
  const [certConfirmOpen, setCertConfirmOpen] = useState(false); // mobile: explain Certify before acting
  const [certifying, setCertifying]   = useState(false);
  const [verifyCode, setVerifyCode]   = useState(() =>
    window.location.pathname.startsWith("/v/") ? window.location.pathname.slice(3) : "");
  const [font, setFont]               = useState(() => {
    const v = localStorage.getItem("inkk_face");
    return ["fell", "garamond", "sans"].includes(v) ? v : "fell";
  });
  const [faceMenuOpen, setFaceMenuOpen] = useState(false);
  const [titleCapsOn, setTitleCapsOn] = useState(() => localStorage.getItem("inkk_title_caps") !== "0");
  const [toolsOpen, setToolsOpen]     = useState(false);   // the editor's tools row, folded away until asked for
  const [showLanding, setShowLanding] = useState(() =>
    !localStorage.getItem("inkk_visited") ||
    !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()));
  const [hsModalOpen, setHsModalOpen] = useState(false);
  const [hsScoreOpen, setHsScoreOpen]   = useState(false);
  const [streak, setStreak]           = useState(() => loadStreak().count);
  const [toasts, setToasts]           = useState([]);
  const [focusMode, setFocusMode]     = useState(false);
  const [profile, setProfile]         = useState(null);
  const [dropCapImages, setDropCapImages] = useState({});
  const [updatePasswordOpen, setUpdatePasswordOpen] = useState(false);
  const [researchOptIn, setResearchOptIn] = useState(false);
  const [liveStats, setLiveStats] = useState({ events: 0, sessionStartedAt: null });
  const [panelConfirmDeleteId, setPanelConfirmDeleteId] = useState(null);
  const [formatActive, setFormatActive] = useState({ bold: false, italic: false });
  const [downloadModalOpen, setDownloadModalOpen] = useState(false);
  const [previewMode, setPreviewMode]     = useState(false);
  const [previewPages, setPreviewPages]   = useState([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  const editorRef      = useRef(null);
  const titleEditorRef = useRef(null);
  const containerRef   = useRef(null);
  const formatBarRef   = useRef(null);
  const imgElRef       = useRef(null);   // currently-selected editor image
  const imgPanelRef    = useRef(null);   // the floating image toolbar
  const [imgTool, setImgTool] = useState(null); // editor image selection: { rect, width, align }
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
  // The chosen face is a root attribute: the editor, the Notes index, the
  // Certify page and the PDF renderer all read it from there.
  useEffect(() => { localStorage.setItem("inkk_face", font); document.documentElement.dataset.face = font; }, [font]);
  useEffect(() => { localStorage.setItem("inkk_title_caps", titleCapsOn ? "1" : "0"); }, [titleCapsOn]);
  useEffect(() => {
    fetch("/drop_caps/manifest.json").then(r => r.json()).then(setDropCapImages).catch(() => {});
  }, []);

  // Safety net: never let a file dropped outside the editor navigate the app
  // away (the browser's default for a file drop is to open it).
  useEffect(() => {
    const prevent = (e) => { if (Array.from(e.dataTransfer?.types || []).includes("Files")) e.preventDefault(); };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
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

  // ── native safe areas ────────────────────────────────────────────────────
  // Capacitor's webview reports env(safe-area-inset-*) as 0, so the notch and
  // home indicator would sit on top of the UI. The plugin reads the real insets
  // natively and publishes them as --safe-area-inset-* for the CSS to use. On
  // the web this import resolves to a no-op implementation.
  useEffect(() => {
    let cancelled = false;
    // Both plugins reject with "not implemented on web" outside the native
    // shell, so only ask for them there (and swallow their own rejections).
    const native = !!window.Capacitor?.isNativePlatform?.();
    if (native) {
      import("@capacitor-community/safe-area")
        .then(({ SafeArea }) => { if (!cancelled) return SafeArea?.enable?.({ config: {} }); })
        .catch(() => { /* plugin unavailable */ });
      // iOS puts a prev/next/Done bar above the keyboard. On a page that is just
      // paper and a sentence it is the only piece of furniture left, so remove it.
      import("@capacitor/keyboard")
        .then(({ Keyboard }) => { if (!cancelled) return Keyboard?.setAccessoryBarVisible?.({ isVisible: false }); })
        .catch(() => {});
    }
    // OAuth comes home via inkk://auth-callback?code=…: exchange the code for a
    // session inside THIS webview (the PKCE verifier lives in its storage), and
    // close the in-app browser sheet the flow ran in.
    let removeUrlListener = null;
    if (window.Capacitor?.isNativePlatform?.()) {
      import("@capacitor/app").then(({ App: CapApp }) => {
        if (cancelled) return;
        CapApp.addListener("appUrlOpen", async ({ url }) => {
          try {
            const u = new URL(url);
            const code = u.searchParams.get("code");
            if (code && supabase) {
              await supabase.auth.exchangeCodeForSession(code);
              import("@capacitor/browser").then(({ Browser }) => Browser.close().catch(() => {})).catch(() => {});
            }
          } catch { /* not an auth link */ }
        }).then(h => { removeUrlListener = () => h.remove(); });
      }).catch(() => {});
    }
    return () => { cancelled = true; removeUrlListener?.(); };
  }, []);

  // ── on-screen keyboard (phones) ──────────────────────────────────────────
  // visualViewport is the only reliable way to know how much of the window the
  // keyboard is covering. Publish it as --kb-inset so the editor can sit above
  // the keyboard, and flag body.keyboard-open for the typewriter scroll rule.
  // No-ops on desktop: the inset stays 0 and the class is never added.
  const [kbOpen, setKbOpen] = useState(false);
  // Phone editor modes. editArmed: the body is only contenteditable while
  // actually writing — in read mode it is plain text, so drags scroll it
  // exactly like the feed instead of fighting WKWebView's text-interaction
  // gestures. chromeHidden: the first keystroke fades ALL the furniture (top
  // bar, drafts, studying strip) and it stays away while reading; the corner
  // control (tick while writing, ⋯ while reading) is the one obvious way back.
  const [editArmed, setEditArmed]       = useState(false);
  const [chromeHidden, setChromeHidden] = useState(false);
  const editorTapRef = useRef(null);
  useEffect(() => {
    if (kbOpen && isMobile()) setChromeHidden(true);
    if (!kbOpen) setEditArmed(false);
  }, [kbOpen]);
  useEffect(() => {
    document.body.classList.toggle("chrome-hidden", view === "editor" && chromeHidden);
    return () => document.body.classList.remove("chrome-hidden");
  }, [view, chromeHidden]);
  useEffect(() => {
    const setInset = (inset) => {
      document.documentElement.style.setProperty("--kb-inset", `${Math.round(inset)}px`);
      document.body.classList.toggle("keyboard-open", inset > 80);
      setKbOpen(inset > 80);
    };

    // Native app: the keyboard events come from the OS and are the ground
    // truth. visualViewport is NOT reliable here — with Keyboard.resize "none"
    // the WKWebView's viewport never changes when the keyboard rises, so the
    // web-side listener below would simply never fire (the app carried on as
    // if the keyboard didn't exist: no typewriter scroll, nav not hidden,
    // text left covered).
    if (window.Capacitor?.isNativePlatform?.()) {
      let handles = [];
      let cancelled = false;
      import("@capacitor/keyboard").then(({ Keyboard }) => {
        if (cancelled) return;
        Keyboard.addListener("keyboardWillShow", info => setInset(info?.keyboardHeight || 0))
          .then(h => handles.push(h));
        Keyboard.addListener("keyboardWillHide", () => setInset(0))
          .then(h => handles.push(h));
      }).catch(() => {});
      return () => {
        cancelled = true;
        handles.forEach(h => h.remove());
        document.body.classList.remove("keyboard-open");
        setKbOpen(false);
      };
    }

    // Mobile web: visualViewport does shrink for the keyboard in Safari.
    const vv = window.visualViewport;
    // Phones only. On desktop, browser zoom also shrinks the visual viewport,
    // which would otherwise look exactly like a keyboard appearing.
    if (!vv || !window.matchMedia("(pointer: coarse)").matches) return;
    let raf = 0;
    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        setInset(inset);
      });
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.body.classList.remove("keyboard-open");
      setKbOpen(false);
    };
  }, []);

  // ── done writing, for now (phones) ──────────────────────────────────────────
  // The iOS Done bar was removed by design, so while the keyboard is up the
  // editor shows a single tick in the top corner (the Notes gesture): tap it
  // to put the keyboard down and read. Tapping the text just moves the caret,
  // and a drag scrolls with the keyboard staying up. Blur releases web focus;
  // Keyboard.hide() is the native belt-and-braces because a bare blur() does
  // not always lower the keyboard in WKWebView.
  const dismissKeyboard = useCallback(() => {
    document.activeElement?.blur?.();
    import("@capacitor/keyboard").then(({ Keyboard }) => Keyboard.hide()).catch(() => {});
  }, []);

  useEffect(() => {
    if (focusMode) document.body.classList.add("focus-mode");
    else document.body.classList.remove("focus-mode");
  }, [focusMode]);

  // Focus mode also drives genuine browser fullscreen. Both helpers must run
  // straight off the user gesture (click / keypress), so toggle here rather
  // than inside an effect.
  const toggleFocusMode = useCallback(() => {
    setFocusMode(prev => {
      if (prev) exitBrowserFullscreen(); else enterBrowserFullscreen();
      return !prev;
    });
  }, []);
  const exitFocusMode = useCallback(() => {
    exitBrowserFullscreen();
    setFocusMode(false);
  }, []);

  // Keep focus mode in sync when the user leaves native fullscreen via Esc / F11.
  useEffect(() => {
    const onFsChange = () => {
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!isFs) setFocusMode(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  useEffect(() => {
    if (!showLanding && !isMobileRef.current) editorRef.current?.focus();
  }, [showLanding]);

  const addToast = useCallback((message, type) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 2800);
  }, []);

  // ─── score recompute (debounced) ──────────────────────────────────────────
  // Reassemble the fullest LOCAL keystroke trace we have for a doc: the recorder's
  // in-memory ring plus the IndexedDB queue (which still holds everything for a
  // user who never syncs). /api/certify unions this with the user's synced cloud
  // batches, then recomputes the certified score from the result.
  const gatherDocEvents = useCallback(async (docId) => {
    const byId = new Map();
    try {
      const rec = recorderRef.current;
      if (rec) for (const e of rec.snapshot(docId).events) if (e?.id) byId.set(e.id, e);
    } catch {}
    try {
      const uid = userRef.current?.id;
      if (uid) for (const e of await dumpLocalForUser(uid)) if (e?.doc_id === docId && e?.id) byId.set(e.id, e);
    } catch {}
    return [...byId.values()].sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
  }, []);

  // Write a doc's score + full metrics object (local + cloud). Shared by the live
  // recompute and the on-open restore so both store an identical shape — the same
  // shape a publication carries in publications.score_features.
  const persistDocScore = useCallback((docId, features, score) => {
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
          // Full nine-dimension sub-signal vector (value + confidence, 0..1) for
          // the radar "fingerprint". Stripped of the heavier `raw` payloads.
          dims: Object.entries(score.subs || {}).map(([key, s]) => ({
            key,
            value: Math.round((s.value || 0) * 1000) / 1000,
            conf:  Math.round((s.conf  || 0) * 1000) / 1000,
          })),
          // Pause distribution buckets for the rhythm chart.
          pause_micro: Math.max(0, (features.pause_count_500 || 0) - (features.pause_count_2000 || 0)),
          pause_think: Math.max(0, (features.pause_count_2000 || 0) - (features.pause_count_10000 || 0)),
          pause_long:  features.pause_count_10000 || 0,
          // Cadence + provenance figures.
          iki_median:      Math.round(features.iki?.median || 0),
          iki_n:           features.iki?.n || 0,
          dwell_mean:      Math.round(features.dwell?.mean || 0),
          dwell_n:         features.dwell?.n || 0,
          deleted_chars:   features.deleted_chars   || 0,
          pasted_chars:    features.pasted_chars    || 0,
          typing_events:   features.typing_events   || 0,
          deletion_events: features.deletion_events || 0,
          burst_total_ms:  features.burst_total_ms  || 0,
          total_time_ms:   features.total_time_ms   || 0,
          nav_events:      features.nav_events      || 0,
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
            prev.find(d => d.id === docId)?.scoreFeatures?.session_count || 0,
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

  // The stored score + metrics must only ever move to a *richer* trace, never a
  // thinner one. Without this, reopening a draft (whose in-memory trace starts
  // empty after a reload) would recompute from almost nothing and wipe the whole
  // metrics panel. Typing-event count grows monotonically with writing, so it's a
  // stable "how much was written" measure that survives reloads.
  const isRicherThanStored = useCallback((docId, features) => {
    const prevDoc = docsRef.current.find(d => d.id === docId);
    if (prevDoc?.humanScore == null) return true;          // nothing stored yet
    const prevKeystrokes = prevDoc?.scoreFeatures?.typing_events ?? prevDoc?.keystrokes ?? 0;
    return (features.typing_events || 0) >= prevKeystrokes;
  }, []);

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
    if (!isRicherThanStored(docId, features)) return;   // never thin the stored metrics
    persistDocScore(docId, features, computeScore(features));
  }, [isRicherThanStored, persistDocScore]);

  const scheduleRecompute = useCallback(() => {
    if (scoreTimerRef.current) clearTimeout(scoreTimerRef.current);
    scoreTimerRef.current = setTimeout(recomputeScore, 700);
  }, [recomputeScore]);

  // On opening a doc, rebuild its score + full metrics from the complete LOCAL
  // keystroke trace (in-memory ring ∪ IndexedDB queue). The in-memory ring is
  // empty right after a reload, so this is what restores the panel for a draft
  // written in an earlier session. Guarded by isRicherThanStored, so it can only
  // restore/refresh the metrics, never thin them — and so a doc whose fuller
  // trace lives only in the synced cloud keeps its stored metrics untouched.
  useEffect(() => {
    const docId = activeId;
    if (!docId) return;
    let cancelled = false;
    (async () => {
      const events = await gatherDocEvents(docId);
      if (cancelled || events.length < 8) return;
      const words = wordCount(contentRef.current || "");
      const features = extractFeatures(events, { words });
      if (cancelled || !isRicherThanStored(docId, features)) return;
      persistDocScore(docId, features, computeScore(features));
    })();
    return () => { cancelled = true; };
  }, [activeId, gatherDocEvents, isRicherThanStored, persistDocScore]);

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

  // ─── persist on tab-hide / unload ─────────────────────────────────────────
  // The normal save is debounced 500ms; localStorage.setItem is synchronous, so
  // this reliably lands the active doc even on a hard close/reload, where the
  // debounce timer would otherwise be torn down and lose the last few words.
  useEffect(() => {
    const persistNow = () => {
      const id = activeIdRef.current;
      if (!id) return;
      const liveSecs = writingSessionStartRef.current !== null
        ? (Date.now() - writingSessionStartRef.current) / 1000 : 0;
      const timeToSave = writingBaseRef.current + writingFlushRef.current + liveSecs;
      const next = docsRef.current.map(d =>
        d.id === id
          ? { ...d, title: titleRef.current, content: contentRef.current, updatedAt: Date.now(), writingTimeSecs: timeToSave }
          : d
      );
      saveState(next, id);
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") persistNow(); };
    window.addEventListener("pagehide", persistNow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", persistNow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const navigate = useCallback((newView, opts = {}) => {
    const { code } = opts;
    const url = viewToPath(newView, code);
    if (window.location.pathname !== url) {
      window.history.pushState({ view: newView, code, fromApp: true }, "", url);
      inAppDepthRef.current += 1;
    }
    setView(newView);
    if (newView === "certify") setVerifyCode(code || "");
  }, []);

  // Nav-tab taps go straight from touchend to navigate. WKWebView's
  // synthesized click was arriving unreliably on the floating bar, which is
  // what made tabs take two or three presses; a real touchend never misses.
  // The distance check keeps a scroll-drag across the bar from navigating,
  // and preventDefault suppresses the late synthetic click that would follow.
  const tabTouchStart = useRef({ x: 0, y: 0 });
  const tabTouch = useCallback(go => ({
    onTouchStart: e => {
      const t = e.touches[0];
      if (t) tabTouchStart.current = { x: t.clientX, y: t.clientY };
    },
    onTouchEnd: e => {
      const t = e.changedTouches[0];
      if (t && Math.hypot(t.clientX - tabTouchStart.current.x, t.clientY - tabTouchStart.current.y) < 12) {
        e.preventDefault();
        go();
      }
    },
    onClick: go,
  }), []);

  useEffect(() => {
    const handler = () => {
      // The URL is the truth: history entries written by the old app (or with
      // no state at all) still resolve to the right view.
      const p = window.location.pathname;
      const newView = pathToView(p);
      if (inAppDepthRef.current > 0) inAppDepthRef.current -= 1;
      setView(newView);
      setLegalPage(pathToLegal(p));
      if (newView === "certify") setVerifyCode(p.startsWith("/v/") ? p.slice(3) : "");
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const IDLE_MS = 1200;
  // Where the caret sits on screen while typing on a phone (fraction of the
  // visible editor strip). ~0.4 keeps it above the thumb and below the eyeline.
  const TYPEWRITER_ANCHOR = 0.4;

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
    // Desktop lands the caret at the end, ready to type. On a phone, planting
    // a selection in an editable is itself enough to raise the keyboard (iOS
    // focuses whatever holds the selection), so skip the whole gesture: the
    // keyboard should only appear when the writer taps the body.
    if (!isMobile()) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      el.focus();
    }
  }, []);

  // Wipe device-local writing state back to a single empty draft. Called on sign
  // out so the next account on this device starts clean (their own work is safe
  // in the cloud and re-fetched on next sign in).
  const resetLocalWorkspace = useCallback(() => {
    const fresh = createDoc();
    docsRef.current = [fresh];
    activeIdRef.current = fresh.id;
    setDocs([fresh]);
    setActiveId(fresh.id);
    saveState([fresh], fresh.id);
    saveOwner(null);
    titleRef.current = "";
    contentRef.current = "";
    writingBaseRef.current = 0;
    writingFlushRef.current = 0;
    writingSessionStartRef.current = null;
    setWords(0);
    try { localStorage.removeItem("inkk_streak"); } catch {}
    setStreak(0);
    loadDocIntoEditor(fresh);
  }, [loadDocIntoEditor]);

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
      // If the on-device docs belong to a *different* signed-in user, never merge
      // them into this account — that would leak drafts (and the streak) across
      // accounts on a shared device. Anonymous local work (no owner) still merges,
      // preserving the write-then-sign-up flow.
      const storedOwner = loadOwner();
      const localBelongsToOther = !!storedOwner && storedOwner !== signedInUser.id;
      if (localBelongsToOther) {
        try { localStorage.removeItem("inkk_streak"); } catch {}
        setStreak(0);
      }
      const mergeableLocal = localBelongsToOther ? [] : localDocs;
      const hasLocalContent = mergeableLocal.some(d => stripHtml(d.content).trim())
        || (!localBelongsToOther && !!stripHtml(titleRef.current).trim());
      let merged = (hasLocalContent || !cloudDocs.length)
        ? mergeDocs(mergeableLocal, cloudDocs) : cloudDocs;
      if (!merged.length) merged = [createDoc()];
      merged = merged.map(normaliseDoc);
      const cloudIds = new Set(cloudDocs.map(d => d.id));
      for (const doc of merged)
        if (!cloudIds.has(doc.id) && stripHtml(doc.content).trim())
          await pushDocToCloud(doc, signedInUser.id);
      const currentActiveId = activeIdRef.current;
      const newActiveId = merged.find(d => d.id === currentActiveId) ? currentActiveId : merged[0].id;
      setDocs(merged); saveState(merged, newActiveId); setActiveId(newActiveId);
      saveOwner(signedInUser.id); // these docs now belong to this account
      docsRef.current = merged; activeIdRef.current = newActiveId;
      const docToLoad = merged.find(d => d.id === newActiveId);
      if (docToLoad) loadDocIntoEditor(docToLoad, { preserveLocalTitle: true });
      // Backfill verify codes from the cloud copy onto any local doc that
      // doesn't carry one yet (certified on another device).
      const codeByDoc = new Map(
        cloudDocs.filter(d => d.verifyCode).map(d => [d.id, { code: d.verifyCode, hash: d.contentHash || null }])
      );
      if (codeByDoc.size) {
        setDocs(prev => prev.map(d => {
          const c = codeByDoc.get(d.id);
          return (c && !d.verifyCode) ? { ...d, verifyCode: c.code, contentHash: d.contentHash || c.hash } : d;
        }));
      }
      let prof = await fetchProfile(signedInUser.id);
      // Every account gets a profile provisioned automatically at sign-in, so no
      // one is ever blocked by a sign-in-time modal. Email signups carry their
      // chosen username + Terms acceptance in user_metadata. Google (and any
      // other provider) has no username, so we derive a unique handle from the
      // Google name / email and record the Terms acceptance ticked in the auth
      // modal, which we stashed across the OAuth redirect. Username + display
      // name stay editable anytime from the Notes tab.
      if (!prof) {
        const meta = signedInUser.user_metadata || {};
        const metaUsername = (meta.username || "").trim();
        // The Terms checkbox ticked before "continue with Google" is carried
        // across the OAuth redirect here; consume it (clear so it can't leak to
        // a later, unrelated signup on this browser).
        let pendingTos = null;
        try { pendingTos = localStorage.getItem("inkk_pending_tos"); localStorage.removeItem("inkk_pending_tos"); } catch {}
        let username = metaUsername || await generateUniqueUsername(
          meta.full_name || meta.name || (signedInUser.email || "").split("@")[0],
        );
        const displayName = (meta.display_name || meta.full_name || meta.name || username).trim();
        const tosAccepted = !!meta.tos_accepted || !!pendingTos;
        const tosVersion  = meta.tos_version || pendingTos || TOS_VERSION;
        let errMsg = await upsertProfile(signedInUser.id, username, displayName, { tosAccepted, tosVersion });
        // The chosen handle was claimed between signup and confirmation — derive
        // a free variant rather than stranding the user without a profile.
        if (errMsg && /unique|duplicate/i.test(errMsg)) {
          username = await generateUniqueUsername(username);
          errMsg = await upsertProfile(signedInUser.id, username, displayName, { tosAccepted, tosVersion });
        }
        if (!errMsg) prof = await fetchProfile(signedInUser.id);
      }
      if (prof) {
        setProfile(prof);
        const opt = !!prof.research_opt_in;
        optInRef.current = opt;
        setResearchOptIn(opt);
        if (opt) { try { syncFlushNow(); } catch {} }
      } else {
        // Provisioning failed (offline / transient DB error) — never trap the
        // user behind a modal. They keep writing; the profile is created on the
        // next sign-in, or when they set a username from the Notes tab.
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
        setUser(null); userRef.current = null;
        setProfile(null);
        setResearchOptIn(false); optInRef.current = false;
        recorderRef.current?.recordUserChange(null);
        // A deliberate Sign out clears this device so the next person doesn't
        // inherit the notes. An implicit one (an expired or revoked token)
        // must not: the writer is still here and their notes are still theirs.
        if (explicitSignOutRef.current) { explicitSignOutRef.current = false; resetLocalWorkspace(); }
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
  }, [loadDocIntoEditor, resetLocalWorkspace]);

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

  // ─ certify ──────────────────────────────────────────────────────────────────

  // Certify the active document — mint (or refresh) its verification code.
  const certifyActiveDoc = useCallback(async () => {
    if (!userRef.current) { setAuthMode("signin"); setAuthOpen(true); return; }
    const docId = activeIdRef.current;
    const base = docsRef.current.find(d => d.id === docId);
    if (!base) return;
    const liveDoc = {
      ...base,
      content: contentRef.current || base.content,
      title: stripHtml(titleRef.current || "") || base.title,
    };
    if (!stripHtml(liveDoc.content || "").trim()) return;
    setCertifying(true);
    const authorName = profile?.display_name || profile?.username || userRef.current.email?.split("@")[0] || "Anonymous";
    const events = await gatherDocEvents(docId);
    const cert = await ensureCertificate(liveDoc, userRef.current, { title: stripHtml(titleRef.current || ""), authorName, authorUsername: profile?.username }, events);
    setCertifying(false);
    if (!cert.code) { addToast(cert.error ? "Could not certify." : "Certification needs a secure connection."); return; }
    setDocs(prev => {
      const next = prev.map(d => d.id === docId ? { ...d, verifyCode: cert.code, contentHash: cert.contentHash, certVerified: !!cert.verified } : d);
      const updated = next.find(d => d.id === docId);
      if (updated) pushDocToCloud(updated, userRef.current.id);
      saveState(next, docId);
      return next;
    });
    if (viewRef.current === "editor") setCertMenuOpen(true);   // the popover belongs to the editor's top bar
    if (cert.isNew) addToast(cert.verified ? "Certified · human-verified." : "Certified.");
    return cert;
  }, [profile, addToast, gatherDocEvents]);

  // Open the auth modal on a specific tab. Mode is set before the modal mounts,
  // so each open lands on the requested tab (signin by default).
  const openAuth = useCallback((mode = "signin") => {
    setAuthMode(mode);
    setAuthOpen(true);
  }, []);

  // ─ sign out ─────────────────────────────────────────────────────────────────

  const signOut = useCallback(async () => {
    if (!supabase) return;
    explicitSignOutRef.current = true;
    const { error } = await supabase.auth.signOut();
    if (error) { explicitSignOutRef.current = false; addToast("Couldn't sign out. Try again."); return; }
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
      const cr = container.getBoundingClientRect();
      // Phone with the keyboard up: typewriter scrolling. Hold the caret at a
      // fixed height in the visible strip rather than letting it drift toward
      // the bottom edge, so the line you are writing stays where your eyes
      // already are. Desktop keeps the original catch-it-near-the-bottom rule.
      if (document.body.classList.contains("keyboard-open")) {
        const delta = rect.top - (cr.top + cr.height * TYPEWRITER_ANCHOR);
        if (Math.abs(delta) > 12) container.scrollTop += delta;
        return;
      }
      const cb = cr.bottom;
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
      if (userRef.current) {
        // Push the whole note (metrics, certificate, title) — the cloud upsert
        // writes every column, so a partial would wipe what it didn't carry.
        const full = docsRef.current.find(d => d.id === capturedId);
        if (full) pushDocToCloud({ ...full, title: capturedTitle, content: capturedContent, updatedAt: capturedUpdatedAt, writingTimeSecs: capturedTime }, userRef.current.id);
      }
      setSaveStatus("saved");
    }, 500);
  }, [activeId, scheduleMenuReturn, scrollToCursor, addToast]);

  // ── Editor image selection (resize / align / remove) ───────────────────────
  const clearImageSel = useCallback(() => {
    if (imgElRef.current) imgElRef.current.classList.remove("img-selected");
    imgElRef.current = null;
    setImgTool(null);
  }, []);

  const selectEditorImage = useCallback((el) => {
    if (!el) return;
    if (imgElRef.current && imgElRef.current !== el) imgElRef.current.classList.remove("img-selected");
    imgElRef.current = el;
    el.classList.add("img-selected");
    const width = el.style.width ? Math.round(parseFloat(el.style.width)) : 100;
    const align = el.dataset.align || "center";
    setImgTool({ rect: el.getBoundingClientRect(), width, align });
  }, []);

  // Select a freshly inserted image once it has real dimensions (so the toolbar
  // lands in the right place).
  const selectImageWhenReady = useCallback((img) => {
    if (img.complete && img.naturalWidth) selectEditorImage(img);
    else img.addEventListener("load", () => selectEditorImage(img), { once: true });
  }, [selectEditorImage]);

  const setImageWidth = useCallback((pct) => {
    const el = imgElRef.current;
    if (!el) return;
    el.style.width = pct >= 100 ? "" : pct + "%";
    onInput();
    setImgTool(t => (t ? { ...t, width: pct, rect: el.getBoundingClientRect() } : t));
  }, [onInput]);

  const setImageAlign = useCallback((align) => {
    const el = imgElRef.current;
    if (!el) return;
    el.dataset.align = align;
    el.style.marginLeft  = align === "left"  ? "0" : "auto";
    el.style.marginRight = align === "right" ? "0" : "auto";
    onInput();
    setImgTool(t => (t ? { ...t, align, rect: el.getBoundingClientRect() } : t));
  }, [onInput]);

  const removeSelectedImage = useCallback(() => {
    const el = imgElRef.current;
    if (!el) return;
    el.remove();
    clearImageSel();
    onInput();
  }, [onInput, clearImageSel]);

  // Keep the toolbar pinned to the image while scrolling/resizing, and dismiss
  // the selection on an outside click or when the image is removed.
  const imgSelActive = imgTool !== null;
  useEffect(() => {
    if (!imgSelActive) return;
    const reposition = () => {
      const el = imgElRef.current;
      if (!el || !el.isConnected) { clearImageSel(); return; }
      setImgTool(t => (t ? { ...t, rect: el.getBoundingClientRect() } : t));
    };
    const onDocMouseDown = (e) => {
      if (imgPanelRef.current?.contains(e.target)) return;
      if (imgElRef.current === e.target) return;
      clearImageSel();
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("mousedown", onDocMouseDown, true);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", onDocMouseDown, true);
    };
  }, [imgSelActive, clearImageSel]);

  const onTitleInput = useCallback((e) => {
    const el = titleEditorRef.current;
    if (!el) return;
    // Live title-case finished words as you type (skip during IME composition).
    if (titleCapsOn && !(e && e.nativeEvent && e.nativeEvent.isComposing)) {
      const text = el.textContent || "";
      const cased = liveTitleCase(text);
      if (cased !== text) {
        const off = titleCaretOffset(el);
        el.textContent = cased;
        if (off != null) setTitleCaret(el, off);
      }
    }
    titleRef.current = el.innerHTML;
    setSaveStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const capturedId = activeId;
    const capturedTitle = el.innerHTML;
    saveTimerRef.current = setTimeout(() => {
      const capturedUpdatedAt = Date.now();
      setDocs(prev => {
        const next = prev.map(d =>
          d.id === capturedId ? { ...d, title: capturedTitle, content: contentRef.current || d.content, updatedAt: capturedUpdatedAt } : d
        );
        saveState(next, capturedId);
        return next;
      });
      if (userRef.current) {
        const full = docsRef.current.find(d => d.id === capturedId);
        if (full) pushDocToCloud({ ...full, title: capturedTitle, content: contentRef.current || full.content, updatedAt: capturedUpdatedAt }, userRef.current.id);
      }
      setSaveStatus("saved");
    }, 500);
  }, [activeId, titleCapsOn]);

  // Apply title-case to the title when the user finishes it (blur / Enter),
  // unless they've turned auto-capitalization off.
  const finalizeTitle = useCallback(() => {
    const el = titleEditorRef.current;
    if (!el) return;
    if (titleCapsOn) {
      const current = el.textContent || "";
      const cased = titleCase(current);
      if (cased && cased !== current) el.textContent = cased;
    }
    titleRef.current = el.innerHTML ?? "";
    onTitleInput();
  }, [titleCapsOn, onTitleInput]);

  const handleEditorDrop = useCallback(async (e) => {
    // Only intercept file drops; let text/other drops behave normally.
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault();   // stop the browser from opening the dropped file
    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
    if (!files.length) return;
    const editor = editorRef.current;
    if (!editor) return;
    // Insert at the drop point if it lands inside the body; otherwise append.
    let range = caretRangeAt(e.clientX, e.clientY);
    if (!range || !editor.contains(range.startContainer)) range = null;
    let lastImg = null;
    let failed = false;
    for (const file of files) {
      const src = await compressImage(file);
      if (!src) { failed = true; continue; }   // undecodable (e.g. HEIC) — skip
      const img = document.createElement("img");
      img.src = src;
      if (range) { range.insertNode(img); range.collapse(false); }
      else editor.appendChild(img);
      lastImg = img;
    }
    if (lastImg) { onInput(); selectImageWhenReady(lastImg); }
    if (failed && !lastImg) addToast("That image format isn’t supported. Try a JPEG or PNG.");
  }, [onInput, selectImageWhenReady, addToast]);

  const handleEditorPaste = useCallback(async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find(item => item.type.startsWith("image/"));
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) return;
      const src = await compressImage(file);
      if (!src) { addToast("That image format isn’t supported. Try a JPEG or PNG."); return; }
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
      selectImageWhenReady(img);
      return;
    }
    // Text paste is turned off for now — pieces should be written, not pasted in
    // (it would bypass the keystroke recording behind Inkk's verification).
    // Pasting an image still works (handled above).
    e.preventDefault();
    if (e.clipboardData?.getData("text/plain")) addToast("Pasting text is turned off for now.");
  }, [onInput, selectImageWhenReady, addToast]);

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
    // PDF keeps the paper look; PNG exports on the clean inkk background.
    const paperTexture = (format === "pdf");
    // Whatever leaves inkk carries its certificate. A signed-in writer's
    // download certifies the text as it is now (reusing the code when the
    // words haven't changed), and the code goes into the file's invisible
    // metadata, where the desktop companion and the Certify page read it back.
    let activeDoc = docsRef.current.find(d => d.id === activeIdRef.current);
    let certCode = null;
    let certVerified = false;
    if (supabase && userRef.current) {
      // A code issued on another device may not be here yet: ask the account.
      if (activeDoc && !activeDoc.verifyCode) {
        const { data } = await supabase
          .from("documents")
          .select("verify_code, score_tier, content_hash")
          .eq("id", activeIdRef.current)
          .maybeSingle();
        if (data?.verify_code) activeDoc = { ...activeDoc, verifyCode: data.verify_code, contentHash: data.content_hash, scoreTier: activeDoc.scoreTier || data.score_tier };
      }
      const fp = await fingerprintOf(text);
      if (activeDoc?.verifyCode && fp && certMatches(activeDoc, fp)) {
        certCode = activeDoc.verifyCode;
        certVerified = activeDoc.certVerified ?? isVerifiedTier(activeDoc.scoreTier);
      } else {
        const cert = await certifyActiveDoc();
        certCode = cert?.code || null;
        certVerified = !!cert?.verified;
      }
    }
    const seal = certCode ? sealUrl(certCode) : null;
    const verify = certCode ? { code: certCode, verified: certVerified } : null;

    if (format === "docx") {
      const byline = profile?.display_name || profile?.username || "";
      saveBlob(docxOf({ title: titleStr, html: text, author: byline, face: font, code: certCode, seal }), `${safeName}.docx`);
      return;
    }
    const renderOptions = {
      pageW: preset.w,
      pageH: preset.h,
      justify:         style.justify         ?? false,
      paragraphIndent: style.paragraphIndent ?? false,
      paperTexture,
    };

    try {
      if (format === "pdf") {
        const pdf = new jsPDF({ unit: "pt", format: [preset.w, preset.h], compress: true });
        const byline = profile?.display_name || profile?.username || "";
        if (pdf.setProperties) {
          pdf.setProperties({
            title:   titleStr || "inkk",
            author:  byline || "inkk",
            creator: "inkk",
            subject: verify
              ? `${verify.verified ? "Human-signal verified on inkk" : "Written in inkk"}. Verify at ${seal.replace("https://", "")}`
              : "Written in inkk",
            keywords: ["inkk", verify ? (verify.verified ? "human-verified" : "written-in-inkk") : null, verify ? `inkk:${verify.code}` : null, seal]
              .filter(Boolean).join(", "),
          });
        }
        await renderBookPdfPages({
          title: titleStr,
          byline,
          html: text,
          options: renderOptions,
          async onPage(canvas, pageIndex) {
            if (pageIndex > 0) pdf.addPage([preset.w, preset.h]);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.96);
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
        if (verify) pngBlob = await withTextChunks(pngBlob, { Title: titleStr, Author: byline, Keywords: `inkk:${verify.code}`, "inkk-code": verify.code, "inkk-seal": seal });
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
  }, [addToast, profile?.display_name, profile?.username, font, certifyActiveDoc]);

  const openDownloadModal = useCallback(() => {
    if (!stripHtml(contentRef.current || "").trim()) return;
    setDownloadModalOpen(true);
  }, []);

  // ─ keyboard shortcuts ───────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (view === "editor") openDownloadModal(); }
      if ((e.metaKey || e.ctrlKey) && e.key === ".") { e.preventDefault(); if (view === "editor") toggleFocusMode(); }
      // Cmd/Ctrl+I toggles italic in the title or body editor.
      if ((e.metaKey || e.ctrlKey) && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        const active = document.activeElement;
        if (active === editorRef.current || active === titleEditorRef.current) {
          document.execCommand("italic");
          if (active === titleEditorRef.current) onTitleInput(); else onInput();
          try {
            setFormatActive({
              bold:   document.queryCommandState("bold"),
              italic: document.queryCommandState("italic"),
            });
          } catch {}
        }
      }
      if (e.key === "Escape") {
        if (authOpen) return;       // auth modal closes only via its × button
        if (focusMode) { exitFocusMode(); return; }
        if (certMenuOpen) { setCertMenuOpen(false); return; }
        if (faceMenuOpen) { setFaceMenuOpen(false); return; }
        if (toolsOpen) { setToolsOpen(false); return; }
        if (downloadModalOpen) { setDownloadModalOpen(false); return; }
        setPanelOpen(false); setHsModalOpen(false); setHsScoreOpen(false);
        if (view !== "editor") {
          if (document.querySelector(".pe-overlay, .legal-overlay")) return;   // a dialog owns Escape
          if (inAppDepthRef.current > 0) window.history.back();   // a previous entry of ours
          else navigate("editor");                                // arrived from outside: don't leave the site
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openDownloadModal, view, focusMode, certMenuOpen, toolsOpen, faceMenuOpen, toggleFocusMode, exitFocusMode, downloadModalOpen, authOpen, onInput, onTitleInput, navigate]);

  // ─ mount ────────────────────────────────────────────────────────────────────

  useEffect(() => {
    isMobileRef.current = isMobile();
    if (isMobileRef.current) {
      // Tag the document so the editor top bar can declutter (CSS), and keep
      // title capitalization on for good — the Aa toggle is hidden on mobile.
      document.body.classList.add("is-mobile");
      setTitleCapsOn(true);
    }
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
    const initCode = initPath.startsWith("/v/") ? initPath.slice(3) : undefined;
    // Old addresses (/profile, /verify, retired social routes) resolve to a view
    // above; give the address bar the current spelling of that view.
    const canonical = pathToLegal(initPath) ? initPath : viewToPath(initView, initCode);
    window.history.replaceState({ view: initView, code: initCode }, "", canonical + window.location.search + window.location.hash);
    void initUrl;

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
      options: { justify: false, paragraphIndent: false, paperTexture: true },
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
  const activeDoc      = docs.find(d => d.id === activeId);
  const activeCert     = activeDoc?.verifyCode || null;
  // What the ledger said when the code was issued; older notes only have the live tier.
  const activeCertOk   = activeDoc?.certVerified ?? isVerifiedTier(activeDoc?.scoreTier);

  // A certificate binds one exact text. When the words move on, the button
  // stops claiming "Certified" and offers to recertify instead — quietly,
  // recomputed a beat after typing settles. Legacy docs without a stored
  // hash can't be compared and keep today's behaviour.
  useEffect(() => {
    const doc = docsRef.current.find(d => d.id === activeId);
    if (!doc?.verifyCode || !doc?.contentHash) { setCertStale(false); return; }
    let live = true;
    const t = setTimeout(async () => {
      // Both fingerprints count: certificates from before September 2026
      // carry the older one.
      const fp = await fingerprintOf(contentRef.current || doc.content);
      if (live) setCertStale(!!fp && !certMatches(doc, fp));
    }, 600);
    return () => { live = false; clearTimeout(t); };
  }, [words, activeId, docs]);

  const openVerify = useCallback((code) => {
    navigate("certify", { code: code || "" });
  }, [navigate]);

  // Open a note from the Notes page: pull it from the cloud if this device
  // doesn't hold it yet, make it the active document, then go to the editor
  // (or straight to certify).
  const openDocFromNotes = useCallback(async (id, { view: target = "editor" } = {}) => {
    if (!docsRef.current.some(d => d.id === id)) {
      const cloud = await fetchCloudDoc(id);
      if (!cloud) { addToast("Couldn't find that note on this device or in your account."); return; }
      setDocs(prev => {
        const next = [cloud, ...prev.filter(d => d.id !== cloud.id)];
        saveState(next, id);
        return next;
      });
    }
    switchDoc(id);
    navigate(target);
  }, [switchDoc, navigate, addToast]);

  return (
    <>
      {/* ── engraving backdrop ──
          In the editor the plate belongs to the blank page: it fades while the
          title is being typed and leaves for good once the piece has words —
          except in preview, where the draft's own plate returns to frame the
          rendered pages and fades away when the preview closes. A fresh blank
          document brings a fresh plate. */}
      <Backdrop
        view={view}
        hidden={showLanding || (isEditor && !previewMode && (hasContent || !menuVisible))}
        override={isEditor && previewMode ? { img: imgForPub(activeId), pos: "center 30%" } : null}
        ringed={view === "certify" && verifyStatus !== "found"}
      />

      {/* ── landing overlay ── */}
      {showLanding && <LandingScreen onDone={() => {
        setShowLanding(false);
        // Hand the blinking caret to the body: the landing's deleted headline
        // resolves into the cursor waiting on the first line.
        setTimeout(() => { if (view === "editor" && !isMobileRef.current) editorRef.current?.focus(); }, 120);
      }} />}

      {/* ── top bar ── */}
      {/* ── offline banner ── */}
      {!online && (
        <div id="offline-banner" role="status">
          Offline. Changes are saved locally on this device and will sync when you reconnect.
        </div>
      )}

      <header id="top-bar">
        <div id="top-bar-left">
          {isEditor && (
            <button
              className="icon-btn"
              onClick={() => setPanelOpen(v => !v)}
              title="Open notes"
              aria-label="Open notes"
            >
              <Menu size={18} />
            </button>
          )}
        </div>
        <div id="top-bar-center">
          <span id="brand" onClick={() => navigate("editor")} style={{ cursor: "pointer" }} role="button" tabIndex={0}>inkk.</span>
        </div>
        <div id="top-bar-right">
          {/* The tools live behind one quiet control. A page that is just paper and
              a sentence shouldn't carry a toolbar; open it when you want it. */}
          {isEditor && (
            <div id="tools" className={`${menuClass}${toolsOpen ? " is-open" : ""}`}>
              {toolsOpen && (
                <div id="tools-row">
          {isEditor && supabase && hasContent && (
            <div id="cert-menu-wrap">
              <button
                id="cert-btn"
                className={`${menuClass}${activeCert && !certStale ? " is-certified" : ""}`}
                title={activeCert
                  ? (certStale ? "The text has changed since certification. Click to recertify." : "Verification code")
                  : "Get a human verification code for this note."}
                disabled={certifying}
                onClick={() => {
                  if (activeCert && certStale) certifyActiveDoc();
                  else if (activeCert) setCertMenuOpen(v => !v);
                  else if (isMobileRef.current) setCertConfirmOpen(v => !v);
                  else certifyActiveDoc();
                }}
              >
                <span className="btn-label">{certifying ? "Certifying…" : activeCert ? (certStale ? "Recertify" : "Certified") : "Certify"}</span>
              </button>
              {!activeCert && certConfirmOpen && (
                <div id="cert-menu">
                  <span className="cert-menu-label">Certify</span>
                  <p className="cert-menu-note">
                    Mint a verification code that proves this piece was written by hand.
                    It stays private to you until you share it.
                  </p>
                  <button
                    className="cert-menu-link"
                    onClick={() => { setCertConfirmOpen(false); certifyActiveDoc(); }}
                  >Certify this piece →</button>
                </div>
              )}
              {activeCert && certMenuOpen && (
                <div id="cert-menu">
                  <span className="cert-menu-label">{activeCertOk ? "Human-verified" : "Verification code"}</span>
                  <button
                    className="cert-menu-code"
                    title="Copy code"
                    onClick={() => navigator.clipboard?.writeText(activeCert).then(() => addToast("Code copied."))}
                  >{activeCert}</button>
                  <p className="cert-menu-note">
                    Proof this piece displays human signal. Share the code and the recipient can check it.
                    It stays private to you until you share it.
                  </p>
                  <button
                    className="cert-menu-link"
                    onClick={() => { setCertMenuOpen(false); openVerify(activeCert); }}
                  >Open verification →</button>
                  <button
                    className="cert-menu-link cert-menu-recertify"
                    onClick={() => { setCertMenuOpen(false); certifyActiveDoc(); }}
                  >Re-certify current text</button>
                </div>
              )}
            </div>
          )}
          {isEditor && (
            <div id="face-menu-wrap">
              <button
                className={`icon-btn title-caps-btn ${menuClass}${faceMenuOpen ? " active" : ""}`}
                onClick={() => setFaceMenuOpen(v => !v)}
                title="Typeface"
                aria-expanded={faceMenuOpen}
              >
                <span className="title-caps-glyph">Aa</span>
              </button>
              {faceMenuOpen && (
                <div id="cert-menu" className="face-menu">
                  <span className="cert-menu-label">Typeface</span>
                  {[["fell", "Fell"], ["garamond", "Garamond"], ["sans", "Sans"]].map(([k, label]) => (
                    <button key={k} className={`face-option${font === k ? " is-on" : ""}`} onClick={() => setFont(k)}>
                      <span className={`face-sample face-${k}`} aria-hidden="true">Aa</span>
                      <span>{label}</span>
                    </button>
                  ))}
                  <label className="face-caps">
                    <input type="checkbox" checked={titleCapsOn} onChange={e => setTitleCapsOn(e.target.checked)} />
                    <span>Capitalise titles</span>
                  </label>
                </div>
              )}
            </div>
          )}
          {isEditor && hasContent && (
            <button
              className={`icon-btn icon-btn-preview${previewMode ? " active" : ""}`}
              onClick={() => setPreviewMode(v => !v)}
              title={previewMode ? "Back to editing" : "Preview the rendered pages"}
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
              onClick={toggleFocusMode}
              title={focusMode ? "Exit fullscreen  ⌘." : "Fullscreen  ⌘."}
            >
              {focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          )}
                </div>
              )}
              <button
                className="icon-btn tools-toggle"
                onClick={() => setToolsOpen(v => !v)}
                aria-expanded={toolsOpen}
                aria-label={toolsOpen ? "Hide tools" : "Tools"}
                title={toolsOpen ? "Hide tools" : "Certify, preview, download…"}
              >
                {toolsOpen ? <X size={15} /> : <MoreHorizontal size={16} />}
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ── doc panel ── */}
      {isEditor && panelOpen && <div id="panel-backdrop" onClick={() => setPanelOpen(false)} />}
      {isEditor && (
        <div id="doc-panel" className={panelOpen ? "open" : ""}>
          <button className="new-doc-btn" onClick={newDoc}>
            <Plus size={13} /> New note
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
        </div>
      )}

      {/* ── writing stats (editor) ── data about the piece, no score ── */}
      {isEditor && (
        <div id="hs-editor-status" className={menuClass}>
          {(() => {
            const doc = docs.find(d => d.id === activeId);
            const wtSecs = doc?.writingTimeSecs || 0;
            const saving = saveStatus === "saving";
            const statusText = saving ? "saving…" : (user && !online ? "offline · saved here" : "saved");
            const sf = doc?.scoreFeatures;
            const hasScore = doc?.humanScore != null && doc?.scoreTier && (sf?.confidence || 0) > 0.08;
            const tierList = ["Faint", "Developing", "Strong", "Distinct"];
            const filled = hasScore ? tierList.indexOf(doc.scoreTier) + 1 : 0;
            void wtSecs;
            return (
              <div className="writing-stats">
                <span className="ws-stat">{words.toLocaleString()} {words === 1 ? "word" : "words"}</span>
                {hasScore && (<>
                  <span className="ws-sep">·</span>
                  <button className="ws-process-btn" onClick={() => setHsScoreOpen(true)} title={`${doc.scoreTier} human signal — view the writing process`} aria-label={`${doc.scoreTier} human signal`}>
                    {tierList.map((_, i) => (
                      <span key={i} className={`hs-dot-xs ${i < filled ? "on" : "off"}`} />
                    ))}
                  </button>
                </>)}
                <span className="ws-sep">·</span>
                <span className={`ws-status ${saving ? "saving" : (online ? "ok" : "off")}`}>{statusText}</span>
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
          title="Click for info. Your writing signatures contribute to a study of human writing."
        >
          <span className="research-pulse" aria-hidden="true" />
          <span className="research-strip-text">
            studying · {liveStats.events.toLocaleString()} {liveStats.events === 1 ? "event" : "events"}
            {liveStats.sessionStartedAt && ` · ${Math.max(1, Math.round((Date.now() - liveStats.sessionStartedAt) / 60000))}m`}
          </span>
        </button>
      )}

      {/* ── editor (always mounted) ── */}
      <div
        id="text-container"
        ref={containerRef}
        className={words > 0 ? "writing-started" : ""}
        style={{ display: isEditor ? "" : "none" }}
        onDrop={handleEditorDrop}
        onDragEnter={e => { if (Array.from(e.dataTransfer?.types || []).includes("Files")) e.preventDefault(); }}
        onDragOver={e => { if (Array.from(e.dataTransfer?.types || []).includes("Files")) e.preventDefault(); }}
        onTouchStart={e => { const t = e.touches[0]; editorTapRef.current = t ? { x: t.clientX, y: t.clientY } : null; }}
        onTouchEnd={e => {
          // Read mode → write mode: a still tap arms editing and puts the
          // caret under the finger. flushSync so the div is editable before
          // focus() runs, still inside the user gesture.
          if (editArmed || !isMobile()) return;
          const t = e.changedTouches[0], s = editorTapRef.current;
          if (!t || !s || Math.hypot(t.clientX - s.x, t.clientY - s.y) > 12) return;
          const isTitle = !!e.target.closest?.("#title-input");
          const { clientX: x, clientY: y } = t;
          flushSync(() => setEditArmed(true));
          const el = isTitle ? titleEditorRef.current : editorRef.current;
          if (!el) return;
          el.focus();
          const sel = window.getSelection();
          const r = document.caretRangeFromPoint?.(x, y);
          if (sel && r && el.contains(r.startContainer)) {
            sel.removeAllRanges(); sel.addRange(r);
          } else if (sel) {
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            sel.removeAllRanges(); sel.addRange(range);
          }
        }}
      >
        <div
          id="title-input"
          ref={titleEditorRef}
          contentEditable={editArmed || !isMobile()}
          suppressContentEditableWarning
          spellCheck={false}
          data-placeholder="Title"
          data-face={font}
          onInput={onTitleInput}
          onBlur={finalizeTitle}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); finalizeTitle(); editorRef.current?.focus(); } }}
          onPaste={e => e.preventDefault()}
        />
        <div id="writing-area">
          <div
            id="text"
            ref={editorRef}
            data-face={font}
            contentEditable={editArmed || !isMobile()}
            suppressContentEditableWarning
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onInput={onInput}
            onPaste={handleEditorPaste}
            onClick={e => { if (e.target.tagName === "IMG") selectEditorImage(e.target); else clearImageSel(); }}
            onKeyDown={() => { if (imgElRef.current) clearImageSel(); }}
          />
        </div>
      </div>

      {/* ── corner control (phone): tick = done typing, ⋯ = bring the chrome back ── */}
      {isEditor && (kbOpen || chromeHidden) && (
        <button
          id="kb-done"
          aria-label={kbOpen ? "Done writing for now" : "Show controls"}
          {...tabTouch(kbOpen ? dismissKeyboard : () => setChromeHidden(false))}
        >
          {kbOpen ? <Check size={16} strokeWidth={2} /> : <MoreHorizontal size={16} strokeWidth={2} />}
        </button>
      )}

      {imgTool && (
        <ImageToolbar
          rect={imgTool.rect}
          width={imgTool.width}
          align={imgTool.align}
          onWidth={setImageWidth}
          onAlign={setImageAlign}
          onRemove={removeSelectedImage}
          panelRef={imgPanelRef}
        />
      )}

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
      {view === "notes" && (
        <NotesView
          user={user}
          profile={profile}
          docs={docs}
          activeId={activeId}
          streak={streak}
          dropCapImages={dropCapImages}
          onSignIn={() => openAuth("signin")}
          onCreateAccount={() => openAuth("signup")}
          onSignOut={signOut}
          onOpenDoc={openDocFromNotes}
          onNewDoc={() => { newDoc(); navigate("editor"); }}
          onDeleteDoc={(id) => deleteDoc(id, { stopPropagation: () => {} })}
          onDownloadDoc={async (id) => { await openDocFromNotes(id); setDownloadModalOpen(true); }}
          onCertifyDoc={async (id) => { await openDocFromNotes(id, { view: "certify" }); }}
          onOpenVerify={(code) => openVerify(code)}
          researchOptIn={researchOptIn}
          onToggleOptIn={toggleResearchOptIn}
          onDownloadData={downloadResearchData}
          onDeleteData={deleteResearchData}
          onChangePassword={() => setUpdatePasswordOpen(true)}
          onProfileUpdate={(updatedProfile) => setProfile(updatedProfile)}
          onToast={addToast}
        />
      )}
      {view === "certify" && (
        <CertifyView
          initialCode={verifyCode}
          onStatus={setVerifyStatus}
          user={user}
          note={activeDoc && hasContent ? {
            id: activeDoc.id,
            title: stripHtml(activeDoc.title || "") || docTitle(activeDoc.content),
            words: wordCount(activeDoc.content),
            verifyCode: activeCert,
            verifiedTier: activeCertOk,
            scoreTier: activeDoc.scoreTier,
            humanScore: activeDoc.humanScore,
            stale: certStale,
          } : null}
          certifying={certifying}
          onCertify={certifyActiveDoc}
          onSignIn={() => openAuth("signin")}
          onWrite={() => navigate("editor")}
          onToast={addToast}
        />
      )}

      {/* ── bottom nav ── */}
      {/* The nav is its own furniture, not part of the editor toolbar: it must
          not inherit menu-hidden (pointer-events:none), which made a tap on a
          tab do nothing for ~1.2s after typing. keyboard-open still hides it
          while the writer is actually composing. */}
      <nav id="bottom-nav">
        <button className={`nav-tab ${isEditor ? "active" : ""}`} {...tabTouch(() => navigate("editor"))}>
          <PPen size={19} weight="light" />
          <span className="nav-label">Write</span>
        </button>
        <button className={`nav-tab ${view === "notes" ? "active" : ""}`} {...tabTouch(() => navigate("notes"))}>
          <PNotes size={19} weight="light" />
          <span className="nav-label">Notes</span>
        </button>
        <button className={`nav-tab ${view === "certify" ? "active" : ""}${activeCert && !certStale ? " has-cert" : ""}`} {...tabTouch(() => navigate("certify"))}>
          <PSeal size={19} weight="light" />
          <span className="nav-label">Certify</span>
        </button>
      </nav>

      {/* ── modals ── */}
      {downloadModalOpen && (
        <DownloadModal onConfirm={downloadDoc} onClose={() => setDownloadModalOpen(false)} />
      )}
      {authOpen && supabase && <AuthModal onClose={() => setAuthOpen(false)} initialMode={authMode} />}
      {hsModalOpen && <HumanSignalModal onClose={() => setHsModalOpen(false)} />}
      {legalPage === "privacy" && <PrivacyModal onClose={() => { setLegalPage(null); navigate("notes"); }} />}
      {legalPage === "terms"   && <TermsModal   onClose={() => { setLegalPage(null); navigate("notes"); }} />}
      {hsScoreOpen && (() => {
        const doc = docs.find(d => d.id === activeId);
        if (!doc?.scoreFeatures) return null;
        const scoreObj = { score: doc.humanScore, tier: doc.scoreTier, ...doc.scoreFeatures };
        return <HumanSignalPanel score={scoreObj} onClose={() => setHsScoreOpen(false)} />;
      })()}
      {updatePasswordOpen && (
        <UpdatePasswordModal
          onClose={() => setUpdatePasswordOpen(false)}
          onDone={() => addToast("Password updated.")}
        />
      )}

      {/* ── focus mode exit ── */}
      {focusMode && (
        <button id="focus-exit" onClick={exitFocusMode} title="Exit fullscreen  ⌘.">
          <Minimize2 size={14} />
        </button>
      )}

      {/* ── popover backdrop ── */}
      {isEditor && certMenuOpen && <div id="publish-menu-backdrop" onClick={() => setCertMenuOpen(false)} />}
      {isEditor && certConfirmOpen && <div id="publish-menu-backdrop" onClick={() => setCertConfirmOpen(false)} />}
      {isEditor && faceMenuOpen && <div id="publish-menu-backdrop" onClick={() => setFaceMenuOpen(false)} />}

      {/* ── toasts ── */}
      <Toasts toasts={toasts} />
    </>
  );
}
