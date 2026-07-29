# WeTerm

第一次做 macOS 上的 SSH/SFTP 客户端，参考了 MobaXterm 的风格。
还有很多不完善的地方，有什么想法或者遇到问题欢迎提出来 🙌

联系我：weterm@foxmail.com

SSH 终端 + SFTP 文件管理 + 远程文件编辑，都集成在一个窗口里。

![WeTerm](myterm-icon.svg)

## 特色

- **双面板独立连接** — 上下两个面板可以分别连到不同服务器，跨服务器传文件也方便
- **原生 macOS 体验** — 密码存入系统钥匙串（Keychain），不用反复输入；支持 Apple Silicon
- **三种认证方式** — 密码、SSH Key、SSH Agent 都支持
- **拖拽传输** — 面板之间拖拽文件就能上传或下载，跨服务器也支持
- **GitHub Dark 风格** — 深色终端配色，看着舒服

## 能做什么

- **SSH 终端** — 打开远程 shell，运行命令、编辑文件、启动交互式程序
- **SFTP 文件管理** — 双面板浏览远程和本地文件，双击进目录，右键操作文件
- **远程文件编辑** — 双击远程文本文件，在线改完直接保存
- **连接管理** — 多标签页、连接历史，重连自动填充

## 下载

| 文件 | 说明 |
|---|---|
| [weterm_0.1.0_aarch64.dmg](./weterm_0.1.0_aarch64.dmg) | macOS Apple Silicon (M1/M2/M3/M4) |

> Intel 版本即将推出。

## 构建

```bash
npm install
npm run tauri build
```

## 技术栈

Tauri v2 / Rust / React 19 / TypeScript / Vite 6 / xterm.js

## License

MIT
