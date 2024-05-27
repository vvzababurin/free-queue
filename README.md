# Install free-queue library

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

### Add to profile
```bash
source ./emsdk_env.sh
```

### free-queue library
```bash
git clone https://github.com/vvzababurin/free-queue.git
cd free-queue
```

### Install free-queue examples
```bash
cd examples
npm install
```

### Compile free-queue
```bash
cd ..
chmod +x ./build.sh
./buld.sh
```







