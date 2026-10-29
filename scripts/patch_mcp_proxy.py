# -*- coding: utf-8 -*-
"""给 mcp-proxy 打补丁:派生引擎时用 DETACHED_PROCESS,避免 Windows Terminal 弹窗

背景
  mcp-proxy 用 MCP SDK 的 StdioClientTransport 派生 node 引擎,spawn 时没设 detached。
  引擎是控制台程序,在没有可用控制台的情况下 Windows 会**新建**一个 →
  Windows 11 默认终端是 Windows Terminal 时,就弹出一个
  "Default: D:\\...\\CastaliaNode.exe" 的窗口(用户报告:老弹控制台框)。

修法
  在 spawn options 里加 `detached: true`(Windows 上 = DETACHED_PROCESS):
  不继承、也不新建控制台。实测:引擎无 conhost、不再出现新的 WT/OpenConsole 进程。

用法
  python patch_mcp_proxy.py            # 打补丁(幂等)
  python patch_mcp_proxy.py --check    # 只检查是否已打

何时需要重跑
  **升级/重装 mcp-proxy 后**(npm/pnpm 会覆盖 dist 文件)。检查:脚本 --check 报"未打补丁"。
"""
import argparse
import io
import os
import shutil
import sys
import time
import tempfile
import re

PROXY = r"D:\AI\castalia\run\LobeHub\node_modules\mcp-proxy\dist\bin\mcp-proxy.mjs"
BAK_DIR = r"D:\AI\castalia\_归档\mcp-proxy-patch"

ANCHOR = ("\t\t\t\tshell: this._serverParams.shell ?? false,\n"
          "\t\t\t\tsignal: this._abortController.signal,\n")
PATCH_LINE = "\t\t\t\tdetached: true,   // Castalia patch: 不新建控制台(防 Windows Terminal 弹窗)\n"

def patch_text(s):
    """Validate only the SDK server spawn block; accept existing equivalent patches."""
    pattern = r'this\._process = spawn\(this\._serverParams\.command, this\._serverParams\.args \?\? \[\], \{([\s\S]*?)\n\s*\}\);'
    blocks = list(re.finditer(pattern, s))
    if len(blocks) != 1:
        raise ValueError('目标 spawn 必须唯一，当前版本不支持')
    block = blocks[0]
    code = re.sub(r'/\*[\s\S]*?\*/|//[^\n]*', '', block.group(1))
    detached = re.findall(r'\bdetached\s*:\s*([^,\n]+)', code)
    if detached:
        if detached != ['true']:
            raise ValueError('目标 spawn 的 detached 重复或值异常')
        return s, False
    if block.group(1).count(ANCHOR) != 1:
        raise ValueError('目标 spawn 锚点失配，拒绝写入')
    replacement = block.group(0).replace(ANCHOR, ANCHOR + PATCH_LINE, 1)
    return s[:block.start()] + replacement + s[block.end():], True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查,不修改")
    ap.add_argument("--proxy", default=PROXY, help="待检查的 mcp-proxy 文件")
    args = ap.parse_args()

    proxy = args.proxy
    if not os.path.exists(proxy):
        print("找不到 mcp-proxy:", proxy)
        return 2
    with open(proxy, encoding="utf-8") as handle:
        s = handle.read()
    try:
        patched, changed = patch_text(s)
    except ValueError as e:
        print("补丁预检失败:", e)
        return 2
    if not changed:
        print("[OK] 已是补丁状态 (无需处理)")
        return 0
    if args.check:
        print("[MISSING] 未打补丁 —— 请不带 --check 运行以修复(否则会弹控制台窗口)")
        return 1

    os.makedirs(BAK_DIR, exist_ok=True)
    bak = os.path.join(BAK_DIR, f"mcp-proxy.mjs.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(proxy, bak)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(proxy), prefix=".mcp-proxy-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(patched); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, proxy)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    print("补丁已写入。备份:", bak)
    print("生效方式:重启记忆桥(托盘菜单 → 服务 → 记忆桥,或跑 scripts/castalia_guard.py)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
