import postgres from 'postgres';

export function createClient(connectionString: string): postgres.Sql {
  return postgres(connectionString, {
    max: 10,
    idle_timeout: 30,
  });
}
