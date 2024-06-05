#!/bin/sh

export DIR=`pwd`

export INSTALLDIR=../build

export JS_FILE=free-queue.js
export JS_FILE_TEMP=free-queue.js.temp
export JS_FILE_PART=free-queue.js.part
export JS_WASM_FILE=free-queue.asm.wasm
export JS_WASM_JS_FILE=free-queue.asm.js
export JS_WASM_WORKER_BLOB_FILE=free-queue.asm.worker.js.blob
export JS_WASM_WORKER_FILE=free-queue.asm.worker.js

if [ -f $JS_FILE ]; then
	echo Delete existing file: $JS_FILE
	rm $JS_FILE
fi

if [ -f $JS_WASM_JS_FILE ]; then
	echo Delete existing file: $JS_WASM_JS_FILE
	rm $JS_WASM_JS_FILE
fi

if [ -f $JS_WASM_WORKER_FILE ]; then
	echo Delete existing file: $JS_WASM_WORKER_FILE
	rm $JS_WASM_WORKER_FILE
fi

if [ -f $JS_WASM_FILE ]; then
	echo Delete existing file: $JS_WASM_FILE
	rm $JS_WASM_FILE
fi

echo $CC: free_queue.cpp -Llib -I../include -Iinclude -pthread $EMCCFLAGS -o $JS_WASM_JS_FILE
$CC free_queue.cpp -Llib -I../include -Iinclude -pthread $EMCCFLAGS -o $JS_WASM_JS_FILE

if [ -f $JS_WASM_WORKER_FILE ]; then
	echo Convert to base64 existing file: $JS_WASM_WORKER_FILE
	openssl base64 -A -in $JS_WASM_WORKER_FILE > $JS_WASM_WORKER_BLOB_FILE
	rm $JS_WASM_WORKER_FILE
fi

cat $JS_FILE_PART > $JS_FILE

echo -n "var pthreadMainBlobJs = '" >> $JS_FILE
cat $JS_WASM_WORKER_BLOB_FILE >> $JS_FILE

echo -n "';" >> $JS_FILE
echo -n " " >> $JS_FILE

sed -i -e "s/var pthreadMainJs=locateFile(\"$JS_WASM_WORKER_FILE\")/var pthreadMainJs=decodeBase64(pthreadMainBlobJs);var URL=(window.URL||window.webkitURL);var blob=new Blob([pthreadMainJs],{type:\"application\/javascript\"})/g" $JS_WASM_JS_FILE
sed -i -e "s/PThread.unusedWorkers.push(new Worker(pthreadMainJs))/PThread.unusedWorkers.push(new Worker(URL.createObjectURL(blob)))/g" $JS_WASM_JS_FILE

cat $JS_WASM_JS_FILE >> $JS_FILE

if [ -f $JS_WASM_WORKER_BLOB_FILE ]; then
	echo Delete existing file: $JS_WASM_WORKER_BLOB_FILE
	rm $JS_WASM_WORKER_BLOB_FILE
fi

if [ -f $JS_WASM_JS_FILE ]; then
	echo Delete existing file: $JS_WASM_JS_FILE
	rm $JS_WASM_JS_FILE
fi

if [ -f $JS_FILE ]; then
	echo Copy existing file: $JS_FILE $INSTALLDIR/$JS_FILE
	cp $JS_FILE $INSTALLDIR/$JS_FILE
fi

if [ -f $JS_WASM_JS_FILE ]; then
	echo Copy existing file: $JS_WASM_JS_FILE $INSTALLDIR/$JS_WASM_JS_FILE
	cp $JS_WASM_JS_FILE $INSTALLDIR/$JS_WASM_JS_FILE
fi

if [ -f $JS_WASM_WORKER_FILE ]; then
	echo Copy existing file: $JS_WASM_WORKER_FILE $INSTALLDIR/$JS_WASM_WORKER_FILE
	cp $JS_WASM_WORKER_FILE $INSTALLDIR/$JS_WASM_WORKER_FILE
fi

if [ -f $JS_WASM_FILE ]; then
	echo Copy existing file: $JS_WASM_FILE $INSTALLDIR/$JS_WASM_FILE
	cp $JS_WASM_FILE $INSTALLDIR/$JS_WASM_FILE
fi

exit 0