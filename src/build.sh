#!/bin/sh

# Emscripten SDK...
# export EMSCRIPTENDIR=c:/emscripten/emsdk

rm -f *.js
rm -f *.wasm

export DIR=`pwd`
sh ./automake.sh
