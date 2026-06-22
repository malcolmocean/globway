// Client runtime: auth (magic-link) + read/star state sync.
// Works in three modes transparently:
//   1. Supabase configured + signed in  -> synced across devices.
//   2. Supabase configured + signed out -> local only; prompts to sign in to sync.
//   3. Supabase not configured           -> local only (dev / pre-setup).
import { getSupabase, isConfigured } from '../lib/supabase';

type Entry = { read?: boolean; starred?: boolean; updated_at: string };
type State = Record<string, Entry>;

const LS_KEY = 'globway:state';
const sb = getSupabase();

function loadLocal(): State {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function saveLocal(s: State) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }

let state: State = loadLocal();

// ---- DOM application --------------------------------------------------------
function applyEntry(key: string) {
  const e = state[key] || {};
  document.querySelectorAll<HTMLElement>(`[data-key="${cssEscape(key)}"]`).forEach((el) => {
    const action = el.getAttribute('data-action');
    if (action === 'read') setPressed(el, !!e.read);
    if (action === 'star') setPressed(el, !!e.starred);
  });
  document.querySelectorAll<HTMLElement>(`[data-row-key="${cssEscape(key)}"]`).forEach((row) => {
    row.classList.toggle('is-read', !!e.read);
    row.classList.toggle('is-starred', !!e.starred);
  });
}
function applyAll() { Object.keys(state).forEach(applyEntry); refreshProgress(); }
function setPressed(el: HTMLElement, on: boolean) {
  el.setAttribute('aria-pressed', String(on));
  el.classList.toggle('is-on', on);
}
function cssEscape(s: string) { return (window as any).CSS?.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'); }

function refreshProgress() {
  const total = document.querySelectorAll('[data-row-key]').length;
  if (!total) return;
  const read = Object.values(state).filter((e) => e.read).length;
  document.querySelectorAll<HTMLElement>('[data-progress]').forEach((el) => {
    el.textContent = `${read} read`;
  });
}

// ---- mutations --------------------------------------------------------------
async function toggle(key: string, field: 'read' | 'starred') {
  const cur = state[key] || { updated_at: '' };
  const next: Entry = { ...cur, [field]: !cur[field], updated_at: new Date().toISOString() };
  state[key] = next;
  saveLocal(state);
  applyEntry(key);
  refreshProgress();
  if (sb && (await getSession())) {
    const { error } = await sb.from('section_state').upsert(
      { user_id: (await getSession())!.user.id, section_key: key,
        read: !!next.read, starred: !!next.starred,
        read_at: next.read ? next.updated_at : null, updated_at: next.updated_at },
      { onConflict: 'user_id,section_key' }
    );
    if (error) console.warn('[globway] sync upsert failed:', error.message);
  }
}

// ---- auth -------------------------------------------------------------------
async function getSession() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

async function pullRemote() {
  if (!sb) return;
  const session = await getSession();
  if (!session) return;
  const { data, error } = await sb.from('section_state').select('*');
  if (error) { console.warn('[globway] pull failed:', error.message); return; }
  const remote: State = {};
  for (const r of data || []) remote[r.section_key] = {
    read: r.read, starred: r.starred, updated_at: r.updated_at || new Date(0).toISOString(),
  };
  // Merge: last-write-wins by updated_at. Push local-only/newer entries up.
  const upserts: any[] = [];
  for (const [key, le] of Object.entries(state)) {
    const re = remote[key];
    if (!re || (le.updated_at || '') > (re.updated_at || '')) {
      remote[key] = le;
      upserts.push({ user_id: session.user.id, section_key: key,
        read: !!le.read, starred: !!le.starred,
        read_at: le.read ? le.updated_at : null, updated_at: le.updated_at });
    }
  }
  if (upserts.length) await sb.from('section_state').upsert(upserts, { onConflict: 'user_id,section_key' });
  state = remote;
  saveLocal(state);
  applyAll();
}

function renderAuth(session: any) {
  const signedIn = !!session;
  document.querySelectorAll<HTMLElement>('[data-auth-status]').forEach((el) => {
    el.textContent = !isConfigured
      ? 'local only'
      : signedIn ? (session.user.email || 'signed in') : 'signed out';
  });
  document.querySelectorAll<HTMLElement>('[data-when="signed-in"]').forEach(
    (el) => (el.hidden = !signedIn));
  document.querySelectorAll<HTMLElement>('[data-when="signed-out"]').forEach(
    (el) => (el.hidden = signedIn || !isConfigured));
  document.querySelectorAll<HTMLElement>('[data-when="unconfigured"]').forEach(
    (el) => (el.hidden = isConfigured));
}

function wireAuth() {
  document.querySelectorAll<HTMLFormElement>('[data-auth-form]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!sb) return;
      const email = (form.querySelector('input[type=email]') as HTMLInputElement)?.value?.trim();
      const msg = form.querySelector('[data-auth-msg]') as HTMLElement | null;
      if (!email) return;
      const { error } = await sb.auth.signInWithOtp({
        email, options: { emailRedirectTo: window.location.href },
      });
      if (msg) msg.textContent = error ? `Error: ${error.message}` : 'Check your email for a magic link.';
    });
  });
  document.querySelectorAll<HTMLElement>('[data-signout]').forEach((btn) =>
    btn.addEventListener('click', async () => { await sb?.auth.signOut(); location.reload(); }));
}

// ---- wire controls ----------------------------------------------------------
function wireControls() {
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action][data-key]');
    if (!el) return;
    const key = el.getAttribute('data-key')!;
    const action = el.getAttribute('data-action');
    if (action === 'read') toggle(key, 'read');
    if (action === 'star') toggle(key, 'starred');
  });
}

// ---- boot -------------------------------------------------------------------
async function boot() {
  wireControls();
  wireAuth();
  applyAll();
  if (sb) {
    const session = await getSession();
    renderAuth(session);
    await pullRemote();
    sb.auth.onAuthStateChange((_evt, session) => { renderAuth(session); pullRemote(); });
  } else {
    renderAuth(null);
  }
}
document.addEventListener('DOMContentLoaded', boot);
