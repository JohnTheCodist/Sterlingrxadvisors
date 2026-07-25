import { useCallback, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDropzone } from 'react-dropzone';

const ACCEPTED_TYPES = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel': ['.xlsx', '.csv'],
  'text/csv': ['.csv'],
  'text/plain': ['.csv'],
};

// Which categories are required for analysis to proceed.
// Phase 1+: The API now provides `needsConfirmation` and `domainStatus` —
// these hardcoded sets are kept as a client-side fallback only.
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

function FileDropZone({ file, onDrop, onRemove }) {
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

  return (
    <div className="flex flex-col gap-2">
      {fileList.length > 0 && (
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
        className={`group flex cursor-pointer flex-col items-center rounded border-2 border-dashed px-8 py-12 transition-all
          ${isDragActive
            ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)]'
            : 'border-[var(--color-line)] bg-[var(--color-bg)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-tint)]'
          }`}
      >
        <input {...getInputProps()} />
        <div className="mb-4 flex h-12 w-12 items-center justify-center text-[var(--color-ink-faint)] group-hover:text-[var(--color-primary)] transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <p className="text-sm font-medium text-[var(--color-ink-soft)]">
          {isDragActive ? 'Drop files here' : 'Drag \u0026 drop spreadsheet files, or click to browse'}
        </p>
        <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">.xlsx and .csv</p>
      </div>
    </div>
  );
}

// ---- Tiered Column Review Components ----

// Shows a collapsed summary of auto-accepted (high-confidence) columns
function AutoAcceptedPanel({ columns, expanded, onToggle }) {
  const count = columns.length;
  return (
    <div className="border-b border-[var(--color-line)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between py-3 text-sm"
      >
        <span className="text-[var(--color-ink-faint)]">
          {count} column{count !== 1 ? 's' : ''} auto-mapped
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-[var(--color-ink-faint)] transition ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <div className="pb-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[var(--color-ink-faint)]">
                <th className="text-left font-medium py-1">Column</th>
                <th className="text-left font-medium py-1">Mapped To</th>
                <th className="text-right font-medium py-1">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((col) => (
                <tr key={col.rawHeader} className="border-t border-[var(--color-line)]">
                  <td className="py-1.5 font-medium text-[var(--color-ink)]">{col.rawHeader}</td>
                  <td className="py-1.5 text-[var(--color-ink-soft)]">{FIELD_LABEL_MAP[col.mappedTo] || formatCategoryLabel(col.mappedTo)}</td>
                  <td className="py-1.5 text-right text-[var(--color-ink-faint)]">{formatPercent(col.bestGuess?.confidence || col.detections[0]?.confidence || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// A single review-tier column card with accept / change / skip
// A single review-tier column card (confidence < 95%).
// Shows a conversational question with only the top 2 predictions + Skip.
// Never exposes the full system field list — the user sees a focused choice.
function ReviewCard({ column, userMapping, onAccept, onChange, onSkip }) {
  const confidence = column.bestGuess?.confidence || column.detections[0]?.confidence || 0;
  const mappedLabel = FIELD_LABEL_MAP[column.mappedTo] || formatCategoryLabel(column.mappedTo);
  const resolved = userMapping[column.rawHeader] !== undefined;

  // Top alternative (second-best match) for the third button
  const secondBest = column.alternatives && column.alternatives.length > 0
    ? column.alternatives[0]
    : null;
  const secondLabel = secondBest
    ? (FIELD_LABEL_MAP[secondBest.category] || formatCategoryLabel(secondBest.category))
    : null;

  const colName = `"${column.rawHeader}"`;

  if (resolved) {
    return (
      <div className="border-b border-[var(--color-line)] py-4">
        <p className="text-sm text-[var(--color-ink-faint)]">
          {colName} mapped as <strong>{userMapping[column.rawHeader] || 'skipped'}</strong>
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-[var(--color-line)] py-5">
      {/* Conversational question */}
      <p className="text-sm text-[var(--color-ink)] leading-relaxed">
        I noticed your column{' '}
        <strong className="text-[var(--color-ink)]">{colName}</strong>.
        {secondLabel
          ? <> Did you mean{' '}<strong>{mappedLabel}</strong>,{' '}<strong>{secondLabel}</strong>, or Skip?</>
          : <> Did you mean{' '}<strong>{mappedLabel}</strong> or Skip?</>
        }
      </p>

      {/* Action buttons: best match · second-best · skip */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Best match */}
        <button
          type="button"
          onClick={() => onAccept(column.rawHeader)}
          className="inline-flex items-center gap-1.5 bg-[var(--color-primary)] px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:bg-[var(--color-primary-dark)]"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          {mappedLabel}
        </button>

        {/* Second-best match */}
        {secondLabel && (
          <button
            type="button"
            onClick={() => onChange(column.rawHeader, secondBest.category)}
            className="inline-flex items-center gap-1.5 border border-[var(--color-line)] px-4 py-2 text-xs font-semibold text-[var(--color-ink-soft)] transition hover:bg-[var(--color-bg-alt)]"
          >
            {secondLabel}
          </button>
        )}

        {/* Skip */}
        <button
          type="button"
          onClick={() => onSkip(column.rawHeader)}
          className="inline-flex items-center gap-1.5 border border-[var(--color-line)] px-4 py-2 text-xs font-semibold text-[var(--color-ink-faint)] transition hover:bg-[var(--color-bg-alt)]"
        >
          Skip
        </button>
      </div>

      {/* Confidence hint */}
      <p className="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">
        {formatPercent(confidence)} confidence
      </p>

      {/* Warning */}
      <p className="mt-2 text-xs text-[var(--color-ink-faint)] leading-relaxed">
        Please choose carefully. If you&apos;re unsure, verify or skip this column, as incorrect mapping may affect the accuracy of your analysis.
      </p>
    </div>
  );
}

// An unresolved (confirm-tier) column card — conversational prompt.
// Same principle: only 2 guesses + Skip, no full field list.
function UnresolvedCard({ column, userMapping, onMappingChange, onSkip }) {
  const confidence = column.bestGuess?.confidence || column.detections[0]?.confidence || 0;
  const mappedLabel = FIELD_LABEL_MAP[column.mappedTo] || formatCategoryLabel(column.mappedTo);
  const resolved = userMapping[column.rawHeader] !== undefined;

  const secondBest = column.alternatives && column.alternatives.length > 0
    ? column.alternatives[0]
    : null;
  const secondLabel = secondBest
    ? (FIELD_LABEL_MAP[secondBest.category] || formatCategoryLabel(secondBest.category))
    : null;

  const colName = `"${column.rawHeader}"`;

  if (resolved) {
    return (
      <div className="border-b border-[var(--color-line)] py-4">
        <p className="text-sm text-[var(--color-ink-faint)]">
          {colName} mapped as <strong>{userMapping[column.rawHeader] || 'skipped'}</strong>
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-[var(--color-line)] py-5">
      {/* Conversational question */}
      <p className="text-sm text-[var(--color-ink)] leading-relaxed">
        {mappedLabel
          ? <>I wasn&apos;t sure about your column{' '}<strong>{colName}</strong>.{secondLabel ? <> It could be{' '}<strong>{mappedLabel}</strong>,{' '}<strong>{secondLabel}</strong>, or Skip?</> : <> Could it be{' '}<strong>{mappedLabel}</strong> or Skip?</>}</>
          : <>I couldn&apos;t figure out your column{' '}<strong>{colName}</strong>. Would you like to choose a field or Skip?</>
        }
      </p>

      {/* Action buttons */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {mappedLabel && (
          <button
            type="button"
            onClick={() => onMappingChange(column.rawHeader, column.mappedTo)}
            className="inline-flex items-center gap-1.5 bg-[var(--color-primary)] px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:bg-[var(--color-primary-dark)]"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            {mappedLabel}
          </button>
        )}

        {secondLabel && (
          <button
            type="button"
            onClick={() => onMappingChange(column.rawHeader, secondBest.category)}
            className="inline-flex items-center gap-1.5 border border-[var(--color-line)] px-4 py-2 text-xs font-semibold text-[var(--color-ink-soft)] transition hover:bg-[var(--color-bg-alt)]"
          >
            {secondLabel}
          </button>
        )}

        <button
          type="button"
          onClick={() => onSkip(column.rawHeader)}
          className="inline-flex items-center gap-1.5 border border-[var(--color-line)] px-4 py-2 text-xs font-semibold text-[var(--color-ink-faint)] transition hover:bg-[var(--color-bg-alt)]"
        >
          Skip
        </button>
      </div>

      {/* Warning */}
      <p className="mt-3 text-xs text-[var(--color-ink-faint)] leading-relaxed">
        Please choose carefully. If you&apos;re unsure, verify or skip this column, as incorrect mapping may affect the accuracy of your analysis.
      </p>
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
  const [llmStatus, setLlmStatus] = useState(null);
  const [classification, setClassification] = useState(null);
  const [processingResult, setProcessingResult] = useState(null);

  useEffect(() => {
    fetch('/api/llm-status')
      .then((r) => r.json())
      .then((data) => setLlmStatus(data))
      .catch(() => {});
  }, []);

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
        const res = await fetch('/api/classify-dataset', { method: 'POST', body: classifyForm });
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

      const classifyRes = await fetch('/api/classify-dataset', { method: 'POST', body: classifyForm });
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
    console.log('[proceedToSchemaDetection] fileIndex:', fileIndex, 'file name:', f?.name, 'file.length:', file.length);
    if (!f) {
      console.warn('[proceedToSchemaDetection] No file at index', fileIndex, '- returning early.');
      return;
    }
    setActiveFileIndex(fileIndex);
    setLoading(true);
    setError('');

    try {
      const schemaForm = new FormData();
      schemaForm.append('file', f);
      const res = await fetch('/api/detect-schema', { method: 'POST', body: schemaForm });
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
      console.log('[proceedToSchemaDetection] set userMapping with', Object.keys(initial).length, 'keys:', Object.keys(initial));
      console.log('[proceedToSchemaDetection] reviewStatuses:', JSON.stringify(statuses));
      console.log('[proceedToSchemaDetection] classifiedFiles[f.name]:', JSON.stringify(classifiedFiles[f.name]));
      setSchemaData(data);
      // Prefer per-file classifiedFiles entry; fall back to existing classification state
      // (single-file flow sets classification directly, not via classifiedFiles).
      const fileClassification = classifiedFiles[f.name] || classification;
      console.log('[proceedToSchemaDetection] effective classification:', JSON.stringify(fileClassification));
      setClassification(fileClassification);
      setPhase('schema');
      setLoading(false);
    } catch (err) {
      setError(err.message || 'Could not reach the server.');
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    const f = activeFileIndex != null ? file[activeFileIndex] : null;
    console.log('[handleConfirm] activeFileIndex:', activeFileIndex, 'file.length:', file.length, 'file name:', f?.name, 'userMapping keys:', Object.keys(userMapping));
    if (!f) {
      console.warn('[handleConfirm] No file found — activeFileIndex is stale or file array is empty. Returning early.');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('file', f);
      formData.append('mapping', JSON.stringify(userMapping));

      const res = await fetch('/api/confirm-mapping', { method: 'POST', body: formData });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Processing failed.');
        setLoading(false);
        return;
      }

      // Store result and show completion — no auto-navigation
      setProcessingResult(data);
      setPhase('processed');
      setLoading(false);
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
    setProcessingResult(null);
    setActiveFileIndex(null);
  };

  const requiredNeedMapping = schemaData?.unmappedRequired?.length || 0;
  const optionalUnmapped = schemaData?.unmappedOptional?.length || 0;
  const priceMissing = schemaData?.priceFulfilled === false;
  const ignoredColumns = schemaData?.ignored?.length || 0;
  const productIdentityFulfilled = schemaData?.productIdentityFulfilled !== false;
  const domainStatus = schemaData?.domainStatus || [];

  // Client-side canProceed: checks that userMapping covers all required categories.
  // Requirements depend on the dataset type — inventory files don't need quantity/date/price.
  const capabilities = classification?.capabilities || {};
  const isSales = !!capabilities.sales;
  const isInventory = !!capabilities.inventory;
  const isInventoryOnly = isInventory && !isSales;
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

  // ---- DEBUG: trace canProceed blockers ----
  console.log('[canProceed DEBUG] ========================================');
  console.log('[canProceed DEBUG] classification:', JSON.stringify(classification));
  console.log('[canProceed DEBUG] capabilities:', JSON.stringify(capabilities));
  console.log('[canProceed DEBUG] isSales:', isSales, '| isInventory:', isInventory, '| isInventoryOnly:', isInventoryOnly);
  console.log('[canProceed DEBUG] requiredCategories:', [...requiredCategories]);
  console.log('[canProceed DEBUG] userMapping keys:', Object.keys(userMapping));
  console.log('[canProceed DEBUG] userMapping values:', [...new Set(Object.values(userMapping).filter(Boolean))]);
  console.log('[canProceed DEBUG] mappedCategories:', [...mappedCategories]);
  console.log('[canProceed DEBUG] requiredSatisfied:', requiredSatisfied, '(needs:', [...requiredCategories], ')');
  console.log('[canProceed DEBUG] PRICE_CATEGORIES:', [...PRICE_CATEGORIES]);
  console.log('[canProceed DEBUG] priceClientSatisfied:', priceClientSatisfied);
  console.log('[canProceed DEBUG] canProceed:', canProceed);
  console.log('[canProceed DEBUG] requiredStillNeeded:', requiredStillNeeded);
  console.log('[canProceed DEBUG] schemaData?.needsConfirmation:', schemaData?.needsConfirmation);
  console.log('[canProceed DEBUG] schemaData?.columns count:', schemaData?.columns?.length);
  if (schemaData?.columns) {
    schemaData.columns.forEach(c => {
      console.log('[canProceed DEBUG]   col:', c.rawHeader, '| tier:', c.tier, '| mappedTo:', c.mappedTo, '| ignored:', c.ignored);
    });
  }
  console.log('[canProceed DEBUG] ========================================');

  const llmUsed = schemaData?.llm?.used;
  const llmSource = schemaData?.llm?.source;

  // ---- Tiered review derived values ----
  const columns = schemaData?.columns || [];
  // Helper: best confidence for a column
  const colConfidence = (c) => c.bestGuess?.confidence || c.detections?.[0]?.confidence || 0;
  // Columns below 50 % confidence are noise — skip them entirely
  const MIN_CONFIDENCE = 0.50;
  const autoColumns    = columns.filter(c => c.tier === 'auto' && !c.ignored);
  const reviewColumns  = columns.filter(c => c.tier === 'review' && !c.ignored && colConfidence(c) >= MIN_CONFIDENCE);
  const confirmColumns = columns.filter(c => (c.tier === 'confirm' || !c.tier) && !c.ignored && colConfidence(c) >= MIN_CONFIDENCE);

  // Review columns sorted by ascending confidence (least certain first)
  const sortedReviewColumns = [...reviewColumns].sort((a, b) => {
    const ca = a.bestGuess?.confidence || 0;
    const cb = b.bestGuess?.confidence || 0;
    return ca - cb;
  });

  // Counts for batch actions and summary
  const pendingReviewCount = reviewColumns.filter(
    c => reviewStatuses[c.rawHeader] === 'review_pending'
  ).length;
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

  const handleConfirmAllRemaining = () => {
    const newMappings = { ...userMapping };
    const newStatuses = { ...reviewStatuses };
    for (const col of reviewColumns) {
      if (reviewStatuses[col.rawHeader] === 'review_pending' && col.mappedTo) {
        newMappings[col.rawHeader] = col.mappedTo;
        newStatuses[col.rawHeader] = 'user_confirmed';
      }
    }
    setUserMapping(newMappings);
    setReviewStatuses(newStatuses);
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      <div className="mx-auto max-w-[var(--max-width)] px-7 py-16">

        {phase === 'upload' && (
          <>
            <div className="mb-10">
              <div className="flex items-center gap-2 mb-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-ink)] text-[10px] font-bold text-primary-foreground font-mono">1</span>
                <p className="text-xs font-semibold tracking-widest text-[var(--color-ink-faint)]">UPLOAD</p>
              </div>
              <h1 className="text-3xl md:text-4xl font-semibold text-[var(--color-ink)]">Upload your spreadsheet</h1>
              <p className="mt-3 text-base text-[var(--color-ink-soft)] max-w-prose">
                Upload a sales or inventory spreadsheet to begin the analysis. We support .xlsx and .csv files from any pharmacy system.
              </p>
              {llmStatus && (
                <div className="mt-4 inline-flex items-center gap-2 border px-3 py-1 text-[11px] font-semibold tracking-wide"
                  style={llmStatus.available
                    ? { borderColor: '#d8b4fe', background: '#faf5ff', color: '#7c3aed' }
                    : { borderColor: '#e5e7eb', background: '#f9fafb', color: '#9ca3af' }}>
                  <span className={`h-1.5 w-1.5 rounded-full ${llmStatus.available ? 'bg-purple-500' : 'bg-gray-300'}`} />
                  {llmStatus.available
                    ? `AI Mapping: ${llmStatus.config?.model || 'enabled'}`
                    : 'AI Mapping: not configured (using rules)'}
                </div>
              )}
            </div>

            <div className="max-w-xl">
              <FileDropZone
                file={file}
                onDrop={handleDrop}
                onRemove={handleRemoveFile}
              />
            </div>

            {error && (
              <div className="mt-6 max-w-xl border-l-2 border-[var(--color-danger)] bg-[var(--color-danger-tint)] px-4 py-3 text-sm text-[var(--color-danger)]">
                {error}
              </div>
            )}

            <div className="mt-8 max-w-xl">
              {!file || !file.length ? (
                <p className="text-sm text-[var(--color-ink-faint)]">Upload a file to continue.</p>
              ) : (
                <button
                  onClick={handleDetectSchema}
                  disabled={loading}
                  className="inline-flex items-center gap-2 bg-[var(--color-primary)] px-8 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-[var(--color-primary-dark)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      Detecting columns...
                    </>
                  ) : (
                    'Detect Columns'
                  )}
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
            <div className="mb-10">
              <div className="flex items-center gap-2 mb-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-ink)] text-[10px] font-bold text-primary-foreground font-mono">2</span>
                <p className="text-xs font-semibold tracking-widest text-[var(--color-ink-faint)]">FILES DETECTED</p>
              </div>
              <h1 className="text-3xl md:text-4xl font-semibold text-[var(--color-ink)]">
                {fileNames.length} file{fileNames.length !== 1 ? 's' : ''} uploaded
              </h1>
              <p className="mt-3 text-base text-[var(--color-ink-soft)] max-w-prose">
                Each file has been analyzed. Select a file to process through column mapping.
              </p>
            </div>

            <div className="max-w-2xl">
              {/* File grid */}
              <div className="space-y-1 mb-12">
                {fileNames.map((name, idx) => {
                  const c = classifiedFiles[name];
                  const caps = c?.capabilities || {};
                  const activeCaps = Object.entries(caps).filter(([,v]) => v).map(([k]) => k);

                  return (
                    <div key={name} className="group flex items-center justify-between gap-4 border-b border-[var(--color-line)] py-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-[var(--color-ink)] text-primary-foreground text-[10px] font-bold font-mono tracking-wider">
                          {name.split('.').pop().toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[var(--color-ink)] truncate">{name}</p>
                          <div className="flex flex-wrap items-center gap-1.5 mt-1">
                            <span className="text-xs text-[var(--color-ink-faint)]">{c?.rowCount || '?'} rows</span>
                            {activeCaps.map(cap => (
                              <span key={cap} className="inline-flex items-center border border-[var(--color-line)] px-1.5 py-px text-[10px] font-medium text-[var(--color-ink-faint)]">
                                {cap}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => proceedToSchemaDetection(idx)}
                        disabled={loading}
                        className="shrink-0 inline-flex items-center gap-1.5 bg-[var(--color-primary)] px-5 py-2 text-xs font-semibold text-primary-foreground transition hover:bg-[var(--color-primary-dark)] disabled:opacity-50"
                      >
                        {loading && activeFileIndex === idx ? (
                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                        ) : null}
                        Process
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Add more files — re-show dropzone */}
              <div className="mb-10">
                <FileDropZone
                  file={file}
                  onDrop={handleDrop}
                  onRemove={handleRemoveFile}
                />
              </div>

              {allFalse && (
                <div className="border-l-2 border-[var(--color-ink-faint)] bg-[var(--color-bg-alt)] px-4 py-6 mb-8">
                  <p className="font-semibold text-[var(--color-ink-soft)] mb-1">No dashboards available</p>
                  <p className="text-sm text-[var(--color-ink-faint)]">These files don't match any known dataset patterns.</p>
                </div>
              )}
            </div>

            {error && (
              <div className="mt-6 max-w-xl border-l-2 border-[var(--color-danger)] bg-[var(--color-danger-tint)] px-4 py-3 text-sm text-[var(--color-danger)]">
                {error}
              </div>
            )}

            {/* Back button */}
            <div className="mt-10 max-w-xl">
              <button onClick={handleBackToUpload} className="inline-flex items-center gap-2 border-b-2 border-[var(--color-line)] pb-1 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]">
                Start Over
              </button>
            </div>
          </>);
        })()}

        {phase === 'processed' && processingResult && (
          <>
            <div className="mb-10">
              <div className="flex items-center gap-2 mb-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-ink)] text-[10px] font-bold text-primary-foreground font-mono">4</span>
                <p className="text-xs font-semibold tracking-widest text-[var(--color-ink-faint)]">COMPLETE</p>
              </div>
              <h1 className="text-3xl md:text-4xl font-semibold text-[var(--color-ink)]">Processing complete</h1>
              <p className="mt-3 text-base text-[var(--color-ink-soft)] max-w-prose">
                Your dataset has been processed and registered. Choose what to do next.
              </p>
            </div>

            <div className="max-w-xl">
              {/* Summary card */}
              <div className="border border-[var(--color-line)] p-6 mb-8">
                <div className="flex items-center gap-3 mb-5">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-primary)]"><polyline points="20 6 9 17 4 12" /></svg>
                  <div>
                    <p className="text-sm font-semibold text-[var(--color-ink)]">Dataset registered</p>
                    <p className="text-xs text-[var(--color-ink-faint)]">
                      {processingResult.normalizedRowCount || processingResult.persistedRows || '?'} records stored
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs mb-4">
                  <div className="bg-[var(--color-bg-alt)] px-3 py-2">
                    <span className="text-[var(--color-ink-faint)]">File</span>
                    <p className="font-medium text-[var(--color-ink)]">{processingResult.fileName || (activeFileIndex != null && file[activeFileIndex] ? file[activeFileIndex].name : '')}</p>
                  </div>
                  <div className="bg-[var(--color-bg-alt)] px-3 py-2">
                    <span className="text-[var(--color-ink-faint)]">Status</span>
                    <p className="font-medium text-[var(--color-ink)]">Processed</p>
                  </div>
                </div>

                {/* Fact Store Summary */}
                {processingResult.factStore && (
                  <div className="pt-4 border-t border-[var(--color-line)]">
                    <p className="text-xs font-semibold text-[var(--color-ink-faint)] mb-2">Multi-Dataset Store</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-[var(--color-bg-alt)] px-3 py-2 text-center">
                        <p className="text-lg font-bold text-[var(--color-ink)]">{processingResult.factStore.FactSales || 0}</p>
                        <p className="text-[10px] text-[var(--color-ink-faint)]">FactSales</p>
                      </div>
                      <div className="bg-[var(--color-bg-alt)] px-3 py-2 text-center">
                        <p className="text-lg font-bold text-[var(--color-ink)]">{processingResult.factStore.FactInventory || 0}</p>
                        <p className="text-[10px] text-[var(--color-ink-faint)]">FactInventory</p>
                      </div>
                    </div>
                    <p className="mt-2 text-[10px] text-[var(--color-ink-faint)]">
                      Upload more files to unlock additional widgets
                    </p>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => navigate('/dashboard', { state: { analytics: processingResult.analytics, metrics: processingResult.metrics, bizHealth: processingResult.bizHealth, widgetManifest: processingResult.widgetManifest } })}
                  className="bg-[var(--color-primary)] px-8 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-[var(--color-primary-dark)]"
                >
                  View Dashboard
                </button>
                <button
                  onClick={() => { setPhase('capabilities'); setProcessingResult(null); setActiveFileIndex(null); setSchemaData(null); setUserMapping({}); setReviewStatuses({}); setAutoExpanded(false); setClassification(null); }}
                  className="border border-[var(--color-ink)] px-8 py-3 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-ink)] hover:text-primary-foreground"
                >
                  Process Another File
                </button>
                <button
                  onClick={handleBackToUpload}
                  className="border-b-2 border-[var(--color-line)] pb-1 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
                >
                  + Upload Another File
                </button>
              </div>
            </div>
          </>
        )}

        {phase === 'schema' && schemaData && (
          <>
            {activeFileIndex != null && file[activeFileIndex] && (
              <div className="mb-6 text-xs font-mono text-[var(--color-ink-faint)]">
                {file[activeFileIndex].name}
              </div>
            )}

            <div className="mb-10">
              <div className="flex items-center gap-2 mb-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-ink)] text-[10px] font-bold text-primary-foreground font-mono">3</span>
                <p className="text-xs font-semibold tracking-widest text-[var(--color-ink-faint)]">REVIEW MAPPING</p>
              </div>
              <h1 className="text-3xl md:text-4xl font-semibold text-[var(--color-ink)]">Column detection results</h1>
              <p className="mt-3 text-base text-[var(--color-ink-soft)] max-w-prose">
                {canProceed
                  ? `All required fields are mapped. ${optionalUnmapped > 0 ? `${optionalUnmapped} optional column${optionalUnmapped > 1 ? 's' : ''} unmapped — you can assign them now or skip.` : 'Review and confirm to continue.'}`
                  : `${requiredStillNeeded > 0 ? `${requiredStillNeeded} required column${requiredStillNeeded > 1 ? 's' : ''} still need${requiredStillNeeded === 1 ? 's' : ''} mapping.` : ''}`}
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {schemaData.savedMapping && (
                  <span className="inline-flex items-center gap-1.5 border border-[var(--color-line)] px-3 py-1 text-[11px] font-medium text-[var(--color-ink-faint)]">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    Saved mapping loaded
                  </span>
                )}
                {productIdentityFulfilled && schemaData.productIdentityFulfilled && (
                  <span className="inline-flex items-center gap-1.5 border border-[var(--color-line)] px-3 py-1 text-[11px] font-medium text-[var(--color-ink-faint)]">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    Flexible product identity
                  </span>
                )}
                {llmUsed && (
                  <span className="inline-flex items-center gap-1.5 border border-[var(--color-line)] px-3 py-1 text-[11px] font-medium text-[var(--color-ink-faint)]">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    AI mapping ({llmSource === 'cache' ? 'cached' : llmSource})
                  </span>
                )}
              </div>
            </div>

            {/* File info */}
            <div className="mb-8 flex flex-wrap items-center gap-4 text-sm font-mono">
              <span className="font-semibold text-[var(--color-ink)]">{schemaData.fileName}</span>
              <span className="text-[var(--color-ink-faint)]">{schemaData.rowCount} rows</span>
              <span className="text-[var(--color-ink-faint)]">Sheet: {schemaData.sheetName}</span>
            </div>

            {/* ---- Tiered Column Review ---- */}
            <div className="max-w-2xl space-y-0">
              {/* 1. Auto-accepted columns (collapsed summary) */}
              {autoColumns.length > 0 && (
                <AutoAcceptedPanel
                  columns={autoColumns}
                  expanded={autoExpanded}
                  onToggle={() => setAutoExpanded(!autoExpanded)}
                />
              )}

              {/* 2. Review queue (sorted by ascending confidence — least certain first) */}
              {sortedReviewColumns.map((col) => (
                <ReviewCard
                  key={col.rawHeader}
                  column={col}
                  userMapping={userMapping}
                  onAccept={(rawHeader) => {
                    if (col.mappedTo) handleMappingChange(rawHeader, col.mappedTo);
                    setReviewStatuses((prev) => ({ ...prev, [rawHeader]: 'user_confirmed' }));
                  }}
                  onChange={(rawHeader, v) => {
                    handleMappingChange(rawHeader, v);
                    setReviewStatuses((prev) => ({ ...prev, [rawHeader]: 'user_overridden' }));
                  }}
                  onSkip={(rawHeader) => {
                    handleMappingChange(rawHeader, '');
                    setReviewStatuses((prev) => ({ ...prev, [rawHeader]: 'skipped' }));
                  }}
                />
              ))}

              {/* 3. Unresolved columns (user must map or skip) */}
              {confirmColumns.map((col) => (
                <UnresolvedCard
                  key={col.rawHeader}
                  column={col}
                  userMapping={userMapping}
                  onMappingChange={(rawHeader, v) => {
                    handleMappingChange(rawHeader, v);
                    setReviewStatuses((prev) => ({ ...prev, [rawHeader]: 'user_confirmed' }));
                  }}
                  onSkip={(rawHeader) => {
                    handleMappingChange(rawHeader, '');
                    setReviewStatuses((prev) => ({ ...prev, [rawHeader]: 'skipped' }));
                  }}
                />
              ))}
            </div>

            {/* 4. Batch actions & summary */}
            {(pendingReviewCount > 0 || allResolved) && (
              <div className="mt-6 max-w-2xl flex flex-wrap items-center gap-3">
                {pendingReviewCount > 0 && (
                  <button
                    type="button"
                    onClick={handleConfirmAllRemaining}
                    className="border border-[var(--color-primary)] px-5 py-2 text-sm font-semibold text-[var(--color-primary)] transition hover:bg-[var(--color-primary-tint)]"
                  >
                    Confirm all {pendingReviewCount} remaining
                  </button>
                )}
                {allResolved && (
                  <div className="border border-[var(--color-line)] px-4 py-1.5 text-xs text-[var(--color-ink-soft)]">
                    {autoColumns.length} auto-mapped &middot; {confirmedCount} confirmed by you &middot; {skippedCount} skipped
                  </div>
                )}
              </div>
            )}

            {/* Phase 1: Ignored columns */}
            {schemaData.ignored && schemaData.ignored.length > 0 && (
              <div className="mt-8 max-w-2xl border-l-2 border-[var(--color-ink-faint)] pl-4 py-2">
                <h3 className="text-sm font-semibold text-[var(--color-ink-soft)] mb-1">
                  Excluded from analysis ({schemaData.ignored.length})
                </h3>
                <p className="text-xs text-[var(--color-ink-faint)] mb-3">
                  Non-business data (notes, contact info, audit fields) — attached to the dataset but excluded automatically.
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

            {/* Domain satisfaction indicators */}
            {domainStatus.length > 0 && (
              <div className="mt-6 max-w-2xl flex flex-wrap items-center gap-2">
                {(isInventory
                  ? domainStatus.filter(d => d.domain !== 'sales_quantity' && d.domain !== 'sales_date')
                  : domainStatus
                ).map((d) => (
                  <span
                    key={d.domain}
                    className={`inline-flex items-center gap-1.5 border px-3 py-1 text-[11px] font-semibold ${
                      d.satisfied
                        ? 'border-[var(--color-line)] text-[var(--color-ink-soft)]'
                        : 'border-[var(--color-danger-tint)] bg-[var(--color-danger-tint)] text-[var(--color-danger)]'
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${d.satisfied ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-danger)]'}`} />
                    {d.label}
                    {d.satisfied ? '' : ' \u2717'}
                  </span>
                ))}
                <span className={`inline-flex items-center gap-1.5 border px-3 py-1 text-[11px] font-semibold ${
                  priceClientSatisfied
                    ? 'border-[var(--color-line)] text-[var(--color-ink-soft)]'
                    : 'border-[var(--color-danger-tint)] bg-[var(--color-danger-tint)] text-[var(--color-danger)]'
                }`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${priceClientSatisfied ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-danger)]'}`} />
                  Price / Revenue
                  {priceClientSatisfied ? '' : ' \u2717'}
                </span>
              </div>
            )}

            {!mappedCategories.has('selling_price') && !mappedCategories.has('revenue') && isSales && requiredStillNeeded === 0 && (
              <div className="mt-6 max-w-2xl border-l-2 border-[var(--color-accent)] pl-4 py-2">
                <h3 className="text-sm font-semibold text-[var(--color-ink)] mb-1">Tip: Add a price field</h3>
                <p className="text-xs text-[var(--color-ink-soft)]">
                  Sales dashboards work best with price data. Revenue, margin, and profit metrics will show errors without it — but volume-based metrics will still work.
                </p>
              </div>
            )}

            {error && (
              <div className="mt-6 max-w-2xl border-l-2 border-[var(--color-danger)] bg-[var(--color-danger-tint)] px-4 py-3 text-sm text-[var(--color-danger)]">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="mt-10 max-w-2xl space-y-4">
              {canProceed && allResolved ? (
                <div className="border-l-2 border-[var(--color-primary)] pl-4 py-1 text-sm text-[var(--color-ink)]">
                  All columns are mapped. Ready to import.
                </div>
              ) : canProceed && !allResolved ? (
                <div className="border-l-2 border-[var(--color-accent)] pl-4 py-1 text-sm text-[var(--color-ink-soft)]">
                  Review the remaining columns above before confirming.
                </div>
              ) : null}
              {!canProceed && (
                <div className="border-l-2 border-[var(--color-danger)] pl-4 py-1 text-sm text-[var(--color-danger)]">
                  {requiredStillNeeded > 0 && 'Map all required fields to proceed.'}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-4">
                <button
                  onClick={handleBackToUpload}
                  className="border-b-2 border-[var(--color-line)] pb-1 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
                >
                  Back
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={loading || !canProceed || !allResolved}
                  className="inline-flex items-center gap-2 bg-[var(--color-primary)] px-8 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-[var(--color-primary-dark)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      Processing...
                    </>
                  ) : (
                    'Confirm & Analyze'
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
