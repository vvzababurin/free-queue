@echo off

setlocal enabledelayedexpansion

rem Emscripten SDK...

if exist *.js (
	@del *.js /F /Q
)

if exist *.wasm (
	@del *.wasm /F /Q
)

set DIR=%cd%
@call cmd /C "%EMSCRIPTENDIR:~0,2% && cd %EMSCRIPTENDIR% && emsdk_env.bat && %DIR:~0,2% && cd %DIR% && automake.bat"
