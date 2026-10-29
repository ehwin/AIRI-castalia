"""切换 Castalia 托盘图标版本(plate/square/glyph),并可选重启托盘使其生效。

用法:
    python use-tray-icon.py status              # 看当前是哪一版
    python use-tray-icon.py plate               # 切到 ① 裁到盘边(默认)
    python use-tray-icon.py square              # 切到 ② 方图圆角
    python use-tray-icon.py glyph               # 切到 ③ 只剩图案
    python use-tray-icon.py plate --no-restart  # 只换文件,不重启托盘
"""
import os, sys, shutil, subprocess, time

HERE = os.path.dirname(os.path.abspath(__file__))          # .../scripts/tray-icons
SCRIPTS = os.path.dirname(HERE)
TRAY = os.path.join(SCRIPTS, "castalia_tray.py")
ACTIVE = os.path.join(HERE, "active-64.png")
VERSIONS = {"plate": "① 裁到盘边(盘外无黑)", "square": "② 方图圆角 24%", "glyph": "③ 只剩图案(透明底)"}


def tray_pids():
    r = subprocess.run(["powershell", "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' or Name='python.exe'\" | "
        "Where-Object { $_.CommandLine -like '*castalia_tray.py*' } | ForEach-Object { $_.ProcessId }"],
        capture_output=True, text=True)
    return [x for x in r.stdout.split() if x.strip().isdigit()]


def current():
    for k in VERSIONS:
        ref = os.path.join(HERE, k, "castalia-%s-64.png" % k)
        if os.path.exists(ACTIVE) and os.path.exists(ref) and open(ACTIVE, "rb").read() == open(ref, "rb").read():
            return k
    return "(未知/自定义)"


def restart_tray():
    pids = tray_pids()
    for p in pids:
        subprocess.run(["taskkill", "/F", "/PID", p], capture_output=True)
    time.sleep(1.5)
    env = dict(os.environ); env["PYTHONPATH"] = ""     # 关键:清污染,否则 Python310 加载错二进制
    exe = sys.executable
    pyw = os.path.join(os.path.dirname(exe), "pythonw.exe")
    if not os.path.exists(pyw): pyw = exe            # 兜底:没有 pythonw 就用 python
    subprocess.Popen([pyw, TRAY], cwd=SCRIPTS, env=env,
                     creationflags=0x00000008 | 0x08000000,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    time.sleep(6)
    return pids, tray_pids()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args or args[0] == "status":
        print("当前托盘图标: %s" % current())
        print("可用版本: " + " / ".join("%s=%s" % (k, v) for k, v in VERSIONS.items()))
        return
    key = args[0].lower()
    if key not in VERSIONS:
        print("未知版本 %r,可选: %s" % (key, ", ".join(VERSIONS))); return
    src = os.path.join(HERE, key, "castalia-%s-64.png" % key)
    if not os.path.exists(src):
        print("找不到 %s,库可能未生成(跑 make_icons.py)" % src); return
    shutil.copy2(src, ACTIVE)
    print("已切换到 %s → %s" % (VERSIONS[key], ACTIVE))
    if "--no-restart" in sys.argv:
        print("(未重启托盘:重启后生效)"); return
    old, new = restart_tray()
    print("托盘 pid: %s → %s %s" % (old, new, "✓" if new and set(new) != set(old) else "✗"))


if __name__ == "__main__":
    main()
