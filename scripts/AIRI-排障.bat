chcp 65001 >nul
@echo off
title AIRI 排障中心

echo ========================================
echo   AIRI 服务状态检查
echo ========================================
echo.
rem --- 检查各服务端口 ---
echo [1/4] Yuan-EB 嵌入服务 (:11436 共用)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":11436" ^| findstr "LISTENING"') do (
    echo       ✅ 运行中 (PID %%a)
    goto :embed_ok
)
echo       ❌ 未运行
:embed_ok

echo [2/4] AIRI 代理 (:5050)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5050" ^| findstr "LISTENING"') do (
    echo       ✅ 运行中 (PID %%a)
    goto :proxy_ok
)
echo       ❌ 未运行
:proxy_ok

echo [3/4] Lemonade 分拣 (:13305)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":13305" ^| findstr "LISTENING"') do (
    echo       ✅ 运行中 (PID %%a)
    goto :lemon_ok
)
echo       ⚠️ 未运行（记忆分拣降级，其他功能正常）
:lemon_ok

echo [4/4] AIRI 主程序
tasklist /fi "imagename eq airi.exe" 2>nul | findstr /i airi >nul
if %errorlevel% equ 0 (
    echo       ✅ 运行中
) else (
    echo       ❌ 未运行
)

echo.
echo ========================================
echo   日志文件位置:
echo   ├ 代理日志   memory\unified-proxy\unified-proxy.log
echo   ├ 对话记录   memory\unified-proxy\conversations.log
echo   ├ 记忆引擎   memory\unified-proxy\memory-engine.log
echo   └ 嵌入服务   memory\memory-fused\embed-server.log
echo ========================================
echo.
echo   按任意键打开日志目录...
pause >nul
explorer "D:\system\AIRI\memory\unified-proxy"
