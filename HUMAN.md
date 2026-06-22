# Setup steps that need you (Malcolm)

The app is built and runs **right now** in localStorage-only mode (try
`npm run dev`). To turn on cross-device sync and put it online, do these. None are
hard; the only one that truly blocks me is creating the Supabase project (needs
your login).

---

## 1. Supabase project (the one real blocker — ~5 min)

1. Go to <https://supabase.com> → sign in → **New project**.
   - Name: `globway` (anything). Pick a region near you. Save the DB password somewhere; you won't need it for the app.
2. Once it's provisioned: left sidebar → **SQL Editor** → **New query** → paste the
   entire contents of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   (Creates `profiles` + `section_state` with row-level security.)
3. Left sidebar → **Project Settings → API**. Copy two values:
   - **Project URL** → this is `PUBLIC_SUPABASE_URL`
   - **anon public** key → this is `PUBLIC_SUPABASE_ANON_KEY`
     (Safe to expose publicly — RLS protects the data.)
4. **Auth → Sign In / Providers**: confirm **Email** is enabled (it is by default).
   Magic links work out of the box. Under **Auth → URL Configuration**, add your
   site URL(s) to **Redirect URLs** (e.g. `http://localhost:4321/**` for local and
   your production URL once you have it), so the magic link returns to the app.

> Paste those two values back to me (or into `.env.local`) and I'll wire them in.
> The anon key is public-safe, so it's fine to share.

---

## 2. GitHub repo Variables (so the deployed site gets the keys)

In the GitHub repo → **Settings → Secrets and variables → Actions → Variables tab**
→ **New repository variable**, add:

| Name | Value |
|------|-------|
| `PUBLIC_SUPABASE_URL` | the Project URL from step 1 |
| `PUBLIC_SUPABASE_ANON_KEY` | the anon public key from step 1 |
| `PUBLIC_SITE_URL` | your final site URL, e.g. `https://meditation.yourdomain` |
| `PUBLIC_BASE_PATH` | leave **unset** for a custom domain; set to `/globway` to preview on the github.io project page |

(These are Variables, not Secrets — the anon key is meant to be public. Using
Variables means they're visible in build logs, which is fine.)

---

## 3. Enable GitHub Pages

Repo → **Settings → Pages** → **Build and deployment → Source: GitHub Actions**.
Then the `Deploy` workflow runs on every push to `main`. I may have enabled this
for you already (check the **Actions** tab for a green run).

---

## 4. Domain decision (to avoid the `/projname` path issue)

You flagged the GitHub Pages base-path annoyance. Two clean options:

- **Custom domain (recommended):** Settings → Pages → **Custom domain** → enter e.g.
  `meditation.yourdomain.com`, then add the DNS record your registrar needs
  (a `CNAME` row pointing to `malcolmocean.github.io`). Leave `PUBLIC_BASE_PATH`
  unset. I'll add a `public/CNAME` file once you pick the domain.
- **Quick preview without a domain:** set Variable `PUBLIC_BASE_PATH=/globway`. The
  site works at `https://malcolmocean.github.io/globway/` immediately (all links are
  base-aware, so switching later is a one-line change).

Tell me which domain you want and I'll set the `CNAME` + `PUBLIC_SITE_URL`.

---

## What I've already done

- Repo scaffolded, content parser, full Astro site (Map + 340 section pages +
  legacy-anchor redirects), read/star sync code, deploy workflow, schema SQL.
- Verified locally in a browser: rendering, read/star toggles, persistence.
- Pushed to GitHub (see the repo's Actions tab).

## What's deferred (designed-for, next milestones)

Notes per section · "try this for N min" timer + log · LLM section Q&A · random
preliminary/auxiliary-practice nudges · sub-tweet leaf fusion.
