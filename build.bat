@echo off

setlocal enabledelayedexpansion

rem Emscripten SDK...

set EMSCRIPTENDIR=c:/emscripten/emsdk

set CC=emcc
set EMCCFLAGS=-s SINGLE_FILE=1 -s TOTAL_MEMORY=100MB -s BUILD_AS_WORKER=0 -s ALLOW_MEMORY_GROWTH=0 -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -O3

cd src
set DIR=%cd%
@call cmd /C "%EMSCRIPTENDIR:~0,2% && cd %EMSCRIPTENDIR% && emsdk_env.bat && %DIR:~0,2% && cd %DIR% && build.bat"
cd ..

@copy build\*.* examples\src\js /Y

cd examples
@call cmd /C "npm run build:webpack"
@call cmd /C "npm run start:webpack"
cd ..

