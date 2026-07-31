/**
 * The executive interpretation attached to a widget.
 *
 * This is the layer between a chart and a decision: the insight says what the
 * number means in business terms, the action says what to do about it. Most
 * analytics tools stop at the chart and leave both to the reader.
 *
 * Renders nothing when a widget has no note, so it can be dropped into every
 * card without gating each call site.
 */
const SEVERITY = {
  high: {
    bar: 'border-[var(--color-danger)]',
    dot: 'bg-[var(--color-danger)]',
    label: 'Act now',
  },
  medium: {
    bar: 'border-[var(--color-accent)]',
    dot: 'bg-[var(--color-accent)]',
    label: 'Worth reviewing',
  },
  low: {
    bar: 'border-[var(--color-line-strong)]',
    dot: 'bg-[var(--color-line-strong)]',
    label: 'Healthy',
  },
  info: {
    bar: 'border-[var(--color-primary)]',
    dot: 'bg-[var(--color-primary)]',
    label: 'Context',
  },
};

export default function ExecutiveNote({ note }) {
  if (!note || (!note.insight && !note.action)) return null;
  const tone = SEVERITY[note.severity] || SEVERITY.info;

  return (
    <div className={`mt-4 border-l-2 ${tone.bar} pl-3.5`}>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">
          {tone.label}
        </span>
      </div>
      {note.insight && (
        <p className="mt-1.5 text-[13px] font-medium leading-relaxed text-[var(--color-ink)]">
          {note.insight}
        </p>
      )}
      {note.action && (
        <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-ink-soft)]">
          {note.action}
        </p>
      )}
    </div>
  );
}
