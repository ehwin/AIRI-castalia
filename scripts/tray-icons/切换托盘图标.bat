@echo off
chcp 65001 >nul
setlocal
set PY=C:\Users\yuepengcheng\AppData\Local\Programs\Python\Python310\python.exe
set SW=%~dp0use-tray-icon.py
:menu
cls
echo ============================================
echo    Castalia 托盘图标 - 切换版本
echo ============================================
"%PY%" "%SW%" status
echo.
echo   [1] 裁到盘边(盘外无黑)   ^<- 默认
echo   [2] 方图圆角 24%%(盘外留黑)
echo   [3] 只剩图案(透明底)
echo   [0] 退出
echo.
set /p c=请输入编号并回车: 
if "%c%"=="1" "%PY%" "%SW%" plate
if "%c%"=="2" "%PY%" "%SW%" square
if "%c%"=="3" "%PY%" "%SW%" glyph
if "%c%"=="0" exit /b
echo.
pause
goto menu
