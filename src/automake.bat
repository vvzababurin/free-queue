@echo off

setlocal enabledelayedexpansion

set DIR=%cd%

set INSTALLDIR=..\build

set JS_FILE=free-queue.js
set JS_FILE_TEMP=free-queue.js.temp
set JS_FILE_PART=free-queue.js.part
set JS_WASM_FILE=free-queue.asm.wasm
set JS_WASM_JS_FILE=free-queue.asm.js
set JS_WASM_WORKER_BLOB_FILE=free-queue.asm.worker.js.blob
set JS_WASM_WORKER_FILE=free-queue.asm.worker.js

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
	@del %JS_WASM_WORKER_FILE%
)

@type %JS_FILE_PART% > %JS_FILE%

@echo|set /p ="var pthreadMainBlobJs='" >> %JS_FILE%
@type %JS_WASM_WORKER_BLOB_FILE% >> %JS_FILE%
@echo|set /p ="';" >> %JS_FILE%
@echo: >> %JS_FILE%

fartt -q %JS_WASM_JS_FILE% "var pthreadMainJs=locateFile(\"!JS_WASM_WORKER_FILE!\")" "var pthreadMainJs=decodeBase64(pthreadMainBlobJs);var URL=(window.URL||window.webkitURL);var blob=new Blob([pthreadMainJs],{type:\"application/javascript\"})"
fartt -q %JS_WASM_JS_FILE% "PThread.unusedWorkers.push(new Worker(pthreadMainJs))" "PThread.unusedWorkers.push(new Worker(URL.createObjectURL(blob)))"

@type %JS_WASM_JS_FILE% >> %JS_FILE%

if exist %JS_WASM_WORKER_BLOB_FILE% (
	@echo Delete existing file: %JS_WASM_WORKER_BLOB_FILE%
	@del %JS_WASM_WORKER_BLOB_FILE%
)

if exist %JS_WASM_JS_FILE% (
	@echo Delete existing file: %JS_WASM_JS_FILE%
	@del %JS_WASM_JS_FILE%
)

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

