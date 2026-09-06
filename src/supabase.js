import { createClient } from '@supabase/supabase-js'

const url = process.env.REACT_APP_SUPABASE_URL
const key = process.env.REACT_APP_SUPABASE_ANON_KEY

// If an OAuth code lands here that THIS context cannot exchange (no PKCE
// verifier in storage), it belongs to the native app: the flow started in the
// app's webview and Supabase redirected to the site instead of the app's deep
// link (e.g. the scheme missing from the dashboard allowlist). Bounce the code
// home before the client tries and fails. iOS-only, and never inside the app
// itself, so normal web sign-ins are untouched.
try {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  const inApp = !!window.Capacitor
  const hasVerifier = Object.keys(window.localStorage || {}).some(k => k.includes('code-verifier'))
  if (code && isIOS && !inApp && !hasVerifier) {
    window.location.replace('inkk://auth-callback?code=' + encodeURIComponent(code))
  }
} catch { /* SSR or storage unavailable */ }

// null when env vars are absent — app runs local-only in that case
// PKCE so the native app can finish OAuth via deep link (exchangeCodeForSession);
// on the web the code in the URL is exchanged automatically on load.
export const supabase = (url && key) ? createClient(url, key, { auth: { flowType: 'pkce' } }) : null
