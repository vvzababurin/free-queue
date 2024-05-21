@echo off

setlocal enabledelayedexpansion

rem Emscripten SDK...

set DIR=%cd%
@call cmd /C "%EMSCRIPTENDIR:~0,2% && cd %EMSCRIPTENDIR% && emsdk_env.bat && %DIR:~0,2% && cd %DIR% && automake.bat"
