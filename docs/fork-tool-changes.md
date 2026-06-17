# Fork Tool Changes (vs upstream Chrome DevTools MCP)

Audience: developers and AI agents using **this fork** (`jitterbox/chrome-devtools-mcp`).

Scope: **tool-level changes only** — new MCP tools, how they work, and what
supporting context they rely on. Does not cover CLI, build, telemetry, or other
repo changes.

**Branch:** `feat-computed-css` (not merged to `main` as of this writing).

**Upstream baseline:** `ChromeDevTools/chrome-devtools-mcp` `main`.

---

## Summary

This fork adds **8 new Debugging tools** for computed CSS, box model geometry,
visibility diagnosis, batch queries, diffs, named baselines, and DevTools
highlights. They live in a new module:

- `src/tools/styles.ts` — registered in `src/tools/tools.ts`

All new tools:

- Target elements by **`uid`** from [`take_snapshot`](tool-reference.md#take_snapshot)
- Are **`readOnlyHint: true`** (Debugging category)
- Are **not** included in **slim mode** (`--slim`)
- Use Chrome DevTools Protocol (CDP) via Puppeteer internals

---

## Prerequisites for agents

1. **Always snapshot first.** Call `take_snapshot`, then use `uid` values from
   that response. Re-snapshot after DOM changes; uids are not stable across
   navigations or re-renders.
2. **Prefer these tools over `evaluate_script` for styles.** They return
   structured JSON from `CSS.getComputedStyleForNode` / `DOM.getBoxModel`
   instead of scraping `getComputedStyle` in page JS.
3. **Use property filters.** Pass `properties: ["color", "display", …]` to
   shrink payloads when checking specific tokens or layout rules.
4. **Named snapshots are in-memory per MCP session.** `save_computed_styles_snapshot`
   stores baselines in a `WeakMap` keyed by MCP context — they do not survive
   server restarts.

---

## New tools

### `get_computed_styles`

Resolved computed styles for one element.

| Parameter | Required | Notes |
|-----------|----------|-------|
| `uid` | yes | From latest `take_snapshot` |
| `properties` | no | Whitelist of CSS property names |
| `includeSources` | no | Best-effort winning rule origins per property |

**Response shape:**

```json
{
  "computed": { "display": "block", "color": "rgb(0, 0, 255)" },
  "sourceMap": {
    "display": {
      "source": "inline",
      "selector": null,
      "origin": null,
      "styleSheetId": null,
      "range": null
    }
  }
}
```

`sourceMap` is omitted unless `includeSources: true`. Origins are matched from
`CSS.getMatchedStylesForNode` (inline, attributes, matched rules).

---

### `get_box_model`

CDP box model quads and derived rectangles for layout debugging.

| Parameter | Required |
|-----------|----------|
| `uid` | yes |

**Response includes:**

- Raw quads: `contentQuad`, `paddingQuad`, `borderQuad`, `marginQuad`
- Derived rects: `contentRect`, `paddingRect`, `borderRect`, `marginRect`,
  `clientRect` (≈ content + padding), `boundingRect` (≈ border box)
- `width` / `height` from CDP model
- `devicePixelRounded` — same rects rounded by `window.devicePixelRatio`

Use for misalignment, overflow, and offset checks without hand-rolling
`getBoundingClientRect` in `evaluate_script`.

---

### `get_visibility`

Explains why an element may not be visible.

| Parameter | Required |
|-----------|----------|
| `uid` | yes |

**Response shape:**

```json
{
  "isVisible": false,
  "reasons": ["display:none", "off-viewport"]
}
```

**Possible `reasons` values:**

| Reason | Trigger |
|--------|---------|
| `display:none` | Computed `display` is `none` |
| `visibility:hidden` | `visibility` is `hidden` or `collapse` |
| `opacity:0` | Parsed opacity is 0 |
| `zero-size` | Box model width or height is 0 |
| `off-viewport` | Border quad does not intersect layout viewport |
| `clip-path` | Computed `clip-path` is not `none` |

`isVisible` is `true` only when `reasons` is empty.

---

### `get_computed_styles_batch`

Batch computed styles for many elements in one call.

| Parameter | Required | Notes |
|-----------|----------|-------|
| `uids` | yes | Array of snapshot uids |
| `properties` | no | Applied to every element |

**Response:** JSON object keyed by `uid` → `CssPropertyMap`.

Use for design-token parity checks across multiple nodes (nav items, cards,
form fields) without N separate `get_computed_styles` calls.

---

### `diff_computed_styles`

Side-by-side computed-style diff for two elements on the **same page**.

| Parameter | Required | Notes |
|-----------|----------|-------|
| `uidA` | yes | First element |
| `uidB` | yes | Second element |
| `properties` | no | Filter diff to these properties |
| `compareGeometry` | no | Also compare border-box rects |

**Response fields:**

| Field | Meaning |
|-------|---------|
| `styleChanges` | `{ property, before, after }[]` — values from A → B |
| `changeClass` | Classification (see below) |
| `effectiveLayoutChange` | Whether layout likely changed |
| `geometry` | Present when `compareGeometry: true` — border rects + `approximatelyEqual` |

**`changeClass` values:**

| Value | Meaning |
|-------|---------|
| `none` | No style changes (and no geometry shift, if compared) |
| `cascadeOnly` | Layout-related properties changed but border geometry unchanged |
| `layoutEffective` | Geometry changed or layout properties changed without geometry proof |
| `paintLikely` | Non-layout properties changed (color, background, etc.) |

---

### `save_computed_styles_snapshot`

Store a named baseline and/or write schema v1 JSON to disk for cross-run
regression checks.

| Parameter | Required | Notes |
|-----------|----------|-------|
| `name` | no* | In-memory name within this MCP session |
| `filePath` | no* | Write full snapshot JSON to this path |
| `uids` | yes | Elements to capture |
| `properties` | no | Filter stored computed values |

\* At least one of `name` or `filePath` is required.

**On-disk JSON format:**

```json
{
  "schemaVersion": 1,
  "name": "optional-label",
  "meta": { "capturedAt": "...", "url": "...", "viewportWidth": 1280, "viewportHeight": 720, "dpr": 1 },
  "elements": {
    "1_1": {
      "computed": { "display": "block" },
      "borderRect": { "left": 0, "top": 0, "right": 10, "bottom": 10, "width": 10, "height": 10 },
      "domPath": "div:nth-of-type(1) > div:nth-of-type(1)",
      "backendNodeId": 42
    }
  }
}
```

Legacy flat snapshots (uid → computed map only) are still readable from file.

---

### `diff_computed_styles_snapshot`

Compare a **live** element against an in-memory snapshot or a JSON baseline file.

| Parameter | Required | Notes |
|-----------|----------|-------|
| `name` | no* | In-memory snapshot from `save_computed_styles_snapshot` |
| `baselineFilePath` | no* | JSON file from `save_computed_styles_snapshot` `filePath` |
| `uid` | yes | Live element uid |
| `domPath` | no | Match baseline by path when uid changed after reload |
| `properties` | no | Filter diff |
| `compareGeometry` | no | Compare border rects |

\* At least one of `name` or `baselineFilePath` is required. `baselineFilePath`
takes precedence for loading the baseline (no in-memory store needed).

**Response fields:**

- `snapshotMeta` — baseline capture metadata
- `domPathBaseline` — path stored at capture time
- `styleChanges` — `{ property, before, after }[]` (snapshot → current)
- `changeClass`, `effectiveLayoutChange` — same semantics as `diff_computed_styles`
- `overlay.borderQuad` — live border quad for screenshot overlays
- `geometry` — when `compareGeometry: true`

**Re-matching logic:** looks up baseline by `uid` first, then by `domPath` if
provided and uid miss.

---

### `highlight_elements_for_styles`

Highlight elements in DevTools and return border quads for overlays.

| Parameter | Required |
|-----------|----------|
| `uids` | yes (min 1) |

Calls `Overlay.enable` + `Overlay.highlightQuad` per element. Returns:

```json
{
  "regions": [
    { "uid": "1_3", "borderQuad": [x1, y1, x2, y2, …] }
  ]
}
```

Quads are 8 numbers (4 x/y pairs) in layout pixels. Pair with
`take_screenshot` for visual regression docs.

---

## Supporting infrastructure (not tools, but required)

These `McpContext` methods were added so style tools can resolve CDP node ids:

| Method | Purpose |
|--------|---------|
| `ensureCssDomainEnabledForPage(page)` | `CSS.enable` once per page |
| `ensureDomDomainEnabledForPage(page)` | `DOM.enable` + shallow `DOM.getDocument` |
| `getNodeIdFromHandle(handle, page)` | `DOM.requestNode` / `DOM.describeNode` fallback |

Exposed on the `Context` type in `src/tools/ToolDefinition.ts`.

**CDP methods used:**

- `CSS.getComputedStyleForNode`
- `CSS.getMatchedStylesForNode` (optional, `includeSources`)
- `DOM.getBoxModel`
- `DOM.describeNode`
- `DOM.requestNode`
- `Overlay.enable` / `Overlay.highlightQuad`
- `Page.getLayoutMetrics` (visibility)
- `Runtime.evaluate` (viewport / DPR)

---

## Recommended agent workflows

### Inspect a single element's layout

```
take_snapshot → get_computed_styles(uid, properties?) → get_box_model(uid)
```

Add `get_visibility(uid)` if the element should be visible but is not.

### Compare two components on the same page

```
take_snapshot → diff_computed_styles(uidA, uidB, compareGeometry: true)
```

Read `changeClass` to decide if you need a screenshot or further DOM inspection.

### Regression after code or navigation change

```
# baseline (golden file for CI)
take_snapshot → save_computed_styles_snapshot(filePath, uids, properties?)

# after change
take_snapshot → diff_computed_styles_snapshot(baselineFilePath, uid, compareGeometry: true)
```

In-memory variant (same MCP session only):

```
take_snapshot → save_computed_styles_snapshot(name, uids)
→ navigate / reload → take_snapshot
→ diff_computed_styles_snapshot(name, uid, domPath?, compareGeometry: true)
```

Use `domPath` when uids differ after reload but the element is the same node in
the tree.

### Token audit across a list

```
take_snapshot → get_computed_styles_batch(uids, properties: ["font-size", "color", …])
```

### Visual confirmation

```
take_snapshot → highlight_elements_for_styles(uids) → take_screenshot
```

---

## Existing tools: description-only updates

The fork also rewrites **tool descriptions** (no handler/schema changes) across
existing modules so agents pick the right tool faster — e.g. `click` now says to
prefer snapshot `uid` over guessing selectors; `take_snapshot` stresses using
the latest snapshot after DOM changes.

Affected modules: `console`, `emulation`, `extensions`, `input`, `lighthouse`,
`memory`, `network`, `pages`, `performance`, `screencast`, `screenshot`,
`script`, `snapshot`, `slim/tools`, and generated `docs/tool-reference.md`.

If you need exact upstream-vs-fork description text, diff
`upstream/main...feat-computed-css` on those files.

---

## Quick reference

| Tool | Use when |
|------|----------|
| `get_computed_styles` | One element's resolved CSS (+ optional rule origins) |
| `get_box_model` | Quads/rects for layout misalignment |
| `get_visibility` | Element missing from view — why? |
| `get_computed_styles_batch` | Many elements, same property subset |
| `diff_computed_styles` | Two live elements differ? |
| `save_computed_styles_snapshot` | Capture baseline before a change |
| `diff_computed_styles_snapshot` | Live state vs saved baseline |
| `highlight_elements_for_styles` | DevTools highlight + quad coords |

**Debugging category tool count:** upstream 6 → fork 14 (+8).
