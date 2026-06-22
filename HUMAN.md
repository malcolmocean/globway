# Globway — status & the few knobs that are yours

**The site is LIVE: <https://globway.top>** (public repo → GitHub Pages via Actions,
HTTPS enforced). Cross-device sync via Supabase is wired and verified.

## Done (no action needed)

- Repo public, GitHub Pages deploying from `main` on every push.
- Custom domain `globway.top` (apex A + IPv6 AAAA DNS by you; `public/CNAME` + Pages
  config by me); HTTPS enforced.
- Repo Variables set: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`,
  `PUBLIC_SITE_URL=https://globway.top`.
- Supabase project `dtwlfemapsdzklzesgym`: schema + RLS + grants applied
  (`supabase/migrations/`); sync verified end-to-end (create user → sign in → upsert →
  read back → RLS isolation between users).
- Supabase Auth **Site URL** = `https://globway.top`, redirect allowlist =
  `https://globway.top/**`, `http://localhost:4321/**`. (This is what was sending
  magic links to `localhost:3000`.)

## Your remaining knobs (optional)

- **Sign-in test:** request a fresh magic link on the live site — it should return you
  to `globway.top` signed in, and your read/star marks then sync across devices.
- **PAT expiry:** the personal access token in `.env` expires **~2026-07-22**. After
  that I can't drive Supabase directly (migrations/admin) until you drop in a new one
  (<https://supabase.com/dashboard/account/tokens>). The live site is unaffected — it
  only uses the public anon key.
- **Email sender:** magic links currently come from Supabase's shared mailer (fine for
  you + a few people; rate-limited). For Mark's-community scale, add a custom SMTP
  sender in Supabase → Auth → SMTP later.

## Credentials

`.env` (gitignored) holds `SUPABASE_PW` (DB password) + `SUPABASE_PAT` (management
token). `.env.local` (gitignored) holds the public Supabase URL + anon key for local
dev. Never commit either; the anon/publishable key is public-safe by design.

## Deferred features (designed-for, next milestones)

Per-section notes · "try this for N min" timer + log · LLM section Q&A · random
preliminary/auxiliary-practice nudges · sub-tweet leaf fusion.
