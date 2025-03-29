
#pragma once

#ifndef __AIENGINE_FREEQUEUE__
#define __AIENGINE_FREEQUEUE__

#include <atomic>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct FQ_FreeQueue {
  uint32_t buffer_length;
  uint32_t channel_count;
  float **channel_data;
  std::atomic<unsigned int> *state;
};

enum FQ_FreeQueueState {
  /** @type {number} A shared index for reading from the queue. (consumer) */
  READ = 0,
  /** @type {number} A shared index for writing into the queue. (producer) */
  WRITE = 1
};

struct FQ_FreeQueue *FQ_FreeQueueCreate(uint32_t length, uint32_t channel_count);
bool FQ_FreeQueueClear(struct FQ_FreeQueue* queue);
void FQ_FreeQueueResetReadCounter(struct FQ_FreeQueue* queue);
void FQ_FreeQueueResetWriteCounter(struct FQ_FreeQueue* queue);
size_t FQ_FreeQueueGetReadCounter(struct FQ_FreeQueue* queue);
size_t FQ_FreeQueueGetWriteCounter(struct FQ_FreeQueue* queue);
void FQ_FreeQueueSetReadCounter(struct FQ_FreeQueue* queue, size_t counter);
void FQ_FreeQueueSetWriteCounter(struct FQ_FreeQueue* queue, size_t counter);
void FQ_FreeQueueDestroy(struct FQ_FreeQueue* queue);
bool FQ_FreeQueuePush(struct FQ_FreeQueue *queue, float **input, size_t block_length);
bool FQ_FreeQueuePushBack(struct FQ_FreeQueue* queue, float** input, size_t block_length);
bool FQ_FreeQueuePushFront(struct FQ_FreeQueue* queue, float** input, size_t block_length);
bool FQ_FreeQueuePushTo(struct FQ_FreeQueue* queue, float** input, size_t begin_index, size_t block_length);
size_t FQ_FreeQueuePull(struct FQ_FreeQueue *queue, float **output, size_t block_length, bool increment = true);
size_t FQ_FreeQueuePullBack(struct FQ_FreeQueue *queue, float **output, size_t block_length, bool increment = true);
size_t FQ_FreeQueuePullFront(struct FQ_FreeQueue* queue, float** output, size_t block_length, bool increment = true);
size_t FQ_FreeQueuePullFrom(struct FQ_FreeQueue* queue, float** input, size_t begin_index, size_t block_length, bool increment = true);
void FQ_PrintQueueInfo(struct FQ_FreeQueue *queue);
void FQ_PrintQueueAddresses(struct FQ_FreeQueue *queue);

#endif // __AIENGINE_FREEQUEUE__
