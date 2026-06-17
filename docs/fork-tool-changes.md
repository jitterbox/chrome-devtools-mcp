# Fork Tool Changes (vs upstream Chrome DevTools MCP)

Audience: developers and AI agents using **this fork** (`jitterbox/chrome-devtools-mcp`).

Scope: **tool-level changes only** — new MCP tools, how they work, file-based
golden snapshots, and what supporting context they rely on. Does not cover CLI,
build, telemetry, or other repo changes.

**Status:** merged to this fork's `main` (not upstream).

**Upstream baseline:** `ChromeDevTools/chrome-devtools-mcp` `main`.

**Fork-only:** do not open PRs against upstream with these changes unless you
intend to contribute them there separately.

---

## Summary

This fork adds **8 new Debugging tools** for computed CSS, box model geometry,
visibility diagnosis, batch queries, diffs, named baselines, DevTools
highlights, and **file-based JSON golden snapshots**. They live in:

- `src/tools/styles.ts` — registered in `src/tools/tools.ts`

All new tools:

- Target elements by **`uid`** from [`take_snapshot`](tool-reference.md#take_snapshot)
- Use Chrome DevTools Protocol (CDP) via Puppeteer internals
- Are **not** included in **slim mode** (`--slim`)

**Read-only hints:** seven tools are `readOnlyHint: true`. `save_computed_styles_snapshot`
is `readOnlyHint: false` because it can write JSON to `filePath`.

**Debugging category tool count:** upstream 6 → fork 14 (+8).

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
4. **Choose the right persistence layer:**
   - **In-memory** (`name` on save) — same MCP session only; stored in a
     server-side `WeakMap`, not in the browser and not in `localStorage`.
   - **On disk** (`filePath` / `baselineFilePath`) — golden files for CI,
     cross-run before/after, and hundreds of E2E tests (see below).

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

\* At least one of `name` or `baselineFilePath` is required. When
`baselineFilePath` is set, the baseline is loaded from disk — no prior in-memory
`save` in the same session is required.

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

## Large-scale before/after E2E (hundreds of tests, file-based JSON)

Use **on-disk golden files** when you have many E2E scenarios and need to
compare a **before** build against an **after** build across separate CI runs,
branches, or refactors. Nothing is stored in browser `localStorage` — baselines
live as JSON files on the test runner filesystem (or in git).

### Why file-based for scale

| Approach | Good for | Limitation |
|----------|----------|------------|
| In-memory `name` | Same MCP session, quick navigate/reload | Lost when MCP server exits |
| `filePath` / `baselineFilePath` | Hundreds of tests, CI golden files, before/after across runs | You manage directory layout |
| `diff_computed_styles` (live A vs B) | Two elements on one page, one session | No cross-run persistence |

For hundreds of tests, **commit or archive a `before/` tree of JSON files**, run
the suite on the **after** build, and diff each test's live state against its
matching baseline file.

### Recommended directory layout

```text
tests/
  fixtures/
    style-snapshots/
      before/                    # captured from baseline branch / build
        login-form.json
        dashboard-header.json
        settings-panel.json
      after/                     # optional: capture after for offline compare
        login-form.json
      manifest.json              # optional: testId → uids/domPaths/properties
```

Each golden file is the schema v1 output written by `save_computed_styles_snapshot`
with `filePath`. One file per test (or per page region) keeps failures isolated
and diffs small.

### Per-test element manifest (optional but useful at scale)

Store stable selectors alongside snapshot files so scripts do not hard-code uids
(which change every `take_snapshot`):

```json
{
  "login-form": {
    "url": "/login",
    "waitFor": ["Sign in"],
    "elements": {
      "submitButton": { "snapshotIncludes": "button \"Sign in\"" },
      "emailInput": { "snapshotIncludes": "textbox \"Email\"" }
    },
    "properties": ["color", "font-size", "display", "width", "height"]
  }
}
```

Your harness resolves `snapshotIncludes` → `uid` from `take_snapshot` text,
then passes those uids to save/diff tools. Use `domPath` from the saved baseline
when uids differ after reload (included automatically in v1 snapshots).

### Phase 1 — capture "before" snapshots (baseline build)

Run once on the known-good branch. One MCP client per test (or per batch) keeps
memory flat.

```text
for each test in manifest:
  connect MCP client
  navigate_page(url)
  wait_for(text)
  take_snapshot
  resolve uids from snapshot text
  save_computed_styles_snapshot({
    filePath: "tests/fixtures/style-snapshots/before/{testId}.json",
    uids: [...],
    properties: [...]   # keep small — only assert-on properties
  })
  close MCP client
```

Commit `before/*.json` to git (or upload as a CI artifact) as the regression
baseline.

**Tips for hundreds of captures:**

- Always pass `properties` — unfiltered computed maps are large (100–300+ keys per
  element). Asserting on 5–20 properties per element keeps files small.
- Use one snapshot file per test, not one giant file for the whole suite.
- Include `compareGeometry: true` at diff time; you do not need separate box-model
  files because v1 snapshots already store `borderRect` and `domPath`.

### Phase 2 — run "after" build and diff against baselines

On the candidate build, replay the same navigation steps, then diff each element
against its baseline file. **No in-memory save required.**

```text
for each test in manifest:
  connect MCP client
  navigate_page(url)
  wait_for(text)
  take_snapshot
  resolve live uids

  for each element in test.elements:
    diff_computed_styles_snapshot({
      baselineFilePath: "tests/fixtures/style-snapshots/before/{testId}.json",
      uid: liveUid,
      domPath: baseline.domPath,        # when uid changed after reload
      properties: test.properties,
      compareGeometry: true
    })
    assert styleChanges is empty OR changeClass is acceptable

  close MCP client
```

Parse the ` ```json ` block in each tool response (see `tests/e2e.styles.test.ts`
`extractJson`). Fail the test when `styleChanges` is non-empty or when
`effectiveLayoutChange` is true and your test disallows layout drift.

### Phase 2 alternative — capture "after" files, diff offline

If you prefer not to call diff tools hundreds of times in one CI job:

1. **After pass:** same as Phase 1 but write to `after/{testId}.json`.
2. **Compare in Node:** load `before` and `after` JSON and diff `elements[*].computed`
   (and optionally `borderRect`) in your test runner.

Use MCP `diff_computed_styles_snapshot` when you want the built-in
`changeClass` / `effectiveLayoutChange` classification and live `overlay.borderQuad`
for debugging. Use offline JSON diff for bulk reporting or custom tolerances.

### Example harness sketch (Node + MCP SDK)

```javascript
// Pseudocode — adapt to your E2E runner
async function captureBaseline(testId, spec) {
  await withMcpClient(async client => {
    await call(client, 'navigate_page', { url: spec.url });
    await call(client, 'wait_for', { text: spec.waitFor });
    const snap = await call(client, 'take_snapshot', {});
    const uids = resolveUids(snap, spec.elements);
    await call(client, 'save_computed_styles_snapshot', {
      filePath: `tests/fixtures/style-snapshots/before/${testId}.json`,
      uids: Object.values(uids),
      properties: spec.properties,
    });
  });
}

async function assertAgainstBaseline(testId, spec) {
  await withMcpClient(async client => {
    await call(client, 'navigate_page', { url: spec.url });
    await call(client, 'wait_for', { text: spec.waitFor });
    const snap = await call(client, 'take_snapshot', {});
    const uids = resolveUids(snap, spec.elements);
    const baseline = JSON.parse(
      await readFile(`tests/fixtures/style-snapshots/before/${testId}.json`, 'utf8'),
    );

    for (const [key, liveUid] of Object.entries(uids)) {
      const domPath = baseline.elements[liveUid]?.domPath
        ?? findDomPathByManifestKey(baseline, key);
      const diff = await call(client, 'diff_computed_styles_snapshot', {
        baselineFilePath: `tests/fixtures/style-snapshots/before/${testId}.json`,
        uid: liveUid,
        domPath,
        properties: spec.properties,
        compareGeometry: true,
      });
      const result = extractJson(diff);
      if (result.styleChanges?.length) {
        throw new Error(`${testId}/${key}: ${JSON.stringify(result.styleChanges)}`);
      }
    }
  });
}
```

See `scripts/run-e2e-styles.js` and `tests/e2e.styles.test.ts` for working MCP
client patterns against this fork.

### Operational notes at scale

- **One MCP client per test** — avoids accumulating in-memory named snapshots and
  keeps Chrome/MCP memory predictable across hundreds of runs.
- **Parallel workers** — safe: each worker writes/reads distinct `filePath` values;
  no shared browser storage involved.
- **Updating baselines** — re-run Phase 1 on the new good build and replace
  `before/*.json` (or bump a manifest version).
- **Flaky geometry** — use `properties` without layout keys first; enable
  `compareGeometry` only where pixel layout is part of the contract.
- **Viewport consistency** — v1 `meta` records viewport and DPR; consider asserting
  `meta.viewportWidth` / `meta.dpr` match before comparing styles.

---

## Quick reference

| Tool | Use when |
|------|----------|
| `get_computed_styles` | One element's resolved CSS (+ optional rule origins) |
| `get_box_model` | Quads/rects for layout misalignment |
| `get_visibility` | Element missing from view — why? |
| `get_computed_styles_batch` | Many elements, same property subset |
| `diff_computed_styles` | Two live elements differ? |
| `save_computed_styles_snapshot` | Capture baseline (`name` and/or `filePath`) |
| `diff_computed_styles_snapshot` | Live state vs in-memory or `baselineFilePath` |
| `highlight_elements_for_styles` | DevTools highlight + quad coords |

### Files added on this fork (vs upstream)

| Path | Role |
|------|------|
| `src/tools/styles.ts` | All 8 tools + file I/O helpers |
| `src/McpContext.ts` | CDP CSS/DOM/node-id helpers |
| `src/tools/tools.ts` | Registers `stylesTools` |
| `tests/tools/styles.test.ts` | Unit tests incl. file save/diff |
| `tests/e2e.styles.test.ts` | End-to-end MCP flow |
| `scripts/run-e2e-styles.js` | Manual E2E styles harness |
| `docs/fork-tool-changes.md` | This document |
