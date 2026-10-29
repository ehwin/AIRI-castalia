chcp 65001 >nul
@echo off
setlocal EnableDelayedExpansion

echo ===== AIRI 停止服务 =====
echo.

echo [1/4] 停 AIRI
taskkill /f /im airi.exe >nul 2>&1 && echo   - airi.exe 已停止 || echo   - airi.exe 未运行

echo [2/4] 停代理 5050
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5050" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
taskkill /f /fi "WINDOWTITLE eq AIRI-Proxy*" >nul 2>&1
echo   - 5050 端口已清理

echo [3/4] 清理旧嵌入 11435（共用嵌入 11436 由 Castalia 托盘管理，这里不杀）
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":11435" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo   - 旧 11435 已清理；11436 保留

echo [4/4] 停 Lemonade 13305
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":13305" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo   - 13305 端口已清理

echo.
echo ===== 已停止 =====
endlocal
