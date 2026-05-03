/**
 * Every integration adapter implements this interface.
 * Adapters live in packages/integrations/src/adapters/{type}/{provider}.ts
 */
export interface IntegrationAdapter {
  /**
   * Handle an inbound webhook payload.
   * Called by the Next.js route handler after HMAC validation.
   */
  handle(payload: unknown, context: AdapterContext): Promise<void>;

  /**
   * Pull fresh data from the external system.
   * Called on a schedule or manually via the dashboard.
   */
  sync(context: AdapterContext): Promise<SyncResult>;

  /**
   * Verify the integration is reachable and credentials are valid.
   * Returns true on success; throws with a descriptive message on failure.
   */
  healthCheck(context: AdapterContext): Promise<boolean>;
}

export interface AdapterContext {
  /** The clinic_integrations row ID — pass to get_integration_credential */
  integrationId: string;
  /** Clinic ID — for scoped DB queries */
  clinicId: string;
  /**
   * Retrieve the decrypted credentials for this integration.
   * Calls `SELECT get_integration_credential($1)` internally.
   * Reads master key from supabase_vault — no session config required.
   */
  getCredentials(): Promise<string>;
}

export interface SyncResult {
  syncedAt: Date;
  itemsProcessed: number;
  errors: string[];
}

/** Shape of the config JSONB column — non-sensitive, adapter-specific */
export interface IntegrationConfig {
  accountId?: string;
  webhookEvents?: string[];
  fieldMappings?: Record<string, string>;
  [key: string]: unknown;
}
