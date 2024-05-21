#!/bin/sh

export CC=emcc

export DIR=`pwd`

export INSTALLDIR="../build"
export SNDFILEDIR="libs/releasedir"

export WASM_JS_LIBNAME=free-queue.js
export WASM_JS_LIBNAME_PART=free-queue.js-part
export WASM_JS_WASM_LIBNAME=free-queue.wasm

if [ -f $WASM_JS_LIBNAME ]; then
	echo prepare: delete $WASM_JS_LIBNAME
	rm $WASM_JS_LIBNAME
fi

if [ -f $WASM_JS_WASM_LIBNAME ]; then
	echo prepare: delete $WASM_JS_WASM_LIBNAME
	rm $WASM_JS_WASM_LIBNAME
fi

#-s MODULARIZE=1 \
#-s EXPORT_ES6=1 \

#echo $CC: $CC free_queue.cpp -Llib -I../include -Iinclude -s SINGLE_FILE -s ALLOW_MEMORY_GROWTH=1 -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap'] -s MODULARIZE=1 -s EXPORT_ES6=1 -s INVOKE_RUN=0 -s USE_ES6_IMPORT_META=1 -O3 -o $WASM_JS_LIBNAME
#$CC free_queue.cpp -Llib -I../include -Iinclude -s SINGLE_FILE -s ALLOW_MEMORY_GROWTH=1 -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap'] -s MODULARIZE=1 -s EXPORT_ES6=1  -s INVOKE_RUN=0 -s USE_ES6_IMPORT_META=1 -O3 -o $WASM_JS_LIBNAME

echo %CC%: free_queue.cpp -Llib -I../include -Iinclude -pthread -s ENVIRONMENT=worker -s MODULARIZE=1 -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -s EXPORT_NAME=FQC -s EXPORT_ES6=1 -O3 -o %WASM_JS_LIBNAME%
$CC free_queue.cpp -Llib -I../include -Iinclude -pthread -s ENVIRONMENT=worker -s MODULARIZE=1 -s EXPORTED_RUNTIME_METHODS=['callMain','ccall','cwrap'] -s INVOKE_RUN=0 -s EXPORT_NAME=FQC -s EXPORT_ES6=1 -O3 -o %WASM_JS_LIBNAME%


# echo $CC: $CC free_queue.cpp -Llib -I../include -Iinclude -s ALLOW_MEMORY_GROWTH=1 -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap'] -s MODULARIZE=1 -s EXPORT_ES6=1 -s INVOKE_RUN=0 -s USE_ES6_IMPORT_META=1 -O3 -o $WASM_JS_LIBNAME
# $CC free_queue.cpp -Llib -I../include -Iinclude -s ALLOW_MEMORY_GROWTH=1 -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap'] -s MODULARIZE=1 -s EXPORT_ES6=1 -s INVOKE_RUN=0 -s USE_ES6_IMPORT_META=1 -O3 -o $WASM_JS_LIBNAME

#cat $WASM_JS_LIBNAME_PART >> $WASM_JS_LIBNAME

echo Copy exesting file: $DIR/$WASM_JS_LIBNAME $INSTALLDIR/$WASM_JS_LIBNAME
cp $DIR/$WASM_JS_LIBNAME $INSTALLDIR/$WASM_JS_LIBNAME

echo Copy exesting file: $DIR/$WASM_JS_WASM_LIBNAME $INSTALLDIR/$WASM_JS_WASM_LIBNAME
cp $DIR/$WASM_JS_WASM_LIBNAME $INSTALLDIR/$WASM_JS_WASM_LIBNAME

exit 0

