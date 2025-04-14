
import initWasmFreeQueue from "./freequeue.asm.js";

class FreeQueue 
{
		constructor(frequency, seconds, channels)
		{
			this.LFreeQueue = {
				setStatus: function (e) {
					if (e !== "") {
						console.log(e)
					};
				}
			};

			this.QueueFrequency = frequency;
			this.QueueSeconds = seconds;
			this.QueueChannels = channels;
			this.CreatedFreeQueue = undefined;

			this.LFreeQueue.onRuntimeInitialized = () => { 				
			};

			initWasmFreeQueue( this.LFreeQueue ).then( ( LFreeQueue ) => {
				this.LFreeQueue.callMain("");

				this.FQ_malloc = LFreeQueue.cwrap('FQ_malloc','number',[ 'number' ]);
				this.FQ_remalloc = LFreeQueue.cwrap('FQ_realloc','number',[ 'number', 'number' ]);
				this.FQ_free = LFreeQueue.cwrap('FQ_free','',[ 'number' ]);

				this.FQ_FreeQueueCreate = LFreeQueue.cwrap('FQ_FreeQueueCreate','number',[ 'number', 'number' ]);

				this.FQ_FreeQueuePush = LFreeQueue.cwrap('FQ_FreeQueuePush','boolean',[ 'number', 'number', 'number' ]);
				this.FQ_FreeQueuePull = LFreeQueue.cwrap('FQ_FreeQueuePull','number',[ 'number', 'number', 'number', 'boolean' ]);

				this.FQ_PrintQueueInfo = LFreeQueue.cwrap('FQ_PrintQueueInfo','',[ 'number' ]);

				this.FQ_GetFreeQueuePointers = LFreeQueue.cwrap('FQ_GetFreeQueuePointers','number',[ 'number', 'string' ]);

				this.FQ_FreeQueueGetReadCounter = LFreeQueue.cwrap('FQ_FreeQueueGetReadCounter','number',[ 'number' ]);
				this.FQ_FreeQueueGetWriteCounter = LFreeQueue.cwrap('FQ_FreeQueueGetWriteCounter','number',[ 'number' ]);

				this.CreatedFreeQueue = this.FQ_FreeQueueCreate( this.QueueFrequency * this.QueueSeconds, this.QueueChannels );
			});

		}

		FreeQueuePull(data, blocklen) 
		{
			if ( this.CreatedFreeQueue === undefined ) return 0;

			let pointers = new Uint32Array( this.QueueChannels );
			for (let i = 0; i < this.QueueChannels; i++) {
				let nDataBytes = blocklen * Float32Array.BYTES_PER_ELEMENT;
				let dataPtr = this.FQ_malloc( nDataBytes );				
				pointers[i] = dataPtr;
			}

			let nPointerBytes = pointers.length * pointers.BYTES_PER_ELEMENT
			let pointerPtr = this.FQ_malloc( nPointerBytes );

			let pointerHeap = new Uint8Array(this.LFreeQueue.HEAPU8.buffer, pointerPtr, nPointerBytes );
			pointerHeap.set( new Uint8Array( pointers.buffer ) );

			blocklen = this.FQ_FreeQueuePull(this.CreatedFreeQueue, pointerHeap.byteOffset, blocklen, true);

			for ( let i = 0; i < this.QueueChannels; i++ ) {
				let output = new Float32Array(this.LFreeQueue.HEAPF32.buffer, pointers[i], blocklen);
				data[i] = new Float32Array(blocklen);
				for ( let j = 0; j < blocklen; j++ ) {
					data[i][j] = output[j];
				}
			}

			this.FQ_free( pointerPtr );

			for (let i = 0; i < this.QueueChannels; i++) {
				this.FQ_free( pointers[i] );
			}

			return blocklen;
		}


		FreeQueuePush(data, blocklen) 
		{
			if ( this.CreatedFreeQueue === undefined ) return false;				
			
			let input = new Float32Array( this.QueueChannels * blocklen );

			for ( let i = 0; i < this.QueueChannels; i++ ) {
				for ( let j = 0; j < blocklen; j++ ) {
					input[i * blocklen + j]	= data[i][j];
				}
			}

			let nDataBytes = input.length * input.BYTES_PER_ELEMENT;
			let dataPtr = this.FQ_malloc( nDataBytes );

			let dataHeap = new Float32Array( this.LFreeQueue.HEAPF32.buffer, dataPtr, nDataBytes);
			dataHeap.set( new Float32Array( input.buffer ) );

			let pointers = new Uint32Array( this.QueueChannels );
			for (let i = 0; i < pointers.length; i++) {
				pointers[i] = dataPtr + i * input.BYTES_PER_ELEMENT * blocklen;
			}

			let nPointerBytes = pointers.length * pointers.BYTES_PER_ELEMENT
			let pointerPtr = this.FQ_malloc( nPointerBytes );

			let pointerHeap = new Uint8Array(this.LFreeQueue.HEAPU8.buffer, pointerPtr, nPointerBytes );
			pointerHeap.set( new Uint8Array( pointers.buffer ) );

			this.FQ_FreeQueuePush( this.CreatedFreeQueue, pointerHeap.byteOffset, blocklen );

			this.FQ_free( pointerHeap.byteOffset );
			this.FQ_free( dataHeap.byteOffset );

			return true;
		}
	
		PrintQueueInfo() 
		{
			if ( this.CreatedFreeQueue === undefined ) return false;				

			this.FQ_PrintQueueInfo( this.CreatedFreeQueue );

			return true;
		}
	
};

export default FreeQueue;
