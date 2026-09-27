/**
 * dsh-vectordb —— 把 s-forge 的 ANN 引擎接成 DSH 的 host 服务。
 *
 * **这一层只做适配，不做能力。** 能力在内核（`s-forge/packages/vectordb`，Go，DiskVamana / HNSW）
 * 与它的 Node 绑定（`@leolee9086/vectordb`，stdio sidecar）里；这里解决的是三件库不该管的事：
 *
 * 1. **进程与生命周期**：sidecar 持有数据库目录的跨进程独占锁，所以本进程内**只能有一个实例**。
 *    多个插件各开一次会互相打架（第二个拿到 `database_locked`）。这里把它收成一个懒启动的单例。
 * 2. **数据放哪**：统一放 `$DSH_HOME/vectors/`，跟 storages 一个位置，不让每个消费者自己编路径。
 * 3. **稳定契约**：对别的插件暴露 `ctx.get('vectorStore')`，而不是让它们各自 import 库。
 *
 * **别的消费者要走别的面**（MCP / HTTP / 其它 agent）时，别改这里 —— 那是在内核与 Node 绑定之上
 * 再加一张脸，跟本文件平级。这是「同一内核、多个面」那条分层。
 *
 * @module dsh-vectordb/host
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openVectorDB } from '@leolee9086/vectordb'

export const name = 'dsh-vectordb'

/**
 * 服务名。别的插件用 `ctx.get('vectorStore')` 取（未声明的可选依赖必须用 ctx.get，
 * 不是 ctx.vectorStore —— 属性代理只认声明过的注入）。
 */
export const SERVICE = 'vectorStore'

/** 默认的库文件位置：跟 storages 并列，别散在工作区里。 */
function defaultPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'vectors', 'vectordb')
}

/**
 * 装这个服务。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} [raw] 配置。
 * @param {string} [raw.path] 库目录，默认 `$DSH_HOME/vectors/vectordb`。
 * @param {boolean} [raw.autoRestart] sidecar 意外退出后是否自动拉起，默认 true。
 * @returns {object} 服务对象。
 */
export function createVectorStore(ctx, raw = {}) {
  const path = typeof raw.path === 'string' && raw.path !== '' ? raw.path : defaultPath()
  const autoRestart = raw.autoRestart !== false

  /** 已打开的库（懒启动后的单例）。 */
  let db = null
  /** 正在打开的那次；并发调用共享它，避免同时拉起两个 sidecar。 */
  let opening = null
  /** 已拿到的 collection 句柄，按名字缓存 —— 句柄本身是幂等的。 */
  const handles = new Map()

  const log = (message) => {
    // sidecar 的 stderr 原样转成宿主日志：出问题时能在这里看到它自己的说法。
    if (typeof ctx.logger?.info === 'function') ctx.logger.info('dsh-vectordb: ' + message)
  }

  async function ensureDb() {
    if (db !== null) return db
    if (opening !== null) return opening
    opening = openVectorDB({ path, autoRestart, onLog: log })
      .then((opened) => {
        db = opened
        opening = null
        return opened
      })
      .catch((error) => {
        opening = null
        throw error
      })
    return opening
  }

  /**
   * 拿一个 collection 句柄。同名重复调用返回同一个句柄。
   *
   * 建库与开库分开判断：`createCollection` 对已存在的名字会抛，所以先列一次再决定建还是开 ——
   * 这样调用方不用关心"这是第一次还是第二次"。
   *
   * @param {string} name collection 名。
   * @param {object} [options] 第一次创建时的选项。
   * @param {number} options.dimension 维度（建库必填）。
   * @param {string} [options.metric] `l2` / `cosine` / `ip`，默认 cosine。
   * @param {string} [options.engine] `disk-vamana` / `hnsw`，默认 hnsw。
   * @param {Array<object>} [options.initialPoints] DiskVamana 建库必须给初始点集。
   * @returns {Promise<object>} collection 句柄。
   */
  async function collection(nm, options = {}) {
    const cached = handles.get(nm)
    if (cached !== undefined) return cached
    const opened = await ensureDb()
    const existing = await opened.listCollections()
    const names = (Array.isArray(existing) ? existing : []).map((item) => (typeof item === 'string' ? item : item?.name))
    const handle = names.includes(nm)
      ? await opened.openCollection(nm)
      : await opened.createCollection(nm, {
        engine: options.engine ?? 'hnsw',
        dimension: options.dimension,
        distanceMetric: options.metric ?? 'cosine',
        ...(options.initialPoints === undefined ? {} : { initialPoints: options.initialPoints }),
      })
    handles.set(nm, handle)
    return handle
  }

  return {
    /** 库文件在哪 —— 诊断时想知道"数据到底写哪了"。 */
    path,
    /** 库开没开（懒启动后才有意义）。 */
    isOpen: () => db !== null,
    collection,
    /** 列出现有的 collection 名。 */
    async list() {
      const opened = await ensureDb()
      const existing = await opened.listCollections()
      return (Array.isArray(existing) ? existing : []).map((item) => (typeof item === 'string' ? item : item?.name))
    },
    /** 合并 WAL 与墓碑、原子发布新代际。写多了之后调一次。 */
    async checkpoint(nm) {
      const handle = await collection(nm)
      return handle.checkpoint()
    },
    /** 关库并收掉 sidecar 进程。正常卸载时由 ctx.effect 调，不需要手动调。 */
    async close() {
      const current = db
      db = null
      handles.clear()
      if (current === null) return
      await current.close()
    },
  }
}

/**
 * 插件入口。
 *
 * 不声明任何 `inject`：本插件不依赖别的服务，别的插件依赖它。
 * 卸载时通过 `ctx.effect` 把 sidecar 收干净 —— 不清的话进程会留下一个孤儿。
 *
 * @param {object} ctx 插件上下文。
 * @param {object} [config] 见 {@link createVectorStore}。
 */
export function apply(ctx, config = {}) {
  const store = createVectorStore(ctx, config)
  // 服务名全局唯一：已经有了就不再注册（同一个进程里注册两次会让插件挂载失败）。
  if (ctx.get(SERVICE) === undefined) {
    ctx.provide(SERVICE, store)
  }
  ctx.effect(() => () => {
    // 卸载是同步的，关库是异步的：不阻塞卸载，但失败了要留下痕迹。
    void store.close().catch((error) => {
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn('dsh-vectordb: 关库时出错: ' + (error instanceof Error ? error.message : String(error)))
      }
    })
  }, 'dsh-vectordb: 收掉 sidecar')
}
