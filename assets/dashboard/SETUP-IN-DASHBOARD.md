# Set up Notice Desk in Supabase (no command line needed)

Project: https://jpowcnzfednnzyiooabg.supabase.co

Total time is about 10 minutes.

## 1. Create your user

1. Go to Dashboard → **Authentication** → **Users** → **Add user** → **Create new user**.
2. Use `your.email@example.com` and set a password.
3. Tick **Auto confirm user**.

## 2. Create the database

1. Go to Dashboard → **SQL Editor** → **New query**.
2. Open `notice-desk-setup.sql`, copy everything, paste it in and click **Run**.

This creates every table, the security rules and the two private storage buckets. It also loads the demo workspace "Northgate Bank (demo)" and makes you its admin.

If it reports that a table or type already exists, the project isn't empty. Stop there and tell Claude, who can move everything into its own schema.

**Check it worked:** run this in a new query. You should get 7 rows.

```sql
select ref, status, instruments, used_direct, logins_permissioned from notice_impact order by effective_date;
```

## 3. Deploy the two functions

Repeat these steps twice, once for each function:

1. Go to Dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Use the function name below, delete the example code, then paste in the whole file.
3. Click **Deploy function**.

| Function name | File to paste |
|---|---|
| `parse-source` | `parse-source.ts` |
| `parse-notice-file` | `parse-notice-file.ts` |

Leave **Verify JWT** switched on for both. The functions only work for signed-in users, and they can only read and write that user's own workspace.

## Update 1: Quarterly Change Summary import

Do this if you've already completed steps 1 to 3 above.

1. Run the update in a new query: Dashboard → **SQL Editor** → **New query**, paste all of `update-01-change-summary.sql` and click **Run**.
2. Deploy one more function, following step 3: name it `import-change-summary` and paste in `import-change-summary.ts`.
3. Re-deploy `parse-source` and `parse-notice-file` using the new copies of those files in this folder. They now share the summary parser.

**Check it worked:** these two queries should both return without errors.

```sql
select count(*) from notice_service_changes;
select ref, title, your_pdps from notice_impact where cardinality(your_pdps) > 0;
```

They return nothing until a summary has been imported. To import one, upload the file to the `notice-files` bucket under `<tenant id>/summaries/` and call the `import-change-summary` function. The app will do this for you once the front end is connected.

## 4. Done

The backend is ready. The next step is connecting the prototype screens to it.
