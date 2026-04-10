(global as any).__DEV__ = false;
import { createClient } from '@supabase/supabase-js';

async function run() {
  const client = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  );
  const { data } = await client
    .from('user_books')
    .select('user_id, rating, status')
    .not('rating', 'is', null)
    .eq('status', 'finished');
  const counts: Record<string, number> = {};
  for (const row of (data ?? [])) {
    counts[row.user_id] = (counts[row.user_id] ?? 0) + 1;
  }
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log('Top users by finished+rated books:');
  for (const [id, n] of sorted) console.log(`  ${id}  (${n} rated finished books)`);
}
run().catch(e => { console.error(e); process.exit(1); });
