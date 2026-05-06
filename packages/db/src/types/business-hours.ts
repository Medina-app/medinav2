export type DayOfWeek =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export interface DayHours {
  /** HH:MM 24-hour, e.g. "08:00" */
  open: string;
  /** HH:MM 24-hour, e.g. "18:00" */
  close: string;
}

export interface BusinessHours {
  /** IANA tz, e.g. "America/Sao_Paulo" */
  timezone: string;
  /** null entry = closed that day */
  schedule: Record<DayOfWeek, DayHours | null>;
}
