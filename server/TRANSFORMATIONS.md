# SterlingRx Advisors — Transformation Reference

Every transformation in the data pipeline, with rationale and examples.

---

## Pipeline Overview

```
Raw Excel rows
  │
  ├─ 1. Header Normalization
  ├─ 2. Schema Detection (dictionary + value pattern)
  ├─ 3. Column Mapping (confidence-scored)
  ├─ 4. Data Cleaning
  │     ├─ 4a. Empty row removal
  │     ├─ 4b. Duplicate header removal
  │     ├─ 4c. Excel serial date conversion
  │     ├─ 4d. Date string parsing
  │     ├─ 4e. Text trimming
  │     ├─ 4f. Product name normalization
  │     └─ 4g. Payment method normalization
  ├─ 5. Field Normalization (raw headers → canonical fields)
  ├─ 6. Missing Value Filling
  └─ 7. Transaction Deduplication
  │
  ▼
Normalized records → Star Schema
```

---

## 1. Header Normalization

**Why:** Nigerian POS systems export wildly inconsistent column names — different casing, punctuation, currency symbols, and whitespace. Normalization ensures the dictionary matching step works reliably.

**What:** Converts all headers to lowercase, strips currency symbols (₦$€£¥), replaces punctuation with spaces, collapses whitespace.

| Before | After |
|--------|-------|
| `Selling Price (₦)` | `selling price` |
| `Qty_Sold` | `qty sold` |
| `  Product  NAME  ` | `product name` |
| `Medicine-Name` | `medicine name` |

---

## 2. Schema Detection

**Why:** Column names alone are unreliable. A column called "Amount" could be price, cost, or quantity. Inspecting sample values disambiguates.

**What:** For each column, combines header similarity (Levenshtein against dictionary) with value pattern analysis (dates, currency, integers, text) to produce a confidence score per category.

### Value pattern rules:
| Pattern | Classification | Trigger |
|---------|---------------|---------|
| Excel serial date (30000–80000) | `date` | Number in range |
| DD/MM/YYYY, YYYY-MM-DD, DD.MM.YYYY | `date` | Regex match |
| ₦1,500 / 1200 / 3,450.50 | `price` or `cost` | Regex: `^[₦$€£¥]?\s*-?[\d,]+(\.\d{1,2})?\s*$` |
| 1 / 5 / 100 (small integer) | `quantity` | Integer between 0–100000 |
| Paracetamol / Augmentin (text with letters) | `product` | Text, not currency, not date |

### Confidence scoring:
```
conf = headerScore × weight + valueScore × (1 − weight)
```
- Header weight: 0.6 (if strong match) or 0.4 (weak)
- Final confidence: 0–1

---

## 3. Column Mapping

**Why:** Two columns can both claim "price." Only one should win — the other is likely "cost." Confidence tiers determine whether user review is needed.

**What:** Global confidence-sorted assignment. Each category assigned at most once. Highest-confidence candidate wins.

### Confidence tiers:
| Score | Tier | Action |
|-------|------|--------|
| > 90% | `auto` | Silent auto-map |
| 70–90% | `review` | Auto-map, flag for review |
| < 70% | `confirm` | Require user selection |

### Cost/Price disambiguation:
If a column header contains "cost" but was detected as "price," the system checks for an explicit "cost" detection instead.

---

## 4a. Empty Row Removal

**Why:** Spreadsheets often contain blank separator rows or trailing empty rows from export formatting.

**What:** Rows where every column value is null, undefined, or empty string are removed.

| Before | After |
|--------|-------|
| `[null, null, null]` | (removed) |

### Impact: Revenue unchanged. These rows have no data.

---

## 4b. Duplicate Header Removal

**Why:** Some pharmacy software repeats column headers mid-sheet (e.g., page breaks).

**What:** If 80%+ of a row's non-empty values match a column header name, the row is treated as a duplicate header and removed.

| Before | After |
|--------|-------|
| `["Drug", "Qty", "Price"]` (repeated header) | (removed) |

### Impact: Revenue unchanged. Headers contain no transaction data.

---

## 4c. Excel Serial Date Conversion

**Why:** Excel stores dates as serial numbers (days since 1899-12-30). Raw numbers like `45785` are meaningless in analytics.

**What:** Converts serial numbers in range [30000, 80000] to ISO date strings (YYYY-MM-DD). Uses the Excel 1900 date system with Lotus 1-2-3 leap-year bug compensation.

| Before | After |
|--------|-------|
| `45801` | `2025-05-24` |

### Impact: Enables correct monthly aggregation and time-series charts.

---

## 4d. Date String Parsing

**Why:** Nigerian pharmacy exports use multiple date formats: DD/MM/YYYY (UK), YYYY-MM-DD (ISO), DD.MM.YYYY (European), YYYY-MM (month-level).

**What:** Detects and normalizes all supported formats to YYYY-MM-DD. DD/MM vs MM/DD ambiguity resolved via Nigerian convention (DD/MM).

| Before | After |
|--------|-------|
| `15/01/2026` | `2026-01-15` |
| `2026-07` | `2026-07-01` |
| `01.03.2026` | `2026-03-01` |

### Impact: Correct month grouping for revenue charts.

---

## 4e. Text Trimming

**Why:** Pharmacy software often pads fields with whitespace.

**What:** Leading and trailing whitespace stripped from all string values.

| Before | After |
|--------|-------|
| `"  Paracetamol  "` | `"Paracetamol"` |

### Impact: Enables correct product name matching and deduplication.

---

## 4f. Product Name Normalization

**Why:** The same medicine appears under many names across different POS systems:
- "PARACETAMOL 500MG TAB" (uppercase, abbreviated form)
- "paracetamol 500mg" (lowercase, no form)  
- "PCM 500" (brand abbreviation)
- "Paracetamol 500mg Tablet" (proper case, full form)

Without normalization, analytics shows 4 separate products instead of 1.

**What (7-step process):**

| Step | Action | Example |
|------|--------|---------|
| 1 | Lowercase | `PARACETAMOL 500MG TAB` → `paracetamol 500mg tab` |
| 2 | Expand abbreviations | `tab` → `tablet`, `cap` → `capsule`, `susp` → `suspension` |
| 3 | Brand mapping | `pcm 500` → `paracetamol 500mg` |
| 4 | Standardize dosage | `500MG` → `500mg`, `500 mg` → `500mg` |
| 5 | Strip form suffixes | `500mg tablet` → `500mg` |
| 6 | Title case (preserve dosage) | `500mg` stays `500mg` |
| 7 | Collapse whitespace | final cleanup |

| Before | After |
|--------|-------|
| `PARACETAMOL 500MG TAB` | `Paracetamol 500mg` |
| `paracetamol 500mg` | `Paracetamol 500mg` |
| `PCM 500` | `Paracetamol 500mg` |
| `Ampiclox 500MG CAP` | `Ampiclox 500mg` |

### Impact: Revenue aggregation is correct. Without this, 3 paracetamol variants become 3 separate products in the top-products chart, obscuring the true bestseller.

---

## 4g. Payment Method Normalization

**Why:** POS systems log payment types inconsistently: "CASH", "Cash Payment", "cash" are all the same method but would show as separate categories.

**What:** Maps variants to 5 canonical types.

| Raw Input | Normalized |
|-----------|------------|
| `CASH`, `Cash Payment`, `cash` | `Cash` |
| `TRF`, `Bank Transfer`, `Online Transfer` | `Transfer` |
| `POS`, `POS Terminal`, `Card Payment`, `Debit Card` | `POS` |
| `NHIS`, `HMO`, `Insurance` | `Insurance` |
| `Credit Account` | `Credit` |

---

## 5. Field Normalization (Raw Headers → Canonical Fields)

**Why:** The analytics engine must never know about raw Excel column names. "Selling Price," "Retail Amount," and "SP" must all arrive as `price`.

**What:** Uses the resolved column mapping to extract values from raw-header columns into canonical fields: `product`, `quantity`, `price`, `cost`, `date`, `payment_method`.

| Raw Key | Canonical Field | Example |
|---------|----------------|---------|
| `Selling Price (₦)` | `price` | `₦1,500` → `1500` |
| `Qty Sold` | `quantity` | `3` → `3` |
| `Medicine Name` | `product` | `Paracetamol` → `Paracetamol` |
| `Cost Price` | `cost` | `₦850` → `850` |
| `Sale Date` | `date` | `2024-01-15` → `2024-01-15` |
| `Payment` | `payment_method` | `CASH` → `Cash` |

**Currency conversion:** `₦1,500` → `1500` (strips ₦ and commas, converts to number)

**Quantity conversion:** String → integer (`"3"` → `3`). Comma-separated: `"1,200"` → `1200`.

**Quantity default:** If quantity is null but price exists → assume `qty = 1` (single unit sale).

---

## 6. Missing Value Filling

**Why:** Some fields may be null after normalization. The analytics engine needs concrete values.

**What:**

| Field | Fallback | Rationale |
|-------|----------|-----------|
| `product` | `"Unknown"` | Preserves the transaction in counts; visible in top-products as "Unknown" |
| `quantity` | `1` | Single-unit sale is the most common case for retail pharmacy |
| `price` | (unchanged) | Revenue cannot be guessed |
| `date` | (unchanged) | Cannot impute chronologically |
| `payment_method` | (unchanged) | Unknown payment type is valid |

---

## 7. Transaction Deduplication

**Why:** Users re-upload the same spreadsheet to "refresh" data. Without dedup, every upload doubles the counts. Even within a single file, some POS systems duplicate line items.

**What:** Duplicate hash = `product|quantity|price|date`. First occurrence kept; subsequent matches dropped. The dedup runs AFTER all normalization (so variants of the same product with different raw names are still correctly identified as duplicates).

| Record A | Record B | Duplicate? |
|----------|----------|------------|
| Paracetamol, 2, ₦200, 2024-01-15 | Paracetamol, 2, ₦200, 2024-01-15 | YES |
| Paracetamol, 1, ₦200, 2024-01-15 | Paracetamol, 2, ₦200, 2024-01-15 | NO (different qty) |
| Paracetamol, 2, ₦200, 2024-01-15 | Paracetamol, 2, ₦200, 2024-01-16 | NO (different date) |

### Impact: Revenue unchanged (legitimate duplicates represent the same transaction, not new revenue).

---

## 8. Star Schema Persistence

**Why:** In-memory processing loses data between requests. A dimensional model enables historical queries, branch comparisons, and product lifecycle analysis.

**What:** Normalized records are inserted into a SQLite star schema:

```
FactSales ──┬── DimProduct (drug names, auto-classified categories)
            ├── DimCalendar (auto-generated from min/max dates in data)
            ├── DimBranch   (pharmacy locations)
            ├── DimEmployee (dispensing staff)
            └── DimCustomer (walk-in, HMO, corporate)
```

All dimensions use upsert logic (INSERT OR IGNORE) with natural_key deduplication. The calendar is auto-generated from the date range of uploaded data.

| Dimension | Natural Key | Auto-classified? |
|-----------|-------------|-----------------|
| DimProduct | Lowercase normalized name | Categories: Analgesic, NSAID, Antibiotic, Antimalarial, etc. |
| DimBranch | `pharmacyId::branchName` | No |
| DimCalendar | `YYYY-MM-DD` date string | Yes (year, quarter, month, week, is_weekend) |
| DimEmployee | Name | No |
| DimCustomer | Name | No |

---

## Summary: What Gets Removed and Why

| Transformation | Items removed | Revenue impact |
|----------------|---------------|----------------|
| Empty row removal | Blank rows | None (no data) |
| Duplicate header removal | Repeated column names | None (not transactions) |
| Deduplication | Identical (product, qty, price, date) rows | None (same transaction) |

**Guarantee:** No legitimate transaction data is ever silently dropped. The validation endpoint (`/api/validate`) produces a before/after comparison report to confirm this for every upload.
