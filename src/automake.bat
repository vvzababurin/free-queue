@echo off

setlocal enabledelayedexpansion

set DIR=%cd%

set INSTALLDIR=..\build

set JS_FILE=free_queue.js
set JS_FILE_TEMP=free_queue.js.temp
set JS_FILE_PART=free_queue.js.part
set JS_WASM_FILE=free_queue.wasm.js

if exist %JS_FILE% (
	@echo Delete existing file: %JS_FILE%
	@del %JS_FILE%
)

if exist %JS_WASM_FILE% (
	@echo Delete existing file: %JS_WASM_FILE%
	@del %JS_WASM_FILE%
)

@echo %CC%: free_queue.cpp -Llib -I../include -Iinclude -pthread %EMCCFLAGS% -o %JS_WASM_FILE%
@call %CC% free_queue.cpp -Llib -I../include -Iinclude -pthread %EMCCFLAGS% -o %JS_WASM_FILE%

rem @type %JS_FILE_PART% >> %JS_FILE%

@type %JS_FILE_PART% >> %JS_FILE%

if exist %JS_FILE% (
	@echo Copy existing file: %DIR%\%JS_FILE% %INSTALLDIR%\%JS_FILE% /Y
	@copy %DIR%\%JS_FILE% %INSTALLDIR%\%JS_FILE% /Y
)

if exist %JS_WASM_FILE% (
 	@echo Copy existing file: %DIR%\%JS_WASM_FILE% %INSTALLDIR%\%JS_WASM_FILE% /Y
	@copy %DIR%\%JS_WASM_FILE% %INSTALLDIR%\%JS_WASM_FILE% /Y
)

exit /b 0

