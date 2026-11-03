# Notice Desk

Notice Desk tracks market data change notifications from LSEG, Bloomberg and the exchanges. It checks each notice against a client's own usage and permissioning data, so they can see what actually affects them and send actions to the people who need to act.

- **App:** a static web app (`index.html`, `assets/`). There's no build step, and GitHub Pages hosts it.
- **Backend:** Supabase (`supabase/`). It provides Postgres with row level security, storage, and Edge Functions that read the files.

## What it does

- **Imports the LSEG Quarterly Change Summary.** It creates one notice per Notification ID and stores the old and new PDP, PE and price for each line. Re-importing updates notices in place and keeps their status, files and actions.
- **Reads DACS exports.** These are the *Usage Detail by User* and *Active Permission by Exchange* reports. It also reads Bloomberg B-PIPE usage CSVs. A new file replaces the old one only once it has loaded completely.
- **Matches notices against your data:**
  - **RICs and tickers:** instruments in a notice's spreadsheet are matched against usage, including chain RICs, delayed `/` RICs and tickers in any case or spacing.
  - **PDPs:** codes a notice removes, adds or remaps are matched against permissioned logins.
- **Creates actions.** There's one action per affected person or application team, with an email draft for each.
- **Keeps clients separate.** Each client gets a workspace with admin, member and viewer roles, enforced by the database.

## Repository layout

```
index.html, assets/          the web app (assets/config.js holds the Supabase URL and publishable key)
supabase/migrations/         schema, logic, RLS, storage, change-summary import
supabase/functions/          parse-source, parse-notice-file, import-change-summary (+ _shared parsers)
supabase/seed.sql            demo workspace with invented data
dashboard/                   single-file copies for pasting into the Supabase dashboard
scripts/                     seed generator, sample B-PIPE data
tests/                       parser tests, RLS/workflow tests on local Postgres
```

## Setting up a Supabase project

Either use the Supabase CLI (`supabase link`, then `supabase db push` and `supabase functions deploy <name>` for each function), or follow `dashboard/SETUP-IN-DASHBOARD.md` to do it all by pasting into the dashboard.

Then put the project URL and **publishable** key in `assets/config.js`. The publishable key is meant for browsers, and RLS protects the data. Never put the secret key in this repo.

## Users and workspaces

1. Create users in Supabase → Authentication → Users.
2. A signed-in user with no workspace can create one, and becomes its admin.
3. Admins add other users by inserting rows into `tenant_members`. An in-app screen for this is still to come.

## Running the app locally

Any static file server works, for example `python3 -m http.server 8000` from the repo root.

## Tests

```bash
cd tests && npm install
npx tsx parsers.test.ts <usage.csv> <permissions.csv>              # parser checks against your DACS files
PGHOST=localhost PGUSER=postgres ./run-db-tests.sh                  # schema, RLS and workflow on local Postgres
```

Client files (DACS exports, vendor notices) aren't committed. `.gitignore` excludes `sample-data/` apart from the invented B-PIPE sample.
