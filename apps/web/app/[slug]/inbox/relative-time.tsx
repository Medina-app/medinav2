'use client';

import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale/pt-BR';

interface RelativeTimeProps {
  date: Date | string | null;
  className?: string;
}

export default function RelativeTime({ date, className }: RelativeTimeProps) {
  const [label, setLabel] = useState<string>('');

  useEffect(() => {
    if (!date) return;
    const compute = () => formatDistanceToNow(new Date(date), { addSuffix: true, locale: ptBR });
    setLabel(compute());
    const interval = setInterval(() => setLabel(compute()), 60_000);
    return () => clearInterval(interval);
  }, [date]);

  if (!date) return null;
  return (
    <time className={className} dateTime={new Date(date).toISOString()}>
      {label}
    </time>
  );
}
