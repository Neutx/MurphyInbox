// MurphyInbox mark: an envelope on a squircle in the current accent color.
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="mi-sheen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" style={{ fill: 'var(--accent)' }} />
      <rect width="64" height="64" rx="15" fill="url(#mi-sheen)" />
      <rect x=".5" y=".5" width="63" height="63" rx="14.5" fill="none" stroke="#fff" strokeOpacity=".18" />
      <rect x="15" y="20" width="34" height="24" rx="4.5" fill="none" stroke="#fff" strokeWidth="3.4" />
      <path d="M16.5 22.5 32 34l15.5-11.5" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ name = 'MurphyInbox' }: { name?: string }) {
  return (
    <div className="flex items-center gap-2">
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight text-fg">{name}</span>
    </div>
  );
}
