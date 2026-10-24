import { expect, test } from '@playwright/test'
import { formatPrice } from '#/config/site'
import { ORIGIN, buyPackage, credits, devLogin, json, ledger, post, uniqueEmail, uploadPhoto } from './helpers'

type Generation = { id: string; status: string; videoUrl: string | null }

const ADMIN_EMAIL = 'admin@example.com'

test('余额不足返回 402，不产生任务也不产生流水', async ({ request }) => {
  await devLogin(request, uniqueEmail('broke'))
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  const res = await json<{ error: string }>(post(request, '/api/generations', { uploadId: upload.id, durationId: 'short' }), 402)
  expect(res.error).toBe('insufficient_credits')
  const { generations } = await json<{ generations: Generation[] }>(request.get('/api/generations'))
  expect(generations).toHaveLength(0)
  expect(await ledger(request)).toHaveLength(0)
})

test('上传校验与越权：伪装 JPEG 返回 415，不能用别人的上传发起生成', async ({ request, playwright }) => {
  await devLogin(request, uniqueEmail('owner'))
  const fake = await uploadPhoto(request, Buffer.from('<?php echo "not an image"; ?>'), 'image/jpeg')
  expect(fake.status()).toBe(415)
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)

  const other = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(other, uniqueEmail('intruder'))
    await buyPackage(other, 'starter')
    const res = await json<{ error: string }>(post(other, '/api/generations', { uploadId: upload.id, durationId: 'short' }), 400)
    expect(res.error).toBe('invalid_upload')
    expect(await credits(other)).toBe(20)
    // 别人的上传图片也不能直接读取
    expect((await other.get(`/media/uploads/${upload.id}`)).status()).not.toBe(200)
  } finally {
    await other.dispose()
  }
})

test('生成失败自动退回积分，失败任务没有视频', async ({ request }) => {
  await devLogin(request, uniqueEmail('refund'))
  await buyPackage(request, 'starter')
  const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
  const { generation } = await json<{ generation: Generation }>(
    post(request, '/api/generations', { uploadId: upload.id, durationId: 'full', mockOutcome: 'fail' }),
    201,
  )
  expect(await credits(request)).toBe(2)

  await expect
    .poll(async () => (await json<{ generation: Generation }>(request.get(`/api/generations/${generation.id}`))).generation.status, {
      timeout: 60_000,
      intervals: [1000],
    })
    .toBe('failed')

  expect(await credits(request)).toBe(20)
  const entries = (await ledger(request)).filter((e) => e.ref_id === generation.id)
  expect(entries.map((e) => [e.reason, e.delta]).sort()).toEqual([
    ['generation', -18],
    ['generation_refund', 18],
  ])
  expect((await request.get(`/api/generations/${generation.id}/video`)).status()).toBe(404)
})

// tryallapi webhook 只是“该去查一下”的信号，会和定时轮询同时处理同一个任务：只能一路落库，另一路不能删掉已落库的成片
test('并发轮询只落库一次、成片不被误删；后台记录服务商成本与毛利，未出片的失败任务不记成本', async ({ request, page }) => {
  await devLogin(request, uniqueEmail('race'))
  await buyPackage(request, 'starter')
  const start = async (mockOutcome: 'hang' | 'fail') => {
    const { upload } = await json<{ upload: { id: string } }>(uploadPhoto(request), 201)
    const body = { uploadId: upload.id, durationId: 'short', mockOutcome }
    return (await json<{ generation: Generation }>(post(request, '/api/generations', body), 201)).generation.id
  }
  const status = async (id: string) => (await json<{ generation: Generation }>(request.get(`/api/generations/${id}`))).generation.status
  const raced = await start('hang')
  const failed = await start('fail')

  await expect.poll(() => status(raced), { timeout: 30_000, intervals: [500] }).toBe('processing')
  expect(await json(post(request, '/api/dev/mock-finish', { generationId: raced, polls: 3 }))).toEqual({ ok: true })
  expect(await status(raced)).toBe('succeeded')
  const video = await request.get(`/api/generations/${raced}/video`)
  expect(video.status()).toBe(200)
  expect((await video.body()).length).toBeGreaterThan(10_000)

  await expect.poll(() => status(failed), { timeout: 60_000, intervals: [1000] }).toBe('failed')
  expect(await credits(request)).toBe(14)

  // mock 出片成本为 0（不是 NULL）；没出片的失败任务服务商不计费，成本为 NULL
  await devLogin(page.request, ADMIN_EMAIL)
  type AdminGeneration = { id: string; provider_cost_cents: number | null }
  const admin = await json<{ generations: AdminGeneration[]; revenuePerCreditCents: number | null }>(page.request.get('/api/admin/generations'))
  const cost = (id: string) => admin.generations.find((g) => g.id === id)?.provider_cost_cents
  expect(cost(raced)).toBe(0)
  expect(cost(failed)).toBeNull()
  // 本用例刚付过一笔 USD 订单，每积分实收一定能算出来
  const perCredit = admin.revenuePerCreditCents
  expect(perCredit).toBeGreaterThan(0)

  await page.goto('/admin/generations')
  const cell = (id: string) => page.getByTestId('admin-generations').locator('tr', { hasText: id }).getByTestId('generation-cost')
  await expect(cell(raced)).toHaveText(`$0.00毛利 ${formatPrice(Math.round(6 * perCredit!), 'USD')}`)
  await expect(cell(failed)).toHaveText('—')
  await page.goto('/admin')
  await expect(page.getByTestId('admin-margin')).toContainText('近 30 天服务商成本')
  await expect(page.getByTestId('admin-margin')).toContainText('估算毛利')
})
