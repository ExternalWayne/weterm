# Weterm — macOS SSH/SFTP Client

<p align="center">
  <img src="public/weterm-blink.gif" width="64" />
</p>

<p align="center">
  <strong>Weterm — macOS 平台现代化 SSH/SFTP 客户端</strong><br/>
  <strong>Weterm — A Modern SSH/SFTP Client for macOS</strong>
</p>

<p align="center">
  Version 1.0.0 · Νείλος (Nile) · © 2025 Benz lau · weterm@foxmail.com
</p>

---

> ⚠️ **测试状态 / Testing Status**  
> 本软件目前仅在 **Apple Silicon (M 系列芯片)** 设备上测试通过。Intel 版本和通用版本尚未经过测试。  
> This software has only been tested on **Apple Silicon (M-series)** devices. Intel and Universal builds are untested.

> ⚠️ **已知问题 / Known Issues**  
> 部分功能仍在持续改进中，例如文件/文件夹重命名功能。  
> Some features (e.g., rename) are still being actively improved.

> 📧 **反馈 / Feedback:** weterm@foxmail.com

---

## 目录 / Table of Contents

1. [安装说明 / Installation](#安装说明--installation)
2. [核心功能 / Core Features](#核心功能--core-features)
3. [连接管理 / Connection Management](#连接管理--connection-management)
4. [文件浏览器 / File Browser](#文件浏览器--file-browser)
5. [拖拽传输 / Drag-and-Drop Transfer](#拖拽传输--drag-and-drop-transfer)
6. [终端操作 / Terminal Operations](#终端操作--terminal-operations)
7. [任务面板 / Task Panel](#任务面板--task-panel)
8. [命令面板 / Commands Panel](#命令面板--commands-panel)
9. [记事本 / Notepad](#记事本--notepad)
10. [文件编辑器 / File Editor](#文件编辑器--file-editor)
11. [会话录制与回放 / Session Recording & Replay](#会话录制与回放--session-recording--replay)
12. [设置 / Settings](#设置--settings)
13. [快捷键 / Keyboard Shortcuts](#快捷键--keyboard-shortcuts)
14. [技术架构 / Technical Architecture](#技术架构--technical-architecture)
15. [开发者指南 / Developer Guide](#开发者指南--developer-guide)

---

## 安装说明 / Installation

### 下载版本 / Download Versions

| 版本 / Version | 适用芯片 / Architecture | 大小 / Size | 说明 / Notes |
|---|---|---|---|
| `weterm_1.0.0_aarch64.dmg` | Apple Silicon (M1/M2/M3/M4) | 6.6 MB | 原生 ARM64 / Native ARM64 |
| `weterm_1.0.0_x86_64.dmg` | Intel Mac | 6.0 MB | 原生 Intel / Native Intel |
| `weterm_1.0.0_universal.dmg` | 通用 / Universal | 13 MB | 同时支持 Intel 和 Apple Silicon / Supports both Intel & Apple Silicon |

### 系统要求 / System Requirements

* macOS 12.0 或更高版本 / macOS 12.0 or later
* 需要网络连接以进行 SSH 通信 / Network connection required for SSH communication

### ⚠️ 测试状态 / Testing Status

> **注意：本软件目前仅在 Apple Silicon (M 系列芯片) 设备上进行了测试。**
> **Note: This software has only been tested on Apple Silicon (M-series) devices.**
>
> Intel 芯片版本和通用版本**尚未经过测试**，可能存在兼容性问题。
> The Intel and Universal builds have **NOT been tested** and may have compatibility issues.
>
> 如您在 Intel Mac 上使用，欢迎反馈运行情况。
> If you are using an Intel Mac, feedback on your experience is welcome.

### ⚠️ 已知问题 / Known Issues

> 部分功能仍存在问题，正在持续改进中，包括但不限于：
> Some features still have issues and are being actively improved, including but not limited to:
>
> * 文件/文件夹重命名功能 / File/folder rename functionality
> * 大文件传输时的性能优化 / Performance optimization for large file transfers
> * 部分 UI 交互细节 / Some UI interaction details
>
> **期待您的反馈！欢迎发送邮件至 / Feedback welcome! Email us at: weterm@foxmail.com**

### 安装步骤 / Installation Steps

1. 下载对应架构的 DMG 文件 / Download the DMG file for your architecture
2. 双击挂载 DMG / Double-click to mount the DMG
3. 将 Weterm.app 拖入 Applications 文件夹 / Drag Weterm.app to the Applications folder
4. 首次打开时，如遇安全提示，请前往「系统设置 → 隐私与安全性」允许打开 / On first launch, if blocked, go to System Settings → Privacy & Security to allow

### 无法打开 / Cannot Open

> 如遇到「无法打开 Weterm」或「已损坏，无法打开」提示，可在终端执行以下命令后重新打开：
> If you see "Weterm cannot be opened" or "is damaged and can't be opened", run this in Terminal and try again:
>
> ```bash
> xattr -d com.apple.quarantine /Applications/WeTerm.app
> ```

---

## 核心功能 / Core Features

### 概览 / Overview

Weterm 是一款受 MobaXterm 启发的 macOS SSH/SFTP 客户端，基于 Tauri v2 构建，融合原生性能与 Web 技术的灵活性。
Weterm is a MobaXterm-inspired macOS SSH/SFTP client built with Tauri v2, blending native performance with web technology flexibility.

**支持的认证方式 / Supported Authentication Methods:**
* 密码认证 / Password authentication
* SSH 密钥认证 / SSH key authentication
* SSH Agent 认证 / SSH Agent authentication

**密码存储 / Password Storage:**
* 密码安全存储在 macOS 钥匙串中 / Passwords are securely stored in macOS Keychain

---

## 连接管理 / Connection Management

### 新建连接 / New Connection
点击顶部 `+` 按钮，填写主机地址、端口、用户名和认证方式，即可建立新的 SSH 连接。
Click the `+` button in the top bar, fill in host, port, username, and authentication method to establish a new SSH connection.

### 连接历史 / Connection History
所有成功连接的服务器自动保存在历史记录中。双击历史记录项即可快速重新连接。
All successfully connected servers are automatically saved in history. Double-click a history entry to quickly reconnect.

### 编辑已保存的连接 / Edit Saved Connections
每条历史记录右侧有 **✐ 编辑** 按钮，可以修改：
Each history entry has an **✐ Edit** button on the right to modify:

* **昵称** — 自定义显示名称，替代默认的 user@host:port 格式
* **Nickname** — Custom display name replacing the default user@host:port format
* **主机地址** — 修改服务器地址 / **Host** — Change server address
* **端口** — 修改 SSH 端口 / **Port** — Change SSH port
* **用户名** — 修改登录用户 / **Username** — Change login user
* **认证方式** — 在密码/密钥/Agent 之间切换 / **Auth Type** — Switch between password/key/agent
* **密码** — 更新钥匙串中的密码（留空则保留原密码） / **Password** — Update keychain password (leave blank to keep existing)

### 删除连接 / Delete Connection
每条历史记录右侧有 **✕ 删除** 按钮，确认后删除该连接及关联的钥匙串密码。
Each history entry has an **✕ Delete** button. Confirm to delete the connection and its associated keychain password.

### 标签页管理 / Tab Management
* 每个连接在顶部以标签页形式显示 / Each connection is displayed as a tab in the top bar
* **右键标签页**可执行以下操作 / **Right-click a tab** for these actions:
  * **克隆标签页** — 使用相同配置创建新连接，并保持在当前工作目录 / **Clone Tab** — Create new connection with same config, preserving current working directory
  * **重新连接** — 断开并重新连接到当前服务器，**同时恢复当前工作目录** / **Reconnect** — Disconnect and reconnect to the same server, **restoring the current working directory**

### 双面板模式 / Dual-Panel Mode
软件支持上下两个独立面板，每个面板可独立连接不同的服务器或浏览本地文件。
The app supports two independent panels (top and bottom), each can connect to different servers or browse local files.

* **顶部面板** — 始终为远程 SSH 连接 / **Top Panel** — Always a remote SSH connection
* **底部面板** — 可切换为远程 SSH 连接或本地文件浏览 / **Bottom Panel** — Switchable between remote SSH connection and local file browsing
* 点击面板标题切换连接模式 / Click panel header to switch connection mode
* 面板之间可通过拖拽调整大小 / Panels can be resized by dragging the divider

---

## 文件浏览器 / File Browser

### 文件列表 / File Listing
* 显示当前目录下的所有文件和文件夹 / Displays all files and folders in the current directory
* **双击文件夹**进入子目录 / **Double-click folder** to navigate into it
* **双击文件**（远程）在内置编辑器中打开 / **Double-click file** (remote) to open in built-in editor
* 点击 `..` 返回上级目录 / Click `..` to go to parent directory

### 文件信息列 / File Information Columns
可通过设置独立控制以下列的显示：
Each column can be independently toggled in Settings:

| 列 / Column | 说明 / Description | 示例 / Example |
|---|---|---|
| **权限 / Permissions** | Unix 文件权限 / Unix file permissions | `drwxr-xr-x` |
| **所有者 / Owner** | 文件所有者与组 / File owner and group | `root:wheel` |
| **修改时间 / Modified** | 最后修改日期 / Last modified date | `2025-07-30` |
| **大小 / Size** | 文件大小 / File size | `1.5GB`, `256KB` |

### 文件搜索 / File Search
* 文件列表上方有搜索过滤栏 / Search filter bar at the top of file list
* 输入关键字即时过滤文件 / Type to instantly filter files by name
* 按 `Escape` 键清空搜索 / Press `Escape` to clear search

### 多选操作 / Multi-Select Operations
* **点击复选框**切换选中状态 / **Click the checkbox** to toggle selection
* **Ctrl/Cmd + 点击**切换单个项目的选中 / **Ctrl/Cmd + Click** to toggle single item selection
* **Shift + 点击**范围选择 / **Shift + Click** for range selection
* 选中文件后，底部出现**批量操作栏** / After selecting files, a **batch action bar** appears at the bottom

### 右键菜单 / Right-Click Context Menu

**远程文件 / Remote Files:**

| 操作 / Action | 图标 / Icon | 说明 / Description |
|---|---|---|
| 下载 / Download | ⤓ | 下载文件/文件夹到本地 / Download file/folder to local |
| 跨服务器传输 / Transfer | ⇉ | 传输到另一个连接的远程服务器 / Transfer to another connected remote server |
| 编辑 / Edit | ✐ | 在内置编辑器中打开文件 / Open file in built-in editor |
| 复制路径 / Copy Path | ⧉ | 将完整路径复制到剪贴板 / Copy full path to clipboard |
| 复制文件 / Copy File | ⎘ | 复制文件到剪贴板（用于粘贴） / Copy file to clipboard (for paste) |
| 粘贴 / Paste | ⎙ | 将剪贴板中的文件粘贴到当前目录 / Paste clipboard file into current directory |
| 重命名 / Rename | ✐ | 重命名文件或文件夹 / Rename file or folder |
| 删除 / Delete | ⨯ | 删除文件或文件夹 / Delete file or folder |
| 刷新 / Refresh | ⟳ | 刷新文件列表 / Refresh file list |

**本地文件 / Local Files:**

| 操作 / Action | 图标 / Icon | 说明 / Description |
|---|---|---|
| 上传 / Upload | ⤒ | 上传文件/文件夹到远程服务器 / Upload file/folder to remote server |
| 复制路径 / Copy Path | ⧉ | 将完整路径复制到剪贴板 / Copy full path to clipboard |
| 复制文件 / Copy File | ⎘ | 复制文件到剪贴板 / Copy file to clipboard |
| 重命名 / Rename | ✐ | 重命名文件或文件夹 / Rename file or folder |
| 删除 / Delete | ⨯ | 删除文件或文件夹 / Delete file or folder |
| 刷新 / Refresh | ⟳ | 刷新文件列表 / Refresh file list |

**空白区域右键 / Empty-Space Right-Click:**

| 操作 / Action | 图标 / Icon | 说明 / Description |
|---|---|---|
| 新建文件夹 / New Folder | ⊕ | 在当前目录创建新文件夹 / Create a new folder in current directory |
| 复制文件夹路径 / Copy Folder Path | ⧉ | 复制当前目录路径 / Copy current directory path |
| 刷新 / Refresh | ⟳ | 刷新文件列表 / Refresh file list |

---

## 拖拽传输 / Drag-and-Drop Transfer

拖拽功能是 Weterm 的核心亮点之一，支持多种场景下的文件传输。
Drag-and-drop is one of Weterm's core features, supporting file transfers in multiple scenarios.

### 场景 1：从远程拖拽到本地面板 / Scenario 1: Remote → Local Panel

**操作：** 将远程文件/文件夹拖放到本地文件浏览器面板
**Action:** Drag remote file/folder and drop onto the local file browser panel

**行为 / Behavior:**
- 自动确定目标为当前本地路径 / Automatically determines the destination as the current local path
- 如遇同名文件自动重命名（如 `file (1).txt`） / Auto-renames on name conflict (e.g., `file (1).txt`)
- 支持同时拖拽多个文件（批量下载） / Supports dragging multiple files at once (batch download)
- 下载任务出现在任务面板中 / Download tasks appear in the Task Panel

### 场景 2：从本地拖拽到远程面板 / Scenario 2: Local → Remote Panel

**操作：** 将本地文件/文件夹拖放到远程文件浏览器面板
**Action:** Drag local file/folder and drop onto the remote file browser panel

**行为 / Behavior:**
- 自动上传到远程服务器的当前目录 / Automatically uploads to the remote server's current directory
- 支持批量上传 / Supports batch upload

### 场景 3：从远程 A 拖拽到远程 B（跨服务器传输） / Scenario 3: Remote A → Remote B (Cross-Server Transfer)

**操作：** 将顶部面板的远程文件拖放到底部面板（底部已连接另一个远程服务器）
**Action:** Drag remote files from the top panel and drop onto the bottom panel (when bottom is connected to another remote server)

**行为 / Behavior:**
- 自动执行两阶段传输：先下载到临时目录，再上传到目标服务器 / Automatically performs two-phase transfer: downloads to temp directory, then uploads to target server
- 完成后自动清理临时文件 / Auto-cleans temporary files after completion

### 场景 4：从 Finder 拖入 Weterm / Scenario 4: Finder → Weterm

**操作：** 从 macOS Finder 将文件/文件夹拖入 Weterm 面板
**Action:** Drag files/folders from macOS Finder into a Weterm panel

**行为 / Behavior:**
- 拖入远程面板 → 自动上传 / Drop on remote panel → auto-upload
- 拖入本地面板 → 自动显示文件 / Drop on local panel → auto-display files
- 自动解析 `file://` URI 和 HTML5 File API / Auto-parses `file://` URIs and HTML5 File API

### 场景 5：从 Weterm 拖出到 Finder / Scenario 5: Weterm → Finder

**操作：** 将文件从 Weterm 拖出到 macOS Finder
**Action:** Drag files from Weterm out to macOS Finder

**行为 / Behavior:**
- **本地文件** — 直接提供 `file://` URI，Finder 可立即使用 / **Local files** — Provides `file://` URI directly, Finder can use immediately
- **远程文件** — 点击文件时自动预缓存到 `~/.weterm/cache/`，拖拽时使用缓存路径 / **Remote files** — Auto-caches on click to `~/.weterm/cache/`, uses cached path for drag
- 配合 Finder 的 `text/uri-list` 协议实现 / Implemented via Finder's `text/uri-list` protocol

### 场景 6：拖拽文件到终端 / Scenario 6: Drag to Terminal

**操作：** 将文件/文件夹拖放到 SSH 终端区域
**Action:** Drag file/folder and drop onto the SSH terminal area

**行为 / Behavior:**
- 自动在终端中粘贴完整路径 / Automatically pastes the full path into the terminal
- 例如：`/home/user/project/main.py `（末尾带空格便于继续输入命令） / Example: `/home/user/project/main.py ` (trailing space for continued command input)

### 场景 7：拖拽文件到记事本 / Scenario 7: Drag to Notepad

**操作：** 将文件/文件夹拖放到记事本区域
**Action:** Drag file/folder and drop onto the Notepad area

**行为 / Behavior:**
* **文件夹** — 粘贴文件夹路径 / **Folder** — Pastes the folder path
* **本地文件** — 读取文件内容并插入记事本（附带路径注释），自动触发保存 / **Local file** — Reads file content and inserts into notepad (with path comment), auto-triggers save
* **远程文件** — 粘贴远程路径 / **Remote file** — Pastes the remote path

### 技术实现细节 / Technical Implementation Details

* 使用 HTML5 Drag-and-Drop API / Uses HTML5 Drag-and-Drop API
* 通过 `window.__weterm_drag` 持久化拖拽数据，解决 WKWebView 的 `getData()` 限制 / Persists drag data via `window.__weterm_drag` to work around WKWebView's `getData()` restrictions
* 在 `dragover` 事件中捕获数据作为备用方案 / Captures data during `dragover` events as fallback
* 拖拽离开区域后保留数据150ms延迟清除，防止快速移动导致数据丢失 / Retains data for 150ms after dragleave to prevent data loss from fast mouse movement
* 远程文件预缓存机制：点击文件时自动在后台下载到本地缓存 / Remote file pre-caching: auto-downloads to local cache on click

---

## 终端操作 / Terminal Operations

### 终端功能 / Terminal Features
* 基于 **xterm.js v5** 的完整终端模拟器 / Full terminal emulator based on **xterm.js v5**
* 支持 256 色和 True Color / Supports 256 colors and True Color
* 自适应窗口大小（FitAddon）/ Auto-fits to window size (FitAddon)
* 支持明/暗两种主题，跟随系统设置 / Supports light/dark themes, follows system settings
* 可自定义终端字体和字号 / Customizable terminal font and font size

### 终端交互 / Terminal Interaction
* **双击命令历史**条目自动粘贴到终端 / **Double-click command history** entry to auto-paste into terminal
* **双击自定义命令**条目自动粘贴到终端 / **Double-click custom command** entry to auto-paste into terminal
* **拖拽文件/文件夹到终端**自动粘贴路径 / **Drag file/folder to terminal** auto-pastes path

### 命令历史 / Command History
* 所有输入的命令自动记录 / All typed commands are auto-recorded
* 按日期分组显示 / Grouped by date
* 支持搜索过滤 / Supports search filtering
* 可配置最大保存条数 / Configurable maximum saved entries

---

## 任务面板 / Task Panel

### 传输管理 / Transfer Management
所有文件传输任务在右侧任务面板中集中管理。
All file transfer tasks are centrally managed in the right-side Task Panel.

### 传输状态 / Transfer Status

| 状态 / Status | 说明 / Description |
|---|---|
| **ACTIVE** | 正在传输中的任务 / Currently transferring |
| **WAITING** | 排队等待传输的任务 / Queued, waiting for a slot |
| **RECENT** | 已完成/已取消/出错的任务 / Completed/cancelled/errored tasks |
| **✓ Done** | 传输成功完成 / Transfer completed successfully |
| **✗ Error** | 传输出错 / Transfer failed with error |
| **⊘ Cancelled** | 用户取消传输 / User cancelled the transfer |

### 传输详情 / Transfer Details
每个任务项显示 / Each task item displays:
* **序号** — 全局任务编号 / **Index** — Global task number
* **方向箭头** — 上传 ↑（蓝色）/ 下载 ↓（绿色） / **Direction arrow** — Upload ↑ (blue) / Download ↓ (green)
* **文件名** — 自动换行显示，不再截断 / **File name** — Auto-wraps, no longer truncated
* **传输路径** — 完整的源→目标路径，支持自动换行 / **Transfer path** — Full source→destination path with auto-wrap
* **进度条** — 实时更新 / **Progress bar** — Real-time updates
* **速度** — 实时传输速度 / **Speed** — Real-time transfer speed
* **预估时间** — 剩余时间预估 / **ETA** — Estimated time remaining
* **取消按钮** — 随时取消进行中的传输 / **Cancel button** — Cancel ongoing transfer at any time

### 传输并发控制 / Transfer Concurrency
* 最多同时运行 2 个传输任务 / Maximum 2 concurrent transfer tasks
* 其他任务在队列中等待 / Additional tasks queue and wait
* 250ms 轮询间隔，快速获取可用槽位 / 250ms poll interval for fast slot acquisition

### 传输历史 / Transfer History
* 点击 "History" 按钮查看历史传输记录 / Click "History" button to view past transfers
* 按日期分组显示 / Grouped by date
* 支持搜索过滤 / Supports search filtering
* 双击历史条目可插入 SCP 命令到终端 / Double-click history entry to insert SCP command into terminal

### 性能优化 / Performance Optimization
* 进度数据使用外部 Store（`useSyncExternalStore`），仅 TaskPanel 重新渲染 / Progress data uses external store (`useSyncExternalStore`), only TaskPanel re-renders
* Rust 端每 250ms 发送一次进度更新（256KB 缓冲区）/ Rust side emits progress every 250ms (256KB buffer)
* 前端每 500ms 批量处理进度事件 / Frontend batches progress events every 500ms
* 使用 React `startTransition` 实现低优先级状态更新 / Uses React `startTransition` for low-priority state updates

---

## 命令面板 / Commands Panel

### 自定义命令 / Custom Commands

**创建自定义命令 / Creating Custom Commands:**
1. 切换到 "Custom" 视图 / Switch to "Custom" view
2. 点击 **"+ New"** 按钮 / Click **"+ New"** button
3. 输入命令名称（如 "Deploy"）和命令内容（如 `./deploy.sh`） / Enter command name (e.g., "Deploy") and command (e.g., `./deploy.sh`)
4. 点击 "Add" 保存 / Click "Add" to save

**使用自定义命令 / Using Custom Commands:**
* 双击命令条目自动粘贴到终端 / Double-click command entry to auto-paste into terminal
* 命令自动持久化保存 / Commands are auto-persisted to disk

**管理自定义命令 / Managing Custom Commands:**
* 搜索过滤：输入关键字过滤命令名称和命令内容 / Search filter: type to filter by command name and content
* 删除：点击 ✕ 按钮删除命令 / Delete: click ✕ button to delete command

### 命令历史 / Command History
* 切换到 "History" 视图查看所有输入过的命令 / Switch to "History" view to see all typed commands
* 按日期分组 / Grouped by date
* 支持搜索过滤 / Supports search filtering
* 双击自动粘贴到终端 / Double-click to auto-paste into terminal

---

## 记事本 / Notepad

### 文本编辑 / Text Editing
* 内置纯文本编辑器，适合临时记录 / Built-in plain text editor for quick notes
* **自动保存** — 停止输入 1.5 秒后自动保存 / **Auto-save** — Auto-saves 1.5 seconds after you stop typing
* **上次文件记忆** — 每次启动自动打开上次编辑的文件 / **Last file memory** — Automatically reopens the last edited file on startup
* 保存状态指示器（● 表示未保存）/ Save status indicator (● = unsaved)

### 工具栏 / Toolbar

| 按钮 / Button | 功能 / Function |
|---|---|
| **New** | 创建新的文本文档 / Create a new text document |
| **Open** | 使用 macOS 原生文件对话框打开文件 / Open file via native macOS file dialog |
| **Save** | 保存到 Weterm 内部记事本 / Save to Weterm internal notepad |
| **Save As…** | 使用 macOS 原生保存对话框导出 / Export via native macOS save dialog |

工具栏支持自动换行，面板缩窄时按钮自动折行。
The toolbar wraps automatically when the panel is narrow.

### 文件管理 / File Management
* 点击 "Notepad ▼" 标题展开文件列表 / Click "Notepad ▼" header to expand file list
* **双击文件名**加载文件 / **Double-click filename** to load file
* **点击文件名**可重命名 / **Click filename** to rename
* **✕ 按钮**删除文件（需确认）/ **✕ button** to delete file (with confirmation)

### 拖拽到记事本 / Drag to Notepad
* **文件夹** → 粘贴文件夹路径 / **Folder** → Pastes folder path
* **本地文件** → 读取完整内容并插入记事本 / **Local file** → Reads full content and inserts into notepad
* **远程文件** → 粘贴远程路径 / **Remote file** → Pastes remote path

---

## 文件编辑器 / File Editor

### 编辑远程文件 / Editing Remote Files
* 双击远程文本文件在内置编辑器中打开 / Double-click remote text file to open in built-in editor
* 支持语法高亮的基础代码编辑 / Basic code editing with syntax highlighting
* **Save** — 保存并上传到远程服务器 / Save and upload to remote server
* **Undo** — 撤销更改 / Undo changes
* **Close** — 关闭编辑器 / Close editor

---

## 会话录制与回放 / Session Recording & Replay

### 录制终端会话 / Recording Terminal Sessions
* 点击录制按钮开始录制终端输出 / Click record button to start recording terminal output
* 红色指示灯闪烁表示正在录制 / Flashing red indicator shows recording is active
* 显示录制时长 / Displays recording duration
* 录制内容自动保存 / Recording auto-saves

### 回放 / Replay
* 点击回放按钮打开回放面板 / Click replay button to open the Replay panel
* 左侧列表选择要回放的会话 / Select session to replay from the left list
* 右侧播放器按时间顺序重现终端输出 / Right-side player reproduces terminal output in chronological order

---

## 设置 / Settings

点击左上角 Weterm 图标 → **⚙ Settings** 打开设置面板。
Click the Weterm icon in the top-left corner → **⚙ Settings** to open the Settings panel.

### 外观设置 / Appearance

| 设置 / Setting | 说明 / Description |
|---|---|
| **UI 字体 / UI Font** | 界面字体，默认使用 Apple 系统字体（SF Pro Text） / UI font, defaults to Apple system font (SF Pro Text) |
| **UI 字号 / UI Font Size** | 界面文字大小 / UI text size |
| **终端字体 / Terminal Font** | 终端字体，默认使用 SF Mono / Terminal font, defaults to SF Mono |
| **终端字号 / Terminal Font Size** | 终端文字大小 / Terminal text size |
| **↺ Reset Fonts to Defaults** | 一键恢复所有字体为系统默认 / One-click reset all fonts to system defaults |
| **主题 / Theme** | 明色 / 暗色 / 跟随系统 / Light / Dark / Follow System |

### 功能设置 / Functionality

| 设置 / Setting | 说明 / Description |
|---|---|
| **最大历史条目 / Max History Entries** | 命令和传输历史的最大保存条数 / Maximum number of command and transfer history entries to keep |
| **显示权限 / Show Permissions** | 是否显示文件权限列 / Toggle file permissions column visibility |
| **显示所有者 / Show Owner** | 是否显示文件所有者列 / Toggle file owner column visibility |
| **显示修改时间 / Show Modified** | 是否显示修改时间列 / Toggle modified time column visibility |
| **显示大小 / Show Size** | 是否显示文件大小列 / Toggle file size column visibility |

---

## 快捷键 / Keyboard Shortcuts

| 快捷键 / Shortcut | 功能 / Function |
|---|---|
| `Escape` | 关闭右键菜单、清空搜索 / Close context menu, clear search |
| `Ctrl/Cmd + Click` | 切换文件选中 / Toggle file selection |
| `Shift + Click` | 范围选择文件 / Range-select files |
| `Enter` | 确认重命名 / 新建文件夹 / 添加自定义命令 / Confirm rename / new folder / add custom command |
| `Double-click` (文件) | 打开/进入 / Open/navigate |
| `Double-click` (历史) | 插入到终端 / Insert into terminal |

---

## 技术架构 / Technical Architecture

### 技术栈 / Tech Stack

| 层 / Layer | 技术 / Technology | 说明 / Notes |
|---|---|---|
| **桌面框架 / Desktop Framework** | Tauri v2 | Rust 后端 + WebView 前端 / Rust backend + WebView frontend |
| **前端 / Frontend** | React 19 + TypeScript + Vite | 现代化组件式 UI / Modern component-based UI |
| **终端 / Terminal** | xterm.js v5 + FitAddon | 完整终端模拟 / Full terminal emulation |
| **SSH 协议 / SSH Protocol** | libssh2 (via ssh2 crate) | SFTP 文件传输 / SFTP file transfers |
| **密码存储 / Password Storage** | macOS Keychain | 通过 security-framework crate / Via security-framework crate |
| **文件对话框 / File Dialogs** | @tauri-apps/plugin-dialog | macOS 原生文件选择器 / Native macOS file picker |
| **样式 / Styling** | CSS Custom Properties | 明暗双主题 / Light and dark themes |

### 项目结构 / Project Structure

```
Weterm/
├── src/                          # 前端源码 / Frontend source
│   ├── App.tsx                   # 主应用组件 / Main app component
│   ├── App.css                   # 全局样式 / Global styles
│   ├── types.ts                  # TypeScript 类型定义 / TypeScript type definitions
│   ├── progressStore.ts          # 传输进度外部 Store / Transfer progress external store
│   └── components/
│       ├── TopBar.tsx            # 顶部标签栏 + 品牌菜单 / Top tab bar + brand menu
│       ├── FileBrowser.tsx       # 文件浏览器（远程+本地）/ File browser (remote + local)
│       ├── TaskPanel.tsx         # 传输任务面板 / Transfer task panel
│       ├── ActivityLog.tsx       # 命令面板（历史+自定义）/ Commands panel (history + custom)
│       ├── Notepad.tsx           # 记事本 / Notepad
│       ├── FileEditor.tsx        # 文件编辑器 / File editor
│       ├── Terminal.tsx          # SSH 终端组件 / SSH terminal component
│       ├── RecapPanel.tsx        # 会话录制回放 / Session recording replay
│       ├── SettingsModal.tsx     # 设置面板 / Settings panel
│       ├── ConnectionPickerModal.tsx  # 连接选择器 / Connection picker
│       ├── ConfirmReplaceModal.tsx    # 文件替换确认 / File replace confirmation
│       └── ResizeHandle.tsx      # 面板大小调整 / Panel resize handle
├── src-tauri/                    # Rust 后端 / Rust backend
│   ├── Cargo.toml                # Rust 依赖 / Rust dependencies
│   ├── tauri.conf.json           # Tauri 配置 / Tauri configuration
│   └── src/
│       ├── lib.rs                # Tauri 命令注册 / Tauri command registration
│       ├── main.rs               # 程序入口 / Program entry point
│       ├── ssh_manager.rs        # SSH 连接和传输管理 / SSH connection & transfer management
│       └── sftp_manager.rs       # SFTP 操作实现 / SFTP operation implementation
└── public/                       # 静态资源 / Static assets
    └── weterm-blink.gif          # 应用图标 / App icon
```

---

## 开发者指南 / Developer Guide

### 环境要求 / Prerequisites

* Node.js 20+ 和 npm / Node.js 20+ and npm
* Rust 工具链 / Rust toolchain (rustup, cargo)
* macOS 12+ (需要 Xcode Command Line Tools) / macOS 12+ (Xcode Command Line Tools required)

### 本地开发 / Local Development

```bash
# 安装前端依赖 / Install frontend dependencies
npm install

# 启动开发服务器（热重载）/ Start dev server (hot reload)
npm run tauri dev

# 构建前端 / Build frontend only
npm run build

# 构建发布版本 / Build release version
npm run tauri build
```

### 构建多架构版本 / Building for Multiple Architectures

```bash
# 构建 Intel (x86_64) 版本 / Build for Intel (x86_64)
cargo build --release --target x86_64-apple-darwin

# 构建 Apple Silicon (aarch64) 版本 / Build for Apple Silicon (aarch64)
cargo build --release --target aarch64-apple-darwin

# 创建通用二进制 / Create universal binary
lipo -create \
  target/aarch64-apple-darwin/release/weterm \
  target/x86_64-apple-darwin/release/weterm \
  -output target/release/weterm

# 打包 DMG / Bundle DMG
npm run tauri build
```

### 反馈 / Feedback

如有问题或建议，请发送邮件至 / For issues or suggestions, email:
**weterm@foxmail.com**

---

<p align="center">
  <sub>Weterm v1.0.0 · Νείλος · Built with Tauri v2 + React 19 · © 2025 Benz lau</sub>
</p>
