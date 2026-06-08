// ════════════════════════════════════════════════════════════════════════════
// App configuration
// ════════════════════════════════════════════════════════════════════════════
//
// This file holds the Supabase project credentials.
//
// The SUPABASE_ANON_KEY is safe to commit and expose publicly — Supabase is
// designed that way. The actual security comes from Row Level Security on the
// database, not from secrecy of this key.
//
// NEVER paste the service_role key into this file or anywhere in the frontend.
//
// To use these values in index.html, add this line near the top of the body:
//   <script src="config.js"></script>
//
// Then in the existing inline script, replace:
//   const SUPABASE_URL = 'https://...';
//   const SUPABASE_KEY = 'sb_publishable_...';
// with:
//   const SUPABASE_URL = window.APP_CONFIG.SUPABASE_URL;
//   const SUPABASE_KEY = window.APP_CONFIG.SUPABASE_ANON_KEY;
//   const REVIEWER_EMAIL = window.APP_CONFIG.PRIMARY_ADMIN_EMAIL;
//
// ════════════════════════════════════════════════════════════════════════════

window.APP_CONFIG = {
  // Your Supabase project URL — find it at:
  // Supabase → Settings → API → "Project URL"
  SUPABASE_URL: 'https://eezzlxyijktbgpabynqd.supabase.co',

  // Your Supabase anon / public key — find it at:
  // Supabase → Settings → API → "anon / public"
  // (NOT the service_role key.)
  SUPABASE_ANON_KEY: 'sb_publishable_tx9rIx_A-anB2c_UuUjihw_XgfpWIWC',

  // Primary admin email — also seeded into the database during setup.
  // Used as a fallback for legacy role checks in the frontend.
  PRIMARY_ADMIN_EMAIL: 'hillstribeco@gmail.com'
};
