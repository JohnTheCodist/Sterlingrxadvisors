import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/apiClient.js';

// Nigeria's 36 states + FCT. This is the only input the weather feature
// needs — deliberately independent of spreadsheet column mapping (branch/
// warehouse columns aren't reliably present in independent-pharmacy sales
// exports), so the pharmacy owner just picks it once, here.
const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue',
  'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu',
  'Federal Capital Territory', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano',
  'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun',
  'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];

export default function SettingsPanel() {
  const [state, setState] = useState('');
  const [saved, setSaved] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | idle | saving | saved | error

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/pharmacy-profile')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setState(data.state || '');
        setSaved(data.state || null);
        setStatus('idle');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setStatus('saving');
    try {
      const res = await apiFetch('/api/pharmacy-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: state || null }),
      });
      if (!res.ok) throw new Error('Save failed');
      const data = await res.json();
      setSaved(data.state || null);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (_) {
      setStatus('error');
    }
  };

  const dirty = state !== (saved || '');

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 text-base font-semibold text-[var(--color-ink)]">Pharmacy Location</h2>
      <p className="mb-4 text-sm text-[var(--color-ink-soft)] leading-relaxed">
        Used to power weather-driven demand insights (e.g. seasonal antimalarial, antihistamine,
        or asthma-medication alerts) — independent of anything in your uploaded spreadsheets.
      </p>

      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
        <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-2">
          State
        </label>
        <select
          value={state}
          onChange={(e) => setState(e.target.value)}
          disabled={status === 'loading'}
          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
        >
          <option value="">Not set</option>
          {NIGERIAN_STATES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={!dirty || status === 'saving'}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--color-primary)] px-5 py-2 text-xs font-semibold text-primary-foreground shadow transition hover:bg-[var(--color-primary-dark)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === 'saving' ? 'Saving…' : 'Save'}
          </button>
          {status === 'saved' && <span className="text-xs font-semibold text-success">Saved</span>}
          {status === 'error' && <span className="text-xs font-semibold text-destructive">Couldn't save — try again.</span>}
          {saved && !dirty && status === 'idle' && (
            <span className="text-xs text-[var(--color-ink-faint)]">Currently set to {saved}.</span>
          )}
        </div>
      </div>
    </div>
  );
}
