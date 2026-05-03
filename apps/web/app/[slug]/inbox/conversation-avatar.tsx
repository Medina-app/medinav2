interface ConversationAvatarProps {
  seed: string;
  name: string | null;
}

const PALETTES = [
  'linear-gradient(135deg, #fb923c, #f43f5e)', // orange-pink
  'linear-gradient(135deg, #34d399, #14b8a6)', // green-teal
  'linear-gradient(135deg, #60a5fa, #6366f1)', // blue-indigo
  'linear-gradient(135deg, #fbbf24, #f97316)', // amber-orange
];

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initials(seed: string, name: string | null): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
    return (first + last).toUpperCase().slice(0, 2);
  }
  // Fallback: last 2 digits of phone
  const digits = seed.replace(/\D/g, '');
  return digits.slice(-2) || '••';
}

export default function ConversationAvatar({ seed, name }: ConversationAvatarProps) {
  const palette = PALETTES[hashString(seed) % PALETTES.length] ?? PALETTES[0];
  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[12px] font-semibold tracking-tight shrink-0"
      style={{ background: palette }}
      aria-hidden="true"
    >
      {initials(seed, name)}
    </div>
  );
}
