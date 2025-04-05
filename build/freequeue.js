/**
 * A shared storage for FreeQueue operation backed by SharedArrayBuffer.
 *
 * @typedef SharedRingBuffer
 * @property {Uint32Array} states Backed by SharedArrayBuffer.
 * @property {number} bufferLength The frame buffer length. Should be identical
 * throughout channels.
 * @property {Array<Float64Array>} channelData The length must be > 0.
 * @property {number} channelCount same with channelData.length
 */

/**
 * A single-producer/single-consumer lock-free FIFO backed by SharedArrayBuffer.
 * In a typical pattern is that a worklet pulls the data from the queue and a
 * worker renders audio data to fill in the queue.
 */

import initWasmFreeQueue from "./freequeue.asm.js";

class FreeQueue 
{
		constructor(frequency, seconds, channels)
		{
			this.LFreeQueue = {};

			this.QueueFrequency = frequency;
			this.QueueSeconds = seconds;
			this.QueueChannels = channels;
			this.CreatedFreeQueue = undefined;
			this.isInit = false;

			this.LFreeQueue.onRuntimeInitialized = () => { 				
				this.LFreeQueue.callMain("");
				console.log( "onRuntimeInitialized\n" );
			};

			initWasmFreeQueue( this.LFreeQueue ).then( async (LFreeQueue) => {
				this.FQ_malloc = LFreeQueue.cwrap('FQ_malloc','number',[ 'number' ]);
				this.FQ_remalloc = LFreeQueue.cwrap('FQ_realloc','number',[ 'number', 'number' ]);
				this.FQ_free = LFreeQueue.cwrap('FQ_free','',[ 'number' ]);

				this.FQ_FreeQueueCreate = LFreeQueue.cwrap('FQ_FreeQueueCreate','number',[ 'number', 'number' ]);
				this.FQ_FreeQueuePush = LFreeQueue.cwrap('FQ_FreeQueuePush','boolean',[ 'number', 'number', 'number' ]);

				this.FQ_PrintQueueInfo = LFreeQueue.cwrap('FQ_PrintQueueInfo','',[ 'number' ]);

				this.FQ_GetFreeQueuePointers = LFreeQueue.cwrap('FQ_GetFreeQueuePointers','number',[ 'number', 'string' ]);

				this.FQ_FreeQueueGetReadCounter = LFreeQueue.cwrap('FQ_FreeQueueGetReadCounter','number',[ 'number' ]);
				this.FQ_FreeQueueGetWriteCounter = LFreeQueue.cwrap('FQ_FreeQueueGetWriteCounter','number',[ 'number' ]);

				this.CreatedFreeQueue = this.FQ_FreeQueueCreate( this.QueueFrequency * this.QueueSeconds, this.QueueChannels );

				this.isInit = true;

				console.log( "initWasmFreeQueue\n" );
			});
		}
		Wait() {
			while ( true )
			{
				let id = setTimeout( function() {}, 100 );
				clearTimeout( id );
				if ( this.isInit == true ) {
					break;
				}
			}
		}
		FreeQueuePush(input, blocklen) 
		{
			console.log( "FreeQueuePush\n" );

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

			this.FQ_FreeQueuePush( this.CreatedFreeQueue, pointerHeap.byteOffset, this.QueueChannels );
			this.PrintQueueInfo();

			this.FQ_free( pointerHeap.byteOffset );
			this.FQ_free( dataHeap.byteOffset );

			return true;
		}
	
		PrintQueueInfo() 
		{
			console.log( "PrintQueueInfo\n" );

			this.FQ_PrintQueueInfo( this.CreatedFreeQueue );
		}
	
};

export default FreeQueue;
