import { describe, it, expect } from 'vitest';
import { mapClinicIntegration } from '../src/mappers';

const rawRow = {
  id: 'int-1',
  clinic_id: 'clinic-abc',
  type: 'whatsapp',
  provider: 'kapso',
  name: 'WA',
  status: 'active',
  config: { phone_number_id: '12345' },
  encrypted_credentials: null,
  webhook_secret: 'sekrit',
  webhook_path: '/api/webhooks/whatsapp/kapso/clinic-abc',
  last_sync_at: null,
  last_error: null,
  last_error_at: null,
  metadata: { foo: 'bar' },
  deleted_at: null,
  created_at: '2026-05-01T10:00:00.000Z',
  updated_at: '2026-05-02T10:00:00.000Z',
};

describe('mapClinicIntegration', () => {
  it('translates snake_case keys to camelCase', () => {
    const out = mapClinicIntegration(rawRow);
    expect(out.clinicId).toBe('clinic-abc');
    expect(out.webhookSecret).toBe('sekrit');
    expect(out.webhookPath).toBe('/api/webhooks/whatsapp/kapso/clinic-abc');
    expect(out.encryptedCredentials).toBeNull();
  });

  it('parses ISO timestamps to Date instances', () => {
    const out = mapClinicIntegration(rawRow);
    expect(out.createdAt).toBeInstanceOf(Date);
    expect(out.updatedAt).toBeInstanceOf(Date);
    expect(out.deletedAt).toBeNull();
  });

  it('preserves config and metadata jsonb shapes', () => {
    const out = mapClinicIntegration(rawRow);
    expect(out.config).toEqual({ phone_number_id: '12345' });
    expect(out.metadata).toEqual({ foo: 'bar' });
  });

  it('falls back to defaults for missing optional fields', () => {
    const out = mapClinicIntegration({
      ...rawRow,
      config: null,
      metadata: null,
      webhook_secret: null,
    });
    expect(out.config).toEqual({});
    expect(out.metadata).toEqual({});
    expect(out.webhookSecret).toBeNull();
  });
});
