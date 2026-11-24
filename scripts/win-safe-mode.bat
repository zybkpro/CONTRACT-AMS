@echo off
chcp 65001 >nul
title 合同管理系统 - 安全模式
echo 正在以安全模式（禁用 GPU 硬件加速）启动合同管理系统...
echo 适用于：打开后无窗口、任务管理器有进程、黑屏等显卡兼容问题。
echo.
set CONTRACTAMS_SOFTWARE_RENDER=1
set CONTRACTAMS_DISABLE_GPU=1
start "" "%~dp0CONTRACT-AMS.exe"
