#!/bin/sh

# Emscripten SDK...
# export EMSCRIPTENDIR=c:/emscripten/emsdk

export CC=emcc
export EMCCFLAGS="-s SINGLE_FILE=1 -s TOTAL_MEMORY=200MB -s ALLOW_MEMORY_GROWTH=0 -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -O3"

rm --force build/*.*

cd src
export DIR=`pwd`
sh ./build.sh
cd ..

cp build/*.* examples/src/js

cd examples
npm run build:webpack
npm run start:webpack
cd ..