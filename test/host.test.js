// test/host.test.js —— 端到端：真的拉起 sidecar、真的写、真的搜出来。
//
// 这条测试的意义不是覆盖率，而是回答一个二值问题：**这台机器上，DSH 到底有没有一个能用的向量库**。
// 所以它不 mock 任何东西 —— mock 掉 sidecar 就等于没测到"进程能不能起来、二进制找不找得到、
// 库文件能不能落盘"这些真正会出问题的地方。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVectorStore } from '../src/host.js'

/** 最小的宿主上下文：只用到 logger 与 get。 */
function fakeCtx() {
  const logs = []
  return {
    logs,
    logger: { info: (m) => logs.push('info: ' + m), warn: (m) => logs.push('warn: ' + m) },
    get: () => undefined,
    provide: () => {},
    effect: () => {},
  }
}

test('端到端：建 collection、写两条、按向量搜出最近的那条', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vectordb-'))
  const ctx = fakeCtx()
  const store = createVectorStore(ctx, { path: join(dir, 'db') })
  t.after(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // 懒启动：没碰它之前不该有库文件。
  assert.equal(store.isOpen(), false, '刚创建时不该打开库')

  const col = await store.collection('probe', { dimension: 4, metric: 'cosine' })
  assert.equal(store.isOpen(), true, '拿到 collection 之后库该开了')
  assert.ok(existsSync(join(dir, 'db')), '库目录应该落在了指定位置')

  await col.write([
    { id: 'a', vector: [1, 0, 0, 0], meta: { tag: 'x', note: '第一个' } },
    { id: 'b', vector: [0, 1, 0, 0], meta: { tag: 'y', note: '第二个' } },
  ])

  const stats = await col.stats()
  assert.equal(stats.count, 2, '两条都该在里面')

  const hits = await col.search([0.9, 0.1, 0, 0], { topK: 2 })
  assert.ok(hits.length >= 1, '至少要搜出一条')
  assert.equal(hits[0].id, 'a', '最靠近 query 的应该是 a')
  // meta 要原样回来 —— 记忆的 tag / seq 就靠它。
  assert.equal(hits[0].meta?.note, '第一个')

  // 同一个名字再拿一次，应该是同一个句柄（不重复建、不重复开）。
  const again = await store.collection('probe')
  assert.equal(again, col, '同名 collection 应当返回同一个句柄')

  const names = await store.list()
  assert.deepEqual(names, ['probe'])
})

test('同名 collection：第二次调用走 open 而不是 create（create 对已存在的会抛）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vectordb-'))
  const ctx = fakeCtx()
  const first = createVectorStore(ctx, { path: join(dir, 'db') })
  let second
  t.after(async () => {
    if (second) await second.close()
    await first.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const col = await first.collection('memories', { dimension: 3 })
  await col.write([{ id: 'm1', vector: [1, 0, 0], meta: { tag: 'commit' } }])

  // 换一个 store 实例（清掉句柄缓存）指向同一个库目录 —— 等价于"重启之后再来一次"。
  await first.close()
  second = createVectorStore(ctx, { path: join(dir, 'db') })
  const reopened = await second.collection('memories', { dimension: 3 })
  const hits = await reopened.search([1, 0, 0], { topK: 1 })
  assert.equal(hits[0]?.id, 'm1', '重开之后数据应当还在（也证明没走 create 那条会抛的路）')
})
