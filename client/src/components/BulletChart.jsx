/**
 * Bullet chart — a single measure read against qualitative context bands.
 *
 * Used where a percentage only means something relative to a range: a 34%
 * inventory margin is unreadable on its own, and obvious the moment you can
 * see where the typical 20–40% band sits.
 *
 * The bands are grey on purpose. They are reference, not data — only the
 * measure itself carries colour, so the eye lands on the number being
 * reported rather than the scale behind it.
 */
export default function BulletChart({ value, max = 100, ranges = [], sublabel, interpretation, ariaLabel }) {
  const v = Number(value) || 0;
  const scale = Number(max) || 100;
  const pctOf = (n) => `${Math.max(0, Math.min(n / scale, 1)) * 100}%`;
  // Darker grey reads as the worse end of the scale.
  const bandShade = [
    'bg-[var(--color-line)]',
    'bg-[var(--color-line)]/55',
    'bg-[var(--color-line)]/25',
  ];

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums text-[var(--color-ink)]">{v}%</span>
        {sublabel && <span className="text-xs text-[var(--color-ink-faint)]">{sublabel}</span>}
      </div>

      <div
        className="relative mt-4 h-7"
        role="img"
        aria-label={ariaLabel || `${v}% of ${scale}%`}
      >
        <div className="absolute inset-0 flex overflow-hidden rounded-md">
          {ranges.map((rg, i) => {
            const from = i === 0 ? 0 : Number(ranges[i - 1].to);
            const width = ((Math.min(Number(rg.to), scale) - from) / scale) * 100;
            if (!(width > 0)) return null;
            return (
              <div
                key={i}
                style={{ width: `${width}%` }}
                className={bandShade[Math.min(i, bandShade.length - 1)]}
                title={rg.label}
              />
            );
          })}
        </div>
        <div
          className="absolute left-0 top-1/2 h-2.5 -translate-y-1/2 rounded-sm bg-[var(--color-primary)] transition-[width] duration-500"
          style={{ width: pctOf(v) }}
        />
      </div>

      <div className="relative mt-1 h-4 text-[10px] text-[var(--color-ink-faint)]">
        <span className="absolute left-0">0%</span>
        {ranges.slice(0, -1).map((rg, i) => (
          <span key={i} className="absolute -translate-x-1/2 tabular-nums" style={{ left: pctOf(Number(rg.to)) }}>
            {rg.to}%
          </span>
        ))}
        <span className="absolute right-0 tabular-nums">{scale}%</span>
      </div>

      {interpretation && (
        <p className="mt-4 border-l-2 border-[var(--color-primary)]/40 pl-3 text-sm leading-relaxed text-[var(--color-ink-soft)]">
          {interpretation}
        </p>
      )}
    </div>
  );
}
