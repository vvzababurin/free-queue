@echo off

setlocal enabledelayedexpansion

rem Emscripten SDK...

set EMSCRIPTENDIR=d:/emscripten/emsdk

set CC=em++

rem set EMCCFLAGS=-s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=1 -s TOTAL_MEMORY=200MB -s ALLOW_MEMORY_GROWTH=0 -s EXPORT_NAME=LFreeQueue -std=c++17 -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap'] -s INVOKE_RUN=0 -O3
set EMCCFLAGS=-s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=0 -s TOTAL_MEMORY=200MB -s ALLOW_MEMORY_GROWTH=0 -s EXPORT_NAME=LFreeQueue -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -O3

if exist build\*.* (
	echo Empty 'build\*.*' directory
	@del build\*.* /F /Q
)

cd src
set DIR=%cd%
@call cmd /C "%EMSCRIPTENDIR:~0,2% && cd %EMSCRIPTENDIR% && emsdk_env.bat && %DIR:~0,2% && cd %DIR% && build.bat"
cd ..

@copy build\*.* examples\src\js /Y

cd examples

if not exist node_modules (
    @call cmd /C "npm install"
    @call cmd /C "npm run build:webpack"
    @call cmd /C "npm run start:webpack"
) else (
    @call cmd /C "npm run build:webpack"
    @call cmd /C "npm run start:webpack"
)

cd ..

