@echo off

setlocal enabledelayedexpansion

set DIR=%cd%

set INSTALLDIR=..\build

set JS_FILE=free-queue.js
set JS_FILE_TEMP=free-queue.js.temp
set JS_FILE_PART=free-queue.js.part
set JS_WASM_FILE=free-queue.wasm.wasm
set JS_WASM_JS_FILE=free-queue.wasm.js
set JS_WASM_WORKER_BLOB_FILE=free-queue.wasm.worker.js.blob
set JS_WASM_WORKER_FILE=free-queue.wasm.worker.js

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

@echo %CC%: free_queue.cpp -Llib -I../include -Iinclude -pthread %EMCCFLAGS% -o %JS_WASM_JS_FILE%
@call %CC% free_queue.cpp -Llib -I../include -Iinclude -pthread %EMCCFLAGS% -o %JS_WASM_JS_FILE%

if exist %JS_WASM_WORKER_FILE% (
	@echo Convert to base64 existing file: %JS_WASM_WORKER_FILE%
	@openssl base64 -A -in %JS_WASM_WORKER_FILE% > %JS_WASM_WORKER_BLOB_FILE%
rem	@del %JS_WASM_WORKER_FILE%
)

@type %JS_FILE_PART% >> %JS_FILE%
@type %JS_WASM_JS_FILE% >> %JS_FILE%

rem fartt -q %JS_WASM_JS_FILE% "locateFile(\"!JS_WASM_WORKER_FILE!\")" "window[\"pthreadBlobMainJs\"]"

rem @echo|set /p=window["pthreadBlobMainJs"] = 'data:text/javascript;base64,>> %JS_FILE%
rem @type %JS_WASM_WORKER_BLOB_FILE% >> %JS_FILE%
rem @echo ' >> %JS_FILE%

rem @type %JS_WASM_JS_FILE% >> %JS_FILE%

if exist %JS_WASM_JS_FILE% (
	@echo Delete existing file: %JS_WASM_JS_FILE%
	@del %JS_WASM_JS_FILE%
)

rem @del %JS_WASM_WORKER_BLOB_FILE%

if exist %JS_FILE% (
	@echo Copy existing file: %JS_FILE% %INSTALLDIR%\%JS_FILE% /Y
	@copy %JS_FILE% %INSTALLDIR%\%JS_FILE% /Y
)

if exist %JS_WASM_JS_FILE% (
 	@echo Copy existing file: %JS_WASM_JS_FILE% %INSTALLDIR%\%JS_WASM_JS_FILE% /Y
	@copy %JS_WASM_JS_FILE% %INSTALLDIR%\%JS_WASM_JS_FILE% /Y
)

if exist %JS_WASM_WORKER_FILE% (
 	@echo Copy existing file: %JS_WASM_WORKER_FILE% %INSTALLDIR%\%JS_WASM_WORKER_FILE% /Y
	@copy %JS_WASM_WORKER_FILE% %INSTALLDIR%\%JS_WASM_WORKER_FILE% /Y
)

if exist %JS_WASM_FILE% (
 	@echo Copy existing file: %JS_WASM_FILE% %INSTALLDIR%\%JS_WASM_FILE% /Y
	@copy %JS_WASM_FILE% %INSTALLDIR%\%JS_WASM_FILE% /Y
)

exit /b 0

