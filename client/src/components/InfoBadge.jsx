function InfoBadge({ description }) {
  if (!description) return null;
  return (
    <span
      className="group relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-line)] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] hover:bg-[var(--color-primary-tint)] cursor-help transition-colors"
      title={description}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] p-2 text-xs leading-relaxed text-[var(--color-ink-soft)] opacity-0 shadow-lg transition-opacity group-hover:opacity-100 whitespace-normal normal-case tracking-normal font-normal z-50">
        {description}
      </span>
    </span>
  );
}

export default InfoBadge;
