# Astroid Design System

Institutional-grade crypto and AI algorithmic trading platform design specification and component guidelines.

---

## 1. Core Philosophy & Design Principles

Astroid is serious algorithmic trading infrastructure. The visual direction is modeled after professional trading terminals and quantitative execution tools rather than consumer SaaS or generic "crypto marketing" websites.

### Key Visual Attributes
* **Institutional & Technical**: Dense, precise, high-utility financial interfaces.
* **Warm Metallic Charcoal**: A distinctive palette combining deep charcoal, dark navy, and warm amber/gold.
* **Restrained**: Every visual element must have an explicit operational purpose.
* **Fail-Closed Clarity**: High contrast, unambiguous execution and risk indicators.

### Anti-Patterns Checklist
* **NO** generic crypto aesthetics (no rainbow gradients, neon purple glows, or floating 3D spheres).
* **NO** stock photography or AI-generated human/hologram illustrations.
* **NO** cartoon illustrations or mascots in trading UI.
* **NO** oversized soft-SaaS cards (avoid 24–32px radii; prefer 6–12px).
* **NO** excessive glassmorphism, heavy blur backdrops, or floating pill containers.
* **NO** gratuitous animations (all transitions must communicate system state within 150–250ms).
* **NO** mixing of icon libraries or styles.
* **NO** mock fallbacks or fake transaction strings in operational paths.

---

## 2. Color System & Design Tokens

Astroid employs a **warm amber and dark charcoal** token system. 

> [!IMPORTANT]
> **Semantic Separation:**
> Warm Amber (`#DEA34F`) is the **Astroid brand accent** (used for AI intelligence, primary actions, active navigation, and terminal controls).
> Green (`#00E676`) is strictly reserved for **financial profit and active operational states**.
> Red (`#FF2A4B`) is strictly reserved for **financial loss, error, and liquidation risk**.

### Color Tokens

| Role | Name | Hex | Usage |
| :--- | :--- | :--- | :--- |
| **Main Background** | Deep Charcoal | `#1A1B1E` | Root application background, canvas backdrop |
| **Surface / Card** | Charcoal Gray | `#262729` | Trading cards, panels, modules, toolbars |
| **Secondary Surface** | Dark Gray | `#2D2B2B` | Elevated panels, hover states, input containers |
| **Border / Divider** | Charcoal Border | `#3A393B` | 1px component borders, grid dividers, splitters |
| **Primary Accent** | Warm Amber | `#DEA34F` | Astroid brand mark, primary CTAs, active states, AI highlights |
| **Bright Accent** | Light Gold | `#E6BF85` | Accent highlights, secondary active indicator, focus rings |
| **Strong Accent** | Deep Amber | `#EB9100` | Progress fills, high-confidence AI badges, pressed buttons |
| **Data / Slider Track**| Dark Navy | `#192939` | Range slider tracks, unspent allocation bars, chart grid lines |
| **Icon Container** | Amber Slate | `#4B4032` | Background surface for primary amber icons |
| **Primary Text** | Off-White | `#FCFCFC` | Headings, primary metrics, active values |
| **Secondary Text** | Muted Slate | `#9A9DA5` | Table headers, secondary descriptions, metadata |
| **Muted Text** | Dim Slate | `#6F7279` | Inactive controls, timestamps, subtle labels |
| **Semantic Success** | Emerald Green | `#00E676` | Positive PnL (`+$1,420`), executed orders, healthy bot status |
| **Semantic Loss** | Muted Crimson | `#FF2A4B` | Negative PnL (`-1.42%`), failed tx, stop-loss trigger |
| **Semantic Warning**| Amber Gold | `#F59E0B` | Slippage warnings, network congestion alerts |
| **Semantic Info** | Terminal Blue | `#38BDF8` | Informational tooltips, external links |

### CSS Variables Mapping (`web/src/styles/index.css`)
```css
:root {
  --bg-main: #1A1B1E;
  --bg-sidebar: #1A1B1E;
  --border-sidebar: #3A393B;
  --bg-card: #262729;
  --border-card: #3A393B;
  --bg-input: #1A1B1E;
  --bg-hover: #2D2B2B;
  --divider-color: #3A393B;
  --badge-bg: #4B4032;

  --text-title: #FCFCFC;
  --text-main: #FCFCFC;
  --text-muted: #9A9DA5;
  --text-dim: #6F7279;

  --color-primary: #DEA34F;
  --color-primary-bright: #E6BF85;
  --color-primary-strong: #EB9100;
  --color-icon-surface: #4B4032;
  --color-data-track: #192939;

  --color-success: #00E676;
  --color-danger: #FF2A4B;
  --color-warning: #F59E0B;
}
```

---

## 3. Typography Hierarchy

Astroid uses a two-tier typographic structure:
1. **Geometric / Clean Sans-Serif** (`Geist` or `Inter`) for UI copy, labels, and navigation.
2. **Tabular Monospace** (`Geist Mono` or `JetBrains Mono`) for all financial prices, PnL values, order book depths, percentages, and hashes.

```
Hero Display:        64–96px   Weight: 600 / 700   Tracking: -0.03em
Section Headings:    40–56px   Weight: 600 / 700   Tracking: -0.02em
Card / Modal Titles: 16–20px   Weight: 600         Tracking: -0.01em
Body Text:           14–16px   Weight: 400 / 500   Leading: 1.5
Table / Metadata:    11–13px   Weight: 500 / 600   Tracking: 0.05em (Uppercase)
Financial Numbers:   Font: Monospace (tabular-nums), Weight: 600 / 700
```

---

## 4. Iconography Standards

* **Icon Library**: `lucide-react` strictly. Do not import other libraries or mix outline with solid icons.
* **Sizing**:
  * Dense UI / Table Actions: `16px` (stroke 1.5)
  * Standard Controls & Nav: `18px` (stroke 1.75)
  * Prominent / Feature Badges: `20px`–`24px` (stroke 1.75)
* **Visual Hierarchy**:
  1. **Primary Action / AI**: Icon `#DEA34F` inside `#4B4032` container (radius `10px–12px`).
  2. **Active State**: Icon `#DEA34F` directly on surface.
  3. **Utility / Neutral Control**: Icon `#9A9DA5` inside `#2D2B2B` container.
  4. **Financial Signal**: `#00E676` for buy/positive, `#FF2A4B` for sell/negative.

---

## 5. Astroid Component Vocabulary

Components are organized into strict functional domains:

```text
web/src/components/
├── Brand/
│   ├── AstroidMark.tsx          # Technical vector orbital mark
│   ├── AstroidBadge.tsx         # Protocol status & version pill
│   └── AstroidOrbital.tsx       # AI signal animation container
│
├── Trading/
│   ├── PriceDisplay.tsx         # Monospace tabular price with tick delta
│   ├── PnLDisplay.tsx           # Semantic green/red profit/loss indicator
│   ├── MarketBadge.tsx          # Pair symbol + network pill
│   ├── SignalBadge.tsx          # Quant buy/sell confidence signal
│   ├── TradeStatus.tsx          # Pending / Executed / Cancelled chip
│   └── RiskIndicator.tsx        # Drawdown & slippage guard display
│
├── AI/
│   ├── AIIndicator.tsx          # Real-time neural execution status
│   ├── AIConfidence.tsx         # Probability meter (e.g. 91% confidence)
│   ├── AISignal.tsx             # Natural language parsed strategy trigger
│   └── AIProcessing.tsx         # Subtle sub-second computation pulse
│
├── Data/
│   ├── Metric.tsx               # Institutional KPI block (label + monospace value)
│   ├── MetricChange.tsx         # 24H delta badge with arrow
│   ├── Sparkline.tsx            # Minimalist inline trendline
│   ├── MiniChart.tsx            # Compact Lightweight-Charts wrapper
│   └── DataTable.tsx            # High-density, sortable trading table
│
├── Controls/
│   ├── AstroidToggle.tsx        # Amber thumb on dark navy track
│   ├── AstroidSlider.tsx        # Navy track with warm amber fill
│   ├── AstroidSelect.tsx        # Compact keyboard-navigable dropdown
│   ├── IconButton.tsx           # 3-tier container icon control
│   └── SegmentedControl.tsx     # High-density tab/timeframe switcher
│
└── Feedback/
    ├── StatusDot.tsx            # Small pulsating live connection dot
    ├── LiveIndicator.tsx        # "● LIVE" metadata badge
    ├── Toast.tsx                # Terminal execution confirmation notification
    └── EmptyState.tsx           # Zero-data state with technical action prompt
```

---

## 6. Financial Tables & Data Density

* **Density**: Moderate-to-high. Avoid large empty padding; maximize readable information.
* **Alignment Rules**:
  * Numerical data (Price, 24H %, Volume, Size): **Right-aligned** using `font-mono`.
  * Text identifiers (Pair, Strategy, Chain): **Left-aligned**.
  * Status chips: **Center-aligned**.
* **Table Dividers**: 1px `#3A393B` borders with hover highlight `#2D2B2B`.

Example Table Layout:
```text
PAIR        PRICE (USDC)      24H CHANGE      24H VOLUME        STATUS
BTC/USDC     $112,420.50          +2.41%          $2.48B        ● ACTIVE
ETH/USDC       $4,281.20          +1.82%          $1.14B        ● ACTIVE
SOL/USDC         $241.05          -0.43%         $842.1M        ● MONITORING
```

---

## 7. Status Indicators & Micro-UI

Use consistent micro-badges:
* **LIVE**: Small emerald dot `●` + uppercase `LIVE` text (`font-mono text-[11px]`).
* **EXECUTED**: Emerald check `✓` + `EXECUTED` (`text-[#00E676]`).
* **AI SIGNAL**: Amber container `#4B4032` + `AI CONFIDENCE 92%`.
* **RISK**: Bordered badge `#3A393B` + `LOW RISK` (`text-[#9A9DA5]`).

---

## 8. Spacing, Elevation & Borders

* **Base Unit**: 4px grid (`4`, `8`, `12`, `16`, `24`, `32`, `48`, `64`).
* **Corner Radius**:
  * Controls & Badges: `6px`–`8px`
  * Panels & Cards: `10px`–`14px`
  * Modals: `16px`
  * Never exceed `16px`.
* **Elevation**: Rely on surface contrast (`#1A1B1E` vs `#262729` vs `#2D2B2B`) and `1px solid #3A393B` borders instead of drop shadows.

---

## 9. Animation Principles

* **Duration**: `150ms`–`250ms` maximum.
* **Purpose**: State transition feedback only (tab switch, button hover, live order confirmation).
* **Forbidden**: Infinite spinning tokens, glowing background bloat, parallax scrolling effects.
