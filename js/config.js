/* =============================================================
   Connection settings
   -------------------------------------------------------------
   The app signs the proctor in with their GOOGLE account,
   through Supabase Auth. Data is saved in your Supabase
   project online, so every device sees the same register.

   One-time setup (full walkthrough in README.md):
   1. Create a free project at https://supabase.com
   2. Run the SQL from README.md (creates the tables)
   3. Turn on the Google provider in Supabase Auth
   4. Paste your project values below
   ============================================================= */

const SUPABASE_URL = "https://ywniaxzwaymvtfnlegrd.supabase.co";

const SUPABASE_ANON_KEY = "sb_publishable_JH6ilojNz6aN0P0miivQSA_y3_xPE1z";   // your project's "anon public" key

/* Both values are in Supabase → Settings → API.
   Until they are filled in, the sign-in page shows setup
   instructions instead of the sign-in button. */
