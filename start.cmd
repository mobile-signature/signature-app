@echo off
REM Mobile Signature - run on THIS COMPUTER ONLY.
REM No tunnel, nothing exposed to the internet. Use setup.cmd when you are
REM ready to put it on your phone.
title Mobile Signature (local)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -LocalOnly
if errorlevel 1 pause
