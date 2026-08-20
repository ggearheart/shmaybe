// ---------------------------------------------------------------------------
// Shmaybe configuration
// ---------------------------------------------------------------------------
// Leave these blank to run in LOCAL mode: everything works, but the data lives
// in one browser, so it's a demo rather than a shared plan.
//
// Fill them in to switch on SHARED mode — everyone opens the same link on their
// own phone, edits their own row, and sees each other's answers.
//
// Both values are safe to publish. The anon key is designed to ship in client
// code; the tables are closed to it and every operation goes through the
// security-definer functions in supabase-schema.sql. Never put the
// `service_role` key here — that one bypasses all of it.
//
// See SETUP.md for the five-minute version.
// ---------------------------------------------------------------------------
window.SHMAYBE_CONFIG = {
  // Supabase → Project Settings → API
  SUPABASE_URL: "",       // e.g. "https://abcd1234.supabase.co"
  SUPABASE_ANON_KEY: "",  // the public "anon" / "publishable" key
};
