// Quick smoke test: connect to Redis, enqueue a test job, consume it, and verify.
import 'dotenv/config';
import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const TEST_QUEUE = 'test-queue-smoke';

async function main() {
  console.log('── Step 1: Test raw Redis connectivity ──');
  console.log(`   REDIS_URL: ${REDIS_URL.replace(/\/\/default:.*@/, '//default:****@')}`);

  const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  try {
    const pong = await redis.ping();
    console.log(`   ✅ Redis PING → ${pong}`);
  } catch (err: any) {
    console.error(`   ❌ Redis PING failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\n── Step 2: Enqueue a test job via BullMQ ──');
  const queue = new Queue(TEST_QUEUE, {
    connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }),
  });

  await queue.add('smoke-test', { hello: 'world', ts: Date.now() });
  console.log('   ✅ Job enqueued');

  console.log('\n── Step 3: Consume the test job via a Worker ──');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Worker did not pick up the job within 10 seconds'));
    }, 10_000);

    const worker = new Worker(
      TEST_QUEUE,
      async (job) => {
        console.log(`   ✅ Worker received job ${job.id}:`);
        console.log(`      data.hello: ${job.data.hello}`);
        console.log(`      data.ts:    ${new Date(job.data.ts).toISOString()}`);
        clearTimeout(timeout);

        // Clean up
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
        resolve();
      },
      {
        connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }),
      }
    );

    worker.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  console.log('\n── All tests passed! ✅ ──');
  console.log('   Redis is reachable, BullMQ can enqueue and consume jobs.');
  
  await redis.quit();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ Test failed: ${err.message}`);
  process.exit(1);
});
