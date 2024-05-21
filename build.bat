@echo off

setlocal enabledelayedexpansion

rem Emscripten SDK...

set EMSCRIPTENDIR=c:/emscripten/emsdk

rem -s EXPORT_NAME=FQC

set CC=emcc
set EMCCFLAGS=-s SINGLE_FILE=1 -s MODULARIZE=1 -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -s EXPORT_NAME=WasmFreeQueue -s EXPORT_ES6=1 -O3

cd src
set DIR=%cd%
@call cmd /C "%EMSCRIPTENDIR:~0,2% && cd %EMSCRIPTENDIR% && emsdk_env.bat && %DIR:~0,2% && cd %DIR% && build.bat"
cd ..

@copy build\*.* example\public\js /Y

cd example
npm run start
cd ..

