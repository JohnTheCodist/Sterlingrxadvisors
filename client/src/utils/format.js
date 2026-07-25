// format.js — Shared display formatters. Single source of truth so every
// page/component renders numbers identically (KpiCard, Overview, widgets).

export function formatNaira(n) {
  if (n == null) return '—';
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function formatNairaDec(n) {
  if (n == null) return '—';
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatNumber(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-NG');
}

export function formatPercent(n) {
  if (n == null) return '—';
  return Number(n).toFixed(1) + '%';
}
