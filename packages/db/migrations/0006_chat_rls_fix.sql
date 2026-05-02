-- Fix auth_rls_initplan: wrap auth.uid() in (select ...) so Postgres evaluates
-- it once per statement instead of per row.
DROP POLICY "conversations: assigned or admin can update" ON public.conversations;

CREATE POLICY "conversations: assigned or admin can update"
  ON public.conversations FOR UPDATE
  USING  (assigned_user_id = (select auth.uid())
          OR has_clinic_role(clinic_id, 'admin')
          OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (assigned_user_id = (select auth.uid())
          OR has_clinic_role(clinic_id, 'admin')
          OR has_clinic_role(clinic_id, 'owner'));
