# 开发状态（2026-10-11）

本轮将已有修改按 Dataset 服务、检索适配契约、安装声明和本地备份忽略规则分别提交，没有发布新版本或修改运行中的宿主组合。

- Dataset 句柄共享、不同维度字段、稀疏实体、持久化重开、字段契约检查和关闭竞态已有实现。
- retrieval-contract 是结构下基础召回的原型；查询插件尚未消费它，不能据此宣称已完成通用记忆召回。
- package.json 的底层依赖仍是 file:../s-forge/packages/vectordb-node，必须在相邻开发工作区使用。侧车缓存解决运行位置问题，不能代替底层包和平台产物的正式分发。
- bundle patch 仅保存已有的 Host 安装声明；本次没有把它安装到现场，也没有验证正式管理器安装链路。

本次必要验证使用 `pnpm exec node --test --test-reporter=dot test/host.test.js test/dataset.test.js test/retrieval-contract.test.js`，15 项通过。测试使用本机底层包与真实侧车，不证明单仓独立安装或完整应用验收。

未纳入提交的 scripts 是带本机路径的记忆库诊断/迁移副本工具；历史施工检查点、真实记忆备份和运行日志保留本地。没有执行这些诊断脚本或打开活跃记忆库。
