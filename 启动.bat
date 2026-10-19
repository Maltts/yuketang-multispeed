@echo off
chcp 65001 >nul
title 雨课堂视频加速助手
cd /d "%~dp0"

echo ================================================
echo    雨课堂视频加速助手  (5倍速 自动连播)
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto HAVEEDGE
set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto HAVEEDGE
echo [错误] 没有找到 Microsoft Edge 浏览器，请先安装 Edge。
echo.
pause
exit /b

:NONODE
echo [错误] 这台电脑没有安装 Node.js。
echo.
echo 请按以下步骤操作：
echo    1. 打开 https://nodejs.org
echo    2. 下载 LTS 版本（左边那个绿色按钮）
echo    3. 双击安装，一路点「下一步」即可
echo    4. 装完后重新双击本文件
echo.
pause
exit /b

:HAVEEDGE
echo [第 1 步] 正在打开专用浏览器窗口...
start "" "%EDGE%" --remote-debugging-port=9223 --user-data-dir="%~dp0profile" --no-first-run --no-default-browser-check "https://www.yuketang.cn/v2/web/index"
echo.
echo [第 2 步] 请在刚弹出的浏览器里完成：
echo          - 登录雨课堂（扫码或账号密码）
echo          - 进入要刷的课程，点开任意一个视频
echo          - 确认左侧能看到章节目录
echo.
echo 准备好后，回到本窗口，按任意键开始加速...
pause >nul

echo.
echo [第 3 步] 正在注入加速脚本，本窗口不要关...
echo.
set "CDP_MATCH=yuketang.cn"
node run-agent2.mjs
echo.
echo 脚本已退出（浏览器关掉了或出错）。
pause
