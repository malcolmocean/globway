// End-to-end verification of the Supabase sync path. Creates a temp user,
// signs in, upserts + reads its own section_state under RLS, then deletes it.
import fs from 'node:fs';

function envFrom(file) {
  const o = {};
  if (!fs.existsSync(file)) return o;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) o[m[1]] = m[2].replace(/\s+#.*$/, '').trim(); // strip inline comments
  }
  return o;
}
const e = { ...envFrom('.env'), ...envFrom('.env.local') };
const URL = e.PUBLIC_SUPABASE_URL, ANON = e.PUBLIC_SUPABASE_ANON_KEY, PAT = e.SUPABASE_PAT;
const ref = URL.match(/https:\/\/([^.]+)/)[1];

const ok = (label, cond, extra = '') => console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);

// 1. service_role key via Management API
const keys = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
  headers: { Authorization: `Bearer ${PAT}` },
}).then((r) => r.json());
const service = Array.isArray(keys) && keys.find((k) => k.name === 'service_role')?.api_key;
ok('fetched service_role key via PAT', !!service);
if (!service) process.exit(1);

const admin = { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' };
const email = `verify+${ref}@example.com`;
const password = 'Test-' + ref.slice(0, 10) + '!9';

// cleanup any prior test user
const existing = await fetch(`${URL}/auth/v1/admin/users`, { headers: admin }).then((r) => r.json());
for (const u of existing.users || []) if (u.email === email)
  await fetch(`${URL}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: admin });

// 2. create confirmed user
const created = await fetch(`${URL}/auth/v1/admin/users`, {
  method: 'POST', headers: admin,
  body: JSON.stringify({ email, password, email_confirm: true }),
}).then((r) => r.json());
ok('created temp user', !!created.id, created.id || JSON.stringify(created).slice(0, 80));
const uid = created.id;

// 3. sign in -> access token (role=authenticated)
const signin = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
}).then((r) => r.json());
ok('signed in (got JWT)', !!signin.access_token);
const jwt = signin.access_token;
const asUser = { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };

// 3b. confirm profile row was auto-created by the trigger
const prof = await fetch(`${URL}/rest/v1/profiles?select=id`, { headers: asUser }).then((r) => r.json());
ok('profile auto-created by trigger', Array.isArray(prof) && prof.length === 1);

// 4. upsert own section_state
const up = await fetch(`${URL}/rest/v1/section_state?on_conflict=user_id,section_key`, {
  method: 'POST',
  headers: { ...asUser, Prefer: 'resolution=merge-duplicates,return=representation' },
  body: JSON.stringify({ user_id: uid, section_key: 'quick-start-guide', read: true, starred: true,
    read_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
});
const upBody = await up.json();
ok('upsert section_state as user', up.status >= 200 && up.status < 300, `HTTP ${up.status}`);

// 5. read it back
const got = await fetch(`${URL}/rest/v1/section_state?select=section_key,read,starred`, { headers: asUser })
  .then((r) => r.json());
ok('read own row back', Array.isArray(got) && got.length === 1 && got[0].read === true,
  JSON.stringify(got));

// 6. RLS isolation: a *different* user must not see this row
const email2 = `verify2+${ref}@example.com`;
const u2 = await fetch(`${URL}/auth/v1/admin/users`, { method: 'POST', headers: admin,
  body: JSON.stringify({ email: email2, password, email_confirm: true }) }).then((r) => r.json());
const s2 = await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: email2, password }) }).then((r) => r.json());
const other = await fetch(`${URL}/rest/v1/section_state?select=section_key`, {
  headers: { apikey: ANON, Authorization: `Bearer ${s2.access_token}` } }).then((r) => r.json());
ok('RLS hides row from a different user', Array.isArray(other) && other.length === 0,
  JSON.stringify(other));

// 7. cleanup both temp users (cascades section_state)
for (const id of [uid, u2.id]) if (id)
  await fetch(`${URL}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: admin });
console.log('✓ cleaned up temp users');
