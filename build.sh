#!/bin/sh

# Emscripten SDK...
# export EMSCRIPTENDIR=c:/emscripten/emsdk

export CC=emcc
export EMCCFLAGS=-s SINGLE_FILE=1 -s MODULARIZE=1 -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -s EXPORT_NAME=WasmFreeQueue -s EXPORT_ES6=1 -O3

cd src
export DIR=`pwd`
sh ./build.sh
cd ..

cp build/*.* example/public/js

cd example
npm run start
cd ..