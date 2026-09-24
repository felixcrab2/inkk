// inkk companion — the writer's inkk account, held by the main process.
//
// A certificate lives in inkk's ledger, so certifying needs a Supabase session.
// The session used to live in the popover's page, which meant only the popover
// could certify, and a sign-in there could disagree with what the rest of the
// app believed. It lives here now, in one place: certify, the document stamper
// and the email signature all ask this module for a token.
//
// Nobody has to make an account to start. With no session, ensureToken() signs
// in anonymously (a real Supabase user with no email); only when the project
// has anonymous sign-ins switched off does the popover ask for an email and
// password. The session is kept in <userData>/inkk/auth.json, readable only by
// this user.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Mirrors TOS_VERSION in src/components/Legal.js (a React file the main process
// can't import); lib/auth.test.js fails if the two ever drift apart.
const TOS_VERSION = "2026-09-25";

function fileStorage(file) {
  let cache = null;
  const load = () => {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { cache = {}; }
    return cache;
  };
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* an unwritable profile means signing in again next launch, nothing worse */ }
  };
  return {
    getItem: (k) => (k in load() ? load()[k] : null),
    setItem: (k, v) => { load()[k] = v; save(); },
    removeItem: (k) => { delete load()[k]; save(); },
  };
}

function classify(error) {
  const msg = String(error?.message || "");
  if (error?.code === "anonymous_provider_disabled" || /anonymous/i.test(msg) && /disabled|not enabled|not allowed/i.test(msg)) return "disabled";
  if (error?.name === "AuthRetryableFetchError" || /fetch failed|network|ENOTFOUND|ECONNREFUSED|timed? ?out/i.test(msg)) return "offline";
  return "error";
}

// createClient is injected so the tests never touch the network.
function createAuth({ url, anonKey, file, createClient, log = () => {} }) {
  if (!url || !anonKey || !createClient) {
    const none = async () => ({ token: null, reason: "disabled" });
    return {
      configured: false, ensureToken: none, signIn: async () => ({ ok: false, error: "This build has no account service." }),
      signOut: async () => {}, importSession: async () => false, state: async () => ({ signedIn: false, anonymous: false, email: null }),
      authorName: async () => null, onChange: () => {},
    };
  }

  const client = createClient(url, anonKey, {
    auth: { storage: fileStorage(file), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const listeners = new Set();
  client.auth.onAuthStateChange(() => { for (const cb of listeners) { try { cb(); } catch { /* a listener's problem */ } } });

  async function currentSession() {
    try {
      const { data } = await client.auth.getSession();
      return data?.session || null;
    } catch { return null; }
  }

  // Every account looks the same to the rest of the schema: a profiles row
  // with a handle and the terms it accepted. Best effort; a certificate never
  // depends on it.
  async function ensureProfile(user) {
    if (!user) return;
    try {
      const { data } = await client.from("profiles").select("id").eq("id", user.id).maybeSingle();
      if (data) return;
      const row = {
        id: user.id,
        username: "writer_" + String(user.id).replace(/-/g, "").slice(0, 6),
        display_name: null,
        research_opt_in: true,
        tos_accepted_at: new Date().toISOString(),
        tos_version: TOS_VERSION,
      };
      const { error } = await client.from("profiles").upsert(row, { onConflict: "id", ignoreDuplicates: true });
      if (error) log(`profile not created: ${error.message}`);
    } catch (e) { log(`profile not created: ${e.message}`); }
  }

  // → { token } or { token: null, reason: "disabled" | "offline" | "error" }
  async function ensureToken() {
    const s = await currentSession();
    if (s?.access_token) return { token: s.access_token };
    try {
      const { data, error } = await client.auth.signInAnonymously();
      if (error || !data?.session) return { token: null, reason: classify(error) };
      await ensureProfile(data.session.user);
      return { token: data.session.access_token };
    } catch (e) {
      return { token: null, reason: classify(e) };
    }
  }

  async function signIn(email, password) {
    try {
      const { data, error } = await client.auth.signInWithPassword({ email: String(email || "").trim(), password: String(password || "") });
      if (error) return { ok: false, error: error.message === "Invalid login credentials" ? "That email and password don't match." : error.message };
      await ensureProfile(data.session?.user);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: classify(e) === "offline" ? "inkk.site can't be reached." : e.message };
    }
  }

  async function signOut() {
    try { await client.auth.signOut(); } catch { /* the local session is dropped either way */ }
  }

  // The popover used to keep its own session in localStorage. It hands that
  // over once, so nobody who had signed in has to do it again.
  async function importSession(tokens) {
    if (!tokens?.access_token || !tokens?.refresh_token) return false;
    if (await currentSession()) return false;
    try {
      const { error } = await client.auth.setSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
      return !error;
    } catch { return false; }
  }

  async function state() {
    const u = (await currentSession())?.user;
    return { signedIn: !!u, anonymous: !!u?.is_anonymous, email: u?.email || null };
  }

  async function authorName() {
    const u = (await currentSession())?.user;
    if (!u || u.is_anonymous) return null;
    try {
      const { data } = await client.from("profiles").select("display_name, username").eq("id", u.id).maybeSingle();
      return data?.display_name || null;
    } catch { return null; }
  }

  return {
    configured: true, ensureToken, signIn, signOut, importSession, state, authorName,
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

module.exports = { createAuth, fileStorage, classify, TOS_VERSION };
