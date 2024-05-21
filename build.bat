@echo off

setlocal enabledelayedexpansion

rem Emscripten SDK...

set EMSCRIPTENDIR=c:/emscripten/emsdk

cd src
set DIR=%cd%
@call cmd /C "%EMSCRIPTENDIR:~0,2% && cd %EMSCRIPTENDIR% && emsdk_env.bat && %DIR:~0,2% && cd %DIR% && build.bat"
cd ..

@copy build\*.* ..\..\js /Y
@copy build\*.* ..\..\..\dist\js /Y