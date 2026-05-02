import { describe, expect, it } from 'vitest';
import { LoginSchema, SignupSchema, CreateClinicSchema } from '../src/schemas.js';

describe('LoginSchema', () => {
  it('accepts valid email and password', () => {
    const result = LoginSchema.safeParse({ email: 'user@example.com', password: 'secret123' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid email', () => {
    const result = LoginSchema.safeParse({ email: 'not-an-email', password: 'secret123' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/email/i);
  });

  it('rejects password shorter than 6 characters', () => {
    const result = LoginSchema.safeParse({ email: 'user@example.com', password: '12345' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/6/);
  });
});

describe('SignupSchema', () => {
  it('accepts valid name, email, and password', () => {
    const result = SignupSchema.safeParse({
      name: 'João Silva',
      email: 'joao@example.com',
      password: 'senhasegura',
    });
    expect(result.success).toBe(true);
  });

  it('rejects name shorter than 2 characters', () => {
    const result = SignupSchema.safeParse({
      name: 'J',
      email: 'j@example.com',
      password: 'senhasegura',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/2/);
  });

  it('rejects password shorter than 8 characters', () => {
    const result = SignupSchema.safeParse({
      name: 'João',
      email: 'joao@example.com',
      password: '1234567',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/8/);
  });
});

describe('CreateClinicSchema', () => {
  it('accepts valid name and slug', () => {
    const result = CreateClinicSchema.safeParse({ name: 'Clínica Central', slug: 'clinica-central' });
    expect(result.success).toBe(true);
  });

  it('rejects slug with uppercase letters', () => {
    const result = CreateClinicSchema.safeParse({ name: 'Clínica', slug: 'Clinica' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/slug/i);
  });

  it('rejects slug with spaces', () => {
    const result = CreateClinicSchema.safeParse({ name: 'Clínica', slug: 'minha clinica' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/slug/i);
  });

  it('rejects slug shorter than 3 characters', () => {
    const result = CreateClinicSchema.safeParse({ name: 'Clínica', slug: 'ab' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/3/);
  });

  it('rejects name shorter than 2 characters', () => {
    const result = CreateClinicSchema.safeParse({ name: 'A', slug: 'clinic-a' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/2/);
  });
});
