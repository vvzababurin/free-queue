import initWasmFreeQueue from "./free-queue/free-queue.wasm.js"

try {		
	var Module = {};
	initWasmFreeQueue(Module);
	window["Module"] = Module;
	window["onFreeQueueInitialize"] = () => {
		const GetFreeQueueThreads = window["Module"].cwrap('GetFreeQueueThreads','number',[ '' ]);
		const GetFreeQueuePointers = window["Module"].cwrap('GetFreeQueuePointers','number',[ 'number', 'string' ]);
		const PrintQueueInfo = window["Module"].cwrap('PrintQueueInfo','',[ 'number' ]);
		const CreateFreeQueue = window["Module"].cwrap('CreateFreeQueue','number',[ 'number', 'number' ]);
		const PrintQueueAddresses = window["Module"].cwrap('PrintQueueAddresses','',[ 'number' ]);
		window["instance"] = GetFreeQueueThreads();
		console.log( "instance: " + window["instance"] );
		const bufferLengthPtr = GetFreeQueuePointers( window["instance"], "buffer_length" );
		const channelCountPtr = GetFreeQueuePointers( window["instance"], "channel_count" );
		const statePtr = GetFreeQueuePointers( window["instance"], "state" );
		const channelDataPtr = GetFreeQueuePointers( window["instance"], "channel_data" );
		const pointers = new Object();
		console.log( "pointers: " + pointers );
		pointers.memory = window["Module"].HEAPU8;
		pointers.bufferLengthPointer = bufferLengthPtr;
		pointers.channelCountPointer = channelCountPtr;
		pointers.statePointer = statePtr;
		pointers.channelDataPointer = channelDataPtr;
		window["queue"] = FreeQueue.fromPointers( pointers );
		if ( window["queue"] != undefined ) window["queue"].printAvailableReadAndWrite();
	};
	window["Module"].onRuntimeInitialized = () => { 				
		window["queue"] = undefined;
		window["instance"] = undefined;
		window["Module"].callMain("");
		window.onFreeQueueInitialize();
	};
} 
catch( e ) 
{
	console.log( "exception: " + e );
	throw( e );
}