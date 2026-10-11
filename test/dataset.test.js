import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVectorStore } from '../src/host.js'

const schema = {
  embeddings: {
    text: { dimension: 2, distanceMetric: 'cosine' },
    image: { dimension: 3, distanceMetric: 'cosine' },
  },
  indexes: { text: { embedding: 'text', engine: 'hnsw' }, image: { embedding: 'image', engine: 'hnsw' } },
}

test('真实多字段：不同维度融合、并发打开、更新删除及重启恢复', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dataset-'))
  let store = createVectorStore({}, { path: join(dir, 'db') })
  t.after(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const [dataset, same] = await Promise.all([store.dataset('memory', schema), store.dataset('memory', schema)])
  assert.equal(dataset, same)
  await dataset.upsertEntities([
    { id: 'a', embeddings: { text: [1, 0], image: [1, 0, 0] }, meta: { revision: 1 } },
    { id: 'b', embeddings: { text: [0, 1], image: [0, 1, 0] } },
  ])
  const queries = [{ index: 'text', vector: [1, 0] }, { index: 'image', vector: [1, 0, 0] }]
  const fused = await dataset.fuseSearch(queries, { topK: 2 })
  assert.equal(fused.results[0]?.id, 'a')
  assert.equal(fused.results[0].sources.length, 2)
  await dataset.upsertEntities([{ id: 'a', embeddings: { text: [1, 0], image: [0.9, 0.1, 0] }, meta: { revision: 2 } }])
  await dataset.deleteEntities(['b'])
  await store.close()
  store = createVectorStore({}, { path: join(dir, 'db') })
  const reopened = await store.dataset('memory', schema)
  const hits = await reopened.fuseSearch(queries, { topK: 5 })
  assert.deepEqual(hits.results.map((item) => item.id), ['a'])
  assert.equal(hits.results[0].meta.revision, 2)
  const [entity] = await reopened.fetchEntities(['a'])
  assert.equal(entity.embeddings.text.length, 2)
  assert.equal(entity.embeddings.image.length, 3)
  await reopened.upsertEntities([{ id: 'sparse', embeddings: { text: [0, 1] } }])
  const sparse = await reopened.fetchEntities(['sparse', 'a'])
  assert.deepEqual([...sparse[0].embeddings.text], [0, 1])
  assert.equal(sparse[0].embeddings.image, undefined)
  assert.equal(sparse[1].embeddings.image.length, 3)
  assert.deepEqual([...sparse[1].embeddings.text], [1, 0])
  await assert.rejects(store.dataset('memory', { embeddings: { text: { dimension: 7 } } }), /字段契约不匹配/)
})

test('首次打开与关闭并发时不泄漏连接或重开已关闭的服务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-close-race-'))
  const store = createVectorStore({}, { path: join(dir, 'db') })
  try {
    const pending = store.dataset('memory', schema)
    await store.close()
    await pending
    assert.equal(store.isOpen(), false)
    assert.throws(() => store.dataset('memory'), /已关闭/)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
