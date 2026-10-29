chcp 65001 >nul
@echo off
title AIRI 实时日志

echo ========================================
echo   AIRI 实时日志 (Ctrl+C 退出)
echo   1=代理  2=对话  3=记忆引擎  4=嵌入服务  0=全部
echo ========================================
echo.
set /p choice=选择日志编号: 

if "%choice%"=="1" (
    type "D:\system\AIRI\memory\unified-proxy\unified-proxy.log" | more
) else if "%choice%"=="2" (
    type "D:\system\AIRI\memory\unified-proxy\conversations.log" | more
) else if "%choice%"=="3" (
    type "D:\system\AIRI\memory\unified-proxy\memory-engine.log" | more
) else if "%choice%"=="4" (
    type "D:\system\AIRI\memory\memory-fused\embed-server.log" | more
) else if "%choice%"=="0" (
    type "D:\system\AIRI\memory\unified-proxy\unified-proxy.log" | more
) else (
    echo 无效选择
)

echo.
pause
