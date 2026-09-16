/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {
  diffComputedStyles,
  diffComputedStylesSnapshot,
  getBoxModel,
  getComputedStyles,
  getComputedStylesBatch,
  getVisibility,
  highlightElementsForStyles,
  saveComputedStylesSnapshot,
} from '../../src/tools/styles.js';
import type {StyleSnapshotData} from '../../src/types.js';
import {
  createHandlerMocks,
  createMockDOMNode,
  createMockElementHandle,
} from '../mocks.js';

const BOX_QUAD: number[] = [0, 0, 10, 0, 10, 10, 0, 10];
const BOX_MODEL = {
  width: 10,
  height: 10,
  content: BOX_QUAD,
  padding: BOX_QUAD,
  border: BOX_QUAD,
  margin: BOX_QUAD,
};
const SHIFTED_BOX = {
  width: 20,
  height: 20,
  content: [5, 5, 25, 5, 25, 25, 5, 25],
  padding: [5, 5, 25, 5, 25, 25, 5, 25],
  border: [5, 5, 25, 5, 25, 25, 5, 25],
  margin: [5, 5, 25, 5, 25, 25, 5, 25],
};
const ZERO_BOX = {
  width: 0,
  height: 0,
  content: [0, 0, 0, 0, 0, 0, 0, 0],
  padding: [0, 0, 0, 0, 0, 0, 0, 0],
  border: [0, 0, 0, 0, 0, 0, 0, 0],
  margin: [0, 0, 0, 0, 0, 0, 0, 0],
};

function styleResultData(
  response: ReturnType<typeof createHandlerMocks>['response'],
): unknown {
  sinon.assert.calledOnce(response.setStyleResult);
  return response.setStyleResult.firstCall.args[2];
}

function visibleStyles(
  overrides: Record<string, string> = {},
): Map<string, string> {
  return new Map([
    ['display', 'block'],
    ['visibility', 'visible'],
    ['opacity', '1'],
    ['clip-path', 'none'],
    ...Object.entries(overrides),
  ]);
}

function stubInspection(
  page: ReturnType<typeof createHandlerMocks>['page'],
  entries: Array<
    [
      string,
      {
        computed: Map<string, string>;
        box?: typeof BOX_MODEL | typeof ZERO_BOX | typeof SHIFTED_BOX | null;
      },
    ]
  >,
) {
  page.getStyleInspectionForUids.resolves(
    new Map(
      entries.map(([uid, value]) => [
        uid,
        {
          computed: value.computed,
          box: value.box,
          backendNodeId: 9,
        },
      ]),
    ),
  );
}

async function stubSavePage(
  page: ReturnType<typeof createHandlerMocks>['page'],
  options: {
    box?: typeof BOX_MODEL | null;
    axBackendNodeId?: number;
    evaluateRejects?: boolean;
  } = {},
) {
  stubInspection(page, [
    [
      '1_1',
      {
        computed: new Map([['display', 'block']]),
        box: options.box === undefined ? BOX_MODEL : options.box,
      },
    ],
  ]);
  const handle = createMockElementHandle();
  if (options.evaluateRejects) {
    handle.evaluate.rejects(new Error('detached'));
  } else {
    handle.evaluate.resolves('div:nth-of-type(1)');
  }
  page.getElementByUid.resolves(handle);
  if (options.axBackendNodeId !== undefined) {
    page.getAXNodeByUid.returns({
      id: '1_1',
      role: 'generic',
      backendNodeId: options.axBackendNodeId,
      children: [],
      elementHandle: async () => null,
    });
  } else {
    page.getAXNodeByUid.returns(undefined);
  }
  page.pptrPage.url.returns('https://example.test/');
  page.pptrPage.evaluate.resolves({w: 800, h: 600, dpr: 2});
  page.pptrPage.viewport.returns({
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
  });
  return {handle};
}

describe('styles tools', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('get_computed_styles', () => {
    it('filters computed styles and writes JSON', async () => {
      const {page, context, response} = createHandlerMocks();
      stubInspection(page, [
        [
          '1_1',
          {
            computed: new Map([
              ['display', 'block'],
              ['color', 'rgb(0, 0, 255)'],
            ]),
          },
        ],
      ]);

      await getComputedStyles.handler(
        {params: {uid: '1_1', properties: ['display']}, page},
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(
        page.getStyleInspectionForUids,
        ['1_1'],
        undefined,
      );
      sinon.assert.calledOnceWithExactly(
        response.setStyleResult,
        'computedStyles',
        'Computed styles:',
        {uid: '1_1', computed: {display: 'block'}},
      );
    });

    it('includes cascade-accurate sources when requested', async () => {
      const {page, context, response} = createHandlerMocks();
      page.getStyleInspectionForUids.resolves(
        new Map([
          [
            '1_1',
            {
              computed: new Map([['display', 'block']]),
              sources: {display: {source: 'inline', value: 'block'}},
            },
          ],
        ]),
      );

      await getComputedStyles.handler(
        {
          params: {
            uid: '1_1',
            properties: ['display'],
            includeSources: true,
          },
          page,
        },
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(
        page.getStyleInspectionForUids,
        ['1_1'],
        {sources: true},
      );
      sinon.assert.calledOnceWithExactly(
        response.setStyleResult,
        'computedStyles',
        'Computed styles:',
        {
          uid: '1_1',
          computed: {display: 'block'},
          sourceMap: {display: {source: 'inline', value: 'block'}},
        },
      );
    });

    it('returns all computed styles when no property filter is given', async () => {
      const {page, context, response} = createHandlerMocks();
      stubInspection(page, [
        [
          '1_1',
          {
            computed: new Map([
              ['display', 'block'],
              ['color', 'red'],
            ]),
          },
        ],
      ]);

      await getComputedStyles.handler(
        {params: {uid: '1_1'}, page},
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(
        page.getStyleInspectionForUids,
        ['1_1'],
        undefined,
      );
      assert.deepStrictEqual(styleResultData(response), {
        uid: '1_1',
        computed: {display: 'block', color: 'red'},
      });
    });

    it('omits filter keys that are not in the computed map', async () => {
      const {page, context, response} = createHandlerMocks();
      stubInspection(page, [
        ['1_1', {computed: new Map([['display', 'block']])}],
      ]);

      await getComputedStyles.handler(
        {params: {uid: '1_1', properties: ['display', 'missing']}, page},
        response,
        context,
      );

      assert.deepStrictEqual(styleResultData(response), {
        uid: '1_1',
        computed: {display: 'block'},
      });
    });
  });

  describe('get_box_model', () => {
    it('returns quads and rects from the page helper', async () => {
      const {page, context, response} = createHandlerMocks();
      page.getBoxModelForUid.resolves(BOX_MODEL);
      page.pptrPage.viewport.returns({
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
      });

      await getBoxModel.handler(
        {params: {uid: '1_1'}, page},
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(page.getBoxModelForUid, '1_1');
      const parsed = styleResultData(response) as {
        uid: string;
        width: number;
        borderRect: {width: number};
        contentQuad: number[];
      };
      assert.strictEqual(parsed.uid, '1_1');
      assert.strictEqual(parsed.width, 10);
      assert.strictEqual(parsed.borderRect.width, 10);
    });

    it('throws when the box model cannot be retrieved', async () => {
      const {page, context, response} = createHandlerMocks();
      page.getBoxModelForUid.resolves(null);

      await assert.rejects(
        () =>
          getBoxModel.handler({params: {uid: '1_1'}, page}, response, context),
        /Could not retrieve box model for element with uid "1_1"/,
      );
    });

    it('falls back to evaluate when viewport DPR is missing', async () => {
      const {page, context, response} = createHandlerMocks();
      page.getBoxModelForUid.resolves(BOX_MODEL);
      page.pptrPage.viewport.returns(null);
      page.pptrPage.evaluate.resolves(2);

      await getBoxModel.handler(
        {params: {uid: '1_1'}, page},
        response,
        context,
      );

      sinon.assert.calledOnce(page.pptrPage.evaluate);
      const parsed = styleResultData(response) as {
        devicePixelRounded: {borderRect: {width: number}};
      };
      assert.strictEqual(parsed.devicePixelRounded.borderRect.width, 20);
    });

    it('treats a non-positive viewport DPR as missing', async () => {
      const {page, context, response} = createHandlerMocks();
      page.getBoxModelForUid.resolves(BOX_MODEL);
      page.pptrPage.viewport.returns({
        width: 800,
        height: 600,
        deviceScaleFactor: 0,
      });
      page.pptrPage.evaluate.resolves(undefined);

      await getBoxModel.handler(
        {params: {uid: '1_1'}, page},
        response,
        context,
      );

      const parsed = styleResultData(response) as {
        devicePixelRounded: {borderRect: {width: number}};
      };
      assert.strictEqual(parsed.devicePixelRounded.borderRect.width, 10);
    });
  });

  describe('get_visibility', () => {
    it('flags display:none and uses viewport intersection', async () => {
      const {page, context, response} = createHandlerMocks();
      const handle = createMockElementHandle();
      handle.isIntersectingViewport.resolves(true);
      page.getElementByUid.resolves(handle);
      stubInspection(page, [
        [
          '1_1',
          {
            computed: new Map([
              ['display', 'none'],
              ['visibility', 'visible'],
              ['opacity', '1'],
              ['clip-path', 'none'],
            ]),
            box: BOX_MODEL,
          },
        ],
      ]);

      await getVisibility.handler(
        {params: {uid: '1_1'}, page},
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(page.getElementByUid, '1_1');
      sinon.assert.calledOnceWithExactly(
        page.getStyleInspectionForUids,
        ['1_1'],
        {box: true},
      );
      sinon.assert.calledOnce(handle.isIntersectingViewport);
      sinon.assert.calledOnce(handle.dispose);
      sinon.assert.calledOnceWithExactly(
        response.setStyleResult,
        'visibility',
        'Visibility:',
        {
          uid: '1_1',
          isVisible: false,
          reasons: ['display:none'],
        },
      );
    });

    it('reports visibility:hidden, opacity, clip-path, and off-viewport', async () => {
      const {page, context, response} = createHandlerMocks();
      const handle = createMockElementHandle();
      handle.isIntersectingViewport.resolves(false);
      page.getElementByUid.resolves(handle);
      stubInspection(page, [
        [
          '1_1',
          {
            computed: visibleStyles({
              visibility: 'hidden',
              opacity: '0',
              'clip-path': 'circle(50%)',
            }),
            box: BOX_MODEL,
          },
        ],
      ]);

      await getVisibility.handler(
        {params: {uid: '1_1'}, page},
        response,
        context,
      );

      assert.deepStrictEqual(styleResultData(response), {
        uid: '1_1',
        isVisible: false,
        reasons: [
          'visibility:hidden',
          'opacity:0',
          'off-viewport',
          'clip-path',
        ],
      });
    });

    it('treats visibility:collapse as hidden and flags zero-size', async () => {
      const {page, context, response} = createHandlerMocks();
      const handle = createMockElementHandle();
      handle.isIntersectingViewport.resolves(true);
      page.getElementByUid.resolves(handle);
      stubInspection(page, [
        [
          '1_1',
          {
            computed: visibleStyles({visibility: 'collapse'}),
            box: ZERO_BOX,
          },
        ],
      ]);

      await getVisibility.handler(
        {params: {uid: '1_1'}, page},
        response,
        context,
      );

      assert.deepStrictEqual(styleResultData(response), {
        uid: '1_1',
        isVisible: false,
        reasons: ['visibility:collapse', 'zero-size'],
      });
    });

    it('skips viewport checks when box model is missing', async () => {
      const {page, context, response} = createHandlerMocks();
      stubInspection(page, [['1_1', {computed: visibleStyles(), box: null}]]);

      await getVisibility.handler(
        {params: {uid: '1_1'}, page},
        response,
        context,
      );

      sinon.assert.notCalled(page.getElementByUid);
      assert.deepStrictEqual(styleResultData(response), {
        uid: '1_1',
        isVisible: true,
        reasons: [],
      });
    });

    it('ignores isIntersectingViewport failures and still disposes', async () => {
      const {page, context, response} = createHandlerMocks();
      const handle = createMockElementHandle();
      handle.isIntersectingViewport.rejects(new Error('frame detached'));
      page.getElementByUid.resolves(handle);
      stubInspection(page, [
        ['1_1', {computed: visibleStyles(), box: BOX_MODEL}],
      ]);

      await getVisibility.handler(
        {params: {uid: '1_1'}, page},
        response,
        context,
      );

      sinon.assert.calledOnce(handle.dispose);
      assert.deepStrictEqual(styleResultData(response), {
        uid: '1_1',
        isVisible: true,
        reasons: [],
      });
    });
  });

  describe('get_computed_styles_batch', () => {
    it('returns a uid-keyed map from the batch helper', async () => {
      const {page, context, response} = createHandlerMocks();
      stubInspection(page, [
        ['1_1', {computed: new Map([['display', 'block']])}],
        ['1_2', {computed: new Map([['display', 'inline']])}],
      ]);

      await getComputedStylesBatch.handler(
        {params: {uids: ['1_1', '1_2'], properties: ['display']}, page},
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(page.getStyleInspectionForUids, [
        '1_1',
        '1_2',
      ]);
      sinon.assert.calledOnceWithExactly(
        response.setStyleResult,
        'computedStylesBatch',
        'Computed styles (batch):',
        {
          uids: ['1_1', '1_2'],
          styles: {
            '1_1': {display: 'block'},
            '1_2': {display: 'inline'},
          },
        },
      );
    });

    it('returns empty maps for uids missing from the helper result', async () => {
      const {page, context, response} = createHandlerMocks();
      stubInspection(page, [['1_1', {computed: new Map([['color', 'red']])}]]);

      await getComputedStylesBatch.handler(
        {params: {uids: ['1_1', '1_2']}, page},
        response,
        context,
      );

      assert.deepStrictEqual(styleResultData(response), {
        uids: ['1_1', '1_2'],
        styles: {
          '1_1': {color: 'red'},
          '1_2': {},
        },
      });
    });
  });

  describe('diff_computed_styles', () => {
    it('diffs two uids and compares geometry when requested', async () => {
      const {page, context, response} = createHandlerMocks();
      stubInspection(page, [
        ['1_1', {computed: new Map([['display', 'block']]), box: BOX_MODEL}],
        ['1_2', {computed: new Map([['display', 'inline']]), box: BOX_MODEL}],
      ]);

      await diffComputedStyles.handler(
        {
          params: {
            uidA: '1_1',
            uidB: '1_2',
            properties: ['display'],
            compareGeometry: true,
          },
          page,
        },
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(
        page.getStyleInspectionForUids,
        ['1_1', '1_2'],
        {box: true},
      );
      sinon.assert.calledOnceWithExactly(
        response.setStyleResult,
        'computedStylesDiff',
        'Computed styles diff (A -> B):',
        {
          uidA: '1_1',
          uidB: '1_2',
          styleChanges: [
            {property: 'display', before: 'block', after: 'inline'},
          ],
          changeClass: 'cascadeOnly',
          effectiveLayoutChange: false,
          geometry: {
            borderRectA: {
              left: 0,
              top: 0,
              right: 10,
              bottom: 10,
              width: 10,
              height: 10,
            },
            borderRectB: {
              left: 0,
              top: 0,
              right: 10,
              bottom: 10,
              width: 10,
              height: 10,
            },
            approximatelyEqual: true,
          },
        },
      );
    });

    it('omits geometry when compareGeometry is not requested', async () => {
      const {page, context, response} = createHandlerMocks();
      stubInspection(page, [
        ['1_1', {computed: new Map([['display', 'block']])}],
        ['1_2', {computed: new Map([['display', 'block']])}],
      ]);

      await diffComputedStyles.handler(
        {params: {uidA: '1_1', uidB: '1_2', properties: ['display']}, page},
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(
        page.getStyleInspectionForUids,
        ['1_1', '1_2'],
        undefined,
      );
      assert.deepStrictEqual(styleResultData(response), {
        uidA: '1_1',
        uidB: '1_2',
        styleChanges: [],
        changeClass: 'none',
        effectiveLayoutChange: false,
      });
    });

    it('classifies a paint-only change when geometry matches', async () => {
      const {page, context, response} = createHandlerMocks();
      stubInspection(page, [
        ['1_1', {computed: new Map([['color', 'red']]), box: BOX_MODEL}],
        ['1_2', {computed: new Map([['color', 'blue']]), box: BOX_MODEL}],
      ]);

      await diffComputedStyles.handler(
        {
          params: {
            uidA: '1_1',
            uidB: '1_2',
            properties: ['color'],
            compareGeometry: true,
          },
          page,
        },
        response,
        context,
      );

      const parsed = styleResultData(response) as {
        changeClass: string;
        effectiveLayoutChange: boolean;
      };
      assert.strictEqual(parsed.changeClass, 'paintLikely');
      assert.strictEqual(parsed.effectiveLayoutChange, false);
    });

    it('classifies a layout shift when border boxes differ', async () => {
      const {page, context, response} = createHandlerMocks();
      stubInspection(page, [
        ['1_1', {computed: new Map([['width', '10px']]), box: BOX_MODEL}],
        ['1_2', {computed: new Map([['width', '20px']]), box: SHIFTED_BOX}],
      ]);

      await diffComputedStyles.handler(
        {
          params: {
            uidA: '1_1',
            uidB: '1_2',
            properties: ['width'],
            compareGeometry: true,
          },
          page,
        },
        response,
        context,
      );

      const parsed = styleResultData(response) as {
        changeClass: string;
        effectiveLayoutChange: boolean;
        geometry: {approximatelyEqual: boolean};
      };
      assert.strictEqual(parsed.changeClass, 'layoutEffective');
      assert.strictEqual(parsed.effectiveLayoutChange, true);
      assert.strictEqual(parsed.geometry.approximatelyEqual, false);
    });
  });

  describe('save_computed_styles_snapshot', () => {
    it('stores a named snapshot on the context', async () => {
      const {page, context, response} = createHandlerMocks();
      await stubSavePage(page, {axBackendNodeId: 9});

      await saveComputedStylesSnapshot.handler(
        {
          params: {name: 'snap1', uids: ['1_1'], properties: ['display']},
          page,
        },
        response,
        context,
      );

      sinon.assert.calledOnce(context.setStyleSnapshot);
      sinon.assert.calledOnceWithExactly(
        response.setStyleResult,
        'styleSnapshot',
        '',
        sinon.match({
          name: 'snap1',
          schemaVersion: 1,
          uids: ['1_1'],
        }),
      );
      const [name, snapshot] = context.setStyleSnapshot.firstCall.args;
      assert.strictEqual(name, 'snap1');
      const named = JSON.parse(JSON.stringify(snapshot)) as StyleSnapshotData;
      assert.strictEqual(named.elements['1_1'].computed.display, 'block');
    });

    it('writes snapshot JSON through saveFile', async () => {
      const {page, context, response} = createHandlerMocks();
      await stubSavePage(page, {axBackendNodeId: 9});
      page.pptrPage.viewport.returns(null);
      context.saveFile.resolves({filename: '/tmp/styles.json'});

      await saveComputedStylesSnapshot.handler(
        {
          params: {
            filePath: '/tmp/styles.json',
            uids: ['1_1'],
            properties: ['display'],
          },
          page,
        },
        response,
        context,
      );

      sinon.assert.calledOnce(context.saveFile);
      sinon.assert.calledWithExactly(
        context.saveFile,
        sinon.match.instanceOf(Uint8Array),
        '/tmp/styles.json',
        '.json',
      );
    });

    it('throws when neither name nor filePath is provided', async () => {
      const {page, context, response} = createHandlerMocks();

      await assert.rejects(
        () =>
          saveComputedStylesSnapshot.handler(
            {params: {uids: ['1_1']}, page},
            response,
            context,
          ),
        /Provide at least one of name or filePath/,
      );
      sinon.assert.notCalled(page.getStyleInspectionForUids);
    });

    it('falls back to the DOM node backend id and ignores a failed domPath', async () => {
      const {page, context, response} = createHandlerMocks();
      const {handle} = await stubSavePage(page, {
        axBackendNodeId: undefined,
        evaluateRejects: true,
        box: null,
      });

      await saveComputedStylesSnapshot.handler(
        {params: {name: 'snap1', uids: ['1_1']}, page},
        response,
        context,
      );

      sinon.assert.calledOnce(handle.dispose);
      const stored = JSON.parse(
        JSON.stringify(context.setStyleSnapshot.firstCall.args[1]),
      ) as StyleSnapshotData;
      assert.strictEqual(stored.elements['1_1'].backendNodeId, 9);
      assert.strictEqual(stored.elements['1_1'].domPath, undefined);
      assert.strictEqual(stored.elements['1_1'].borderRect, undefined);
    });
  });

  describe('diff_computed_styles_snapshot', () => {
    it('diffs live styles against an in-memory snapshot', async () => {
      const {page, context, response} = createHandlerMocks();
      context.getStyleSnapshot.returns({
        meta: {
          capturedAt: '2026-01-01T00:00:00.000Z',
          url: 'https://example.test/',
          viewportWidth: 800,
          viewportHeight: 600,
          dpr: 1,
        },
        elements: {
          '1_1': {
            computed: {display: 'block'},
            borderRect: {
              left: 0,
              top: 0,
              right: 10,
              bottom: 10,
              width: 10,
              height: 10,
            },
            domPath: 'div:nth-of-type(1)',
          },
        },
      });
      stubInspection(page, [
        ['1_1', {computed: new Map([['display', 'inline']]), box: BOX_MODEL}],
      ]);

      await diffComputedStylesSnapshot.handler(
        {
          params: {name: 'snap1', uid: '1_1', properties: ['display']},
          page,
        },
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(context.getStyleSnapshot, 'snap1');
      sinon.assert.calledOnceWithExactly(
        page.getStyleInspectionForUids,
        ['1_1'],
        {box: true},
      );
      const parsed = styleResultData(response) as {
        uid: string;
        styleChanges: Array<{before: string; after: string}>;
      };
      assert.strictEqual(parsed.uid, '1_1');
      assert.strictEqual(parsed.styleChanges[0]?.before, 'block');
      assert.strictEqual(parsed.styleChanges[0]?.after, 'inline');
    });

    it('reads a validated baseline file path', async () => {
      const {page, context, response} = createHandlerMocks();
      const filePath = join(tmpdir(), `styles-baseline-${Date.now()}.json`);
      await writeFile(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          meta: {
            capturedAt: '2026-01-01T00:00:00.000Z',
            url: 'https://example.test/',
            viewportWidth: 800,
            viewportHeight: 600,
            dpr: 1,
          },
          elements: {'1_1': {computed: {display: 'block'}}},
        }),
      );
      stubInspection(page, [
        ['1_1', {computed: new Map([['display', 'inline']]), box: BOX_MODEL}],
      ]);

      try {
        await diffComputedStylesSnapshot.handler(
          {
            params: {
              baselineFilePath: filePath,
              uid: '1_1',
              properties: ['display'],
            },
            page,
          },
          response,
          context,
        );
        const saved = JSON.parse(await readFile(filePath, 'utf8')) as {
          schemaVersion: number;
        };
        assert.strictEqual(saved.schemaVersion, 1);
        sinon.assert.notCalled(context.getStyleSnapshot);
      } finally {
        await rm(filePath, {force: true});
      }
    });

    it('throws when neither name nor baselineFilePath is provided', async () => {
      const {page, context, response} = createHandlerMocks();
      await assert.rejects(
        () =>
          diffComputedStylesSnapshot.handler(
            {params: {uid: '1_1'}, page},
            response,
            context,
          ),
        /Provide at least one of name or baselineFilePath/,
      );
    });

    it('throws when the named snapshot is missing', async () => {
      const {page, context, response} = createHandlerMocks();
      context.getStyleSnapshot.returns(undefined);
      await assert.rejects(
        () =>
          diffComputedStylesSnapshot.handler(
            {params: {name: 'missing', uid: '1_1'}, page},
            response,
            context,
          ),
        /No snapshot found with the provided name/,
      );
    });

    it('matches a baseline element by domPath when uids differ', async () => {
      const {page, context, response} = createHandlerMocks();
      context.getStyleSnapshot.returns({
        meta: {
          capturedAt: '2026-01-01T00:00:00.000Z',
          url: 'https://example.test/',
          viewportWidth: 800,
          viewportHeight: 600,
          dpr: 1,
        },
        elements: {
          '1_9': {
            computed: {display: 'block'},
            domPath: 'div:nth-of-type(1)',
          },
        },
      });
      stubInspection(page, [
        ['2_1', {computed: new Map([['display', 'block']]), box: BOX_MODEL}],
      ]);

      await diffComputedStylesSnapshot.handler(
        {
          params: {
            name: 'snap1',
            uid: '2_1',
            domPath: 'div:nth-of-type(1)',
            properties: ['display'],
          },
          page,
        },
        response,
        context,
      );

      const parsed = styleResultData(response) as {
        styleChanges: unknown[];
        domPathBaseline: string;
      };
      assert.deepStrictEqual(parsed.styleChanges, []);
      assert.strictEqual(parsed.domPathBaseline, 'div:nth-of-type(1)');
    });

    it('supports a legacy flat snapshot map', async () => {
      const {page, context, response} = createHandlerMocks();
      context.getStyleSnapshot.returns({
        '1_1': {display: 'block', color: 'red'},
      });
      stubInspection(page, [
        [
          '1_1',
          {
            computed: new Map([
              ['display', 'block'],
              ['color', 'blue'],
            ]),
            box: null,
          },
        ],
      ]);

      await diffComputedStylesSnapshot.handler(
        {params: {name: 'legacy', uid: '1_1'}, page},
        response,
        context,
      );

      const parsed = styleResultData(response) as {
        snapshotMeta: unknown;
        styleChanges: Array<{property: string; after: string}>;
        overlay: {borderQuad: number[] | null};
      };
      assert.strictEqual(parsed.snapshotMeta, undefined);
      assert.strictEqual(parsed.overlay.borderQuad, null);
      assert.strictEqual(parsed.styleChanges[0]?.property, 'color');
      assert.strictEqual(parsed.styleChanges[0]?.after, 'blue');
    });

    it('rejects an invalid snapshot file', async () => {
      const {page, context, response} = createHandlerMocks();
      const filePath = join(tmpdir(), `styles-invalid-${Date.now()}.json`);
      await writeFile(filePath, JSON.stringify({not: 'a snapshot'}));
      try {
        await assert.rejects(
          () =>
            diffComputedStylesSnapshot.handler(
              {params: {baselineFilePath: filePath, uid: '1_1'}, page},
              response,
              context,
            ),
          /Invalid styles snapshot file format/,
        );
      } finally {
        await rm(filePath, {force: true});
      }
    });

    it('compares geometry against the stored border rect', async () => {
      const {page, context, response} = createHandlerMocks();
      context.getStyleSnapshot.returns({
        meta: {
          capturedAt: '2026-01-01T00:00:00.000Z',
          url: 'https://example.test/',
          viewportWidth: 800,
          viewportHeight: 600,
          dpr: 1,
        },
        elements: {
          '1_1': {
            computed: {display: 'block'},
            borderRect: {
              left: 0,
              top: 0,
              right: 10,
              bottom: 10,
              width: 10,
              height: 10,
            },
          },
        },
      });
      stubInspection(page, [
        ['1_1', {computed: new Map([['display', 'block']]), box: SHIFTED_BOX}],
      ]);

      await diffComputedStylesSnapshot.handler(
        {
          params: {
            name: 'snap1',
            uid: '1_1',
            properties: ['display'],
            compareGeometry: true,
          },
          page,
        },
        response,
        context,
      );

      const parsed = styleResultData(response) as {
        changeClass: string;
        geometry: {approximatelyEqual: boolean};
      };
      assert.strictEqual(parsed.changeClass, 'layoutEffective');
      assert.strictEqual(parsed.geometry.approximatelyEqual, false);
    });
  });

  describe('highlight_elements_for_styles', () => {
    it('highlights resolved nodes and returns border quads', async () => {
      const {page, context, response} = createHandlerMocks();
      const node = createMockDOMNode();
      node.boxModel.resolves(BOX_MODEL);
      page.getDomNodesForUids.resolves(new Map([['1_1', node]]));

      await highlightElementsForStyles.handler(
        {params: {uids: ['1_1']}, page},
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(page.getDomNodesForUids, ['1_1']);
      sinon.assert.calledOnceWithExactly(node.highlight, 'all');
      sinon.assert.calledOnce(node.boxModel);
      sinon.assert.callOrder(node.boxModel, node.highlight);
      sinon.assert.calledOnceWithExactly(
        response.setStyleResult,
        'highlightRegions',
        'Highlight regions (border quads, layout px):',
        {
          uids: ['1_1'],
          regions: [{uid: '1_1', borderQuad: BOX_QUAD}],
        },
      );
    });

    it('highlights after collecting boxes so the last uid wins', async () => {
      const {page, context, response} = createHandlerMocks();
      const first = createMockDOMNode();
      const second = createMockDOMNode();
      first.boxModel.resolves(BOX_MODEL);
      second.boxModel.resolves(SHIFTED_BOX);
      page.getDomNodesForUids.resolves(
        new Map([
          ['1_1', first],
          ['1_2', second],
        ]),
      );

      await highlightElementsForStyles.handler(
        {params: {uids: ['1_1', '1_2']}, page},
        response,
        context,
      );

      sinon.assert.callOrder(first.boxModel, first.highlight);
      sinon.assert.callOrder(second.boxModel, second.highlight);
      sinon.assert.callOrder(first.highlight, second.highlight);
    });

    it('returns a null quad when box model is unavailable', async () => {
      const {page, context, response} = createHandlerMocks();
      const node = createMockDOMNode();
      node.boxModel.resolves(null);
      page.getDomNodesForUids.resolves(new Map([['1_1', node]]));

      await highlightElementsForStyles.handler(
        {params: {uids: ['1_1']}, page},
        response,
        context,
      );

      assert.deepStrictEqual(styleResultData(response), {
        uids: ['1_1'],
        regions: [{uid: '1_1', borderQuad: null}],
      });
    });

    it('throws when a requested uid is missing from the node map', async () => {
      const {page, context, response} = createHandlerMocks();
      page.getDomNodesForUids.resolves(new Map());

      await assert.rejects(
        () =>
          highlightElementsForStyles.handler(
            {params: {uids: ['1_1']}, page},
            response,
            context,
          ),
        /Element with uid "1_1" was detached/,
      );
    });
  });
});
