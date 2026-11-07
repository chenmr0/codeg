# 自动重建策略

`codegraph sync`、MCP 启动补同步和文件监听使用同一套规则。在正常扫描得到实际变更后，小改继续增量；达到启用规则的阈值时，建立候选库，验证完成后切换并回收旧库。

规则按变更规模判断，不预测耗时。满足阈值不保证重建更快，例如对许多大文件追加少量代码，增量可能仍明显更快。可以根据项目实测调整规则。

## 项目配置

在项目根目录放置可选文件 `.codegraphrc.json`。没有文件时使用下面的默认值；可以只填写需要覆盖的字段。

```json
{
  "sync": {
    "adaptive": {
      "enabled": true,
      "rules": {
        "fileScale": {
          "enabled": true,
          "minChangedFiles": 128,
          "minChangedFraction": 0.25,
          "minWorkFraction": 0.25
        },
        "oldNodeScale": {
          "enabled": true,
          "minAffectedOldNodes": 10000,
          "minAffectedOldNodeFraction": 0.25
        }
      }
    }
  }
}
```

启用的两条规则之间使用 OR。

- 文件规则同时要求增、改、删文件数达到数量和比例门槛，且修改/新增文件的目标字节占比或修改/删除文件的旧节点占比达到 `minWorkFraction`。
- 节点规则同时要求修改/删除文件原有节点数达到数量和比例门槛。它可以在变更文件少于 128 个时独立触发。

文件比例的分母是新旧文件总数的较大值。字节比例的分母是目标源码总字节，节点比例的分母是旧索引总节点。受影响旧节点来自每个文件原有的 `nodeCount`，不计算传递依赖。只改 mtime、内容相同的文件不会计入内容变化。提取版本或解析配置改变时，需要重新提取的文件也属于工作量。无变化或目标源码为空时沿用增量处理。

关闭自动重建，仍正常同步并保留健康空同步的只读路径：

```json
{"sync":{"adaptive":{"enabled":false}}}
```

只启用文件规则：

```json
{"sync":{"adaptive":{"rules":{"oldNodeScale":{"enabled":false}}}}}
```

同时提高两条规则的比例要求，例如按项目实测采用 50%：

```json
{
  "sync": {
    "adaptive": {
      "rules": {
        "fileScale": {"minChangedFraction": 0.5, "minWorkFraction": 0.5},
        "oldNodeScale": {"minAffectedOldNodeFraction": 0.5}
      }
    }
  }
}
```

关闭两条规则也等同于关闭自动重建。数量必须是正的安全整数，比例必须在 `(0,1]`，开关必须是 JSON 布尔值。文件上限 64 KiB。未知字段、非法 JSON、数值错误、文件不可读等情况会明确告警，并关闭本次自动重建、继续增量。

只识别项目根目录的这个文件，不查父目录，不继承子目录，不执行表达式。`.codegraphignore` 仍负责决定哪些源文件纳入索引。

## 生效时机与调用覆盖

每次同步开始读取一次 `.codegraphrc.json`。预判、写锁内复核和发布子进程沿用同一份重建策略。同步过程中调整阈值或规则，会在下一次同步生效。

策略文件变化本身不主动启动同步，不会使同内容源文件重新提取。普通源文件事件会在下一次同步使用新配置。匿名的系统文件事件仍可触发已有的全目录核对，以防丢失源码变化。

SDK 显式字段覆盖项目字段，项目字段覆盖默认值：

```ts
await graph.sync({
  adaptive: true,
  adaptiveFallback: { minChangedFiles: 256 },
  adaptiveRules: { oldNodeScale: false },
});
```

`adaptiveFallback` 只覆盖指定阈值，不自动开启已关闭的规则。`adaptive:true` 可以覆盖合法项目配置的总开关。`CODEGRAPH_ADAPTIVE_SYNC=0`、内部强制 `adaptive:false` 和无效配置均会禁止重建。数据库、磁盘空间、写锁及发布校验等限制不受阈值配置覆盖。发布后尚未完成的源码补查仍会执行。

## 日志与兼容

`sync -v` 和 `.runtime/adaptive-sync.log` 包含策略来源、有效阈值、规则开关、变更计数/比例和命中规则。启用重建的决定使用 `structural-large-change`，完成发布后补查还会记录 `event: "sync-complete"`。只凭一条重建决定不能认定切库已成功。

自动决策不读取、训练或保存历史耗时样本，旧 `adaptive-cost-history.json` 和库内历史值留在原处并忽略。默认固定路径索引（包括项目内 `CODEGRAPH_DIR` 覆盖目录）无需来源标记；旧 `CURRENT` 存储仍遵守原有来源和生命周期约束，但也使用同一组结构规则与配置。

保留 `adaptive`、`adaptiveFallback` 和诊断回调。类方法 `getPortableCostHistory` / `setPortableCostHistory` 已弃用，显式调用仍可读写历史值，但不改变策略。决策类型中原本可选的预计耗时字段继续可用，新决策不填充它们。内部 `dist/sync/adaptive-plan` 的成本预测、样本读写函数已移除，直接依赖这些内部导出的调用方应改用公开 `sync` 选项。

## 建库期间继续开发

自动重建在独立数据库中进行，期间仍可查询旧索引。建库时修改、新增、删除或重命名源码，或用 Git 切换分支，成功构建的候选库通过完整性和运行环境校验后即可接替旧库。

切换后，同一次 `sync` 会按文件内容核对新库与当前工作区，补齐差异后才报告完成。`.codegraphignore` 的变化会更新收录范围。编译命令、模块解析配置或识别到的框架发生变化时，追平会重新提取，必要时涉及全部文件。若只有项目级宏定义发生变化，会重新提取 C、C++ 和 Objective-C 文件，同时处理其他语言中实际改动的文件。

在切库与追平完成之间，查询可能仍反映建库期间的内容。若此时中断，待追平状态会留在已发布的库里，下次 `sync` 取得写锁后继续处理。
