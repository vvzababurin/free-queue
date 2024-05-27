#!/bin/sh

# Emscripten SDK...
# export EMSCRIPTENDIR=c:/emscripten/emsdk

rm --force *.js
rm --force *.wasm

export DIR=`pwd`
sh ./automake.sh
