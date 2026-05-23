# Wiser Resources — CLAUDE.md

## Project Overview

**Wiser Resources** is a static HTML site deployed on Vercel. It publishes free finance tools, calculators, and educational guides tied to the *Wiser With Vidhaan* content brand. Every page is a standalone HTML file; there is no build step, no bundler, and no framework at the project level.

The site also exposes two Vercel serverless functions in `/api/` that provide live Indian market data (Nifty P/E, price, 200-DMA, India VIX) to the front-end tools, bypassing browser CORS restrictions.

---

## Repository Structure

```
/
├── vercel.json                  # Clean-URL rewrites (slug → /public/slug.html)
├── api/
│   ├── pe.js                    # Serverless: Nifty 50 P/E (4-layer fallback, 3h cache)
│   └── market.js                # Serverless: Nifty price + 200-DMA + India VIX (15min cache)
├── public/
│   ├── index.html               # Home page — card grid linking all tools/guides
│   ├── investor-dna.html        # Quiz → investor persona + allocation blueprint
│   ├── compounding-machine.html # SIP compounding calculator with milestone timeline
│   ├── fire-calculator.html     # FIRE number / freedom-date calculator
│   ├── delay-engine.html        # Cost-of-delay calculator (two wealth curves)
│   ├── smart-sip-allocator.html # Live market-driven SIP equity/liquid split
│   ├── sip-flat-returns.html    # Educational guide: "zero returns" historical case
│   ├── one-tap-email-automation.html  # Guide: iPhone Shortcut + Claude + Gmail MCP
│   ├── system1-system2-decision-framework.html  # Guide: System 1 vs System 2
│   ├── anthropic-finance-agents.html  # Guide: Anthropic finance agent templates
│   ├── child-wealth-playbook.html     # Guide: ₹10K/month wealth strategy for kids
│   ├── ai-stock-research-toolkit.html # Guide: AI workflows for stock research
│   └── bcomm-free-skills.html         # Older guide (not linked from index)
├── bcomm-free-skills.html       # Root-level duplicate (pre-`public/` migration)
├── google-apps-script-leads.js  # Apps Script template for Google Sheets lead capture
└── wisermoney and finance tools/
    └── PortfolioFitQuiz.jsx     # React component (standalone, not used in prod)
```

---

## Pages Inventory

| Slug | WR # | Type | Description |
|------|-------|------|-------------|
| `/` | — | Hub | Home page, card grid |
| `/investor-dna` | — | Calculator | 5-question risk-profile quiz → allocation blueprint |
| `/compounding-machine` | — | Calculator | SIP + lump-sum growth with milestone timeline |
| `/fire-calculator` | — | Calculator | FIRE corpus + coast FIRE + survival chart |
| `/delay-engine` | — | Calculator | Rupee cost of starting late |
| `/smart-sip-allocator` | — | Calculator (live) | Market-zone-aware SIP allocation |
| `/sip-flat-returns` | WR-003 | Guide | Historical flat-market SIP case study |
| `/one-tap-email-automation` | WR-001 | Guide | AI email automation with iPhone Shortcut |
| `/system1-system2-decision-framework` | WR-002 | Guide | Thinking-fast-and-slow decision heuristic |
| `/anthropic-finance-agents` | WR-005 | Guide | Anthropic finance agent templates overview |
| `/child-wealth-playbook` | WR-006 | Guide | SSY/PPF/NPS Vatsalya/index SIP for kids |
| `/ai-stock-research-toolkit` | WR-004 | Guide | AI-driven stock research workflows |

New resources follow the **WR-NNN** numbering sequence. The next number is **WR-007**.

---

## Design System

All calculator/tool pages share a single dark theme. Guide pages may use a custom palette — see **Conventions** below.

### Color Tokens (CSS custom properties)

```css
--bg:          #060b0f   /* page background */
--surface:     #0a0d14
--card:        #0c1019
--card-hover:  #0f1420
--gold:        #F5C842   /* primary accent — numbers, CTAs, highlights */
--gold-soft:   #F9DC7A
--gold-pale:   rgba(245,200,66,0.07)
--gold-border: rgba(245,200,66,0.2)
--teal:        #00D9A0   /* secondary accent — AI/guide badges, data live badges */
--teal-pale:   rgba(0,217,160,0.07)
--teal-border: rgba(0,217,160,0.18)
--text:        #EDE9E3
--text-soft:   rgba(237,233,227,0.62)
--text-muted:  rgba(237,233,227,0.3)
--border:      rgba(255,255,255,0.065)
--border-mid:  rgba(255,255,255,0.1)
```

Some pages also use `--red: #FF4757` for negative/cost messaging (delay-engine).

### Typography

| Token | Font | Usage |
|-------|------|-------|
| `--serif` | DM Serif Display | Hero headings, card titles, large numbers |
| `--sans` | Plus Jakarta Sans | Body text, labels, descriptions |
| `--mono` | DM Mono | Badges, tags, metadata, eyebrows |

`Space Mono` appears in smart-sip-allocator for technical/live data labels.

All fonts load from Google Fonts CDN via `<link>` preconnect in `<head>`.

### Card Pattern

Calculator cards share a consistent structure:
- Dark background + 1px `var(--border)` border + 18px border-radius
- Hover: `var(--gold-border)` border + lift (`translateY(-5px)`) + top glow via `::before`
- Teal variant (`.teal-card`) uses teal glow instead
- Scroll-reveal: cards start `opacity:0; transform:translateY(28px)` and transition to `.visible` via IntersectionObserver

### Badge Pattern

```html
<div class="card-badge badge-gold">Calculator · SIP</div>   <!-- gold accent -->
<div class="card-badge badge-teal">AI & Automation</div>    <!-- teal accent -->
```

---

## Serverless API Endpoints

### `GET /api/pe` — Nifty 50 P/E Ratio

- **Cache:** `s-maxage=10800` (3 hours), `stale-while-revalidate=3600`
- **CORS:** open (`*`)
- **Response:** `{ pe, source, live, estimated? }`
- **Fallback chain:**
  1. niftyindices CDN blob (no auth)
  2. NSE `allIndices` API (session cookie)
  3. Yahoo Finance `quoteSummary` (trailingPE)
  4. EPS estimate: Nifty price ÷ `TRAILING_EPS` constant
  5. Hardcoded `HARDCODED` object (always succeeds)

**Maintenance constants in `api/pe.js`:**
- `TRAILING_EPS` — update quarterly after results season closes (FY26 Q4 value: `1072`)
- `HARDCODED.pe` — update when Nifty moves >8% from last-recorded value (last verified May 2026, `21.5`)

### `GET /api/market` — Nifty Price + 200-DMA + India VIX

- **Cache:** `s-maxage=900` (15 minutes), `stale-while-revalidate=300`
- **CORS:** open (`*`)
- **Response:** `{ niftyPrice, dma200, vix, live, source, fetchedAt }`
- **Sources:** Yahoo Finance `v8/finance/chart` for `%5ENSEI` (1y) and `%5EINDIAVIX` (5d), with `query1`/`query2` failover
- **Fallback constant in `api/market.js`:** `FALLBACK` object — update when Nifty moves >8% (last verified May 2026: price `24500`, dma200 `23800`, vix `14.2`)

---

## Lead Capture

Two pages capture leads and POST to a Google Apps Script webhook:

- `investor-dna.html` — collects name, email, phone, persona, allocation scores
- `smart-sip-allocator.html` — collects email, name

**Webhook URL** (live, do not change without updating both HTML files):
```
https://script.google.com/macros/s/AKfycbxYoHR1iCFIwOM8l6Rfz6n2jKc3JwCojhnuhs58Bw3kL3iQudiDp_DKz0BczSRA0nQ/exec
```

The Apps Script source is in `google-apps-script-leads.js`. It writes to a Google Sheet tab named `Leads` with columns: Timestamp, Source, Name, Email, Phone, Persona, Equity %, Debt %, Gold %, Quiz Score.

---

## Deployment

- **Platform:** Vercel (static + serverless)
- **Routing:** `vercel.json` maps clean slugs (e.g. `/fire-calculator`) to `public/fire-calculator.html`
- **API routes:** `/api/*.js` are auto-detected as Vercel serverless functions (Node.js)
- **No build command** — Vercel serves `public/` as static files directly

When adding a new page:
1. Create `public/your-slug.html`
2. Add a rewrite entry to `vercel.json`: `{ "source": "/your-slug", "destination": "/your-slug.html" }`
3. Add a card to `public/index.html` in the appropriate grid section

---

## Conventions

### New Calculator Pages
- Use the shared dark gold/teal CSS token palette above
- Include all three Google Fonts (`DM Mono`, `DM Serif Display`, `Plus Jakarta Sans`)
- No external JS dependencies beyond React 18 CDN (if needed): `https://unpkg.com/react@18/umd/react.production.min.js` + Babel standalone
- All computation is client-side; no backend required for pure calculators
- Use IntersectionObserver scroll-reveal pattern for result cards (`.card` → `.visible`)

### New Guide Pages (WR-NNN)
- Guides may use custom themes (e.g. orange for `sip-flat-returns`, teal for newer guides)
- Add `<span class="card-wr">WR-NNN</span>` badge in the index card
- Assign the next WR number in sequence

### API Maintenance
- After each quarterly earnings season, update `TRAILING_EPS` in `api/pe.js`
- If Nifty moves >8% from the `HARDCODED` / `FALLBACK` values, update them before merging to main

### React Usage
- React is loaded via CDN only (no npm, no bundler)
- Babel standalone (`@babel/standalone`) transpiles JSX in `<script type="text/babel">` tags
- The `wisermoney and finance tools/PortfolioFitQuiz.jsx` file is a standalone component not currently deployed here

### Git Workflow
- Feature branches merged via PR into `main`
- Commit messages: `feat: ...` / `fix: ...` / `chore: ...`
- No CI/CD pipeline — Vercel auto-deploys on push to `main`
