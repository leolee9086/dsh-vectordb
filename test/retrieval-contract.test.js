import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVectorStore } from '../src/host.js'
import { sourceReference, referenceKey, searchView, matchBoundFilter, createAdapter, invokeAdapter } from '../src/retrieval-contract.js'

const ref = (objectId, componentId, selector) => sourceReference({
  namespace: 'fixture', objectId, revision: 'v1',
  ...(componentId === undefined ? {} : { componentId }),
  ...(selector === undefined ? {} : { selector }),
})
const view = (id, sources, input = { text: id }) => searchView({
  namespace: 'fixture', id, revision: 'v1', representation: { id: 'native', revision: 'v1' }, sources, input,
})

// These four projections are adapter choices, not branches in the shared implementation.
const fixtures = [
  { id: 'flat', views: [view('flat', [ref('flat')])], contents: [[ref('flat'), 'plain text']] },
  { id: 'container', views: [view('joint', [ref('round', 'text'), ref('round', 'image')], { text: 'camera', image: 'image-sha' })],
    contents: [[ref('round', 'text'), { role: 'user', text: 'camera' }], [ref('round', 'image'), { image: 'image-sha' }]] },
  { id: 'graph', views: [view('edge', [ref('edge'), ref('person'), ref('device')])],
    contents: [[ref('edge'), { fact: 'owns', endpoints: [ref('person'), ref('device')] }], [ref('person'), 'Alice'], [ref('device'), 'camera']] },
  { id: 'sequence', views: [view('step', [ref('run', 'steps', { index: 1, role: 'observation' }), ref('run', 'steps', { index: 1, role: 'action' })])],
    contents: [[ref('run', 'steps', { index: 1, role: 'observation' }), 'lock failed'], [ref('run', 'steps', { index: 1, role: 'action' }), 'close stale process']] },
]

function adapterFor(fixture) {
  const contents = new Map(fixture.contents.map(([reference, content]) => [referenceKey(reference), content]))
  return createAdapter({ id: fixture.id, revision: 'v1', capabilities: {
    project: async () => ({ status: 'ok', views: fixture.views }),
    resolve: async (reference) => {
      const key = referenceKey(reference)
      return contents.has(key) ? { status: 'ok', reference, content: contents.get(key) } : { status: 'unavailable', reference }
    },
  } })
}

for (const fixture of fixtures) {
  test('same contract preserves ' + fixture.id + ' projection and native resolution', async () => {
    const adapter = adapterFor(fixture)
    const projected = await invokeAdapter(adapter, 'project', {})
    assert.equal(projected.status, 'ok')
    for (const candidate of projected.views) {
      const restored = searchView(JSON.parse(JSON.stringify(candidate)))
      assert.deepEqual(restored.sources, candidate.sources)
      assert.equal(restored.projectionHash, candidate.projectionHash)
      for (const reference of restored.sources) assert.equal((await invokeAdapter(adapter, 'resolve', reference)).status, 'ok')
    }
    assert.equal((await invokeAdapter(adapter, 'expand', {})).status, 'unsupported')
    assert.equal((await invokeAdapter(adapter, 'toString', {})).status, 'unsupported')
    assert.equal((await invokeAdapter(adapter, 'resolve', { ...fixture.contents[0][0], revision: 'v2' })).status, 'unavailable')
  })
}

test('references require versions and preserve component/selector identity', () => {
  const first = ref('run', 'steps', { role: 'action', index: 1 })
  const reordered = ref('run', 'steps', { index: 1, role: 'action' })
  assert.equal(referenceKey(first), referenceKey(reordered))
  assert.notEqual(referenceKey(first), referenceKey({ ...first, revision: 'v2' }))
  assert.notEqual(referenceKey(first), referenceKey(ref('run', 'steps', { index: 2, role: 'action' })))
  assert.notEqual(referenceKey(first), referenceKey({ ...first, namespace: 'other' }))
  assert.throws(() => sourceReference({ namespace: 'fixture', objectId: 'a' }), /revision/)
  assert.throws(() => sourceReference({ ...first, component: 'typo' }), /Unknown/)
  assert.throws(() => { first.selector.index = 99 }, TypeError)
})

test('encoding bytes stay reusable when representation or source versions change', () => {
  const original = view('fact', [ref('event', 'a'), ref('event', 'b')], { text: 'same encoding input' })
  const changed = searchView({ ...original, revision: 'v2', representation: { id: 'new-category', revision: 'v2' },
    sources: [ref('event', 'a'), { ...ref('event', 'b'), revision: 'v2' }] })
  assert.equal(changed.inputHash, original.inputHash)
  assert.notEqual(changed.projectionHash, original.projectionHash)
  assert.notEqual(view('fact', original.sources, { text: 'changed encoding input' }).inputHash, original.inputHash)
  assert.equal(original.sources.length, 2)
  assert.throws(() => searchView({ ...original, sources: [] }), /source references/)
})

test('canonical identities reject lossy JSON, cycles and live class instances', () => {
  const circular = {}; circular.self = circular
  for (const input of [undefined, { text: undefined }, { text: NaN }, circular, new Date(), [, 'a'], { text: () => 'a' }]) {
    assert.throws(() => searchView({ ...view('invalid', [ref('a')]), input }), TypeError)
  }
  assert.equal(view('ordered', [ref('a')], { text: 'a', image: 'b' }).inputHash,
    view('ordered', [ref('a')], { image: 'b', text: 'a' }).inputHash)
})

const fields = {
  person: { type: 'string', operators: ['eq', 'in'] },
  time: { type: 'number', operators: ['eq', 'gte', 'lt'] },
  success: { type: 'boolean', operators: ['eq'] },
}
const rows = [
  { ref: ref('events', 'event-1'), values: { person: 'Alice', time: 1, success: false } },
  { ref: ref('events', 'event-2'), values: { person: 'Bob', time: 2, success: true } },
]

test('all predicates bind to the same component, not different subevents', () => {
  const crossed = matchBoundFilter({ fields, rows, where: [
    { field: 'person', op: 'eq', value: 'Alice' }, { field: 'time', op: 'eq', value: 2 },
  ] })
  assert.equal(crossed.status, 'empty')
  const matched = matchBoundFilter({ fields, rows, where: [
    { field: 'person', op: 'in', value: ['Bob'] }, { field: 'time', op: 'gte', value: 2 }, { field: 'success', op: 'eq', value: true },
  ] })
  assert.equal(matched.status, 'ok')
  assert.equal(matched.matches.length, 1)
  assert.equal(matched.matches[0].ref.componentId, 'event-2')
})

test('unknown filters are unsupported even with no candidates, never ignored', () => {
  const unsupported = matchBoundFilter({ fields, rows: [], where: [{ field: 'entity', op: 'eq', value: 'Alice' }] })
  assert.equal(unsupported.status, 'unsupported')
  assert.deepEqual(unsupported.unsupported, [{ field: 'entity', op: 'eq' }])
  assert.equal(matchBoundFilter({ fields, rows, where: [{ field: 'person', op: 'gte', value: 'Alice' }] }).status, 'unsupported')
  assert.throws(() => matchBoundFilter({ fields, rows: [], where: [{ field: 'time', op: 'eq', value: '2' }] }), /field type/)
  assert.throws(() => matchBoundFilter({ fields, rows: [{ ref: ref('a'), values: { time: '2' } }], where: [{ field: 'time', op: 'eq', value: 2 }] }), /field type/)
  assert.equal(matchBoundFilter({ fields: {}, rows: [{ ref: ref('flat'), values: {} }] }).status, 'ok')
})

test('optional hooks preserve partial/unavailable and do not prescribe model output', async () => {
  const adapter = createAdapter({ id: 'custom', revision: '1', capabilities: {
    project: () => ({ status: 'partial', views: [], reason: 'budget' }),
    resolve: () => ({ status: 'unavailable' }),
    customRanking: (request) => ({ orderedIds: request.ids.toReversed(), diagnostic: 'adapter-defined' }),
  } })
  assert.equal((await invokeAdapter(adapter, 'project')).status, 'partial')
  assert.equal((await invokeAdapter(adapter, 'resolve')).status, 'unavailable')
  assert.deepEqual(await invokeAdapter(adapter, 'customRanking', { ids: ['a', 'b'] }), { orderedIds: ['b', 'a'], diagnostic: 'adapter-defined' })
  assert.throws(() => createAdapter({ id: 'missing', revision: '1', capabilities: { project() {} } }), /project and resolve/)
})

test('real Dataset persists projection provenance and resolves all four native shapes after restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-retrieval-contract-'))
  let store = createVectorStore({}, { path: join(dir, 'db') })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  assert.equal(store.isOpen(), false, 'constructing contracts does not start a sidecar')
  assert.equal(store.retrieval.searchView, searchView)
  const schema = { embeddings: { text: { dimension: 2, distanceMetric: 'cosine' } },
    indexes: { text: { embedding: 'text', engine: 'hnsw' } } }
  const dataset = await store.dataset('projections', schema)
  await dataset.upsertEntities(fixtures.map((fixture, index) => ({
    id: fixture.id, embeddings: { text: [1, index / 10] }, meta: { adapterId: fixture.id, view: fixture.views[0] },
  })), { durability: 'sync' })
  await store.close()
  store = createVectorStore({}, { path: join(dir, 'db') })
  const reopened = await store.dataset('projections', schema)
  const result = await reopened.fuseSearch([{ index: 'text', vector: [1, 0] }], { topK: 4 })
  assert.equal(result.results.length, 4)
  for (const hit of result.results) {
    const fixture = fixtures.find((entry) => entry.id === hit.meta.adapterId)
    const persisted = store.retrieval.searchView(hit.meta.view)
    assert.deepEqual(persisted, fixture.views[0])
    for (const reference of persisted.sources) {
      assert.equal((await store.retrieval.invokeAdapter(adapterFor(fixture), 'resolve', reference)).status, 'ok')
    }
  }
})
