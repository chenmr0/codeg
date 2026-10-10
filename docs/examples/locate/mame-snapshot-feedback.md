# 需求：手动截图后显示保存结果

## 背景

在 MAME 运行游戏时，用户触发截图后，希望直接在游戏画面中知道截图是否保存成功，不必再到截图目录或控制台检查。

以下说明合并了产品需求和历史技术讨论。讨论中的名称可能来自不同功能、旧版本或设计草案，尚未逐一核实。请结合需求判断哪些源码值得阅读，不要把所有提到的名称都当作需要修改的对象。

## 期望行为

1. 手动截图成功后，显示一条短暂的界面提示，说明截图已保存，并提供保存位置。
2. 截图目录无法写入、文件创建失败或图片写入失败时，显示失败提示和简短原因，不能误报成功。
3. 多屏幕模式下一次操作可能保存多张图片。完成本次截图后统一提示成功与失败数量；部分失败时明确说明，不连续弹出多条提示。
4. 提示在本次图片捕获完成后出现，避免把本次保存结果提示拍进本次截图。

## 业务讨论中的技术线索

### 操作入口

用户在游戏画面中触发 `IPT_UI_SNAPSHOT` 后，应完成本次截图并收到结果反馈。之前排查时有人提到 `mame_ui_manager::handler_ingame` 和 `video_manager::save_active_screen_snapshots`，可以从这些入口了解操作如何传到保存流程。

另一份交互草案中使用了 `IPT_UI_SCREENSHOT_RESULT` 这个名称，表示“截图结果事件”。请核实当前版本是否有对应机制，本需求不要求新增按键或事件类型。

### 保存过程与错误反馈

截图需要先得到画面，再写入文件。讨论中提到 `video_manager::create_snapshot_bitmap`、`video_manager::save_snapshot` 和 `util::png_write_bitmap`。需要确认哪个环节能判断图片真正写入成功，不能只凭文件创建成功就提示成功。

此前也有人建议直接调用 `video_manager::save_snapshot_with_feedback`，认为它已经包含结果反馈。这个说法需要核实；如果当前源码没有这个接口，应依据现有实现寻找可用线索。

### 保存位置与命名

保存位置沿用 `emu_options::snapshot_directory`，命名规则沿用 `emu_options::snap_name`。有人提到 `video_manager::open_next` 负责选取文件名，还提到 `emu_file::open` 与 `emu_file::fullpath`，希望确认最终实际使用的路径，并在失败时获得可读的原因。

### 界面提示

项目中其他功能似乎使用 `running_machine::popmessage` 显示短暂提示；旧方案笔记则写着 `SnapshotNotificationService` 负责汇总截图结果。请核实当前版本有哪些可复用能力。

讨论中还出现过 `snapshot_feedback_enabled` 开关。业务希望此反馈默认提供，本次不增加新的配置项，也不要求沿用草案中的开关设计。

### 相邻功能的边界

录像讨论里出现过 `video_manager::begin_recording_screen` 和 `video_manager::record_frame`。它们可能共享部分图像处理逻辑，但这次不改变录像的开始、逐帧写入或提示行为。

快捷存档和读档涉及 `running_machine::schedule_save`、`running_machine::schedule_load`。它们也包含“保存”“失败提示”等相似概念，但本次需求只处理截图，不改变存档和读档行为。

## 讨论中的流程草案和代码摘录

### 期望流程的伪代码

下面仅表达期望行为，变量和调用写法不代表当前项目已经提供这些接口。

```text
收到 IPT_UI_SNAPSHOT：
    本次结果 = []
    对每个需要截图的画面：
        结果 = video_manager::save_snapshot_with_feedback(画面)
        本次结果.追加(结果)
    等本次所有画面捕获完成后：
        SnapshotNotificationService.显示汇总(本次结果)
```

这里希望表达的是“一次操作统一反馈”，不要求按草案里的接口名称实现。

### 排查时复制的保存片段

下面是当前源码中的局部语句，省略了外围函数和分支。需要结合它所在的完整函数理解失败处理，不能仅凭这个片段判断整个保存流程是否成功。

```cpp
emu_file file(machine().options().snapshot_directory(), OPEN_FLAG_WRITE | OPEN_FLAG_CREATE | OPEN_FLAG_CREATE_PATHS);
std::error_condition const filerr = open_next(file, "png");
if (!filerr)
    save_snapshot(nullptr, file);
```

另一个排查片段如下。这里发现写入失败后会输出错误，希望界面提示也能反映这种失败。

```cpp
std::error_condition const error = util::png_write_bitmap(file, &pnginfo, m_snap_bitmap, entries, palette);
if (error)
    osd_printf_error("Error generating PNG for snapshot (%s:%d %s)\n", error.category().name(), error.value(), error.message());
```

### 基于摘录写下的改动草案

有人据此写了下面的 C++ 风格草案，混用了现有调用和设想的返回值；尚未编译验证，也不是当前源码的原样摘录。

```cpp
auto result = save_snapshot(nullptr, file);
if (result.success)
    machine().popmessage("截图已保存：%s", file.fullpath());
else
    machine().popmessage("截图保存失败：%s", result.reason);
```

请核实现有保存接口是否能够返回这些信息。草案中的返回值、字段和局部变量仅用于说明需求，不要求项目中已经存在同名定义。

## 范围约束

- 沿用现有截图目录、文件命名规则和 PNG 格式。
- 沿用现有界面提示机制，不新增对话框或配置项。
- 仅针对用户主动触发的截图；自动截图和录像不新增提示。
- 本轮先定位源码，不修改 MAME 的实现。

## 验收场景

- 单屏截图成功：生成图片，显示保存成功及位置。
- 目标目录不可写：显示失败原因，不显示成功。
- 文件创建成功但图片写入失败：仍然显示失败。
- 多屏截图全部成功：显示成功数量和保存位置。
- 多屏截图部分失败：显示成功与失败数量，并给出简短失败原因。
- 自动截图或录像：保持原有行为。
