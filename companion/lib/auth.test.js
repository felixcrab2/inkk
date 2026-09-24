// Run: node --test lib/auth.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAuth, fileStorage, classify, TOS_VERSION } = require("./auth");

test("TOS_VERSION matches the website's", () => {
  const legal = fs.readFileSync(path.join(__dirname, "..", "..", "src", "components", "Legal.js"), "utf8");
  const m = /export const TOS_VERSION = "([^"]+)"/.exec(legal);
  assert.ok(m, "Legal.js exports TOS_VERSION");
  assert.strictEqual(TOS_VERSION, m[1]);
});

test("file storage persists, is private, and survives a fresh instance", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inkk-auth-")), "auth.json");
  const a = fileStorage(file);
  a.setItem("k", "v");
  assert.strictEqual(a.getItem("k"), "v");
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fileStorage(file).getItem("k"), "v");
  a.removeItem("k");
  assert.strictEqual(fileStorage(file).getItem("k"), null);
});

test("errors are classified: disabled, offline, other", () => {
  assert.strictEqual(classify({ code: "anonymous_provider_disabled", message: "Anonymous sign-ins are disabled" }), "disabled");
  assert.strictEqual(classify({ message: "Anonymous sign-ins are disabled" }), "disabled");
  assert.strictEqual(classify({ name: "AuthRetryableFetchError", message: "fetch failed" }), "offline");
  assert.strictEqual(classify({ message: "something else" }), "error");
});

// A fake supabase client with just what auth.js touches.
function fakeClient({ session = null, anonError = null } = {}) {
  let current = session;
  const profiles = new Map();
  const calls = { anon: 0, upserts: [] };
  const client = {
    calls,
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      getSession: async () => ({ data: { session: current } }),
      signInAnonymously: async () => {
        calls.anon++;
        if (anonError) return { data: {}, error: anonError };
        current = { access_token: "anon-token", user: { id: "11111111-2222-3333-4444-555555555555", is_anonymous: true } };
        return { data: { session: current }, error: null };
      },
      signInWithPassword: async ({ email, password }) => {
        if (password !== "right") return { data: {}, error: { message: "Invalid login credentials" } };
        current = { access_token: "user-token", user: { id: "aaaaaaaa-bbbb", email, is_anonymous: false } };
        return { data: { session: current }, error: null };
      },
      signOut: async () => { current = null; return { error: null }; },
      setSession: async (t) => { current = { access_token: t.access_token, user: { id: "imported", email: "x@y.z" } }; return { error: null }; },
    },
    from: () => ({
      select: () => ({ eq: (_c, id) => ({ maybeSingle: async () => ({ data: profiles.get(id) || null }) }) }),
      upsert: async (row) => { calls.upserts.push(row); profiles.set(row.id, row); return { error: null }; },
    }),
  };
  return client;
}

function authWith(client) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inkk-auth-")), "auth.json");
  return createAuth({ url: "https://x.supabase.co", anonKey: "k", file, createClient: () => client });
}

test("an existing session's token is used as is", async () => {
  const c = fakeClient({ session: { access_token: "t1", user: { id: "u" } } });
  assert.deepStrictEqual(await authWith(c).ensureToken(), { token: "t1" });
  assert.strictEqual(c.calls.anon, 0);
});

test("no session: signs in anonymously and creates the profile once", async () => {
  const c = fakeClient();
  const auth = authWith(c);
  assert.deepStrictEqual(await auth.ensureToken(), { token: "anon-token" });
  assert.strictEqual(c.calls.upserts.length, 1);
  assert.match(c.calls.upserts[0].username, /^writer_[0-9a-f]{6}$/);
  assert.strictEqual(c.calls.upserts[0].tos_version, TOS_VERSION);
  assert.deepStrictEqual(await auth.state(), { signedIn: true, anonymous: true, email: null });
});

test("anonymous sign-ins disabled: says so, so the popover can ask for a password", async () => {
  const c = fakeClient({ anonError: { code: "anonymous_provider_disabled", message: "Anonymous sign-ins are disabled" } });
  const auth = authWith(c);
  assert.deepStrictEqual(await auth.ensureToken(), { token: null, reason: "disabled" });
  assert.deepStrictEqual(await auth.signIn("me@x.com", "wrong"), { ok: false, error: "That email and password don't match." });
  assert.deepStrictEqual(await auth.signIn("me@x.com", "right"), { ok: true });
  assert.deepStrictEqual(await auth.ensureToken(), { token: "user-token" }, "the sign-in sticks: certify gets this token");
  assert.deepStrictEqual(await auth.state(), { signedIn: true, anonymous: false, email: "me@x.com" });
});

test("an old popover session is imported once, never over a live one", async () => {
  const c = fakeClient();
  const auth = authWith(c);
  assert.strictEqual(await auth.importSession({ access_token: "a", refresh_token: "r" }), true);
  assert.strictEqual(await auth.importSession({ access_token: "b", refresh_token: "r" }), false);
  assert.deepStrictEqual(await auth.ensureToken(), { token: "a" });
});

test("unconfigured builds fail softly", async () => {
  const auth = createAuth({});
  assert.strictEqual(auth.configured, false);
  assert.deepStrictEqual(await auth.ensureToken(), { token: null, reason: "disabled" });
});
