# Notice Desk

Notice Desk tracks market data change notifications from LSEG, Bloomberg and the exchanges. It checks each notice against a client's own usage and permissioning data, so they can see what actually affects them and send actions to the people who need to act.

- **App:** a static web app (`index.html`, `assets/`). There's no build step, and GitHub Pages hosts it.
- **Backend:** Supabase (`supabase/`). It provides Postgres with row level security, storage, and Edge Functions that read the files.

## How it works

1. **CJC IT builds the library.** Each quarter, a CJC IT admin opens **Library** and drops in the LSEG Quarterly Change Summary plus the notice spreadsheets (and later Bloomberg's).
   - The summary creates the notices, with old and new PDP, PE and price for each line.
   - Each spreadsheet is matched to its notice by the DN number in its file name. Every RIC row is read from every tab (`remove`, `addNew`, `update`), including files of 650,000+ rows, and stored compactly. An LSEG quarter is about 1.3 million rows and 170 MB.
2. **Clients check their impact.** A client user signs in, opens **Check impact** and drops their DACS *Usage Detail by User* and/or *Active Permission by Exchange* CSVs.
   - **The files are read in the browser and never uploaded or stored.** Only RIC codes are sent to match against the library.
   - The report lists:
     - **Urgent actions:** RIC replaced, RIC removed, a service to order to keep access, content withdrawn.
     - **Reviews:** entitlement checks, price changes, policy changes.
     - **Affected users and applications:** with what each needs to do, by notice and by RIC.
   - The report downloads as Excel.
3. **CJC IT manages clients.** In **Clients**, an admin adds client organisations and their users. Logins are created in Supabase Authentication.

The rules that turn a change into an action are in `assets/impact.js`.

## Repository layout

```
index.html, assets/          the web app: app.js (UI), impact.js (report rules), library.js (library loading),
                             notice-worker.js (reads spreadsheets off the main thread), dacs-parsers.js (generated)
supabase/migrations/         schema, RLS, storage, change summary, notice files, shared library (update 3)
supabase/functions/          parse-source, parse-notice-file, import-change-summary (+ _shared parsers;
                             _shared/notice-workbook.js is also used by the app's assets/notice-worker.js)
supabase/seed.sql            demo workspace with invented data
dashboard/                   single-file copies for pasting into the Supabase dashboard
scripts/                     seed generator, sample B-PIPE data
tests/                       parser tests, RLS/workflow tests on local Postgres
```

## Setting up a Supabase project

Either use the Supabase CLI (`supabase link`, then `supabase db push` and `supabase functions deploy <name>` for each function), or follow `dashboard/SETUP-IN-DASHBOARD.md` to do it all by pasting into the dashboard.

Then put the project URL and **publishable** key in `assets/config.js`. The publishable key is meant for browsers, and RLS protects the data. Never put the secret key in this repo.

## Users

- **CJC IT admins** are listed in `app_admins`. Add one with:
  ```sql
  insert into app_admins(user_id) select id from auth.users where email = 'name@cjcit.com';
  ```
- **Client users** are created in Supabase → Authentication → Users, then added to their client on the **Clients** page.

## Running the app locally

Any static file server works, for example `python3 -m http.server 8000` from the repo root.

## Tests

```bash
cd tests && npm install
npx tsx parsers.test.ts <usage.csv> <permissions.csv>              # parser checks against your DACS files
PGHOST=localhost PGUSER=postgres ./run-db-tests.sh                  # schema, RLS and workflow on local Postgres
node load-library.test.mjs <folder of LSEG .xlsx files>             # load a quarter into the local library (PG* env vars)
npx tsx impact.test.mjs <usage.csv> <permissions.csv>               # run the impact report against it
```

Client files (DACS exports, vendor notices) aren't committed. `.gitignore` excludes `sample-data/` apart from the invented B-PIPE sample.
