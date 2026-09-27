@echo off
rem Run a command inside the MSVC build environment (vcvars64).
rem
rem Why this exists: in Git Bash / some shells, /usr/bin/link (GNU coreutils)
rem shadows MSVC link.exe and cargo builds fail with "link: extra operand".
rem Also, PATH order is not reliable when commands run through pnpm/npm
rem indirection, so rustc gets the MSVC linker pinned via RUSTC_LINKER.
rem
rem Usage (from any shell, with cargo & pnpm on PATH):
rem   cmd /c "scripts\msvc-run.cmd cargo check --manifest-path src-tauri\Cargo.toml"
rem   cmd /c "scripts\msvc-run.cmd pnpm tauri build"

setlocal

rem Try vswhere first (covers normally-registered VS installs).
set "VSDIR="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
  set "VSTMP=%TEMP%\zmate-msvc-vsdir.txt"
  "%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%VSTMP%" 2>nul
  set /p VSDIR=<"%VSTMP%"
)

rem Fall back to probing standard install locations (covers unregistered or
rem manually-installed Build Tools, where vswhere reports no instances).
if not defined VSDIR if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VSDIR=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools"
if not defined VSDIR if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VSDIR=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Community"
if not defined VSDIR if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat" set "VSDIR=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Professional"
if not defined VSDIR if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat" set "VSDIR=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Enterprise"
if not defined VSDIR if exist "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VSDIR=%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools"
if not defined VSDIR if exist "%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VSDIR=%ProgramFiles%\Microsoft Visual Studio\2022\Community"
if not defined VSDIR if exist "%ProgramFiles%\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat" set "VSDIR=%ProgramFiles%\Microsoft Visual Studio\2022\Professional"
if not defined VSDIR if exist "%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat" set "VSDIR=%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise"

if not defined VSDIR (
  echo [msvc-run] Visual Studio / Build Tools with C++ workload not found.
  echo [msvc-run] Install "Desktop development with C++" first.
  exit /b 1
)

call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul

rem Pin rustc to the MSVC linker regardless of PATH order. The version dir
rem (e.g. 14.44.35207) changes between toolchain updates, so pick the newest.
dir /b /ad /o-n "%VSDIR%\VC\Tools\MSVC" > "%TEMP%\zmate-msvc-vcver.txt" 2>nul
set /p MSVCVER=<"%TEMP%\zmate-msvc-vcver.txt"
if defined MSVCVER (
  set "RUSTC_LINKER=%VSDIR%\VC\Tools\MSVC\%MSVCVER%\bin\Hostx64\x64\link.exe"
)

%*
