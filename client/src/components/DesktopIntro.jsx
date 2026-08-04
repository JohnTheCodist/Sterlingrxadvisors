import { useEffect, useRef, useState } from 'react';
import { isDesktop } from '../lib/platform.js';

/**
 * The launch sequence for the desktop app: mark, wordmark, motto, then out of
 * the way.
 *
 * Three decisions worth defending, because a splash screen is one of the
 * easiest things to get wrong:
 *
 * 1. ONCE PER LAUNCH, not once per navigation. Keyed in sessionStorage, which
 *    for a desktop window is exactly the life of the app — quitting and
 *    reopening plays it again, clicking around inside does not. An animation
 *    that replays on every route change stops being a flourish within a day.
 *
 * 2. SKIPPABLE, on click or any key. Someone opening this app for the ninth
 *    time today wants their dashboard, not our logo. Anything that cannot be
 *    dismissed is a toll booth.
 *
 * 3. IT DOES NOT BLOCK SIGN-IN. The form is mounted and ready underneath the
 *    whole time; this is an overlay that fades away, not a gate the app waits
 *    behind. If the animation broke entirely, the app would still work.
 *
 * Built in CSS and inline SVG rather than a motion library — this project
 * ships none, and adding one for a single screen would be a dependency the
 * whole app pays for.
 */

const SEEN_KEY = 'sterlingrx.intro.played';
const HOLD_MS = 2500;   // full sequence before the overlay begins leaving
const FADE_MS = 420;    // and how long it takes to go

export default function DesktopIntro() {
  // Web never sees this. The website has a homepage; the app opens on itself.
  const [show, setShow] = useState(() => {
    if (!isDesktop) return false;
    try { return sessionStorage.getItem(SEEN_KEY) !== '1'; } catch { return true; }
  });
  const [leaving, setLeaving] = useState(false);
  const timers = useRef([]);

  useEffect(() => {
    if (!show) return undefined;

    const finish = () => {
      try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode; replays, harmless */ }
      setLeaving(true);
      timers.current.push(setTimeout(() => setShow(false), FADE_MS));
    };

    timers.current.push(setTimeout(finish, HOLD_MS));

    const skip = () => finish();
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('pointerdown', skip, { once: true });

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [show]);

  if (!show) return null;

  return (
    /* aria-hidden and inert: the sign-in form underneath is the real content
       and already has focus. A screen reader announcing a decorative logo
       before the email field would be noise, not branding. */
    <div className={`intro${leaving ? ' is-leaving' : ''}`} aria-hidden="true">
      <div className="intro-stage">
        {/* Concentric rings reading outward from the mark — the same "pulse"
            language the product uses for a live reading of the business. */}
        <span className="intro-ring" />
        <span className="intro-ring intro-ring--2" />
        <span className="intro-ring intro-ring--3" />

        <div className="intro-mark">
          <svg viewBox="0 0 96 96" role="img" aria-label="SterlingRx Advisors">
            <rect className="intro-tile" x="4" y="4" width="88" height="88" rx="21" />
            <text className="intro-rx" x="48" y="49" textAnchor="middle" dominantBaseline="central">Rx</text>
          </svg>
        </div>

        <h1 className="intro-word">SterlingRx Advisors</h1>

        <p className="intro-motto">
          <span>AI Intelligence.</span>
          <span>Human Expertise.</span>
          <span>Better Pharmacy Decisions.</span>
        </p>
      </div>
    </div>
  );
}
