// Keyless browser snapshot for reviewed per-agent model selection. The real
// shipped composition creates the durable plan; no model turn is admitted.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/collaboration-model-selection', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: reviewed model selection for every collaboration agent', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the daily-session model directory for the Lead and every planned expert', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-collaboration-model-selection'))
    await page.getByRole('button', { name: '进入独立多智能体协作' }).click()
    await page.getByRole('textbox', { name: '任务目标与验收标准' }).fill(
      '分析企业知识管理中的 AI 智能体机会，并由多位专家交叉验证后给出建议',
    )
    await page.getByRole('button', { name: '生成协作方案' }).click()
    const review = page.locator('[data-collaboration-workspace="review"]')
    await review.waitFor({ timeout: 15_000 })
    await expect.poll(
      () => review.getByRole('combobox', { name: /选择模型/u }).count(),
      { timeout: 10_000 },
    ).toBe(4)
    expect(await review.locator('[data-review-lead-model]').count()).toBe(1)
    expect(await review.locator('[data-review-expert]').count()).toBe(3)
    expect(await review.getByText('全部智能体的模型配置已与当前方案一致').count()).toBe(1)

    const snapshot = await captureStableAria(
      page,
      '[data-collaboration-workspace="review"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
