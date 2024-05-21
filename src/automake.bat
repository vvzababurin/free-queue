@echo off

setlocal enabledelayedexpansion

set CC=emcc

set DIR=%cd%

set INSTALLDIR=..\build

set WASM_JS_LIBNAME=free-queue.js
set WASM_JS_LIBNAME_PART=free-queue.js-part
set WASM_JS_WASM_LIBNAME=free-queue.wasm

if exist %WASM_JS_LIBNAME% (
	@echo Delete existing file: %WASM_TEMP_JS_LIBNAME%
	@del %WASM_JS_LIBNAME%
)

if exist %WASM_JS_WASM_LIBNAME% (
	@echo Delete existing file: %WASM_JS_WASM_LIBNAME%
	@del %WASM_JS_WASM_LIBNAME%
)

rem if not exist !CC! (
rem 	echo prepare: !CC! WASM compiler is not present...
rem 	exit /b 1
rem )

rem @echo %CC%: free_queue.cpp -Llib -I../include -Iinclude -s SINGLE_FILE -s ALLOW_MEMORY_GROWTH=1 -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap'] -s INVOKE_RUN=0 -s USE_ES6_IMPORT_META=1 -O3 -o %WASM_JS_LIBNAME%
rem @call %CC% free_queue.cpp -Llib -I../include -Iinclude -s SINGLE_FILE -s ALLOW_MEMORY_GROWTH=1 -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap'] -s INVOKE_RUN=0 -s USE_ES6_IMPORT_META=1 -O3 -o %WASM_JS_LIBNAME%

@echo %CC%: free_queue.cpp -Llib -I../include -Iinclude -pthread -s ENVIRONMENT=worker -s MODULARIZE=1 -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -s EXPORT_NAME=FQC -s EXPORT_ES6=1 -O3 -o %WASM_JS_LIBNAME%
@call %CC% free_queue.cpp -Llib -I../include -Iinclude -pthread -s ENVIRONMENT=worker -s MODULARIZE=1 -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -s EXPORT_NAME=FQC -s EXPORT_ES6=1 -O3 -o %WASM_JS_LIBNAME%

rem type %WASM_JS_LIBNAME_PART% >> %WASM_JS_LIBNAME%

echo Copy exesting file: %DIR%\%WASM_JS_LIBNAME% %INSTALLDIR%\%WASM_JS_LIBNAME% /Y
copy %DIR%\%WASM_JS_LIBNAME% %INSTALLDIR%\%WASM_JS_LIBNAME% /Y

echo Copy exesting file: %DIR%\%WASM_JS_WASM_LIBNAME% %INSTALLDIR%\%WASM_JS_WASM_LIBNAME% /Y
copy %DIR%\%WASM_JS_WASM_LIBNAME% %INSTALLDIR%\%WASM_JS_WASM_LIBNAME% /Y


exit /b 0

