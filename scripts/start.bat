chcp 65001 >nul
@echo off
title AIRI è®°å¿†ç³»ç»Ÿ Â· ä¸?é”?å?åŠ?
cd /d D:\system\AIRI

echo ============================================
echo   AIRI Memory System v4.0 â€? ä¸?é”?å?åŠ?
echo   %date% %time%
echo ============================================
echo.
rem â”?â”? æ­¥é?? 1: æ£?æŸ? Yuan-EB åµŒå…¥æœåŠ¡ â”?â”?
echo [1/4] æ£?æŸ? Yuan-EB (embedding æœåŠ¡ :11436)...
curl -s http://127.0.0.1:11436 >nul 2>&1
if %errorlevel% neq 0 (
    echo   [WARN] Yuan-EB æœ?å“åº”ï¼Œè?·å…ˆè¿è?? start-airi.bat å?åŠ¨åµŒå…¥æœåŠ?
    echo   æˆ–æ‰‹åŠ¨å¯åŠ?: python D:\AI\castalia\run\Castalia\yuan_embed_server.py
) else (
    echo   Yuan-EB âœ?
)
rem â”?â”? æ­¥é?? 2: å?åŠ? Lemonade (0.8B FLM åˆ†ç±»å™?) â”?â”?
echo [2/4] å?åŠ? Lemonade (0.8B FLM ç‰¹åŒ–æ¨¡å‹)...
netstat -ano | findstr ":13305" >nul 2>&1
if %errorlevel% equ 0 (
    echo   Lemonade å·²åœ¨è¿è?? âœ?
) else (
    echo   å?åŠ? LemonadeServer.exe ...
    cd /d D:\AI\Lemonade\bin
    start "" "LemonadeServer.exe"
    echo   ç­‰å¾… Lemonade å°±ç»ªï¼ˆåŠ è½? FLM æ¨¡å‹éœ?è¦? 10-30 ç§’ï¼‰...
    timeout /t 10 /nobreak >nul
rem åŠ è½½ FLM æ¨¡å‹ï¼ˆå?‚æœªåŠ è½½ï¼?
    lemonade.exe load qwen3.5-9b-FLM 2>nul
    timeout /t 10 /nobreak >nul
rem éªŒè¯
    curl -s http://127.0.0.1:13305/v1/models >nul 2>&1
    if %errorlevel% neq 0 (
        echo   [WARN] Lemonade ç«?å? 13305 æœ?å“åº”ï¼Œåˆ†ç±»åŠŸèƒ½å°†ä¸å¯ç”?
        echo   è¯·æ‰‹åŠ¨æ??æŸ?: D:\AI\Lemonade\bin\LemonadeServer.exe
    ) else (
        echo   Lemonade âœ?
    )
)
rem â”?â”? æ­¥é?? 3: å?åŠ¨ç»Ÿä¸?ä»£ç† (å? MemoryEngine) â”?â”?
echo [3/4] å?åŠ¨ç»Ÿä¸?ä»£ç† (Flask :5050 + MemoryEngine)...
netstat -ano | findstr ":5050" >nul 2>&1
if %errorlevel% equ 0 (
    echo   ä»£ç†å·²åœ¨è¿è?Œï¼Œå…ˆåœæ?...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5050" ^| findstr "LISTENING"') do (
        taskkill /f /pid %%a 2>nul
    )
    timeout /t 2 /nobreak >nul
)
rem è®¾ç¯å¢ƒå˜é‡? + å?åŠ?
set REALTIME_CLASSIFY=1
set LLM_UPSTREAM=https://api.deepseek.com/v1
set MEMORY_DIR=D:\AI\castalia\memory-banks\airi
set PYTHONPATH=

start "AIRI-Proxy" cmd /c "cd /d D:\system\AIRI\memory\unified-proxy && python proxy.py 2>&1 | tee proxy-console.log"

echo   ç­‰å¾…ä»£ç†å°±ç»ª...
timeout /t 5 /nobreak >nul
rem éªŒè¯ä»£ç†
curl -s http://127.0.0.1:5050/health >nul 2>&1
if %errorlevel% neq 0 (
    echo   [WARN] ä»£ç†æœ?å°±ç»ªï¼Œå†ç­? 5 ç§?...
    timeout /t 5 /nobreak >nul
    curl -s http://127.0.0.1:5050/health >nul 2>&1
    if %errorlevel% neq 0 (
        echo   [ERROR] ä»£ç†å?åŠ¨å¤±è´¥ï¼è¯·æ??æŸ? D:\system\AIRI\memory\unified-proxy\unified-proxy.log
        pause
        exit /b 1
    )
)
echo   ä»£ç† âœ?
rem â”?â”? æ­¥é?? 4: å?åŠ? AIRI â”?â”?
echo [4/4] AIRI éœ?è¦æ‰‹åŠ¨å¯åŠ?ï¼ˆElectron åº”ç”¨ï¼?
echo   è¯·æ‰“å¼? AIRIï¼Œç¡®è®? LLM baseUrl è®¾ç½®ä¸? http://127.0.0.1:5050/v1
echo.
rem â”?â”? çŠ¶æ?é¢æ? â”?â”?
echo ============================================
echo   æ‰?æœ‰æœåŠ¡å·²å°±ç»ªï¼?
echo.
echo   Yuan-EB   : http://127.0.0.1:11436
echo   Lemonade  : http://127.0.0.1:13305
echo   ä»£ç†      : http://127.0.0.1:5050
echo   å¥åº·æ£?æŸ?  : http://127.0.0.1:5050/health
echo   è®°å¿†ç®¡ç†  : D:\system\AIRI\memory\unified-proxy\reflect-admin.html
echo   å¯¹è¯æ—¥å¿—  : D:\system\AIRI\memory\unified-proxy\conversations.log
echo.
echo   æŒ? Ctrl+C ä¸ä¼šåœä»£ç†ï¼ˆä»£ç†åœ¨ç‹¬ç«‹çª—å£è¿è¡Œï¼‰
echo   è¦åœæ­¢æ‰€æœ‰æœåŠ¡ï¼Œè¿è?? stop.bat
echo ============================================

pause
