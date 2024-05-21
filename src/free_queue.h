#ifndef FREE_QUEUE_C_H_
#define FREE_QUEUE_C_H_

#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * FreeQueue C Struct
 */
struct FreeQueue {
  size_t buffer_length;
  size_t channel_count;
  atomic_uint *state;
  double **channel_data;
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

/**
 * C API for implementing and acessing FreeQueue.
 */
/**
 * Create a FreeQueue and returns pointer.
 * Takes length of FreeQueue and channel Count as parameters.
 * Returns pointer to created FreeQueue.
 */
EMSCRIPTEN_KEEPALIVE 
struct FreeQueue *CreateFreeQueue(size_t length, size_t channel_count);

/**
 * Push new data to FreeQueue.
 * Takes pointer to FreeQueue, pointer to input data,
 * and block length as parameters.
 * Returns if operation was successful or not as boolean.
 */
EMSCRIPTEN_KEEPALIVE 
bool FreeQueuePush(struct FreeQueue *queue, double **input, size_t block_length);

/**
 * Pull data from FreeQueue.
 * Takes pointer to FreeQueue, pointer to output buffers, 
 * and block length as parameters.
 * Returns if operation was successful or not as boolean.
 */
EMSCRIPTEN_KEEPALIVE 
bool FreeQueuePull(struct FreeQueue *queue, double **output, size_t block_length);

/**
 * Destroy FreeQueue.
 * Takes pointer to FreeQueue as parameter.
 */
EMSCRIPTEN_KEEPALIVE 
void DestroyFreeQueue(struct FreeQueue *queue);

/**
 * Helper Function to get Pointers to data members of FreeQueue Struct.
 * Takes pointer to FreeQueue, and char* string refering to data member to query.
 */
EMSCRIPTEN_KEEPALIVE 
void *GetFreeQueuePointers(struct FreeQueue *queue, char *data);

#ifdef __cplusplus
}
#endif
#endif
