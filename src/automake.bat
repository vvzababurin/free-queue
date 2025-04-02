@echo off

setlocal enabledelayedexpansion

set DIR=%cd%

set INSTALLDIR=..\build

set JS_FILE=freequeue.js
set JS_FILE_TEMP=freequeue.js.temp
set JS_FILE_PART=freequeue.js.part
set JS_WASM_FILE=freequeue.asm.wasm
set JS_WASM_JS_FILE=freequeue.asm.js
set JS_WASM_WORKER_FILE=freequeue.asm.worker.js

if exist %JS_FILE% (
	@echo Delete existing file: %JS_FILE%
	@del %JS_FILE%
)

if exist %JS_WASM_JS_FILE% (
	@echo Delete existing file: %JS_WASM_JS_FILE%
	@del %JS_WASM_JS_FILE%
)

if exist %JS_WASM_WORKER_FILE% (
	@echo Delete existing file: %JS_WASM_WORKER_FILE%
	@del %JS_WASM_WORKER_FILE%
)

if exist %JS_WASM_FILE% (
	@echo Delete existing file: %JS_WASM_FILE%
	@del %JS_WASM_FILE%
)

rem @echo %CC%: freequeue.cpp -Llib -I../include -Iinclude -pthread -lwasm_workers %EMCCFLAGS% -o %JS_WASM_JS_FILE%
rem @call %CC% freequeue.cpp -Llib -I../include -Iinclude -pthread -lwasm_workers %EMCCFLAGS% -o %JS_WASM_JS_FILE%

@echo %CC%: freequeue.cpp -Llib -I../include -Iinclude -pthread %EMCCFLAGS% -o %JS_WASM_JS_FILE%
@call %CC% freequeue.cpp -Llib -I../include -Iinclude -pthread %EMCCFLAGS% -o %JS_WASM_JS_FILE%

@type %JS_FILE_PART% >> %JS_FILE%

if exist %JS_FILE% (
	@echo Copy existing file: %DIR%\%JS_FILE% %INSTALLDIR%\%JS_FILE% /Y
	@copy %DIR%\%JS_FILE% %INSTALLDIR%\%JS_FILE% /Y
)

if exist %JS_WASM_JS_FILE% (
 	@echo Copy existing file: %DIR%\%JS_WASM_JS_FILE% %INSTALLDIR%\%JS_WASM_JS_FILE% /Y
	@copy %DIR%\%JS_WASM_JS_FILE% %INSTALLDIR%\%JS_WASM_JS_FILE% /Y
)

if exist %JS_WASM_WORKER_FILE% (
 	@echo Copy existing file: %DIR%\%JS_WASM_WORKER_FILE% %INSTALLDIR%\%JS_WASM_WORKER_FILE% /Y
	@copy %DIR%\%JS_WASM_WORKER_FILE% %INSTALLDIR%\%JS_WASM_WORKER_FILE% /Y
)

if exist %JS_WASM_FILE% (
 	@echo Copy existing file: %DIR%\%JS_WASM_FILE% %INSTALLDIR%\%JS_WASM_FILE% /Y
	@copy %DIR%\%JS_WASM_FILE% %INSTALLDIR%\%JS_WASM_FILE% /Y
)

exit /b 0

