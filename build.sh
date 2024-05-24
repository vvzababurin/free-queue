#!/bin/sh

# Emscripten SDK...
# export EMSCRIPTENDIR=c:/emscripten/emsdk

export CC=emcc
export EMCCFLAGS="-s SINGLE_FILE=1 -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap'] -s INVOKE_RUN=0 -O3 "

#export EMCCFLAGS=-s SINGLE_FILE=1 -s MODULARIZE=1 -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -s EXPORT_NAME=WasmFreeQueue -s EXPORT_ES6=1 -O3

cd src
export DIR=`pwd`
sh ./build.sh
cd ..

cp build/*.* examples/src/js

cd examples
npm run build:webpack
npm run start:webpack
cd ..