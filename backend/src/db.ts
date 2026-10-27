import pg from 'pg';

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required. See .env.example.');
  }
  return url;
}

export function createClient(): pg.Client {
  return new pg.Client({ connectionString: databaseUrl() });
}
