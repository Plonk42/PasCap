import { parentPort } from 'node:worker_threads';
import { measureFrames } from './motion.js';
import type { MotionReply, MotionTask } from './motion-pool.js';

const port = parentPort!;
port.on('message', (task: MotionTask) => {
  let reply: MotionReply;
  try {
    reply = { error: null, motions: measureFrames(task.frames, task.withPrevious) };
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
});
