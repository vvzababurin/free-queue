#!/bin/sh

# Emscripten SDK...
# export EMSCRIPTENDIR=c:/emscripten/emsdk

cd src
export DIR=`pwd`
sh ./build.sh
cd ..

cp build/*.* ../../js
cp build/*.* ../../../dist/js