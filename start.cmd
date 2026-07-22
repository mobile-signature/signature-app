@echo off
REM Mobile Signature - opens the app.
REM
REM The app runs online, so nothing starts on this computer: no black window
REM to keep open, and the links it creates work on any phone.
REM
REM If the app ever moves to a different address, change this one line.
set "APP_URL=https://signature-app-n7vs.onrender.com/"

start "" "%APP_URL%"
