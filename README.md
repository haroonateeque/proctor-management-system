# Proctor Register

A simple student register for non-technical proctors.
Plain HTML/CSS/JavaScript — no build step — with **Supabase** as the hidden backend.

## What it does

| Task | Where |
|---|---|
| Sign in | `index.html` |
| Home screen with counts | `home.html` |
| Search students (name / ID / phone / CNIC / guardian number, forgiving match) | `students.html` |
| Add a student by hand (duplicate-ID warning) | `add-student.html` |
| Scan the ID card — live camera auto-reads front + back and prefills a new student | `scan.html` |
| Add many students from Excel (3-step wizard, auto column detection) | `upload.html` |
| Excel template download + "update existing students" import mode | `upload.html` |
| Student profile + history timeline + fines / warnings / suspensions / notes | `student.html` |
| Notify the guardian on WhatsApp (custom country code + message template) | student page, home card, `more.html` |
| Remove a student (with Undo) | student page & bulk bar |
| Mark fine paid / remove a fine | student page |
| Bulk actions (fine / warning / suspend / remove several at once) | `students.html` |
| WhatsApp settings, backups, removed students, past imports, error help | `more.html` |

## Sign-in: Google (via Supabase Auth)

The proctor signs in with their **Google account** — no passwords to
remember or manage. Sign-in goes through **Supabase Auth** (one-time setup below).
Until `js/config.js` has your project values, the sign-in page shows setup
instructions instead of the button.

## Supabase setup (one time)

### 1. Create the project
1. Sign up at <https://supabase.com> and create a new project.
2. Open **SQL Editor**, paste the SQL below, press **Run**.

```sql
create table if not exists students (
  id          text primary key,
  name        text not null,
  student_id  text not null,
  class_name  text,
  section     text,
  department  text,
  semester    text,
  phone       text,
  email       text,
  father_name      text,
  guardian_phone   text,
  blood_group      text,
  hostel           text,
  dob              text,
  cnic             text,
  address          text,
  notes       text,
  status      text not null default 'ACTIVE',
  removed     boolean not null default false,
  owner_id    uuid not null default auth.uid(),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
-- one copy of each student ID *per proctor* (ids compare exactly the
-- way the app does: lowercase, letters and digits only)
create unique index if not exists students_owner_sid_uniq
  on students (owner_id, regexp_replace(lower(student_id), '[^a-z0-9]', '', 'g'));

create table if not exists history (
  id          uuid primary key default gen_random_uuid(),
  student_id  text not null references students(id) on delete cascade,
  type        text not null,             -- fine | warning | suspension | note
  description text not null,
  amount      numeric,
  paid        boolean default false,
  created_by  text,
  owner_id    uuid not null default auth.uid(),
  created_at  timestamptz default now()
);
create index if not exists history_student_idx on history (student_id, created_at desc);

create table if not exists settings (
  key      text not null,
  value    jsonb,
  owner_id uuid not null default auth.uid(),
  primary key (owner_id, key)
);

alter table students enable row level security;
alter table history  enable row level security;
alter table settings enable row level security;

-- every proctor sees and edits only their own rows (enforced by the
-- database itself, not just by the app)
create policy "own students" on students
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "own history" on history
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy "own settings" on settings
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
```

> **Already created the tables with an older version of this SQL?**
> Run `sql/migration-privacy.sql` instead — it adds the per-proctor
> `owner_id` columns, switches the policies to per-owner, and fixes
> the student-ID unique index.

### 2. Turn on Google sign-in
1. Go to the [Google Cloud Console](https://console.cloud.google.com) →
   **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   (type: **Web application**).
2. Add to **Authorized JavaScript origins**:
   - your deployed address, e.g. `https://your-app.vercel.app`
   - `http://localhost:8080` (for local testing)
3. Add to **Authorized redirect URIs**:
   `https://YOUR-PROJECT.supabase.co/auth/v1/callback`
4. In Supabase: **Authentication → Providers → Google** — paste the
   Client ID and Client Secret, then **Save**.
5. In Supabase: **Authentication → URL Configuration** — set the
   **Site URL** to your deployed address and add it under **Redirect URLs**.

### 3. Connect the app
Edit `js/config.js`:

```js
const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "your-anon-public-key";
```

(Both values are in **Settings → API**.)

## Run locally

```powershell
python -m http.server 8080    # or: npx serve .
```

Open <http://localhost:8080>. Note: real Google sign-in needs the
`http://localhost:8080` origin added in step 2 above.

## Deploy

### Hostinger
1. Zip all files (keep `index.html` at the top level).
2. hPanel → **File Manager** → open `public_html` → upload and extract the zip.
3. Done — visit your domain. For a subdomain/subfolder, upload into that folder instead.

### Vercel
```
npm i -g vercel
vercel          # from this folder, accept defaults
vercel --prod
```
Or import the folder at <https://vercel.com/new> (no framework preset needed).

## Troubleshooting

- **"Can't reach the internet"** — the app opens without a connection,
  but *reading and saving* connected data needs the internet.
- **"You don't have permission"** — the SQL policies from step 1 weren't run.
- **Login works but lists are empty** — that's normal; data lives per Supabase project.
- **Excel says "file could not be read"** — re-save the file as `.xlsx` or `.csv`.
- **Card scan says the reader didn't load** — scanning downloads its OCR engine
  (about 3 MB) from the internet the first time, so it needs a connection.

## File map

```
index.html            login
home.html             dashboard
students.html         search + list + bulk actions
student.html          profile + history + quick actions
add-student.html      add / edit form
scan.html             ID-card scanner (camera → OCR → prefilled form)
upload.html           Excel wizard
more.html             WhatsApp settings / backups / removed / imports / help
css/style.css         mobile-first styles (+ desktop table view, print)
js/config.js          ← the only file you may need to edit
js/ui.js              toasts, dialogs, undo, chrome, formatting
js/db.js              all storage logic (trial localStorage / Supabase)
js/excel.js           Excel reading + column auto-detection
js/scan-parse.js      card-text parsing for the scanner (unit-tested)
js/page-*.js          one small script per screen
vendor/               Supabase + Excel libraries stored locally
                      (so the app shell and Excel import work offline)
sql/                  database migrations (per-proctor privacy)
sw.js                 service worker — offline app shell
manifest.webmanifest  install-as-app (PWA) settings
```
