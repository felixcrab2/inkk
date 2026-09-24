// inkk companion — a stand-in window.inkk for previewing the popover outside
// the app (a plain browser, or a bare Electron window with no preload).
//
// Loaded before bundle.js from index.html. In the real app the preload has
// already defined window.inkk, so this whole file is a no-op there. Nothing in
// here is bundled; it is realistic fake data plus an event bus, nothing more.
(function () {
  "use strict";
  if (window.inkk) return;

  const now = Date.now();
  const MIN = 60000;

  // ── fake session data ─────────────────────────────────────────────────
  const contributors = (vals) => {
    const labels = {
      variance: "Keystroke variance", dwell: "Key contact time", pauses: "Pause distribution",
      corrections: "In-line corrections", revisions: "Mid-stream revisions", bursts: "Sustained writing bursts",
      rhythm: "Combined rhythm signature", velocity: "Writing speed naturalness", engagement: "Cognitive engagement",
    };
    return Object.entries(vals).map(([key, value]) => ({ key, label: labels[key], value, conf: 0.8 }));
  };

  const live = {
    id: "s-live", code: "INKK-4B7N-R2XE-8KMT", app: "Notes", bundleId: "com.apple.Notes",
    startedAt: now - 12 * MIN, endedAt: null, lastKeyAt: now - 4000,
    keystrokes: 1240, deletions: 96, pastes: 0, wordsEst: 210, activeMs: 11.5 * MIN,
    score: { score: 72, tier: "Strong", confidence: 0.71, contributors: contributors({
      rhythm: 0.82, engagement: 0.74, variance: 0.66, pauses: 0.58, corrections: 0.41 }) },
    cert: null,
  };
  const past = [
    { id: "s-1", app: "Pages", bundleId: "com.apple.iWork.Pages", code: "INKK-7F3A-9K2D-XQ4M",
      startedAt: now - 3 * 60 * MIN, endedAt: now - 2 * 60 * MIN, lastKeyAt: now - 2 * 60 * MIN,
      keystrokes: 3480, deletions: 310, pastes: 1, wordsEst: 640, activeMs: 48 * MIN,
      score: { score: 84, tier: "Distinct", confidence: 0.93, contributors: contributors({
        variance: 0.9, rhythm: 0.86, pauses: 0.8, engagement: 0.77, dwell: 0.6 }) },
      cert: { code: "INKK-7F3A-9K2D-XQ4M", verified: true, tier: "Distinct", score: 84,
        issuedAt: now - 2 * 60 * MIN + 30000, title: "On slow mornings", wordCount: 641,
        contentHash: "9c1f4a" } },
    { id: "s-2", app: "Google Chrome", bundleId: "com.google.Chrome", code: "INKK-2Q8V-M4TN-7HC1",
      startedAt: now - 26 * 60 * MIN, endedAt: now - 25 * 60 * MIN, lastKeyAt: now - 25 * 60 * MIN,
      keystrokes: 820, deletions: 52, pastes: 3, wordsEst: 150, activeMs: 9 * MIN,
      score: { score: 38, tier: "Developing", confidence: 0.4, contributors: contributors({
        variance: 0.5, pauses: 0.36, corrections: 0.3 }) },
      cert: null },
    { id: "s-3", app: "Obsidian", bundleId: "md.obsidian", code: "INKK-9X1D-K3PW-5RA6",
      startedAt: now - 4 * 24 * 60 * MIN, endedAt: now - 4 * 24 * 60 * MIN + 30 * MIN,
      lastKeyAt: now - 4 * 24 * 60 * MIN + 30 * MIN,
      keystrokes: 2120, deletions: 180, pastes: 0, wordsEst: 390, activeMs: 27 * MIN,
      score: { score: 61, tier: "Strong", confidence: 0.75, contributors: contributors({
        rhythm: 0.7, bursts: 0.64, velocity: 0.55, engagement: 0.5 }) },
      cert: null },
  ];

  const state = {
    version: "0.2.0",
    onboarded: true,
    permissions: { accessibility: "granted", inputMonitoring: "granted", screen: "not determined" },
    hookActive: true,
    needsRelaunch: false,
    paused: null,
    launchAtLogin: true,
    ignoredApps: ["site.inkk.companion", "com.apple.Terminal", "com.googlecode.iterm2", "com.1password.1password"],
    frontApp: { name: "Safari", bundleId: "com.apple.Safari" },
    active: live,
    supabaseConfigured: true,
    auth: { signedIn: true, anonymous: true, email: null, needed: false },
    settings: { receive: true, notify: true, stampDocuments: true, readPictures: false, signatureName: "Ada Writer", signatureFace: "garamond", signShortcut: "Control+Alt+S" },
    shortcutOk: true,
    helper: true,
    seal: { code: "INKK-7F3A-9K2D-XQ4M", source: "link", app: "Mail", bundleId: "com.apple.mail", mine: false,
      cert: { code: "INKK-7F3A-9K2D-XQ4M", verified: true, score_tier: "Distinct", human_score: 84, author_name: "Felix Crabtree", issued_at: new Date(now - 4 * 86400000).toISOString() },
      match: { state: "match", ratio: 1 }, seenAt: now },
    lastStamp: { path: "/Users/ada/Documents/On slow mornings.docx", name: "On slow mornings.docx", code: "INKK-7F3A-9K2D-XQ4M", ok: true, at: now - 3 * MIN },
    signing: false,
  };
  let sessions = [live, ...past];

  // ── event bus ─────────────────────────────────────────────────────────
  const subs = { state: new Set(), sessions: new Set(), shown: new Set() };
  const emit = (k, v) => subs[k].forEach((cb) => { try { cb(v); } catch (e) { console.error(e); } });
  const pushState = () => emit("state", JSON.parse(JSON.stringify(state)));
  const pushSessions = () => emit("sessions", JSON.parse(JSON.stringify(sessions)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const detailOf = (s) => ({
    ...s,
    full: {
      ...(s.score || {}),
      subs: {},
      velocity_series: [],
      thinking_pauses: Math.round(s.keystrokes / 60),
      typo_corrections: Math.round(s.deletions / 3),
      mid_revisions: Math.round(s.deletions / 20),
      burst_count: Math.round(s.activeMs / MIN / 2),
      avg_wpm: 34, peak_wpm: 58,
      active_time_ms: s.activeMs,
    },
  });

  window.inkk = {
    __mock: true,
    getState: async () => JSON.parse(JSON.stringify(state)),
    getSessions: async () => JSON.parse(JSON.stringify(sessions)),
    getSession: async (id) => { const s = sessions.find((x) => x.id === id); return s ? detailOf(s) : null; },
    endSession: async (id) => {
      const s = sessions.find((x) => x.id === (id || state.active?.id));
      if (s) { s.endedAt = Date.now(); if (state.active?.id === s.id) state.active = null; }
      pushState(); pushSessions();
    },
    deleteSession: async (id) => { sessions = sessions.filter((x) => x.id !== id); pushSessions(); },
    certify: async (id) => {
      await wait(600);
      const s = sessions.find((x) => x.id === id);
      if (state.__requireAuth) return { ok: false, error: "Sign in to certify.", needsAuth: true };
      const cert = { code: s?.code || "INKK-4B7N-R2XE-8KMT", verified: true, tier: s?.score?.tier || "Strong", score: s?.score?.score || 70,
        issuedAt: Date.now(), title: null, wordCount: 641, binding: "text", contentHash: "mock" };
      if (s) s.cert = cert;
      pushSessions();
      return { ok: true, cert };
    },
    requestPermission: async (kind) => { await wait(300); state.permissions[kind] = "granted"; pushState(); return "granted"; },
    openPermissionSettings: async () => {},
    setOnboarded: async (v) => { state.onboarded = !!v; pushState(); },
    setReceive: async (v) => { state.settings.receive = !!v; pushState(); },
    setSetting: async (k, v) => { state.settings[k] = v; pushState(); },
    sign: async () => console.log("[mock] sign"),
    previewSignature: async () => null,
    signIn: async () => { await wait(400); state.auth = { signedIn: true, anonymous: false, email: "ada@example.com", needed: false }; state.__requireAuth = false; pushState(); return { ok: true }; },
    signOut: async () => { state.auth = { signedIn: false, anonymous: false, email: null, needed: false }; pushState(); },
    importSession: async () => false,
    revealFile: async () => {},
    resize: (h) => { document.documentElement.dataset.height = h; },
    setPaused: async (until) => { state.paused = until; pushState(); },
    setLaunchAtLogin: async (v) => { state.launchAtLogin = !!v; pushState(); },
    setIgnoredApps: async (list) => { state.ignoredApps = list.slice(); pushState(); },
    relaunch: () => console.log("[mock] relaunch"),
    quit: () => console.log("[mock] quit"),
    hide: () => console.log("[mock] hide"),
    copyText: async (t) => { try { await navigator.clipboard.writeText(t); } catch {} },
    openExternal: async (url) => console.log("[mock] open", url),
    onState: (cb) => { subs.state.add(cb); return () => subs.state.delete(cb); },
    onSessions: (cb) => { subs.sessions.add(cb); return () => subs.sessions.delete(cb); },
    onShown: (cb) => { subs.shown.add(cb); return () => subs.shown.delete(cb); },

    // Preview helpers (not part of the contract): flip the fake state around
    // so every screen variant can be looked at.
    __set: (patch) => { Object.assign(state, patch); pushState(); },
  };

  // A little life: the live session keeps ticking while it is shown.
  setInterval(() => {
    if (!state.active) return;
    live.keystrokes += 3; live.lastKeyAt = Date.now(); live.wordsEst = Math.round(live.keystrokes / 5.9);
    pushState();
  }, 1500);
})();
