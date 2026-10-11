# dsh-vectordb

**DeepSeek Harness 的向量库服务。** 把 S-forge 的 ANN 引擎（DiskVamana / DiskANN 与内存 HNSW，走 stdio sidecar）接成 host 服务，供本进程内任何插件做语义检索。

内核来自 [s-forge](https://github.com/leolee9086/siyuan) 的 `packages/vectordb`（Go）与 `packages/vectordb-node`（Node 绑定）。**能力在内核，这一层只做适配。** 本文档以中文为主。

## 它解决什么

向量检索的难点不在"存一个向量、按余弦找最近的" —— 而在几件没人愿意在每个插件里重写一遍的事：

- **sidecar 是独立进程，且持有数据库目录的跨进程独占锁**：同一进程里开两次会互相打架（第二个拿到 `database_locked`）。本插件把它收成**懒启动的单例**；
- **数据放哪**：统一在 `$DSH_HOME/vectors/vectordb`，跟 storages 并列，不让每个消费者自己编路径；
- **稳定契约**：别的插件用 `ctx.get('vectorStore')`，而不是各自 `import` 那份库、各自管生命周期；
- **收尾**：插件卸载时把 sidecar 收干净（`ctx.effect` 的 dispose 里关库），不然进程会留孤儿。

## 用法

```js
// 1) 在 cordis.patch.yml 里挂上（host 侧，需重启）
//    - id: vectordb
//      name: "file:///D:/dev/dsh-vectordb/src/host.js"

// 2) 别的插件这么用 —— 未在 inject 里声明的可选依赖用 ctx.get
const store = ctx.get('vectorStore')

const col = await store.collection('memories', { dimension: 1024, metric: 'cosine', engine: 'hnsw' })
await col.write([{ id: 'm1', vector: new Float32Array(1024), meta: { tag: 'commit' } }])
const hits = await col.search(queryVector, { topK: 5 })   // [{ id, score, distance, meta }]
await store.checkpoint('memories')                        // 写多了之后合并 WAL
```

### 服务面

| 成员 | 说明 |
|---|---|
| `path` | 库文件在哪（诊断用） |
| `isOpen()` | 库开没开（懒启动之后才有意义） |
| `collection(name, options)` | 拿 collection 句柄。**幂等**：同名返回同一个句柄；第一次建、之后开 |
| `list()` | 列出现有的 collection 名 |
| `checkpoint(name)` | 合并 WAL 与墓碑、原子发布新代际 |
| `close()` | 关库并收掉 sidecar（正常卸载由 `ctx.effect` 调，不用手动） |

`collection()` 的选项：`dimension`（建库必填）、`metric`（`l2` / `cosine` / `ip`，默认 cosine）、`engine`（`hnsw` / `disk-vamana`，默认 hnsw）、`initialPoints`（DiskVamana 建库必须给初始点集）。

## 边界

- **这不只是一张给 DSH 的脸。** 同一内核会长出别的面（MCP / HTTP / 其它 agent）。**别改这一层去迁就它们** —— 那是在内核与 Node 绑定之上再加一张脸，跟 `src/host.js` 平级；
- **向量库只管存，不管向量从哪来。** 向量由**调用方**提供 —— 谁需要检索谁自己算（用哪个模型、走哪条推理路径，都是它自己的事）。这一层不认识任何嵌入模型，**于是也就不必替一堆模型做适配**。换嵌入模型时这里要动的只是"加一个命名字段"，不需要改代码；
- **多命名嵌入**：`store.dataset(name, { embeddings, indexes })` 直接暴露底层 Dataset 句柄，支持不同维度字段、稀疏字段、检索和 RRF 融合。`listDatasets()` 列出现有数据集。字段身份和模型版本由调用方管理；上层更换契约时使用新代际并回填，不能混用不同语义空间。
- **生命周期**：并发打开同名句柄共享一次创建；`close()` 等待正在打开的连接清理完毕，关闭后的服务不可重用。侧车异常退出不会自动重启成一个空数据库并继续使用旧句柄，需要重建服务实例。

## 依赖

- `@leolee9086/vectordb`（Node 绑定，内含已经编好的 `bin/vectordb-sidecar.exe`）。开发期用 `file:` 指向本地包，发布时改版本号；
- 运行时不需要原生构建（sidecar 是预编译的独立进程）。

## 测试

```bash
node test/host.test.js      # 端到端：真拉起 sidecar、真写、真搜
```

使用 `pnpm test` 运行集合、多字段融合、稀疏字段和关闭竞态的真实侧车测试。

Windows 下的工作区产物可能继承 Low 完整性标签，即使从普通终端启动也不能写普通临时目录。宿主默认按 SHA256 将侧车字节安装到 `$DSH_HOME/cache/vectordb-runtime`，新文件继承安装目录权限，再从该位置启动；工作区 ACL 和调用者令牌保持原有约束。缓存安装不能提升受限调用者的权限，缓存位置也必须适合宿主正常执行。

部署配置支持 `binary`、`binaryCachePath`、`cacheBinary`（Windows 默认为 true）、`path`、`requestTimeoutMs`（默认 30000）。明确设置 `cacheBinary: false` 可直接运行指定产物。默认数据仍在 `$DSH_HOME/vectors/vectordb`；测试使用一次性目录。

## 许可

MIT。

---

如果这个东西帮到了你，欢迎通过 [爱发电](https://afdian.net/a/leolee9086) 支持 —— 家里最近不太宽裕，每一份都是实在的帮助。

也欢迎看看同一系列的其他插件：[DSH 插件总览](https://github.com/leolee9086?tab=repositories)。
