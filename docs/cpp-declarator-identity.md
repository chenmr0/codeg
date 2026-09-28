# C/C++ 声明身份修复（main-ch-new）

本批基于 `f48e208`，修复两个边界明确的问题：健康 typedef 的名字来自真正声明符；匿名枚举的底层类型不再被当成枚举名字。

## 行为变化

- `typedef Existing Alias;` 只在该位置声明 Alias，保留其他位置真实的 Existing 定义。
- `typedef Existing Alias, *Pointer, Array[4], (*Callback)(int);` 提取四个声明符，不把参数、数组长度或基础类型当成新别名。
- C/C++ 的无错误 typedef 沿已知指针、引用、数组、函数和括号包装寻找名称；有错误或不支持的包装继续使用原恢复路径。其他语言不切换到新路径。
- `enum : u32 { VALUE };` 以及限定底层类型形式按匿名枚举处理，VALUE 保持在外层作用域；正常具名/scoped 枚举保持原行为。
- 现有 typedef tag/主名展示方式不做一般性修改；只避免把匿名枚举的底层类型再当作 tag 补建。

没有加入按宏名删除符号、全局空宏擦除、初始化器宏过滤或完整预处理器改造。

## 存量索引

提取版本从 main-ch-new 的 24 提升为 25，本批仅考虑该分支的升级路径，数据库 schema 不变。旧索引仍可读取；为了清理未变化文件中的旧伪节点和错误归属，发布后应执行 `codegraph index --force` 全量重建。普通 sync 不能保证重新提取所有未变化文件。

## 已完成的验证

- 构建通过。
- 27 个相关测试文件、757 项测试通过，覆盖 C/C++、跨语言提取、原有宏恢复、typedef tag 兼容、声明/定义与引用解析。
- 新增 sync 测试比较变化后的增量数据库与全新全量索引：节点和全部持久化关系边一致，旧符号移除，无悬挂边。
- 在冻结 MAME/OceanBase 的 45 个真实文件中对比完整项目宏上下文下的提取：48 条 typedef 基础类型伪别名和 2 条枚举误名均消除，真正别名及枚举成员保留，没有新增提取告警。完整文件差异仅涉及 type_alias/enum 节点增删；枚举成员限定名随 owner 修正。
- Windows 上跨语言测试默认子进程曾出现 V8 Zone 内存异常；向测试子进程显式传递 `--liftoff-only --no-wasm-tier-up` 后完整回归通过。这是测试运行配置，没有更改产品启动参数或内存限制。

真实证据与运行日志保存在本任务工作区 `artifacts/main-symbol-fixes-staging/` 的 `real-verify.json`、`preserved-symbols.json`、`regression-final.log` 和 `benchmark.json`。耗时实验只覆盖所选 45 文件的进程内提取，不代表全量 init/sync 或峰值内存基准。

## 保留的边界

复杂调用约定宏和损坏的成员函数指针 typedef 仍可能走旧恢复路径。当前 grammar 将部分 `enum [[...]]` 解析为 attributed_statement，而不是 enum_specifier；本批保护邻接声明，不扩大为正则恢复整类语法。全局宏污染、纯宏头文件语言选择及宏实参残留清理留在独立修复中。
