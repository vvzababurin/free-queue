@echo off

setlocal enabledelayedexpansion

rem Emscripten SDK...

set EMSCRIPTENDIR=c:/emscripten/emsdk

set CC=emcc
set EMCCFLAGS=-s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=0 -s TOTAL_MEMORY=200MB -s ALLOW_MEMORY_GROWTH=0 -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -O3

@del build\*.* /F /Q

cd src
set DIR=%cd%
@call cmd /C "%EMSCRIPTENDIR:~0,2% && cd %EMSCRIPTENDIR% && emsdk_env.bat && %DIR:~0,2% && cd %DIR% && build.bat"
cd ..

rem @copy build\*.* examples\src\js /Y
@copy build\*.* examples\src\free-queue /Y

cd examples
@call cmd /C "npm run build:webpack"
@call cmd /C "npm run start:webpack"
cd ..

