import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';

/**
 * A guided walkthrough of the dashboard, shown once per person.
 *
 * Design decisions worth knowing:
 *
 * · Steps whose target isn't on the page are SKIPPED, not shown against a
 *   blank spotlight. A brand-new account has no KPI cards to point at, and a
 *   populated one has no empty-state upload prompt — one step list serves both
 *   because missing targets drop out silently.
 *
 * · The spotlight is one element with an enormous spread shadow, so the whole
 *   page dims except the cut-out. That's a single compositor layer rather than
 *   four positioned dimming panels, and the hole can never drift out of
 *   register with the thing it's framing.
 *
 * · Completion is stored per-user in localStorage. A tour that reappears on
 *   every visit is worse than no tour, and this shouldn't cost a round trip
 *   or a schema column to remember.
 */

const STORAGE_PREFIX = 'sterlingrx.tour.';
const PADDING = 8;      // breathing room around the spotlit element
const GAP = 14;         // distance from spotlight edge to the tooltip
const CARD_MAX = 332;   // 20.75rem — must match the card's CSS width

/**
 * The card's REAL rendered width. Its CSS is `min(20.75rem, 100vw - 2rem)`, so
 * below ~364px the card is narrower than CARD_MAX — and a clamp that assumed
 * the fixed width computed a negative left offset on a 320px screen, sliding
 * the card off the left edge. Deriving it the way the CSS does keeps the two
 * from disagreeing.
 */
const cardWidth = (vw) => Math.min(CARD_MAX, vw - 32);

export function hasSeenTour(userKey) {
  try {
    return localStorage.getItem(STORAGE_PREFIX + (userKey || 'anon')) === 'done';
  } catch {
    // Private browsing can throw on access. Treat it as "seen" rather than
    // showing the tour on every single page load.
    return true;
  }
}

export function markTourSeen(userKey) {
  try {
    localStorage.setItem(STORAGE_PREFIX + (userKey || 'anon'), 'done');
  } catch { /* nothing to do — the tour simply isn't remembered */ }
}

export default function ProductTour({ steps, userKey, onFinish }) {
  // Resolve which steps actually have a target on screen before showing
  // anything, so "Step 2 of 5" is never a lie.
  const live = steps.filter((s) => !s.selector || document.querySelector(s.selector));

  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null);
  const cardRef = useRef(null);

  const step = live[index];
  const isLast = index === live.length - 1;

  const finish = useCallback(() => {
    markTourSeen(userKey);
    onFinish?.();
  }, [userKey, onFinish]);

  // Measure before paint so the spotlight never renders in the wrong place
  // for a frame.
  useLayoutEffect(() => {
    if (!step) return undefined;

    const measure = () => {
      if (!step.selector) { setRect(null); return; }
      const el = document.querySelector(step.selector);
      if (!el) { setRect(null); return; }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };

    const el = step.selector ? document.querySelector(step.selector) : null;
    if (el) {
      // 'nearest' rather than 'center' — a target already in view shouldn't
      // jump the page just because the tour advanced onto it.
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    measure();

    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  // Move focus to the card on each step so a keyboard user follows along
  // instead of being left behind on whatever had focus before.
  useEffect(() => {
    cardRef.current?.focus();
  }, [index]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setIndex((i) => Math.min(i + 1, live.length - 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish, live.length]);

  if (!step) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Card placement: below the target when there's room, above when there
  // isn't, centred when the step has no target at all.
  let cardStyle;
  if (!rect) {
    cardStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  } else {
    const below = rect.top + rect.height + PADDING + GAP;
    const fitsBelow = below + 200 < vh;
    const top = fitsBelow ? below : Math.max(GAP, rect.top - PADDING - GAP - 200);
    // Clamped against the card's real width so it never hangs off either edge.
    // The lower bound wins on very narrow screens, where the upper bound would
    // otherwise go negative.
    const upper = vw - cardWidth(vw) - GAP;
    const left = Math.max(GAP, Math.min(rect.left, upper));
    cardStyle = { top: `${top}px`, left: `${left}px` };
  }

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {rect ? (
        <div
          className="tour__spotlight"
          style={{
            top: rect.top - PADDING,
            left: rect.left - PADDING,
            width: rect.width + PADDING * 2,
            height: rect.height + PADDING * 2,
          }}
        />
      ) : (
        <div className="tour__scrim" />
      )}

      <div className="tour__card" style={cardStyle} ref={cardRef} tabIndex={-1}>
        <p className="tour__count">Step {index + 1} of {live.length}</p>
        <h2 className="tour__title" id="tour-title">{step.title}</h2>
        <p className="tour__body">{step.body}</p>

        <div className="tour__actions">
          <button type="button" className="tour__skip" onClick={finish}>
            Skip tour
          </button>
          <div className="tour__nav">
            {index > 0 && (
              <button type="button" className="tour__back" onClick={() => setIndex((i) => i - 1)}>
                Back
              </button>
            )}
            <button
              type="button"
              className="tour__next"
              onClick={() => (isLast ? finish() : setIndex((i) => i + 1))}
            >
              {isLast ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
