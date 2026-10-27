import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '../db.js';

const migrationPath = path.resolve('backend/migrations/001_core.sql');
const client = createClient();

try {
  await client.connect();
  const sql = await readFile(migrationPath, 'utf8');
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log('Applied phase 1 core schema.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
