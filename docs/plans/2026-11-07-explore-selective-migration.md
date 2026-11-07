# Explore 查询能力选择性迁移

## 发布范围

本分支只发布查询实现、必要依赖、许可证、回归测试与本说明。仓库级验收材料、源码摘录、图关系、查询响应、冻结清单、运行日志及相关元数据不纳入本分支；完整交付另行保留。原本地提交不受本次发布影响。

## 代码边界

- 从同步策略分支整合活跃 MCP Explore 查询入口、原生图适配器、统一查询解析、精确目标和声明身份、图遍历、源码漂移校验、预算窗口、缓存与会话处理。
- 社区实现固定 f72c9d2efb14454ff4f9fd7b8460abd82f19a287；来源与许可证见 src/upstream-explore/MIGRATION.md 和 UPSTREAM_LICENSE。
- 保留查询期语法资源与打包脚本，不依赖外部隐式下载。
- 原生索引和提取语义保持目标分支行为。C/C++ owner 比较隔离在查询路径，不修改共享 resolver。
- 保留批量工具、内部 ripgrep 兜底以及其他调用方使用的共享 context/graph 实现。
- 不迁入已被活跃查询链替代的旧试验模块，不恢复已撤回的预算调整。

## 回归入口

执行 npm ci、npm run build。查询回归包括 __tests__/explore-*.test.ts、adaptive-explore-sizing.test.ts 和 upstream-native-integration.test.ts；vitest.upstream.config.ts 提供固定社区套件入口。既有测试缺陷及索引功能差异不应通过修改查询断言掩盖。

## 行为变化

查询支持自然语言和结构化目标；按查询类型选择文件和窗口预算，输出包含缺口提示。预算针对正文分配，包装信息不承诺严格落在名义字符上限内。精确目标保护与查询缓存以实际源码及图状态为准。
