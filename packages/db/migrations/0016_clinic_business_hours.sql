-- ─── 0016: clinics.business_hours ────────────────────────────────────────────
-- Stores per-clinic business hours so the AI agent (check_business_hours tool)
-- can answer questions like "you're open now?" deterministically. Default is
-- monday-friday 08:00-18:00 America/Sao_Paulo, weekends closed (null).
-- Schema: { timezone: string (IANA), schedule: { day → { open, close } | null } }

ALTER TABLE public.clinics
  ADD COLUMN IF NOT EXISTS business_hours jsonb NOT NULL
  DEFAULT '{
    "timezone": "America/Sao_Paulo",
    "schedule": {
      "monday":    {"open":"08:00","close":"18:00"},
      "tuesday":   {"open":"08:00","close":"18:00"},
      "wednesday": {"open":"08:00","close":"18:00"},
      "thursday":  {"open":"08:00","close":"18:00"},
      "friday":    {"open":"08:00","close":"18:00"},
      "saturday":  null,
      "sunday":    null
    }
  }'::jsonb;

COMMENT ON COLUMN public.clinics.business_hours IS
  'IANA timezone + per-day open/close (HH:MM 24h). null day = closed. Read by AI agent check_business_hours tool.';
