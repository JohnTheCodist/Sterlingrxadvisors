/**
 * The executive interpretation attached to a widget.
 *
 * This is the layer between a chart and a decision: the insight says what the
 * number means in business terms, the action says what to do about it. Most
 * analytics tools stop at the chart and leave both to the reader.
 *
 * Renders nothing when a widget has no note, so it can be dropped into every
 * card without gating each call site.
 *
 * Severity used to read from a 2px coloured border down the left edge. That
 * shape — an asymmetric accent rail on a card — is one of the most
 * recognisable generated-UI tells, and it also spent the page's whole accent
 * budget on decoration rather than signal. Severity now reads from a small
 * square beside the label, and the note sits on its own tinted panel.
 *
 * The severity vocabulary and the note contract are unchanged.
 */
const SEVERITY = {
  high:   { color: 'var(--destructive)',     label: 'Act now' },
  medium: { color: 'var(--warning)',         label: 'Worth reviewing' },
  low:    { color: 'var(--success)',         label: 'Healthy' },
  info:   { color: 'var(--color-ink-faint)', label: 'Context' },
};

export default function ExecutiveNote({ note }) {
  if (!note || (!note.insight && !note.action)) return null;
  const tone = SEVERITY[note.severity] || SEVERITY.info;

  return (
    <div className="exec-note">
      <div className="exec-note__head">
        <span className="exec-note__chip" style={{ background: tone.color }} />
        <span className="exec-note__tone">{tone.label}</span>
      </div>
      {note.insight && <p className="exec-note__insight">{note.insight}</p>}
      {note.action && <p className="exec-note__action">{note.action}</p>}
    </div>
  );
}
