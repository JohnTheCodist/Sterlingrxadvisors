/**
 * The one loading treatment the app uses while it has nothing to show yet.
 *
 * Signing in used to cross two different screens back to back: the auth
 * guard printed a bare "Loading…" line, that vanished, and then the
 * dashboard started its own animation. Two loading states in a row read as a
 * stutter — the reader registers the change, not the progress.
 *
 * Both now render this, so the wait is visually continuous from sign-in
 * through to data: the chart starts drawing at the auth gate and keeps
 * drawing until the figures replace it.
 *
 * The motion, the reduced-motion collapse, and the screen-reader wiring all
 * live in .dash-loading in index.css.
 *
 * @param {string} [sub] — the second line. Defaults to the sign-in phase;
 *   the dashboard passes its own once it knows what it's fetching.
 */
export default function LoadingState({ sub = 'Getting your workspace ready.' }) {
  return (
    <div className="dash-loading" role="status" aria-live="polite">
      {/* Decorative — the copy below carries the meaning for a screen reader. */}
      <div className="dash-loading__chart" aria-hidden="true">
        <span className="dash-loading__bar" />
        <span className="dash-loading__bar" />
        <span className="dash-loading__bar" />
        <span className="dash-loading__bar" />
        <span className="dash-loading__bar" />
        <span className="dash-loading__bar" />
        <span className="dash-loading__bar" />
      </div>
      <div className="dash-loading__copy">
        <p className="dash-loading__title">Almost ready — hold on.</p>
        <p className="dash-loading__sub">{sub}</p>
      </div>
    </div>
  );
}
