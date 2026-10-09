/** Operator-only confirmation after independently verifying a publisher migration. */
import { initializeDatabase, closeDatabase } from '../src/db/client.js';
import { domain } from '../src/services/supply-path-input.js';
import { approveSupplyPathAuthorityChange } from '../src/services/supply-path-authority-state.js';

const usage = 'Usage: npx tsx server/scripts/approve-supply-path-authority.ts <publisher-domain> <https-location> --confirm-publisher-migration';
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const publisher = domain(args[0]);
  if (args.length !== 3 || !publisher || args[2] !== '--confirm-publisher-migration') throw new Error(usage);
  const location = new URL(args[1]!);
  if (location.protocol !== 'https:' || location.username || location.password || location.hash || (location.port && location.port !== '443') || location.href.length > 8192) throw new Error('Invalid authoritative location');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  initializeDatabase({ connectionString: process.env.DATABASE_URL });
  try {
    await approveSupplyPathAuthorityChange(publisher, location.href);
    console.log(`Confirmed authoritative location for ${publisher}; existing revocation holds are preserved.`);
  } finally { await closeDatabase(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Authority confirmation failed'); process.exitCode = 1; });
