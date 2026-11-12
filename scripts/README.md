# Castalia 记忆体 · Windows 托盘控制台(可选组件)

给 [Castalia](https://github.com/ehwin/Castalia) 记忆引擎用的 **Windows 托盘界面 + 运行时看护**。
它不是引擎的一部分 —— 引擎本体是 Node 项目(`npm install && npm run build` 后由 MCP 客户端调用),
本目录只是**可选的桌面运维层**:在通知区显示状态、一键打开星图/管理服务、并在后台桥掉线时自动修复。

> 同一套代码支持**多实例**(dsh / hermes / lobehub / airi …),也支持三个品牌变体
> (**Lite / Anima / MAX**),差异全部写在配置里,不是三份代码。

---

## 组成

| 文件 | 作用 |
|---|---|
| `castalia.config.json` | **唯一需要改的地方**:路径、实例、端口、库目录 |
| `castalia_config.py` | 配置加载器(缺失时回退内置默认) |
| `castalia_tray.py` | 托盘程序本体(状态/菜单/关于/开机启动开关/服务管理) |
| `castalia_shell.py` | 桌面外壳:**原生窗口 GUI**(pywebview/WebView2),托盘「打开…」的落地窗口 |
| `shell/shell.html` | 外壳界面(自绘标题栏 + 星图 / 记忆总成 / 库管理 / 设置 / 服务 / 接入 六个视图) |
| `castalia_guard.py` | 无界面守护:**跑完即退**,由计划任务每 2 分钟调用一次,桥坏就重建 |
| `tray_launcher.py` | 打包入口(PyInstaller 薄壳:品牌资源 + 依赖,真代码仍从磁盘读) |
| `build_tray.cmd` | 重新打包 `Castalia.exe`(**只在新增第三方依赖时才需要**) |
| `patch_mcp_proxy.py` | 给 mcp-proxy 打补丁:避免 Windows Terminal 弹出控制台窗口 |
| `anima_event_digest.mjs` | 事件层(`daily_event`)的**主机侧触发**:给 `variant=anima` 的实例跑一次 `runEventDigest`。计划任务每 10 分钟叫一次,脚本自带节流(默认 10 分钟)与"没有待整理对话就直接退"(零 LLM 调用)。`--force` / `--dry` / `--days N` / `--bank id` / `--status` |
| `run_anima_event_digest.vbs` | 上面那个脚本的**无窗口**启动器(wscript 是 GUI 子系统,不会弹控制台) |
| `make_brand_icons.py` | 从原图生成三变体图标库(PNG 多尺寸 + .ico + 托盘图) |

## 快速开始

1. **改配置** —— 编辑 `castalia.config.json` 的 `paths`(指向你的目录)与 `instances`(你要管哪几端):

   ```jsonc
   {
     "paths": {
       "home": "D:/castalia", // 也可用环境变量 CASTALIA_HOME 覆盖
       "run": "D:/castalia/run/Castalia", // 引擎实例目录(含 dist/、viz/)
       "banks": "D:/castalia/memory-banks", // 活库目录
       "node": "D:/castalia/run/Castalia/bin/CastaliaNode.exe"
     },
     "instances": [
       {
         "id": "default",
         "label": "Castalia 记忆体",
         "variant": "lite",
         "icon": "tray-icons/brand/lite-tray.png",
         "bank": "default"
       }
     ]
   }
   ```

   相对路径的规则:值写成 `run/viz` 时,`run` 若命中 `paths` 的键就按它解析(等价于 `paths.run + "/viz"`)。

2. **跑起来** —— 双击 `Castalia.exe`(或 `pythonw castalia_tray.py`)。
   右键通知区图标:打开星图 / 服务开关 / 复制状态 / 打开日志 / 开机启动 / 关于。

3. **看护(可选,推荐)** —— 建一个计划任务,每 2 分钟跑一次 `Castalia.exe castalia_guard.py`:

   ```bat
   schtasks /create /tn "Castalia guard" /tr "\"<...>\Castalia.exe\" \"<...>\castalia_guard.py\"" /sc minute /mo 2 /it /f
   ```

   守护脚本的职责:**桥(端口+引擎子进程双判定)→ 不健康就重建并复验 → 若重建过则重启 LobeHub 容器**
   (桥一换,LobeHub 缓存的 MCP 会话就失效,不重启会一直报 `Session not found`)。

## 多实例 / 三变体

* **实例**(`instances[]`)= 一个消费端(一个库 + 一组服务)。可给每个实例配不同图标,一眼区分。
  DSH 和 Hermes 是两个独立的 harness：分别使用 `bank=dsh, project=dsh` 与
  `bank=hermes, project=hermes`，记忆桥端口为 3318 / 3316，星图端口为 3347 / 3345。
  控制台「接入」页选择对应实例后复制配置；共享引擎程序不会合并记忆库。
* **变体**(`variant`)= 品牌系列,对应引擎构建:

  | 变体 | 图标 | 引擎 | 能力 |
  |---|---|---|---|
  | `lite` | 青螺旋 + 水滴 | Castalia | 中立核 |
  | `anima` | 青粉渐变 + 心 | Castalia-Anima | 情感 / 人设层 |
  | `max` | 发光青桃 + 粉心 | Castalia-Full | 中立核 **+** 联邦(联合版) |

* 只想管某一端时:`Castalia.exe castalia_tray.py --instance airi`(或设环境变量 `CASTALIA_INSTANCE=airi`)。

## 联邦成员(桥)

引擎侧联邦由托盘的配置打开 —— `bridges[].federation: true` 时,托盘会把全局
`federation` 列表作为 `FEDERATION_DIRS` 注入该桥的进程环境,于是这个桥背后的实例
可以跨记忆体检索(`memory_search_all`)、跨库反思(`reflect_all`);不写则只搜本实例。

```jsonc
"bridges": [
  { "id": "lobehub-bridge", "port": 3310, "bank": "lobehub", "federation": true }
]
```

成员在引擎侧用 `FEDERATION_MEMBERS`(推荐)或 `FEDERATION_DIRS`(兼容)声明,详见
引擎仓库 README 的 "Federation" 章节;transport 支持 `local-dir`(同机目录)与
`mcp-http`(任意 MCP 端点,**对端零改动**)。

## 桌面外壳(原生窗口 GUI)

托盘的「打开…」(联邦总图 / 记忆总成 / 各端星图 / AIRI Admin / LobeHub)**默认送进外壳窗口**,
不再甩给浏览器 —— 同一个窗口内部切页,点几次也只有一个窗口。外壳自带:

* **本地控制端口**(只监听 127.0.0.1,`shell.port`,默认 3397):托盘点「打开…」时先打这个端口,
  已开的外壳就导航过去并置前;没开才用 `--url` 拉起一个。
* **单实例锁**:第二次启动会把请求转发给在跑的那个,然后自己退出。
* **置前**:由托盘(刚收到点击、有前台权限的那个进程)调 `SetForegroundWindow`,不受 Windows 前台锁限制。

```jsonc
"shell": { "id": "shell", "name": "控制台", "port": 3397 }
```

* **删掉 `shell` 段** → 「打开…」一律回浏览器(旧行为)。
* 外壳依赖 **pywebview**:品牌 `Castalia.exe` 里没打包它,托盘会自动挑本机装了 pywebview 的
  `pythonw.exe` 来跑(挑不到才回落浏览器并弹通知)。
* 调试:`pythonw castalia_shell.py --url http://127.0.0.1:3345/?scope=federation --view viz`;
  控制端口还有 `/health`(探活)与 `/state`(读当前 iframe/视图)。

## 打包(通常不需要)

`Castalia.exe` 是**薄壳**:它只负责品牌资源 + 把依赖收进 exe,**真正的逻辑每次从磁盘上的 .py 读取**。
所以改托盘/守护逻辑 → 重启托盘即可生效;**只有新增第三方依赖时**才需要重新打包:

```bat
scripts\build_tray.cmd
```

当前打进 exe 的依赖清单(见 `tray_launcher.py`):`psutil`、`pystray`、`Pillow`、`psycopg2`(LobeHub 钩子)、
`cryptography`(keys.enc 解密)。新增依赖请同步加进 launcher 的 import。

## 已知注意

* **mcp-proxy 补丁**:`patch_mcp_proxy.py` 给 mcp-proxy 的 spawn 加 `detached: true`(否则 Windows 11
  默认终端是 Windows Terminal 时会弹 `Default: …CastaliaNode.exe` 窗口)。**升级/重装 mcp-proxy 后要重跑**,
  `--check` 可判断。
* **node 运行时副本**:`CastaliaNode.exe` 是 node.exe 的一份拷贝(改名 + 换图标 + 版本信息),让任务管理器里
  显示统一品牌。升级 node 后重新复制,并重跑 rcedit(图标/版本)。**保留 Node.js 的 MIT 声明**是硬要求。
* **`.cmd` 文件保持 ASCII**:cmd 按 OEM 代码页读取,中文注释会被解码错乱并被当成命令执行
  (症状:`'xxx' 不是内部或外部命令` 窗口反复弹出)。

## 许可证

MIT(与 Castalia 一致)。图标与品牌资源随项目一并以 MIT 发布。
