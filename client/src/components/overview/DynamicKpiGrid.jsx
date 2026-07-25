import KpiCard from '../KpiCard';
import { formatNaira, formatNumber, formatPercent } from '../../utils/format';

// Order mirrors the PRD's example KPI lists — pulled 1:1 from widgetRegistry.js ids.
const SALES_KPI_IDS = [
  'revenue-kpi', 'profit-kpi', 'margin-kpi', 'transactions-kpi',
  'products-sold-kpi', 'distinct-products-kpi', 'avg-basket-value', 'avg-items-per-basket',
];
const INVENTORY_KPI_IDS = ['stock-value', 'current-stock', 'inventory-turnover', 'low-stock-alert'];

function formatFor(w) {
  if (!w) return null;
  if (w.format === 'currency') return formatNaira;
  if (w.format === 'percentage') return formatPercent;
  if (w.format === 'number') return formatNumber;
  return null;
}

function pickWidgets(available, ids) {
  const byId = new Map((available || []).map((w) => [w.id, w]));
  return ids.map((id) => byId.get(id)).filter((w) => w && !w.result?.error);
}

export default function DynamicKpiGrid({ widgetManifest, capabilities }) {
  const dashboards = widgetManifest?.dashboards || {};
  const salesAvailable = dashboards.sales?.available || [];
  const inventoryAvailable = [...(dashboards.inventory?.available || []), ...(dashboards.expiry?.available || [])];

  const showSales = !!capabilities?.sales && salesAvailable.length > 0;
  const showInventory = !!capabilities?.inventory && inventoryAvailable.length > 0;

  const salesKpis = showSales ? pickWidgets(salesAvailable, SALES_KPI_IDS) : [];
  const growthWidget = showSales ? salesAvailable.find((w) => w.id === 'sales-growth-rate' && !w.result?.error) : null;
  const inventoryKpis = showInventory ? pickWidgets(inventoryAvailable, INVENTORY_KPI_IDS) : [];

  const hasSalesCards = salesKpis.length > 0 || !!growthWidget;
  const hasInventoryCards = inventoryKpis.length > 0;
  const showBoth = hasSalesCards && hasInventoryCards;

  if (!hasSalesCards && !hasInventoryCards) return null;

  return (
    <div className="mb-6">
      {hasSalesCards && (
        <div className={showBoth ? 'mb-2' : ''}>
          {showBoth && (
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">Sales</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {salesKpis.map((w) => (
              <KpiCard
                key={w.id}
                label={w.title}
                value={w.result?.value}
                format={formatFor(w)}
                sub={w.result?.sublabel || w.result?.sub || null}
                trend={w.result?.trend}
                description={w.description}
              />
            ))}
            {growthWidget && (
              <KpiCard
                label="Sales Growth"
                value={growthWidget.result?.growth}
                format={formatPercent}
                sub={growthWidget.result?.growthClassification}
                description={growthWidget.description}
              />
            )}
          </div>
        </div>
      )}

      {showBoth && <div className="my-5 border-t border-[var(--color-line)]" />}

      {hasInventoryCards && (
        <div>
          {showBoth && (
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-faint)]">Inventory</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {inventoryKpis.map((w) => (
              <KpiCard
                key={w.id}
                label={w.title}
                value={w.result?.value}
                format={formatFor(w)}
                sub={w.result?.sublabel || w.result?.sub || null}
                description={w.description}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
