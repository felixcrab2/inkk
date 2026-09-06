import { createClient } from '@supabase/supabase-js'

const url = process.env.REACT_APP_SUPABASE_URL
const key = process.env.REACT_APP_SUPABASE_ANON_KEY

// null when env vars are absent — app runs local-only in that case
// PKCE so the native app can finish OAuth via deep link (exchangeCodeForSession);
// on the web the code in the URL is exchanged automatically on load.
export const supabase = (url && key) ? createClient(url, key, { auth: { flowType: 'pkce' } }) : null
