export class TenantAccessDeniedError extends Error {
  constructor(slug: string) {
    super(`Access denied to clinic: ${slug}`);
    this.name = 'TenantAccessDeniedError';
  }
}

export class NoSessionError extends Error {
  constructor() {
    super('No authenticated session found');
    this.name = 'NoSessionError';
  }
}
