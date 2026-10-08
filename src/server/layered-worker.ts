import { parentPort } from 'node:worker_threads';
import { compileGradeInto } from '../shared/colour.js';
import { fillColourLut } from './layered-colour.js';
import { composeRows } from './layered-frame.js';
import type { CompositorReply, CompositorTask } from './layered-pool.js';

const port = parentPort!;
port.on('message', (task: CompositorTask) => {
  let reply: CompositorReply = { error: null };
  try {
    if (task.kind === 'rows') composeRows(task.output, task.width, task.sources, task.start, task.end);
    else fillColourLut(task.lut, compileGradeInto(task.colour), task.start, task.end);
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(reply);
});
