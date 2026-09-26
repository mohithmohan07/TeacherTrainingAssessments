@echo off
rem Starts the scanner helper for Teacher Training Assessments.
rem
rem The helper is a small Python program. The first time, this fetches a
rem private copy of the official 32-bit Python (the scanner driver is 32-bit)
rem from nuget.org, checks it is exactly the expected file, and unpacks it into
rem your user folder. Nothing is installed for the whole computer.
setlocal EnableExtensions
title Scanner helper - Teacher Training Assessments
cd /d "%~dp0"

if not exist "%~dp0scan_helper.py" goto not_extracted

set "PY_VERSION=3.13.15"
set "PY_SHA256=e1f290012fa15337a32a4911d877fd8bd5e8a0f8d01c199b23d4d808785cc9c3"
set "PY_HOME=%LOCALAPPDATA%\TTA scanner helper\python-%PY_VERSION%-32bit"
set "PYTHON=%PY_HOME%\tools\python.exe"
set "TOOLS=%SystemRoot%\System32"

if exist "%PYTHON%" goto run

echo Setting up the scanner helper. This happens once and needs the internet.
echo Downloading Python %PY_VERSION% (32-bit) from nuget.org...
set "PACKAGE=%TEMP%\tta-python-%PY_VERSION%-32bit.zip"
"%TOOLS%\curl.exe" --fail --location --silent --show-error --output "%PACKAGE%" "https://api.nuget.org/v3-flatcontainer/pythonx86/%PY_VERSION%/pythonx86.%PY_VERSION%.nupkg"
if errorlevel 1 goto download_failed

set "ACTUAL="
rem No quotes around the program here: for /f would strip the wrong ones.
for /f "skip=1 delims=" %%H in ('%TOOLS%\certutil.exe -hashfile "%PACKAGE%" SHA256') do if not defined ACTUAL set "ACTUAL=%%H"
set "ACTUAL=%ACTUAL: =%"
if /i not "%ACTUAL%"=="%PY_SHA256%" goto bad_download

if not exist "%PY_HOME%" mkdir "%PY_HOME%"
"%TOOLS%\tar.exe" -xf "%PACKAGE%" -C "%PY_HOME%"
if errorlevel 1 goto unpack_failed
del "%PACKAGE%" >nul 2>&1
if not exist "%PYTHON%" goto unpack_failed
echo Done.
echo.

:run
"%PYTHON%" "%~dp0scan_helper.py" %*
if errorlevel 1 pause
exit /b

:not_extracted
echo This needs the whole "Scanner helper" folder. Right-click the zip you
echo downloaded, choose Extract All, then open the extracted folder and
echo double-click "Start scanner helper" there.
pause
exit /b 1

:download_failed
echo.
echo Could not download Python. Check the internet connection, then try again.
pause
exit /b 1

:bad_download
del "%PACKAGE%" >nul 2>&1
echo.
echo The downloaded Python was not the expected file, so it was deleted and
echo not used. Try again later.
pause
exit /b 1

:unpack_failed
echo.
echo Could not unpack Python into "%PY_HOME%".
pause
exit /b 1
