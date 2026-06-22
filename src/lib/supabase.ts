// Browser Supabase client. Keys are PUBLIC_ env vars inlined at build time.
// If unconfigured, returns null and the app falls back to localStorage-only mode
// (so the site is fully usable locally before Supabase is set up).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;
export function getSupabase(): SupabaseClient | null {
  if (!isConfigured) return null;
  if (!client) {
    client = createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}
