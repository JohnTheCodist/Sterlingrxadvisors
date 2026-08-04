import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Download page for the Windows desktop app.
 *
 * Deliberately unauthenticated: a pharmacy evaluating the product has to be
 * able to get the installer before it has an account.
 *
 * The button renders from what the server actually has on disk rather than a
 * hardcoded version and size, so a stale number can never send someone to a
 * dead link. When no build is published the page says so instead of offering a
 * download that would fail.
 */

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
};

export default function Download() {
  const [release, setRelease] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/desktop/release')
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setRelease(data); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const available = release?.available;

  return (
    <>
      <section className="page-header">
        <div className="shell">
          <div className="section-head center">
            <span className="eyebrow">Desktop app</span>
            <h1>SterlingRx Advisors on your counter PC.</h1>
            <p className="lead">
              The same dashboards, the same Advisor, in its own window — no browser tab
              to lose, no address to remember. Your data stays where it already is.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="download-panel">
            {failed && (
              <p className="download-note">
                Could not check for a download just now. Please refresh, or{' '}
                <Link to="/contact">contact us</Link> and we will send it to you directly.
              </p>
            )}

            {!failed && !release && (
              <p className="download-note">Checking for the latest version…</p>
            )}

            {!failed && release && !available && (
              <>
                <h2>Not quite ready</h2>
                <p className="download-note">
                  The desktop app is in final testing. Use SterlingRx Advisors in your browser in the
                  meantime — it is the same product, and everything you upload now will be
                  there when you install.
                </p>
                <div className="download-actions">
                  <Link className="btn btn-primary" to="/signup">Start in your browser</Link>
                  <Link className="btn btn-ghost" to="/contact">Tell me when it is out</Link>
                </div>
              </>
            )}

            {!failed && available && (
              <>
                <div className="download-head">
                  <div className="download-mark" aria-hidden="true">Rx</div>
                  <div>
                    <h2>SterlingRx Advisors for Windows</h2>
                    <p className="download-meta">
                      Version {release.version} · {release.sizeMB} MB
                      {release.builtAt && ` · Released ${fmtDate(release.builtAt)}`}
                    </p>
                  </div>
                </div>

                <div className="download-actions">
                  {/* A plain link, not fetch(): the browser then shows its own
                      progress bar and handles resuming a 78 MB download, which
                      a JS-driven download cannot do well. */}
                  <a className="btn btn-primary btn-lg" href="/download/desktop">
                    Download for Windows
                  </a>
                  <span className="download-req">{release.minimumOS}</span>
                </div>

                {/* Said BEFORE they see it. An unsigned installer makes Windows
                    show a full-screen blue warning, and a pharmacist who paid
                    for software and is then told it is dangerous will assume
                    they have been sold malware. Naming it first turns a refund
                    into a shrug. */}
                {!release.signed && (
                  <div className="download-warning">
                    <strong>Windows will show a blue warning screen when you open this file.</strong>
                    <p>
                      That is normal for newly released software and does not mean the file is
                      unsafe — it means Windows has not seen enough copies of it yet. Click
                      <em> More info</em>, then <em>Run anyway</em>.
                    </p>
                  </div>
                )}

                <ol className="download-steps">
                  <li>Download and run the installer.</li>
                  <li>Sign in with the same email and password you use on the website.</li>
                  <li>Your uploads, dashboards and history are already there.</li>
                </ol>

                <p className="download-note">
                  Needs an internet connection. Prefer not to install anything?{' '}
                  <Link to="/signin">Use SterlingRx Advisors in your browser</Link> — it is the same product.
                </p>
              </>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
