/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {existsSync} from 'node:fs';
import {readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';

import type {McpContext} from '../../src/McpContext.js';
import {TextSnapshot} from '../../src/TextSnapshot.js';
import {
  diffComputedStyles,
  diffComputedStylesSnapshot,
  getBoxModel,
  getComputedStyles,
  getComputedStylesBatch,
  getVisibility,
  saveComputedStylesSnapshot,
} from '../../src/tools/styles.js';
import {html, withMcpContext} from '../utils.js';

async function snapshotPage(context: McpContext) {
  const mcpPage = context.getSelectedMcpPage();
  mcpPage.textSnapshot = await TextSnapshot.create(mcpPage);
}

describe('styles', () => {
  describe('get_computed_styles', () => {
    it('returns filtered computed styles', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();
        await page.setContent(
          html`<div
            id="box"
            style="display:block;color:rgb(0,0,255)"
            >box</div
          >`,
        );
        await snapshotPage(context);

        await getComputedStyles.handler(
          {
            params: {
              uid: '1_1',
              properties: ['display'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        const json = response.responseLines.at(2)!;
        const parsed = JSON.parse(json) as {
          computed: Record<string, string>;
        };
        assert.strictEqual(parsed.computed.display, 'block');
      });
    });

    it('can include best-effort rule origins', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();
        await page.setContent(
          html`<div
            id="box"
            style="display:block"
            >box</div
          >`,
        );
        await snapshotPage(context);

        await getComputedStyles.handler(
          {
            params: {
              uid: '1_1',
              properties: ['display'],
              includeSources: true,
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        const json = response.responseLines.at(2)!;
        const parsed = JSON.parse(json) as {
          computed: Record<string, string>;
          sourceMap?: Record<string, {source?: string}>;
        };
        assert.strictEqual(parsed.computed.display, 'block');
        assert.strictEqual(parsed.sourceMap?.display?.source, 'inline');
      });
    });
  });

  describe('get_box_model', () => {
    it('returns box quads and rects', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();
        await page.setContent(
          html`<div
            id="box"
            style="width:10px;height:10px;padding:1px;border:1px solid"
            >box</div
          >`,
        );
        await snapshotPage(context);

        await getBoxModel.handler(
          {params: {uid: '1_1'}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        const json = response.responseLines.at(2)!;
        const parsed = JSON.parse(json) as {
          borderRect: {width: number};
          contentRect: {width: number};
          borderQuad: unknown;
        };
        assert.ok(parsed.borderQuad);
        assert.ok(parsed.borderRect.width >= parsed.contentRect.width);
      });
    });
  });

  describe('get_visibility', () => {
    it('flags display:none as not visible', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();
        await page.setContent(html`<div id="box">hidden</div>`);
        await snapshotPage(context);
        await page.evaluate(() => {
          const el = document.getElementById('box');
          if (el) {
            el.style.display = 'none';
          }
        });

        await getVisibility.handler(
          {params: {uid: '1_1'}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        const json = response.responseLines.at(2)!;
        const parsed = JSON.parse(json) as {
          isVisible: boolean;
          reasons: string[];
        };
        assert.strictEqual(parsed.isVisible, false);
        assert.ok(parsed.reasons.includes('display:none'));
      });
    });
  });

  describe('get_computed_styles_batch', () => {
    it('returns styles for multiple elements', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();
        await page.setContent(html`<div>box</div><span>inline</span>`);
        await snapshotPage(context);

        await getComputedStylesBatch.handler(
          {
            params: {
              uids: ['1_1', '1_2'],
              properties: ['display'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        const json = response.responseLines.at(2)!;
        const parsed = JSON.parse(json) as Record<string, {display: string}>;
        assert.strictEqual(parsed['1_1'].display, 'block');
        assert.strictEqual(parsed['1_2'].display, 'inline');
      });
    });
  });

  describe('diff_computed_styles', () => {
    it('returns changed properties between two nodes', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();
        await page.setContent(html`<div>box</div><span>inline</span>`);
        await snapshotPage(context);

        await diffComputedStyles.handler(
          {
            params: {
              uidA: '1_1',
              uidB: '1_2',
              properties: ['display'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        const json = response.responseLines.at(2)!;
        const parsed = JSON.parse(json) as {
          styleChanges: Array<{
            property: string;
            before: string;
            after: string;
          }>;
        };
        const display = parsed.styleChanges.find(p => p.property === 'display');
        assert.ok(display);
        assert.strictEqual(display?.before, 'block');
        assert.strictEqual(display?.after, 'inline');
      });
    });
  });

  describe('named snapshots', () => {
    it('saves and diffs snapshot vs current', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();
        await page.setContent(
          html`<div
            id="box"
            style="display:block"
            >box</div
          >`,
        );
        await snapshotPage(context);

        await saveComputedStylesSnapshot.handler(
          {
            params: {
              name: 'snap1',
              uids: ['1_1'],
              properties: ['display'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        await page.evaluate(() => {
          const el = document.getElementById('box');
          if (el) {
            el.style.display = 'inline';
          }
        });

        response.resetResponseLineForTesting();
        await diffComputedStylesSnapshot.handler(
          {
            params: {
              name: 'snap1',
              uid: '1_1',
              properties: ['display'],
            },
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        const json = response.responseLines.at(2)!;
        const parsed = JSON.parse(json) as {
          styleChanges: Array<{
            property: string;
            before: string;
            after: string;
          }>;
        };
        const display = parsed.styleChanges.find(p => p.property === 'display');
        assert.strictEqual(display?.before, 'block');
        assert.strictEqual(display?.after, 'inline');
      });
    });

    it('writes snapshot JSON to filePath', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();
        await page.setContent(
          html`<div
            id="box"
            style="display:block"
            >box</div
          >`,
        );
        await snapshotPage(context);

        const filePath = join(tmpdir(), 'styles-snapshot-test.json');
        try {
          await saveComputedStylesSnapshot.handler(
            {
              params: {
                filePath,
                uids: ['1_1'],
                properties: ['display'],
              },
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          );

          assert.ok(existsSync(filePath));
          const saved = JSON.parse(await readFile(filePath, 'utf8')) as {
            schemaVersion: number;
            elements: Record<string, {computed: {display: string}}>;
          };
          assert.strictEqual(saved.schemaVersion, 1);
          assert.strictEqual(saved.elements['1_1'].computed.display, 'block');
        } finally {
          await rm(filePath, {force: true});
        }
      });
    });

    it('diffs live styles against baselineFilePath', async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();
        await page.setContent(
          html`<div
            id="box"
            style="display:block"
            >box</div
          >`,
        );
        await snapshotPage(context);

        const filePath = join(tmpdir(), 'styles-baseline-test.json');
        try {
          await saveComputedStylesSnapshot.handler(
            {
              params: {
                filePath,
                uids: ['1_1'],
                properties: ['display'],
              },
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          );

          await page.evaluate(() => {
            const el = document.getElementById('box');
            if (el) {
              el.style.display = 'inline';
            }
          });

          response.resetResponseLineForTesting();
          await diffComputedStylesSnapshot.handler(
            {
              params: {
                baselineFilePath: filePath,
                uid: '1_1',
                properties: ['display'],
              },
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          );

          const json = response.responseLines.at(2)!;
          const parsed = JSON.parse(json) as {
            styleChanges: Array<{
              property: string;
              before: string;
              after: string;
            }>;
          };
          const display = parsed.styleChanges.find(
            entry => entry.property === 'display',
          );
          assert.strictEqual(display?.before, 'block');
          assert.strictEqual(display?.after, 'inline');
        } finally {
          await rm(filePath, {force: true});
        }
      });
    });
  });
});
