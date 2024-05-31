import Module from './js/free-queue.wasm.js'

try {		
	Module.ready( function() {
		console.log( "onRuntimeInitialized...\n" );		
	} );
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


