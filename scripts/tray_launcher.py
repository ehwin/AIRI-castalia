# -*- coding: utf-8 -*-
"""Castalia 记忆体 —— 品牌宿主启动器(2026-09-15)

PyInstaller 打包入口。它只解决两件事:
  1. 让任务管理器 / 文件属性 / 托盘 显示品牌(名称、图标、版本、许可);
  2. 把第三方依赖收进 exe(见下方 import 清单)。

**真正的代码仍从磁盘加载**:默认加载托盘脚本,也可用第一个参数指定任意脚本:
    Castalia.exe                                  → 托盘
    Castalia.exe <路径\\castalia_guard.py> --check → 守护脚本(参数透传)
    (外部应用的钩子不走本宿主 —— LobeHub 记忆钩子用 pythonw.exe 跑,见启动项)

所以:改逻辑不用重新打包;只有**新增第三方依赖**时才需要重打(scripts/build_tray.cmd)。

不会打包任何 node 组件:记忆桥/引擎/星图仍是运行时按绝对路径拉起的外部进程。
"""
import os
import runpy
import sys
import subprocess
import glob

# 显式 import —— 告诉 PyInstaller 把依赖收进 exe(磁盘上的各脚本真正用到它们):
#   psutil / pystray / PIL  → 托盘
#   psycopg2                → LobeHub 对话记忆钩子
#   cryptography            → keys.enc 解密 / 嵌入模式判定(keys_util 动态 import,静态分析会漏)
#   tkinter                 → 设置窗口(castalia_settings.py 独立进程启动;动态加载,静态分析会漏)
try:
    import psutil            # noqa: F401
    import pystray           # noqa: F401
    import PIL.Image         # noqa: F401
    import PIL.ImageDraw     # noqa: F401
except Exception:
    pass
try:
    import tkinter           # noqa: F401
    import tkinter.ttk       # noqa: F401
    import tkinter.filedialog  # noqa: F401
    import tkinter.messagebox  # noqa: F401
except Exception:
    pass
# ⚠️ 外部应用的依赖一律**不打进来**(用户 2026-09-22 明确):
#   · 曾为 LobeHub 记忆钩子打过 psycopg2(连带 numpy,占 _internal 近 47MB)
#   · 钩子属于外部应用(LobeHub/docker/Postgres)的集成件,改由系统 Python 的 pythonw.exe 运行,
#     不再宿主在本 exe 上 —— 本 exe 只跑我们自己的组件(托盘/守护/外壳)。
try:
    import cryptography                                          # noqa: F401
    from cryptography.fernet import Fernet                       # noqa: F401
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: F401
except Exception:
    pass

DEFAULT_SCRIPT = r"D:\castalia\run\Castalia\scripts\castalia_tray.py"


def _pick_script():
    """第一个参数若是 .py 路径,就加载它(其余参数透传给脚本)。"""
    if len(sys.argv) > 1 and sys.argv[1].lower().endswith(".py"):
        target = sys.argv[1]
        sys.argv = [target] + sys.argv[2:]      # 让脚本拿到干净的参数
        return target
    return DEFAULT_SCRIPT


SCRIPT = _pick_script()

# Hermes hook 属于外部集成，必须交给带标准库 sqlite3 的 Python 运行，
# 不能在精简 PyInstaller 宿主内 runpy 导入。
if os.path.basename(SCRIPT).lower() == "hermes_memory_hook.py":
    candidates = []
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        candidates.extend(glob.glob(os.path.join(local, "hermes", "tools", "python-*-win32-x64", "python.exe")))
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        candidates.extend(glob.glob(os.path.join(hermes_home, "tools", "python-*-win32-x64", "python.exe")))
    candidates.extend(glob.glob(r"D:\AI\hermes-home\tools\python-*-win32-x64\python.exe"))
    py = next((p for p in candidates if p and os.path.isfile(p) and os.path.abspath(p) != os.path.abspath(sys.executable)), None)
    if py:
        try:
            raise SystemExit(subprocess.call([py, SCRIPT] + sys.argv[1:]))
        except OSError:
            pass

if not os.path.exists(SCRIPT):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            0,
            f"找不到脚本:\n{SCRIPT}\n\n请检查目录是否被移动或 D 盘是否就绪。",
            "Castalia 记忆体 · 启动失败",
            0x10,   # MB_ICONERROR
        )
    except Exception:
        pass
    sys.exit(1)

# 让磁盘上的脚本能 import 同目录模块(如 castalia_guard 复用托盘逻辑)
sys.path.insert(0, os.path.dirname(SCRIPT))

# ⚠️ 异常绝不能漏出去:PyInstaller 的 windowed exe(--noconsole)遇到未捕获异常会弹
# **系统错误对话框**,用户只会看到一个莫名奇妙的 Traceback 窗口。这里兜住并落日志。
try:
    runpy.run_path(SCRIPT, run_name="__main__")
except SystemExit:
    raise
except BaseException:
    try:
        import traceback
        log = os.path.join(os.path.dirname(SCRIPT), "launcher-error.log")
        with open(log, "a", encoding="utf-8") as f:
            f.write(f"\n===== {SCRIPT} @ {__import__('datetime').datetime.now():%Y-%m-%d %H:%M:%S} =====\n")
            f.write(traceback.format_exc())
    except Exception:
        pass
    sys.exit(1)
