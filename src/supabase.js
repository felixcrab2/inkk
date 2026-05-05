import { createClient } from '@supabase/supabase-js'

const url = process.env.REACT_APP_SUPABASE_URL
const key = process.env.REACT_APP_SUPABASE_ANON_KEY

// null when env vars are absent — app runs local-only in that case
export const supabase = (url && key) ? createClient(url, key) : null
