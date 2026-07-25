# Premium B2B Dashboard Design System

> Design spec for AI developers. Prescriptive on purpose — follow it literally.
> Inspired by Stripe, Linear, and Microsoft. Target aesthetic: clean, calm,
> trustworthy, data-dense but breathable.

## Core Philosophy (read first)

Premium is NOT decorative. It comes from **restraint + consistency + one
confident brand hue**. Non-negotiables:

1. Max **5 colors**, **2 fonts**, **one spacing scale**, **one radius base**.
2. **Never** hardcode hex. **Never** use `text-white` / `bg-black`. Everything
   flows through semantic tokens.
3. Neutrals are **tinted**, not pure gray. Shadows are **tinted**, not black.
4. Whitespace and hierarchy do the heavy lifting — not borders, gradients, or effects.
5. No gradients unless explicitly requested. No emojis as icons. No decorative blobs.

---

## 1. Color — OKLCH, desaturated, tinted neutrals

Use OKLCH (perceptually uniform: equal number changes look equally different).
Formula: **1 low-chroma brand hue + neutrals tinted with a cool hue (~250) + 3
semantic status colors.**

```css
:root {
  /* Surfaces — bg is off-white, cards pure white. That ~1.5% gap = "lift" */
  --background: oklch(0.985 0.002 240);
  --foreground: oklch(0.21 0.02 250);   /* soft ink, never pure black */
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.21 0.02 250);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.21 0.02 250);

  /* Brand — LOW chroma (0.088). Desaturated = enterprise/trustworthy */
  --primary: oklch(0.52 0.088 194);
  --primary-foreground: oklch(0.99 0.005 190);

  /* Neutrals carry a faint cool hue + micro-chroma. The Stripe/Linear secret */
  --secondary: oklch(0.96 0.006 240);
  --secondary-foreground: oklch(0.3 0.02 250);
  --muted: oklch(0.965 0.004 240);
  --muted-foreground: oklch(0.55 0.018 250);   /* secondary text */
  --accent: oklch(0.955 0.015 190);
  --accent-foreground: oklch(0.4 0.06 194);
  --border: oklch(0.92 0.006 250);       /* barely-there hairlines */
  --input: oklch(0.92 0.006 250);
  --ring: oklch(0.52 0.088 194);

  /* Semantic status — same lightness/chroma family so they feel like siblings */
  --success: oklch(0.62 0.13 155);
  --warning: oklch(0.72 0.14 75);
  --destructive: oklch(0.585 0.2 25);

  --radius: 0.7rem;
}
```

**Rules:**
- To rebrand, change **only the hue angle** (third number). Keep lightness/chroma.
- Loud saturation reads "consumer app." Keep brand chroma <= ~0.10.
- Status colors are **semantic only**: green = healthy, amber = warning, red = risk.
  Never use them decoratively.
- If you change any background, you **must** change its paired foreground for
  contrast (WCAG AA minimum).

---

## 2. Typography — weight-driven hierarchy, mono for numbers

**Two fonts max:** one sans for UI (Geist / Inter), one mono reserved for
numbers and metrics.

Hierarchy comes from **weight + color contrast**, not size alone.

| Element         | Classes                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| Card label      | `text-sm font-medium text-muted-foreground`                                |
| KPI value       | `text-2xl md:text-3xl font-semibold tracking-tight text-foreground font-mono` |
| Section heading | `text-lg font-semibold tracking-tight text-balance`                        |
| Body / caption  | `text-sm text-muted-foreground leading-relaxed text-pretty`                |

**Rules:**
- `tracking-tight` on large text/headings; `leading-relaxed` (~1.5) on body.
- `font-mono` + `tabular-nums` on **any value that changes** (money, %, counts)
  so digits don't jitter and columns align.
- The muted-small-label over dark-large-value pairing **is** the KPI-card effect.
  Reuse it everywhere.
- Never below 14px for body. Never decorative fonts for body.

---

## 3. Spacing — one scale, generous, gap-only

- Use the Tailwind scale only: `p-6` cards, `gap-6` sections, `gap-4` tight
  grids. No arbitrary values like `p-[17px]`.
- Create spacing with **`gap`** on flex/grid parents — never `space-y-*`, never
  mixed margin+padding on one element.
- When unsure, add more whitespace. Cramped = cheap.

---

## 4. Elevation — whisper-soft, tinted shadows

```css
/* tint the shadow with your foreground hue, never pure black */
--shadow-card: 0 1px 2px oklch(0.2 0.02 250 / 0.04),
               0 1px 3px oklch(0.2 0.02 250 / 0.06);
```

Cards rely mostly on **white-on-off-white contrast + a 1px `border-border`**.
Shadow is a whisper, layered in two low-opacity steps. No hard drop shadows,
no glows.

---

## 5. Radius — one base, everything derives

```css
--radius: 0.7rem;
--radius-sm: calc(var(--radius) * 0.6);
--radius-lg: var(--radius);
--radius-xl: calc(var(--radius) * 1.4);
```

Consistent rounding across cards, buttons, inputs, and badges = cohesion.

---

## 6. Token -> utility bridge

### Tailwind v4 (no config file)

Define tokens in `:root`, then register them so semantic utilities exist:

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-border: var(--border);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-destructive: var(--destructive);
  /* ...map every token */
}
```

### Tailwind v3 (tailwind.config.js)

```js
// theme.extend.colors
colors: {
  background: "var(--background)",
  foreground: "var(--foreground)",
  card: { DEFAULT: "var(--card)", foreground: "var(--card-foreground)" },
  primary: { DEFAULT: "var(--primary)", foreground: "var(--primary-foreground)" },
  muted: { DEFAULT: "var(--muted)", foreground: "var(--muted-foreground)" },
  accent: { DEFAULT: "var(--accent)", foreground: "var(--accent-foreground)" },
  border: "var(--border)",
  success: "var(--success)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
}
```

Components then use **only** `bg-card`, `text-muted-foreground`,
`border-border`, `text-success` — zero raw color.

---

## 7. Component recipes

**Card**
```
bg-card text-card-foreground border border-border rounded-xl p-6 shadow-[var(--shadow-card)]
```

**KPI card** — label (muted, sm, medium) -> value (foreground, 2xl/3xl,
semibold, mono, tracking-tight) -> delta chip (`text-success` / `text-destructive`
with a small arrow icon, `text-xs font-medium`).

**Status badge** — tinted surface, not solid fill: `bg-success/10 text-success`.
Soft, not loud.

**Icons** — one library (e.g. lucide), fixed sizes `16 / 20 / 24`, `1.5` stroke.
Never emojis as icons.

**Layout** — flexbox first; CSS grid only for 2D card grids
(`grid gap-6 md:grid-cols-2 xl:grid-cols-4`). Mobile-first, enhance upward with
responsive prefixes.

---

## 8. One-paragraph brief (paste at top of any prompt)

> Build with OKLCH: one low-chroma brand hue, neutrals tinted with a cool ~250
> hue (never pure gray), and three semantic status colors — 5 colors max. Two
> fonts max, monospace for all numbers. Hierarchy from weight + muted/foreground
> contrast, not size. One spacing scale applied generously with `gap` only. One
> radius base. Whisper-soft two-layer shadows tinted with the foreground hue on
> white cards over an off-white background. All styling flows through semantic
> tokens — never hardcode hex.

---

## 9. Checklist before shipping any screen

- [ ] 5 colors or fewer, all via tokens (no raw hex, no `text-white`/`bg-black`)
- [ ] Neutrals and shadows are tinted, not pure gray/black
- [ ] 2 fonts max; all numbers use mono + `tabular-nums`
- [ ] Hierarchy reads via weight + color, not size alone
- [ ] Spacing uses `gap` on one consistent scale; no `space-y-*`
- [ ] Cards: white surface, 1px border, whisper shadow, `p-6`, consistent radius
- [ ] Status colors used semantically only (green/amber/red)
- [ ] Layout is mobile-first and responsive; flexbox-first
- [ ] Every changed background has a matching foreground (WCAG AA)
