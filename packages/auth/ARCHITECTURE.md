# @medina/auth — Architecture Notes

## Why `setCurrentClinic` is NOT exported

`setCurrentClinic(clinicId)` would call:

```sql
SELECT set_config('app.current_clinic', $1, TRUE);
```

The `TRUE` argument makes the setting transaction-scoped (equivalent to `SET LOCAL`).
Supabase Cloud uses PgBouncer in transaction-pooling mode: each individual query may
be routed to a different PostgreSQL backend transaction. A config set in one round-trip
is invisible to the next one.

Result: any code that calls `current_clinic_id()` after a `setCurrentClinic` call via
Supabase JS would receive `NULL` — silently. This is subtle and hard to debug. We
therefore do not expose the function to prevent future misuse.

## How real tenant validation works

```
Browser → middleware → assertTenantAccess(supabase, slug) → clinics + clinic_members queries
                                                           ↑
                              Supabase PostgREST enforces RLS:
                              is_clinic_member(id) on clinics
                              user_id = auth.uid() on clinic_members
```

1. Middleware receives request for `/[slug]/...`
2. `assertTenantAccess(supabase, slug)` queries `clinics WHERE slug = $1`. The user's
   Supabase client JWT is sent in the `Authorization` header; PostgREST runs the query
   under RLS. If `is_clinic_member(clinics.id)` returns false, 0 rows come back →
   `TenantAccessDeniedError`.
3. If access is granted, middleware injects `x-tenant-slug: <slug>` into the request
   headers forwarded to Server Components.
4. Server Components call `getTenantContext()` which reads `x-tenant-slug` from
   `headers()` and re-validates via `assertTenantAccess`.

## When would `setCurrentClinic` be useful?

Only inside a PostgreSQL stored procedure (RPC) that executes multiple queries in a
single transaction, where the clinic context needs to flow through helper functions
that call `current_clinic_id()`. Even then, it should only be called from an RPC that
already validates access — never from application code over the network.

## Correct pattern: always pass `clinic_id` explicitly

```typescript
// ✅ Correct: explicit clinic_id in every query
supabase.from('patients')
  .select('*')
  .eq('clinic_id', context.clinicId);

// ❌ Wrong: trusting a session variable that may not survive connection pooling
supabase.rpc('set_current_clinic', { clinic_id: context.clinicId });
supabase.from('patients').select('*'); // current_clinic_id() may be NULL here
```

## Trust hierarchy

| Layer | Mechanism | Trustworthy |
|-------|-----------|-------------|
| Middleware | `assertTenantAccess` + RLS | Yes |
| Server Component | `getTenantContext()` re-validates | Yes |
| Client Component | Never trust client-provided `clinic_id` | — |
| RLS | `is_clinic_member(id)` SECURITY DEFINER | Yes (last line of defence) |
