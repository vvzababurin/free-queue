#!/bin/sh

export DIR=`pwd`

export INSTALLDIR=../build

export JS_FILE=free-queue.js
export JS_FILE_TEMP=free-queue.js.temp
export JS_FILE_PART=free-queue.js.part
export JS_FILE_WASM=free-queue.wasm.js

if [ -f $JS_FILE ]; then
	echo Delete existing file: $JS_FILE
	rm $JS_FILE
fi

if [ -f $JS_FILE_WASM ]; then
	echo Delete existing file: $JS_FILE_WASM
	rm $JS_FILE_WASM
fi

echo $CC: free_queue.cpp -Llib -I../include -Iinclude -pthread $EMCCFLAGS -o $JS_FILE_WASM
$CC free_queue.cpp -Llib -I../include -Iinclude -pthread $EMCCFLAGS -o $JS_FILE_WASM

# cat $JS_FILE_PART >> $JS_FILE
cat $JS_FILE_PART >> $JS_FILE

if [ -f $JS_FILE ]; then
	echo Copy existing file: $DIR/$JS_FILE $INSTALLDIR/$JS_FILE
	cp $DIR/$JS_FILE $INSTALLDIR/$JS_FILE
fi

if [ -f $JS_FILE_WASM ]; then
	echo Copy existing file: $DIR/$JS_FILE_WASM $INSTALLDIR/$JS_FILE_WASM
	cp $DIR/$JS_FILE_WASM $INSTALLDIR/$JS_FILE_WASM
fi

exit 0

