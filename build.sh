#!/bin/sh

# Emscripten SDK...
# export EMSCRIPTENDIR=c:/emscripten/emsdk

export CC=emcc
export EMCCFLAGS="-s SINGLE_FILE=1 -s ALLOW_MEMORY_GROWTH=0 -s TOTAL_MEMORY=100MB -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap'] -s INVOKE_RUN=1 -O3"

cd src
export DIR=`pwd`
sh ./build.sh
cd ..

cp build/*.* examples/src/js

cd examples
npm run build:webpack
npm run start:webpack
cd ..