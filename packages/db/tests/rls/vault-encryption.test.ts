import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureVaultMasterKey,
  getServiceClient,
  getVaultMasterKey,
} from './helpers/setup.js';

const sql = getServiceClient();

beforeAll(async () => {
  await ensureVaultMasterKey(sql);
});

afterAll(async () => {
  await sql.end();
});

describe('vault master key bootstrap', () => {
  it('master key is present in vault.decrypted_secrets', async () => {
    const key = await getVaultMasterKey(sql);
    expect(key).toBeTypeOf('string');
    expect(key!.length).toBeGreaterThan(0);
  });
});

describe('encrypt_credential / decrypt_credential round-trip', () => {
  it('decrypts back to original plaintext', async () => {
    const plain = '{"api_key":"round-trip-secret-' + Date.now() + '"}';
    const rows = await sql<{ result: string }[]>`
      SELECT decrypt_credential(encrypt_credential(${plain})) AS result
    `;
    expect(rows[0]?.result).toBe(plain);
  });

  it('encrypted output is a Buffer that does not contain the plaintext', async () => {
    const plain = 'distinctive-marker-xyz-' + Date.now();
    const rows = await sql<{ encrypted: Buffer }[]>`
      SELECT encrypt_credential(${plain}) AS encrypted
    `;
    const buf = rows[0]?.encrypted;
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf!.toString('utf-8')).not.toContain(plain);
  });
});

describe('encrypt_cpf / decrypt_cpf round-trip', () => {
  it('decrypts back to original CPF string', async () => {
    const cpf = '123.456.789-00';
    const rows = await sql<{ result: string }[]>`
      SELECT decrypt_cpf(encrypt_cpf(${cpf})) AS result
    `;
    expect(rows[0]?.result).toBe(cpf);
  });
});
