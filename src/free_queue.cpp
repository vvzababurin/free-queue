#include <emscripten.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <unistd.h> 

int treads_busy = 1;

pthread_t tid_consumer = 0;
pthread_t tid_producer = 0;

struct FreeQueue {
  size_t buffer_length;
  size_t channel_count;
  double **channel_data;
  atomic_uint *state;
};

struct FreeQueueThread {
  struct FreeQueue* instance;
  int busy;
};

/**
 * An index set for shared state fields.
 * @enum {number}
 */
enum FreeQueueState {
  /** @type {number} A shared index for reading from the queue. (consumer) */
  READ = 0,
  /** @type {number} A shared index for writing into the queue. (producer) */
  WRITE = 1
};

void *producer( void *arg ); 
void *consumer( void *arg );

static pthread_mutex_t tasks_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct FreeQueueThread memorydata;

uint32_t _getAvailableRead(
  struct FreeQueue *queue, 
  uint32_t read_index, 
  uint32_t write_index
) {  
  if (write_index >= read_index)
    return write_index - read_index;
  
  return write_index + queue->buffer_length - read_index;
}

uint32_t _getAvailableWrite(
  struct FreeQueue *queue, 
  uint32_t read_index, 
  uint32_t write_index
) {
  if (write_index >= read_index)
    return queue->buffer_length - write_index + read_index - 1;
  return read_index - write_index - 1;
}

#ifdef __cplusplus
extern "C" {
#endif

EMSCRIPTEN_KEEPALIVE
struct FreeQueue *CreateFreeQueue(size_t length, size_t channel_count) {
  struct FreeQueue *queue = (struct FreeQueue *)malloc(sizeof(struct FreeQueue));
  queue->buffer_length = length + 1;
  queue->channel_count = channel_count;
  queue->state = (atomic_uint *)malloc(2 * sizeof(atomic_uint));
  atomic_store(queue->state + READ, 0);
  atomic_store(queue->state + WRITE, 0);
  queue->channel_data = (double **)malloc(channel_count * sizeof(double *));
  for (int i = 0; i < channel_count; i++) {
    queue->channel_data[i] = (double *)malloc(queue->buffer_length * sizeof(double));
    for (int j = 0; j < queue->buffer_length; j++) {
      queue->channel_data[i][j] = 0;
    }
  }
  return queue;
}

EMSCRIPTEN_KEEPALIVE
void DestroyFreeQueue(struct FreeQueue *queue) {
  if ( queue != nullptr ) {
    for (int i = 0; i < queue->channel_count; i++) {
      free(queue->channel_data[i]);
    }
    free(queue->channel_data);
    free(queue);
  }
}

EMSCRIPTEN_KEEPALIVE
bool FreeQueuePush(struct FreeQueue *queue, double **input, size_t block_length) {
  if ( queue != nullptr ) {
    uint32_t current_read = atomic_load(queue->state + READ);
    uint32_t current_write = atomic_load(queue->state + WRITE);
    if (_getAvailableWrite(queue, current_read, current_write) < block_length) {
      return false;
    }
    for (uint32_t i = 0; i < block_length; i++) {
      for (uint32_t channel = 0; channel < queue->channel_count; channel++) {
        queue->channel_data[channel][(current_write + i) % queue->buffer_length] = 
            input[channel][i];
      }
    }
    uint32_t next_write = (current_write + block_length) % queue->buffer_length;
    atomic_store(queue->state + WRITE, next_write);
    return true;
  }
  return false;
}

EMSCRIPTEN_KEEPALIVE
bool FreeQueuePull(struct FreeQueue *queue, double **output, size_t block_length) {
  if ( queue != nullptr ) {
    uint32_t current_read = atomic_load(queue->state + READ);
    uint32_t current_write = atomic_load(queue->state + WRITE);

    if (_getAvailableRead(queue, current_read, current_write) < block_length) {
      return false;
    }

    for (uint32_t i = 0; i < block_length; i++) {
      for (uint32_t channel = 0; channel < queue->channel_count; channel++) {
        output[channel][i] = 
            queue->channel_data[channel][(current_read + i) % queue->buffer_length];
      }
    }

    uint32_t nextRead = (current_read + block_length) % queue->buffer_length;
    atomic_store(queue->state + READ, nextRead);
    return true;
  }
  return false;
}

EMSCRIPTEN_KEEPALIVE
void *GetFreeQueuePointers( struct FreeQueue* queue, char* data ) 
{
  if ( queue != nullptr ) {
    if (strcmp(data, "buffer_length") == 0) {
      return ( void* )&queue->buffer_length;
    }
    else if (strcmp(data, "channel_count") == 0) {
      return ( void* )&queue->channel_count;
    }
    else if (strcmp(data, "state") == 0) {
      return ( void* )&queue->state;
    }
    else if (strcmp(data, "channel_data") == 0) {
      return ( void* )&queue->channel_data;
    }
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE 
void DestroyFreeQueueThreads() {
  if ( memorydata.instance != nullptr )
  {
    memorydata.busy = 0;

    pthread_join(tid_producer, 0);
    pthread_join(tid_consumer, 0);

    DestroyFreeQueue( memorydata.instance );
    memorydata.instance = nullptr;
  }
}

EMSCRIPTEN_KEEPALIVE 
struct FreeQueue *GetFreeQueueThreads() {
  if ( memorydata.instance != nullptr ) {
    return memorydata.instance;
  }
  return nullptr;
}

EMSCRIPTEN_KEEPALIVE 
int CreateFreeQueueThreads() {
  uint32_t channel_count = 2;
  uint32_t length = 1764;
  memorydata.busy = 1;
  memorydata.instance = CreateFreeQueue( length * 500, channel_count );
  int p = 0;
  p = pthread_create( &tid_consumer, 0, consumer, &memorydata );
  if ( p ) {
    return -1;
  }
  printf( "CreateThreads: consumer thread created...\n" );
  p = pthread_create( &tid_producer, 0, producer, &memorydata );
  if ( p ) {
    return -1;
  }
  printf( "CreateThreads: producer thread created...\n" );
  return 0;
}

EMSCRIPTEN_KEEPALIVE 
void PrintQueueInfo(struct FreeQueue *queue) {
  if ( queue != nullptr ) {
    uint32_t current_read = atomic_load(queue->state + READ);
    uint32_t current_write = atomic_load(queue->state + WRITE);
    for (uint32_t channel = 0; channel < queue->channel_count; channel++) {
      printf("channel %d: ", channel);
      for (uint32_t i = 0; i < queue->buffer_length; i++) {
        printf("%f ", queue->channel_data[channel][i]);
      }
      printf("\n");
    }
    printf("----------\n");
    printf("current_read: %u  | current_write: %u\n", current_read, current_write);
    printf("available_read: %u  | available_write: %u\n", 
        _getAvailableRead(queue, current_read, current_write), 
        _getAvailableWrite(queue, current_read, current_write));
    printf("----------\n");
  }
}

EMSCRIPTEN_KEEPALIVE 
void PrintQueueAddresses(struct FreeQueue *queue) {
  if ( queue != nullptr ) {
    printf("buffer_length: %p   uint: %zu\n", 
        &queue->buffer_length, (size_t)&queue->buffer_length);
    printf("channel_count: %p   uint: %zu\n", 
        &queue->channel_count, (size_t)&queue->channel_count);
    printf("state       : %p   uint: %zu\n", 
        &queue->state, (size_t)&queue->state);
    printf("channel_data    : %p   uint: %zu\n", 
        &queue->channel_data, (size_t)&queue->channel_data);
    for (uint32_t channel = 0; channel < queue->channel_count; channel++) {
        printf("channel_data[%d]    : %p   uint: %zu\n", channel,
            &queue->channel_data[channel], (size_t)&queue->channel_data[channel]);
    }
    printf("state[0]    : %p   uint: %zu\n", 
        &queue->state[0], (size_t)&queue->state[0]);
    printf("state[1]    : %p   uint: %zu\n", 
        &queue->state[1], (size_t)&queue->state[1]);
  }
}

#ifdef __cplusplus
}
#endif

// store data
void *producer( void *arg ) 
{
  struct FreeQueueThread* f = (struct FreeQueueThread*)arg;
  struct FreeQueue* instance = f->instance;
  uint32_t channel_count = instance->channel_count;
  uint32_t buffer_length = instance->buffer_length;
  uint32_t length = 1764;
  printf( "producer: [ buffer length is %d; channel count is %d ]\n", buffer_length, channel_count );
  while ( f->busy ) {  
    double** input = (double **)malloc(channel_count * sizeof(double *));
    for (int i = 0; i < channel_count; i++) {
      input[i] = (double *)malloc(length * sizeof(double));
      for (int j = 0; j < length; j++) {
        input[i][j] = ( i % 2 ) ? -rand() : rand();
      }
    }
    uint32_t current_read = atomic_load(instance->state + READ);
    uint32_t current_write = atomic_load(instance->state + WRITE);
    while( _getAvailableWrite(instance, current_read, current_write) > ( length * 450 ) && f->busy ) { 
      for (int i = 0; i < channel_count; i++) {
        for (int j = 0; j < length; j++) {
          input[i][j] = ( i % 2 ) ? -rand() : rand();
        }
      }
      current_read = atomic_load(instance->state + READ);
      current_write = atomic_load(instance->state + WRITE);
      pthread_mutex_lock( &tasks_mutex );
      //printf( "producer: [ read is %d; write is %d ]\n", current_read, current_write );
      //printf( "producer: [ length is %d ]\n", length );
      ////////////////////////////////////////////////////////////////////////////////////////
      bool rc = FreeQueuePush(instance, input, length);
      //printf( "FreeQueuePush: %s\n", ( rc == true ) ? "true" : "false" );
      ////////////////////////////////////////////////////////////////////////////////////////
      pthread_mutex_unlock( &tasks_mutex );
      usleep( 40 * 1000 ); // 40ms 1fps
    }
    for (int i = 0; i < channel_count; i++) free( input[i] );
    free( input );
  }  
  printf( "producer: exit thread\n" );
  return 0;
}

// load data
void *consumer( void *arg )
{
  struct FreeQueueThread* f = (struct FreeQueueThread*)arg;
  struct FreeQueue* instance = f->instance;
  uint32_t channel_count = instance->channel_count;
  uint32_t buffer_length = instance->buffer_length;
  uint32_t length = 1764;
  printf( "consumer: [ buffer length is %d; channel count is %d ]\n", buffer_length, channel_count );
  while ( f->busy ) 
  {
    double** output = (double **)malloc(channel_count * sizeof(double *));
    for (int i = 0; i < channel_count; i++) {
      output[i] = (double *)malloc(length * sizeof(double));
      for (int j = 0; j < length; j++) {
        output[i][j] = 0;
      }
    }    
    uint32_t current_read = atomic_load(instance->state + READ);
    uint32_t current_write = atomic_load(instance->state + WRITE);
    while( _getAvailableRead(instance, current_read, current_write) > 0 && f->busy ) {
      current_read = atomic_load(instance->state + READ);
      current_write = atomic_load(instance->state + WRITE);
      pthread_mutex_lock( &tasks_mutex );
      //printf( "consumer: [ read is %d; write is %d ]\n", current_read, current_write );
      ////////////////////////////////////////////////////////////////////////////////////////
      bool rc = FreeQueuePull(instance, output, length);
      //printf( "FreeQueuePull: %s\n", ( rc == true ) ? "true" : "false" );
      ////////////////////////////////////////////////////////////////////////////////////////
      pthread_mutex_unlock( &tasks_mutex );
      usleep( 120 * 1000 ); // 120ms 3fps
    }
    for (int i = 0; i < channel_count; i++) free( output[i] );
    free( output );
  }  
  printf( "consumer: exit thread\n" );
  return 0;
}
int main( int argc, char* argv[] )
{
  return CreateFreeQueueThreads();
}

