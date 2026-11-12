# 安装与首次运行

本文面向“拿到安装包、想在自己电脑上跑起来”的人。开发/构建请看根目录 `README.md`。

## 1. 下载

到 [Releases](https://github.com/ehwin/AIRI-castalia/releases) 下载最新一版：

- 文件名：`AIRI-Castalia-<版本>-windows-x64-setup.exe`
- 约 400 MB。体积主要来自 Electron 运行时、Godot 舞台二进制和随包分发的向量扩展。

## 2. 关于“未知发布者”

当前构建用的是**自签名证书**（`CN=Castalia AIRI`），不是花钱买的公共代码签名证书。所以：

- Windows SmartScreen 会提示“Windows 已保护你的电脑”。
- 这不代表文件被动过，只代表证书链不在系统信任列表里。

三个选择，按推荐顺序：

1. **先校验再运行**：比对 Releases 页面给出的 SHA-256，与本地一致再点“更多信息 → 仍要运行”。
2. **本机信任这张证书**（只影响这台机器）：把发布页附带的 `castalia-airi.cer` 导入“受信任的根证书颁发机构（当前用户）”，之后安装包和 `airi.exe` 的签名状态都会变成“有效”。
3. 自己从源码构建，见 `README.md`。

> 拿到公共签名证书后，我会把这段替换成正常安装说明。

## 3. 安装

安装器是标准的 NSIS 向导：可以改安装目录、会创建桌面快捷方式、安装完直接启动。

默认安装位置：`%LOCALAPPDATA%\Programs\AIRI`。

## 4. 首次运行

1. 欢迎页 → 选择模型服务商（OpenAI 兼容、DeepSeek、MiniMax、Ollama 等）。
2. 填入该服务商的 API Key 与模型名。**这一步跳过也能进主界面，但她不会有回复。**
3. 选择语音（可选）：本地 TTS、浏览器 TTS 或云端服务。

### 数据存在哪

| 内容 | 位置 |
| --- | --- |
| 设置、会话、卡片 | `%APPDATA%\AIRI`（Electron userData） |
| 长期记忆库 | `%APPDATA%\AIRI\memory-banks\<角色>\<项目>\...\memory.sqlite` |
| 记忆引擎配置 | `%APPDATA%\AIRI\castalia-engine.json`（不存在时用内置默认值） |

记忆库默认落在 userData 下，不依赖任何固定盘符；想放到别处就在 `castalia-engine.json` 里改 `bankDir`。

### 长期记忆坏了会怎样

不会静默装作“没记忆过”：

- 记忆模块关闭时，读日记/读记忆的接口会**报错**，工具会如实说“打不开”。
- 向量扩展缺失时退化为全文检索，检索结果会变差，但写入与列表仍可用。

## 5. 卸载

控制面板卸载即可。卸载器当前配置为**一并删除 userData**（`deleteAppDataOnUninstall: true`）——想留记忆库的话，卸载前先把 `%APPDATA%\AIRI\memory-banks` 复制出来。

## 6. 已知限制

- 只有 Windows x64 的安装包在本仓发布流程里验证过。
- 安装包未签名证书兜底，企业环境可能被策略直接拦下。
- 舞台（Godot）二进制随包分发，第一次切换舞台会比后续慢。
- 遥测：**默认关闭且没有接入**，应用不上报任何使用数据。
