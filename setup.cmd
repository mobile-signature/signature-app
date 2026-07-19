@echo off
REM Mobile Signature - double-click this file to set up and start everything.
REM -ExecutionPolicy Bypass applies to THIS run only; it changes no system
REM setting, which is why setup works without touching your security policy.
title Mobile Signature
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 pause
