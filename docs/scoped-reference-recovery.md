# Scoped reference recovery

## Stage 1 committed reference sources

A modified-file replacement can preserve incoming edges by semantic identity.
When an old target cannot be matched, stamped incoming edges become pending
references from unchanged source files. These sources are now reported by the
main store, the store-worker response after transaction commit, and single-file
fallback indexing. Sync resolves those sources directly; late fallback stores
have their own second drain.

Resolving base references does not prove synthesized relationships are current.
The store therefore atomically records `index_rewire_synthesis_pending` with
resurrected references before destructive replacement. The rewiring plan is
pure; if the obligation cannot be persisted, the old file has not been deleted.
The worker retains its existing whole-file transaction. On the main thread,
this protects the resurrected references without claiming that all other file
replacement writes have become one transaction. Any present value requires
full synthesis recovery.
Only a successful full tail clears it. Failed stores, failed synthesis and
process interruption cannot certify completion merely because pending rows
were consumed. Existing explicit incomplete/unknown coverage remains separate.

This first stage is a correctness and observability foundation, not a claim
that full synthesis has been eliminated. It is deliberately conservative:
when another file in the same batch later replaces a resurrected caller, the
obligation still survives until full synthesis. Planned writes are not proof
that the write, resolution or derived-edge recovery actually succeeded.

Legacy no-op behavior is unchanged: absent obligations do not create new input
records or trigger a global macro scan/full synthesis. Further producer-specific
recovery requires independent dependency evidence and validation; unknown
impact must retain the full fallback.

Verbose sync output includes `recovery-plan` (reported source files, resolved
references, remaining pending rows, persisted obligation and full-pass choice)
and `fallback-reference-sources` for late stores. These are stage diagnostics,
not wall-time performance guarantees.

## 第二阶段：减少合成时的整文件拆行

`source-lines.ts` 对正常的一基、闭区间行号通过 LF 位置提取片段，避免每个候选方法都对整份源码 `split` 并分配行数组。合成器原有的六处行范围读取共同使用这一内部 helper，读取源码的时点、候选遍历与派生边顺序保持原样。

语义仍与原 `split('\n').slice(startLine - 1, endLine).join('\n')` 一致：保留 CR 和 UTF-16 字符、文件末尾空行及越界结果。原先缺失或零值行号返回 `null`；负数、小数、无穷等异常边界仍走原表达式。

这项优化降低必要合成的计算和临时分配开销，不跳过完整合成，也不新增跨同步缓存、数据库迁移或旧库补建任务。C++ 类缓存与批量查询只做了外部对照试验，因收益不稳定未纳入产品。

## Fallback 写入后的解析缓存

大分支对照发现：晚期 fallback 替换节点 ID 后，旧的文件节点及父类缓存可能仍指向已删除的 ID，使继承方法被误当作不可见，退回无关的同名函数。提前定向恢复改变了缓存驻留，暴露出这条既有阶段边界缺口。

fallback 写循环现在在 `finally` 中结束 resolver 缓存 epoch，然后再解析成功重建文件和其关联来源。正常完成、部分写入失败和 WAL gate 异常均清除过期缓存，持久重试日志仍按原生命周期保留。没有 fallback 的健康空同步不新增清理。候选匹配和继承规则不变。
