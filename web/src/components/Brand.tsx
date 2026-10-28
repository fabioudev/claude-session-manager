export function BrandMark({ needs = false, size = 18 }: { needs?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={needs ? 'needs-signal' : undefined}
    >
      <path
        d="M4 7h8M4 12h14M4 17h6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="18" cy="7" r="2.1" fill="currentColor" />
    </svg>
  )
}

export function BrandLockup({ needs = false }: { needs?: boolean }) {
  return (
    <span className="brand">
      <span className="brand-mark">
        <BrandMark needs={needs} />
      </span>
      <span className="brand-text">
        <span className="brand-name">Session Manager</span>
        <span className="brand-sub">for Claude Code</span>
      </span>
    </span>
  )
}
