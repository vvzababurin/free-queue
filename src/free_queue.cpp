#include <emscripten.h>
#include "free_queue.h"

#define WASM_CODE_VERSION	"0.5.2"

static uint32_t _getAvailableRead(
  struct FreeQueue *queue, 
  uint32_t read_index, 
  uint32_t write_index
) {  
  if (write_index >= read_index)
    return write_index - read_index;
  
  return write_index + queue->buffer_length - read_index;
}

static uint32_t _getAvailableWrite(
  struct FreeQueue *queue, 
  uint32_t read_index, 
  uint32_t write_index
) {
  if (write_index >= read_index)
    return queue->buffer_length - write_index + read_index - 1;
  
  return read_index - write_index - 1;
}

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
  for (int i = 0; i < queue->channel_count; i++) {
    free(queue->channel_data[i]);
  }
  free(queue->channel_data);
  free(queue);
}

EMSCRIPTEN_KEEPALIVE
bool FreeQueuePush(struct FreeQueue *queue, double **input, size_t block_length) {
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

EMSCRIPTEN_KEEPALIVE
bool FreeQueuePull(struct FreeQueue *queue, double **output, size_t block_length) {
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

EMSCRIPTEN_KEEPALIVE
void *GetFreeQueuePointers(struct FreeQueue *queue, char *data) {
  if (strcmp(data, "buffer_length") == 0) {
    return &queue->buffer_length;
  }
  else if (strcmp(data, "channel_count") == 0) {
    return &queue->channel_count;
  }
  else if (strcmp(data, "channel_data") == 0) {
    return &queue->channel_data;
  }
  else if (strcmp(data, "state") == 0) {
    return &queue->state;
  }

  return 0;
}

EMSCRIPTEN_KEEPALIVE void PrintQueueInfo(struct FreeQueue *queue) {
  for (uint32_t channel = 0; channel < queue->channel_count; channel++) {
    printf("channel %d: ", channel);
    for (uint32_t i = 0; i < queue->buffer_length; i++) {
      printf("%f ", queue->channel_data[channel][i]);
    }
    printf("\n");
  }

  uint32_t current_read = atomic_load(queue->state + READ);
  uint32_t current_write = atomic_load(queue->state + WRITE);

  printf("----------\n");
  printf("current_read: %u  | current_write: %u\n", current_read, current_write);
  printf("available_read: %u  | available_write: %u\n", 
      _getAvailableRead(queue, current_read, current_write), 
      _getAvailableWrite(queue, current_read, current_write));

  printf("----------\n");
}

EMSCRIPTEN_KEEPALIVE void PrintQueueAddresses(struct FreeQueue *queue) {
  printf("buffer_length: %p   uint: %zu\n", 
      &queue->buffer_length, (size_t)&queue->buffer_length);
  printf("channel_count: %p   uint: %zu\n", 
      &queue->channel_count, (size_t)&queue->channel_count);
  printf("state       : %p   uint: %zu\n", 
      &queue->state, (size_t)&queue->state);
  printf("channel_data    : %p   uint: %zu\n", 
      &queue->channel_data, (size_t)&queue->channel_data);
  printf("state[0]    : %p   uint: %zu\n", 
      &queue->state[0], (size_t)&queue->state[0]);
  printf("state[1]    : %p   uint: %zu\n", 
      &queue->state[1], (size_t)&queue->state[1]);
}

static struct FreeQueue* instance = null;

static struct FreeQueue* getInstance(size_t length = 1764, size_t channel_count = 2)
{
	if ( instance != null ) {
		return instance;		
	} else { 
		instance = CreateFreeQueue(size_t length, size_t channel_count);
	}
	return instance;
}

int main( int argc, char* argv[] )
{
	return 0;
}
