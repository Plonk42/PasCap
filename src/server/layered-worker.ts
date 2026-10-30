import { parentPort } from 'node:worker_threads';
import { compileGradeChain } from '../shared/grade.js';
import { fillColorLut } from './layered-color.js';
import { composeRows } from './layered-frame.js';
import type { CompositorReply, CompositorTask } from './layered-pool.js';

const port = parentPort!;
port.on('message', (task: CompositorTask) => {
  let reply: CompositorReply = { error: null };
  try {
    if (task.kind === 'rows') composeRows(task.output, task.width, task.sources, task.start, task.end);
    else fillColorLut(task.lut, compileGradeChain(task.stages), task.start, task.end);
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
});
