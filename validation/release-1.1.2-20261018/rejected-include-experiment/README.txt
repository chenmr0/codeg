未采用的 include 来源约束方案（2026-10-18 用户授权撤回）

cpp-macro-visibility.experiment.ts 是从 a4b9a38 原样保留的22项实验测试，不属于常规vitest套件；它依赖已撤回的macro-visibility模块，不能在恢复后的产品上解释为通过。
完整回放请在独立目录检出a4b9a38，并运行其原 __tests__/cpp-macro-visibility.test.ts。
第一项 unrelated header addition/removal 是原TestBody缺陷证据；它在30d确实失败，不以skip或改期待值伪装修复。最早3c12493提交、repro-baseline.log及完整证据包保存失败结果。
保留常规cpp-macro-preprocessing-order.test.ts的6项编译器依据测试：这些不依赖来源方案，验证原有预处理顺序，并不声称污染已解决。

撤回原因：真实编译器确认本地DECL经forced/computed include调用HELPER时合法A丢失；四对AB/BA显示TS/native小变更仍有约5%中位额外成本。所有src恢复30d；提取版本恢复36，来源扫描/worker载荷/递归限制/附属优化全部移除。schema9断言独立保留。
