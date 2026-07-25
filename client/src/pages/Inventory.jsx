import { useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';

export default function Inventory() {
  const location = useLocation();
  const navigate = useNavigate();
  const analysis = location.state?.analysis;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!analysis?.fileName) {
      setError('No dataset analysis available. Please upload a file first.');
    }
  }, [analysis]);

  const loadInventory = async () => {
    setLoading(true);
    setError('');
    try {
      const formData = new FormData();
      // Re-fetch from server — the file buffer isn't serializable through router state.
      // Instead, we tell the server to analyze the most recent upload.
      const res = await fetch('/api/inventory-analytics', { method: 'POST' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to load inventory data');
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const caps = analysis?.capabilities || {};

  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      <div className="mx-auto max-w-[var(--max-width)] px-7 py-16">
        <div className="mb-12 text-center">
          <p className="eyebrow">Inventory Dashboard</p>
          <h1>Inventory Management</h1>
        </div>

        {!analysis ? (
          <div className="mx-auto max-w-xl rounded-xl border-2 border-gray-200 bg-gray-50 px-6 py-8 text-center">
            <p className="text-gray-600 font-semibold mb-2">No dataset loaded</p>
            <p className="text-sm text-gray-500 mb-6">Upload an inventory spreadsheet to see your stock analytics.</p>
            <button
              onClick={() => navigate('/upload')}
              className="inline-flex items-center gap-2 rounded-full bg-[var(--color-primary)] px-6 py-2.5 text-sm font-semibold text-white"
            >
              Go to Upload
            </button>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl">
            {/* Capability summary */}
            <div className="rounded-xl border border-[var(--color-line)] bg-white p-6 mb-8">
              <h3 className="text-sm font-semibold text-[var(--color-ink)] mb-4">Dataset Capabilities</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { key: 'inventory', label: 'Inventory' },
                  { key: 'expiry', label: 'Expiry Tracking' },
                  { key: 'supplier', label: 'Suppliers' },
                  { key: 'sales', label: 'Sales' },
                  { key: 'customer', label: 'Customers' },
                ].map(({ key, label }) => {
                  const active = caps[key];
                  return (
                    <div key={key} className={`rounded-lg border px-3 py-2 text-center ${
                      active ? 'border-emerald-200 bg-emerald-50' : 'border-gray-100 bg-gray-50/50'
                    }`}>
                      <div className={`text-xs font-semibold ${active ? 'text-emerald-700' : 'text-gray-400'}`}>
                        {active ? '✓' : '—'} {label}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Load inventory data */}
            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-medium text-red-600 mb-6">
                {error}
              </div>
            )}

            {!data && !loading && (
              <div className="text-center mb-8">
                <button
                  onClick={loadInventory}
                  className="inline-flex items-center gap-2 rounded-full bg-[var(--color-primary)] px-8 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[var(--color-primary)]/30 transition hover:bg-[var(--color-primary-dark)]"
                >
                  Load Inventory Data
                </button>
              </div>
            )}

            {loading && (
              <div className="text-center py-12">
                <div className="inline-block h-8 w-8 animate-spin rounded-full border-3 border-[var(--color-primary)]/30 border-t-[var(--color-primary)]" />
                <p className="mt-4 text-sm text-[var(--color-ink-soft)]">Loading inventory data...</p>
              </div>
            )}

            {/* Inventory metrics */}
            {data && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="rounded-xl border border-[var(--color-line)] bg-white p-5">
                    <p className="text-xs text-[var(--color-ink-faint)] mb-1">Stock Levels</p>
                    <p className="text-2xl font-bold text-[var(--color-ink)]">{data.stockMetrics?.totalProducts || 0}</p>
                    <p className="text-xs text-[var(--color-ink-soft)] mt-1">total products tracked</p>
                  </div>
                  <div className="rounded-xl border border-[var(--color-line)] bg-white p-5">
                    <p className="text-xs text-[var(--color-ink-faint)] mb-1">Low Stock Items</p>
                    <p className="text-2xl font-bold text-red-600">{data.stockMetrics?.lowStockCount || 0}</p>
                    <p className="text-xs text-[var(--color-ink-soft)] mt-1">below reorder threshold</p>
                  </div>
                  <div className="rounded-xl border border-[var(--color-line)] bg-white p-5">
                    <p className="text-xs text-[var(--color-ink-faint)] mb-1">Expiring Soon</p>
                    <p className="text-2xl font-bold text-amber-600">{data.stockMetrics?.expiringSoon || 0}</p>
                    <p className="text-xs text-[var(--color-ink-soft)] mt-1">within 90 days</p>
                  </div>
                </div>

                {data.products && data.products.length > 0 && (
                  <div className="rounded-xl border border-[var(--color-line)] bg-white overflow-hidden">
                    <div className="px-6 py-4 border-b border-[var(--color-line)] bg-[var(--color-bg)]">
                      <h3 className="text-sm font-semibold text-[var(--color-ink)]">Product Inventory</h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-[var(--color-line)] text-left">
                            <th className="px-6 py-3 text-xs font-semibold text-[var(--color-ink-faint)]">Product</th>
                            <th className="px-6 py-3 text-xs font-semibold text-[var(--color-ink-faint)] text-right">Stock</th>
                            <th className="px-6 py-3 text-xs font-semibold text-[var(--color-ink-faint)] text-right">Reorder</th>
                            <th className="px-6 py-3 text-xs font-semibold text-[var(--color-ink-faint)]">Supplier</th>
                            <th className="px-6 py-3 text-xs font-semibold text-[var(--color-ink-faint)]">Expiry</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.products.slice(0, 20).map((p, i) => (
                            <tr key={i} className={`border-b border-[var(--color-line)] last:border-0 ${p.stock <= (p.reorderLevel || 0) ? 'bg-red-50/30' : ''}`}>
                              <td className="px-6 py-3 font-medium text-[var(--color-ink)]">{p.name}</td>
                              <td className={`px-6 py-3 text-right font-mono ${p.stock <= (p.reorderLevel || 0) ? 'text-red-600 font-semibold' : 'text-[var(--color-ink)]'}`}>{p.stock}</td>
                              <td className="px-6 py-3 text-right font-mono text-[var(--color-ink-soft)]">{p.reorderLevel || '—'}</td>
                              <td className="px-6 py-3 text-[var(--color-ink-soft)]">{p.supplier || '—'}</td>
                              <td className={`px-6 py-3 font-mono text-xs ${p.expiryUrgent ? 'text-red-600 font-semibold' : 'text-[var(--color-ink-soft)]'}`}>{p.expiryDate || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {data.products.length > 20 && (
                        <div className="px-6 py-3 text-center text-xs text-[var(--color-ink-faint)]">
                          Showing 20 of {data.products.length} products
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {data.suppliers && data.suppliers.length > 0 && (
                  <div className="rounded-xl border border-[var(--color-line)] bg-white overflow-hidden">
                    <div className="px-6 py-4 border-b border-[var(--color-line)] bg-[var(--color-bg)]">
                      <h3 className="text-sm font-semibold text-[var(--color-ink)]">Suppliers</h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-[var(--color-line)] text-left">
                            <th className="px-6 py-3 text-xs font-semibold text-[var(--color-ink-faint)]">Supplier</th>
                            <th className="px-6 py-3 text-xs font-semibold text-[var(--color-ink-faint)] text-right">Products</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.suppliers.map((s, i) => (
                            <tr key={i} className="border-b border-[var(--color-line)] last:border-0">
                              <td className="px-6 py-3 font-medium text-[var(--color-ink)]">{s.name}</td>
                              <td className="px-6 py-3 text-right font-mono text-[var(--color-ink-soft)]">{s.productCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
