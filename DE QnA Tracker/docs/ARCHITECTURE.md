# Architecture

This document explains *how the app actually works* — what talks to what, and where each piece lives.

## The big picture

```
┌──────────────────────────────┐         ┌─────────────────────────────────────┐
│                              │         │                                     │
│   User's web browser         │         │           Supabase                  │
│   (the staff laptop)         │         │     (your hosted backend)           │
│                              │         │                                     │
│  ┌────────────────────────┐  │   HTTPS │  ┌──────────────────────────────┐   │
│  │   index.html           │◄─┼─────────┼─►│  PostgREST (auto REST API)   │   │
│  │   (the whole app)      │  │         │  └──────────────────────────────┘   │
│  │                        │  │         │  ┌──────────────────────────────┐   │
│  │   Supabase JS client   │◄─┼─────────┼─►│  Supabase Realtime (WebSocket)│  │
│  │   (auth + queries)     │  │         │  └──────────────────────────────┘   │
│  └────────────────────────┘  │         │  ┌──────────────────────────────┐   │
│            │                 │         │  │  Supabase Auth (Google OAuth)│   │
└────────────┼─────────────────┘         │  └──────────────────────────────┘   │
             │                            │  ┌──────────────────────────────┐   │
             │                            │  │  PostgreSQL database         │   │
             ▼                            │  │   • Tables                   │   │
   ┌──────────────────┐                   │  │   • Row Level Security       │   │
   │     Netlify      │                   │  │   • Triggers & functions     │   │
   │  (hosts the      │                   │  │   • Indexes                  │   │
   │   HTML file)     │                   │  └──────────────────────────────┘   │
   └──────────────────┘                   └─────────────────────────────────────┘
```

## What does what

### Netlify

**Job:** Serves the static HTML/CSS/JS file to the user's browser. That's it.

Netlify doesn't run any code, doesn't talk to the database, and doesn't know about users. It's a glorified file server with a global CDN, automatic HTTPS, and one-click deploys from GitHub.

### Supabase

**Job:** Everything else — database, authentication, real-time updates.

Supabase is your "backend" without writing any backend code. It exposes your PostgreSQL tables as a secure REST API automatically. The same tables, when subscribed to, push real-time updates over WebSockets — that's how live chat works.

### The HTML file (`index.html`)

**Job:** Runs in the user's browser. Reads/writes data via the Supabase JS client. Renders everything.

Inside, it has:

- **CSS** (lines ~14–1144): All visual styling.
- **HTML markup** (lines ~1545–2099): Seven "pages" (login, submit, all questions, review, admin, FAQ, privacy) all in the same file. JavaScript hides/shows them.
- **JavaScript** (lines ~2101–9224): Two `<script>` blocks. The second one ("V2 OVERRIDES") redefines many of the same functions from the first one. Only the second definition runs — the first is dead code that should eventually be removed.

> **About the dual definitions:** Your current `index.html` has two `init()`, two `submitQuestion()`, two `loadReviewData()`, etc. JavaScript uses the last declaration, so the V2 versions are what runs. The original definitions take ~1700 lines and do nothing. Removing them is safe and is the single biggest cleanup win available, but it requires careful review — track it as a backlog task, not an emergency fix.

## How a single click flows through the system

Take: **a staff member clicks "Submit Question".**

1. **Browser** — JavaScript reads the form values and calls `sb.from('questions').insert(...)`.
2. **Supabase JS client** — Adds the user's auth token (from Google sign-in) and POSTs to the auto-generated REST endpoint.
3. **PostgREST** — Receives the request and asks PostgreSQL to insert the row.
4. **Row Level Security** — PostgreSQL checks the `questions_insert_authenticated` policy: *"Is the submitter_email equal to this user's email? Or are they a reviewer?"* — if yes, the insert proceeds.
5. **Trigger fires** — The `trigger_set_question_id` trigger auto-fills `question_id = 'Q-001'` (or next number).
6. **Trigger fires (2)** — The `trigger_set_question_defaults` trigger calculates `due_at` using the SLA settings.
7. **Response** — Postgres returns the newly created row, all the way back to the browser.
8. **Realtime broadcast** — If anyone else has a subscription to the `questions` table (not currently used, but possible), they receive the new row over WebSocket.

The whole round trip takes 100–300 ms. No backend code was written.

## Security model in one paragraph

The browser is **not trusted**. Anyone can open dev tools and call `sb.from('questions').delete()` if they want. That's fine, because **Row Level Security in the database is what actually protects your data.** Every table has policies that say *"You may only do X if Y is true,"* and the database rejects unauthorized queries no matter where they come from. The frontend's role checks (`isReviewer()`, `isAdmin()`) only control what the UI *shows*, not what's actually allowed. The real enforcement is in `00_baseline.sql` section 8.

See [`SECURITY.md`](SECURITY.md) for the full breakdown.

## Why no separate backend?

You asked whether to add Node.js / Python / PHP. **No — and here's why:**

| Need                        | Solved by             |
|-----------------------------|-----------------------|
| Storing data                | Supabase PostgreSQL   |
| Reading/writing data        | Supabase REST API     |
| Authentication              | Supabase Auth + Google|
| Permission rules            | Row Level Security    |
| Live chat                   | Supabase Realtime     |
| File uploads (future)       | Supabase Storage      |
| Sending emails (future)     | Supabase Edge Functions or third-party |
| Scheduled jobs (future)     | Supabase pg_cron      |

There is **nothing this app needs** that requires running custom server code. Adding a Node.js or Python backend would mean: another piece to host, another piece to update, another set of credentials, another place for bugs to hide. For an internal office tool with maybe a few dozen users, that's pure cost with no benefit.

If you ever need server-side logic (e.g. sending Slack notifications when a question is answered), Supabase has **Edge Functions** — small serverless functions that run in their cloud. You add them as needed, you never run a server.
