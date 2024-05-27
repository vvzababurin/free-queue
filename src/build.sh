#!/bin/sh

# Emscripten SDK...
# export EMSCRIPTENDIR=c:/emscripten/emsdk

rm --force build/*.js
rm --force build/*.wasm

export DIR=`pwd`
sh ./automake.sh
