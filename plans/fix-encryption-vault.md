# Migração de criptografia: `app.encryption_key` (GUC) → `supabase_vault`

> **Migration alvo:** `packages/db/migrations/0012_vault_encryption.sql`.

## Decisões confirmadas (Phase 3)

1. **Chave-mestra do vault** = chave atual já no cofre/`.env` (`3e2fdd2ae9…`). Sem re-encrypt, cofre vira backup de recovery.
2. **Bootstrap do vault secret** = SQL Editor manual. Chave nunca toca repo nem CI.
3. **TEST_ENCRYPTION_KEY** = string fixa `'test-encryption-key-medina-2025'`, virou argumento pra `ensureVaultMasterKey()` em `beforeAll`. Não gera dinâmica por suite.
4. **Drizzle schemas** = inalterados. `encryptedCredentials`/`encryptedCpf` continuam `bytea` mapeado pra `Buffer | undefined`. Acesso TS sempre via RPC (`get_integration_credential`/`get_patient_cpf`), nunca SELECT direto.

## Context

A criptografia simétrica do projeto (credenciais de integrações + CPF de pacientes) hoje depende do GUC `app.encryption_key` lido via `current_setting('app.encryption_key', TRUE)`. Supabase managed-Postgres bloqueia `ALTER DATABASE ... SET app.encryption_key` com `42501: permission denied to set parameter` — confirmado em produção. Resultado: o GUC só vive enquanto a sessão/transação está aberta, e queries simples no SQL Editor (com pooler em transaction-mode) NÃO conseguem persistir o valor entre statements. Toda chamada a `get_integration_credential` ou `get_patient_cpf` falha com `app.encryption_key is not configured for this session` se o caller esquecer de setar.

A solução é mover a chave-mestra pra `supabase_vault` (extensão `supabase_vault` v0.3.1 já instalada — confirmado via `pg_extension`). Vault armazena o segredo encriptado em disco e expõe a versão decriptada via view `vault.decrypted_secrets`. Funções SECURITY DEFINER lêem da view direto, sem dependência de GUC.

## Estado atual (evidências)

| Item | Valor |
|---|---|
| `supabase_vault` instalada | sim, v0.3.1 |
| `pgsodium` instalada | não (vault v0.3 não exige) |
| `pgcrypto` instalada | sim (mantém `pgp_sym_encrypt/decrypt`) |
| `clinic_integrations` rows totais | 1 |
| Rows com `encrypted_credentials IS NOT NULL` | 1 (Kapso clínica `2fa85492-…`) |
| `patients` rows totais | 0 |
| `vault.secrets` rows | 0 |
| Master key atual | `3e2fdd2ae9…` (apenas no cofre do Gabriel + 3 `.env` locais) |

### Funções que lêem o GUC `app.encryption_key`
- `public.get_integration_credential(uuid)` → `0002_integrations.sql:201`
- `public.get_patient_cpf(uuid)` → `0004_patients.sql:211` (re-criada em `0011_auth_uid_wrap.sql:115` após wrap de `auth.uid()`)

### Funções que recebem a chave por parâmetro (sem GUC)
- `public.encrypt_credential(text, text)` → `0002:5-9` — IMMUTABLE (latent bug: `pgp_sym_encrypt` é não-determinístico, deveria ser VOLATILE)
- `public.decrypt_credential(bytea, text)` → `0002:11-15` — IMMUTABLE (correto: `pgp_sym_decrypt` é determinístico)
- `public.encrypt_cpf(text, text)` → `0004:8-12` — mesmo bug IMMUTABLE
- `public.decrypt_cpf(bytea, text)` → `0004:14-18` — IMMUTABLE
- `public.hash_cpf(text)` → `0004:20-24` — sem chave (sha256), IMMUTABLE correto

### Vault v0.3.1 — API real (introspecção via `pg_proc`)
- `vault.create_secret(new_secret text, new_name text, new_description text, new_key_id uuid) → uuid`
- `vault.update_secret(secret_id uuid, new_secret text, new_name text, new_description text, new_key_id uuid) → void`
- View `vault.decrypted_secrets(id uuid, name text, description text, secret text, decrypted_secret text, key_id uuid, nonce bytea, created_at, updated_at)`
- Tabela `vault.secrets` (mesmas colunas, sem `decrypted_secret`)
- GRANTs: `service_role` e `postgres` têm SELECT em ambas. `authenticated`/`anon` não têm acesso direto — leitura DEVE ser via SECURITY DEFINER owned by `postgres`.

### Tests afetados (5 testes diretos + 1 helper)
- `packages/db/tests/rls/clinic-integrations.test.ts` linhas 127, 146 (2 testes setam GUC)
- `packages/db/tests/rls/patients.test.ts` linhas 82, 106, 129 (3 testes setam GUC)
- `packages/db/tests/rls/helpers/setup.ts:12,100` — `TEST_ENCRYPTION_KEY` + `createTestIntegration` chama `encrypt_credential(plain, key)`

### TS code afetado
- `packages/integrations/src/types.ts:33` — comentário sobre `app.encryption_key` em `AdapterContext.getCredentials()`
- Nenhum código de runtime em `apps/web/**` chama as funções de cripto hoje (confirmado via grep)

## Decisão de design: Master key compartilhada (Option M)

### Option M — chave-mestra única no vault (RECOMENDADA)
- Cria UM secret no vault chamado `medina_master_encryption_key` com a chave hex de 32 bytes que já existe no cofre.
- Funções `encrypt_*`/`decrypt_*` lêem essa chave de `vault.decrypted_secrets` e seguem usando `pgp_sym_encrypt/decrypt` em colunas BYTEA existentes.
- Schema das tabelas **não muda** (`encrypted_credentials BYTEA`, `encrypted_cpf BYTEA` permanecem).
- **Re-encrypt de dados existentes: ZERO.** A chave armazenada no vault é a MESMA que encriptou a row atual. Funções novas decriptam dado antigo sem migração de dados.
- Rotação futura: gerar nova chave, decriptar+re-encriptar todas as rows, atualizar secret no vault — operação de manutenção rara, fora do escopo deste plano.

### Option P — secret-por-registro no vault (REJEITADA)
- Cada `clinic_integrations` row teria `credential_secret_id UUID` apontando pra `vault.secrets.id`. Plaintext vai pro vault. Coluna `encrypted_credentials BYTEA` removida. Idem `patients.encrypted_cpf` → `cpf_secret_id UUID`.
- Vantagens: rotação per-registro nativa, idiomatic Supabase, `vault.secrets` vira fonte única de auditoria.
- Desvantagens: schema churn (drop/add colunas, atualizar Drizzle, atualizar todos os INSERTs em `helpers/setup.ts`, atualizar testes), e o gain de "rotação per-registro" é teórico (CRM não tem caso de uso pra rotacionar 1 credencial isolada).
- **Veredicto:** P é mais correto a longo prazo, mas o ROI hoje (1 row em integrations, 0 pacientes) não justifica 3-4× o tamanho da migration. Documenta como possível evolução futura.

## SQL real da migration

### Bloco A — bootstrap do secret (rodar UMA VEZ no SQL Editor, **fora da migration**)

A chave-mestra **não vai pro arquivo de migration** (não commitar segredo em git). Bootstrap one-shot:

```sql
-- Substitui <ENCRYPTION_KEY_FROM_COFRE> pela chave hex do cofre antes de rodar.
-- Idempotente: só insere se não existe.
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'medina_master_encryption_key';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(
      '<ENCRYPTION_KEY_FROM_COFRE>',
      'medina_master_encryption_key',
      'Master symmetric key for encrypt_credential/encrypt_cpf. Rotate via UPDATE vault.secrets + re-encrypt all rows.'
    );
  END IF;
END $$;

-- Validação:
SELECT id, name, description, decrypted_secret IS NOT NULL AS has_value
FROM vault.decrypted_secrets WHERE name = 'medina_master_encryption_key';
```

### Bloco B — `packages/db/migrations/0012_vault_encryption.sql` (ARQUIVO COMPLETO)

```sql
-- Migration 0012: replace app.encryption_key GUC with supabase_vault master secret.
-- Pre-requisite: secret named 'medina_master_encryption_key' exists in vault.secrets.
-- See plans/fix-encryption-vault.md for bootstrap instructions.

-- ─── Helper: read master key from vault ───────────────────────────────────────
-- Single source of truth for vault lookup. SECURITY DEFINER + qualified
-- references prevent schema-hijacking. STABLE because vault contents change
-- between transactions but not within one query.

CREATE OR REPLACE FUNCTION public._get_master_encryption_key()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'medina_master_encryption_key';

  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'master encryption key not found in vault (name=medina_master_encryption_key)';
  END IF;

  RETURN v_key;
END $$;

REVOKE EXECUTE ON FUNCTION public._get_master_encryption_key() FROM PUBLIC;
-- Não dá GRANT a authenticated — só funções SECURITY DEFINER do public schema chamam internamente.

-- ─── Drop old key-parameter signatures ────────────────────────────────────────

DROP FUNCTION IF EXISTS public.encrypt_credential(text, text);
DROP FUNCTION IF EXISTS public.decrypt_credential(bytea, text);
DROP FUNCTION IF EXISTS public.encrypt_cpf(text, text);
DROP FUNCTION IF EXISTS public.decrypt_cpf(bytea, text);

-- ─── New no-key-parameter encrypt/decrypt ─────────────────────────────────────

CREATE FUNCTION public.encrypt_credential(plain text)
RETURNS bytea LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
BEGIN
  RETURN extensions.pgp_sym_encrypt(plain, public._get_master_encryption_key());
END $$;

CREATE FUNCTION public.decrypt_credential(encrypted bytea)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
BEGIN
  RETURN extensions.pgp_sym_decrypt(encrypted, public._get_master_encryption_key());
END $$;

CREATE FUNCTION public.encrypt_cpf(cpf text)
RETURNS bytea LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
BEGIN
  RETURN extensions.pgp_sym_encrypt(cpf, public._get_master_encryption_key());
END $$;

CREATE FUNCTION public.decrypt_cpf(encrypted bytea)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
BEGIN
  RETURN extensions.pgp_sym_decrypt(encrypted, public._get_master_encryption_key());
END $$;

REVOKE EXECUTE ON FUNCTION public.encrypt_credential(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decrypt_credential(bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.encrypt_cpf(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decrypt_cpf(bytea) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.encrypt_credential(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_credential(bytea) TO service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_cpf(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_cpf(bytea) TO service_role;

-- ─── Replace GUC-reading wrappers ─────────────────────────────────────────────
-- get_integration_credential keeps signature (uuid) → text. Body now reads vault.

CREATE OR REPLACE FUNCTION public.get_integration_credential(p_integration_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
DECLARE
  v_clinic_id uuid;
  v_encrypted bytea;
BEGIN
  SELECT clinic_id, encrypted_credentials
  INTO v_clinic_id, v_encrypted
  FROM public.clinic_integrations
  WHERE id = p_integration_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'integration not found';
  END IF;

  IF NOT public.has_clinic_role(v_clinic_id, 'admin')
     AND NOT public.has_clinic_role(v_clinic_id, 'owner') THEN
    RAISE EXCEPTION 'access denied: requires admin or owner role';
  END IF;

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN extensions.pgp_sym_decrypt(v_encrypted, public._get_master_encryption_key());
END $$;

REVOKE EXECUTE ON FUNCTION public.get_integration_credential(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_integration_credential(uuid) TO authenticated, service_role;

-- get_patient_cpf: mesma estratégia. Mantém audit-log que `0011_auth_uid_wrap.sql` adicionou.

CREATE OR REPLACE FUNCTION public.get_patient_cpf(p_patient_id uuid)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
DECLARE
  v_clinic_id uuid;
  v_encrypted bytea;
BEGIN
  SELECT clinic_id, encrypted_cpf
  INTO v_clinic_id, v_encrypted
  FROM public.patients
  WHERE id = p_patient_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found';
  END IF;

  IF NOT public.has_clinic_role(v_clinic_id, 'admin')
     AND NOT public.has_clinic_role(v_clinic_id, 'owner') THEN
    RAISE EXCEPTION 'access denied: requires admin or owner role';
  END IF;

  -- Audit (sobrevive de 0004/0011 — mantido idêntico)
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (v_clinic_id, (SELECT auth.uid()), 'patient.cpf_accessed', 'patients', p_patient_id, '{}'::jsonb);

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN extensions.pgp_sym_decrypt(v_encrypted, public._get_master_encryption_key());
END $$;

REVOKE EXECUTE ON FUNCTION public.get_patient_cpf(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_patient_cpf(uuid) TO authenticated, service_role;
```

### Re-encrypt de dados existentes — NÃO necessário

Como o vault recebe a chave **idêntica** à que encriptou a row de `clinic_integrations` hoje (`3e2fdd2ae9…`), o ciphertext existente é decriptável pelas funções novas sem mudança. Nenhum `UPDATE` de dado é executado nesta migration. (Confirmado: `pgp_sym_encrypt` produz ciphertext determinístico-decriptável dado a mesma chave; o IV é parte do output, não da entrada.)

## Mudanças em código TS

### `packages/db/tests/rls/helpers/setup.ts`
- **Remove** `export const TEST_ENCRYPTION_KEY = 'test-encryption-key-medina-2025';` (linha 12).
- **Adiciona** `ensureVaultMasterKey()` chamado em `beforeAll` global (criar `tests/rls/helpers/vault-bootstrap.ts`):
  ```ts
  export async function ensureVaultMasterKey(sql: postgres.Sql, key: string) {
    await sql`
      DO $$ DECLARE v_id uuid; BEGIN
        SELECT id INTO v_id FROM vault.secrets WHERE name = 'medina_master_encryption_key';
        IF v_id IS NULL THEN
          PERFORM vault.create_secret(${key}::text, 'medina_master_encryption_key'::text, 'test'::text);
        ELSE
          PERFORM vault.update_secret(v_id, ${key}::text);
        END IF;
      END $$;
    `;
  }
  ```
- `createTestIntegration` (linha 100) muda chamada de `encrypt_credential(${plainCredentials}, ${TEST_ENCRYPTION_KEY})` → `encrypt_credential(${plainCredentials})`.
- O TEST key continua sendo a string `'test-encryption-key-medina-2025'`, mas vive como variável local do bootstrap (não é parte da assinatura das funções SQL).

### `packages/db/tests/rls/clinic-integrations.test.ts`
- Linhas 137, 156: remover os `set_config('app.encryption_key', ..., TRUE)` dentro das transações.
- Os 2 testes (linhas 127, 146) ficam mais simples: chamam `get_integration_credential(${id})` direto.

### `packages/db/tests/rls/patients.test.ts`
- Linhas 87, 111, 134: remover `set_config('app.encryption_key', ...)` calls.
- Linhas 91, 115, 138: trocar `encrypt_cpf('cpf', ${TEST_ENCRYPTION_KEY})` → `encrypt_cpf('cpf')`.
- Os 3 testes (linhas 82, 106, 129) continuam validando os mesmos invariantes (CPF nunca em SELECT plain, admin decripta, member não decripta).

### `packages/integrations/src/types.ts:33`
- Atualiza comentário no JSDoc de `AdapterContext.getCredentials()`:
  - Remove: `"Only works when the calling session has app.encryption_key set."`
  - Adiciona: `"Reads master key from supabase_vault — no session config required."`

## Plano de teste

| Cenário | Como testar |
|---|---|
| Bootstrap criou secret | `SELECT decrypted_secret IS NOT NULL FROM vault.decrypted_secrets WHERE name = 'medina_master_encryption_key';` deve retornar `true` |
| Migration aplicada limpa | `SELECT proname FROM pg_proc WHERE proname IN ('encrypt_credential','decrypt_credential','encrypt_cpf','decrypt_cpf','get_integration_credential','get_patient_cpf','_get_master_encryption_key');` deve listar 7 funções |
| Decrypta a row Kapso existente | `SELECT decrypt_credential(encrypted_credentials)::jsonb FROM clinic_integrations WHERE clinic_id = '2fa85492-acfd-4d64-a09b-45327e8bdd75';` deve retornar JSON legível (mesmos valores que estavam antes — placeholders ou reais) |
| `get_integration_credential` funciona sem GUC | Numa sessão NOVA (sem `set_config`), chamar a função autenticado como admin da clínica — deve retornar plaintext sem `RAISE EXCEPTION` |
| RLS preservada | Member não-admin chamando `get_integration_credential` → deve falhar com `access denied` |
| Vault secret ausente → erro claro | `DELETE FROM vault.secrets WHERE name = 'medina_master_encryption_key'` num branch de teste, chamar função → deve falhar com `master encryption key not found in vault` (e re-criar no fim do teste) |
| Tests RLS existentes (134+ totais, 5 afetados) | `pnpm --filter @medina/db test` — todos passam após updates dos 3 arquivos |

### Testes novos a escrever
- `packages/db/tests/rls/vault-encryption.test.ts`:
  1. Função `_get_master_encryption_key` levanta erro quando secret não existe
  2. `encrypt_credential` + `decrypt_credential` round-trip retorna mesmo plaintext
  3. Mudar valor do secret no vault (UPDATE) faz `get_integration_credential` falhar pra rows encriptadas com chave antiga (validar que rotação requer re-encrypt — guardrail)

### Não testado neste plano
- Rotação real de chave (re-encrypt em massa) — fora de escopo, vira ticket separado.

## Plano de rollback

Se algo quebrar no apply (ex: vault secret não criado, GRANT errado, função quebra):

1. **Antes de aplicar 0012:** confirmar que bootstrap (Bloco A) executou e `vault.decrypted_secrets` retorna a chave esperada. Se não, NÃO aplicar a migration — corrige o bootstrap primeiro.

2. **Se 0012 aplicada e está quebrada:** criar `0013_revert_vault_encryption.sql` que recria as funções antigas verbatim (cole abaixo). A row de `clinic_integrations` continua decriptável pelas funções antigas se o GUC for setado por sessão (modelo pré-0012). A chave continua no cofre + nos `.env`.

   ```sql
   -- 0013_revert_vault_encryption.sql (apply only if 0012 broke production)
   DROP FUNCTION IF EXISTS public.encrypt_credential(text);
   DROP FUNCTION IF EXISTS public.decrypt_credential(bytea);
   DROP FUNCTION IF EXISTS public.encrypt_cpf(text);
   DROP FUNCTION IF EXISTS public.decrypt_cpf(bytea);
   DROP FUNCTION IF EXISTS public._get_master_encryption_key();

   -- Re-criar assinaturas originais (copiadas de 0002:5-15 e 0004:8-18)
   CREATE FUNCTION public.encrypt_credential(plain text, key text)
   RETURNS bytea LANGUAGE sql IMMUTABLE SECURITY DEFINER
   SET search_path = extensions, public, pg_catalog AS $$
     SELECT extensions.pgp_sym_encrypt(plain, key);
   $$;
   -- (idem decrypt_credential, encrypt_cpf, decrypt_cpf — corpos idênticos a 0002/0004)

   -- Recriar get_integration_credential e get_patient_cpf com leitura do GUC
   -- (corpos idênticos a 0002:173-208 e 0011:87-133 respectivamente)
   ```

3. **Vault secret continua intacto** — não dropa pra preservar a chave. Bootstrap pode rodar de novo se preciso.

## Schema-migration-checklist self-check

- [x] Toda policy com `auth.uid()` usa `(select auth.uid())`? — N/A, plan não cria policies novas. `get_patient_cpf` mantém `(SELECT auth.uid())` herdado de `0011_auth_uid_wrap.sql`.
- [x] FKs cross-tenant têm trigger de validação documentado? — N/A, sem novas FKs.
- [x] Triggers BEFORE vs AFTER documentados com razão? — N/A, sem novos triggers.
- [x] Funções SECURITY DEFINER têm `search_path` explícito? — Sim: `_get_master_encryption_key` usa `pg_catalog, pg_temp`; demais usam `extensions, public, pg_catalog, pg_temp`.
- [x] Funções chamadas via supabase-js/postgres-js evitam `SET` parametrizado? — Sim, é o ponto inteiro: GUC eliminada.
- [x] Ordem de criação na migration sem forward references? — `_get_master_encryption_key` definida antes dos consumers; `DROP` antes de `CREATE` pra signatures novas; wrappers (`get_integration_credential`/`get_patient_cpf`) usam `CREATE OR REPLACE`.
- [x] Audit log preparado pra `user_id NULL`? — Sim: `audit_logs.user_id` já aceita NULL (estabelecido em migrations anteriores). `get_patient_cpf` continua logando com `(SELECT auth.uid())` — quando service_role, vira NULL, esperado.
- [x] Plan tem SQL REAL? — Sim, blocos completos.
- [x] Nomes de colunas em testes batem com schema existente? — Sim: `encrypted_credentials`, `encrypted_cpf`, `clinic_id`, `id`, `deleted_at` — todos confirmados via Drizzle schemas (`packages/db/src/schema/clinic-integrations.ts:32` e `patients.ts:35`).

### Riscos residuais conhecidos
- **`IMMUTABLE → VOLATILE` nas funções encrypt:** mudança de volatilidade pode afetar query plans que cachearam o resultado. Risco baixo (não há queries usando `encrypt_*` em cláusulas WHERE/index — só em INSERT/UPDATE expression). Documenta no commit message.
- **`pg_proc` cache em sessões abertas:** após DROP+CREATE de signature, sessões já abertas em pgbouncer pooler podem cachear OID antigo. Resolução: reiniciar pool ou esperar TTL. Mitigação: aplicar migration em janela de baixo tráfego (1 row em produção hoje, irrelevante).
- **Bootstrap esquecido:** se rodar 0012 sem o Bloco A, próxima chamada de `encrypt_credential` falha com `master encryption key not found in vault`. Fail-fast com mensagem clara — não corrompe dados.
