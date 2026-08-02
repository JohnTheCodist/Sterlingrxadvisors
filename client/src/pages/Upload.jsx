import { useCallback, useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useDropzone } from 'react-dropzone';
import { apiFetch } from '../lib/apiClient.js';

const ACCEPTED_TYPES = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel': ['.xlsx', '.csv'],
  'text/csv': ['.csv'],
  'text/plain': ['.csv'],
};

// Which categories are required for analysis to proceed.
const SALES_REQUIRED = new Set(['product_name']);
const INVENTORY_REQUIRED = new Set(['product_name']);
const PRICE_CATEGORIES = new Set(['revenue', 'selling_price']);
const PRODUCT_IDENTITY_CATEGORIES = new Set(['product_name', 'generic_name', 'brand', 'strength', 'dosage_form', 'pack_size', 'manufacturer']);

/**
 * Determine required categories based on the dataset's capabilities.
 * Sales files need product, quantity, date, and a price.
 * Inventory files only need a product name.
 */
function getRequiredCategories(capabilities) {
  if (!capabilities) return INVENTORY_REQUIRED; // fallback — only product identity required
  const isSales = capabilities.sales;
  const isInventory = capabilities.inventory;
  if (isSales && !isInventory) return SALES_REQUIRED;
  // Inventory (or mixed): only product identity is required to proceed
  return INVENTORY_REQUIRED;
}

// Business-domain grouping for the mapping dropdown.
// Groups appear in logical business order (not alphabetically).
const FIELD_GROUPS = [
  {
    label: 'Sales',
    options: [
      { value: 'revenue', label: 'Revenue (Total)' },
      { value: 'selling_price', label: 'Selling Price (Unit)' },
      { value: 'quantity', label: 'Quantity Sold' },
      { value: 'discount', label: 'Discount' },
      { value: 'tax', label: 'Tax' },
      { value: 'profit', label: 'Profit' },
      { value: 'margin', label: 'Gross Margin' },
      { value: 'cost_price', label: 'Purchase Cost' },
    ],
  },
  {
    label: 'Product',
    options: [
      { value: 'product_name', label: 'Product Name' },
      { value: 'generic_name', label: 'Generic Name' },
      { value: 'brand', label: 'Brand' },
      { value: 'strength', label: 'Strength (e.g. 500mg)' },
      { value: 'dosage_form', label: 'Dosage Form (e.g. Tablet)' },
      { value: 'pack_size', label: 'Pack Size' },
      { value: 'category', label: 'Category' },
      { value: 'subcategory', label: 'Subcategory' },
    ],
  },
  {
    label: 'Inventory',
    options: [
      { value: 'cost_price', label: 'Purchase Cost' },
      { value: 'current_stock', label: 'Current Stock' },
      { value: 'reorder_level', label: 'Reorder Level' },
      { value: 'min_stock', label: 'Min Stock' },
      { value: 'max_stock', label: 'Max Stock' },
      { value: 'opening_stock', label: 'Opening Stock' },
      { value: 'supplier', label: 'Supplier' },
      { value: 'batch_number', label: 'Batch Number' },
      { value: 'warehouse', label: 'Warehouse' },
    ],
  },
  {
    label: 'Expiry',
    options: [
      { value: 'expiry_date', label: 'Expiry Date' },
    ],
  },
  {
    label: 'Customer',
    options: [
      { value: 'customer', label: 'Customer Name' },
    ],
  },
  {
    label: 'Transaction',
    options: [
      { value: 'invoice_number', label: 'Invoice Number' },
      { value: 'payment_method', label: 'Payment Method' },
      { value: 'sales_channel', label: 'Sales Channel' },
    ],
  },
  {
    label: 'Branch',
    options: [
      { value: 'branch', label: 'Branch' },
      { value: 'warehouse', label: 'Warehouse' },
    ],
  },
  {
    label: 'Staff',
    options: [
      { value: 'sales_representative', label: 'Sales Representative' },
    ],
  },
  {
    label: 'Date \u0026 Time',
    options: [
      { value: 'transaction_date', label: 'Transaction Date' },
      { value: 'day', label: 'Day of Month' },
      { value: 'week', label: 'Week Number' },
      { value: 'expiry_date', label: 'Expiry Date' },
    ],
  },
  {
    label: 'Supplier',
    options: [
      { value: 'supplier', label: 'Supplier' },
      { value: 'manufacturer', label: 'Manufacturer' },
    ],
  },
];

// Human-readable labels built from FIELD_GROUPS — maps category codes to display names
const FIELD_LABEL_MAP = {};
for (const group of FIELD_GROUPS) {
  for (const opt of group.options) {
    FIELD_LABEL_MAP[opt.value] = opt.label;
  }
}

// Flat, de-duplicated list backing the field picker. A few fields appear under
// more than one group in FIELD_GROUPS (supplier, warehouse, expiry_date), which
// is right for browsing and wrong for searching — a filtered list that shows
// "Supplier" twice reads like a bug.
const ALL_FIELDS = (() => {
  const seen = new Map();
  for (const group of FIELD_GROUPS) {
    for (const opt of group.options) {
      if (!seen.has(opt.value)) seen.set(opt.value, { ...opt, group: group.label });
    }
  }
  return [...seen.values()];
})();

// Short plain-language glosses for the fields people actually confuse. Only
// where the label alone leaves a real question — annotating every field would
// bury the handful that need it.
const FIELD_HINTS = {
  cost_price: 'what you pay your supplier, per unit',
  selling_price: 'what you charge the customer, per unit',
  revenue: 'the total for the line — price x quantity',
  quantity: 'units sold on this line',
  current_stock: 'units you still have on the shelf',
  transaction_date: 'when the sale happened',
  expiry_date: 'when the medicine expires',
  reorder_level: 'the level at which you reorder',
  batch_number: 'manufacturer batch or lot code',
  invoice_number: 'receipt or invoice reference',
};

function searchFields(query) {
  const q = query.trim().toLowerCase();
  if (!q) return ALL_FIELDS;
  return ALL_FIELDS.filter((f) =>
    f.label.toLowerCase().includes(q)
    || f.value.replace(/_/g, ' ').includes(q)
    || (FIELD_HINTS[f.value] || '').includes(q)
    || f.group.toLowerCase().includes(q));
}

// Required fields for badges — will be overridden per-file based on capabilities
const DEFAULT_REQUIRED_FIELDS = new Set(['product_name']);

function getTierStyle(tier) {
  switch (tier) {
    case 'auto': return { bg: 'bg-success/10', text: 'text-success', border: 'border-success/30', label: 'Auto-mapped', icon: 'check' };
    case 'review': return { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/30', label: 'Review', icon: 'eye' };
    default: return { bg: 'bg-destructive/10', text: 'text-destructive', border: 'border-destructive/30', label: 'Needs mapping', icon: 'alert' };
  }
}

function formatPercent(n) {
  return Math.round(n * 100) + '%';
}

function isLlmDetection(detection) {
  return detection.source && /llm|ai/i.test(detection.source);
}

function FileDropZone({ file, onDrop, onRemove, compact }) {
  const onDropCb = useCallback(
    (accepted) => { if (accepted.length > 0) onDrop(accepted); },
    [onDrop]
  );
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onDropCb,
    accept: ACCEPTED_TYPES,
    maxFiles: 20,
    multiple: true,
  });

  const fileList = Array.isArray(file) ? file : (file ? [file] : []);
  // In compact mode this box sits directly below the Files step's own file
  // manifest — re-listing every file here too would show the same names
  // twice on one screen. Compact mode's only job is "add one more."
  const showFileList = fileList.length > 0 && !compact;

  return (
    <div className="flex flex-col gap-2">
      {showFileList && (
        <div className="space-y-1.5 mb-3">
          {fileList.map((f, i) => (
            <div key={f.name + i} className="flex items-center justify-between border-b border-[var(--color-line)] pb-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[var(--color-ink)] text-primary-foreground text-[10px] font-bold font-mono tracking-wider">
                  {f.name.split('.').pop().toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-ink)] truncate">{f.name}</p>
                  <p className="text-xs text-[var(--color-ink-faint)]">{(f.size / 1024).toFixed(0)} KB</p>
                </div>
              </div>
              <button
                onClick={() => onRemove(i)}
                className="shrink-0 p-1.5 text-[var(--color-ink-faint)] hover:text-[var(--color-danger)] transition-colors"
                aria-label={`Remove ${f.name}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        {...getRootProps()}
        className={`group flex cursor-pointer flex-col items-center rounded border-2 border-dashed transition-all
          ${compact ? 'px-5 py-6' : 'px-8 py-12'}
          ${isDragActive
            ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)]'
            : 'border-[var(--color-line)] bg-[var(--color-bg)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-tint)]'
          }`}
      >
        <input {...getInputProps()} />
        {!compact && (
          <div className="mb-4 flex h-12 w-12 items-center justify-center text-[var(--color-ink-faint)] group-hover:text-[var(--color-primary)] transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
        )}
        <p className={`font-medium text-[var(--color-ink-soft)] ${compact ? 'text-xs' : 'text-sm'}`}>
          {isDragActive ? 'Drop files here' : compact ? 'Add another file' : 'Drag \u0026 drop, or click to browse'}
        </p>
        {!compact && <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">.xlsx and .csv</p>}
      </div>
    </div>
  );
}

// ---- Tiered Column Review Components ----

// Shows a collapsed summary of auto-accepted (high-confidence) columns
function AutoAcceptedPanel({ columns, expanded, onToggle }) {
  const count = columns.length;
  return (
    <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-surface)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-sm"
      >
        <span className="flex items-center gap-2 text-[var(--color-ink-soft)]">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          </span>
          {count} column{count !== 1 ? 's' : ''} auto-mapped
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`map-chevron shrink-0 text-[var(--color-ink-faint)] ${expanded ? 'is-open' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div className={`map-accordion ${expanded ? 'is-open' : ''}`}>
        <div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[var(--color-ink-faint)]">
                <th className="text-left font-medium py-1 px-5">Column</th>
                <th className="text-left font-medium py-1">Mapped To</th>
                <th className="text-right font-medium py-1 px-5">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((col) => (
                <tr key={col.rawHeader} className="border-t border-[var(--color-line)]">
                  <td className="py-1.5 px-5 font-medium text-[var(--color-ink)]">{col.rawHeader}</td>
                  <td className="py-1.5 text-[var(--color-ink-soft)]">{FIELD_LABEL_MAP[col.mappedTo] || formatCategoryLabel(col.mappedTo)}</td>
                  <td className="py-1.5 px-5 text-right font-mono text-[var(--color-ink-faint)]">{formatPercent(col.bestGuess?.confidence || col.detections[0]?.confidence || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="h-2" />
        </div>
      </div>
    </div>
  );
}

// Single-card review queue — one column at a time, swipe (or button) to
// advance.
//
// The top 2 guesses are offered first because they are usually right. When
// they are not, the user picks from the full field list, filtered as they
// type. That ordering matters: at this point the user KNOWS what the column
// is, and the system's only job is to accept the answer. Asking them to
// describe it in prose so a model can map the description back onto a fixed
// list of 25 fields is slower, can fail, and needs a network round trip to do
// a lookup.
//
// The LLM re-read is kept, demoted to what it is good at — when the typed text
// matches no field name, it can still work out the meaning ("what the supplier
// charged me" -> cost_price). It is a fallback behind the list, not the only
// way through, so the path still works with no LLM configured.
//
// Nothing here ever skips a column on the user's behalf. Dropping a column
// while someone is actively trying to map it is the worst available outcome.
function MappingCard({ column, index, total, onResolve }) {
  const [exiting, setExiting] = useState(false);
  const [mode, setMode] = useState('idle'); // idle | browse | loading | match
  const [hint, setHint] = useState('');
  const [matchResult, setMatchResult] = useState(null);
  const [interpretFailed, setInterpretFailed] = useState(false);
  const cardRef = useRef(null);
  const dragRef = useRef({ startX: 0, dx: 0, dragging: false });

  const matches = searchFields(hint);
  const samples = (column.sampleValues || []).filter((v) => v != null && v !== '').slice(0, 4);

  // Focusing the search box makes the browser scroll it into view, which drags
  // the list underneath it along too — so the picker opened part-way down and
  // the most likely fields were above the fold. Pin it back to the top
  // whenever the list opens or the filter changes the results.
  const listRef = useRef(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [mode, hint]);

  const tier = column.tier === 'review' ? 'review' : 'confirm';
  const confidence = column.bestGuess?.confidence || column.detections?.[0]?.confidence || 0;
  const bestLabel = column.mappedTo ? (FIELD_LABEL_MAP[column.mappedTo] || formatCategoryLabel(column.mappedTo)) : null;
  const secondBest = column.alternatives && column.alternatives.length > 0 ? column.alternatives[0] : null;
  const secondLabel = secondBest ? (FIELD_LABEL_MAP[secondBest.category] || formatCategoryLabel(secondBest.category)) : null;

  const commit = (category) => {
    setExiting(true);
    setTimeout(() => onResolve(column.rawHeader, category), 200);
  };

  const onPointerDown = (e) => {
    // Don't hijack clicks on real controls (buttons, the hint input) —
    // only the card's own surface (title, question text, padding) starts
    // a swipe-to-skip gesture.
    if (e.target.closest('button, input, textarea')) return;
    dragRef.current = { startX: e.clientX, dx: 0, dragging: true };
    cardRef.current?.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    dragRef.current.dx = dx;
    if (cardRef.current) cardRef.current.style.transform = `translateX(${dx}px) rotate(${dx / 45}deg)`;
  };
  const endDrag = () => {
    if (!dragRef.current.dragging) return;
    const dx = dragRef.current.dx;
    dragRef.current.dragging = false;
    if (cardRef.current) cardRef.current.style.transform = '';
    if (dx < -90) commit('');
  };

  // Only reachable when the typed text matches no field in the list — at that
  // point the user has described something rather than named it, which is
  // exactly what the model is good at reading.
  const submitHint = async () => {
    if (!hint.trim()) return;
    setMode('loading');
    setInterpretFailed(false);
    try {
      const res = await apiFetch('/api/reinterpret-column', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawHeader: column.rawHeader, sampleValues: column.sampleValues || [], hint }),
      });
      const data = await res.json();
      if (data.matched) {
        setMatchResult({ category: data.category });
        setMode('match');
        return;
      }
    } catch (_) {
      // fall through — a failed interpretation is not a reason to lose the column
    }
    // Back to the list with the search cleared, rather than skipping the
    // column out from under the user.
    setInterpretFailed(true);
    setHint('');
    setMode('browse');
  };

  return (
    <div
      ref={cardRef}
      className={`map-card map-card--${tier} map-card-single ${exiting ? 'is-exiting' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="map-card-head">
        <span className={`map-badge map-badge--${tier}`}>
          <span className="dot" />{tier === 'review' ? `Review · ${formatPercent(confidence)}` : 'Uncertain'}
        </span>
        <span className="map-confidence">{index + 1} of {total}</span>
      </div>

      <p className="map-col-title">&ldquo;{column.rawHeader}&rdquo;</p>

      {/* Real cells from the file. A header alone often cannot identify a
          column — "Col7" means nothing, four of its values usually mean
          everything — and these were already in the payload, unused. */}
      {samples.length > 0 && (
        <div className="map-samples">
          {samples.map((v, i) => (
            <span key={i} className="map-sample">{String(v)}</span>
          ))}
        </div>
      )}

      {mode === 'idle' && (
        <>
          <p className="map-question">
            {bestLabel ? 'Which field is this?' : "I couldn't place this one — pick the field it belongs to."}
          </p>
          {(bestLabel || secondLabel) && (
            <div className="map-actions">
              {bestLabel && (
                <button type="button" onClick={() => commit(column.mappedTo)} className="map-btn map-btn--primary">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  {bestLabel}
                </button>
              )}
              {secondLabel && (
                <button type="button" onClick={() => commit(secondBest.category)} className="map-btn map-btn--secondary">
                  {secondLabel}
                </button>
              )}
            </div>
          )}
          <button type="button" onClick={() => setMode('browse')} className="map-else-link">
            {bestLabel ? 'Neither — choose a field' : 'Choose a field'}
          </button>
        </>
      )}

      {mode === 'browse' && (
        <>
          {interpretFailed && (
            <p className="map-question map-question--muted">
              I couldn&apos;t work that one out. Pick the field from the list instead.
            </p>
          )}
          <div className="map-hint-row">
            <input
              type="text"
              value={hint}
              autoFocus
              onChange={(e) => setHint(e.target.value)}
              onKeyDown={(e) => {
                // Enter takes the single remaining match — the fastest path
                // once typing has narrowed the list to one.
                if (e.key !== 'Enter') return;
                if (matches.length === 1) commit(matches[0].value);
                else if (matches.length === 0 && hint.trim()) submitHint();
              }}
              placeholder="Search fields, or describe the column…"
              className="map-hint-input"
            />
          </div>

          {matches.length > 0 ? (
            <div className="map-field-list" ref={listRef}>
              {matches.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => commit(f.value)}
                  className="map-field-option"
                >
                  <span className="map-field-label">{f.label}</span>
                  {FIELD_HINTS[f.value] && <span className="map-field-hint">{FIELD_HINTS[f.value]}</span>}
                  <span className="map-field-group">{f.group}</span>
                </button>
              ))}
            </div>
          ) : (
            // Nothing in the list matches what they typed — this is the one
            // case where asking the model to interpret it genuinely helps.
            <div className="map-field-empty">
              <p className="map-question">No field matches &ldquo;{hint}&rdquo;.</p>
              <button type="button" onClick={submitHint} className="map-btn map-btn--primary">
                Work out what I mean
              </button>
            </div>
          )}

          <button type="button" onClick={() => { setHint(''); setInterpretFailed(false); setMode('idle'); }} className="map-else-link">
            Back
          </button>
        </>
      )}

      {mode === 'loading' && (
        <p className="map-question flex items-center gap-2">
          <span className="map-spinner" /> Reading &ldquo;{hint}&rdquo;&hellip;
        </p>
      )}

      {mode === 'match' && matchResult && (
        <>
          <p className="map-question">That matches:</p>
          <div className="map-actions">
            <button type="button" onClick={() => commit(matchResult.category)} className="map-btn map-btn--primary">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              {FIELD_LABEL_MAP[matchResult.category] || formatCategoryLabel(matchResult.category)}
            </button>
            <button type="button" onClick={() => { setHint(''); setMode('browse'); }} className="map-btn map-btn--skip">
              Not that — show the list
            </button>
          </div>
        </>
      )}

      <div className="map-card-footer">
        <button type="button" onClick={() => commit('')} className="map-skip-link">Skip</button>
      </div>
    </div>
  );
}

function formatCategoryLabel(cat) {
  const labels = {
    product_name: 'Product Name',
    quantity: 'Quantity',
    revenue: 'Revenue',
    selling_price: 'Selling Price',
    cost_price: 'Cost Price',
    date: 'Date',
    payment_method: 'Payment Method',
    supplier: 'Supplier',
    manufacturer: 'Manufacturer',
    brand: 'Brand',
    generic_name: 'Generic Name',
    strength: 'Strength',
    dosage_form: 'Dosage Form',
    pack_size: 'Pack Size',
    category: 'Category',
    subcategory: 'Subcategory',
    batch_number: 'Batch Number',
    expiry_date: 'Expiry Date',
    branch: 'Branch',
    warehouse: 'Warehouse',
    sales_channel: 'Sales Channel',
    customer: 'Customer',
    current_stock: 'Current Stock',
    reorder_level: 'Reorder Level',
    min_stock: 'Min Stock',
    max_stock: 'Max Stock',
    opening_stock: 'Opening Stock',
    sales_representative: 'Sales Representative',
    invoice_number: 'Invoice Number',
    discount: 'Discount',
    tax: 'Tax',
    profit: 'Profit',
    margin: 'Margin',
    // Legacy
    product: 'Product',
    price: 'Price',
    cost: 'Cost',
  };
  return labels[cat] || cat;
}

export default function Upload() {
  const navigate = useNavigate();
  const [file, setFile] = useState([]);
  const [classifiedFiles, setClassifiedFiles] = useState({});
  const [activeFileIndex, setActiveFileIndex] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('upload');
  const [schemaData, setSchemaData] = useState(null);
  const [userMapping, setUserMapping] = useState({});
  const [reviewStatuses, setReviewStatuses] = useState({});
  const [autoExpanded, setAutoExpanded] = useState(false);
  const [classification, setClassification] = useState(null);

  const handleDrop = async (acceptedFiles) => {
    setError('');
    setPhase('upload');
    setSchemaData(null);
    setUserMapping({});
    setReviewStatuses({});
    setAutoExpanded(false);
    setClassification(null);
    setFile(prev => [...prev, ...acceptedFiles]);

    // Auto-classify all newly dropped files — use functional updater
    // to prevent race conditions when handleDrop is called concurrently.
    setLoading(true);
    const newEntries = {};
    for (const f of acceptedFiles) {
      try {
        const classifyForm = new FormData();
        classifyForm.append('file', f);
        const res = await apiFetch('/api/classify-dataset', { method: 'POST', body: classifyForm });
        const data = await res.json();
        if (res.ok) newEntries[f.name] = data;
      } catch (_) { /* individual file failure is non-blocking */ }
    }
    setClassifiedFiles(prev => ({ ...prev, ...newEntries }));
    setPhase('capabilities');
    setLoading(false);
  };

  const handleRemoveFile = (index) => {
    const removed = file[index];
    setFile(prev => prev.filter((_, i) => i !== index));
    if (removed && classifiedFiles[removed.name]) {
      const updated = { ...classifiedFiles };
      delete updated[removed.name];
      setClassifiedFiles(updated);
    }
    if (activeFileIndex === index) {
      setActiveFileIndex(null);
      setSchemaData(null);
      setUserMapping({});
      setReviewStatuses({});
      setAutoExpanded(false);
      setClassification(null);
    } else if (activeFileIndex > index) {
      setActiveFileIndex(activeFileIndex - 1);
    }
  };

  const handleMappingChange = (rawHeader, category) => {
    setUserMapping((prev) => {
      const next = { ...prev };
      // Explicit skip: store empty string so it survives JSON.stringify
      // and is distinguishable from "no mapping set yet."
      if (category === '' || category == null) {
        next[rawHeader] = '';
      } else {
        next[rawHeader] = category;
      }
      return next;
    });
  };

  const handleDetectSchema = async () => {
    if (!file || !file.length) return;
    setLoading(true);
    setError('');
    setClassification(null);

    try {
      // Step 1: Classify the dataset
      const classifyForm = new FormData();
      classifyForm.append('file', file[0]);

      const classifyRes = await apiFetch('/api/classify-dataset', { method: 'POST', body: classifyForm });
      const classifyData = await classifyRes.json();

      if (!classifyRes.ok) {
        setError(classifyData.error || 'Classification failed.');
        setLoading(false);
        return;
      }

      setClassification(classifyData);

      // Dashboard Composer: every capability independently activates its module.
      // No gating on dataset_type — capabilities ARE the contract.
      setPhase('capabilities');
      setLoading(false);
      return;
    } catch (err) {
      setError(err.message || 'Could not reach the server.');
      setLoading(false);
    }
  };

  const proceedToSchemaDetection = async (fileIndex) => {
    const f = file[fileIndex];
    if (!f) return;
    setActiveFileIndex(fileIndex);
    setLoading(true);
    setError('');

    try {
      const schemaForm = new FormData();
      schemaForm.append('file', f);
      const res = await apiFetch('/api/detect-schema', { method: 'POST', body: schemaForm });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Schema detection failed.'); setLoading(false); return; }

      const initial = {};
      const statuses = {};
      for (const col of data.columns) {
        if (col.ignored) continue;
        const conf = col.bestGuess?.confidence || col.detections?.[0]?.confidence || 0;
        // Columns below 50% confidence are noise — skip silently
        if (conf < 0.50) {
          initial[col.rawHeader] = '';
          statuses[col.rawHeader] = 'skipped';
          continue;
        }
        if (col.tier === 'auto') {
          // Auto-tier: accept immediately into userMapping
          if (col.mappedTo) initial[col.rawHeader] = col.mappedTo;
          statuses[col.rawHeader] = 'auto_accepted';
        } else if (col.tier === 'review') {
          // Review-tier: pre-fill is shown as guess but not yet committed
          statuses[col.rawHeader] = 'review_pending';
        } else {
          // Confirm-tier (or unknown tier): unresolved
          statuses[col.rawHeader] = 'unresolved';
        }
      }
      setUserMapping(initial);
      setReviewStatuses(statuses);
      setSchemaData(data);
      // Prefer per-file classifiedFiles entry; fall back to existing classification state
      // (single-file flow sets classification directly, not via classifiedFiles).
      const fileClassification = classifiedFiles[f.name] || classification;
      setClassification(fileClassification);
      setPhase('schema');
      setLoading(false);
    } catch (err) {
      setError(err.message || 'Could not reach the server.');
      setLoading(false);
    }
  };

  // Confirms the current file, then either chains straight into the next
  // uploaded file's mapping (no return trip to the file list) or, once the
  // last one is done, goes to the dashboard directly — there is no separate
  // "done" screen to land on first. One "Continue" in the Files step starts
  // this chain for however many files were uploaded; a single file is just a
  // chain of one.
  const handleConfirm = async () => {
    const f = activeFileIndex != null ? file[activeFileIndex] : null;
    if (!f) return;
    setLoading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('file', f);
      formData.append('mapping', JSON.stringify(userMapping));
      // Which of these the user actually decided, as opposed to accepted
      // automatically. A column the user OVERRODE is the strongest signal the
      // system can get — a person correcting the detector about one specific
      // column — and until now it was computed here and then dropped, so the
      // same mistake was repeated on every future file.
      formData.append('reviewStatuses', JSON.stringify(reviewStatuses));

      const res = await apiFetch('/api/confirm-mapping', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Processing failed.');
        setLoading(false);
        return;
      }

      const nextIndex = activeFileIndex + 1;
      if (nextIndex < file.length) {
        // proceedToSchemaDetection manages its own loading/error state —
        // returning here instead of also touching `loading` avoids a flash
        // between this call finishing and the next one starting.
        await proceedToSchemaDetection(nextIndex);
        return;
      }

      navigate('/dashboard', {
        state: {
          analytics: data.analytics, metrics: data.metrics,
          bizHealth: data.bizHealth, widgetManifest: data.widgetManifest,
        },
      });
    } catch (err) {
      setError(err.message || 'Could not reach the server.');
      setLoading(false);
    }
  };

  const handleBackToUpload = () => {
    setPhase('upload');
    setSchemaData(null);
    setUserMapping({});
    setReviewStatuses({});
    setAutoExpanded(false);
    setClassification(null);
    setActiveFileIndex(null);
  };

  // Client-side canProceed: checks that userMapping covers all required categories.
  // Requirements depend on the dataset type — inventory files don't need quantity/date/price.
  const capabilities = classification?.capabilities || {};
  const isSales = !!capabilities.sales;
  const isInventory = !!capabilities.inventory;
  const requiredCategories = getRequiredCategories(capabilities);
  const mappedCategories = new Set(Object.values(userMapping).filter(Boolean));
  // Product identity is satisfied by any identity field (brand, generic_name, etc.),
  // not just the exact 'product_name' category. The resolver composes a name from them.
  const requiredSatisfied = [...requiredCategories].every(cat => {
    if (cat === 'product_name') {
      return PRODUCT_IDENTITY_CATEGORIES && [...PRODUCT_IDENTITY_CATEGORIES].some(idCat => mappedCategories.has(idCat));
    }
    return mappedCategories.has(cat);
  });
  // Price is optional for all pipelines. Widgets that need price will show
  // a clear error if it's missing; volume-based metrics still work without it.
  const priceClientSatisfied = true;
  const canProceed = requiredSatisfied && priceClientSatisfied;
  const requiredStillNeeded = [...requiredCategories].filter(cat => {
    if (cat === 'product_name') {
      return !PRODUCT_IDENTITY_CATEGORIES || ![...PRODUCT_IDENTITY_CATEGORIES].some(idCat => mappedCategories.has(idCat));
    }
    return !mappedCategories.has(cat);
  }).length;

  // ---- Tiered review derived values ----
  const columns = schemaData?.columns || [];
  // Helper: best confidence for a column
  const colConfidence = (c) => c.bestGuess?.confidence || c.detections?.[0]?.confidence || 0;
  // Columns below 50 % confidence are noise — skip them entirely
  const MIN_CONFIDENCE = 0.50;
  const autoColumns    = columns.filter(c => c.tier === 'auto' && !c.ignored);
  const reviewColumns  = columns.filter(c => c.tier === 'review' && !c.ignored && colConfidence(c) >= MIN_CONFIDENCE);
  const confirmColumns = columns.filter(c => (c.tier === 'confirm' || !c.tier) && !c.ignored && colConfidence(c) >= MIN_CONFIDENCE);

  // A column scoring below MIN_CONFIDENCE never becomes a card at all — by
  // design, so a real upload isn't blocked resolving every weak guess. That's
  // safe for most fields, but not the transaction date: the server's own gate
  // for sales capability (hasTransactionCapability) is a hard boolean, mapped
  // or not, nothing in between — so a file whose date column has an odd
  // enough header could confirm with sales silently, invisibly switched off.
  //
  // Checking the DETECTOR'S own category isn't enough to catch this: a real
  // case ("Txn Dt") fuzzy-matched harder to "txn id" (67%) than to anything
  // date-related, so schemaDetector never recorded a transaction_date/date
  // detection for it AT ALL — there was nothing low-confidence to surface,
  // the column was simply never considered a date candidate in the first
  // place. This checks the raw header text directly instead, scoped to only
  // the columns invisible to the whole review queue (below MIN_CONFIDENCE) —
  // a visible pending card is already covered by the messages below.
  const dateAlreadyMapped = Object.values(userMapping).some(
    (cat) => cat === 'transaction_date' || cat === 'date'
  );
  const DATE_HEADER_HINT = /\b(date|dt|txn ?dt)\b/i;
  const hiddenDateCandidate = dateAlreadyMapped ? null : columns.find((c) => {
    if (c.ignored || colConfidence(c) >= MIN_CONFIDENCE) return false;
    return DATE_HEADER_HINT.test(c.normalizedHeader || c.rawHeader || '');
  });

  // Review columns sorted by ascending confidence (least certain first)
  const sortedReviewColumns = [...reviewColumns].sort((a, b) => {
    const ca = a.bestGuess?.confidence || 0;
    const cb = b.bestGuess?.confidence || 0;
    return ca - cb;
  });

  // Counts for progress bar and summary
  const confirmedCount = [
    ...reviewColumns, ...confirmColumns
  ].filter(c => {
    const s = reviewStatuses[c.rawHeader];
    return s === 'user_confirmed' || s === 'user_overridden';
  }).length;
  const skippedCount = [
    ...reviewColumns, ...confirmColumns
  ].filter(c => reviewStatuses[c.rawHeader] === 'skipped').length;

  // All review + confirm columns must be resolved (not in pending/unresolved state).
  // Only columns mapped to a required category gate the Confirm button;
  // non-required review/confirm columns (e.g. quantity on an inventory file) are auto-skipped.
  // Product identity is satisfied by any identity field (brand, generic_name, etc.).
  const requiredSet = new Set(requiredCategories);
  const isProductIdentityCategory = (cat) => requiredSet.has('product_name') && PRODUCT_IDENTITY_CATEGORIES.has(cat);
  const mappedToRequired = (col) => {
    const cat = userMapping[col.rawHeader] || col.mappedTo || '';
    return requiredSet.has(cat) || isProductIdentityCategory(cat);
  };
  const allResolved =
    reviewColumns.every(c => {
      if (!mappedToRequired(c)) return true; // non-required — auto-skip
      const s = reviewStatuses[c.rawHeader];
      return s === 'user_confirmed' || s === 'user_overridden' || s === 'skipped';
    }) &&
    // confirm-tier columns (confidence < 70%) do NOT gate the button.
    // The pipeline itself is unsure about these mappings — forcing the user
    // to resolve a low-confidence guess (e.g. "Prescription (Y/N)" → dosage_form)
    // would block the upload unnecessarily. The user can still map them manually.
    confirmColumns.every(c => {
      if (!mappedToRequired(c)) return true; // non-required — auto-skip
      if (c.tier === 'confirm') return true; // low-confidence: don't block
      const s = reviewStatuses[c.rawHeader];
      return s === 'user_confirmed' || s === 'skipped';
    });

  // Single-card queue: one column at a time, in the same ascending-confidence
  // order as before. A column drops out of the queue the moment it's resolved
  // (accepted / overridden / matched via hint / skipped) — no separate index
  // bookkeeping needed, the next card is just whatever's now first.
  const mappingQueue = [...sortedReviewColumns, ...confirmColumns].filter(
    (c) => userMapping[c.rawHeader] === undefined
  );
  const totalQueueCount = reviewColumns.length + confirmColumns.length;
  const currentCard = mappingQueue[0] || null;
  const resolvedQueueCount = totalQueueCount - mappingQueue.length;

  const handleCardResolve = (rawHeader, category) => {
    handleMappingChange(rawHeader, category);
    const col = columns.find((c) => c.rawHeader === rawHeader);
    const status = category === '' ? 'skipped' : (category === col?.mappedTo ? 'user_confirmed' : 'user_overridden');
    setReviewStatuses((prev) => ({ ...prev, [rawHeader]: status }));
  };

  const STEP_LABELS = ['Upload', 'Files', 'Map'];
  const stepIndex = { upload: 0, capabilities: 1, schema: 2 }[phase] ?? 0;
  const isWideCard = phase === 'schema';

  return (
    <div className="upload-shell">
      <div className={`upload-card ${isWideCard ? 'upload-card--wide' : ''}`}>
        <Link to="/dashboard" className="upload-card__close" aria-label="Close and return to dashboard">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </Link>

        <ol className="upload-steps">
          {STEP_LABELS.map((label, i) => (
            <li key={label} aria-current={i === stepIndex ? 'step' : undefined} data-done={i < stepIndex ? 'true' : undefined}>
              <span>{label}</span>
            </li>
          ))}
        </ol>

        {phase === 'upload' && (
          <>
            <h1 className="upload-title">Upload your spreadsheet</h1>
            <p className="upload-sub">Excel or CSV, from any pharmacy system.</p>

            <div className="mt-6">
              <FileDropZone file={file} onDrop={handleDrop} onRemove={handleRemoveFile} />
            </div>

            {error && <p className="upload-status" data-tone="danger">{error}</p>}

            <div className="mt-6">
              {file && file.length > 0 && (
                <button onClick={handleDetectSchema} disabled={loading} className="btn btn-primary auth__submit">
                  {loading ? 'Reading file…' : 'Continue'}
                </button>
              )}
            </div>
          </>
        )}

        {phase === 'capabilities' && (() => {
          const fileNames = Object.keys(classifiedFiles);
          const allFalse = fileNames.length > 0 && fileNames.every(name => {
            const caps = classifiedFiles[name]?.capabilities || {};
            return !caps.sales && !caps.inventory && !caps.expiry && !caps.supplier && !caps.customer;
          });

          return (<>
            <h1 className="upload-title">
              {fileNames.length} file{fileNames.length !== 1 ? 's' : ''} ready
            </h1>
            <p className="upload-sub">We'll walk through each file's columns, one at a time.</p>

            <div className="upload-files mt-5">
              {fileNames.map((name, idx) => {
                const c = classifiedFiles[name];
                const caps = c?.capabilities || {};
                const activeCaps = Object.entries(caps).filter(([, v]) => v).map(([k]) => k);
                const fileArrayIndex = file.findIndex((f) => f.name === name);

                return (
                  <div key={name} className="upload-file" style={{ '--i': idx }}>
                    <span className="upload-file__icon" aria-hidden="true">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="8" y1="13" x2="16" y2="13" />
                        <line x1="8" y1="17" x2="13" y2="17" />
                      </svg>
                    </span>

                    <div className="upload-file__body">
                      <p className="upload-file__name">{name}</p>
                      <div className="upload-file__meta">
                        <span className="upload-file__rows">{c?.rowCount || '?'} rows</span>
                        {activeCaps.map((cap) => (
                          <span key={cap} className="upload-file__tag">{cap}</span>
                        ))}
                      </div>
                    </div>

                    <span className="upload-file__ready" aria-hidden="true">
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    </span>

                    {fileArrayIndex !== -1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveFile(fileArrayIndex)}
                        className="upload-file__remove"
                        aria-label={`Remove ${name}`}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {allFalse && (
              <p className="upload-status mt-4">No dashboards match these files yet — check that the columns line up with a pharmacy sales or stock export.</p>
            )}

            {error && <p className="upload-status" data-tone="danger">{error}</p>}

            <div className="mt-6 flex items-center gap-4">
              <button
                onClick={() => proceedToSchemaDetection(0)}
                disabled={loading || fileNames.length === 0}
                className="btn btn-primary"
              >
                {loading ? 'Reading file…' : 'Continue'}
                {!loading && (
                  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                )}
              </button>
            </div>

            <div className="mt-5">
              <FileDropZone file={file} onDrop={handleDrop} onRemove={handleRemoveFile} compact />
            </div>

            <div className="mt-6">
              <button onClick={handleBackToUpload} className="text-sm font-semibold text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] transition">
                Start over
              </button>
            </div>
          </>);
        })()}

        {phase === 'schema' && schemaData && (
          <>
            <h1 className="upload-title">Map your columns</h1>
            <p className="upload-sub">
              {file.length > 1 ? `File ${activeFileIndex + 1} of ${file.length} — ` : ''}
              {schemaData.fileName} · {schemaData.rowCount} rows
            </p>

            {(reviewColumns.length + confirmColumns.length) > 0 && (() => {
              const totalToReview = reviewColumns.length + confirmColumns.length;
              const doneCount = confirmedCount + skippedCount;
              const pct = Math.round((doneCount / totalToReview) * 100);
              return (
                <div className="mt-5">
                  <p className="mb-1.5 text-xs font-medium text-[var(--color-ink-faint)]">{pct}% reviewed</p>
                  <div className="map-progress-track">
                    <div className="map-progress-fill" style={{ '--progress': doneCount / totalToReview }} />
                  </div>
                </div>
              );
            })()}

            <div className="mt-5">
              {autoColumns.length > 0 && (
                <AutoAcceptedPanel
                  columns={autoColumns}
                  expanded={autoExpanded}
                  onToggle={() => setAutoExpanded(!autoExpanded)}
                />
              )}

              {currentCard ? (
                <MappingCard
                  key={currentCard.rawHeader}
                  column={currentCard}
                  index={resolvedQueueCount}
                  total={totalQueueCount}
                  onResolve={handleCardResolve}
                />
              ) : totalQueueCount > 0 ? (
                <div className="map-card map-card--resolved">
                  <div className="map-resolved-row">
                    <span className="check">
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    </span>
                    <span>All columns reviewed — {confirmedCount} confirmed, {skippedCount} skipped.</span>
                  </div>
                </div>
              ) : null}
            </div>

            {hiddenDateCandidate && (
              <div className="upload-status" data-tone="danger">
                <p>
                  "{hiddenDateCandidate.rawHeader}" looks like it might name a date, but we didn't
                  recognize it as one, so it wasn't shown above. Without a date column, revenue and
                  trend figures won't be available for this file.
                </p>
                <button
                  type="button"
                  onClick={() => handleCardResolve(hiddenDateCandidate.rawHeader, 'transaction_date')}
                  className="mt-1.5 text-sm font-semibold text-[var(--color-danger)] underline underline-offset-2 hover:no-underline transition"
                >
                  Map "{hiddenDateCandidate.rawHeader}" as the transaction date
                </button>
              </div>
            )}

            {schemaData.ignored && schemaData.ignored.length > 0 && (
              <div className="mt-6 border-l-2 border-[var(--color-line-strong)] pl-3.5 py-1">
                <p className="text-xs font-semibold text-[var(--color-ink-soft)] mb-1.5">
                  Excluded ({schemaData.ignored.length})
                </p>
                <div className="space-y-1">
                  {schemaData.ignored.map((col) => (
                    <div key={col.rawHeader} className="flex items-center justify-between gap-4 text-xs">
                      <span className="text-[var(--color-ink-faint)]">{col.rawHeader}</span>
                      {col.reason && <span className="text-[var(--color-ink-faint)]/60">{col.reason}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!mappedCategories.has('selling_price') && !mappedCategories.has('revenue') && isSales && requiredStillNeeded === 0 && (
              <p className="upload-status" data-tone="accent">Add a price column to also see revenue and margin.</p>
            )}

            {error && <p className="upload-status" data-tone="danger">{error}</p>}

            {!canProceed && requiredStillNeeded > 0 && (
              <p className="upload-status" data-tone="danger">
                Map {requiredStillNeeded} more required column{requiredStillNeeded === 1 ? '' : 's'} to continue.
              </p>
            )}
            {canProceed && !allResolved && (
              <p className="upload-status" data-tone="accent">Finish reviewing the columns above to continue.</p>
            )}

            <div className="mt-6 flex items-center gap-4">
              <button
                onClick={handleBackToUpload}
                className="text-sm font-semibold text-[var(--color-ink-soft)] hover:text-[var(--color-ink)] transition"
              >
                Back
              </button>
              <button
                onClick={handleConfirm}
                disabled={loading || !canProceed || !allResolved}
                className="btn btn-primary auth__submit"
                style={{ width: 'auto', flex: '1 1 auto' }}
              >
                {loading
                  ? 'Processing…'
                  : activeFileIndex + 1 < file.length ? 'Confirm & continue' : 'Confirm & analyze'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
