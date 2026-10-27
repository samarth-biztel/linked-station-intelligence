import path from 'node:path';
import { runner } from 'node-pg-migrate';
import { databaseUrl } from '../db.js';

const applied = await runner({
  databaseUrl: databaseUrl(),
  dir: path.resolve('backend/migrations'),
  direction: 'up',
  migrationsTable: 'schema_migration',
});

console.log(`Applied ${applied.length} pending migration(s).`);
