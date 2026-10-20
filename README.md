# dsh-desktop-organizer

一个 DeepSeek Harness 插件，用来整理 Windows 桌面。

它解决三件事：

1. **归类**桌面上已有的快捷方式（AI 与大模型 / 开发工具 / 数据库 / 办公与文档 …）。
2. **为没有快捷方式的程序创建快捷方式**，并直接放进对应分类文件夹 —— 也就是你「搜索才能找到」的那批。
   它通过 `shell:AppsFolder` 枚举系统里全部可启动程序（这台机器上是 267 个），再减去已有的，差额就是你要找的。
3. 标出**失效的快捷方式**（目标文件已不存在），并能**恢复被误归的分类文件夹**。

## 用法

### 在对话里用（agent 工具）

```
desktop_organize action="report"                      # 只读盘点
desktop_organize action="plan"                        # 预览整理方案，不动任何文件
desktop_organize action="apply"                       # 执行整理
desktop_organize action="shortcuts" dryRun=true       # 预览要创建哪些快捷方式
desktop_organize action="shortcuts"                   # 为所有缺失程序建快捷方式（按分类归档）
desktop_organize action="shortcuts" apps=["WorkBuddy","ChatGPT"]   # 只建这几个
desktop_organize action="repair"                      # 恢复被误归入 other/ 的分类文件夹
desktop_organize action="undo"                        # 撤销上一次整理或建快捷方式
desktop_organize action="plan" only=["ai","dev"]      # 只整理这两类
```

### 在 Web UI 里用

设置 → **桌面整理**。页面提供统计卡片、四个标签页（桌面分类 / 已归档 / 未在桌面 / 失效链接）、
以及「重新扫描 / 预览方案 / 执行整理 / 撤销」按钮。

在**未在桌面**标签页里可以勾选程序，点「为选中程序建快捷方式」，它们会被直接创建到对应分类文件夹中。

数据来自插件自己的同源接口 `/api/desktop-organizer/*`。

## 已修复的问题（v0.2）

第一版在真实桌面上跑过后暴露了三个缺陷，现已修复并加了回归测试：

| 问题 | 根因 | 修复 |
|---|---|---|
| 分类文件夹全被塞进 `other/` | 文件夹名「AI 与大模型」匹配不到英文正则，被判为 `other`，于是被自己创建的规则二次归档 | `classify()` 现在**优先按分类标签精确匹配**；`planOrganization()` 增加「永不移动自己的分类文件夹」硬保护 |
| WorkBuddy 没被识别为 AI 类 | 规则表里没有 workbuddy / codebuddy / qoder 等 agent 工具名 | 补充 agent 工具家族规则（workbuddy、codebuddy、jobster、codearts、qoder、cc switch、hermes …） |
| 已归档的快捷方式仍被报为「未在桌面」 | 只检查桌面根目录，不看分类文件夹内部 | 新增 `scanCategoryFolders()`，同时检查根目录与 `other/` 下的分类文件夹 |

另外新增：**用户自己的文件夹默认不再移动**（需 `includeFolders` 显式开启），
避免把 `plan/` 这类个人文件夹卷进分类桶。

## 它做了什么（本机实测）

| 指标 | 数值 |
|---|---|
| 桌面项目 | 14 |
| 已归档到分类文件夹 | 25 |
| 开始菜单快捷方式 | 222 |
| 系统可启动程序 | 267 |
| 未在桌面建快捷方式 | 242 |
| 完整扫描耗时 | 约 1.5 秒 |

## 安全设计

移动和创建文件这件事做错了会丢数据，所以规则是硬编码的：

- **只移动/创建，从不删除**，而且只动桌面根目录下的顶层项目。
- **不进入你已有的桌面文件夹** —— 文件夹里面的东西一律不碰。
- **永不移动本插件自己创建的分类文件夹**（这是第一版出错的直接原因）。
- **用户文件夹默认不移动**，需要显式开启。
- `desktop.ini`、`Thumbs.db`、Office 的 `~$` 临时文件永远不动。
- **「其他」类默认不整理**，避免把桌面变成一个杂物抽屉。
- 名称冲突时**加后缀，绝不覆盖**。
- 每次执行前先写完整**撤销快照**，中途崩溃也能还原。
- 单个文件失败（比如被占用）只记录并继续，不会中断整批。

## 安装

```powershell
dsh plugin --profile desktop add "D:\DeepSeek\harness\dsh-desktop-organizer"
```

或在 Web UI 的插件页安装本目录。

## 自定义分类规则

在 profile 的 `cordis.patch.yml` 里覆盖配置（patch 会整体替换 `config`）：

```yaml
- id: desktop-organizer
  name: 'dsh-desktop-organizer'
  config:
    cacheTtlMs: 60000
    rules:
      - id: ai
        label: AI 与大模型
        patterns: ['ollama', 'trae', 'cursor', 'workbuddy']
      - id: dev
        label: 开发工具
        patterns: ['vscode', 'docker']
```

`patterns` 是正则片段，会以 `|` 连接并加 `i` 标志。**顺序即优先级**，先匹配到的类别胜出；
没匹配上的归入 `other`。分类标签同时用于文件夹名，所以改 `label` 会改文件夹名。

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半身：注册 `desktop_organize` 工具和 HTTP 路由 |
| `client.js` | 浏览器半身：设置页里的「桌面整理」页面 |
| `scan.js` | 扫描与分类：桌面 / 开始菜单 / AppsFolder 三份清单合并，含分类文件夹与修复计划 |
| `organize.js` | 整理计划、执行、撤销，以及全部移动安全规则 |
| `shortcuts.js` | 为程序创建快捷方式（区分 Win32 与 MSIX 两种启动方式）与撤销 |
| `cordis.patch.yml` | bundle patch，把插件挂进 profile |

## 测试

```powershell
$node = 'C:\Users\xuzq\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node test-scan.mjs       # 扫描真实桌面，打印分类结果
& $node test-regress.mjs    # 回归：三个已修 bug 的断言（分类文件夹、WorkBuddy、文件名安全）
& $node test-shortcuts.mjs  # 沙箱里创建快捷方式，验证 explorer/AppsFolder 与 exe 两种目标
& $node test-organize.mjs   # 沙箱里跑 计划→执行→撤销 闭环（不碰真实桌面）
& $node test-host.mjs       # 用桩 ctx 验证工具注册、各 action、路由
& $node test-client.mjs     # 用桩 React/slot 验证 UI 半身注册
```

`test-organize.mjs` 会断言：`desktop.ini` 未被移动、`~$` 临时文件未被移动、
已有文件夹内容完好、撤销后目录集合与初始完全一致。

## 已知限制

- **只整理文件与文件夹，不改变桌面图标的位置。** 桌面图标坐标存在
  `HKCU\Software\Microsoft\Windows\Shell\Bags\1\Desktop\IconLayouts`，写它需要重启 explorer
  且没有稳定公开的格式，风险高于收益，所以没有实现。
- 扫描依赖 PowerShell 子进程（`shell:AppsFolder` 与 `.lnk` 目标解析没有可靠的纯 Node 替代）。
  已强制 UTF-8，中文应用名不会乱码。
- 分类是**基于名称的正则匹配**，不是内容识别。名字特殊的程序会落进「其他」。
- 只处理桌面根目录，不递归。
- 创建的快捷方式图标统一使用 explorer 图标；MSIX 应用无法直接借用原图标。

