import { readFileSync, readdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import * as dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../apps/web/.env.local') });

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set in apps/web/.env.local');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);
const migrationsDir = resolve(__dirname, '../migrations');

const fromArg = process.argv.find((a) => a.startsWith('--from='))?.split('=')[1];

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql') && (!fromArg || f >= fromArg))
  .sort();

for (const file of files) {
  const content = readFileSync(join(migrationsDir, file), 'utf-8');
  console.log(`Applying ${file}...`);
  await sql.unsafe(content);
  console.log(`  ✓ ${file}`);
}

await sql.end();
console.log('\nMigrations complete.');
