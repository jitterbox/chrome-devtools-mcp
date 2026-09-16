/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';

import {zod as z} from '../third_party/index.js';
import type {ElementHandle, Page, Protocol} from '../third_party/index.js';
import type {
  CssPropertyMap,
  LegacyStyleSnapshotMap,
  NamedStyleSnapshot,
  StyleSnapshotData,
  StyleSnapshotElement,
  StyleSnapshotMeta,
} from '../types.js';

import {ToolCategory} from './categories.js';
import {
  definePageTool,
  type Context,
  type Response,
  type StyleInspection,
} from './ToolDefinition.js';

interface BorderRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface StyleSnapshotFile {
  schemaVersion: number;
  name?: string;
  meta: StyleSnapshotMeta;
  elements: Record<string, StyleSnapshotElement>;
}

const GEOMETRY_EPS_PX = 0.5;

const filePathSchema = z
  .string()
  .optional()
  .describe(
    'Absolute or cwd-relative path to read/write a JSON styles snapshot file.',
  );

function isCssPropertyMap(value: unknown): value is CssPropertyMap {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Object.values(value).every(entry => typeof entry === 'string');
}

function isStyleSnapshotMeta(value: unknown): value is StyleSnapshotMeta {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value;
  return (
    'capturedAt' in record &&
    typeof record.capturedAt === 'string' &&
    'url' in record &&
    typeof record.url === 'string' &&
    'viewportWidth' in record &&
    typeof record.viewportWidth === 'number' &&
    'viewportHeight' in record &&
    typeof record.viewportHeight === 'number' &&
    'dpr' in record &&
    typeof record.dpr === 'number'
  );
}

function isStyleSnapshotElement(value: unknown): value is StyleSnapshotElement {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value;
  if (!('computed' in record) || !isCssPropertyMap(record.computed)) {
    return false;
  }
  return true;
}

function isStyleSnapshotElements(
  value: unknown,
): value is Record<string, StyleSnapshotElement> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Object.values(value).every(entry => isStyleSnapshotElement(entry));
}

function isStyleSnapshotFile(value: unknown): value is StyleSnapshotFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value;
  return (
    'schemaVersion' in record &&
    typeof record.schemaVersion === 'number' &&
    'meta' in record &&
    isStyleSnapshotMeta(record.meta) &&
    'elements' in record &&
    isStyleSnapshotElements(record.elements)
  );
}

function isLegacySnapshotMap(value: unknown): value is LegacyStyleSnapshotMap {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Object.values(value).every(entry => isCssPropertyMap(entry));
}

function isV1SnapshotData(value: unknown): value is StyleSnapshotData {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value;
  return (
    'meta' in record &&
    isStyleSnapshotMeta(record.meta) &&
    'elements' in record &&
    isStyleSnapshotElements(record.elements)
  );
}

function parseStyleSnapshotJson(text: string): NamedStyleSnapshot {
  const parsed: unknown = JSON.parse(text);
  if (isStyleSnapshotFile(parsed)) {
    return {meta: parsed.meta, elements: parsed.elements};
  }
  if (isV1SnapshotData(parsed)) {
    return parsed;
  }
  if (isLegacySnapshotMap(parsed)) {
    return parsed;
  }
  throw new Error('Invalid styles snapshot file format');
}

async function writeStyleSnapshotFile(
  context: Context,
  filePath: string,
  name: string | undefined,
  data: StyleSnapshotData,
): Promise<string> {
  const payload: StyleSnapshotFile = {
    schemaVersion: 1,
    name,
    meta: data.meta,
    elements: data.elements,
  };
  const encoded = new TextEncoder().encode(
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  const saved = await context.saveFile(encoded, filePath, '.json');
  return saved.filename;
}

async function readStyleSnapshotFile(
  filePath: string,
): Promise<NamedStyleSnapshot> {
  const text = await fs.readFile(filePath, 'utf8');
  return parseStyleSnapshotJson(text);
}

async function resolveBaselineSnapshot(
  context: Context,
  name: string | undefined,
  baselineFilePath: string | undefined,
): Promise<NamedStyleSnapshot> {
  if (baselineFilePath) {
    return readStyleSnapshotFile(baselineFilePath);
  }
  if (!name) {
    throw new Error('Provide either name or baselineFilePath');
  }
  const snapshot = context.getStyleSnapshot(name);
  if (!snapshot) {
    throw new Error('No snapshot found with the provided name');
  }
  return snapshot;
}

function assertSaveTarget(name?: string, filePath?: string): void {
  if (!name && !filePath) {
    throw new Error('Provide at least one of name or filePath');
  }
}

function assertDiffBaseline(name?: string, baselineFilePath?: string): void {
  if (!name && !baselineFilePath) {
    throw new Error('Provide at least one of name or baselineFilePath');
  }
}

function isV1Snapshot(s: NamedStyleSnapshot): s is StyleSnapshotData {
  return (
    typeof s === 'object' &&
    s !== null &&
    'meta' in s &&
    'elements' in s &&
    isStyleSnapshotElements(s.elements)
  );
}

function snapshotElements(
  raw: NamedStyleSnapshot,
): Record<string, StyleSnapshotElement> {
  if (isV1Snapshot(raw)) {
    return raw.elements;
  }
  const out: Record<string, StyleSnapshotElement> = {};
  for (const [uid, computed] of Object.entries(raw)) {
    out[uid] = {computed};
  }
  return out;
}

function snapshotMeta(raw: NamedStyleSnapshot): StyleSnapshotMeta | undefined {
  return isV1Snapshot(raw) ? raw.meta : undefined;
}

function rectFromQuad(quad: Protocol.DOM.Quad): BorderRect | undefined {
  if (quad.length < 8) {
    return undefined;
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  if (
    xs.some(value => !Number.isFinite(value)) ||
    ys.some(value => !Number.isFinite(value))
  ) {
    return undefined;
  }
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function borderRectsMatch(
  a?: BorderRect,
  b?: BorderRect,
  eps = GEOMETRY_EPS_PX,
) {
  if (!a || !b) {
    return !a && !b;
  }
  return (
    Math.abs(a.left - b.left) <= eps &&
    Math.abs(a.top - b.top) <= eps &&
    Math.abs(a.width - b.width) <= eps &&
    Math.abs(a.height - b.height) <= eps
  );
}

function isLayoutProperty(p: string): boolean {
  const x = p.toLowerCase();
  return (
    x.includes('width') ||
    x.includes('height') ||
    x.includes('margin') ||
    x.includes('padding') ||
    x.includes('border') ||
    x === 'display' ||
    x === 'position' ||
    x.includes('flex') ||
    x.includes('grid') ||
    x.includes('gap') ||
    x === 'transform' ||
    x === 'top' ||
    x === 'left' ||
    x === 'right' ||
    x === 'bottom' ||
    x.includes('inset')
  );
}

function classifyStyleDiff(
  styleChanges: Array<{property: string}>,
  geometryEqual: boolean | undefined,
): {
  changeClass: 'none' | 'cascadeOnly' | 'layoutEffective' | 'paintLikely';
  effectiveLayoutChange: boolean;
} {
  if (styleChanges.length === 0) {
    if (geometryEqual === undefined) {
      return {changeClass: 'none', effectiveLayoutChange: false};
    }
    const layoutShift = geometryEqual === false;
    return {
      changeClass: layoutShift ? 'layoutEffective' : 'none',
      effectiveLayoutChange: layoutShift,
    };
  }
  if (geometryEqual === false) {
    return {changeClass: 'layoutEffective', effectiveLayoutChange: true};
  }
  const touchedLayout = styleChanges.some(c => isLayoutProperty(c.property));
  if (geometryEqual === true && touchedLayout) {
    return {changeClass: 'cascadeOnly', effectiveLayoutChange: false};
  }
  if (geometryEqual === undefined && touchedLayout) {
    return {changeClass: 'layoutEffective', effectiveLayoutChange: false};
  }
  if (touchedLayout) {
    return {changeClass: 'layoutEffective', effectiveLayoutChange: true};
  }
  return {changeClass: 'paintLikely', effectiveLayoutChange: false};
}

async function domPathForHandle(handle: ElementHandle<Element>) {
  return handle.evaluate((el: Element) => {
    const parts: string[] = [];
    let current: Element | null = el;
    const stopAt = document.documentElement.parentElement;
    while (current && current !== stopAt) {
      const tag = current.tagName.toLowerCase();
      const par: Element | null = current.parentElement;
      let idx = 1;
      if (par) {
        for (const c of par.children) {
          if (c.tagName === current.tagName) {
            if (c === current) {
              break;
            }
            idx++;
          }
        }
      }
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      current = par;
    }
    return parts.join(' > ');
  });
}

function mapToRecord(map: Map<string, string>): CssPropertyMap {
  const out: CssPropertyMap = {};
  for (const [name, value] of map) {
    out[name] = value;
  }
  return out;
}

function filterMap(
  map: CssPropertyMap,
  properties?: string[] | undefined,
): CssPropertyMap {
  if (!properties?.length) {
    return map;
  }
  const out: CssPropertyMap = {};
  for (const key of properties) {
    if (key in map) {
      out[key] = map[key];
    }
  }
  return out;
}

function resolveSnapshotElement(
  elements: Record<string, StyleSnapshotElement>,
  uid: string,
  domPath?: string,
): StyleSnapshotElement | undefined {
  const direct = elements[uid];
  if (direct) {
    return direct;
  }
  if (!domPath?.length) {
    return undefined;
  }
  for (const el of Object.values(elements)) {
    if (el.domPath === domPath) {
      return el;
    }
  }
  return undefined;
}

function appendJson(response: Response, title: string, value: unknown): void {
  response.appendResponseLine(title);
  response.appendResponseLine('```json');
  response.appendResponseLine(JSON.stringify(value));
  response.appendResponseLine('```');
}

function styleChangesBetween(
  before: CssPropertyMap,
  after: CssPropertyMap,
): Array<{property: string; before: string; after: string}> {
  const changed: Array<{property: string; before: string; after: string}> = [];
  const seen = new Set<string>();
  for (const key of Object.keys(before)) {
    seen.add(key);
    if (before[key] !== after[key]) {
      changed.push({
        property: key,
        before: before[key],
        after: after[key] ?? '',
      });
    }
  }
  for (const key of Object.keys(after)) {
    if (seen.has(key)) {
      continue;
    }
    changed.push({
      property: key,
      before: '',
      after: after[key],
    });
  }
  return changed;
}

function pickSources(
  sources: NonNullable<StyleInspection['sources']>,
  keys: string[],
): NonNullable<StyleInspection['sources']> {
  const out: NonNullable<StyleInspection['sources']> = {};
  for (const key of keys) {
    if (key in sources) {
      out[key] = sources[key];
    }
  }
  return out;
}

function computedFromInspection(
  inspection: StyleInspection | undefined,
  properties?: string[],
): CssPropertyMap {
  return filterMap(mapToRecord(inspection?.computed ?? new Map()), properties);
}

async function devicePixelRatio(page: Page): Promise<number> {
  const dpr = page.viewport()?.deviceScaleFactor;
  if (dpr !== undefined && dpr > 0) {
    return dpr;
  }
  const evaluated = await page.evaluate(() => window.devicePixelRatio);
  return Number(evaluated) || 1;
}

function roundedRect(rect: BorderRect, dpr: number): BorderRect {
  const round = (value: number) => Math.round(value * dpr);
  return {
    left: round(rect.left),
    top: round(rect.top),
    right: round(rect.right),
    bottom: round(rect.bottom),
    width: round(rect.width),
    height: round(rect.height),
  };
}

export const getComputedStyles = definePageTool({
  name: 'get_computed_styles',
  description:
    'Resolved computed styles for one uid; optional property filter and ' +
    'cascade-accurate winning declarations (includeSources). Prefer over ' +
    'scraping styles in evaluate_script.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    uid: z
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
    properties: z.array(z.string()).optional().describe('Optional filter list'),
    includeSources: z
      .boolean()
      .optional()
      .describe(
        'If true, include cascade-accurate winning declaration origins',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const inspections = await request.page.getStyleInspectionForUids(
      [request.params.uid],
      request.params.includeSources ? {sources: true} : undefined,
    );
    const computed = computedFromInspection(
      inspections.get(request.params.uid),
      request.params.properties,
    );
    const result: {
      computed: CssPropertyMap;
      sourceMap?: Record<string, unknown>;
    } = {computed};

    const sources = inspections.get(request.params.uid)?.sources;
    if (request.params.includeSources && sources) {
      result.sourceMap = pickSources(sources, Object.keys(computed));
    }

    appendJson(response, 'Computed styles:', result);
  },
});

export const getBoxModel = definePageTool({
  name: 'get_box_model',
  description:
    'CDP box model quads and rects for layout misalignment, overflow, and ' +
    'offset debugging.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    uid: z
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const model = await request.page.getBoxModelForUid(request.params.uid);
    if (!model) {
      throw new Error(
        `Could not retrieve box model for element with uid "${request.params.uid}".`,
      );
    }

    const contentRect = rectFromQuad(model.content);
    const paddingRect = rectFromQuad(model.padding);
    const borderRect = rectFromQuad(model.border);
    const marginRect = rectFromQuad(model.margin);
    const clientRect = paddingRect;
    const boundingRect = borderRect;
    const dpr = await devicePixelRatio(request.page.pptrPage);
    const roundIfPresent = (rect?: BorderRect) =>
      rect ? roundedRect(rect, dpr) : undefined;

    appendJson(response, 'Box model:', {
      width: model.width,
      height: model.height,
      contentQuad: model.content,
      paddingQuad: model.padding,
      borderQuad: model.border,
      marginQuad: model.margin,
      contentRect,
      paddingRect,
      borderRect,
      marginRect,
      clientRect,
      boundingRect,
      devicePixelRounded: {
        contentRect: roundIfPresent(contentRect),
        paddingRect: roundIfPresent(paddingRect),
        borderRect: roundIfPresent(borderRect),
        marginRect: roundIfPresent(marginRect),
        clientRect: roundIfPresent(clientRect),
        boundingRect: roundIfPresent(boundingRect),
      },
    });
  },
});

export const getVisibility = definePageTool({
  name: 'get_visibility',
  description:
    'Explain why an element is invisible (display, opacity, zero size, ' +
    'off-viewport, clip-path).',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    uid: z
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const inspections = await request.page.getStyleInspectionForUids(
      [request.params.uid],
      {box: true},
    );
    const inspection = inspections.get(request.params.uid);
    const style = computedFromInspection(inspection);
    const boxModel = inspection?.box;
    const reasons: string[] = [];

    if (style['display'] === 'none') {
      reasons.push('display:none');
    }
    if (
      style['visibility'] === 'hidden' ||
      style['visibility'] === 'collapse'
    ) {
      reasons.push(`visibility:${style['visibility']}`);
    }
    if (Number.parseFloat(style['opacity'] ?? '1') === 0) {
      reasons.push('opacity:0');
    }

    if (boxModel) {
      if (boxModel.width === 0 || boxModel.height === 0) {
        reasons.push('zero-size');
      }
      const handle = await request.page.getElementByUid(request.params.uid);
      try {
        const intersecting = await handle.isIntersectingViewport();
        if (!intersecting) {
          reasons.push('off-viewport');
        }
      } catch {
        // Ignore viewport intersection errors.
      } finally {
        await handle.dispose();
      }
    }

    if ((style['clip-path'] ?? 'none') !== 'none') {
      reasons.push('clip-path');
    }

    appendJson(response, 'Visibility:', {
      isVisible: reasons.length === 0,
      reasons,
    });
  },
});

export const getComputedStylesBatch = definePageTool({
  name: 'get_computed_styles_batch',
  description:
    'Batch computed styles map keyed by uid—use for design tokens or ' +
    'multi-node parity checks.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    uids: z
      .array(z.string())
      .describe(
        'The uids of elements on the page from the page content snapshot',
      ),
    properties: z.array(z.string()).optional().describe('Optional filter list'),
  },
  blockedByDialog: true,
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const inspections = await request.page.getStyleInspectionForUids(
      request.params.uids,
    );
    const results: Record<string, CssPropertyMap> = {};
    for (const uid of request.params.uids) {
      results[uid] = computedFromInspection(
        inspections.get(uid),
        request.params.properties,
      );
    }
    appendJson(response, 'Computed styles (batch):', results);
  },
});

export const diffComputedStyles = definePageTool({
  name: 'diff_computed_styles',
  description:
    'Side-by-side style diff for two uids on the same page; optional ' +
    'geometry compare for layout-affecting changes.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    uidA: z.string().describe('First element uid'),
    uidB: z.string().describe('Second element uid'),
    properties: z.array(z.string()).optional().describe('Optional filter list'),
    compareGeometry: z
      .boolean()
      .optional()
      .describe(
        'If true, compare border-box geometry and classify effective layout change.',
      ),
  },
  blockedByDialog: true,
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const inspections = await request.page.getStyleInspectionForUids(
      [request.params.uidA, request.params.uidB],
      request.params.compareGeometry ? {box: true} : undefined,
    );
    const a = computedFromInspection(
      inspections.get(request.params.uidA),
      request.params.properties,
    );
    const b = computedFromInspection(
      inspections.get(request.params.uidB),
      request.params.properties,
    );
    const changed = styleChangesBetween(a, b);

    let geometryEqual: boolean | undefined;
    let rectA: BorderRect | undefined;
    let rectB: BorderRect | undefined;
    if (request.params.compareGeometry) {
      const boxA = inspections.get(request.params.uidA)?.box;
      const boxB = inspections.get(request.params.uidB)?.box;
      rectA = boxA ? rectFromQuad(boxA.border) : undefined;
      rectB = boxB ? rectFromQuad(boxB.border) : undefined;
      geometryEqual = borderRectsMatch(rectA, rectB);
    }

    const classification = classifyStyleDiff(changed, geometryEqual);
    const out: Record<string, unknown> = {
      styleChanges: changed,
      ...classification,
    };
    if (request.params.compareGeometry) {
      out.geometry = {
        borderRectA: rectA,
        borderRectB: rectB,
        approximatelyEqual: geometryEqual,
      };
    }
    appendJson(response, 'Computed styles diff (A -> B):', out);
  },
});

export const saveComputedStylesSnapshot = definePageTool({
  name: 'save_computed_styles_snapshot',
  description:
    'Store baseline computed styles + domPath/meta under a name and/or ' +
    'write schema v1 JSON to filePath for cross-run regression checks.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    name: z.string().optional().describe('In-memory snapshot name'),
    uids: z
      .array(z.string())
      .describe(
        'The uids of elements on the page from the page content snapshot',
      ),
    properties: z.array(z.string()).optional().describe('Optional filter list'),
    filePath: filePathSchema,
  },
  blockedByDialog: true,
  verifyFilesSchema: {
    filePath: true,
  },
  handler: async (request, response, context) => {
    assertSaveTarget(request.params.name, request.params.filePath);

    const pptr = request.page.pptrPage;
    const [inspections, metrics] = await Promise.all([
      request.page.getStyleInspectionForUids(request.params.uids, {
        box: true,
      }),
      pptr.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio,
      })),
    ]);

    const meta: StyleSnapshotMeta = {
      capturedAt: new Date().toISOString(),
      url: pptr.url(),
      viewportWidth: Number(metrics.w ?? 0),
      viewportHeight: Number(metrics.h ?? 0),
      dpr: Number(pptr.viewport()?.deviceScaleFactor ?? metrics.dpr ?? 1) || 1,
    };

    const captured = await Promise.all(
      request.params.uids.map(async uid => {
        const handle = await request.page.getElementByUid(uid);
        try {
          const inspection = inspections.get(uid);
          const box = inspection?.box;
          const domPath = await domPathForHandle(handle).catch(() => undefined);
          const element: StyleSnapshotElement = {
            computed: computedFromInspection(
              inspection,
              request.params.properties,
            ),
            borderRect: box ? rectFromQuad(box.border) : undefined,
            domPath: domPath || undefined,
            backendNodeId:
              request.page.getAXNodeByUid(uid)?.backendNodeId ??
              inspection?.backendNodeId,
          };
          return [uid, element] as const;
        } finally {
          await handle.dispose();
        }
      }),
    );
    const elements: Record<string, StyleSnapshotElement> = {};
    for (const [uid, element] of captured) {
      elements[uid] = element;
    }

    const data: StyleSnapshotData = {meta, elements};
    if (request.params.name) {
      context.setStyleSnapshot(request.params.name, data);
    }

    let savedFilePath: string | undefined;
    if (request.params.filePath) {
      savedFilePath = await writeStyleSnapshotFile(
        context,
        request.params.filePath,
        request.params.name,
        data,
      );
    }

    const label = request.params.name ?? savedFilePath ?? 'snapshot';
    response.appendResponseLine(
      `Saved styles snapshot "${label}" for ` +
        `${Object.keys(elements).length} elements (schema v1).`,
    );
    if (savedFilePath) {
      response.appendResponseLine(`Snapshot file: ${savedFilePath}`);
    }
    response.appendResponseLine('```json');
    response.appendResponseLine(
      JSON.stringify({
        name: request.params.name,
        schemaVersion: 1,
        meta,
        uids: Object.keys(elements),
        filePath: savedFilePath,
      }),
    );
    response.appendResponseLine('```');
  },
});

export const diffComputedStylesSnapshot = definePageTool({
  name: 'diff_computed_styles_snapshot',
  description:
    'Compare live uid to an in-memory snapshot (name) or JSON baseline ' +
    '(baselineFilePath); domPath when uids differ between loads.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    name: z.string().optional().describe('In-memory snapshot name'),
    baselineFilePath: filePathSchema.describe(
      'JSON baseline from save_computed_styles_snapshot filePath.',
    ),
    uid: z
      .string()
      .describe('Element uid for the live node (from current snapshot)'),
    domPath: z
      .string()
      .optional()
      .describe(
        'If baseline uid differs, match saved element by domPath from v1 snapshot.',
      ),
    properties: z.array(z.string()).optional().describe('Optional filter list'),
    compareGeometry: z
      .boolean()
      .optional()
      .describe('Compare border-box rects to detect effective layout change.'),
  },
  blockedByDialog: true,
  verifyFilesSchema: {
    baselineFilePath: true,
  },
  handler: async (request, response, context) => {
    assertDiffBaseline(request.params.name, request.params.baselineFilePath);

    const snapshot = await resolveBaselineSnapshot(
      context,
      request.params.name,
      request.params.baselineFilePath,
    );
    const elems = snapshotElements(snapshot);
    const baseline = resolveSnapshotElement(
      elems,
      request.params.uid,
      request.params.domPath,
    );
    if (!baseline) {
      throw new Error('No entry for the provided uid/domPath in the snapshot');
    }

    const inspections = await request.page.getStyleInspectionForUids(
      [request.params.uid],
      {box: true},
    );
    const inspection = inspections.get(request.params.uid);
    const current = computedFromInspection(
      inspection,
      request.params.properties,
    );
    const changed = styleChangesBetween(baseline.computed, current);
    const box = inspection?.box;
    const currentRect = box ? rectFromQuad(box.border) : undefined;
    const liveQuad = box?.border ?? null;

    let geometryEqual: boolean | undefined;
    if (request.params.compareGeometry) {
      geometryEqual = borderRectsMatch(baseline.borderRect, currentRect);
    }

    const classification = classifyStyleDiff(changed, geometryEqual);
    const meta = snapshotMeta(snapshot);
    const baselineLabel =
      request.params.baselineFilePath ?? request.params.name ?? 'snapshot';
    const out: Record<string, unknown> = {
      snapshotMeta: meta,
      domPathBaseline: baseline.domPath,
      styleChanges: changed,
      overlay: {borderQuad: liveQuad},
      ...classification,
    };
    if (request.params.compareGeometry) {
      out.geometry = {
        baselineBorderRect: baseline.borderRect,
        currentBorderRect: currentRect,
        approximatelyEqual: geometryEqual,
      };
    }
    appendJson(
      response,
      `Computed styles diff vs snapshot "${baselineLabel}" ` +
        `(snapshot -> current):`,
      out,
    );
  },
});

export const highlightElementsForStyles = definePageTool({
  name: 'highlight_elements_for_styles',
  description:
    'Highlight border quads in DevTools and return coordinates for ' +
    'screenshot overlays or docs.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    uids: z
      .array(z.string())
      .min(1)
      .describe('Element uids from the current page snapshot'),
  },
  blockedByDialog: true,
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const nodes = await request.page.getDomNodesForUids(request.params.uids);
    const regions = await Promise.all(
      request.params.uids.map(async uid => {
        const node = nodes.get(uid);
        if (!node) {
          throw new Error(
            `Element with uid "${uid}" was detached or no longer exists on the page.`,
          );
        }
        const box = await node.boxModel();
        return {uid, node, borderQuad: box?.border ?? null};
      }),
    );
    for (const region of regions) {
      region.node.highlight('all');
    }
    appendJson(response, 'Highlight regions (border quads, layout px):', {
      regions: regions.map(({uid, borderQuad}) => ({uid, borderQuad})),
    });
  },
});
