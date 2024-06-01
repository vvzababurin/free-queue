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

class FreeQueue {

  /**
   * An index set for shared state fields. Requires atomic access.
   * @enum {number}
   */
  States = {
    /** @type {number} A shared index for reading from the queue. (consumer) */
    READ: 0,
    /** @type {number} A shared index for writing into the queue. (producer) */
    WRITE: 1,  
  }
  
  /**
   * FreeQueue constructor. A shared buffer created by this constuctor
   * will be shared between two threads.
   *
   * @param {number} size Frame buffer length.
   * @param {number} channelCount Total channel count.
   */
  constructor(size, channelCount = 1) {
    this.states = new Uint32Array(
      new SharedArrayBuffer(
        Object.keys(this.States).length * Uint32Array.BYTES_PER_ELEMENT
      )
    );
    /**
     * Use one extra bin to distinguish between the read and write indices 
     * when full. See Tim Blechmann's |boost::lockfree::spsc_queue|
     * implementation.
     */
    this.bufferLength = size + 1;
    this.channelCount = channelCount;
    this.channelData = [];
    for (let i = 0; i < channelCount; i++) {
      this.channelData.push(
        new Float64Array(
          new SharedArrayBuffer(
            this.bufferLength * Float64Array.BYTES_PER_ELEMENT
          )
        )
      );
    }
  }

  /**
   * Helper function for creating FreeQueue from pointers.
   * @param {FreeQueuePointers} queuePointers 
   * An object containing various pointers required to create FreeQueue
   *
   * interface FreeQueuePointers {
   *   memory: WebAssembly.Memory;   // Reference to WebAssembly Memory
   *   bufferLengthPointer: number;
   *   channelCountPointer: number;
   *   statePointer: number;
   *   channelDataPointer: number;
   * }
   * @returns FreeQueue
   */
  static fromPointers(queuePointers) {

    const queue = new FreeQueue(0, 0);

    const HEAPU32 = new Uint32Array(queuePointers.memory.buffer);
    const HEAPF64 = new Float64Array(queuePointers.memory.buffer);

    const bufferLength = HEAPU32[queuePointers.bufferLengthPointer / 4];
    const channelCount = HEAPU32[queuePointers.channelCountPointer / 4];

    const states = HEAPU32.subarray(
        HEAPU32[queuePointers.statePointer / 4] / 4,
        HEAPU32[queuePointers.statePointer / 4] / 4 + 2
    );

    const channelData = [];
    for (let i = 0; i < channelCount; i++) {
      channelData.push(
          new Float64Array( queuePointers.memory.buffer, HEAPU32[HEAPU32[queuePointers.channelDataPointer / 4] / 4 + i], bufferLength )
      );
    }
    
    queue.bufferLength = bufferLength;
    queue.channelCount = channelCount;
    queue.states = states;
    queue.channelData = channelData;

    return queue;
  }

  /**
   * Pushes the data into queue. Used by producer.
   *
   * @param {Float64Array[]} input Its length must match with the channel
   *   count of this queue.
   * @param {number} blockLength Input block frame length. It must be identical
   *   throughout channels.
   * @return {boolean} False if the operation fails.
   */
  push(input, blockLength) {
    const currentRead = Atomics.load(this.states, this.States.READ);
    const currentWrite = Atomics.load(this.states, this.States.WRITE);
    if (this._getAvailableWrite(currentRead, currentWrite) < blockLength) {
      return false;
    }
    let nextWrite = currentWrite + blockLength;
    if (this.bufferLength < nextWrite) {
      nextWrite -= this.bufferLength;
      for (let channel = 0; channel < this.channelCount; channel++) {
        const blockA = this.channelData[channel].subarray(currentWrite);
        const blockB = this.channelData[channel].subarray(0, nextWrite);
        blockA.set(input[channel].subarray(0, blockA.length));
        blockB.set(input[channel].subarray(blockA.length));
      }
    } else {
      for (let channel = 0; channel < this.channelCount; channel++) {
        this.channelData[channel]
            .subarray(currentWrite, nextWrite)
            .set(input[channel].subarray(0, blockLength));
      }
      if (nextWrite === this.bufferLength) nextWrite = 0;
    }
    Atomics.store(this.states, this.States.WRITE, nextWrite);
    return true;
  }

  /**
   * Pulls data out of the queue. Used by consumer.
   *
   * @param {Float64Array[]} output Its length must match with the channel
   *   count of this queue.
   * @param {number} blockLength output block length. It must be identical
   *   throughout channels.
   * @return {boolean} False if the operation fails.
   */
  pull(output, blockLength) {
    const currentRead = Atomics.load(this.states, this.States.READ);
    const currentWrite = Atomics.load(this.states, this.States.WRITE);
    if (this._getAvailableRead(currentRead, currentWrite) < blockLength) {
      return false;
    }
    let nextRead = currentRead + blockLength;
    if (this.bufferLength < nextRead) {
      nextRead -= this.bufferLength;
      for (let channel = 0; channel < this.channelCount; channel++) {
        const blockA = this.channelData[channel].subarray(currentRead);
        const blockB = this.channelData[channel].subarray(0, nextRead);
        output[channel].set(blockA);
        output[channel].set(blockB, blockA.length);
      }
    } else {
      for (let channel = 0; channel < this.channelCount; ++channel) {
        output[channel].set(
            this.channelData[channel].subarray(currentRead, nextRead)
        );
      }
      if (nextRead === this.bufferLength) {
        nextRead = 0;
      }
    }
    Atomics.store(this.states, this.States.READ, nextRead);
    return true;
  }
  /**
   * Helper function for debugging.
   * Prints currently available read and write.
   */
  printAvailableReadAndWrite() {
    const currentRead = Atomics.load(this.states, this.States.READ);
    const currentWrite = Atomics.load(this.states, this.States.WRITE);
    console.log(this, {
        availableRead: this._getAvailableRead(currentRead, currentWrite),
        availableWrite: this._getAvailableWrite(currentRead, currentWrite),
    });
  }
  /**
   * 
   * @returns {number} number of samples available for read
   */
  getAvailableSamples() {
    const currentRead = Atomics.load(this.states, this.States.READ);
    const currentWrite = Atomics.load(this.states, this.States.WRITE);
    return this._getAvailableRead(currentRead, currentWrite);
  }
  /**
   * 
   * @param {number} size 
   * @returns boolean. if frame of given size is available or not.
   */
  isFrameAvailable(size) {
    return this.getAvailableSamples() >= size;
  }

  /**
   * @return {number}
   */
  getBufferLength() {
    return this.bufferLength - 1;
  }

  _getAvailableWrite(readIndex, writeIndex) {
    if (writeIndex >= readIndex)
        return this.bufferLength - writeIndex + readIndex - 1;
    return readIndex - writeIndex - 1;
  }

  _getAvailableRead(readIndex, writeIndex) {
    if (writeIndex >= readIndex) return writeIndex - readIndex;
    return writeIndex + this.bufferLength - readIndex;
  }

  _reset() {
    for (let channel = 0; channel < this.channelCount; channel++) {
      this.channelData[channel].fill(0);
    }
    Atomics.store(this.states, this.States.READ, 0);
    Atomics.store(this.states, this.States.WRITE, 0);
  }
}



// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(Module) { ..generated code.. }
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = typeof Module !== 'undefined' ? Module : {};

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
// {{PRE_JSES}}

// Sometimes an existing Module object exists with properties
// meant to overwrite the default module functionality. Here
// we collect those properties and reapply _after_ we configure
// the current environment's defaults to avoid having to be so
// defensive during initialization.
var moduleOverrides = {};
var key;
for (key in Module) {
  if (Module.hasOwnProperty(key)) {
    moduleOverrides[key] = Module[key];
  }
}

var arguments_ = [];
var thisProgram = './this.program';
var quit_ = function(status, toThrow) {
  throw toThrow;
};

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).

// Attempt to auto-detect the environment
var ENVIRONMENT_IS_WEB = typeof window === 'object';
var ENVIRONMENT_IS_WORKER = typeof importScripts === 'function';
// N.b. Electron.js environment is simultaneously a NODE-environment, but
// also a web environment.
var ENVIRONMENT_IS_NODE = typeof process === 'object' && typeof process.versions === 'object' && typeof process.versions.node === 'string';
var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

if (Module['ENVIRONMENT']) {
  throw new Error('Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -s ENVIRONMENT=web or -s ENVIRONMENT=node)');
}

// Three configurations we can be running in:
// 1) We could be the application main() thread running in the main JS UI thread. (ENVIRONMENT_IS_WORKER == false and ENVIRONMENT_IS_PTHREAD == false)
// 2) We could be the application main() thread proxied to worker. (with Emscripten -s PROXY_TO_WORKER=1) (ENVIRONMENT_IS_WORKER == true, ENVIRONMENT_IS_PTHREAD == false)
// 3) We could be an application pthread running in a worker. (ENVIRONMENT_IS_WORKER == true and ENVIRONMENT_IS_PTHREAD == true)

// ENVIRONMENT_IS_PTHREAD=true will have been preset in worker.js. Make it false in the main runtime thread.
var ENVIRONMENT_IS_PTHREAD = Module['ENVIRONMENT_IS_PTHREAD'] || false;

// In MODULARIZE mode _scriptDir needs to be captured already at the very top of the page immediately when the page is parsed, so it is generated there
// before the page load. In non-MODULARIZE modes generate it here.
var _scriptDir = (typeof document !== 'undefined' && document.currentScript) ? document.currentScript.src : undefined;

if (ENVIRONMENT_IS_WORKER) {
  _scriptDir = self.location.href;
}
else if (ENVIRONMENT_IS_NODE) {
  _scriptDir = __filename;
}

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = '';
function locateFile(path) {
  if (Module['locateFile']) {
    return Module['locateFile'](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var read_,
    readAsync,
    readBinary,
    setWindowTitle;

var nodeFS;
var nodePath;

if (ENVIRONMENT_IS_NODE) {
  if (!(typeof process === 'object' && typeof require === 'function')) throw new Error('not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)');
  if (ENVIRONMENT_IS_WORKER) {
    scriptDirectory = require('path').dirname(scriptDirectory) + '/';
  } else {
    scriptDirectory = __dirname + '/';
  }

// include: node_shell_read.js


read_ = function shell_read(filename, binary) {
  var ret = tryParseAsDataURI(filename);
  if (ret) {
    return binary ? ret : ret.toString();
  }
  if (!nodeFS) nodeFS = require('fs');
  if (!nodePath) nodePath = require('path');
  filename = nodePath['normalize'](filename);
  return nodeFS['readFileSync'](filename, binary ? null : 'utf8');
};

readBinary = function readBinary(filename) {
  var ret = read_(filename, true);
  if (!ret.buffer) {
    ret = new Uint8Array(ret);
  }
  assert(ret.buffer);
  return ret;
};

readAsync = function readAsync(filename, onload, onerror) {
  var ret = tryParseAsDataURI(filename);
  if (ret) {
    onload(ret);
  }
  if (!nodeFS) nodeFS = require('fs');
  if (!nodePath) nodePath = require('path');
  filename = nodePath['normalize'](filename);
  nodeFS['readFile'](filename, function(err, data) {
    if (err) onerror(err);
    else onload(data.buffer);
  });
};

// end include: node_shell_read.js
  if (process['argv'].length > 1) {
    thisProgram = process['argv'][1].replace(/\\/g, '/');
  }

  arguments_ = process['argv'].slice(2);

  if (typeof module !== 'undefined') {
    module['exports'] = Module;
  }

  process['on']('uncaughtException', function(ex) {
    // suppress ExitStatus exceptions from showing an error
    if (!(ex instanceof ExitStatus)) {
      throw ex;
    }
  });

  process['on']('unhandledRejection', abort);

  quit_ = function(status, toThrow) {
    if (keepRuntimeAlive()) {
      process['exitCode'] = status;
      throw toThrow;
    }
    process['exit'](status);
  };

  Module['inspect'] = function () { return '[Emscripten Module object]'; };

  var nodeWorkerThreads;
  try {
    nodeWorkerThreads = require('worker_threads');
  } catch (e) {
    console.error('The "worker_threads" module is not supported in this node.js build - perhaps a newer version is needed?');
    throw e;
  }
  global.Worker = nodeWorkerThreads.Worker;

} else
if (ENVIRONMENT_IS_SHELL) {

  if ((typeof process === 'object' && typeof require === 'function') || typeof window === 'object' || typeof importScripts === 'function') throw new Error('not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)');

  if (typeof read != 'undefined') {
    read_ = function shell_read(f) {
      var data = tryParseAsDataURI(f);
      if (data) {
        return intArrayToString(data);
      }
      return read(f);
    };
  }

  readBinary = function readBinary(f) {
    var data;
    data = tryParseAsDataURI(f);
    if (data) {
      return data;
    }
    if (typeof readbuffer === 'function') {
      return new Uint8Array(readbuffer(f));
    }
    data = read(f, 'binary');
    assert(typeof data === 'object');
    return data;
  };

  readAsync = function readAsync(f, onload, onerror) {
    setTimeout(function() { onload(readBinary(f)); }, 0);
  };

  if (typeof scriptArgs != 'undefined') {
    arguments_ = scriptArgs;
  } else if (typeof arguments != 'undefined') {
    arguments_ = arguments;
  }

  if (typeof quit === 'function') {
    quit_ = function(status) {
      quit(status);
    };
  }

  if (typeof print !== 'undefined') {
    // Prefer to use print/printErr where they exist, as they usually work better.
    if (typeof console === 'undefined') console = /** @type{!Console} */({});
    console.log = /** @type{!function(this:Console, ...*): undefined} */ (print);
    console.warn = console.error = /** @type{!function(this:Console, ...*): undefined} */ (typeof printErr !== 'undefined' ? printErr : print);
  }

} else

// Note that this includes Node.js workers when relevant (pthreads is enabled).
// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
// ENVIRONMENT_IS_NODE.
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  if (ENVIRONMENT_IS_WORKER) { // Check worker, not web, since window could be polyfilled
    scriptDirectory = self.location.href;
  } else if (typeof document !== 'undefined' && document.currentScript) { // web
    scriptDirectory = document.currentScript.src;
  }
  // blob urls look like blob:http://site.com/etc/etc and we cannot infer anything from them.
  // otherwise, slice off the final part of the url to find the script directory.
  // if scriptDirectory does not contain a slash, lastIndexOf will return -1,
  // and scriptDirectory will correctly be replaced with an empty string.
  if (scriptDirectory.indexOf('blob:') !== 0) {
    scriptDirectory = scriptDirectory.substr(0, scriptDirectory.lastIndexOf('/')+1);
  } else {
    scriptDirectory = '';
  }

  if (!(typeof window === 'object' || typeof importScripts === 'function')) throw new Error('not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)');

  // Differentiate the Web Worker from the Node Worker case, as reading must
  // be done differently.
  if (ENVIRONMENT_IS_NODE) {

// include: node_shell_read.js


read_ = function shell_read(filename, binary) {
  var ret = tryParseAsDataURI(filename);
  if (ret) {
    return binary ? ret : ret.toString();
  }
  if (!nodeFS) nodeFS = require('fs');
  if (!nodePath) nodePath = require('path');
  filename = nodePath['normalize'](filename);
  return nodeFS['readFileSync'](filename, binary ? null : 'utf8');
};

readBinary = function readBinary(filename) {
  var ret = read_(filename, true);
  if (!ret.buffer) {
    ret = new Uint8Array(ret);
  }
  assert(ret.buffer);
  return ret;
};

readAsync = function readAsync(filename, onload, onerror) {
  var ret = tryParseAsDataURI(filename);
  if (ret) {
    onload(ret);
  }
  if (!nodeFS) nodeFS = require('fs');
  if (!nodePath) nodePath = require('path');
  filename = nodePath['normalize'](filename);
  nodeFS['readFile'](filename, function(err, data) {
    if (err) onerror(err);
    else onload(data.buffer);
  });
};

// end include: node_shell_read.js
  } else
  {

// include: web_or_worker_shell_read.js


  read_ = function(url) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, false);
      xhr.send(null);
      return xhr.responseText;
    } catch (err) {
      var data = tryParseAsDataURI(url);
      if (data) {
        return intArrayToString(data);
      }
      throw err;
    }
  };

  if (ENVIRONMENT_IS_WORKER) {
    readBinary = function(url) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.responseType = 'arraybuffer';
        xhr.send(null);
        return new Uint8Array(/** @type{!ArrayBuffer} */(xhr.response));
      } catch (err) {
        var data = tryParseAsDataURI(url);
        if (data) {
          return data;
        }
        throw err;
      }
    };
  }

  readAsync = function(url, onload, onerror) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = function() {
      if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) { // file URLs can return 0
        onload(xhr.response);
        return;
      }
      var data = tryParseAsDataURI(url);
      if (data) {
        onload(data.buffer);
        return;
      }
      onerror();
    };
    xhr.onerror = onerror;
    xhr.send(null);
  };

// end include: web_or_worker_shell_read.js
  }

  setWindowTitle = function(title) { document.title = title };
} else
{
  throw new Error('environment detection error');
}

if (ENVIRONMENT_IS_NODE) {
  // Polyfill the performance object, which emscripten pthreads support
  // depends on for good timing.
  if (typeof performance === 'undefined') {
    global.performance = require('perf_hooks').performance;
  }
}

// Set up the out() and err() hooks, which are how we can print to stdout or
// stderr, respectively.
var out = Module['print'] || console.log.bind(console);
var err = Module['printErr'] || console.warn.bind(console);

// Merge back in the overrides
for (key in moduleOverrides) {
  if (moduleOverrides.hasOwnProperty(key)) {
    Module[key] = moduleOverrides[key];
  }
}
// Free the object hierarchy contained in the overrides, this lets the GC
// reclaim data used e.g. in memoryInitializerRequest, which is a large typed array.
moduleOverrides = null;

// Emit code to handle expected values on the Module object. This applies Module.x
// to the proper local x. This has two benefits: first, we only emit it if it is
// expected to arrive, and second, by using a local everywhere else that can be
// minified.

if (Module['arguments']) arguments_ = Module['arguments'];
if (!Object.getOwnPropertyDescriptor(Module, 'arguments')) {
  Object.defineProperty(Module, 'arguments', {
    configurable: true,
    get: function() {
      abort('Module.arguments has been replaced with plain arguments_ (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)')
    }
  });
}

if (Module['thisProgram']) thisProgram = Module['thisProgram'];
if (!Object.getOwnPropertyDescriptor(Module, 'thisProgram')) {
  Object.defineProperty(Module, 'thisProgram', {
    configurable: true,
    get: function() {
      abort('Module.thisProgram has been replaced with plain thisProgram (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)')
    }
  });
}

if (Module['quit']) quit_ = Module['quit'];
if (!Object.getOwnPropertyDescriptor(Module, 'quit')) {
  Object.defineProperty(Module, 'quit', {
    configurable: true,
    get: function() {
      abort('Module.quit has been replaced with plain quit_ (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)')
    }
  });
}

// perform assertions in shell.js after we set up out() and err(), as otherwise if an assertion fails it cannot print the message
// Assertions on removed incoming Module JS APIs.
assert(typeof Module['memoryInitializerPrefixURL'] === 'undefined', 'Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['pthreadMainPrefixURL'] === 'undefined', 'Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['cdInitializerPrefixURL'] === 'undefined', 'Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['filePackagePrefixURL'] === 'undefined', 'Module.filePackagePrefixURL option was removed, use Module.locateFile instead');
assert(typeof Module['read'] === 'undefined', 'Module.read option was removed (modify read_ in JS)');
assert(typeof Module['readAsync'] === 'undefined', 'Module.readAsync option was removed (modify readAsync in JS)');
assert(typeof Module['readBinary'] === 'undefined', 'Module.readBinary option was removed (modify readBinary in JS)');
assert(typeof Module['setWindowTitle'] === 'undefined', 'Module.setWindowTitle option was removed (modify setWindowTitle in JS)');
assert(typeof Module['TOTAL_MEMORY'] === 'undefined', 'Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY');

if (!Object.getOwnPropertyDescriptor(Module, 'read')) {
  Object.defineProperty(Module, 'read', {
    configurable: true,
    get: function() {
      abort('Module.read has been replaced with plain read_ (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)')
    }
  });
}

if (!Object.getOwnPropertyDescriptor(Module, 'readAsync')) {
  Object.defineProperty(Module, 'readAsync', {
    configurable: true,
    get: function() {
      abort('Module.readAsync has been replaced with plain readAsync (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)')
    }
  });
}

if (!Object.getOwnPropertyDescriptor(Module, 'readBinary')) {
  Object.defineProperty(Module, 'readBinary', {
    configurable: true,
    get: function() {
      abort('Module.readBinary has been replaced with plain readBinary (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)')
    }
  });
}

if (!Object.getOwnPropertyDescriptor(Module, 'setWindowTitle')) {
  Object.defineProperty(Module, 'setWindowTitle', {
    configurable: true,
    get: function() {
      abort('Module.setWindowTitle has been replaced with plain setWindowTitle (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)')
    }
  });
}
var IDBFS = 'IDBFS is no longer included by default; build with -lidbfs.js';
var PROXYFS = 'PROXYFS is no longer included by default; build with -lproxyfs.js';
var WORKERFS = 'WORKERFS is no longer included by default; build with -lworkerfs.js';
var NODEFS = 'NODEFS is no longer included by default; build with -lnodefs.js';
function alignMemory() { abort('`alignMemory` is now a library function and not included by default; add it to your library.js __deps or to DEFAULT_LIBRARY_FUNCS_TO_INCLUDE on the command line'); }

assert(ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER || ENVIRONMENT_IS_NODE, 'Pthreads do not work in this environment yet (need Web Workers, or an alternative to them)');

assert(!ENVIRONMENT_IS_SHELL, "shell environment detected but not enabled at build time.  Add 'shell' to `-s ENVIRONMENT` to enable.");




var STACK_ALIGN = 16;

function getNativeTypeSize(type) {
  switch (type) {
    case 'i1': case 'i8': return 1;
    case 'i16': return 2;
    case 'i32': return 4;
    case 'i64': return 8;
    case 'float': return 4;
    case 'double': return 8;
    default: {
      if (type[type.length-1] === '*') {
        return 4; // A pointer
      } else if (type[0] === 'i') {
        var bits = Number(type.substr(1));
        assert(bits % 8 === 0, 'getNativeTypeSize invalid bits ' + bits + ', type ' + type);
        return bits / 8;
      } else {
        return 0;
      }
    }
  }
}

function warnOnce(text) {
  if (!warnOnce.shown) warnOnce.shown = {};
  if (!warnOnce.shown[text]) {
    warnOnce.shown[text] = 1;
    err(text);
  }
}

// include: runtime_functions.js


// Wraps a JS function as a wasm function with a given signature.
function convertJsFunctionToWasm(func, sig) {

  // If the type reflection proposal is available, use the new
  // "WebAssembly.Function" constructor.
  // Otherwise, construct a minimal wasm module importing the JS function and
  // re-exporting it.
  if (typeof WebAssembly.Function === "function") {
    var typeNames = {
      'i': 'i32',
      'j': 'i64',
      'f': 'f32',
      'd': 'f64'
    };
    var type = {
      parameters: [],
      results: sig[0] == 'v' ? [] : [typeNames[sig[0]]]
    };
    for (var i = 1; i < sig.length; ++i) {
      type.parameters.push(typeNames[sig[i]]);
    }
    return new WebAssembly.Function(type, func);
  }

  // The module is static, with the exception of the type section, which is
  // generated based on the signature passed in.
  var typeSection = [
    0x01, // id: section,
    0x00, // length: 0 (placeholder)
    0x01, // count: 1
    0x60, // form: func
  ];
  var sigRet = sig.slice(0, 1);
  var sigParam = sig.slice(1);
  var typeCodes = {
    'i': 0x7f, // i32
    'j': 0x7e, // i64
    'f': 0x7d, // f32
    'd': 0x7c, // f64
  };

  // Parameters, length + signatures
  typeSection.push(sigParam.length);
  for (var i = 0; i < sigParam.length; ++i) {
    typeSection.push(typeCodes[sigParam[i]]);
  }

  // Return values, length + signatures
  // With no multi-return in MVP, either 0 (void) or 1 (anything else)
  if (sigRet == 'v') {
    typeSection.push(0x00);
  } else {
    typeSection = typeSection.concat([0x01, typeCodes[sigRet]]);
  }

  // Write the overall length of the type section back into the section header
  // (excepting the 2 bytes for the section id and length)
  typeSection[1] = typeSection.length - 2;

  // Rest of the module is static
  var bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // magic ("\0asm")
    0x01, 0x00, 0x00, 0x00, // version: 1
  ].concat(typeSection, [
    0x02, 0x07, // import section
      // (import "e" "f" (func 0 (type 0)))
      0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00,
    0x07, 0x05, // export section
      // (export "f" (func 0 (type 0)))
      0x01, 0x01, 0x66, 0x00, 0x00,
  ]));

   // We can compile this wasm module synchronously because it is very small.
  // This accepts an import (at "e.f"), that it reroutes to an export (at "f")
  var module = new WebAssembly.Module(bytes);
  var instance = new WebAssembly.Instance(module, {
    'e': {
      'f': func
    }
  });
  var wrappedFunc = instance.exports['f'];
  return wrappedFunc;
}

var freeTableIndexes = [];

// Weak map of functions in the table to their indexes, created on first use.
var functionsInTableMap;

function getEmptyTableSlot() {
  // Reuse a free index if there is one, otherwise grow.
  if (freeTableIndexes.length) {
    return freeTableIndexes.pop();
  }
  // Grow the table
  try {
    wasmTable.grow(1);
  } catch (err) {
    if (!(err instanceof RangeError)) {
      throw err;
    }
    throw 'Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.';
  }
  return wasmTable.length - 1;
}

// Add a wasm function to the table.
function addFunctionWasm(func, sig) {
  // Check if the function is already in the table, to ensure each function
  // gets a unique index. First, create the map if this is the first use.
  if (!functionsInTableMap) {
    functionsInTableMap = new WeakMap();
    for (var i = 0; i < wasmTable.length; i++) {
      var item = wasmTable.get(i);
      // Ignore null values.
      if (item) {
        functionsInTableMap.set(item, i);
      }
    }
  }
  if (functionsInTableMap.has(func)) {
    return functionsInTableMap.get(func);
  }

  // It's not in the table, add it now.

  var ret = getEmptyTableSlot();

  // Set the new value.
  try {
    // Attempting to call this with JS function will cause of table.set() to fail
    wasmTable.set(ret, func);
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err;
    }
    assert(typeof sig !== 'undefined', 'Missing signature argument to addFunction: ' + func);
    var wrapped = convertJsFunctionToWasm(func, sig);
    wasmTable.set(ret, wrapped);
  }

  functionsInTableMap.set(func, ret);

  return ret;
}

function removeFunction(index) {
  functionsInTableMap.delete(wasmTable.get(index));
  freeTableIndexes.push(index);
}

// 'sig' parameter is required for the llvm backend but only when func is not
// already a WebAssembly function.
function addFunction(func, sig) {
  assert(typeof func !== 'undefined');

  return addFunctionWasm(func, sig);
}

// end include: runtime_functions.js
// include: runtime_debug.js


// end include: runtime_debug.js
var tempRet0 = 0;

var setTempRet0 = function(value) {
  tempRet0 = value;
};

var getTempRet0 = function() {
  return tempRet0;
};

// JS library code refers to Atomics in the manner used from asm.js, provide
// the same API here.
var Atomics_load = Atomics.load;
var Atomics_store = Atomics.store;
var Atomics_compareExchange = Atomics.compareExchange;



// === Preamble library stuff ===

// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html

var wasmBinary;
if (Module['wasmBinary']) wasmBinary = Module['wasmBinary'];
if (!Object.getOwnPropertyDescriptor(Module, 'wasmBinary')) {
  Object.defineProperty(Module, 'wasmBinary', {
    configurable: true,
    get: function() {
      abort('Module.wasmBinary has been replaced with plain wasmBinary (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)')
    }
  });
}
var noExitRuntime = Module['noExitRuntime'] || true;
if (!Object.getOwnPropertyDescriptor(Module, 'noExitRuntime')) {
  Object.defineProperty(Module, 'noExitRuntime', {
    configurable: true,
    get: function() {
      abort('Module.noExitRuntime has been replaced with plain noExitRuntime (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)')
    }
  });
}

if (typeof WebAssembly !== 'object') {
  abort('no native wasm support detected');
}

// include: runtime_safe_heap.js


// In MINIMAL_RUNTIME, setValue() and getValue() are only available when building with safe heap enabled, for heap safety checking.
// In traditional runtime, setValue() and getValue() are always available (although their use is highly discouraged due to perf penalties)

/** @param {number} ptr
    @param {number} value
    @param {string} type
    @param {number|boolean=} noSafe */
function setValue(ptr, value, type, noSafe) {
  type = type || 'i8';
  if (type.charAt(type.length-1) === '*') type = 'i32'; // pointers are 32-bit
    switch (type) {
      case 'i1': HEAP8[((ptr)>>0)] = value; break;
      case 'i8': HEAP8[((ptr)>>0)] = value; break;
      case 'i16': HEAP16[((ptr)>>1)] = value; break;
      case 'i32': HEAP32[((ptr)>>2)] = value; break;
      case 'i64': (tempI64 = [value>>>0,(tempDouble=value,(+(Math.abs(tempDouble))) >= 1.0 ? (tempDouble > 0.0 ? ((Math.min((+(Math.floor((tempDouble)/4294967296.0))), 4294967295.0))|0)>>>0 : (~~((+(Math.ceil((tempDouble - +(((~~(tempDouble)))>>>0))/4294967296.0)))))>>>0) : 0)],HEAP32[((ptr)>>2)] = tempI64[0],HEAP32[(((ptr)+(4))>>2)] = tempI64[1]); break;
      case 'float': HEAPF32[((ptr)>>2)] = value; break;
      case 'double': HEAPF64[((ptr)>>3)] = value; break;
      default: abort('invalid type for setValue: ' + type);
    }
}

/** @param {number} ptr
    @param {string} type
    @param {number|boolean=} noSafe */
function getValue(ptr, type, noSafe) {
  type = type || 'i8';
  if (type.charAt(type.length-1) === '*') type = 'i32'; // pointers are 32-bit
    switch (type) {
      case 'i1': return HEAP8[((ptr)>>0)];
      case 'i8': return HEAP8[((ptr)>>0)];
      case 'i16': return HEAP16[((ptr)>>1)];
      case 'i32': return HEAP32[((ptr)>>2)];
      case 'i64': return HEAP32[((ptr)>>2)];
      case 'float': return HEAPF32[((ptr)>>2)];
      case 'double': return HEAPF64[((ptr)>>3)];
      default: abort('invalid type for getValue: ' + type);
    }
  return null;
}

// end include: runtime_safe_heap.js
// Wasm globals

var wasmMemory;

// For sending to workers.
var wasmModule;

//========================================
// Runtime essentials
//========================================

// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS;

/** @type {function(*, string=)} */
function assert(condition, text) {
  if (!condition) {
    abort('Assertion failed: ' + text);
  }
}

// Returns the C function with a specified identifier (for C++, you need to do manual name mangling)
function getCFunc(ident) {
  var func = Module['_' + ident]; // closure exported function
  assert(func, 'Cannot call unknown function ' + ident + ', make sure it is exported');
  return func;
}

// C calling interface.
/** @param {string|null=} returnType
    @param {Array=} argTypes
    @param {Arguments|Array=} args
    @param {Object=} opts */
function ccall(ident, returnType, argTypes, args, opts) {
  // For fast lookup of conversion functions
  var toC = {
    'string': function(str) {
      var ret = 0;
      if (str !== null && str !== undefined && str !== 0) { // null string
        // at most 4 bytes per UTF-8 code point, +1 for the trailing '\0'
        var len = (str.length << 2) + 1;
        ret = stackAlloc(len);
        stringToUTF8(str, ret, len);
      }
      return ret;
    },
    'array': function(arr) {
      var ret = stackAlloc(arr.length);
      writeArrayToMemory(arr, ret);
      return ret;
    }
  };

  function convertReturnValue(ret) {
    if (returnType === 'string') return UTF8ToString(ret);
    if (returnType === 'boolean') return Boolean(ret);
    return ret;
  }

  var func = getCFunc(ident);
  var cArgs = [];
  var stack = 0;
  assert(returnType !== 'array', 'Return type should not be "array".');
  if (args) {
    for (var i = 0; i < args.length; i++) {
      var converter = toC[argTypes[i]];
      if (converter) {
        if (stack === 0) stack = stackSave();
        cArgs[i] = converter(args[i]);
      } else {
        cArgs[i] = args[i];
      }
    }
  }
  var ret = func.apply(null, cArgs);
  function onDone(ret) {
    if (stack !== 0) stackRestore(stack);
    return convertReturnValue(ret);
  }

  ret = onDone(ret);
  return ret;
}

/** @param {string=} returnType
    @param {Array=} argTypes
    @param {Object=} opts */
function cwrap(ident, returnType, argTypes, opts) {
  return function() {
    return ccall(ident, returnType, argTypes, arguments, opts);
  }
}

// We used to include malloc/free by default in the past. Show a helpful error in
// builds with assertions.

var ALLOC_NORMAL = 0; // Tries to use _malloc()
var ALLOC_STACK = 1; // Lives for the duration of the current function call

// allocate(): This is for internal use. You can use it yourself as well, but the interface
//             is a little tricky (see docs right below). The reason is that it is optimized
//             for multiple syntaxes to save space in generated code. So you should
//             normally not use allocate(), and instead allocate memory using _malloc(),
//             initialize it with setValue(), and so forth.
// @slab: An array of data.
// @allocator: How to allocate memory, see ALLOC_*
/** @type {function((Uint8Array|Array<number>), number)} */
function allocate(slab, allocator) {
  var ret;
  assert(typeof allocator === 'number', 'allocate no longer takes a type argument')
  assert(typeof slab !== 'number', 'allocate no longer takes a number as arg0')

  if (allocator == ALLOC_STACK) {
    ret = stackAlloc(slab.length);
  } else {
    ret = _malloc(slab.length);
  }

  if (slab.subarray || slab.slice) {
    HEAPU8.set(/** @type {!Uint8Array} */(slab), ret);
  } else {
    HEAPU8.set(new Uint8Array(slab), ret);
  }
  return ret;
}

// include: runtime_strings.js


// runtime_strings.js: Strings related runtime functions that are part of both MINIMAL_RUNTIME and regular runtime.

// Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the given array that contains uint8 values, returns
// a copy of that string as a Javascript String object.

// UTF8Decoder.decode may not work with a view of a SharedArrayBuffer, see
// https://github.com/whatwg/encoding/issues/172
// To avoid that, we wrap around it and add a copy into a normal ArrayBuffer,
// which can still be much faster than creating a string character by
// character.
function TextDecoderWrapper(encoding) {
  var textDecoder = new TextDecoder(encoding);
  this.decode = function(data) {
    assert(data instanceof Uint8Array);
    // While we compile with pthreads, this method can be called on side buffers
    // as well, such as the stdout buffer in the filesystem code. Only copy when
    // we have to.
    if (data.buffer instanceof SharedArrayBuffer) {
      data = new Uint8Array(data);
    }
    return textDecoder.decode.call(textDecoder, data);
  };
}

var UTF8Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoderWrapper('utf8') : undefined;

/**
 * @param {number} idx
 * @param {number=} maxBytesToRead
 * @return {string}
 */
function UTF8ArrayToString(heap, idx, maxBytesToRead) {
  var endIdx = idx + maxBytesToRead;
  var endPtr = idx;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on null terminator by itself.
  // Also, use the length info to avoid running tiny strings through TextDecoder, since .subarray() allocates garbage.
  // (As a tiny code save trick, compare endPtr against endIdx using a negation, so that undefined means Infinity)
  while (heap[endPtr] && !(endPtr >= endIdx)) ++endPtr;

  if (endPtr - idx > 16 && heap.subarray && UTF8Decoder) {
    return UTF8Decoder.decode(heap.subarray(idx, endPtr));
  } else {
    var str = '';
    // If building with TextDecoder, we have already computed the string length above, so test loop end condition against that
    while (idx < endPtr) {
      // For UTF8 byte structure, see:
      // http://en.wikipedia.org/wiki/UTF-8#Description
      // https://www.ietf.org/rfc/rfc2279.txt
      // https://tools.ietf.org/html/rfc3629
      var u0 = heap[idx++];
      if (!(u0 & 0x80)) { str += String.fromCharCode(u0); continue; }
      var u1 = heap[idx++] & 63;
      if ((u0 & 0xE0) == 0xC0) { str += String.fromCharCode(((u0 & 31) << 6) | u1); continue; }
      var u2 = heap[idx++] & 63;
      if ((u0 & 0xF0) == 0xE0) {
        u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
      } else {
        if ((u0 & 0xF8) != 0xF0) warnOnce('Invalid UTF-8 leading byte 0x' + u0.toString(16) + ' encountered when deserializing a UTF-8 string in wasm memory to a JS string!');
        u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heap[idx++] & 63);
      }

      if (u0 < 0x10000) {
        str += String.fromCharCode(u0);
      } else {
        var ch = u0 - 0x10000;
        str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
      }
    }
  }
  return str;
}

// Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the emscripten HEAP, returns a
// copy of that string as a Javascript String object.
// maxBytesToRead: an optional length that specifies the maximum number of bytes to read. You can omit
//                 this parameter to scan the string until the first \0 byte. If maxBytesToRead is
//                 passed, and the string at [ptr, ptr+maxBytesToReadr[ contains a null byte in the
//                 middle, then the string will cut short at that byte index (i.e. maxBytesToRead will
//                 not produce a string of exact length [ptr, ptr+maxBytesToRead[)
//                 N.B. mixing frequent uses of UTF8ToString() with and without maxBytesToRead may
//                 throw JS JIT optimizations off, so it is worth to consider consistently using one
//                 style or the other.
/**
 * @param {number} ptr
 * @param {number=} maxBytesToRead
 * @return {string}
 */
function UTF8ToString(ptr, maxBytesToRead) {
  return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : '';
}

// Copies the given Javascript String object 'str' to the given byte array at address 'outIdx',
// encoded in UTF8 form and null-terminated. The copy will require at most str.length*4+1 bytes of space in the HEAP.
// Use the function lengthBytesUTF8 to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   heap: the array to copy to. Each index in this array is assumed to be one 8-byte element.
//   outIdx: The starting offset in the array to begin the copying.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array.
//                    This count should include the null terminator,
//                    i.e. if maxBytesToWrite=1, only the null terminator will be written and nothing else.
//                    maxBytesToWrite=0 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF8Array(str, heap, outIdx, maxBytesToWrite) {
  if (!(maxBytesToWrite > 0)) // Parameter maxBytesToWrite is not optional. Negative values, 0, null, undefined and false each don't write out any bytes.
    return 0;

  var startIdx = outIdx;
  var endIdx = outIdx + maxBytesToWrite - 1; // -1 for string null terminator.
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description and https://www.ietf.org/rfc/rfc2279.txt and https://tools.ietf.org/html/rfc3629
    var u = str.charCodeAt(i); // possibly a lead surrogate
    if (u >= 0xD800 && u <= 0xDFFF) {
      var u1 = str.charCodeAt(++i);
      u = 0x10000 + ((u & 0x3FF) << 10) | (u1 & 0x3FF);
    }
    if (u <= 0x7F) {
      if (outIdx >= endIdx) break;
      heap[outIdx++] = u;
    } else if (u <= 0x7FF) {
      if (outIdx + 1 >= endIdx) break;
      heap[outIdx++] = 0xC0 | (u >> 6);
      heap[outIdx++] = 0x80 | (u & 63);
    } else if (u <= 0xFFFF) {
      if (outIdx + 2 >= endIdx) break;
      heap[outIdx++] = 0xE0 | (u >> 12);
      heap[outIdx++] = 0x80 | ((u >> 6) & 63);
      heap[outIdx++] = 0x80 | (u & 63);
    } else {
      if (outIdx + 3 >= endIdx) break;
      if (u >= 0x200000) warnOnce('Invalid Unicode code point 0x' + u.toString(16) + ' encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x1FFFFF).');
      heap[outIdx++] = 0xF0 | (u >> 18);
      heap[outIdx++] = 0x80 | ((u >> 12) & 63);
      heap[outIdx++] = 0x80 | ((u >> 6) & 63);
      heap[outIdx++] = 0x80 | (u & 63);
    }
  }
  // Null-terminate the pointer to the buffer.
  heap[outIdx] = 0;
  return outIdx - startIdx;
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF8 form. The copy will require at most str.length*4+1 bytes of space in the HEAP.
// Use the function lengthBytesUTF8 to compute the exact number of bytes (excluding null terminator) that this function will write.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF8(str, outPtr, maxBytesToWrite) {
  assert(typeof maxBytesToWrite == 'number', 'stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!');
  return stringToUTF8Array(str, HEAPU8,outPtr, maxBytesToWrite);
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF8 byte array, EXCLUDING the null terminator byte.
function lengthBytesUTF8(str) {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! So decode UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var u = str.charCodeAt(i); // possibly a lead surrogate
    if (u >= 0xD800 && u <= 0xDFFF) u = 0x10000 + ((u & 0x3FF) << 10) | (str.charCodeAt(++i) & 0x3FF);
    if (u <= 0x7F) ++len;
    else if (u <= 0x7FF) len += 2;
    else if (u <= 0xFFFF) len += 3;
    else len += 4;
  }
  return len;
}

// end include: runtime_strings.js
// include: runtime_strings_extra.js


// runtime_strings_extra.js: Strings related runtime functions that are available only in regular runtime.

// Given a pointer 'ptr' to a null-terminated ASCII-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.

function AsciiToString(ptr) {
  var str = '';
  while (1) {
    var ch = HEAPU8[((ptr++)>>0)];
    if (!ch) return str;
    str += String.fromCharCode(ch);
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in ASCII form. The copy will require at most str.length+1 bytes of space in the HEAP.

function stringToAscii(str, outPtr) {
  return writeAsciiToMemory(str, outPtr, false);
}

// Given a pointer 'ptr' to a null-terminated UTF16LE-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.

var UTF16Decoder = typeof TextDecoder !== 'undefined' ? new TextDecoderWrapper('utf-16le') : undefined;

function UTF16ToString(ptr, maxBytesToRead) {
  assert(ptr % 2 == 0, 'Pointer passed to UTF16ToString must be aligned to two bytes!');
  var endPtr = ptr;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on null terminator by itself.
  // Also, use the length info to avoid running tiny strings through TextDecoder, since .subarray() allocates garbage.
  var idx = endPtr >> 1;
  var maxIdx = idx + maxBytesToRead / 2;
  // If maxBytesToRead is not passed explicitly, it will be undefined, and this
  // will always evaluate to true. This saves on code size.
  while (!(idx >= maxIdx) && HEAPU16[idx]) ++idx;
  endPtr = idx << 1;

  if (endPtr - ptr > 32 && UTF16Decoder) {
    return UTF16Decoder.decode(HEAPU8.subarray(ptr, endPtr));
  } else {
    var str = '';

    // If maxBytesToRead is not passed explicitly, it will be undefined, and the for-loop's condition
    // will always evaluate to true. The loop is then terminated on the first null char.
    for (var i = 0; !(i >= maxBytesToRead / 2); ++i) {
      var codeUnit = HEAP16[(((ptr)+(i*2))>>1)];
      if (codeUnit == 0) break;
      // fromCharCode constructs a character from a UTF-16 code unit, so we can pass the UTF16 string right through.
      str += String.fromCharCode(codeUnit);
    }

    return str;
  }
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF16 form. The copy will require at most str.length*4+2 bytes of space in the HEAP.
// Use the function lengthBytesUTF16() to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outPtr: Byte address in Emscripten HEAP where to write the string to.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array. This count should include the null
//                    terminator, i.e. if maxBytesToWrite=2, only the null terminator will be written and nothing else.
//                    maxBytesToWrite<2 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF16(str, outPtr, maxBytesToWrite) {
  assert(outPtr % 2 == 0, 'Pointer passed to stringToUTF16 must be aligned to two bytes!');
  assert(typeof maxBytesToWrite == 'number', 'stringToUTF16(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!');
  // Backwards compatibility: if max bytes is not specified, assume unsafe unbounded write is allowed.
  if (maxBytesToWrite === undefined) {
    maxBytesToWrite = 0x7FFFFFFF;
  }
  if (maxBytesToWrite < 2) return 0;
  maxBytesToWrite -= 2; // Null terminator.
  var startPtr = outPtr;
  var numCharsToWrite = (maxBytesToWrite < str.length*2) ? (maxBytesToWrite / 2) : str.length;
  for (var i = 0; i < numCharsToWrite; ++i) {
    // charCodeAt returns a UTF-16 encoded code unit, so it can be directly written to the HEAP.
    var codeUnit = str.charCodeAt(i); // possibly a lead surrogate
    HEAP16[((outPtr)>>1)] = codeUnit;
    outPtr += 2;
  }
  // Null-terminate the pointer to the HEAP.
  HEAP16[((outPtr)>>1)] = 0;
  return outPtr - startPtr;
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF16 byte array, EXCLUDING the null terminator byte.

function lengthBytesUTF16(str) {
  return str.length*2;
}

function UTF32ToString(ptr, maxBytesToRead) {
  assert(ptr % 4 == 0, 'Pointer passed to UTF32ToString must be aligned to four bytes!');
  var i = 0;

  var str = '';
  // If maxBytesToRead is not passed explicitly, it will be undefined, and this
  // will always evaluate to true. This saves on code size.
  while (!(i >= maxBytesToRead / 4)) {
    var utf32 = HEAP32[(((ptr)+(i*4))>>2)];
    if (utf32 == 0) break;
    ++i;
    // Gotcha: fromCharCode constructs a character from a UTF-16 encoded code (pair), not from a Unicode code point! So encode the code point to UTF-16 for constructing.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    if (utf32 >= 0x10000) {
      var ch = utf32 - 0x10000;
      str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
    } else {
      str += String.fromCharCode(utf32);
    }
  }
  return str;
}

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF32 form. The copy will require at most str.length*4+4 bytes of space in the HEAP.
// Use the function lengthBytesUTF32() to compute the exact number of bytes (excluding null terminator) that this function will write.
// Parameters:
//   str: the Javascript string to copy.
//   outPtr: Byte address in Emscripten HEAP where to write the string to.
//   maxBytesToWrite: The maximum number of bytes this function can write to the array. This count should include the null
//                    terminator, i.e. if maxBytesToWrite=4, only the null terminator will be written and nothing else.
//                    maxBytesToWrite<4 does not write any bytes to the output, not even the null terminator.
// Returns the number of bytes written, EXCLUDING the null terminator.

function stringToUTF32(str, outPtr, maxBytesToWrite) {
  assert(outPtr % 4 == 0, 'Pointer passed to stringToUTF32 must be aligned to four bytes!');
  assert(typeof maxBytesToWrite == 'number', 'stringToUTF32(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!');
  // Backwards compatibility: if max bytes is not specified, assume unsafe unbounded write is allowed.
  if (maxBytesToWrite === undefined) {
    maxBytesToWrite = 0x7FFFFFFF;
  }
  if (maxBytesToWrite < 4) return 0;
  var startPtr = outPtr;
  var endPtr = startPtr + maxBytesToWrite - 4;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! We must decode the string to UTF-32 to the heap.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var codeUnit = str.charCodeAt(i); // possibly a lead surrogate
    if (codeUnit >= 0xD800 && codeUnit <= 0xDFFF) {
      var trailSurrogate = str.charCodeAt(++i);
      codeUnit = 0x10000 + ((codeUnit & 0x3FF) << 10) | (trailSurrogate & 0x3FF);
    }
    HEAP32[((outPtr)>>2)] = codeUnit;
    outPtr += 4;
    if (outPtr + 4 > endPtr) break;
  }
  // Null-terminate the pointer to the HEAP.
  HEAP32[((outPtr)>>2)] = 0;
  return outPtr - startPtr;
}

// Returns the number of bytes the given Javascript string takes if encoded as a UTF16 byte array, EXCLUDING the null terminator byte.

function lengthBytesUTF32(str) {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! We must decode the string to UTF-32 to the heap.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var codeUnit = str.charCodeAt(i);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDFFF) ++i; // possibly a lead surrogate, so skip over the tail surrogate.
    len += 4;
  }

  return len;
}

// Allocate heap space for a JS string, and write it there.
// It is the responsibility of the caller to free() that memory.
function allocateUTF8(str) {
  var size = lengthBytesUTF8(str) + 1;
  var ret = _malloc(size);
  if (ret) stringToUTF8Array(str, HEAP8, ret, size);
  return ret;
}

// Allocate stack space for a JS string, and write it there.
function allocateUTF8OnStack(str) {
  var size = lengthBytesUTF8(str) + 1;
  var ret = stackAlloc(size);
  stringToUTF8Array(str, HEAP8, ret, size);
  return ret;
}

// Deprecated: This function should not be called because it is unsafe and does not provide
// a maximum length limit of how many bytes it is allowed to write. Prefer calling the
// function stringToUTF8Array() instead, which takes in a maximum length that can be used
// to be secure from out of bounds writes.
/** @deprecated
    @param {boolean=} dontAddNull */
function writeStringToMemory(string, buffer, dontAddNull) {
  warnOnce('writeStringToMemory is deprecated and should not be called! Use stringToUTF8() instead!');

  var /** @type {number} */ lastChar, /** @type {number} */ end;
  if (dontAddNull) {
    // stringToUTF8Array always appends null. If we don't want to do that, remember the
    // character that existed at the location where the null will be placed, and restore
    // that after the write (below).
    end = buffer + lengthBytesUTF8(string);
    lastChar = HEAP8[end];
  }
  stringToUTF8(string, buffer, Infinity);
  if (dontAddNull) HEAP8[end] = lastChar; // Restore the value under the null character.
}

function writeArrayToMemory(array, buffer) {
  assert(array.length >= 0, 'writeArrayToMemory array must have a length (should be an array or typed array)')
  HEAP8.set(array, buffer);
}

/** @param {boolean=} dontAddNull */
function writeAsciiToMemory(str, buffer, dontAddNull) {
  for (var i = 0; i < str.length; ++i) {
    assert(str.charCodeAt(i) === str.charCodeAt(i)&0xff);
    HEAP8[((buffer++)>>0)] = str.charCodeAt(i);
  }
  // Null-terminate the pointer to the HEAP.
  if (!dontAddNull) HEAP8[((buffer)>>0)] = 0;
}

// end include: runtime_strings_extra.js
// Memory management

function alignUp(x, multiple) {
  if (x % multiple > 0) {
    x += multiple - (x % multiple);
  }
  return x;
}

var HEAP,
/** @type {ArrayBuffer} */
  buffer,
/** @type {Int8Array} */
  HEAP8,
/** @type {Uint8Array} */
  HEAPU8,
/** @type {Int16Array} */
  HEAP16,
/** @type {Uint16Array} */
  HEAPU16,
/** @type {Int32Array} */
  HEAP32,
/** @type {Uint32Array} */
  HEAPU32,
/** @type {Float32Array} */
  HEAPF32,
/** @type {Float64Array} */
  HEAPF64;

if (ENVIRONMENT_IS_PTHREAD) {
  // Grab imports from the pthread to local scope.
  buffer = Module['buffer'];
  // Note that not all runtime fields are imported above
}

function updateGlobalBufferAndViews(buf) {
  buffer = buf;
  Module['HEAP8'] = HEAP8 = new Int8Array(buf);
  Module['HEAP16'] = HEAP16 = new Int16Array(buf);
  Module['HEAP32'] = HEAP32 = new Int32Array(buf);
  Module['HEAPU8'] = HEAPU8 = new Uint8Array(buf);
  Module['HEAPU16'] = HEAPU16 = new Uint16Array(buf);
  Module['HEAPU32'] = HEAPU32 = new Uint32Array(buf);
  Module['HEAPF32'] = HEAPF32 = new Float32Array(buf);
  Module['HEAPF64'] = HEAPF64 = new Float64Array(buf);
}

var TOTAL_STACK = 5242880;
if (Module['TOTAL_STACK']) assert(TOTAL_STACK === Module['TOTAL_STACK'], 'the stack size can no longer be determined at runtime')

var INITIAL_MEMORY = Module['INITIAL_MEMORY'] || 209715200;
if (!Object.getOwnPropertyDescriptor(Module, 'INITIAL_MEMORY')) {
  Object.defineProperty(Module, 'INITIAL_MEMORY', {
    configurable: true,
    get: function() {
      abort('Module.INITIAL_MEMORY has been replaced with plain INITIAL_MEMORY (the initial value can be provided on Module, but after startup the value is only looked for on a local variable of that name)')
    }
  });
}

assert(INITIAL_MEMORY >= TOTAL_STACK, 'INITIAL_MEMORY should be larger than TOTAL_STACK, was ' + INITIAL_MEMORY + '! (TOTAL_STACK=' + TOTAL_STACK + ')');

// check for full engine support (use string 'subarray' to avoid closure compiler confusion)
assert(typeof Int32Array !== 'undefined' && typeof Float64Array !== 'undefined' && Int32Array.prototype.subarray !== undefined && Int32Array.prototype.set !== undefined,
       'JS engine does not provide full typed array support');

// In non-standalone/normal mode, we create the memory here.
// include: runtime_init_memory.js


// Create the wasm memory. (Note: this only applies if IMPORTED_MEMORY is defined)

if (ENVIRONMENT_IS_PTHREAD) {
  wasmMemory = Module['wasmMemory'];
  buffer = Module['buffer'];
} else {

  if (Module['wasmMemory']) {
    wasmMemory = Module['wasmMemory'];
  } else
  {
    wasmMemory = new WebAssembly.Memory({
      'initial': INITIAL_MEMORY / 65536,
      'maximum': INITIAL_MEMORY / 65536
      ,
      'shared': true
    });
    if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
      err('requested a shared WebAssembly.Memory but the returned buffer is not a SharedArrayBuffer, indicating that while the browser has SharedArrayBuffer it does not have WebAssembly threads support - you may need to set a flag');
      if (ENVIRONMENT_IS_NODE) {
        console.log('(on node you may need: --experimental-wasm-threads --experimental-wasm-bulk-memory and also use a recent version)');
      }
      throw Error('bad memory');
    }
  }

}

if (wasmMemory) {
  buffer = wasmMemory.buffer;
}

// If the user provides an incorrect length, just use that length instead rather than providing the user to
// specifically provide the memory length with Module['INITIAL_MEMORY'].
INITIAL_MEMORY = buffer.byteLength;
assert(INITIAL_MEMORY % 65536 === 0);
updateGlobalBufferAndViews(buffer);

// end include: runtime_init_memory.js

// include: runtime_init_table.js
// In regular non-RELOCATABLE mode the table is exported
// from the wasm module and this will be assigned once
// the exports are available.
var wasmTable;

// end include: runtime_init_table.js
// include: runtime_stack_check.js


// Initializes the stack cookie. Called at the startup of main and at the startup of each thread in pthreads mode.
function writeStackCookie() {
  var max = _emscripten_stack_get_end();
  assert((max & 3) == 0);
  // The stack grows downwards
  HEAPU32[(max >> 2)+1] = 0x2135467;
  HEAPU32[(max >> 2)+2] = 0x89BACDFE;
  // Also test the global address 0 for integrity.
  HEAP32[0] = 0x63736d65; /* 'emsc' */
}

function checkStackCookie() {
  if (ABORT) return;
  var max = _emscripten_stack_get_end();
  var cookie1 = HEAPU32[(max >> 2)+1];
  var cookie2 = HEAPU32[(max >> 2)+2];
  if (cookie1 != 0x2135467 || cookie2 != 0x89BACDFE) {
    abort('Stack overflow! Stack cookie has been overwritten, expected hex dwords 0x89BACDFE and 0x2135467, but received 0x' + cookie2.toString(16) + ' ' + cookie1.toString(16));
  }
  // Also test the global address 0 for integrity.
  if (HEAP32[0] !== 0x63736d65 /* 'emsc' */) abort('Runtime error: The application has corrupted its heap memory area (address zero)!');
}

// end include: runtime_stack_check.js
// include: runtime_assertions.js


// Endianness check
(function() {
  var h16 = new Int16Array(1);
  var h8 = new Int8Array(h16.buffer);
  h16[0] = 0x6373;
  if (h8[0] !== 0x73 || h8[1] !== 0x63) throw 'Runtime error: expected the system to be little-endian! (Run with -s SUPPORT_BIG_ENDIAN=1 to bypass)';
})();

// end include: runtime_assertions.js
var __ATPRERUN__  = []; // functions called before the runtime is initialized
var __ATINIT__    = []; // functions called during startup
var __ATMAIN__    = []; // functions called when main() is to be run
var __ATEXIT__    = []; // functions called during shutdown
var __ATPOSTRUN__ = []; // functions called after the main() is called

var runtimeInitialized = false;
var runtimeExited = false;
var runtimeKeepaliveCounter = 0;

function keepRuntimeAlive() {
  return noExitRuntime || runtimeKeepaliveCounter > 0;
}

function preRun() {
  if (ENVIRONMENT_IS_PTHREAD) return; // PThreads reuse the runtime from the main thread.

  if (Module['preRun']) {
    if (typeof Module['preRun'] == 'function') Module['preRun'] = [Module['preRun']];
    while (Module['preRun'].length) {
      addOnPreRun(Module['preRun'].shift());
    }
  }

  callRuntimeCallbacks(__ATPRERUN__);
}

function initRuntime() {
  checkStackCookie();
  assert(!runtimeInitialized);
  runtimeInitialized = true;

  if (ENVIRONMENT_IS_PTHREAD) return;

  
  callRuntimeCallbacks(__ATINIT__);
}

function preMain() {
  checkStackCookie();
  if (ENVIRONMENT_IS_PTHREAD) return; // PThreads reuse the runtime from the main thread.
  
  callRuntimeCallbacks(__ATMAIN__);
}

function exitRuntime() {
  checkStackCookie();
  if (ENVIRONMENT_IS_PTHREAD) return; // PThreads reuse the runtime from the main thread.
  runtimeExited = true;
}

function postRun() {
  checkStackCookie();
  if (ENVIRONMENT_IS_PTHREAD) return; // PThreads reuse the runtime from the main thread.

  if (Module['postRun']) {
    if (typeof Module['postRun'] == 'function') Module['postRun'] = [Module['postRun']];
    while (Module['postRun'].length) {
      addOnPostRun(Module['postRun'].shift());
    }
  }

  callRuntimeCallbacks(__ATPOSTRUN__);
}

function addOnPreRun(cb) {
  __ATPRERUN__.unshift(cb);
}

function addOnInit(cb) {
  __ATINIT__.unshift(cb);
}

function addOnPreMain(cb) {
  __ATMAIN__.unshift(cb);
}

function addOnExit(cb) {
}

function addOnPostRun(cb) {
  __ATPOSTRUN__.unshift(cb);
}

// include: runtime_math.js


// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/imul

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/fround

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/clz32

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/trunc

assert(Math.imul, 'This browser does not support Math.imul(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.fround, 'This browser does not support Math.fround(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.clz32, 'This browser does not support Math.clz32(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');
assert(Math.trunc, 'This browser does not support Math.trunc(), build with LEGACY_VM_SUPPORT or POLYFILL_OLD_MATH_FUNCTIONS to add in a polyfill');

// end include: runtime_math.js
// A counter of dependencies for calling run(). If we need to
// do asynchronous work before running, increment this and
// decrement it. Incrementing must happen in a place like
// Module.preRun (used by emcc to add file preloading).
// Note that you can add dependencies in preRun, even though
// it happens right before run - run will be postponed until
// the dependencies are met.
var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null; // overridden to take different actions when all run dependencies are fulfilled
var runDependencyTracking = {};

function getUniqueRunDependency(id) {
  var orig = id;
  while (1) {
    if (!runDependencyTracking[id]) return id;
    id = orig + Math.random();
  }
}

function addRunDependency(id) {
  runDependencies++;

  if (Module['monitorRunDependencies']) {
    Module['monitorRunDependencies'](runDependencies);
  }

  if (id) {
    assert(!runDependencyTracking[id]);
    runDependencyTracking[id] = 1;
    if (runDependencyWatcher === null && typeof setInterval !== 'undefined') {
      // Check for missing dependencies every few seconds
      runDependencyWatcher = setInterval(function() {
        if (ABORT) {
          clearInterval(runDependencyWatcher);
          runDependencyWatcher = null;
          return;
        }
        var shown = false;
        for (var dep in runDependencyTracking) {
          if (!shown) {
            shown = true;
            err('still waiting on run dependencies:');
          }
          err('dependency: ' + dep);
        }
        if (shown) {
          err('(end of list)');
        }
      }, 10000);
    }
  } else {
    err('warning: run dependency added without ID');
  }
}

function removeRunDependency(id) {
  runDependencies--;

  if (Module['monitorRunDependencies']) {
    Module['monitorRunDependencies'](runDependencies);
  }

  if (id) {
    assert(runDependencyTracking[id]);
    delete runDependencyTracking[id];
  } else {
    err('warning: run dependency removed without ID');
  }
  if (runDependencies == 0) {
    if (runDependencyWatcher !== null) {
      clearInterval(runDependencyWatcher);
      runDependencyWatcher = null;
    }
    if (dependenciesFulfilled) {
      var callback = dependenciesFulfilled;
      dependenciesFulfilled = null;
      callback(); // can add another dependenciesFulfilled
    }
  }
}

Module["preloadedImages"] = {}; // maps url to image data
Module["preloadedAudios"] = {}; // maps url to audio data

/** @param {string|number=} what */
function abort(what) {
  // When running on a pthread, none of the incoming parameters on the module
  // object are present.  The `onAbort` handler only exists on the main thread
  // and so we need to proxy the handling of these back to the main thread.
  // TODO(sbc): Extend this to all such handlers that can be passed into on
  // module creation.
  if (ENVIRONMENT_IS_PTHREAD) {
    postMessage({ 'cmd': 'onAbort', 'arg': what});
  } else
  {
    if (Module['onAbort']) {
      Module['onAbort'](what);
    }
  }

  what += '';
  err(what);

  ABORT = true;
  EXITSTATUS = 1;

  var output = 'abort(' + what + ') at ' + stackTrace();
  what = output;

  // Use a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  var e = new WebAssembly.RuntimeError(what);

  // Throw the error whether or not MODULARIZE is set because abort is used
  // in code paths apart from instantiation where an exception is expected
  // to be thrown when abort is called.
  throw e;
}

// {{MEM_INITIALIZER}}

// include: memoryprofiler.js


// end include: memoryprofiler.js
// show errors on likely calls to FS when it was not included
var FS = {
  error: function() {
    abort('Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with  -s FORCE_FILESYSTEM=1');
  },
  init: function() { FS.error() },
  createDataFile: function() { FS.error() },
  createPreloadedFile: function() { FS.error() },
  createLazyFile: function() { FS.error() },
  open: function() { FS.error() },
  mkdev: function() { FS.error() },
  registerDevice: function() { FS.error() },
  analyzePath: function() { FS.error() },
  loadFilesFromDB: function() { FS.error() },

  ErrnoError: function ErrnoError() { FS.error() },
};
Module['FS_createDataFile'] = FS.createDataFile;
Module['FS_createPreloadedFile'] = FS.createPreloadedFile;

// include: URIUtils.js


// Prefix of data URIs emitted by SINGLE_FILE and related options.
var dataURIPrefix = 'data:application/octet-stream;base64,';

// Indicates whether filename is a base64 data URI.
function isDataURI(filename) {
  // Prefix of data URIs emitted by SINGLE_FILE and related options.
  return filename.startsWith(dataURIPrefix);
}

// Indicates whether filename is delivered via file protocol (as opposed to http/https)
function isFileURI(filename) {
  return filename.startsWith('file://');
}

// end include: URIUtils.js
function createExportWrapper(name, fixedasm) {
  return function() {
    var displayName = name;
    var asm = fixedasm;
    if (!fixedasm) {
      asm = Module['asm'];
    }
    assert(runtimeInitialized, 'native function `' + displayName + '` called before runtime initialization');
    assert(!runtimeExited, 'native function `' + displayName + '` called after runtime exit (use NO_EXIT_RUNTIME to keep it alive after main() exits)');
    if (!asm[name]) {
      assert(asm[name], 'exported native function `' + displayName + '` not found');
    }
    return asm[name].apply(null, arguments);
  };
}

var wasmBinaryFile;
  wasmBinaryFile = 'data:application/octet-stream;base64,AGFzbQEAAAAB4oKAgAAwYAF/AX9gAX8AYAN/f38Bf2ACf38Bf2AAAGAAAX9gAn9/AGAFf39/f38Bf2AEf39/fwF/YAR/f39/AGADf39/AGADf35/AX5gBn9/f39/fwF/YAV/f39/fwBgB39/f39/f38Bf2AGf3x/f39/AX9gAn5/AX9gBH9+fn8AYAABfGADf398AX9gA39/fwF8YAN/fH8Bf2ABfABgA39/fQBgBH9/fX8AYAZ/f39/f38AYAh/f39/f39/fwBgCn9/f39/f39/f38AYAl/f39/f39/f38Bf2ABfQBgAn99AGACfX0AYAN/fX0AYAN9fX0AYAR/fX19AGAEfX19fQBgBX99fX19AGAHf39/f39/fwBgCX9/f39/f39/fwBgC39/f39/f39/f39/AGAIf39/f39/f38Bf2ACf3wBf2AEf39/fwF8YAJ8fwF8YAN+f38Bf2ABfAF+YAJ+fgF8YAR/f35/AX4C6oWAgAAZA2VudhNfX2N4YV90aHJlYWRfYXRleGl0AAIDZW52E19fcHRocmVhZF9jcmVhdGVfanMACANlbnYbX19wdGhyZWFkX2V4aXRfcnVuX2hhbmRsZXJzAAQDZW52EmVtc2NyaXB0ZW5fZ2V0X25vdwASA2VudjBlbXNjcmlwdGVuX2NvbmRpdGlvbmFsX3NldF9jdXJyZW50X3RocmVhZF9zdGF0dXMABgNlbnYVZW1zY3JpcHRlbl9mdXRleF93YWl0ABMDZW52FWVtc2NyaXB0ZW5fZnV0ZXhfd2FrZQADA2Vudg1fX2Fzc2VydF9mYWlsAAkDZW52JGVtc2NyaXB0ZW5fc2V0X2N1cnJlbnRfdGhyZWFkX3N0YXR1cwABA2Vudh9fZW1zY3JpcHRlbl9ub3RpZnlfdGhyZWFkX3F1ZXVlAAMDZW52H2Vtc2NyaXB0ZW5fd2ViZ2xfY3JlYXRlX2NvbnRleHQAAwNlbnYiZW1zY3JpcHRlbl9zZXRfY2FudmFzX2VsZW1lbnRfc2l6ZQACA2VudiRlbXNjcmlwdGVuX3JlY2VpdmVfb25fbWFpbl90aHJlYWRfanMAFANlbnYWZW1zY3JpcHRlbl9zZXRfdGltZW91dAAVA2Vudg5pbml0UHRocmVhZHNKUwABA2VudhNfX3B0aHJlYWRfZXhpdF9kb25lAAQDZW52BGV4aXQAAQNlbnYiZW1zY3JpcHRlbl91bndpbmRfdG9fanNfZXZlbnRfbG9vcAAEA2VudhFfX3B0aHJlYWRfam9pbl9qcwADA2Vudg9fX2Nsb2NrX2dldHRpbWUAAwNlbnYWZW1zY3JpcHRlbl9yZXNpemVfaGVhcAAAA2VudhVlbXNjcmlwdGVuX21lbWNweV9iaWcAAhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAgDZW52C3NldFRlbXBSZXQwAAEDZW52Bm1lbW9yeQIDgBmAGQOKgYCAAIgBBAEEAgIDAQICAwUFAAAFAQEDBAEWBAABASkFAwABAQIHBCoFDAEECAEBBAMABAUKBQUFBQUAAgMrBw4KAAksEBANAg8GLQIDAAADAgEBAAIAAAMGBQQEBAUEAwcHAAMRES4AAwAABAABAwMGBQACAgEBBQQAAgACAAsDAAEFAQAEBgUFAAAvBwSFgICAAAFwAQoKBr2AgIAAC38BQcCmwAILfwFBAAt/AEEBC38AQQELfwFBAAt/AUEAC38BQQALfwFBAAt/AUEAC38AQagVC38AQZwZCweEiICAACoRX193YXNtX2NhbGxfY3RvcnMAGA9DcmVhdGVGcmVlUXVldWUAHQZtYWxsb2MAfRBEZXN0cm95RnJlZVF1ZXVlAB4EZnJlZQCAAQ1GcmVlUXVldWVQdXNoAB8NRnJlZVF1ZXVlUHVsbAAgFEdldEZyZWVRdWV1ZVBvaW50ZXJzACEXRGVzdHJveUZyZWVRdWV1ZVRocmVhZHMAIhZDcmVhdGVGcmVlUXVldWVUaHJlYWRzACMTR2V0RnJlZVF1ZXVlVGhyZWFkcwAmDlByaW50UXVldWVJbmZvACcTUHJpbnRRdWV1ZUFkZHJlc3NlcwAoBG1haW4AKRlfX2luZGlyZWN0X2Z1bmN0aW9uX3RhYmxlAQATZW1zY3JpcHRlbl90bHNfaW5pdAAqLmVtc2NyaXB0ZW5fY3VycmVudF90aHJlYWRfcHJvY2Vzc19xdWV1ZWRfY2FsbHMALSFlbXNjcmlwdGVuX21haW5fYnJvd3Nlcl90aHJlYWRfaWQAMiRlbXNjcmlwdGVuX3N5bmNfcnVuX2luX21haW5fdGhyZWFkXzIANyRlbXNjcmlwdGVuX3N5bmNfcnVuX2luX21haW5fdGhyZWFkXzQAOCtlbXNjcmlwdGVuX21haW5fdGhyZWFkX3Byb2Nlc3NfcXVldWVkX2NhbGxzADkrX2Vtc2NyaXB0ZW5fYWxsb3dfbWFpbl9ydW50aW1lX3F1ZXVlZF9jYWxscwMJKGVtc2NyaXB0ZW5fcnVuX2luX21haW5fcnVudGltZV90aHJlYWRfanMAOhpfZW1zY3JpcHRlbl9jYWxsX29uX3RocmVhZAA8JV9fZW1zY3JpcHRlbl9wdGhyZWFkX2RhdGFfY29uc3RydWN0b3IAPh1fZW1zY3JpcHRlbl9tYWluX3RocmVhZF9mdXRleAMKF19lbXNjcmlwdGVuX3RocmVhZF9leGl0AEAMcHRocmVhZF9zZWxmAGwXX2Vtc2NyaXB0ZW5fdGhyZWFkX2luaXQARxJwdGhyZWFkX3Rlc3RjYW5jZWwARRBfX2Vycm5vX2xvY2F0aW9uAEwaZW1zY3JpcHRlbl9nZXRfZ2xvYmFsX2xpYmMASgZmZmx1c2gAnAEJc3RhY2tTYXZlAJUBDHN0YWNrUmVzdG9yZQCWAQpzdGFja0FsbG9jAJcBFWVtc2NyaXB0ZW5fc3RhY2tfaW5pdACYARtlbXNjcmlwdGVuX3N0YWNrX3NldF9saW1pdHMAmQEZZW1zY3JpcHRlbl9zdGFja19nZXRfZnJlZQCaARhlbXNjcmlwdGVuX3N0YWNrX2dldF9lbmQAmwEIbWVtYWxpZ24AgQEMZHluQ2FsbF9qaWppAJ8BCIGAgIAAGgmSgICAAAEAQQELCSQlKz1bXJABjwGRAQyBgICAAAUKy5GCgACIAQkAEJgBED4QKgsQACAAJAEgAEEAQQH8CAAAC2sAQbgmQQBBAf5IAgAEQEG4JkEBQn/+AQIAGgVBkAhBAEGUDfwIAQBBqBVBAEGcAfwIAgACQEHEFhpBABpBKxoLQfAWQQBByA/8CAQAQbgmQQL+FwIAQbgmQX/+AAIAGgv8CQH8CQIB/AkEC7QBARR/IwAhA0EQIQQgAyAEayEFIAUgADYCCCAFIAE2AgQgBSACNgIAIAUoAgAhBiAFKAIEIQcgBiEIIAchCSAIIAlPIQpBASELIAogC3EhDAJAAkAgDEUNACAFKAIAIQ0gBSgCBCEOIA0gDmshDyAFIA82AgwMAQsgBSgCACEQIAUoAgghESARKAIAIRIg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HTYCDAwCC0HYECEeQQAhHyAeIB8QkgEaQfQWISBBACEhQQIhIkH4FiEjICMhJCAgICEgIiAkED8hJSACICU2AgAgAigCACEmAkAgJkUNAEF/IScgAiAnNgIMDAILQYMRIShBACEpICggKRCSARpBASEqIAIgKjYCDAwBC0EAISsgAiArNgIMCyACKAIMISxBECEtIAIgLWohLiAuJAAgLA8L8AgCgwF/AXwjACEBQdAAIQIgASACayEDIAMkACADIAA2AkwgAygCTCEEIAMgBDYCSCADKAJIIQUgBSgCACEGIAMgBjYCRCADKAJEIQcgBygCBCEIIAMgCDYCQCADKAJEIQkgCSgCACEKIAMgCjYCPEHkDSELIAMgCzYCOCADKAI8IQwgAygCQCENIAMgDTYCBCADIAw2AgBB6A8hDiAOIAMQkgEaAkADQCADKAJIIQ8gDygCBCEQIBBFDQEgAygCQCERQQIhEiARIBJ0IRMgExB9IRQgAyAUNgI0QQAhFSADIBU2AjACQANAIAMoAjAhFiADKAJAIRcgFiEYIBchGSAYIBlJIRpBASEbIBogG3EhHCAcRQ0BIAMoAjghHUEDIR4gHSAedCEfIB8QfSEgIAMoAjQhISADKAIwISJBAiEjICIgI3QhJCAhICRqISUgJSAgNgIAQQAhJiADICY2AiwCQANAIAMoAiwhJyADKAI4ISggJyEpICghKiApICpJIStBASEsICsgLHEhLSAtRQ0BIAMoAjQhLiADKAIwIS9BAiEwIC8gMHQhMSAuIDFqITIgMigCACEzIAMoAiwhNEEDITUgNCA1dCE2IDMgNmohN0EAITggOLchhAEgNyCEATkDACADKAIsITlBASE6IDkgOmohOyADIDs2AiwMAAsACyADKAIwITxBASE9IDwgPWohPiADID42AjAMAAsACyADKAJEIT8gPygCDCFAIED+EAIAIUEgAyBBNgIkIAMoAiQhQiADIEI2AiggAygCRCFDIEMoAgwhRCBE/hACBCFFIAMgRTYCHCADKAIcIUYgAyBGNgIgA0AgAygCRCFHIAMoAighSCADKAIgIUkgRyBIIEkQGyFKQQAhSyBKIUwgSyFNIEwgTUshTkEAIU9BASFQIE4gUHEhUSBPIVICQCBRRQ0AIAMoAkghUyBTKAIEIVRBACFVIFQhViBVIVcgViBX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QQE6AABBgBkQYBoCQAJAEGwQLiIADQBBgBkQaRoMAQsgAEEIaiEBAkAgACgCCCICIAAoAgxGDQADQEGAGRBpGiAAKAIEIAJBAnRqKAIAEC9BgBkQYBogACACQQFqQYABbyICNgIIIAIgACgCDEcNAAsLQYAZEGkaIAFB/////wcQBhoLIwFBAGpBADoAAAsLSAEBfwJAIABFDQACQEEAKAKgGSIBRQ0AA0ACQCABKAIAIABHDQAgAQ8LIAEoAhAiAQ0ACwtBAA8LQdMIQeUKQdECQakJEAcAC+sRAQF/AkACQAJAIAAoAgAiAUGAgIDAAXFBgICAwAFGDQACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAFB////7wBKDQACQCABQaeAgDBKDQACQCABQf///x9KDQACQCABQYCAgHBqDgMEGwUACyABQYCAgIp4Rg0bIAENGiAAKAIEEQQADB4LAkAgAUH///8vSg0AIAFB+P//X2oOAwUaBhkLIAFBgICAMEYNBiABQaCAgDBHDRkgACgCECAAQRhqKAIAIABBIGoqAgAgACgCBBEXAAwdCwJAIAFBp4GAwABKDQACQCABQdj//09qDgMIGgkACyABQYCAgMAARg0JIAFBoICAwABHDRkgACgCECAAQRhqKAIAIABBIGoqAgAgAEEoaigCACAAKAIEERgADB0LAkAgAUGnhYDQAEoNACABQdj+/79/ag4DChkLDAsgAUGohYDQAEYNDCABQYCAgOAARw0YIAAoAhAgAEEYaigCACAAQSBqKAIAIABBKGooAgAgAEEwaigCACAAQThqKAIAIAAoAgQRGQAMHAsCQCABQf///68CSg0AAkAgAUH///+vAUoNAAJAIAFB////jwFKDQAgAUGAgIDwAEYNDyABQYCAgIABRw0aIAAoAhAgAEEYaigCACAAQSBqKAIAIABBKGooAgAgAEEwaigCACAAQThqKAIAIABBwABqKAIAIABByABqKAIAIAAoAgQRGgAMHgsgAUGAgICQAUYNDyABQYCAgKABRw0ZIAAoAhAgAEEYaigCACAAQSBqKAIAIABBKGooAgAgAEEwaigCACAAQThqKAIAIABBwABqKAIAIABByABqKAIAIABB0ABqKAIAIABB2ABqKAIAIAAoAgQRGwAMHQsCQCABQf///48CSg0AIAFBgICAsAFGDRAgAUGAgICAAkcNGSAAIAAoAgQRBQA2ArABDB0LIAFBgICAkAJGDRAgAUGAgICgAkYNESABQYCAgKkCRw0YIAAgACgCECAAQRhqKAIAEAo2ArABDBwLAkAgAUH////PAkoNAAJAIAFB////vwJKDQAgAUGAgICwAkYNEyABQYCAwLkCRw0ZIAAgACgCECAAQRhqKAIAIABBIGooAgAQCzYCsAEMHQsgAUGAgIDAAkYNEyABQYCAgMgCRw0YIAAgACgCECAAQRhqKAIAIABBIGooAgAgAEEoaigCABABNgKwAQwcCwJAIAFB////7wJKDQAgAUGAgIDQAkYNFCABQYCAgOACRw0YIAAgACgCECAAQRhqKAIAIABBIGooAgAgAEEoaigCACAAQTBqKAIAIABBOGooAgAgACgCBBEMADYCsAEMHAsgAUGAgIDwAkYNFCABQYCAgIADRg0VIAFBgICAkANHDRcgACAAKAIQIABBGGooAgAgAEEgaigCACAAQShqKAIAIABBMGooAgAgAEE4aigCACAAQcAAaigCACAAQcgAaigCACAAQdAAaigCACAAKAIEERwANgKwAQwbCyAAKAIQIAAoAgQRAQAMGgsgACoCECAAKAIEER0ADBkLIAAoAhAgAEEYaioCACAAKAIEER4ADBgLIAAqAhAgAEEYaioCACAAKAIEER8ADBcLIAAoAhAgAEEYaigCACAAQSBqKAIAIAAoAgQRCgAMFgsgACgCECAAQRhqKgIAIABBIGoqAgAgACgCBBEgAAwVCyAAKgIQIABBGGoqAgAgAEEgaioCACAAKAIEESEADBQLIAAoAhAgAEEYaigCACAAQSBqKAIAIABBKGooAgAgACgCBBEJAAwTCyAAKAIQIABBGGoqAgAgAEEgaioCACAAQShqKgIAIAAoAgQRIgAMEgsgACoCECAAQRhqKgIAIABBIGoqAgAgAEEoaioCACAAKAIEESMADBELIAFBgICA0ABHDQwgACgCECAAQRhqKAIAIABBIGooAgAgAEEoaigCACAAQTBqKAIAIAAoAgQRDQAMEAsgACgCECAAQRhqKgIAIABBIGoqAgAgAEEoaioCACAAQTBqKgIAIAAoAgQRJAAMDwsgACgCECAAQRhqKAIAIABBIGooAgAgAEEoaigCACAAQTBqKAIAIABBOGooAgAgAEHAAGooAgAgACgCBBElAAwOCyAAKAIQIABBGGooAgAgAEEgaigCACAAQShqKAIAIABBMGooAgAgAEE4aigCACAAQcAAaigCACAAQcgAaigCACAAQdAAaigCACAAKAIEESYADA0LIAAoAhAgAEEYaigCACAAQSBqKAIAIABBKGooAgAgAEEwaigCACAAQThqKAIAIABBwABqKAIAIABByABqKAIAIABB0ABqKAIAIABB2ABqKAIAIABB4ABqKAIAIAAoAgQRJwAMDAsgACAAKAIQIAAoAgQRAAA2ArABDAsLIAAgACgCECAAQRhqKAIAIAAoAgQRAwA2ArABDAoLIAAgACgCECAAQRhqKAIAIABBIGooAgAgACgCBBECADYCsAEMCQsgACAAKAIQIABBGGooAgAgAEEgaigCACAAQShqKAIAIAAoAgQRCAA2ArABDAgLIAAgACgCECAAQRhqKAIAIABBIGooAgAgAEEoaigCACAAQTBqKAIAIAAoAgQRBwA2ArABDAcLIAAgACgCECAAQRhqKAIAIABBIGooAgAgAEEoaigCACAAQTBqKAIAIABBOGooAgAgAEHAAGooAgAgACgCBBEOADYCsAEMBgsgACAAKAIQIABBGGooAgAgAEEgaigCACAAQShqKAIAIABBMGooAgAgAEE4aigCACAAQcAAaigCACAAQcgAaigCACAAKAIEESgANgKwAQwFCyABQYCAgCBGDQMLQcQMQeUKQa8CQYkJEAcACyAAIAAoAgQgACgCECAAQRhqEAw5A7ABDAILQegLQeUKQZ8BQYkJEAcACyAAKAIQIABBGGooAgAgACgCBBEGAAsCQCAAKAK8AUUNACAAEDAPCyAAQQH+FwIIIABBCGpB/////wcQBhoLGAACQCAARQ0AIAAoArgBEIABCyAAEIABC2cCAX8BfAJAIAD+EAIIIgINABADIQNBBRAIQQAhAgJAIAMgAyABoCIBY0UNACAAQQhqIQADQCAAQQAgASADoRAFGiAA/hACACECEAMhAyACDQEgAyABYw0ACwtBARAIC0EAQXggAhsLBQBBoBcLswIBBn8CQAJAAkAgAUUNAAJAAkACQCAADgIAAQILQbgJQeUKQZ0DQcYJEAcAC0GgFyEACwJAAkAgAEECRg0A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IBIgAUobIQEMCQsgACAHKwNAIBIgEyANIAEgBREPACEBDAgLIAcgBykDQDwAN0EBIRMgCCEMIAkhESAVIQ0MBQsgByABQQFqIg42AkwgAS0AASENIA4hAQwACwALIAshFCAADQUgCkUNA0EBIQECQANAIAQgAUECdGooAgAiDUUNASADIAFBA3RqIA0gAiAGEFVBASEUIAFBAWoiAUEKRw0ADAcLAAtBASEUIAFBCk8NBQNAIAQgAUECdGooAgANAUEBIRQgAUEBaiIBQQpGDQYMAAsAC0F/IRQMBAsgCSERCyAAQSAgFCARIAxrIg8gEyATIA9IGyIRaiIOIBIgEiAOSBsiASAOIA0QWSAAIBAgFBBTIABBMCABIA4gDUGAgARzEFkgAEEwIBEgD0EAEFkgACAMIA8QUyAAQSAgASAOIA1BgMAAcxBZDAELC0EAIRQLIAdB0ABqJAAgFAsZAAJAIAAtAABBIHENACABIAIgABCNARoLC0kBA39BACEBAkAgACgCACwAABBNRQ0AA0AgACgCACICLAAAIQMgACACQQFqNgIAIAMgAUEKbGpBUGohASACLAABEE0NAAsLIAELuwIAAkAgAUEUSw0AAkACQAJAAkACQAJAAkACQAJAAkAgAUF3ag4KAAECAwQFBgcICQoLIAIgAigCACIBQQRqNgIAIAAgASgCADYCAA8LIAIgAigCACIBQQRqNgIAIAAgATQCADcDAA8LIAIgAigCACIBQQRqNgIAIAAgATUCADcDAA8LIAIgAigCAEEHakF4cSIBQQhqNgIAIAAgASkDADcDAA8LIAIgAigCACIBQQRqNgIAIAAgATIBADcDAA8LIAIgAigCACIBQQRqNgIAIAAgATMBADcDAA8LIAIgAigCACIBQQRqNgIAIAAgATAAADcDAA8LIAIgAigCACIBQQRqNgIAIAAgATEAADcDAA8LIAIgAigCAEEHakF4cSIBQQhqNgIAIAAgASsDADkDAA8LIAAgAiADEQYACws9AQF/AkAgAFANAANAIAFBf2oiASAAp0EPcUGQFWotAAAgAnI6AAAgAEIPViEDIABCBIghACADDQALCyABCzYBAX8CQCAAUA0AA0AgAUF/aiIBIACnQQdxQTByOgAAIABCB1YhAiAAQgOIIQAgAg0ACwsgAQuIAQIBfgN/AkACQCAAQoCA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k+vcA0sNACAAKAIAIgBBf0oNAQsQTEEcNgIAQX8PCyACt0QAAAAAgIQuQaMgALdEAAAAAABAj0CioBAsQQALUwEBfgJAAkAgA0HAAHFFDQAgASADQUBqrYYhAkIAIQEMAQsgA0UNACABQcAAIANrrYggAiADrSIEhoQhAiABIASGIQELIAAgATcDACAAIAI3AwgLUwEBfgJAAkAgA0HAAHFFDQAgAiADQUBqrYghAUIAIQIMAQsgA0UNACACQcAAIANrrYYgASADrSIEiIQhASACIASIIQILIAAgATcDACAAIAI3AwgL6AMCAn8CfiMAQSBrIgIkAAJAAkAgAUL///////////8AgyIEQoCAgICAgMD/Q3wgBEKAgICAgIDAgLx/fFoNACAAQjyIIAFCBIaEIQQCQCAAQv//////////D4MiAEKBgICAgICAgAhUDQAgBEKBgICAgICAgMAAfCEFDAILIARCgICAgICAgIDAAHwhBSAAQoCAgICAgICACIVCAFINASAFIARCAYN8IQUMAQsCQCAAUCAEQoCAgICAgMD//wBUIARCgICAgICAwP//AFEbDQAgAEI8iCABQgSGhEL/////////A4NCgICAgICAgPz/AIQhBQwBC0KAgICAgICA+P8AIQUgBEL///////+//8MAVg0AQgAhBSAEQjCIpyIDQZH3AEkNACACQRBqIAAgAUL///////8/g0KAgICAgIDAAIQiBCADQf+If2oQdyACIAAgBEGB+AAgA2sQeCACKQMAIgRCPIggAkEIaikDAEIEhoQhBQJAIARC//////////8PgyACKQMQIAJBEGpBCGopAwCEQgBSrYQiBEKBgICAgICAgAhUDQAgBUIBfCEFDAELIARCgICAgICAgIAIhUIAUg0AIAVCAYMgBXwhBQsgAkEgaiQAIAUgAUKAgICAgICAgIB/g4S/CwsAIABBADYCAEEAC3kBBH8jAEEgayICQRhqIgNBADYCACACQRBqIgRCADcDACACQQhqIgVCADcDACACQgA3AwAgACACKQMANwIAIABBGGogAygCADYCACAAQRBqIAQpAwA3AgAgAEEIaiAFKQMANwIAAkAgAUUNACAAIAEoAgA2AgALQQALBABBAAu1KgEJfwJAQQAoAvgZDQAQfgsCQAJAQQAtAMwdQQJxRQ0AQQAhAUHQ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cmlwdGVuXGVtc2RrXHVwc3RyZWFtXGVtc2NyaXB0ZW5cc3lzdGVtXGxpYlxwdGhyZWFkXGxpYnJhcnlfcHRocmVhZC5jAGNoYW5uZWxfZGF0YQBudW1fYXJncysxIDw9IEVNX1FVRVVFRF9KU19DQUxMX01BWF9BUkdTAEVNX0ZVTkNfU0lHX05VTV9GVU5DX0FSR1VNRU5UUyhxLT5mdW5jdGlvbkVudW0pIDw9IEVNX1FVRVVFRF9DQUxMX01BWF9BUkdTAE5BTgBJTkYALgAobnVsbCkAMCAmJiAiSW52YWxpZCBFbXNjcmlwdGVuIHB0aHJlYWQgX2RvX2NhbGwgb3Bjb2RlISIAJWYgAGNoYW5uZWwgJWQ6IABjaGFubmVsX2NvdW50OiAlcCAgIHVpbnQ6ICV6dQoAYnVmZmVyX2xlbmd0aDogJXAgICB1aW50OiAlenUKAGNoYW5uZWxfZGF0YSAgICA6ICVwICAgdWludDogJXp1CgBjaGFubmVsX2RhdGFbJWRdICAgIDogJXAgICB1aW50OiAlenUKAHN0YXRlWzFdICAgIDogJXAgICB1aW50OiAlenUKAHN0YXRlWzBdICAgIDogJXAgICB1aW50OiAlenUKAHN0YXRlICAgICAgIDogJXAgICB1aW50OiAlenUKAGN1cnJlbnRfcmVhZDogJXUgIHwgY3VycmVudF93cml0ZTogJXUKAGF2YWlsYWJsZV9yZWFkOiAldSAgfCBhdmFpbGFibGVfd3JpdGU6ICV1CgBjb25zdW1lcjogZXhpdCB0aHJlYWQKAHByb2R1Y2VyOiBleGl0IHRocmVhZAoAY29uc3VtZXI6IFsgYnVmZmVyIGxlbmd0aCBpcyAlZDsgY2hhbm5lbCBjb3VudCBpcyAlZCBdCgBwcm9kdWNlcjogWyBidWZmZXIgbGVuZ3RoIGlzICVkOyBjaGFubmVsIGNvdW50IGlzICVkIF0KAENyZWF0ZVRocmVhZHM6IGNvbnN1bWVyIHRocmVhZCBjcmVhdGVkLi4uCgBDcmVhdGVUaHJlYWRzOiBwcm9kdWNlciB0aHJlYWQgY3JlYXRlZC4uLgoALS0tLS0tLS0tLQoAAAAAAAAAEQAKABEREQAAAAAFAAAAAAAACQAAAAALAAAAAAAAAAARAA8KERERAwoHAAEACQsLAAAJBgsAAAsABhEAAAAREREAAAAAAAAAAAAAAAAAAAAACwAAAAAAAAAAEQAKChEREQAKAAACAAkLAAAACQALAAALAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAwAAAAADAAAAAAJDAAAAAAADAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAANAAAABA0AAAAACQ4AAAAAAA4AAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAADwAAAAAPAAAAAAkQAAAAAAAQAAAQAAASAAAAEhISAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABIAAAASEhIAAAAAAAAJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALAAAAAAAAAAAAAAAKAAAAAAoAAAAACQsAAAAAAAsAAAsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAADAAAAAAMAAAAAAkMAAAAAAAMAAAMAAAwMTIzNDU2Nzg5QUJDREVGsAoAAAGcAQEAAABAE1AABQAAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAkAAAA4DwAAAAQAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAACv////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsAoAAAEAAcgPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  if (!isDataURI(wasmBinaryFile)) {
    wasmBinaryFile = locateFile(wasmBinaryFile);
  }

function getBinary(file) {
  try {
    if (file == wasmBinaryFile && wasmBinary) {
      return new Uint8Array(wasmBinary);
    }
    var binary = tryParseAsDataURI(file);
    if (binary) {
      return binary;
    }
    if (readBinary) {
      return readBinary(file);
    } else {
      throw "both async and sync fetching of the wasm failed";
    }
  }
  catch (err) {
    abort(err);
  }
}

function getBinaryPromise() {
  // If we don't have the binary yet, try to to load it asynchronously.
  // Fetch has some additional restrictions over XHR, like it can't be used on a file:// url.
  // See https://github.com/github/fetch/pull/92#issuecomment-140665932
  // Cordova or Electron apps are typically loaded from a file:// url.
  // So use fetch if it is available and the url is not a file, otherwise fall back to XHR.
  if (!wasmBinary && (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER)) {
    if (typeof fetch === 'function'
      && !isFileURI(wasmBinaryFile)
    ) {
      return fetch(wasmBinaryFile, { credentials: 'same-origin' }).then(function(response) {
        if (!response['ok']) {
          throw "failed to load wasm binary file at '" + wasmBinaryFile + "'";
        }
        return response['arrayBuffer']();
      }).catch(function () {
          return getBinary(wasmBinaryFile);
      });
    }
    else {
      if (readAsync) {
        // fetch is not available or url is file => try XHR (readAsync uses XHR internally)
        return new Promise(function(resolve, reject) {
          readAsync(wasmBinaryFile, function(response) { resolve(new Uint8Array(/** @type{!ArrayBuffer} */(response))) }, reject)
        });
      }
    }
  }

  // Otherwise, getBinary should be able to get it synchronously
  return Promise.resolve().then(function() { return getBinary(wasmBinaryFile); });
}

// Create the wasm instance.
// Receives the wasm imports, returns the exports.
function createWasm() {
  // prepare imports
  var info = {
    'env': asmLibraryArg,
    'wasi_snapshot_preview1': asmLibraryArg,
  };
  // Load the wasm module and create an instance of using native support in the JS engine.
  // handle a generated wasm instance, receiving its exports and
  // performing other necessary setup
  /** @param {WebAssembly.Module=} module*/
  function receiveInstance(instance, module) {
    var exports = instance.exports;

    Module['asm'] = exports;

    wasmTable = Module['asm']['__indirect_function_table'];
    assert(wasmTable, "table not found in wasm exports");

    addOnInit(Module['asm']['__wasm_call_ctors']);

    PThread.tlsInitFunctions.push(Module['asm']['emscripten_tls_init']);
    // We now have the Wasm module loaded up, keep a reference to the compiled module so we can post it to the workers.
    wasmModule = module;
    // Instantiation is synchronous in pthreads and we assert on run dependencies.
    if (!ENVIRONMENT_IS_PTHREAD) {
      // PTHREAD_POOL_DELAY_LOAD==1 (or no preloaded pool in use): do not wait up for the Workers to
      // instantiate the Wasm module, but proceed with main() immediately.
      removeRunDependency('wasm-instantiate');
    }
  }
  // we can't run yet (except in a pthread, where we have a custom sync instantiator)
  if (!ENVIRONMENT_IS_PTHREAD) { addRunDependency('wasm-instantiate'); }

  // Prefer streaming instantiation if available.
  // Async compilation can be confusing when an error on the page overwrites Module
  // (for example, if the order of elements is wrong, and the one defining Module is
  // later), so we save Module and check it later.
  var trueModule = Module;
  function receiveInstantiationResult(result) {
    // 'result' is a ResultObject object which has both the module and instance.
    // receiveInstance() will swap in the exports (to Module.asm) so they can be called
    assert(Module === trueModule, 'the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?');
    trueModule = null;
    receiveInstance(result['instance'], result['module']);
  }

  function instantiateArrayBuffer(receiver) {
    return getBinaryPromise().then(function(binary) {
      return WebAssembly.instantiate(binary, info);
    }).then(function (instance) {
      return instance;
    }).then(receiver, function(reason) {
      err('failed to asynchronously prepare wasm: ' + reason);

      // Warn on some common problems.
      if (isFileURI(wasmBinaryFile)) {
        err('warning: Loading from a file URI (' + wasmBinaryFile + ') is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing');
      }
      abort(reason);
    });
  }

  function instantiateAsync() {
    if (!wasmBinary &&
        typeof WebAssembly.instantiateStreaming === 'function' &&
        !isDataURI(wasmBinaryFile) &&
        // Don't use streaming for file:// delivered objects in a webview, fetch them synchronously.
        !isFileURI(wasmBinaryFile) &&
        typeof fetch === 'function') {
      return fetch(wasmBinaryFile, { credentials: 'same-origin' }).then(function (response) {
        var result = WebAssembly.instantiateStreaming(response, info);

        return result.then(
          receiveInstantiationResult,
          function(reason) {
            // We expect the most common failure cause to be a bad MIME type for the binary,
            // in which case falling back to ArrayBuffer instantiation should work.
            err('wasm streaming compile failed: ' + reason);
            err('falling back to ArrayBuffer instantiation');
            return instantiateArrayBuffer(receiveInstantiationResult);
          });
      });
    } else {
      return instantiateArrayBuffer(receiveInstantiationResult);
    }
  }

  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
  // to manually instantiate the Wasm module themselves. This allows pages to run the instantiation parallel
  // to any other async startup actions they are performing.
  if (Module['instantiateWasm']) {
    try {
      var exports = Module['instantiateWasm'](info, receiveInstance);
      return exports;
    } catch(e) {
      err('Module.instantiateWasm callback failed with error: ' + e);
      return false;
    }
  }

  instantiateAsync();
  return {}; // no exports yet; we'll fill them in later
}

// Globals used by JS i64 conversions (see makeSetValue)
var tempDouble;
var tempI64;

// === Body ===

var ASM_CONSTS = {
  
};
function initPthreadsJS(tb){ PThread.initRuntime(tb); }





  function callRuntimeCallbacks(callbacks) {
      while (callbacks.length > 0) {
        var callback = callbacks.shift();
        if (typeof callback == 'function') {
          callback(Module); // Pass the module as the first argument.
          continue;
        }
        var func = callback.func;
        if (typeof func === 'number') {
          if (callback.arg === undefined) {
            wasmTable.get(func)();
          } else {
            wasmTable.get(func)(callback.arg);
          }
        } else {
          func(callback.arg === undefined ? null : callback.arg);
        }
      }
    }

  function demangle(func) {
      warnOnce('warning: build with  -s DEMANGLE_SUPPORT=1  to link in libcxxabi demangling');
      return func;
    }

  function demangleAll(text) {
      var regex =
        /\b_Z[\w\d_]+/g;
      return text.replace(regex,
        function(x) {
          var y = demangle(x);
          return x === y ? x : (y + ' [' + x + ']');
        });
    }

  function _emscripten_futex_wake(addr, count) {
      if (addr <= 0 || addr > HEAP8.length || addr&3 != 0 || count < 0) return -28;
      if (count == 0) return 0;
      // Waking (at least) INT_MAX waiters is defined to mean wake all callers.
      // For Atomics.notify() API Infinity is to be passed in that case.
      if (count >= 2147483647) count = Infinity;
  
      // See if main thread is waiting on this address? If so, wake it up by resetting its wake location to zero.
      // Note that this is not a fair procedure, since we always wake main thread first before any workers, so
      // this scheme does not adhere to real queue-based waiting.
      assert(__emscripten_main_thread_futex > 0);
      var mainThreadWaitAddress = Atomics.load(HEAP32, __emscripten_main_thread_futex >> 2);
      var mainThreadWoken = 0;
      if (mainThreadWaitAddress == addr) {
        // We only use __emscripten_main_thread_futex on the main browser thread, where we
        // cannot block while we wait. Therefore we should only see it set from
        // other threads, and not on the main thread itself. In other words, the
        // main thread must never try to wake itself up!
        assert(!ENVIRONMENT_IS_WEB);
        var loadedAddr = Atomics.compareExchange(HEAP32, __emscripten_main_thread_futex >> 2, mainThreadWaitAddress, 0);
        if (loadedAddr == mainThreadWaitAddress) {
          --count;
          mainThreadWoken = 1;
          if (count <= 0) return 1;
        }
      }
  
      // Wake any workers waiting on this address.
      var ret = Atomics.notify(HEAP32, addr >> 2, count);
      if (ret >= 0) return ret + mainThreadWoken;
      throw 'Atomics.notify returned an unexpected value ' + ret;
    }
  Module["_emscripten_futex_wake"] = _emscripten_futex_wake;
  
  function killThread(pthread_ptr) {
      if (ENVIRONMENT_IS_PTHREAD) throw 'Internal Error! killThread() can only ever be called from main application thread!';
      if (!pthread_ptr) throw 'Internal Error! Null pthread_ptr in killThread!';
      HEAP32[(((pthread_ptr)+(8))>>2)] = 0;
      var pthread = PThread.pthreads[pthread_ptr];
      delete PThread.pthreads[pthread_ptr];
      pthread.worker.terminate();
      PThread.freeThreadData(pthread);
      // The worker was completely nuked (not just the pthread execution it was hosting), so remove it from running workers
      // but don't put it back to the pool.
      PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(pthread.worker), 1); // Not a running Worker anymore.
      pthread.worker.pthread = undefined;
    }
  
  function cancelThread(pthread_ptr) {
      if (ENVIRONMENT_IS_PTHREAD) throw 'Internal Error! cancelThread() can only ever be called from main application thread!';
      if (!pthread_ptr) throw 'Internal Error! Null pthread_ptr in cancelThread!';
      var pthread = PThread.pthreads[pthread_ptr];
      pthread.worker.postMessage({ 'cmd': 'cancel' });
    }
  
  function cleanupThread(pthread_ptr) {
      if (ENVIRONMENT_IS_PTHREAD) throw 'Internal Error! cleanupThread() can only ever be called from main application thread!';
      if (!pthread_ptr) throw 'Internal Error! Null pthread_ptr in cleanupThread!';
      var pthread = PThread.pthreads[pthread_ptr];
      // If pthread has been removed from this map this also means that pthread_ptr points
      // to already freed data. Such situation may occur in following circumstances:
      // 1. Joining cancelled thread - in such situation it may happen that pthread data will
      //    already be removed by handling 'cancelDone' message.
      // 2. Joining thread from non-main browser thread (this also includes thread running main()
      //    when compiled with `PROXY_TO_PTHREAD`) - in such situation it may happen that following
      //    code flow occur (MB - Main Browser Thread, S1, S2 - Worker Threads):
      //    S2: thread ends, 'exit' message is sent to MB
      //    S1: calls pthread_join(S2), this causes:
      //        a. S2 is marked as detached,
      //        b. 'cleanupThread' message is sent to MB.
      //    MB: handles 'exit' message, as thread is detached, so returnWorkerToPool()
      //        is called and all thread related structs are freed/released.
      //    MB: handles 'cleanupThread' message which calls this function.
      if (pthread) {
        HEAP32[(((pthread_ptr)+(8))>>2)] = 0;
        var worker = pthread.worker;
        PThread.returnWorkerToPool(worker);
      }
    }
  
  function handleException(e) {
      // Certain exception types we do not treat as errors since they are used for
      // internal control flow.
      // 1. ExitStatus, which is thrown by exit()
      // 2. "unwind", which is thrown by emscripten_unwind_to_js_event_loop() and others
      //    that wish to return to JS event loop.
      if (e instanceof ExitStatus || e == 'unwind') {
        return EXITSTATUS;
      }
      // Anything else is an unexpected exception and we treat it as hard error.
      var toLog = e;
      if (e && typeof e === 'object' && e.stack) {
        toLog = [e, e.stack];
      }
      err('exception thrown: ' + toLog);
      quit_(1, e);
    }
  var PThread = {unusedWorkers:[],runningWorkers:[],tlsInitFunctions:[],initMainThreadBlock:function() {
        assert(!ENVIRONMENT_IS_PTHREAD);
  
      },initRuntime:function(tb) {
  
        // Pass the thread address to the native code where they stored in wasm
        // globals which act as a form of TLS. Global constructors trying
        // to access this value will read the wrong value, but that is UB anyway.
        __emscripten_thread_init(tb, /*isMainBrowserThread=*/!ENVIRONMENT_IS_WORKER, /*isMainRuntimeThread=*/1);
        PThread.mainRuntimeThread = true;
      },initWorker:function() {
      },pthreads:{},threadExitHandlers:[],setExitStatus:function(status) {
        EXITSTATUS = status;
      },terminateAllThreads:function() {
        for (var t in PThread.pthreads) {
          var pthread = PThread.pthreads[t];
          if (pthread && pthread.worker) {
            PThread.returnWorkerToPool(pthread.worker);
          }
        }
        PThread.pthreads = {};
  
        for (var i = 0; i < PThread.unusedWorkers.length; ++i) {
          var worker = PThread.unusedWorkers[i];
          assert(!worker.pthread); // This Worker should not be hosting a pthread at this time.
          worker.terminate();
        }
        PThread.unusedWorkers = [];
  
        for (var i = 0; i < PThread.runningWorkers.length; ++i) {
          var worker = PThread.runningWorkers[i];
          var pthread = worker.pthread;
          assert(pthread, 'This Worker should have a pthread it is executing');
          worker.terminate();
          PThread.freeThreadData(pthread);
        }
        PThread.runningWorkers = [];
      },freeThreadData:function(pthread) {
        if (!pthread) return;
        if (pthread.threadInfoStruct) {
          _free(pthread.threadInfoStruct);
        }
        pthread.threadInfoStruct = 0;
        if (pthread.allocatedOwnStack && pthread.stackBase) _free(pthread.stackBase);
        pthread.stackBase = 0;
        if (pthread.worker) pthread.worker.pthread = null;
      },returnWorkerToPool:function(worker) {
        // We don't want to run main thread queued calls here, since we are doing
        // some operations that leave the worker queue in an invalid state until
        // we are completely done (it would be bad if free() ends up calling a
        // queued pthread_create which looks at the global data structures we are
        // modifying).
        PThread.runWithoutMainThreadQueuedCalls(function() {
          delete PThread.pthreads[worker.pthread.threadInfoStruct];
          //Note: worker is intentionally not terminated so the pool can dynamically grow.
          PThread.unusedWorkers.push(worker);
          PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker), 1); // Not a running Worker anymore
          PThread.freeThreadData(worker.pthread);
          // Detach the worker from the pthread object, and return it to the worker pool as an unused worker.
          worker.pthread = undefined;
        });
      },runWithoutMainThreadQueuedCalls:function(func) {
        assert(PThread.mainRuntimeThread, 'runWithoutMainThreadQueuedCalls must be done on the main runtime thread');
        assert(__emscripten_allow_main_runtime_queued_calls);
        HEAP32[__emscripten_allow_main_runtime_queued_calls >> 2] = 0;
        try {
          func();
        } finally {
          HEAP32[__emscripten_allow_main_runtime_queued_calls >> 2] = 1;
        }
      },receiveObjectTransfer:function(data) {
      },threadInit:function() {
        // Call thread init functions (these are the emscripten_tls_init for each
        // module loaded.
        for (var i in PThread.tlsInitFunctions) {
          PThread.tlsInitFunctions[i]();
        }
      },loadWasmModuleToWorker:function(worker, onFinishedLoading) {
        worker.onmessage = function(e) {
          var d = e['data'];
          var cmd = d['cmd'];
          // Sometimes we need to backproxy events to the calling thread (e.g.
          // HTML5 DOM events handlers such as
          // emscripten_set_mousemove_callback()), so keep track in a globally
          // accessible variable about the thread that initiated the proxying.
          if (worker.pthread) PThread.currentProxiedOperationCallerThread = worker.pthread.threadInfoStruct;
  
          // If this message is intended to a recipient that is not the main thread, forward it to the target thread.
          if (d['targetThread'] && d['targetThread'] != _pthread_self()) {
            var thread = PThread.pthreads[d.targetThread];
            if (thread) {
              thread.worker.postMessage(e.data, d['transferList']);
            } else {
              err('Internal error! Worker sent a message "' + cmd + '" to target pthread ' + d['targetThread'] + ', but that thread no longer exists!');
            }
            PThread.currentProxiedOperationCallerThread = undefined;
            return;
          }
  
          if (cmd === 'processQueuedMainThreadWork') {
            // TODO: Must post message to main Emscripten thread in PROXY_TO_WORKER mode.
            _emscripten_main_thread_process_queued_calls();
          } else if (cmd === 'spawnThread') {
            spawnThread(e.data);
          } else if (cmd === 'cleanupThread') {
            cleanupThread(d['thread']);
          } else if (cmd === 'killThread') {
            killThread(d['thread']);
          } else if (cmd === 'cancelThread') {
            cancelThread(d['thread']);
          } else if (cmd === 'loaded') {
            worker.loaded = true;
            if (onFinishedLoading) onFinishedLoading(worker);
            // If this Worker is already pending to start running a thread, launch the thread now
            if (worker.runPthread) {
              worker.runPthread();
              delete worker.runPthread;
            }
          } else if (cmd === 'print') {
            out('Thread ' + d['threadId'] + ': ' + d['text']);
          } else if (cmd === 'printErr') {
            err('Thread ' + d['threadId'] + ': ' + d['text']);
          } else if (cmd === 'alert') {
            alert('Thread ' + d['threadId'] + ': ' + d['text']);
          } else if (cmd === 'exit') {
            var detached = worker.pthread && Atomics.load(HEAPU32, (worker.pthread.threadInfoStruct + 60) >> 2);
            if (detached) {
              PThread.returnWorkerToPool(worker);
            }
          } else if (cmd === 'exitProcess') {
            // A pthread has requested to exit the whole application process (runtime).
            err("exitProcess requested by worker");
            try {
              exit(d['returnCode']);
            } catch (e) {
              handleException(e);
            }
          } else if (cmd === 'cancelDone') {
            PThread.returnWorkerToPool(worker);
          } else if (e.data.target === 'setimmediate') {
            worker.postMessage(e.data); // Worker wants to postMessage() to itself to implement setImmediate() emulation.
          } else if (cmd === 'onAbort') {
            if (Module['onAbort']) {
              Module['onAbort'](d['arg']);
            }
          } else {
            err("worker sent an unknown command " + cmd);
          }
          PThread.currentProxiedOperationCallerThread = undefined;
        };
  
        worker.onerror = function(e) {
          err('pthread sent an error! ' + e.filename + ':' + e.lineno + ': ' + e.message);
          throw e;
        };
  
        if (ENVIRONMENT_IS_NODE) {
          worker.on('message', function(data) {
            worker.onmessage({ data: data });
          });
          worker.on('error', function(e) {
            worker.onerror(e);
          });
          worker.on('exit', function() {
            // TODO: update the worker queue?
            // See: https://github.com/emscripten-core/emscripten/issues/9763
          });
        }
  
        assert(wasmMemory instanceof WebAssembly.Memory, 'WebAssembly memory should have been loaded by now!');
        assert(wasmModule instanceof WebAssembly.Module, 'WebAssembly Module should have been loaded by now!');
  
        // Ask the new worker to load up the Emscripten-compiled page. This is a heavy operation.
        worker.postMessage({
          'cmd': 'load',
          // If the application main .js file was loaded from a Blob, then it is not possible
          // to access the URL of the current script that could be passed to a Web Worker so that
          // it could load up the same file. In that case, developer must either deliver the Blob
          // object in Module['mainScriptUrlOrBlob'], or a URL to it, so that pthread Workers can
          // independently load up the same main application file.
          'urlOrBlob': Module['mainScriptUrlOrBlob']
          || _scriptDir
          ,
          'wasmMemory': wasmMemory,
          'wasmModule': wasmModule,
        });
      },allocateUnusedWorker:function() {
        // Allow HTML module to configure the location where the 'worker.js' file will be loaded from,
        // via Module.locateFile() function. If not specified, then the default URL 'worker.js' relative
        // to the main html file is loaded.
        var pthreadMainJs = locateFile('free-queue.asm.worker.js');
        PThread.unusedWorkers.push(new Worker(pthreadMainJs));
      },getNewWorker:function() {
        if (PThread.unusedWorkers.length == 0) {
          err('Tried to spawn a new thread, but the thread pool is exhausted.\n' +
          'This might result in a deadlock unless some threads eventually exit or the code explicitly breaks out to the event loop.\n' +
          'If you want to increase the pool size, use setting `-s PTHREAD_POOL_SIZE=...`.'
          + '\nIf you want to throw an explicit error instead of the risk of deadlocking in those cases, use setting `-s PTHREAD_POOL_SIZE_STRICT=2`.'
          );
  
          PThread.allocateUnusedWorker();
          PThread.loadWasmModuleToWorker(PThread.unusedWorkers[0]);
        }
        return PThread.unusedWorkers.pop();
      }};
  function establishStackSpace(stackTop, stackMax) {
      // Set stack limits used by `emscripten/stack.h` function.  These limits are
      // cached in wasm-side globals to make checks as fast as possible.
      _emscripten_stack_set_limits(stackTop, stackMax);
  
      // Call inside wasm module to set up the stack frame for this pthread in wasm module scope
      stackRestore(stackTop);
  
      // Write the stack cookie last, after we have set up the proper bounds and
      // current position of the stack.
      writeStackCookie();
    }
  Module["establishStackSpace"] = establishStackSpace;


  function invokeEntryPoint(ptr, arg) {
      return wasmTable.get(ptr)(arg);
    }
  Module["invokeEntryPoint"] = invokeEntryPoint;

  function jsStackTrace() {
      var error = new Error();
      if (!error.stack) {
        // IE10+ special cases: It does have callstack info, but it is only populated if an Error object is thrown,
        // so try that as a special-case.
        try {
          throw new Error();
        } catch(e) {
          error = e;
        }
        if (!error.stack) {
          return '(no stack trace available)';
        }
      }
      return error.stack.toString();
    }

  function stackTrace() {
      var js = jsStackTrace();
      if (Module['extraStackTrace']) js += '\n' + Module['extraStackTrace']();
      return demangleAll(js);
    }

  function ___assert_fail(condition, filename, line, func) {
      abort('Assertion failed: ' + UTF8ToString(condition) + ', at: ' + [filename ? UTF8ToString(filename) : 'unknown filename', line, func ? UTF8ToString(func) : 'unknown function']);
    }

  var _emscripten_get_now;if (ENVIRONMENT_IS_NODE) {
    _emscripten_get_now = function() {
      var t = process['hrtime']();
      return t[0] * 1e3 + t[1] / 1e6;
    };
  } else if (ENVIRONMENT_IS_PTHREAD) {
    _emscripten_get_now = function() { return performance.now() - Module['__performance_now_clock_drift']; };
  } else _emscripten_get_now = function() { return performance.now(); }
  ;
  
  var _emscripten_get_now_is_monotonic = true;;
  
  function setErrNo(value) {
      HEAP32[((___errno_location())>>2)] = value;
      return value;
    }
  function _clock_gettime(clk_id, tp) {
      // int clock_gettime(clockid_t clk_id, struct timespec *tp);
      var now;
      if (clk_id === 0) {
        now = Date.now();
      } else if ((clk_id === 1 || clk_id === 4) && _emscripten_get_now_is_monotonic) {
        now = _emscripten_get_now();
      } else {
        setErrNo(28);
        return -1;
      }
      HEAP32[((tp)>>2)] = (now/1000)|0; // seconds
      HEAP32[(((tp)+(4))>>2)] = ((now % 1000)*1000*1000)|0; // nanoseconds
      return 0;
    }
  function ___clock_gettime(a0,a1
  ) {
  return _clock_gettime(a0,a1);
  }

  function ___cxa_thread_atexit(routine, arg) {
      PThread.threadExitHandlers.push(function() { wasmTable.get(routine)(arg) });
    }

  function spawnThread(threadParams) {
      if (ENVIRONMENT_IS_PTHREAD) throw 'Internal Error! spawnThread() can only ever be called from main application thread!';
  
      var worker = PThread.getNewWorker();
  
      if (!worker) {
        // No available workers in the PThread pool.
        return 6;
      }
      if (worker.pthread !== undefined) throw 'Internal error!';
      if (!threadParams.pthread_ptr) throw 'Internal error, no pthread ptr!';
      PThread.runningWorkers.push(worker);
  
      var stackHigh = threadParams.stackBase + threadParams.stackSize;
  
      // Create a pthread info object to represent this thread.
      var pthread = PThread.pthreads[threadParams.pthread_ptr] = {
        worker: worker,
        stackBase: threadParams.stackBase,
        stackSize: threadParams.stackSize,
        allocatedOwnStack: threadParams.allocatedOwnStack,
        // Info area for this thread in Emscripten HEAP (shared)
        threadInfoStruct: threadParams.pthread_ptr
      };
      var tis = pthread.threadInfoStruct >> 2;
      // spawnThread is always called with a zero-initialized thread struct so
      // no need to set any valudes to zero here.
      Atomics.store(HEAPU32, tis + (60 >> 2), threadParams.detached);
      Atomics.store(HEAPU32, tis + (76 >> 2), threadParams.stackSize);
      Atomics.store(HEAPU32, tis + (72 >> 2), stackHigh);
      Atomics.store(HEAPU32, tis + (100 >> 2), threadParams.stackSize);
      Atomics.store(HEAPU32, tis + (100 + 8 >> 2), stackHigh);
      Atomics.store(HEAPU32, tis + (100 + 12 >> 2), threadParams.detached);
  
      worker.pthread = pthread;
      var msg = {
          'cmd': 'run',
          'start_routine': threadParams.startRoutine,
          'arg': threadParams.arg,
          'threadInfoStruct': threadParams.pthread_ptr,
          'stackBase': threadParams.stackBase,
          'stackSize': threadParams.stackSize
      };
      worker.runPthread = function() {
        // Ask the worker to start executing its pthread entry point function.
        msg.time = performance.now();
        worker.postMessage(msg, threadParams.transferList);
      };
      if (worker.loaded) {
        worker.runPthread();
        delete worker.runPthread;
      }
      return 0;
    }
  function ___pthread_create_js(pthread_ptr, attr, start_routine, arg) {
      if (typeof SharedArrayBuffer === 'undefined') {
        err('Current environment does not support SharedArrayBuffer, pthreads are not available!');
        return 6;
      }
  
      // List of JS objects that will transfer ownership to the Worker hosting the thread
      var transferList = [];
      var error = 0;
  
      // Synchronously proxy the thread creation to main thread if possible. If we
      // need to transfer ownership of objects, then proxy asynchronously via
      // postMessage.
      if (ENVIRONMENT_IS_PTHREAD && (transferList.length === 0 || error)) {
        return _emscripten_sync_run_in_main_thread_4(687865856, pthread_ptr, attr, start_routine, arg);
      }
  
      // If on the main thread, and accessing Canvas/OffscreenCanvas failed, abort
      // with the detected error.
      if (error) return error;
  
      var stackSize = 0;
      var stackBase = 0;
      // Default thread attr is PTHREAD_CREATE_JOINABLE, i.e. start as not detached.
      var detached = 0;
      // When musl creates C11 threads it passes __ATTRP_C11_THREAD (-1) which
      // treat as if it was NULL.
      if (attr && attr != -1) {
        stackSize = HEAP32[((attr)>>2)];
        // Musl has a convention that the stack size that is stored to the pthread
        // attribute structure is always musl's #define DEFAULT_STACK_SIZE
        // smaller than the actual created stack size. That is, stored stack size
        // of 0 would mean a stack of DEFAULT_STACK_SIZE in size. All musl
        // functions hide this impl detail, and offset the size transparently, so
        // pthread_*() API user does not see this offset when operating with
        // the pthread API. When reading the structure directly on JS side
        // however, we need to offset the size manually here.
        stackSize += 81920 /*DEFAULT_STACK_SIZE*/;
        stackBase = HEAP32[(((attr)+(8))>>2)];
        detached = HEAP32[(((attr)+(12))>>2)] !== 0/*PTHREAD_CREATE_JOINABLE*/;
      } else {
        // According to
        // http://man7.org/linux/man-pages/man3/pthread_create.3.html, default
        // stack size if not specified is 2 MB, so follow that convention.
        stackSize = 2097152;
      }
      // If allocatedOwnStack == true, then the pthread impl maintains the stack allocation.
      var allocatedOwnStack = stackBase == 0;
      if (allocatedOwnStack) {
        // Allocate a stack if the user doesn't want to place the stack in a
        // custom memory area.
        stackBase = _memalign(16, stackSize);
      } else {
        // Musl stores the stack base address assuming stack grows downwards, so
        // adjust it to Emscripten convention that the
        // stack grows upwards instead.
        stackBase -= stackSize;
        assert(stackBase > 0);
      }
  
      var threadParams = {
        stackBase: stackBase,
        stackSize: stackSize,
        allocatedOwnStack: allocatedOwnStack,
        detached: detached,
        startRoutine: start_routine,
        pthread_ptr: pthread_ptr,
        arg: arg,
        transferList: transferList
      };
  
      if (ENVIRONMENT_IS_PTHREAD) {
        // The prepopulated pool of web workers that can host pthreads is stored
        // in the main JS thread. Therefore if a pthread is attempting to spawn a
        // new thread, the thread creation must be deferred to the main JS thread.
        threadParams.cmd = 'spawnThread';
        postMessage(threadParams, transferList);
        // When we defer thread creation this way, we have no way to detect thread
        // creation synchronously today, so we have to assume success and return 0.
        return 0;
      }
  
      // We are the main thread, so we have the pthread warmup pool in this
      // thread and can fire off JS thread creation directly ourselves.
      return spawnThread(threadParams);
    }

  function ___pthread_exit_done() {
      // Called at the end of pthread_exit, either when called explicitly called
      // by programmer, or implicitly when leaving the thread main function.
      //
      // Note: in theory we would like to return any offscreen canvases back to the main thread,
      // but if we ever fetched a rendering context for them that would not be valid, so we don't try.
      postMessage({ 'cmd': 'exit' });
    }

  function _exit(status) {
      // void _exit(int status);
      // http://pubs.opengroup.org/onlinepubs/000095399/functions/exit.html
      exit(status);
    }
  function ___pthread_exit_run_handlers(status) {
      // Called from pthread_exit, either when called explicitly called
      // by programmer, or implicitly when leaving the thread main function.
  
      while (PThread.threadExitHandlers.length > 0) {
        PThread.threadExitHandlers.pop()();
      }
    }

  function _emscripten_futex_wait(addr, val, timeout) {
      if (addr <= 0 || addr > HEAP8.length || addr&3 != 0) return -28;
      // We can do a normal blocking wait anywhere but on the main browser thread.
      if (!ENVIRONMENT_IS_WEB) {
        var ret = Atomics.wait(HEAP32, addr >> 2, val, timeout);
        if (ret === 'timed-out') return -73;
        if (ret === 'not-equal') return -6;
        if (ret === 'ok') return 0;
        throw 'Atomics.wait returned an unexpected value ' + ret;
      } else {
        // First, check if the value is correct for us to wait on.
        if (Atomics.load(HEAP32, addr >> 2) != val) {
          return -6;
        }
  
        // Atomics.wait is not available in the main browser thread, so simulate it via busy spinning.
        var tNow = performance.now();
        var tEnd = tNow + timeout;
  
        // Register globally which address the main thread is simulating to be
        // waiting on. When zero, the main thread is not waiting on anything, and on
        // nonzero, the contents of the address pointed by __emscripten_main_thread_futex
        // tell which address the main thread is simulating its wait on.
        // We need to be careful of recursion here: If we wait on a futex, and
        // then call _emscripten_main_thread_process_queued_calls() below, that
        // will call code that takes the proxying mutex - which can once more
        // reach this code in a nested call. To avoid interference between the
        // two (there is just a single __emscripten_main_thread_futex at a time), unmark
        // ourselves before calling the potentially-recursive call. See below for
        // how we handle the case of our futex being notified during the time in
        // between when we are not set as the value of __emscripten_main_thread_futex.
        assert(__emscripten_main_thread_futex > 0);
        var lastAddr = Atomics.exchange(HEAP32, __emscripten_main_thread_futex >> 2, addr);
        // We must not have already been waiting.
        assert(lastAddr == 0);
  
        while (1) {
          // Check for a timeout.
          tNow = performance.now();
          if (tNow > tEnd) {
            // We timed out, so stop marking ourselves as waiting.
            lastAddr = Atomics.exchange(HEAP32, __emscripten_main_thread_futex >> 2, 0);
            // The current value must have been our address which we set, or
            // in a race it was set to 0 which means another thread just allowed
            // us to run, but (tragically) that happened just a bit too late.
            assert(lastAddr == addr || lastAddr == 0);
            return -73;
          }
          // We are performing a blocking loop here, so we must handle proxied
          // events from pthreads, to avoid deadlocks.
          // Note that we have to do so carefully, as we may take a lock while
          // doing so, which can recurse into this function; stop marking
          // ourselves as waiting while we do so.
          lastAddr = Atomics.exchange(HEAP32, __emscripten_main_thread_futex >> 2, 0);
          assert(lastAddr == addr || lastAddr == 0);
          if (lastAddr == 0) {
            // We were told to stop waiting, so stop.
            break;
          }
          _emscripten_main_thread_process_queued_calls();
  
          // Check the value, as if we were starting the futex all over again.
          // This handles the following case:
          //
          //  * wait on futex A
          //  * recurse into emscripten_main_thread_process_queued_calls(),
          //    which waits on futex B. that sets the __emscripten_main_thread_futex address to
          //    futex B, and there is no longer any mention of futex A.
          //  * a worker is done with futex A. it checks __emscripten_main_thread_futex but does
          //    not see A, so it does nothing special for the main thread.
          //  * a worker is done with futex B. it flips mainThreadMutex from B
          //    to 0, ending the wait on futex B.
          //  * we return to the wait on futex A. __emscripten_main_thread_futex is 0, but that
          //    is because of futex B being done - we can't tell from
          //    __emscripten_main_thread_futex whether A is done or not. therefore, check the
          //    memory value of the futex.
          //
          // That case motivates the design here. Given that, checking the memory
          // address is also necessary for other reasons: we unset and re-set our
          // address in __emscripten_main_thread_futex around calls to
          // emscripten_main_thread_process_queued_calls(), and a worker could
          // attempt to wake us up right before/after such times.
          //
          // Note that checking the memory value of the futex is valid to do: we
          // could easily have been delayed (relative to the worker holding on
          // to futex A), which means we could be starting all of our work at the
          // later time when there is no need to block. The only "odd" thing is
          // that we may have caused side effects in that "delay" time. But the
          // only side effects we can have are to call
          // emscripten_main_thread_process_queued_calls(). That is always ok to
          // do on the main thread (it's why it is ok for us to call it in the
          // middle of this function, and elsewhere). So if we check the value
          // here and return, it's the same is if what happened on the main thread
          // was the same as calling emscripten_main_thread_process_queued_calls()
          // a few times times before calling emscripten_futex_wait().
          if (Atomics.load(HEAP32, addr >> 2) != val) {
            return -6;
          }
  
          // Mark us as waiting once more, and continue the loop.
          lastAddr = Atomics.exchange(HEAP32, __emscripten_main_thread_futex >> 2, addr);
          assert(lastAddr == 0);
        }
        return 0;
      }
    }
  
  function _emscripten_check_blocking_allowed() {
      if (ENVIRONMENT_IS_NODE) return;
  
      if (ENVIRONMENT_IS_WORKER) return; // Blocking in a worker/pthread is fine.
  
      warnOnce('Blocking on the main thread is very dangerous, see https://emscripten.org/docs/porting/pthreads.html#blocking-on-the-main-browser-thread');
  
    }
  function __emscripten_do_pthread_join(thread, status, block) {
      if (!thread) {
        err('pthread_join attempted on a null thread pointer!');
        return 71;
      }
      if (ENVIRONMENT_IS_PTHREAD && _pthread_self() == thread) {
        err('PThread ' + thread + ' is attempting to join to itself!');
        return 16;
      }
      else if (!ENVIRONMENT_IS_PTHREAD && _emscripten_main_browser_thread_id() == thread) {
        err('Main thread ' + thread + ' is attempting to join to itself!');
        return 16;
      }
      var self = HEAP32[(((thread)+(8))>>2)];
      if (self !== thread) {
        err('pthread_join attempted on thread ' + thread + ', which does not point to a valid thread, or does not exist anymore!');
        return 71;
      }
  
      var detached = Atomics.load(HEAPU32, (thread + 60 ) >> 2);
      if (detached) {
        err('Attempted to join thread ' + thread + ', which was already detached!');
        return 28; // The thread is already detached, can no longer join it!
      }
  
      if (block) {
        _emscripten_check_blocking_allowed();
      }
  
      for (;;) {
        var threadStatus = Atomics.load(HEAPU32, (thread + 0 ) >> 2);
        if (threadStatus == 1) { // Exited?
          if (status) {
            var result = Atomics.load(HEAPU32, (thread + 88 ) >> 2);
            HEAP32[((status)>>2)] = result;
          }
          // Mark the thread as detached.
          Atomics.store(HEAPU32, (thread + 60 ) >> 2, 1);
          if (!ENVIRONMENT_IS_PTHREAD) cleanupThread(thread);
          else postMessage({ 'cmd': 'cleanupThread', 'thread': thread });
          return 0;
        }
        if (!block) {
          return 10;
        }
        _pthread_testcancel();
        // In main runtime thread (the thread that initialized the Emscripten C
        // runtime and launched main()), assist pthreads in performing operations
        // that they need to access the Emscripten main runtime for.
        if (!ENVIRONMENT_IS_PTHREAD) _emscripten_main_thread_process_queued_calls();
        _emscripten_futex_wait(thread + 0, threadStatus, ENVIRONMENT_IS_PTHREAD ? 100 : 1);
      }
    }
  function ___pthread_join_js(thread, status) {
      return __emscripten_do_pthread_join(thread, status, true);
    }

  function __emscripten_notify_thread_queue(targetThreadId, mainThreadId) {
      if (targetThreadId == mainThreadId) {
        postMessage({'cmd' : 'processQueuedMainThreadWork'});
      } else if (ENVIRONMENT_IS_PTHREAD) {
        postMessage({'targetThread': targetThreadId, 'cmd': 'processThreadQueue'});
      } else {
        var pthread = PThread.pthreads[targetThreadId];
        var worker = pthread && pthread.worker;
        if (!worker) {
          err('Cannot send message to thread with ID ' + targetThreadId + ', unknown thread ID!');
          return /*0*/;
        }
        worker.postMessage({'cmd' : 'processThreadQueue'});
      }
      return 1;
    }

  function _emscripten_conditional_set_current_thread_status_js(expectedStatus, newStatus) {
    }
  function _emscripten_conditional_set_current_thread_status(expectedStatus, newStatus) {
    }




  function _emscripten_memcpy_big(dest, src, num) {
      HEAPU8.copyWithin(dest, src, src + num);
    }

  /** @type{function(number, (number|boolean), ...(number|boolean))} */
  function _emscripten_proxy_to_main_thread_js(index, sync) {
      // Additional arguments are passed after those two, which are the actual
      // function arguments.
      // The serialization buffer contains the number of call params, and then
      // all the args here.
      // We also pass 'sync' to C separately, since C needs to look at it.
      var numCallArgs = arguments.length - 2;
      if (numCallArgs > 20-1) throw 'emscripten_proxy_to_main_thread_js: Too many arguments ' + numCallArgs + ' to proxied function idx=' + index + ', maximum supported is ' + (20-1) + '!';
      // Allocate a buffer, which will be copied by the C code.
      var stack = stackSave();
      // First passed parameter specifies the number of arguments to the function.
      // When BigInt support is enabled, we must handle types in a more complex
      // way, detecting at runtime if a value is a BigInt or not (as we have no
      // type info here). To do that, add a "prefix" before each value that
      // indicates if it is a BigInt, which effectively doubles the number of
      // values we serialize for proxying. TODO: pack this?
      var serializedNumCallArgs = numCallArgs ;
      var args = stackAlloc(serializedNumCallArgs * 8);
      var b = args >> 3;
      for (var i = 0; i < numCallArgs; i++) {
        var arg = arguments[2 + i];
        HEAPF64[b + i] = arg;
      }
      var ret = _emscripten_run_in_main_runtime_thread_js(index, serializedNumCallArgs, args, sync);
      stackRestore(stack);
      return ret;
    }
  
  var _emscripten_receive_on_main_thread_js_callArgs = [];
  function _emscripten_receive_on_main_thread_js(index, numCallArgs, args) {
      _emscripten_receive_on_main_thread_js_callArgs.length = numCallArgs;
      var b = args >> 3;
      for (var i = 0; i < numCallArgs; i++) {
        _emscripten_receive_on_main_thread_js_callArgs[i] = HEAPF64[b + i];
      }
      // Proxied JS library funcs are encoded as positive values, and
      // EM_ASMs as negative values (see include_asm_consts)
      var isEmAsmConst = index < 0;
      var func = !isEmAsmConst ? proxiedFunctionTable[index] : ASM_CONSTS[-index - 1];
      assert(func.length == numCallArgs, 'Call args mismatch in emscripten_receive_on_main_thread_js');
      return func.apply(null, _emscripten_receive_on_main_thread_js_callArgs);
    }

  function abortOnCannotGrowMemory(requestedSize) {
      abort('Cannot enlarge memory arrays to size ' + requestedSize + ' bytes (OOM). Either (1) compile with  -s INITIAL_MEMORY=X  with X higher than the current value ' + HEAP8.length + ', (2) compile with  -s ALLOW_MEMORY_GROWTH=1  which allows increasing the size at runtime, or (3) if you want malloc to return NULL (0) instead of this abort, compile with  -s ABORTING_MALLOC=0 ');
    }
  function _emscripten_resize_heap(requestedSize) {
      var oldSize = HEAPU8.length;
      requestedSize = requestedSize >>> 0;
      abortOnCannotGrowMemory(requestedSize);
    }

  var JSEvents = {inEventHandler:0,removeAllEventListeners:function() {
        for (var i = JSEvents.eventHandlers.length-1; i >= 0; --i) {
          JSEvents._removeHandler(i);
        }
        JSEvents.eventHandlers = [];
        JSEvents.deferredCalls = [];
      },registerRemoveEventListeners:function() {
        if (!JSEvents.removeEventListenersRegistered) {
          __ATEXIT__.push(JSEvents.removeAllEventListeners);
          JSEvents.removeEventListenersRegistered = true;
        }
      },deferredCalls:[],deferCall:function(targetFunction, precedence, argsList) {
        function arraysHaveEqualContent(arrA, arrB) {
          if (arrA.length != arrB.length) return false;
  
          for (var i in arrA) {
            if (arrA[i] != arrB[i]) return false;
          }
          return true;
        }
        // Test if the given call was already queued, and if so, don't add it again.
        for (var i in JSEvents.deferredCalls) {
          var call = JSEvents.deferredCalls[i];
          if (call.targetFunction == targetFunction && arraysHaveEqualContent(call.argsList, argsList)) {
            return;
          }
        }
        JSEvents.deferredCalls.push({
          targetFunction: targetFunction,
          precedence: precedence,
          argsList: argsList
        });
  
        JSEvents.deferredCalls.sort(function(x,y) { return x.precedence < y.precedence; });
      },removeDeferredCalls:function(targetFunction) {
        for (var i = 0; i < JSEvents.deferredCalls.length; ++i) {
          if (JSEvents.deferredCalls[i].targetFunction == targetFunction) {
            JSEvents.deferredCalls.splice(i, 1);
            --i;
          }
        }
      },canPerformEventHandlerRequests:function() {
        return JSEvents.inEventHandler && JSEvents.currentEventHandler.allowsDeferredCalls;
      },runDeferredCalls:function() {
        if (!JSEvents.canPerformEventHandlerRequests()) {
          return;
        }
        for (var i = 0; i < JSEvents.deferredCalls.length; ++i) {
          var call = JSEvents.deferredCalls[i];
          JSEvents.deferredCalls.splice(i, 1);
          --i;
          call.targetFunction.apply(null, call.argsList);
        }
      },eventHandlers:[],removeAllHandlersOnTarget:function(target, eventTypeString) {
        for (var i = 0; i < JSEvents.eventHandlers.length; ++i) {
          if (JSEvents.eventHandlers[i].target == target && 
            (!eventTypeString || eventTypeString == JSEvents.eventHandlers[i].eventTypeString)) {
             JSEvents._removeHandler(i--);
           }
        }
      },_removeHandler:function(i) {
        var h = JSEvents.eventHandlers[i];
        h.target.removeEventListener(h.eventTypeString, h.eventListenerFunc, h.useCapture);
        JSEvents.eventHandlers.splice(i, 1);
      },registerOrRemoveHandler:function(eventHandler) {
        var jsEventHandler = function jsEventHandler(event) {
          // Increment nesting count for the event handler.
          ++JSEvents.inEventHandler;
          JSEvents.currentEventHandler = eventHandler;
          // Process any old deferred calls the user has placed.
          JSEvents.runDeferredCalls();
          // Process the actual event, calls back to user C code handler.
          eventHandler.handlerFunc(event);
          // Process any new deferred calls that were placed right now from this event handler.
          JSEvents.runDeferredCalls();
          // Out of event handler - restore nesting count.
          --JSEvents.inEventHandler;
        };
        
        if (eventHandler.callbackfunc) {
          eventHandler.eventListenerFunc = jsEventHandler;
          eventHandler.target.addEventListener(eventHandler.eventTypeString, jsEventHandler, eventHandler.useCapture);
          JSEvents.eventHandlers.push(eventHandler);
          JSEvents.registerRemoveEventListeners();
        } else {
          for (var i = 0; i < JSEvents.eventHandlers.length; ++i) {
            if (JSEvents.eventHandlers[i].target == eventHandler.target
             && JSEvents.eventHandlers[i].eventTypeString == eventHandler.eventTypeString) {
               JSEvents._removeHandler(i--);
             }
          }
        }
      },queueEventHandlerOnThread_iiii:function(targetThread, eventHandlerFunc, eventTypeId, eventData, userData) {
        var stackTop = stackSave();
        var varargs = stackAlloc(12);
        HEAP32[((varargs)>>2)] = eventTypeId;
        HEAP32[(((varargs)+(4))>>2)] = eventData;
        HEAP32[(((varargs)+(8))>>2)] = userData;
        __emscripten_call_on_thread(0, targetThread, 637534208, eventHandlerFunc, eventData, varargs);
        stackRestore(stackTop);
      },getTargetThreadForEventCallback:function(targetThread) {
        switch (targetThread) {
          case 1: return 0; // The event callback for the current event should be called on the main browser thread. (0 == don't proxy)
          case 2: return PThread.currentProxiedOperationCallerThread; // The event callback for the current event should be backproxied to the thread that is registering the event.
          default: return targetThread; // The event callback for the current event should be proxied to the given specific thread.
        }
      },getNodeNameForTarget:function(target) {
        if (!target) return '';
        if (target == window) return '#window';
        if (target == screen) return '#screen';
        return (target && target.nodeName) ? target.nodeName : '';
      },fullscreenEnabled:function() {
        return document.fullscreenEnabled
        // Safari 13.0.3 on macOS Catalina 10.15.1 still ships with prefixed webkitFullscreenEnabled.
        // TODO: If Safari at some point ships with unprefixed version, update the version check above.
        || document.webkitFullscreenEnabled
         ;
      }};
  
  function stringToNewUTF8(jsString) {
      var length = lengthBytesUTF8(jsString)+1;
      var cString = _malloc(length);
      stringToUTF8(jsString, cString, length);
      return cString;
    }
  function _emscripten_set_offscreencanvas_size_on_target_thread_js(targetThread, targetCanvas, width, height) {
      var stackTop = stackSave();
      var varargs = stackAlloc(12);
      var targetCanvasPtr = 0;
      if (targetCanvas) {
        targetCanvasPtr = stringToNewUTF8(targetCanvas);
      }
      HEAP32[((varargs)>>2)] = targetCanvasPtr;
      HEAP32[(((varargs)+(4))>>2)] = width;
      HEAP32[(((varargs)+(8))>>2)] = height;
      // Note: If we are also a pthread, the call below could theoretically be done synchronously. However if the target pthread is waiting for a mutex from us, then
      // these two threads will deadlock. At the moment, we'd like to consider that this kind of deadlock would be an Emscripten runtime bug, although if
      // emscripten_set_canvas_element_size() was documented to require running an event in the queue of thread that owns the OffscreenCanvas, then that might be ok.
      // (safer this way however)
      __emscripten_call_on_thread(0, targetThread, 657457152, 0, targetCanvasPtr /* satellite data */, varargs);
      stackRestore(stackTop);
    }
  function _emscripten_set_offscreencanvas_size_on_target_thread(targetThread, targetCanvas, width, height) {
      targetCanvas = targetCanvas ? UTF8ToString(targetCanvas) : '';
      _emscripten_set_offscreencanvas_size_on_target_thread_js(targetThread, targetCanvas, width, height);
    }
  
  function maybeCStringToJsString(cString) {
      // "cString > 2" checks if the input is a number, and isn't of the special
      // values we accept here, EMSCRIPTEN_EVENT_TARGET_* (which map to 0, 1, 2).
      // In other words, if cString > 2 then it's a pointer to a valid place in
      // memory, and points to a C string.
      return cString > 2 ? UTF8ToString(cString) : cString;
    }
  
  var specialHTMLTargets = [0, typeof document !== 'undefined' ? document : 0, typeof window !== 'undefined' ? window : 0];
  function findEventTarget(target) {
      target = maybeCStringToJsString(target);
      var domElement = specialHTMLTargets[target] || (typeof document !== 'undefined' ? document.querySelector(target) : undefined);
      return domElement;
    }
  function findCanvasEventTarget(target) { return findEventTarget(target); }
  function _emscripten_set_canvas_element_size_calling_thread(target, width, height) {
      var canvas = findCanvasEventTarget(target);
      if (!canvas) return -4;
  
      if (canvas.canvasSharedPtr) {
        // N.B. We hold the canvasSharedPtr info structure as the authoritative source for specifying the size of a canvas
        // since the actual canvas size changes are asynchronous if the canvas is owned by an OffscreenCanvas on another thread.
        // Therefore when setting the size, eagerly set the size of the canvas on the calling thread here, though this thread
        // might not be the one that actually ends up specifying the size, but the actual size change may be dispatched
        // as an asynchronous event below.
        HEAP32[((canvas.canvasSharedPtr)>>2)] = width;
        HEAP32[(((canvas.canvasSharedPtr)+(4))>>2)] = height;
      }
  
      if (canvas.offscreenCanvas || !canvas.controlTransferredOffscreen) {
        if (canvas.offscreenCanvas) canvas = canvas.offscreenCanvas;
        var autoResizeViewport = false;
        if (canvas.GLctxObject && canvas.GLctxObject.GLctx) {
          var prevViewport = canvas.GLctxObject.GLctx.getParameter(0xBA2 /* GL_VIEWPORT */);
          // TODO: Perhaps autoResizeViewport should only be true if FBO 0 is currently active?
          autoResizeViewport = (prevViewport[0] === 0 && prevViewport[1] === 0 && prevViewport[2] === canvas.width && prevViewport[3] === canvas.height);
        }
        canvas.width = width;
        canvas.height = height;
        if (autoResizeViewport) {
          // TODO: Add -s CANVAS_RESIZE_SETS_GL_VIEWPORT=0/1 option (default=1). This is commonly done and several graphics engines depend on this,
          // but this can be quite disruptive.
          canvas.GLctxObject.GLctx.viewport(0, 0, width, height);
        }
      } else if (canvas.canvasSharedPtr) {
        var targetThread = HEAP32[(((canvas.canvasSharedPtr)+(8))>>2)];
        _emscripten_set_offscreencanvas_size_on_target_thread(targetThread, target, width, height);
        return 1; // This will have to be done asynchronously
      } else {
        return -4;
      }
      return 0;
    }
  
  
  function _emscripten_set_canvas_element_size_main_thread(target, width, height) {
    if (ENVIRONMENT_IS_PTHREAD)
      return _emscripten_proxy_to_main_thread_js(1, 1, target, width, height);
     return _emscripten_set_canvas_element_size_calling_thread(target, width, height); 
  }
  
  function _emscripten_set_canvas_element_size(target, width, height) {
      var canvas = findCanvasEventTarget(target);
      if (canvas) {
        return _emscripten_set_canvas_element_size_calling_thread(target, width, height);
      } else {
        return _emscripten_set_canvas_element_size_main_thread(target, width, height);
      }
    }

  function _emscripten_set_current_thread_status_js(newStatus) {
    }
  function _emscripten_set_current_thread_status(newStatus) {
    }

  function maybeExit() {
      if (!keepRuntimeAlive()) {
        try {
          if (ENVIRONMENT_IS_PTHREAD) __emscripten_thread_exit(EXITSTATUS);
          else
          _exit(EXITSTATUS);
        } catch (e) {
          handleException(e);
        }
      }
    }
  function callUserCallback(func, synchronous) {
      if (ABORT) {
        err('user callback triggered after application aborted.  Ignoring.');
        return;
      }
      // For synchronous calls, let any exceptions propagate, and don't let the runtime exit.
      if (synchronous) {
        func();
        return;
      }
      try {
        func();
        if (ENVIRONMENT_IS_PTHREAD)
          maybeExit();
      } catch (e) {
        handleException(e);
      }
    }
  
  function runtimeKeepalivePush() {
      runtimeKeepaliveCounter += 1;
    }
  
  function runtimeKeepalivePop() {
      assert(runtimeKeepaliveCounter > 0);
      runtimeKeepaliveCounter -= 1;
    }
  function _emscripten_set_timeout(cb, msecs, userData) {
      runtimeKeepalivePush();
      return setTimeout(function() {
        runtimeKeepalivePop();
        callUserCallback(function() {
          wasmTable.get(cb)(userData);
        });
      }, msecs);
    }

  function _emscripten_unwind_to_js_event_loop() {
      throw 'unwind';
    }

  function __webgl_enable_ANGLE_instanced_arrays(ctx) {
      // Extension available in WebGL 1 from Firefox 26 and Google Chrome 30 onwards. Core feature in WebGL 2.
      var ext = ctx.getExtension('ANGLE_instanced_arrays');
      if (ext) {
        ctx['vertexAttribDivisor'] = function(index, divisor) { ext['vertexAttribDivisorANGLE'](index, divisor); };
        ctx['drawArraysInstanced'] = function(mode, first, count, primcount) { ext['drawArraysInstancedANGLE'](mode, first, count, primcount); };
        ctx['drawElementsInstanced'] = function(mode, count, type, indices, primcount) { ext['drawElementsInstancedANGLE'](mode, count, type, indices, primcount); };
        return 1;
      }
    }
  
  function __webgl_enable_OES_vertex_array_object(ctx) {
      // Extension available in WebGL 1 from Firefox 25 and WebKit 536.28/desktop Safari 6.0.3 onwards. Core feature in WebGL 2.
      var ext = ctx.getExtension('OES_vertex_array_object');
      if (ext) {
        ctx['createVertexArray'] = function() { return ext['createVertexArrayOES'](); };
        ctx['deleteVertexArray'] = function(vao) { ext['deleteVertexArrayOES'](vao); };
        ctx['bindVertexArray'] = function(vao) { ext['bindVertexArrayOES'](vao); };
        ctx['isVertexArray'] = function(vao) { return ext['isVertexArrayOES'](vao); };
        return 1;
      }
    }
  
  function __webgl_enable_WEBGL_draw_buffers(ctx) {
      // Extension available in WebGL 1 from Firefox 28 onwards. Core feature in WebGL 2.
      var ext = ctx.getExtension('WEBGL_draw_buffers');
      if (ext) {
        ctx['drawBuffers'] = function(n, bufs) { ext['drawBuffersWEBGL'](n, bufs); };
        return 1;
      }
    }
  
  function __webgl_enable_WEBGL_multi_draw(ctx) {
      // Closure is expected to be allowed to minify the '.multiDrawWebgl' property, so not accessing it quoted.
      return !!(ctx.multiDrawWebgl = ctx.getExtension('WEBGL_multi_draw'));
    }
  var GL = {counter:1,buffers:[],programs:[],framebuffers:[],renderbuffers:[],textures:[],shaders:[],vaos:[],contexts:{},offscreenCanvases:{},queries:[],stringCache:{},unpackAlignment:4,recordError:function recordError(errorCode) {
        if (!GL.lastError) {
          GL.lastError = errorCode;
        }
      },getNewId:function(table) {
        var ret = GL.counter++;
        for (var i = table.length; i < ret; i++) {
          table[i] = null;
        }
        return ret;
      },getSource:function(shader, count, string, length) {
        var source = '';
        for (var i = 0; i < count; ++i) {
          var len = length ? HEAP32[(((length)+(i*4))>>2)] : -1;
          source += UTF8ToString(HEAP32[(((string)+(i*4))>>2)], len < 0 ? undefined : len);
        }
        return source;
      },createContext:function(canvas, webGLContextAttributes) {
  
        // BUG: Workaround Safari WebGL issue: After successfully acquiring WebGL context on a canvas,
        // calling .getContext() will always return that context independent of which 'webgl' or 'webgl2'
        // context version was passed. See https://bugs.webkit.org/show_bug.cgi?id=222758 and
        // https://github.com/emscripten-core/emscripten/issues/13295.
        // TODO: Once the bug is fixed and shipped in Safari, adjust the Safari version field in above check.
        if (!canvas.getContextSafariWebGL2Fixed) {
          canvas.getContextSafariWebGL2Fixed = canvas.getContext;
          canvas.getContext = function(ver, attrs) {
            var gl = canvas.getContextSafariWebGL2Fixed(ver, attrs);
            return ((ver == 'webgl') == (gl instanceof WebGLRenderingContext)) ? gl : null;
          }
        }
  
        var ctx = 
          (canvas.getContext("webgl", webGLContextAttributes)
            // https://caniuse.com/#feat=webgl
            );
  
        if (!ctx) return 0;
  
        var handle = GL.registerContext(ctx, webGLContextAttributes);
  
        return handle;
      },registerContext:function(ctx, webGLContextAttributes) {
        // with pthreads a context is a location in memory with some synchronized data between threads
        var handle = _malloc(8);
        HEAP32[(((handle)+(4))>>2)] = _pthread_self(); // the thread pointer of the thread that owns the control of the context
  
        var context = {
          handle: handle,
          attributes: webGLContextAttributes,
          version: webGLContextAttributes.majorVersion,
          GLctx: ctx
        };
  
        // Store the created context object so that we can access the context given a canvas without having to pass the parameters again.
        if (ctx.canvas) ctx.canvas.GLctxObject = context;
        GL.contexts[handle] = context;
        if (typeof webGLContextAttributes.enableExtensionsByDefault === 'undefined' || webGLContextAttributes.enableExtensionsByDefault) {
          GL.initExtensions(context);
        }
  
        return handle;
      },makeContextCurrent:function(contextHandle) {
  
        GL.currentContext = GL.contexts[contextHandle]; // Active Emscripten GL layer context object.
        Module.ctx = GLctx = GL.currentContext && GL.currentContext.GLctx; // Active WebGL context object.
        return !(contextHandle && !GLctx);
      },getContext:function(contextHandle) {
        return GL.contexts[contextHandle];
      },deleteContext:function(contextHandle) {
        if (GL.currentContext === GL.contexts[contextHandle]) GL.currentContext = null;
        if (typeof JSEvents === 'object') JSEvents.removeAllHandlersOnTarget(GL.contexts[contextHandle].GLctx.canvas); // Release all JS event handlers on the DOM element that the GL context is associated with since the context is now deleted.
        if (GL.contexts[contextHandle] && GL.contexts[contextHandle].GLctx.canvas) GL.contexts[contextHandle].GLctx.canvas.GLctxObject = undefined; // Make sure the canvas object no longer refers to the context object so there are no GC surprises.
        _free(GL.contexts[contextHandle].handle);
        GL.contexts[contextHandle] = null;
      },initExtensions:function(context) {
        // If this function is called without a specific context object, init the extensions of the currently active context.
        if (!context) context = GL.currentContext;
  
        if (context.initExtensionsDone) return;
        context.initExtensionsDone = true;
  
        var GLctx = context.GLctx;
  
        // Detect the presence of a few extensions manually, this GL interop layer itself will need to know if they exist.
  
        // Extensions that are only available in WebGL 1 (the calls will be no-ops if called on a WebGL 2 context active)
        __webgl_enable_ANGLE_instanced_arrays(GLctx);
        __webgl_enable_OES_vertex_array_object(GLctx);
        __webgl_enable_WEBGL_draw_buffers(GLctx);
  
        {
          GLctx.disjointTimerQueryExt = GLctx.getExtension("EXT_disjoint_timer_query");
        }
  
        __webgl_enable_WEBGL_multi_draw(GLctx);
  
        // .getSupportedExtensions() can return null if context is lost, so coerce to empty array.
        var exts = GLctx.getSupportedExtensions() || [];
        exts.forEach(function(ext) {
          // WEBGL_lose_context, WEBGL_debug_renderer_info and WEBGL_debug_shaders are not enabled by default.
          if (!ext.includes('lose_context') && !ext.includes('debug')) {
            // Call .getExtension() to enable that extension permanently.
            GLctx.getExtension(ext);
          }
        });
      }};
  
  var __emscripten_webgl_power_preferences = ['default', 'low-power', 'high-performance'];
  function _emscripten_webgl_do_create_context(target, attributes) {
      assert(attributes);
      var a = attributes >> 2;
      var powerPreference = HEAP32[a + (24>>2)];
      var contextAttributes = {
        'alpha': !!HEAP32[a + (0>>2)],
        'depth': !!HEAP32[a + (4>>2)],
        'stencil': !!HEAP32[a + (8>>2)],
        'antialias': !!HEAP32[a + (12>>2)],
        'premultipliedAlpha': !!HEAP32[a + (16>>2)],
        'preserveDrawingBuffer': !!HEAP32[a + (20>>2)],
        'powerPreference': __emscripten_webgl_power_preferences[powerPreference],
        'failIfMajorPerformanceCaveat': !!HEAP32[a + (28>>2)],
        // The following are not predefined WebGL context attributes in the WebGL specification, so the property names can be minified by Closure.
        majorVersion: HEAP32[a + (32>>2)],
        minorVersion: HEAP32[a + (36>>2)],
        enableExtensionsByDefault: HEAP32[a + (40>>2)],
        explicitSwapControl: HEAP32[a + (44>>2)],
        proxyContextToMainThread: HEAP32[a + (48>>2)],
        renderViaOffscreenBackBuffer: HEAP32[a + (52>>2)]
      };
  
      var canvas = findCanvasEventTarget(target);
  
      if (!canvas) {
        return 0;
      }
  
      if (contextAttributes.explicitSwapControl) {
        return 0;
      }
  
      var contextHandle = GL.createContext(canvas, contextAttributes);
      return contextHandle;
    }
  function _emscripten_webgl_create_context(a0,a1
  ) {
  return _emscripten_webgl_do_create_context(a0,a1);
  }


  function flush_NO_FILESYSTEM() {
      // flush anything remaining in the buffers during shutdown
      if (typeof _fflush !== 'undefined') _fflush(0);
      var buffers = SYSCALLS.buffers;
      if (buffers[1].length) SYSCALLS.printChar(1, 10);
      if (buffers[2].length) SYSCALLS.printChar(2, 10);
    }
  
  var SYSCALLS = {mappings:{},buffers:[null,[],[]],printChar:function(stream, curr) {
        var buffer = SYSCALLS.buffers[stream];
        assert(buffer);
        if (curr === 0 || curr === 10) {
          (stream === 1 ? out : err)(UTF8ArrayToString(buffer, 0));
          buffer.length = 0;
        } else {
          buffer.push(curr);
        }
      },varargs:undefined,get:function() {
        assert(SYSCALLS.varargs != undefined);
        SYSCALLS.varargs += 4;
        var ret = HEAP32[(((SYSCALLS.varargs)-(4))>>2)];
        return ret;
      },getStr:function(ptr) {
        var ret = UTF8ToString(ptr);
        return ret;
      },get64:function(low, high) {
        if (low >= 0) assert(high === 0);
        else assert(high === -1);
        return low;
      }};
  
  function _fd_write(fd, iov, iovcnt, pnum) {
    if (ENVIRONMENT_IS_PTHREAD)
      return _emscripten_proxy_to_main_thread_js(2, 1, fd, iov, iovcnt, pnum);
    
      // hack to support printf in SYSCALLS_REQUIRE_FILESYSTEM=0
      var num = 0;
      for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAP32[(((iov)+(i*8))>>2)];
        var len = HEAP32[(((iov)+(i*8 + 4))>>2)];
        for (var j = 0; j < len; j++) {
          SYSCALLS.printChar(fd, HEAPU8[ptr+j]);
        }
        num += len;
      }
      HEAP32[((pnum)>>2)] = num
      return 0;
    
  }
  

  function _setTempRet0(val) {
      setTempRet0(val);
    }
if (!ENVIRONMENT_IS_PTHREAD) PThread.initMainThreadBlock();;
var GLctx;;

 // proxiedFunctionTable specifies the list of functions that can be called either synchronously or asynchronously from other threads in postMessage()d or internally queued events. This way a pthread in a Worker can synchronously access e.g. the DOM on the main thread.

var proxiedFunctionTable = [null,_emscripten_set_canvas_element_size_main_thread,_fd_write];

var ASSERTIONS = true;



/** @type {function(string, boolean=, number=)} */
function intArrayFromString(stringy, dontAddNull, length) {
  var len = length > 0 ? length : lengthBytesUTF8(stringy)+1;
  var u8array = new Array(len);
  var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
  if (dontAddNull) u8array.length = numBytesWritten;
  return u8array;
}

function intArrayToString(array) {
  var ret = [];
  for (var i = 0; i < array.length; i++) {
    var chr = array[i];
    if (chr > 0xFF) {
      if (ASSERTIONS) {
        assert(false, 'Character code ' + chr + ' (' + String.fromCharCode(chr) + ')  at offset ' + i + ' not in 0x00-0xFF.');
      }
      chr &= 0xFF;
    }
    ret.push(String.fromCharCode(chr));
  }
  return ret.join('');
}


// Copied from https://github.com/strophe/strophejs/blob/e06d027/src/polyfills.js#L149

// This code was written by Tyler Akins and has been placed in the
// public domain.  It would be nice if you left this header intact.
// Base64 code from Tyler Akins -- http://rumkin.com

/**
 * Decodes a base64 string.
 * @param {string} input The string to decode.
 */
var decodeBase64 = typeof atob === 'function' ? atob : function (input) {
  var keyStr = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

  var output = '';
  var chr1, chr2, chr3;
  var enc1, enc2, enc3, enc4;
  var i = 0;
  // remove all characters that are not A-Z, a-z, 0-9, +, /, or =
  input = input.replace(/[^A-Za-z0-9\+\/\=]/g, '');
  do {
    enc1 = keyStr.indexOf(input.charAt(i++));
    enc2 = keyStr.indexOf(input.charAt(i++));
    enc3 = keyStr.indexOf(input.charAt(i++));
    enc4 = keyStr.indexOf(input.charAt(i++));

    chr1 = (enc1 << 2) | (enc2 >> 4);
    chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    chr3 = ((enc3 & 3) << 6) | enc4;

    output = output + String.fromCharCode(chr1);

    if (enc3 !== 64) {
      output = output + String.fromCharCode(chr2);
    }
    if (enc4 !== 64) {
      output = output + String.fromCharCode(chr3);
    }
  } while (i < input.length);
  return output;
};

// Converts a string of base64 into a byte array.
// Throws error on invalid input.
function intArrayFromBase64(s) {
  if (typeof ENVIRONMENT_IS_NODE === 'boolean' && ENVIRONMENT_IS_NODE) {
    var buf = Buffer.from(s, 'base64');
    return new Uint8Array(buf['buffer'], buf['byteOffset'], buf['byteLength']);
  }

  try {
    var decoded = decodeBase64(s);
    var bytes = new Uint8Array(decoded.length);
    for (var i = 0 ; i < decoded.length ; ++i) {
      bytes[i] = decoded.charCodeAt(i);
    }
    return bytes;
  } catch (_) {
    throw new Error('Converting base64 string to bytes failed.');
  }
}

// If filename is a base64 data URI, parses and returns data (Buffer on node,
// Uint8Array otherwise). If filename is not a base64 data URI, returns undefined.
function tryParseAsDataURI(filename) {
  if (!isDataURI(filename)) {
    return;
  }

  return intArrayFromBase64(filename.slice(dataURIPrefix.length));
}


var asmLibraryArg = {
  "__assert_fail": ___assert_fail,
  "__clock_gettime": ___clock_gettime,
  "__cxa_thread_atexit": ___cxa_thread_atexit,
  "__pthread_create_js": ___pthread_create_js,
  "__pthread_exit_done": ___pthread_exit_done,
  "__pthread_exit_run_handlers": ___pthread_exit_run_handlers,
  "__pthread_join_js": ___pthread_join_js,
  "_emscripten_notify_thread_queue": __emscripten_notify_thread_queue,
  "emscripten_conditional_set_current_thread_status": _emscripten_conditional_set_current_thread_status,
  "emscripten_futex_wait": _emscripten_futex_wait,
  "emscripten_futex_wake": _emscripten_futex_wake,
  "emscripten_get_now": _emscripten_get_now,
  "emscripten_memcpy_big": _emscripten_memcpy_big,
  "emscripten_receive_on_main_thread_js": _emscripten_receive_on_main_thread_js,
  "emscripten_resize_heap": _emscripten_resize_heap,
  "emscripten_set_canvas_element_size": _emscripten_set_canvas_element_size,
  "emscripten_set_current_thread_status": _emscripten_set_current_thread_status,
  "emscripten_set_timeout": _emscripten_set_timeout,
  "emscripten_unwind_to_js_event_loop": _emscripten_unwind_to_js_event_loop,
  "emscripten_webgl_create_context": _emscripten_webgl_create_context,
  "exit": _exit,
  "fd_write": _fd_write,
  "initPthreadsJS": initPthreadsJS,
  "memory": wasmMemory,
  "setTempRet0": _setTempRet0
};
var asm = createWasm();
/** @type {function(...*):?} */
var ___wasm_call_ctors = Module["___wasm_call_ctors"] = createExportWrapper("__wasm_call_ctors");

/** @type {function(...*):?} */
var _CreateFreeQueue = Module["_CreateFreeQueue"] = createExportWrapper("CreateFreeQueue");

/** @type {function(...*):?} */
var _malloc = Module["_malloc"] = createExportWrapper("malloc");

/** @type {function(...*):?} */
var _DestroyFreeQueue = Module["_DestroyFreeQueue"] = createExportWrapper("DestroyFreeQueue");

/** @type {function(...*):?} */
var _free = Module["_free"] = createExportWrapper("free");

/** @type {function(...*):?} */
var _FreeQueuePush = Module["_FreeQueuePush"] = createExportWrapper("FreeQueuePush");

/** @type {function(...*):?} */
var _FreeQueuePull = Module["_FreeQueuePull"] = createExportWrapper("FreeQueuePull");

/** @type {function(...*):?} */
var _GetFreeQueuePointers = Module["_GetFreeQueuePointers"] = createExportWrapper("GetFreeQueuePointers");

/** @type {function(...*):?} */
var _DestroyFreeQueueThreads = Module["_DestroyFreeQueueThreads"] = createExportWrapper("DestroyFreeQueueThreads");

/** @type {function(...*):?} */
var _CreateFreeQueueThreads = Module["_CreateFreeQueueThreads"] = createExportWrapper("CreateFreeQueueThreads");

/** @type {function(...*):?} */
var _GetFreeQueueThreads = Module["_GetFreeQueueThreads"] = createExportWrapper("GetFreeQueueThreads");

/** @type {function(...*):?} */
var _PrintQueueInfo = Module["_PrintQueueInfo"] = createExportWrapper("PrintQueueInfo");

/** @type {function(...*):?} */
var _PrintQueueAddresses = Module["_PrintQueueAddresses"] = createExportWrapper("PrintQueueAddresses");

/** @type {function(...*):?} */
var _main = Module["_main"] = createExportWrapper("main");

/** @type {function(...*):?} */
var _emscripten_tls_init = Module["_emscripten_tls_init"] = createExportWrapper("emscripten_tls_init");

/** @type {function(...*):?} */
var _emscripten_current_thread_process_queued_calls = Module["_emscripten_current_thread_process_queued_calls"] = createExportWrapper("emscripten_current_thread_process_queued_calls");

/** @type {function(...*):?} */
var _emscripten_main_browser_thread_id = Module["_emscripten_main_browser_thread_id"] = createExportWrapper("emscripten_main_browser_thread_id");

/** @type {function(...*):?} */
var _emscripten_sync_run_in_main_thread_2 = Module["_emscripten_sync_run_in_main_thread_2"] = createExportWrapper("emscripten_sync_run_in_main_thread_2");

/** @type {function(...*):?} */
var _emscripten_sync_run_in_main_thread_4 = Module["_emscripten_sync_run_in_main_thread_4"] = createExportWrapper("emscripten_sync_run_in_main_thread_4");

/** @type {function(...*):?} */
var _emscripten_main_thread_process_queued_calls = Module["_emscripten_main_thread_process_queued_calls"] = createExportWrapper("emscripten_main_thread_process_queued_calls");

/** @type {function(...*):?} */
var _emscripten_run_in_main_runtime_thread_js = Module["_emscripten_run_in_main_runtime_thread_js"] = createExportWrapper("emscripten_run_in_main_runtime_thread_js");

/** @type {function(...*):?} */
var __emscripten_call_on_thread = Module["__emscripten_call_on_thread"] = createExportWrapper("_emscripten_call_on_thread");

/** @type {function(...*):?} */
var ___emscripten_pthread_data_constructor = Module["___emscripten_pthread_data_constructor"] = createExportWrapper("__emscripten_pthread_data_constructor");

/** @type {function(...*):?} */
var __emscripten_thread_exit = Module["__emscripten_thread_exit"] = createExportWrapper("_emscripten_thread_exit");

/** @type {function(...*):?} */
var _pthread_self = Module["_pthread_self"] = createExportWrapper("pthread_self");

/** @type {function(...*):?} */
var __emscripten_thread_init = Module["__emscripten_thread_init"] = createExportWrapper("_emscripten_thread_init");

/** @type {function(...*):?} */
var _pthread_testcancel = Module["_pthread_testcancel"] = createExportWrapper("pthread_testcancel");

/** @type {function(...*):?} */
var ___errno_location = Module["___errno_location"] = createExportWrapper("__errno_location");

/** @type {function(...*):?} */
var _emscripten_get_global_libc = Module["_emscripten_get_global_libc"] = createExportWrapper("emscripten_get_global_libc");

/** @type {function(...*):?} */
var _fflush = Module["_fflush"] = createExportWrapper("fflush");

/** @type {function(...*):?} */
var stackSave = Module["stackSave"] = createExportWrapper("stackSave");

/** @type {function(...*):?} */
var stackRestore = Module["stackRestore"] = createExportWrapper("stackRestore");

/** @type {function(...*):?} */
var stackAlloc = Module["stackAlloc"] = createExportWrapper("stackAlloc");

/** @type {function(...*):?} */
var _emscripten_stack_init = Module["_emscripten_stack_init"] = function() {
  return (_emscripten_stack_init = Module["_emscripten_stack_init"] = Module["asm"]["emscripten_stack_init"]).apply(null, arguments);
};

/** @type {function(...*):?} */
var _emscripten_stack_set_limits = Module["_emscripten_stack_set_limits"] = function() {
  return (_emscripten_stack_set_limits = Module["_emscripten_stack_set_limits"] = Module["asm"]["emscripten_stack_set_limits"]).apply(null, arguments);
};

/** @type {function(...*):?} */
var _emscripten_stack_get_free = Module["_emscripten_stack_get_free"] = function() {
  return (_emscripten_stack_get_free = Module["_emscripten_stack_get_free"] = Module["asm"]["emscripten_stack_get_free"]).apply(null, arguments);
};

/** @type {function(...*):?} */
var _emscripten_stack_get_end = Module["_emscripten_stack_get_end"] = function() {
  return (_emscripten_stack_get_end = Module["_emscripten_stack_get_end"] = Module["asm"]["emscripten_stack_get_end"]).apply(null, arguments);
};

/** @type {function(...*):?} */
var _memalign = Module["_memalign"] = createExportWrapper("memalign");

/** @type {function(...*):?} */
var dynCall_jiji = Module["dynCall_jiji"] = createExportWrapper("dynCall_jiji");

var __emscripten_allow_main_runtime_queued_calls = Module['__emscripten_allow_main_runtime_queued_calls'] = 2728;
var __emscripten_main_thread_futex = Module['__emscripten_main_thread_futex'] = 3228;



// === Auto-generated postamble setup entry stuff ===

if (!Object.getOwnPropertyDescriptor(Module, "intArrayFromString")) Module["intArrayFromString"] = function() { abort("'intArrayFromString' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "intArrayToString")) Module["intArrayToString"] = function() { abort("'intArrayToString' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
Module["ccall"] = ccall;
Module["cwrap"] = cwrap;
if (!Object.getOwnPropertyDescriptor(Module, "setValue")) Module["setValue"] = function() { abort("'setValue' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getValue")) Module["getValue"] = function() { abort("'getValue' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "allocate")) Module["allocate"] = function() { abort("'allocate' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "UTF8ArrayToString")) Module["UTF8ArrayToString"] = function() { abort("'UTF8ArrayToString' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "UTF8ToString")) Module["UTF8ToString"] = function() { abort("'UTF8ToString' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToUTF8Array")) Module["stringToUTF8Array"] = function() { abort("'stringToUTF8Array' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToUTF8")) Module["stringToUTF8"] = function() { abort("'stringToUTF8' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "lengthBytesUTF8")) Module["lengthBytesUTF8"] = function() { abort("'lengthBytesUTF8' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stackTrace")) Module["stackTrace"] = function() { abort("'stackTrace' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addOnPreRun")) Module["addOnPreRun"] = function() { abort("'addOnPreRun' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addOnInit")) Module["addOnInit"] = function() { abort("'addOnInit' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addOnPreMain")) Module["addOnPreMain"] = function() { abort("'addOnPreMain' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addOnExit")) Module["addOnExit"] = function() { abort("'addOnExit' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addOnPostRun")) Module["addOnPostRun"] = function() { abort("'addOnPostRun' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeStringToMemory")) Module["writeStringToMemory"] = function() { abort("'writeStringToMemory' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeArrayToMemory")) Module["writeArrayToMemory"] = function() { abort("'writeArrayToMemory' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeAsciiToMemory")) Module["writeAsciiToMemory"] = function() { abort("'writeAsciiToMemory' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addRunDependency")) Module["addRunDependency"] = function() { abort("'addRunDependency' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "removeRunDependency")) Module["removeRunDependency"] = function() { abort("'removeRunDependency' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createFolder")) Module["FS_createFolder"] = function() { abort("'FS_createFolder' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createPath")) Module["FS_createPath"] = function() { abort("'FS_createPath' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createDataFile")) Module["FS_createDataFile"] = function() { abort("'FS_createDataFile' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createPreloadedFile")) Module["FS_createPreloadedFile"] = function() { abort("'FS_createPreloadedFile' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createLazyFile")) Module["FS_createLazyFile"] = function() { abort("'FS_createLazyFile' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createLink")) Module["FS_createLink"] = function() { abort("'FS_createLink' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_createDevice")) Module["FS_createDevice"] = function() { abort("'FS_createDevice' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "FS_unlink")) Module["FS_unlink"] = function() { abort("'FS_unlink' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ). Alternatively, forcing filesystem support (-s FORCE_FILESYSTEM=1) can export this for you") };
if (!Object.getOwnPropertyDescriptor(Module, "getLEB")) Module["getLEB"] = function() { abort("'getLEB' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getFunctionTables")) Module["getFunctionTables"] = function() { abort("'getFunctionTables' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "alignFunctionTables")) Module["alignFunctionTables"] = function() { abort("'alignFunctionTables' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerFunctions")) Module["registerFunctions"] = function() { abort("'registerFunctions' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "addFunction")) Module["addFunction"] = function() { abort("'addFunction' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "removeFunction")) Module["removeFunction"] = function() { abort("'removeFunction' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getFuncWrapper")) Module["getFuncWrapper"] = function() { abort("'getFuncWrapper' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "prettyPrint")) Module["prettyPrint"] = function() { abort("'prettyPrint' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "dynCall")) Module["dynCall"] = function() { abort("'dynCall' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getCompilerSetting")) Module["getCompilerSetting"] = function() { abort("'getCompilerSetting' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "print")) Module["print"] = function() { abort("'print' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "printErr")) Module["printErr"] = function() { abort("'printErr' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getTempRet0")) Module["getTempRet0"] = function() { abort("'getTempRet0' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "setTempRet0")) Module["setTempRet0"] = function() { abort("'setTempRet0' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
Module["callMain"] = callMain;
if (!Object.getOwnPropertyDescriptor(Module, "abort")) Module["abort"] = function() { abort("'abort' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
Module["keepRuntimeAlive"] = keepRuntimeAlive;
if (!Object.getOwnPropertyDescriptor(Module, "zeroMemory")) Module["zeroMemory"] = function() { abort("'zeroMemory' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToNewUTF8")) Module["stringToNewUTF8"] = function() { abort("'stringToNewUTF8' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "setFileTime")) Module["setFileTime"] = function() { abort("'setFileTime' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "abortOnCannotGrowMemory")) Module["abortOnCannotGrowMemory"] = function() { abort("'abortOnCannotGrowMemory' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "emscripten_realloc_buffer")) Module["emscripten_realloc_buffer"] = function() { abort("'emscripten_realloc_buffer' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "ENV")) Module["ENV"] = function() { abort("'ENV' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "ERRNO_CODES")) Module["ERRNO_CODES"] = function() { abort("'ERRNO_CODES' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "ERRNO_MESSAGES")) Module["ERRNO_MESSAGES"] = function() { abort("'ERRNO_MESSAGES' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "setErrNo")) Module["setErrNo"] = function() { abort("'setErrNo' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "inetPton4")) Module["inetPton4"] = function() { abort("'inetPton4' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "inetNtop4")) Module["inetNtop4"] = function() { abort("'inetNtop4' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "inetPton6")) Module["inetPton6"] = function() { abort("'inetPton6' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "inetNtop6")) Module["inetNtop6"] = function() { abort("'inetNtop6' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "readSockaddr")) Module["readSockaddr"] = function() { abort("'readSockaddr' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeSockaddr")) Module["writeSockaddr"] = function() { abort("'writeSockaddr' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "DNS")) Module["DNS"] = function() { abort("'DNS' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getHostByName")) Module["getHostByName"] = function() { abort("'getHostByName' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "GAI_ERRNO_MESSAGES")) Module["GAI_ERRNO_MESSAGES"] = function() { abort("'GAI_ERRNO_MESSAGES' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "Protocols")) Module["Protocols"] = function() { abort("'Protocols' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "Sockets")) Module["Sockets"] = function() { abort("'Sockets' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getRandomDevice")) Module["getRandomDevice"] = function() { abort("'getRandomDevice' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "traverseStack")) Module["traverseStack"] = function() { abort("'traverseStack' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "UNWIND_CACHE")) Module["UNWIND_CACHE"] = function() { abort("'UNWIND_CACHE' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "withBuiltinMalloc")) Module["withBuiltinMalloc"] = function() { abort("'withBuiltinMalloc' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "readAsmConstArgsArray")) Module["readAsmConstArgsArray"] = function() { abort("'readAsmConstArgsArray' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "readAsmConstArgs")) Module["readAsmConstArgs"] = function() { abort("'readAsmConstArgs' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "mainThreadEM_ASM")) Module["mainThreadEM_ASM"] = function() { abort("'mainThreadEM_ASM' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "jstoi_q")) Module["jstoi_q"] = function() { abort("'jstoi_q' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "jstoi_s")) Module["jstoi_s"] = function() { abort("'jstoi_s' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getExecutableName")) Module["getExecutableName"] = function() { abort("'getExecutableName' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "listenOnce")) Module["listenOnce"] = function() { abort("'listenOnce' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "autoResumeAudioContext")) Module["autoResumeAudioContext"] = function() { abort("'autoResumeAudioContext' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "dynCallLegacy")) Module["dynCallLegacy"] = function() { abort("'dynCallLegacy' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getDynCaller")) Module["getDynCaller"] = function() { abort("'getDynCaller' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "dynCall")) Module["dynCall"] = function() { abort("'dynCall' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "callRuntimeCallbacks")) Module["callRuntimeCallbacks"] = function() { abort("'callRuntimeCallbacks' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "handleException")) Module["handleException"] = function() { abort("'handleException' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "runtimeKeepalivePush")) Module["runtimeKeepalivePush"] = function() { abort("'runtimeKeepalivePush' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "runtimeKeepalivePop")) Module["runtimeKeepalivePop"] = function() { abort("'runtimeKeepalivePop' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "callUserCallback")) Module["callUserCallback"] = function() { abort("'callUserCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "maybeExit")) Module["maybeExit"] = function() { abort("'maybeExit' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "safeSetTimeout")) Module["safeSetTimeout"] = function() { abort("'safeSetTimeout' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "asmjsMangle")) Module["asmjsMangle"] = function() { abort("'asmjsMangle' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "asyncLoad")) Module["asyncLoad"] = function() { abort("'asyncLoad' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "alignMemory")) Module["alignMemory"] = function() { abort("'alignMemory' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "mmapAlloc")) Module["mmapAlloc"] = function() { abort("'mmapAlloc' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "reallyNegative")) Module["reallyNegative"] = function() { abort("'reallyNegative' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "unSign")) Module["unSign"] = function() { abort("'unSign' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "reSign")) Module["reSign"] = function() { abort("'reSign' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "formatString")) Module["formatString"] = function() { abort("'formatString' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "PATH")) Module["PATH"] = function() { abort("'PATH' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "PATH_FS")) Module["PATH_FS"] = function() { abort("'PATH_FS' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "SYSCALLS")) Module["SYSCALLS"] = function() { abort("'SYSCALLS' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "syscallMmap2")) Module["syscallMmap2"] = function() { abort("'syscallMmap2' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "syscallMunmap")) Module["syscallMunmap"] = function() { abort("'syscallMunmap' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getSocketFromFD")) Module["getSocketFromFD"] = function() { abort("'getSocketFromFD' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getSocketAddress")) Module["getSocketAddress"] = function() { abort("'getSocketAddress' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "JSEvents")) Module["JSEvents"] = function() { abort("'JSEvents' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerKeyEventCallback")) Module["registerKeyEventCallback"] = function() { abort("'registerKeyEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "specialHTMLTargets")) Module["specialHTMLTargets"] = function() { abort("'specialHTMLTargets' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "maybeCStringToJsString")) Module["maybeCStringToJsString"] = function() { abort("'maybeCStringToJsString' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "findEventTarget")) Module["findEventTarget"] = function() { abort("'findEventTarget' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "findCanvasEventTarget")) Module["findCanvasEventTarget"] = function() { abort("'findCanvasEventTarget' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getBoundingClientRect")) Module["getBoundingClientRect"] = function() { abort("'getBoundingClientRect' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "fillMouseEventData")) Module["fillMouseEventData"] = function() { abort("'fillMouseEventData' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerMouseEventCallback")) Module["registerMouseEventCallback"] = function() { abort("'registerMouseEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerWheelEventCallback")) Module["registerWheelEventCallback"] = function() { abort("'registerWheelEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerUiEventCallback")) Module["registerUiEventCallback"] = function() { abort("'registerUiEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerFocusEventCallback")) Module["registerFocusEventCallback"] = function() { abort("'registerFocusEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "fillDeviceOrientationEventData")) Module["fillDeviceOrientationEventData"] = function() { abort("'fillDeviceOrientationEventData' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerDeviceOrientationEventCallback")) Module["registerDeviceOrientationEventCallback"] = function() { abort("'registerDeviceOrientationEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "fillDeviceMotionEventData")) Module["fillDeviceMotionEventData"] = function() { abort("'fillDeviceMotionEventData' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerDeviceMotionEventCallback")) Module["registerDeviceMotionEventCallback"] = function() { abort("'registerDeviceMotionEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "screenOrientation")) Module["screenOrientation"] = function() { abort("'screenOrientation' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "fillOrientationChangeEventData")) Module["fillOrientationChangeEventData"] = function() { abort("'fillOrientationChangeEventData' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerOrientationChangeEventCallback")) Module["registerOrientationChangeEventCallback"] = function() { abort("'registerOrientationChangeEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "fillFullscreenChangeEventData")) Module["fillFullscreenChangeEventData"] = function() { abort("'fillFullscreenChangeEventData' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerFullscreenChangeEventCallback")) Module["registerFullscreenChangeEventCallback"] = function() { abort("'registerFullscreenChangeEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerRestoreOldStyle")) Module["registerRestoreOldStyle"] = function() { abort("'registerRestoreOldStyle' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "hideEverythingExceptGivenElement")) Module["hideEverythingExceptGivenElement"] = function() { abort("'hideEverythingExceptGivenElement' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "restoreHiddenElements")) Module["restoreHiddenElements"] = function() { abort("'restoreHiddenElements' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "setLetterbox")) Module["setLetterbox"] = function() { abort("'setLetterbox' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "currentFullscreenStrategy")) Module["currentFullscreenStrategy"] = function() { abort("'currentFullscreenStrategy' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "restoreOldWindowedStyle")) Module["restoreOldWindowedStyle"] = function() { abort("'restoreOldWindowedStyle' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "softFullscreenResizeWebGLRenderTarget")) Module["softFullscreenResizeWebGLRenderTarget"] = function() { abort("'softFullscreenResizeWebGLRenderTarget' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "doRequestFullscreen")) Module["doRequestFullscreen"] = function() { abort("'doRequestFullscreen' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "fillPointerlockChangeEventData")) Module["fillPointerlockChangeEventData"] = function() { abort("'fillPointerlockChangeEventData' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerPointerlockChangeEventCallback")) Module["registerPointerlockChangeEventCallback"] = function() { abort("'registerPointerlockChangeEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerPointerlockErrorEventCallback")) Module["registerPointerlockErrorEventCallback"] = function() { abort("'registerPointerlockErrorEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "requestPointerLock")) Module["requestPointerLock"] = function() { abort("'requestPointerLock' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "fillVisibilityChangeEventData")) Module["fillVisibilityChangeEventData"] = function() { abort("'fillVisibilityChangeEventData' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerVisibilityChangeEventCallback")) Module["registerVisibilityChangeEventCallback"] = function() { abort("'registerVisibilityChangeEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerTouchEventCallback")) Module["registerTouchEventCallback"] = function() { abort("'registerTouchEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "fillGamepadEventData")) Module["fillGamepadEventData"] = function() { abort("'fillGamepadEventData' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerGamepadEventCallback")) Module["registerGamepadEventCallback"] = function() { abort("'registerGamepadEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerBeforeUnloadEventCallback")) Module["registerBeforeUnloadEventCallback"] = function() { abort("'registerBeforeUnloadEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "fillBatteryEventData")) Module["fillBatteryEventData"] = function() { abort("'fillBatteryEventData' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "battery")) Module["battery"] = function() { abort("'battery' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "registerBatteryEventCallback")) Module["registerBatteryEventCallback"] = function() { abort("'registerBatteryEventCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "setCanvasElementSize")) Module["setCanvasElementSize"] = function() { abort("'setCanvasElementSize' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getCanvasElementSize")) Module["getCanvasElementSize"] = function() { abort("'getCanvasElementSize' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "polyfillSetImmediate")) Module["polyfillSetImmediate"] = function() { abort("'polyfillSetImmediate' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "demangle")) Module["demangle"] = function() { abort("'demangle' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "demangleAll")) Module["demangleAll"] = function() { abort("'demangleAll' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "jsStackTrace")) Module["jsStackTrace"] = function() { abort("'jsStackTrace' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stackTrace")) Module["stackTrace"] = function() { abort("'stackTrace' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getEnvStrings")) Module["getEnvStrings"] = function() { abort("'getEnvStrings' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "checkWasiClock")) Module["checkWasiClock"] = function() { abort("'checkWasiClock' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "flush_NO_FILESYSTEM")) Module["flush_NO_FILESYSTEM"] = function() { abort("'flush_NO_FILESYSTEM' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeI53ToI64")) Module["writeI53ToI64"] = function() { abort("'writeI53ToI64' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeI53ToI64Clamped")) Module["writeI53ToI64Clamped"] = function() { abort("'writeI53ToI64Clamped' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeI53ToI64Signaling")) Module["writeI53ToI64Signaling"] = function() { abort("'writeI53ToI64Signaling' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeI53ToU64Clamped")) Module["writeI53ToU64Clamped"] = function() { abort("'writeI53ToU64Clamped' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeI53ToU64Signaling")) Module["writeI53ToU64Signaling"] = function() { abort("'writeI53ToU64Signaling' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "readI53FromI64")) Module["readI53FromI64"] = function() { abort("'readI53FromI64' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "readI53FromU64")) Module["readI53FromU64"] = function() { abort("'readI53FromU64' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "convertI32PairToI53")) Module["convertI32PairToI53"] = function() { abort("'convertI32PairToI53' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "convertU32PairToI53")) Module["convertU32PairToI53"] = function() { abort("'convertU32PairToI53' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "uncaughtExceptionCount")) Module["uncaughtExceptionCount"] = function() { abort("'uncaughtExceptionCount' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "exceptionLast")) Module["exceptionLast"] = function() { abort("'exceptionLast' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "exceptionCaught")) Module["exceptionCaught"] = function() { abort("'exceptionCaught' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "ExceptionInfo")) Module["ExceptionInfo"] = function() { abort("'ExceptionInfo' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "CatchInfo")) Module["CatchInfo"] = function() { abort("'CatchInfo' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "exception_addRef")) Module["exception_addRef"] = function() { abort("'exception_addRef' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "exception_decRef")) Module["exception_decRef"] = function() { abort("'exception_decRef' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "Browser")) Module["Browser"] = function() { abort("'Browser' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "funcWrappers")) Module["funcWrappers"] = function() { abort("'funcWrappers' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "getFuncWrapper")) Module["getFuncWrapper"] = function() { abort("'getFuncWrapper' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "setMainLoop")) Module["setMainLoop"] = function() { abort("'setMainLoop' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "wget")) Module["wget"] = function() { abort("'wget' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "tempFixedLengthArray")) Module["tempFixedLengthArray"] = function() { abort("'tempFixedLengthArray' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "miniTempWebGLFloatBuffers")) Module["miniTempWebGLFloatBuffers"] = function() { abort("'miniTempWebGLFloatBuffers' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "heapObjectForWebGLType")) Module["heapObjectForWebGLType"] = function() { abort("'heapObjectForWebGLType' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "heapAccessShiftForWebGLHeap")) Module["heapAccessShiftForWebGLHeap"] = function() { abort("'heapAccessShiftForWebGLHeap' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "GL")) Module["GL"] = function() { abort("'GL' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "emscriptenWebGLGet")) Module["emscriptenWebGLGet"] = function() { abort("'emscriptenWebGLGet' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "computeUnpackAlignedImageSize")) Module["computeUnpackAlignedImageSize"] = function() { abort("'computeUnpackAlignedImageSize' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "emscriptenWebGLGetTexPixelData")) Module["emscriptenWebGLGetTexPixelData"] = function() { abort("'emscriptenWebGLGetTexPixelData' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "emscriptenWebGLGetUniform")) Module["emscriptenWebGLGetUniform"] = function() { abort("'emscriptenWebGLGetUniform' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "webglGetUniformLocation")) Module["webglGetUniformLocation"] = function() { abort("'webglGetUniformLocation' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "webglPrepareUniformLocationsBeforeFirstUse")) Module["webglPrepareUniformLocationsBeforeFirstUse"] = function() { abort("'webglPrepareUniformLocationsBeforeFirstUse' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "webglGetLeftBracePos")) Module["webglGetLeftBracePos"] = function() { abort("'webglGetLeftBracePos' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "emscriptenWebGLGetVertexAttrib")) Module["emscriptenWebGLGetVertexAttrib"] = function() { abort("'emscriptenWebGLGetVertexAttrib' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "writeGLArray")) Module["writeGLArray"] = function() { abort("'writeGLArray' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "FS")) Module["FS"] = function() { abort("'FS' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "MEMFS")) Module["MEMFS"] = function() { abort("'MEMFS' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "TTY")) Module["TTY"] = function() { abort("'TTY' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "PIPEFS")) Module["PIPEFS"] = function() { abort("'PIPEFS' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "SOCKFS")) Module["SOCKFS"] = function() { abort("'SOCKFS' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "_setNetworkCallback")) Module["_setNetworkCallback"] = function() { abort("'_setNetworkCallback' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "AL")) Module["AL"] = function() { abort("'AL' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "SDL_unicode")) Module["SDL_unicode"] = function() { abort("'SDL_unicode' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "SDL_ttfContext")) Module["SDL_ttfContext"] = function() { abort("'SDL_ttfContext' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "SDL_audio")) Module["SDL_audio"] = function() { abort("'SDL_audio' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "SDL")) Module["SDL"] = function() { abort("'SDL' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "SDL_gfx")) Module["SDL_gfx"] = function() { abort("'SDL_gfx' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "GLUT")) Module["GLUT"] = function() { abort("'GLUT' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "EGL")) Module["EGL"] = function() { abort("'EGL' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "GLFW_Window")) Module["GLFW_Window"] = function() { abort("'GLFW_Window' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "GLFW")) Module["GLFW"] = function() { abort("'GLFW' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "GLEW")) Module["GLEW"] = function() { abort("'GLEW' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "IDBStore")) Module["IDBStore"] = function() { abort("'IDBStore' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "runAndAbortIfError")) Module["runAndAbortIfError"] = function() { abort("'runAndAbortIfError' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
Module["PThread"] = PThread;
if (!Object.getOwnPropertyDescriptor(Module, "killThread")) Module["killThread"] = function() { abort("'killThread' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "cleanupThread")) Module["cleanupThread"] = function() { abort("'cleanupThread' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "cancelThread")) Module["cancelThread"] = function() { abort("'cancelThread' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "spawnThread")) Module["spawnThread"] = function() { abort("'spawnThread' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "establishStackSpace")) Module["establishStackSpace"] = function() { abort("'establishStackSpace' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "invokeEntryPoint")) Module["invokeEntryPoint"] = function() { abort("'invokeEntryPoint' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "warnOnce")) Module["warnOnce"] = function() { abort("'warnOnce' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stackSave")) Module["stackSave"] = function() { abort("'stackSave' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stackRestore")) Module["stackRestore"] = function() { abort("'stackRestore' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stackAlloc")) Module["stackAlloc"] = function() { abort("'stackAlloc' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "AsciiToString")) Module["AsciiToString"] = function() { abort("'AsciiToString' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToAscii")) Module["stringToAscii"] = function() { abort("'stringToAscii' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "UTF16ToString")) Module["UTF16ToString"] = function() { abort("'UTF16ToString' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToUTF16")) Module["stringToUTF16"] = function() { abort("'stringToUTF16' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "lengthBytesUTF16")) Module["lengthBytesUTF16"] = function() { abort("'lengthBytesUTF16' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "UTF32ToString")) Module["UTF32ToString"] = function() { abort("'UTF32ToString' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "stringToUTF32")) Module["stringToUTF32"] = function() { abort("'stringToUTF32' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "lengthBytesUTF32")) Module["lengthBytesUTF32"] = function() { abort("'lengthBytesUTF32' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "allocateUTF8")) Module["allocateUTF8"] = function() { abort("'allocateUTF8' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "allocateUTF8OnStack")) Module["allocateUTF8OnStack"] = function() { abort("'allocateUTF8OnStack' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
Module["writeStackCookie"] = writeStackCookie;
Module["checkStackCookie"] = checkStackCookie;
Module["PThread"] = PThread;
Module["wasmMemory"] = wasmMemory;
Module["ExitStatus"] = ExitStatus;
if (!Object.getOwnPropertyDescriptor(Module, "intArrayFromBase64")) Module["intArrayFromBase64"] = function() { abort("'intArrayFromBase64' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "tryParseAsDataURI")) Module["tryParseAsDataURI"] = function() { abort("'tryParseAsDataURI' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") };
if (!Object.getOwnPropertyDescriptor(Module, "ALLOC_NORMAL")) Object.defineProperty(Module, "ALLOC_NORMAL", { configurable: true, get: function() { abort("'ALLOC_NORMAL' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") } });
if (!Object.getOwnPropertyDescriptor(Module, "ALLOC_STACK")) Object.defineProperty(Module, "ALLOC_STACK", { configurable: true, get: function() { abort("'ALLOC_STACK' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the FAQ)") } });

var calledRun;

/**
 * @constructor
 * @this {ExitStatus}
 */
function ExitStatus(status) {
  this.name = "ExitStatus";
  this.message = "Program terminated with exit(" + status + ")";
  this.status = status;
}

var calledMain = false;

dependenciesFulfilled = function runCaller() {
  // If run has never been called, and we should call run (INVOKE_RUN is true, and Module.noInitialRun is not false)
  if (!calledRun) run();
  if (!calledRun) dependenciesFulfilled = runCaller; // try this again later, after new deps are fulfilled
};

function callMain(args) {
  assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on Module["onRuntimeInitialized"])');
  assert(__ATPRERUN__.length == 0, 'cannot call main when preRun functions remain to be called');

  var entryFunction = Module['_main'];

  args = args || [];

  var argc = args.length+1;
  var argv = stackAlloc((argc + 1) * 4);
  HEAP32[argv >> 2] = allocateUTF8OnStack(thisProgram);
  for (var i = 1; i < argc; i++) {
    HEAP32[(argv >> 2) + i] = allocateUTF8OnStack(args[i - 1]);
  }
  HEAP32[(argv >> 2) + argc] = 0;

  try {

    var ret = entryFunction(argc, argv);

    // In PROXY_TO_PTHREAD builds, we should never exit the runtime below, as
    // execution is asynchronously handed off to a pthread.
    // if we're not running an evented main loop, it's time to exit
    exit(ret, /* implicit = */ true);
    return ret;
  }
  catch (e) {
    return handleException(e);
  } finally {
    calledMain = true;

  }
}

function stackCheckInit() {
  // This is normally called automatically during __wasm_call_ctors but need to
  // get these values before even running any of the ctors so we call it redundantly
  // here.
  // TODO(sbc): Move writeStackCookie to native to to avoid this.
  _emscripten_stack_init();
  writeStackCookie();
}

/** @type {function(Array=)} */
function run(args) {
  args = args || arguments_;

  if (runDependencies > 0) {
    return;
  }

  stackCheckInit();

  if (ENVIRONMENT_IS_PTHREAD) {
    initRuntime();
    postMessage({ 'cmd': 'loaded' });
    return;
  }

  preRun();

  // a preRun added a dependency, run will be called later
  if (runDependencies > 0) {
    return;
  }

  function doRun() {
    // run may have just been called through dependencies being fulfilled just in this very frame,
    // or while the async setStatus time below was happening
    if (calledRun) return;
    calledRun = true;
    Module['calledRun'] = true;

    if (ABORT) return;

    initRuntime();

    preMain();

    if (Module['onRuntimeInitialized']) Module['onRuntimeInitialized']();

    if (shouldRunNow) callMain(args);

    postRun();
  }

  if (Module['setStatus']) {
    Module['setStatus']('Running...');
    setTimeout(function() {
      setTimeout(function() {
        Module['setStatus']('');
      }, 1);
      doRun();
    }, 1);
  } else
  {
    doRun();
  }
  checkStackCookie();
}
Module['run'] = run;

function checkUnflushedContent() {
  // Compiler settings do not allow exiting the runtime, so flushing
  // the streams is not possible. but in ASSERTIONS mode we check
  // if there was something to flush, and if so tell the user they
  // should request that the runtime be exitable.
  // Normally we would not even include flush() at all, but in ASSERTIONS
  // builds we do so just for this check, and here we see if there is any
  // content to flush, that is, we check if there would have been
  // something a non-ASSERTIONS build would have not seen.
  // How we flush the streams depends on whether we are in SYSCALLS_REQUIRE_FILESYSTEM=0
  // mode (which has its own special function for this; otherwise, all
  // the code is inside libc)
  var oldOut = out;
  var oldErr = err;
  var has = false;
  out = err = function(x) {
    has = true;
  }
  try { // it doesn't matter if it fails
    var flush = flush_NO_FILESYSTEM;
    if (flush) flush();
  } catch(e) {}
  out = oldOut;
  err = oldErr;
  if (has) {
    warnOnce('stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the FAQ), or make sure to emit a newline when you printf etc.');
    warnOnce('(this may also be due to not including full filesystem support - try building with -s FORCE_FILESYSTEM=1)');
  }
}

/** @param {boolean|number=} implicit */
function exit(status, implicit) {
  EXITSTATUS = status;

  checkUnflushedContent();

  if (!implicit) {
    if (ENVIRONMENT_IS_PTHREAD) {
      err('Pthread 0x' + _pthread_self().toString(16) + ' called exit(), posting exitProcess.');
      // When running in a pthread we propagate the exit back to the main thread
      // where it can decide if the whole process should be shut down or not.
      // The pthread may have decided not to exit its own runtime, for example
      // because it runs a main loop, but that doesn't affect the main thread.
      postMessage({ 'cmd': 'exitProcess', 'returnCode': status });
      throw new ExitStatus(status);
    } else {
      err('main thread called exit: keepRuntimeAlive=' + keepRuntimeAlive() + ' (counter=' + runtimeKeepaliveCounter + ')');
    }
  }

  if (keepRuntimeAlive()) {
    // if exit() was called, we may warn the user if the runtime isn't actually being shut down
    if (!implicit) {
      var msg = 'program exited (with status: ' + status + '), but EXIT_RUNTIME is not set, so halting execution but not exiting the runtime or preventing further async execution (build with EXIT_RUNTIME=1, if you want a true shutdown)';
      err(msg);
    }
  } else {
    PThread.terminateAllThreads();
    exitRuntime();
  }

  procExit(status);
}

function procExit(code) {
  EXITSTATUS = code;
  if (!keepRuntimeAlive()) {
    PThread.terminateAllThreads();
    if (Module['onExit']) Module['onExit'](code);
    ABORT = true;
  }
  quit_(code, new ExitStatus(code));
}

if (Module['preInit']) {
  if (typeof Module['preInit'] == 'function') Module['preInit'] = [Module['preInit']];
  while (Module['preInit'].length > 0) {
    Module['preInit'].pop()();
  }
}

// shouldRunNow refers to calling main(), not run().
var shouldRunNow = false;

if (Module['noInitialRun']) shouldRunNow = false;

if (ENVIRONMENT_IS_PTHREAD) {
  // The default behaviour for pthreads is always to exit once they return
  // from their entry point (or call pthread_exit).  If we set noExitRuntime
  // to true here on pthreads they would never complete and attempt to
  // pthread_join to them would block forever.
  // pthreads can still choose to set `noExitRuntime` explicitly, or
  // call emscripten_unwind_to_js_event_loop to extend their lifetime beyond
  // their main function.  See comment in src/worker.js for more.
  noExitRuntime = false;
  PThread.initWorker();
}

run();





