import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { supabase } from "../supabase";
import { PrivacyModal, TermsModal, TOS_VERSION } from "../components/Legal";
import { isMobile } from "../lib/text";
import { fetchProfileByUsername } from "../lib/profile";

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export const PW_MIN = 8;

export function passwordChecks(pw) {
  return {
    length: pw.length >= PW_MIN,
    letter: /[a-zA-Z]/.test(pw),
    number: /[0-9]/.test(pw),
  };
}

// ─── Google Identity Services (ID-token sign-in) ──────────────────────────────
// On DESKTOP, when REACT_APP_GOOGLE_CLIENT_ID is set, "continue with Google"
// uses Google's own button to obtain an ID token in-page, which we hand to
// supabase.auth.signInWithIdToken. The whole consent flow runs on our own
// domain (no redirect), so Google's screen shows the Inkk app.
//
// On MOBILE that in-page flow is unusable: Google's popup/transform step loses
// its opener and dead-ends on a blank accounts.google.com/gsi/transform page,
// so sign-in never returns. Mobile therefore uses the full-page redirect flow
// (signInWithOAuth). Google's consent screen still shows "inkk" (set via the
// OAuth consent screen's App name), so branding holds; the only cosmetic cost
// is a brief <ref>.supabase.co in the address bar mid-redirect. Without the env
// var, everything falls back to the redirect flow.
export const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || "";

export let gsiScriptPromise = null;

export function loadGoogleIdentity() {
  if (gsiScriptPromise) return gsiScriptPromise;
  gsiScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load Google sign-in."));
    document.head.appendChild(s);
  });
  return gsiScriptPromise;
}

// Supabase validates the nonce by SHA-256-hashing the value passed to
// signInWithIdToken and matching it to the token's nonce claim — so Google gets
// the hashed nonce and Supabase gets the raw one.
export async function makeGoogleNonce() {
  const raw = window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  return { raw, hashed };
}

export function AuthModal({ onClose, initialMode = "signin" }) {
  const [mode, setMode]             = useState(initialMode); // signin | signup | reset
  const [email, setEmail]           = useState("");
  const [username, setUsername]     = useState("");
  const [password, setPassword]     = useState("");
  const [showPw, setShowPw]         = useState(false);
  const [accepted, setAccepted]     = useState(false);
  const [showTerms, setShowTerms]   = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [error, setError]           = useState("");
  const [message, setMessage]       = useState("");
  const [loading, setLoading]       = useState(false);
  const [unameStatus, setUnameStatus] = useState(""); // "" | checking | available | taken | invalid
  const [resend, setResend]         = useState("");   // "" | sending | sent
  const [needsConfirm, setNeedsConfirm] = useState(false); // show "resend confirmation" UI
  const [gsiReady, setGsiReady]     = useState(false);     // Google Identity script loaded
  const sentEmailRef                = useRef("");
  const googleBtnRef                = useRef(null);        // host for Google's rendered button
  const acceptedRef                 = useRef(false);       // latest Terms state for the GIS callback

  // In-page Google button on desktop only. On mobile it dead-ends on Google's
  // blank /gsi/transform page, so mobile (and the no-client-id fallback) uses
  // the redirect flow instead. See the GOOGLE_CLIENT_ID note above.
  const [useGsi] = useState(() => !!GOOGLE_CLIENT_ID && !isMobile());

  const switchMode = (m) => {
    setMode(m); setError(""); setMessage(""); setResend(""); setNeedsConfirm(false);
    if (m === "reset") setPassword("");
  };

  // Live username availability check (signup only, debounced).
  useEffect(() => {
    if (mode !== "signup") return;
    const u = username.trim();
    if (!u)                    { setUnameStatus(""); return; }
    if (!USERNAME_RE.test(u))  { setUnameStatus("invalid"); return; }
    setUnameStatus("checking");
    let alive = true;
    const t = setTimeout(async () => {
      const existing = await fetchProfileByUsername(u);
      if (alive) setUnameStatus(existing ? "taken" : "available");
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [username, mode]);

  // Keep the latest Terms state available to the (long-lived) GIS callback.
  useEffect(() => { acceptedRef.current = accepted; }, [accepted]);

  // Load Google Identity Services once, if we're using the in-page button.
  useEffect(() => {
    if (!useGsi) return;
    let active = true;
    loadGoogleIdentity().then(() => { if (active) setGsiReady(true); }).catch(() => {});
    return () => { active = false; };
  }, [useGsi]);

  // Render Google's button as soon as the script is ready (so it's never a dead
  // placeholder). Terms are enforced inside the callback, which exchanges the
  // Google ID token for a Supabase session via signInWithIdToken — no redirect
  // ever leaves our own domain.
  useEffect(() => {
    if (!useGsi || !gsiReady || mode === "reset") return;
    const el = googleBtnRef.current;
    const gid = window.google?.accounts?.id;
    if (!el || !gid) return;
    let active = true;
    makeGoogleNonce().then(({ raw, hashed }) => {
      if (!active) return;
      gid.initialize({
        client_id: GOOGLE_CLIENT_ID,
        nonce: hashed,
        callback: async (resp) => {
          if (!acceptedRef.current) {
            setError("Please accept the Terms & Privacy Policy first.");
            return;
          }
          // Record Terms acceptance for the profile auto-provisioner.
          try { localStorage.setItem("inkk_pending_tos", TOS_VERSION); } catch {}
          const { error } = await supabase.auth.signInWithIdToken({
            provider: "google", token: resp.credential, nonce: raw,
          });
          if (error) setError(error.message);
        },
      });
      el.innerHTML = "";
      gid.renderButton(el, {
        type: "standard", theme: "outline", size: "large",
        text: "continue_with", shape: "pill", logo_alignment: "center", width: 272,
      });
    }).catch(() => {});
    return () => { active = false; };
  }, [useGsi, gsiReady, mode]);

  const pw       = passwordChecks(password);
  const pwOk     = pw.length && pw.letter && pw.number;
  const unameOk  = USERNAME_RE.test(username.trim()) && unameStatus !== "taken";
  const signupReady = !!email && unameOk && pwOk && accepted;

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setMessage(""); setNeedsConfirm(false);

    if (mode === "signin") {
      setLoading(true);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setLoading(false);
      if (error) {
        // Correct password but the address was never confirmed — Supabase returns
        // a dedicated code/message. Surface it clearly and offer a resend instead
        // of the generic "invalid credentials".
        if (error.code === "email_not_confirmed" || /not confirmed/i.test(error.message || "")) {
          sentEmailRef.current = email;
          setNeedsConfirm(true);
          setMessage(`${email} hasn't been confirmed yet. Check your inbox for the confirmation link to finish signing in.`);
        } else {
          setError(error.message);
        }
      }
      return;
    }

    if (mode === "reset") {
      setLoading(true);
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/?recovery=1",
      });
      setLoading(false);
      if (error) setError(error.message);
      else setMessage("Check your email for a link to reset your password.");
      return;
    }

    // signup
    const u = username.trim();
    if (!USERNAME_RE.test(u)) { setError("Username must be 3–20 characters."); return; }
    if (!pwOk)                { setError(`Password needs at least ${PW_MIN} characters, a letter, and a number.`); return; }
    if (!accepted)            { setError("Please accept the Terms & Privacy Policy to continue."); return; }

    setLoading(true);
    // Final availability check right before we commit.
    const existing = await fetchProfileByUsername(u);
    if (existing) { setUnameStatus("taken"); setError("That username is already taken. Please try another."); setLoading(false); return; }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        data: { username: u, display_name: u, tos_accepted: true, tos_version: TOS_VERSION },
      },
    });
    setLoading(false);
    if (error) { setError(error.message); return; }
    if (data.user?.identities?.length === 0) {
      setError("An account with this email already exists. Try signing in.");
      return;
    }
    sentEmailRef.current = email;
    // No session means email confirmation is required; a session means we're in
    // and onAuthStateChange will create the profile from the metadata above.
    if (!data.session) {
      setNeedsConfirm(true);
      setMessage(`We sent a confirmation link to ${email}. Open it to finish creating your account.`);
    }
  };

  const resendConfirmation = async () => {
    if (!sentEmailRef.current || resend === "sending") return;
    setResend("sending"); setError("");
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: sentEmailRef.current,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) { setResend(""); setError(error.message); }
    else setResend("sent");
  };

  const googleSignIn = async () => {
    // Google has no username/Terms step of its own, so the agreement is ticked
    // in the modal first. The button stays tappable even when it isn't, so the
    // tap can explain why nothing happens (a disabled button is silent, which
    // reads as broken — especially on mobile).
    if (!accepted) {
      setError("Please accept the Terms & Privacy Policy to continue with Google.");
      return;
    }
    setError("");
    // Stash the acceptance across the OAuth redirect so the profile provisioned
    // on return records the Terms acceptance.
    try { localStorage.setItem("inkk_pending_tos", TOS_VERSION); } catch {}
    if (window.Capacitor?.isNativePlatform?.()) {
      // In the app, a plain redirect escapes to Safari and strands the session
      // there. Run the flow in an in-app browser sheet and come home on the
      // inkk:// deep link instead.
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: "inkk://auth-callback", skipBrowserRedirect: true },
      });
      if (error) { setError(error.message); return; }
      try {
        const { Browser } = await import("@capacitor/browser");
        await Browser.open({ url: data.url, presentationStyle: "popover" });
      } catch {
        window.location.href = data.url;
      }
      return;
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    // If the redirect can't be started, surface it instead of failing silently.
    if (error) setError(error.message);
  };

  const unameHint = {
    checking:  { text: "checking…",        cls: "muted" },
    available: { text: "available",         cls: "ok" },
    taken:     { text: "already taken",     cls: "bad" },
    invalid:   { text: "3–20 chars", cls: "muted" },
  }[unameStatus];

  // The modal only closes via the × button — never on a backdrop click,
  // text-selection drag, or key press.
  return (
    <>
    <div id="auth-overlay">
      <div id="auth-modal">
        <button id="auth-close" onClick={onClose}>×</button>
        {message ? (
          <div id="auth-message-wrap">
            <p id="auth-message">{message}</p>
            {needsConfirm && sentEmailRef.current && (
              <div className="auth-resend">
                {resend === "sent"
                  ? <span className="auth-resend-done">Sent again. Please check your inbox and spam folder.</span>
                  : <>Didn't get it? <button type="button" onClick={resendConfirmation} disabled={resend === "sending"}>{resend === "sending" ? "sending…" : "resend confirmation email"}</button></>}
                <button type="button" className="auth-back" onClick={() => { setMessage(""); setResend(""); }}>← back</button>
              </div>
            )}
          </div>
        ) : mode === "reset" ? (
          <>
            <div id="auth-tabs">
              <button className="active" style={{ cursor: "default" }}>Reset password</button>
            </div>
            <p className="auth-blurb">Enter the email you signed up with and we'll send you a link to set a new password.</p>
            <form onSubmit={submit}>
              <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus={!isMobile()} />
              {error && <p className="auth-error">{error}</p>}
              <button id="auth-submit" type="submit" disabled={loading}>
                {loading ? "…" : "Send reset link"}
              </button>
            </form>
            <button className="auth-back" onClick={() => switchMode("signin")}>← back to sign in</button>
          </>
        ) : (
          <>
            <div id="auth-tabs">
              <button className={mode === "signin" ? "active" : ""} onClick={() => switchMode("signin")}>Sign in</button>
              <button className={mode === "signup" ? "active" : ""} onClick={() => switchMode("signup")}>Create account</button>
            </div>
            <form onSubmit={submit}>
              {/* Don't autofocus on mobile: it pops the keyboard the moment the
                  modal opens, covering the "continue with Google" button. The
                  keyboard should only appear when a field is actually tapped. */}
              <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus={!isMobile()} autoComplete="email" />

              {mode === "signup" && (
                <>
                  <div className="auth-field">
                    <input
                      type="text"
                      placeholder="Username"
                      value={username}
                      onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                      maxLength={20}
                      required
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                    {unameHint && <span className={`auth-uname-hint ${unameHint.cls}`}>{unameHint.text}</span>}
                  </div>
                </>
              )}

              <div className="auth-field">
                <input
                  type={showPw ? "text" : "password"}
                  placeholder="Password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                />
                {password && (
                  <button type="button" className="auth-pw-toggle" onClick={() => setShowPw(v => !v)} aria-label={showPw ? "Hide password" : "Show password"}>
                    {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                )}
              </div>

              {mode === "signup" && password && !pwOk && (
                <ul className="auth-pw-reqs">
                  <li className={pw.length ? "met" : ""}>{pw.length ? "✓" : "○"} at least {PW_MIN} characters</li>
                  <li className={pw.letter ? "met" : ""}>{pw.letter ? "✓" : "○"} a letter</li>
                  <li className={pw.number ? "met" : ""}>{pw.number ? "✓" : "○"} a number</li>
                </ul>
              )}

              {mode === "signup" && (
                <label id="tos-consent" className="auth-tos">
                  <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />
                  <span id="tos-consent-text">
                    I agree to the{" "}
                    <button type="button" className="tos-link" onClick={() => setShowTerms(true)}>Terms</button>
                    {" "}and{" "}
                    <button type="button" className="tos-link" onClick={() => setShowPrivacy(true)}>Privacy Policy</button>
                    , including contributing my anonymised writing-process data to Inkk's research dataset. I can opt out anytime from Notes.
                  </span>
                </label>
              )}

              {error && <p className="auth-error">{error}</p>}
              <button id="auth-submit" type="submit" disabled={loading || (mode === "signup" && !signupReady)}>
                {loading ? "…" : mode === "signin" ? "Sign in" : "Create account"}
              </button>
            </form>
            {mode === "signin" && (
              <button className="auth-forgot" onClick={() => switchMode("reset")}>
                Forgot password?
              </button>
            )}
            <div id="auth-divider"><span>or</span></div>
            {/* Google has no username/Terms step of its own, so the agreement is
                collected here and carried across the OAuth redirect. In create-
                account mode the in-form checkbox above already covers it. */}
            {mode === "signin" && (
              <label id="tos-consent" className="auth-tos">
                <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />
                <span id="tos-consent-text">
                  I agree to the{" "}
                  <button type="button" className="tos-link" onClick={() => setShowTerms(true)}>Terms</button>
                  {" "}and{" "}
                  <button type="button" className="tos-link" onClick={() => setShowPrivacy(true)}>Privacy Policy</button>
                  , including contributing my anonymised writing-process data to Inkk's research dataset. I can opt out anytime from Notes.
                </span>
              </label>
            )}
            {useGsi ? (
              <div ref={googleBtnRef} style={{ display: "flex", justifyContent: "center" }} />
            ) : (
              <button id="google-btn" onClick={googleSignIn}>Continue with Google</button>
            )}
          </>
        )}
      </div>
    </div>
    {showPrivacy && <PrivacyModal onClose={() => setShowPrivacy(false)} />}
    {showTerms   && <TermsModal   onClose={() => setShowTerms(false)} />}
    </>
  );
}

// ─── UpdatePasswordModal ──────────────────────────────────────────────────────
// Shown after the user clicks a password-recovery link in their email, or
// from the Notes page "Change password" entry. Calls supabase.auth.updateUser.

export function UpdatePasswordModal({ onClose, onDone }) {
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


// ─── DownloadModal ────────────────────────────────────────────────────────────
