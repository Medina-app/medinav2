export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 relative z-10">
      <div className="mb-8 flex items-center gap-2.5">
        <div
          className="w-7 h-7 rounded-[8px] flex items-center justify-center text-white text-[13px] font-semibold tracking-tight flex-shrink-0"
          style={{
            background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2), 0 1px 2px rgba(0,0,0,0.1)',
          }}
        >
          M
        </div>
        <span
          className="font-semibold text-sm tracking-tight"
          style={{ color: 'var(--luma-text-primary)' }}
        >
          Medina
        </span>
      </div>
      <div className="w-full max-w-[400px]">{children}</div>
    </div>
  )
}
