import 'dotenv/config';
import { Queue, Worker, QueueOptions, WorkerOptions, Processor } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from './logger';

const configuredRedisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

function normalizeRedisUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'redis:' && url.hostname.endsWith('.upstash.io')) {
      url.protocol = 'rediss:';
    }
    return url.toString();
  } catch {
    return value;
  }
}

const REDIS_URL = normalizeRedisUrl(configuredRedisUrl);

// Initialize Redis connection for the Queue (producer side).
// BullMQ requires maxRetriesPerRequest to be null.
export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const DESCRIPTION_QUEUE_NAME = 'description-fetch-queue';

// The centralized queue for all description fetching
export const descriptionQueue = new Queue(DESCRIPTION_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  }
});

/**
 * Helper to create a worker for the description queue.
 * Each Worker needs its own IORedis instance (BullMQ requirement).
*/
export function createDescriptionWorker(
  processor: Processor,
  options?: Omit<WorkerOptions, 'connection'>
) {
  const workerConnection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker(DESCRIPTION_QUEUE_NAME, processor, {
    connection: workerConnection,
    concurrency: 5, // Default concurrency
    ...options,
  });

  worker.on('error', (err) => {
    logger.error(`[BullMQ] Worker Error: ${err.message}`);
  });

  worker.on('failed', (job, err) => {
    if (job) {
      logger.warn(`[BullMQ] Job ${job.id} failed: ${err.message}`);
    }
  });

  return worker;
}

