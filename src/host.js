/**
 * 把独立向量库接成共享的宿主服务。数据库目录只能由一个侧车持有，
 * 消费者通过 ctx.get('vectorStore') 共享连接，不自行拉起进程。
 * Dataset、多向量字段与 RRF 都由底层实现，这里只做句柄和生命周期适配。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openVectorDB } from '@leolee9086/vectordb'
import { prepareSidecarBinary } from './runtime-binary.js'
import * as retrieval from './retrieval-contract.js'

export { retrieval }
export const name = 'dsh-vectordb'
export const SERVICE = 'vectorStore'

function defaultPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'vectors', 'vectordb')
}

/**
 * 配置：path、binary、binaryCachePath、cacheBinary、requestTimeoutMs。
 * Windows 默认把包里的侧车安装到宿主缓存；关闭后的 store 不再接受新请求。
 * 意外退出必须显式重开整个库，不能只重启空侧车后继续使用旧句柄。
 */
export function createVectorStore(ctx, raw = {}) {
  const path = typeof raw.path === 'string' && raw.path !== '' ? raw.path : defaultPath()
  let db = null
  let opening = null
  let closing = null
  let disposed = false
  const collections = new Map()
  const datasets = new Map()
  const assertActive = () => {
    if (disposed) throw new Error('vectorStore 已关闭')
  }
  const log = (message) => ctx.logger?.info?.('dsh-vectordb: ' + message)

  function ensureDb() {
    assertActive()
    if (db !== null) return Promise.resolve(db)
    if (opening !== null) return opening
    opening = (async () => {
      const binary = await prepareSidecarBinary(raw)
      const opened = await openVectorDB({
        path, binary, autoRestart: false,
        requestTimeoutMs: raw.requestTimeoutMs ?? 30000,
        onLog: log,
      })
      db = opened
      return opened
    })().finally(() => { opening = null })
    return opening
  }

  // 缓存的是正在打开的 Promise：两个消费者第一次同时请求时也只有一次 create。
  function cached(map, nm, operation) {
    assertActive()
    if (typeof nm !== 'string' || !nm.trim()) return Promise.reject(new Error('名称不能为空'))
    if (map.has(nm)) return map.get(nm)
    const pending = operation().catch((error) => {
      if (map.get(nm) === pending) map.delete(nm)
      throw error
    })
    map.set(nm, pending)
    return pending
  }

  function collection(nm, options = {}) {
    return cached(collections, nm, async () => {
      const opened = await ensureDb()
      const names = (await opened.listCollections()).map((item) => typeof item === 'string' ? item : item.name)
      return names.includes(nm) ? opened.openCollection(nm) : opened.createCollection(nm, {
        engine: options.engine ?? 'hnsw',
        dimension: options.dimension,
        distanceMetric: options.distanceMetric ?? options.metric ?? 'cosine',
        ...(options.initialPoints === undefined ? {} : { initialPoints: options.initialPoints }),
      })
    })
  }

  function dataset(nm, options) {
    const pending = cached(datasets, nm, async () => {
      const opened = await ensureDb()
      const names = (await opened.listDatasets()).map((item) => item.name)
      if (!names.includes(nm)) {
        if (!options?.embeddings) throw new Error('创建 dataset 需要 embeddings 字段定义')
        return opened.createDataset(nm, options)
      }
      return opened.openDataset(nm)
    })
    if (!options?.embeddings) return pending
    return pending.then(async (handle) => {
      // 包括命中缓存的调用：相同名字不同维度不能悄悄复用。
      const stats = await handle.stats()
      for (const [field, schema] of Object.entries(options.embeddings)) {
        const existing = stats.embeddings?.[field]
        if (!existing || existing.dimension !== schema.dimension ||
            (existing.distanceMetric || 'cosine') !== (schema.distanceMetric || 'cosine')) {
          throw new Error('dataset 字段契约不匹配：' + nm + '/' + field)
        }
      }
      return handle
    })
  }

  return {
    path,
    retrieval,
    isOpen: () => db !== null && !disposed,
    collection,
    dataset,
    async list() {
      return (await (await ensureDb()).listCollections()).map((item) => typeof item === 'string' ? item : item.name)
    },
    async listDatasets() {
      return (await ensureDb()).listDatasets()
    },
    async checkpoint(nm) {
      return (await collection(nm)).checkpoint()
    },
    close() {
      if (closing !== null) return closing
      disposed = true
      closing = (async () => {
        // 包括 close 与首次 open 并发的情形：先等已开始的打开，再释放唯一连接。
        await Promise.allSettled([opening, ...collections.values(), ...datasets.values()])
        const current = db
        db = null
        collections.clear()
        datasets.clear()
        if (current !== null) await current.close()
      })()
      return closing
    },
  }
}

export function apply(ctx, config = {}) {
  if (ctx.get(SERVICE) !== undefined) throw new Error('vectorStore 已由其他插件提供')
  const store = createVectorStore(ctx, config)
  ctx.provide(SERVICE, store)
  ctx.effect(() => () => {
    void store.close().catch((error) => ctx.logger?.warn?.('dsh-vectordb: 关闭失败：' + error.message))
  }, 'dsh-vectordb: 收掉 sidecar')
}
