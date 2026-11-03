import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** A client that acts as the calling user, so every read and write goes through RLS. */
export function userClient(req: Request): SupabaseClient {
  const auth = req.headers.get('Authorization');
  if (!auth) throw new HttpError(401, 'Sign in first: the request has no Authorization header.');
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

export async function handle(req: Request, fn: () => Promise<Response>): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  try { return await fn(); }
  catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
}

/** Insert in batches so large usage files stay under request size limits. */
export async function insertChunked(db: SupabaseClient, table: string, rows: Record<string, unknown>[], size = 1000) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).insert(rows.slice(i, i + size));
    if (error) throw new HttpError(400, `Saving ${table} failed at row ${i + 1}: ${error.message}`);
  }
}
