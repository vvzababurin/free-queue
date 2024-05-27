# Install free-queue library


## Configure emscripten SDK
### Emscripten SDK
```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
```

### Emscripten SDK: Install and activate SDK 2.0.28
```bash
git pull
./emsdk install 2.0.28
./emsdk activate 2.0.28
```

### Add environment to profile
```bash
source ./emsdk_env.sh
```

## Configure free-queue library
### free-queue library
```bash
git clone https://github.com/vvzababurin/free-queue.git
cd free-queue
```

### Install free-queue modules for examples
```bash
cd examples
npm install
```

### Assign rights to ./build.sh
```bash
cd ..
chmod +x ./build.sh
```

### Compile and run free-queue Demo
```bash
./build.sh
```







