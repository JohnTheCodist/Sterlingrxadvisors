import { useState } from 'react';

// The single most prominent card on the Overview page — overall score,
// rating, and an expandable pillar breakdown. Data comes straight from
// GET /api/business-health (bizHealth.health); no scoring logic here.
export default function BusinessHealthCard({ bizHealth }) {
  const [pillarsExpanded, setPillarsExpanded] = useState(true);

  if (!bizHealth?.health) return null;
  const bh = bizHealth.health;
  const scoreColor = bh.rating === 'Excellent' ? 'emerald' : bh.rating === 'Healthy' ? 'emerald' : bh.rating === 'Stable' ? 'amber' : bh.rating === 'At Risk' ? 'orange' : 'red';

  return (
    <div className="mb-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-6">
        <div className={`flex h-24 w-24 shrink-0 items-center justify-center rounded-full text-3xl font-bold font-mono
          ${scoreColor === 'emerald' ? 'bg-success/10 text-success' :
            scoreColor === 'amber' ? 'bg-amber-50 text-warning' :
            scoreColor === 'orange' ? 'bg-orange-100 text-orange-700' :
            'bg-destructive/10 text-destructive'}`}>
          {bh.overallScore}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">Business Health</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-lg font-semibold text-[var(--color-ink)]">{bh.rating}</span>
            <span className="text-sm text-[var(--color-ink-faint)] font-mono">{bh.overallScore}/100</span>
            <button
              onClick={() => setPillarsExpanded(!pillarsExpanded)}
              className="ml-1 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-bg-alt)] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] transition-colors"
              title="Toggle pillar breakdown"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                className={`transition-transform ${pillarsExpanded ? 'rotate-180' : ''}`}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)] leading-relaxed">
            {bh.customerRedistributed && 'Customer Health unavailable. '}
            {bh.concerns?.length || 0} area{(bh.concerns?.length || 0) === 1 ? '' : 's'} need attention · {bh.strengths?.length || 0} performing well
          </p>
        </div>
      </div>

      {pillarsExpanded && bh.pillars?.length > 0 && (
        <div className="mt-6 pt-5 border-t border-[var(--color-line)] grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {bh.pillars.map((pillar) => (
            <div key={pillar.name} className={`rounded-lg border border-[var(--color-line)] p-3 ${!pillar.assessed ? 'border-dashed bg-[var(--color-bg-alt)]' : ''}`}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">
                {pillar.name.replace(' Performance', '')}
              </p>
              {pillar.assessed ? (
                <>
                  <p className={`font-mono text-xl font-bold ${pillar.band === 'good' ? 'text-emerald-600' : pillar.band === 'fair' ? 'text-warning' : pillar.band === 'warning' ? 'text-orange-600' : 'text-red-600'}`}>
                    {pillar.score}
                  </p>
                  <div className="w-full h-1 rounded-full bg-[var(--color-bg-alt)] overflow-hidden mt-1">
                    <div className={`h-full rounded-full ${pillar.band === 'good' ? 'bg-emerald-500' : pillar.band === 'fair' ? 'bg-amber-500' : pillar.band === 'warning' ? 'bg-orange-500' : 'bg-red-500'}`}
                      style={{ width: `${pillar.score}%` }} />
                  </div>
                  <p className="text-[10px] text-[var(--color-ink-faint)] mt-0.5 capitalize">{pillar.band} · {pillar.adjustedWeight}%</p>
                </>
              ) : (
                <p className="text-[10px] text-[var(--color-ink-faint)] italic leading-tight">{pillar.notAssessedReason?.substring(0, 60)}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
