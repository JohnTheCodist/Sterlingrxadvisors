/**
 * What a dashboard section shows when it has nothing to show.
 *
 * Before this, a section with no widgets rendered `null` — so a pharmacy that
 * uploaded a sales-only export could click "Inventory" and land on a blank
 * page. Nothing said the tab was empty, why it was empty, or that the file
 * they already uploaded could never fill it. The natural reading is that the
 * product is broken.
 *
 * The fix is not a generic "no data" line. Each section is empty for a
 * SPECIFIC and explainable reason rooted in how pharmacy systems actually
 * export data — a sales report records what left the shelf, never what is
 * still on it — so each one states its own reason, names the columns that
 * would fill it, and says what the owner would get in return. That turns a
 * dead end into an instruction.
 *
 * The illustrations carry the same message wordlessly and set the tone: an
 * emptied crate, sand running out, a truck already gone. They are deliberately
 * quiet — a pharmacy owner seeing this is missing something they may have paid
 * for, and a bouncy animation would read as mockery. Everything stops under
 * prefers-reduced-motion.
 */

// ---- illustrations ------------------------------------------------------
// Inline SVG rather than an asset: these inherit currentColor, so they follow
// the theme without a second set of dark-mode files, and cost no request.

function CrateArt() {
  // An open crate, emptied. The lid sits ajar and one last mote drifts down
  // — the visual of stock that has all been sold and none recorded back in.
  return (
    <svg viewBox="0 0 120 100" className="empty-art" role="presentation" aria-hidden="true">
      <ellipse cx="60" cy="88" rx="34" ry="5" className="empty-art__shadow" />
      <g className="empty-art__sway">
        <path d="M30 46 L60 36 L90 46 L90 76 L60 86 L30 76 Z" className="empty-art__body" />
        <path d="M30 46 L60 56 L90 46" className="empty-art__line" />
        <path d="M60 56 L60 86" className="empty-art__line" />
        <path d="M26 40 L58 29 L64 31" className="empty-art__lid" />
      </g>
      <circle cx="60" cy="30" r="2.5" className="empty-art__mote" />
      <circle cx="48" cy="26" r="1.8" className="empty-art__mote empty-art__mote--b" />
    </svg>
  );
}

function HourglassArt() {
  // Sand almost through. Expiry is the one section where the missing data is
  // itself about time running out, so the metaphor is literal.
  return (
    <svg viewBox="0 0 120 100" className="empty-art" role="presentation" aria-hidden="true">
      <ellipse cx="60" cy="90" rx="26" ry="4" className="empty-art__shadow" />
      <path d="M42 18 H78 M42 82 H78" className="empty-art__line" strokeWidth="3" />
      <path d="M45 18 C45 40 60 46 60 50 C60 54 45 60 45 82" className="empty-art__body" fill="none" />
      <path d="M75 18 C75 40 60 46 60 50 C60 54 75 60 75 82" className="empty-art__body" fill="none" />
      <path d="M50 24 L70 24 L61.5 47 L58.5 47 Z" className="empty-art__sand-top" />
      <path d="M52 78 L68 78 L64 68 L56 68 Z" className="empty-art__sand-bottom" />
      <line x1="60" y1="50" x2="60" y2="70" className="empty-art__grain" />
    </svg>
  );
}

function DockArt() {
  // The truck has already left — supplier data lives in purchase records the
  // sales export never carries.
  return (
    <svg viewBox="0 0 120 100" className="empty-art" role="presentation" aria-hidden="true">
      <ellipse cx="58" cy="88" rx="38" ry="5" className="empty-art__shadow" />
      <path d="M20 78 H100" className="empty-art__line" strokeWidth="3" />
      <g className="empty-art__depart">
        <path d="M62 52 H84 V72 H62 Z" className="empty-art__body" />
        <path d="M84 60 H92 L97 68 V72 H84 Z" className="empty-art__body" />
        <circle cx="70" cy="76" r="4" className="empty-art__line" />
        <circle cx="91" cy="76" r="4" className="empty-art__line" />
      </g>
      <path d="M24 72 H44 M28 78 H48" className="empty-art__track" />
    </svg>
  );
}

function CounterArt() {
  // An empty counter. Most Nigerian pharmacy POS setups ring up a walk-in
  // without ever capturing who the buyer was.
  return (
    <svg viewBox="0 0 120 100" className="empty-art" role="presentation" aria-hidden="true">
      <ellipse cx="60" cy="88" rx="34" ry="5" className="empty-art__shadow" />
      <path d="M26 62 H94 V70 H26 Z" className="empty-art__body" />
      <path d="M34 70 V84 M86 70 V84" className="empty-art__line" strokeWidth="3" />
      <circle cx="60" cy="44" r="9" className="empty-art__outline-figure" />
      <path d="M45 62 C45 52 52 47 60 47 C68 47 75 52 75 62" className="empty-art__outline-figure" />
    </svg>
  );
}

function FlatlineArt() {
  // A chart with nothing to plot.
  return (
    <svg viewBox="0 0 120 100" className="empty-art" role="presentation" aria-hidden="true">
      <ellipse cx="60" cy="88" rx="34" ry="5" className="empty-art__shadow" />
      <path d="M24 24 V78 H98" className="empty-art__line" strokeWidth="3" />
      <path d="M30 58 H92" className="empty-art__flatline" />
    </svg>
  );
}

// ---- what each section needs, and why it is empty ------------------------
//
// The "why" lines are the part that matters. They describe how pharmacy
// exports actually work, so the owner learns something about their own data
// rather than being told to go and click around. Column names match what the
// dataset classifier genuinely looks for, so following this advice works.

const SECTIONS = {
  inventory: {
    Art: CrateArt,
    title: 'No stock data in this upload',
    why: 'A sales report records what left your shelves. It cannot record what is still on them — '
      + 'those are two different exports from your POS, and only the stock one carries quantities on hand.',
    needs: ['Stock on hand / quantity in stock', 'Reorder or minimum level', 'Batch or lot number', 'Pack size, strength or dosage form'],
    unlocks: 'stock cover in days, reorder alerts before you run out, and the capital sitting in slow-moving lines',
    exportHint: 'In most pharmacy systems this is the "Stock Report", "Inventory Valuation" or "Stock on Hand" export.',
  },
  expiry: {
    Art: HourglassArt,
    title: 'No expiry dates in this upload',
    why: 'Expiry belongs to the batch, not to the sale. When a product is dispensed the system records the '
      + 'transaction, not the shelf life of the box it came from — so expiry never travels with a sales export.',
    needs: ['Expiry date', 'Batch or lot number', 'Quantity remaining in that batch'],
    unlocks: 'what expires in the next 30, 60 and 90 days, and the naira value at risk before it becomes a write-off',
    exportHint: 'Look for a "Batch Report", "Expiry Report" or a stock export that includes an expiry column.',
  },
  supplier: {
    Art: DockArt,
    title: 'No supplier data in this upload',
    why: 'Your sales file records who bought from you, never who sold to you. Supplier names live on the '
      + 'purchase side — goods-received notes and purchase orders — which is a separate record entirely.',
    needs: ['Supplier or vendor name', 'Manufacturer', 'Purchase or cost price'],
    unlocks: 'spend concentration per supplier, which ones carry your margin, and where you are exposed to a single source',
    exportHint: 'Usually a "Purchase Report", "Goods Received" or "Supplier Ledger" export.',
  },
  customer: {
    Art: CounterArt,
    title: 'No customer data in this upload',
    why: 'Most pharmacy counters ring up a walk-in without capturing who they are — the sale is recorded, '
      + 'the buyer is not. Unless your POS asks for a name, phone number or patient ID at checkout, the column is simply never written.',
    needs: ['Customer, patient or client name', 'Customer ID or phone number', 'Age or gender (optional)'],
    unlocks: 'repeat-purchase rates, who your most valuable regulars are, and which customers have quietly stopped coming',
    exportHint: 'If your POS supports it, enable customer capture at checkout — this section fills itself from then on.',
  },
  sales: {
    Art: FlatlineArt,
    title: 'No sales transactions in this upload',
    why: 'This file has no dated transaction rows. A stock or price list describes what you hold and what it '
      + 'costs, but without a date and an amount per sale there is no trading history to measure.',
    needs: ['Transaction or invoice date', 'Product name', 'Quantity sold', 'Amount or selling price'],
    unlocks: 'revenue and profit trends, your best and worst performers, and growth against previous periods',
    exportHint: 'This is the "Sales Report", "Daily Sales" or "Transaction History" export.',
  },
};

/**
 * @param {string} dashboardKey  which section is empty (inventory/expiry/…)
 * @param {function} [onUpload]  wired to the upload route when provided
 */
export default function SectionEmptyState({ dashboardKey, onUpload }) {
  const spec = SECTIONS[dashboardKey];
  // An unknown key must not blank the page all over again — fall back to a
  // plain, honest message rather than rendering nothing.
  if (!spec) {
    return (
      <div className="empty-state">
        <p className="empty-state__title">Nothing to show here yet</p>
        <p className="empty-state__why">This section has no data in the file you uploaded.</p>
      </div>
    );
  }

  const { Art, title, why, needs, unlocks, exportHint } = spec;

  return (
    <div className="empty-state" data-section={dashboardKey}>
      <div className="empty-state__art"><Art /></div>

      <h3 className="empty-state__title">{title}</h3>
      <p className="empty-state__why">{why}</p>

      <div className="empty-state__needs">
        <p className="empty-state__needs-label">Columns that would fill this section</p>
        <ul className="empty-state__needs-list">
          {needs.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>

      <p className="empty-state__unlocks">
        With those, this section shows {unlocks}.
      </p>

      <p className="empty-state__hint">{exportHint}</p>

      {onUpload && (
        <button type="button" className="empty-state__cta" onClick={onUpload}>
          Upload a file with this data
        </button>
      )}
    </div>
  );
}
