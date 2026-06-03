# Recommended Professional Folder Structure

This package uses a beginner-friendly structure that still follows production habits.

```text
qa-management-app/
├── public/
│   ├── index.html              # Current app, patched but not rewritten
│   ├── config.js               # Current working Supabase config
│   ├── config.example.js       # Safe template for future projects
│   └── privacy.html            # Missing page added
│
├── supabase/
│   └── migrations/
│       ├── 0000_baseline.sql
│       └── 0001_production_hardening.sql
│
├── docs/
│   ├── PROJECT_AUDIT.md
│   ├── REFACTOR_ROADMAP.md
│   ├── PRODUCTION_CHECKLIST.md
│   └── ...existing docs...
│
├── scripts/
│   └── project_audit.py
│
├── netlify.toml
├── package.json
├── CHANGELOG.md
└── README.md
```

## Why this structure

- `public/` is what Netlify publishes.
- `supabase/migrations/` is where database history lives.
- `docs/` is for non-developer instructions and architecture notes.
- `scripts/` is for optional helper scripts.
- `netlify.toml` makes deployment repeatable.

## Future frontend split

When you are ready, split `public/index.html` in this order:

```text
public/
├── index.html
├── config.js
├── privacy.html
└── assets/
    ├── css/
    │   ├── base.css
    │   ├── layout.css
    │   ├── qa.css
    │   ├── chat.css
    │   └── admin.css
    └── js/
        ├── app.js
        ├── supabase-client.js
        ├── auth.js
        ├── qa.js
        ├── comments.js
        ├── chat.js
        ├── admin.js
        ├── notifications.js
        └── utils.js
```

Do this slowly. Move one feature at a time and test after each move.
