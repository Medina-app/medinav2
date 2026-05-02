export type ClinicRole = 'owner' | 'admin' | 'member';

export interface ClinicSummary {
  id: string;
  slug: string;
  name: string;
  role: ClinicRole;
}

export interface TenantContext {
  user: { id: string; email: string | undefined };
  clinicId: string;
  clinicSlug: string;
  clinicName: string;
  role: ClinicRole;
}

export type Permission =
  | 'clinic:manage'
  | 'integration:manage'
  | 'member:manage'
  | 'audit:read'
  | 'patient:read'
  | 'patient:write';

const PERMISSION_MATRIX: Record<Permission, ClinicRole[]> = {
  'clinic:manage':       ['owner'],
  'integration:manage':  ['owner', 'admin'],
  'member:manage':       ['owner', 'admin'],
  'audit:read':          ['owner', 'admin'],
  'patient:read':        ['owner', 'admin', 'member'],
  'patient:write':       ['owner', 'admin', 'member'],
};

export function hasPermission(role: ClinicRole, permission: Permission): boolean {
  const allowed = PERMISSION_MATRIX[permission];
  return allowed.includes(role);
}
