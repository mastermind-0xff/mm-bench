/**
 * Entry of the measuring workers. Imports the bench file, which measures
 * one case when it reaches the task's call (see `compare`) and posts the
 * result itself. Only types are imported, so this file starts fast and
 * also runs from the TypeScript sources (in tests); the keys below match
 * `TASK_KEY` and `REACHED_KEY` of `protocol.ts`.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { WorkerMessage, WorkerTask } from './protocol.js';

const task = (workerData as { mmBench: WorkerTask }).mmBench;
const reached = Symbol.for('mm-bench.reached');

const post = (message: WorkerMessage): void => {
  parentPort?.postMessage(message);
};

const describe = (error: unknown): { message: string; stack?: string } => {
  try {
    return error instanceof Error ?
        { message: `${error.name}: ${error.message}`, stack: error.stack ?? '' }
      : { message: String(error) };
  } catch {
    return { message: 'unknown error' };
  }
};

import(task.file).then(
  // the call may come after awaits of earlier calls, which settle right
  // away in a worker: give them a turn of the event loop
  () =>
    setImmediate(() => {
      if (!(reached in globalThis)) post({ type: 'not-reached' });
    }),
  (error: unknown) => {
    post({ type: 'error', ...describe(error) });
  }
);
