import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { escapeControls } from './format.js';
import { MachineProbe } from './machine.js';
import { TASK_KEY, type WorkerMessage, type WorkerTask } from './protocol.js';
import type { MeasuredSample } from './report.js';

/** The worker entry next to this module: `.js`, `.cjs` or `.ts` (tests). */
const WORKER_ENTRY = new URL(
  `./worker${extname(fileURLToPath(import.meta.url))}`,
  import.meta.url
);

/** Longest delay `setTimeout` takes; longer timeouts never fire. */
const MAX_TIMEOUT = 2 ** 31 - 1;
/** Characters of a worker's stderr kept for error messages. */
const STDERR_TAIL = 4096;

export interface SampleRunOptions {
  /** Name of the case, for messages. */
  readonly name: string;
  /** Milliseconds without progress before the worker is stopped. */
  readonly timeout: number;
}

const workerError = (
  message: string,
  cause?: { message: string; stack?: string | undefined }
): Error => {
  if (cause === undefined) return new Error(message);
  const error = new Error(cause.message);
  if (cause.stack !== undefined) error.stack = cause.stack;
  return new Error(message, { cause: error });
};

/**
 * Measures one sample in a fresh worker, probing the machine's cores
 * meanwhile (see `MachineProbe`). The worker's stdout is dropped (the bench
 * file runs again there, and its logs would repeat); the end of its stderr
 * is added to errors.
 *
 * @throws Error when the case throws, the worker dies, never reaches the
 * call or makes no progress for `timeout` milliseconds.
 */
export const runSample = (
  task: WorkerTask,
  { name, timeout }: SampleRunOptions
): Promise<MeasuredSample> =>
  new Promise((resolve, reject) => {
    const machine = new MachineProbe();
    const worker = new Worker(WORKER_ENTRY, {
      workerData: { [TASK_KEY]: task },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    let stderr = '';
    worker.stderr.setEncoding('utf8');
    worker.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    const label = `"${escapeControls(name)}" (sample ${String(task.sample + 1)})`;
    const withStderr = (message: string): string =>
      stderr.trim() === '' ?
        message
      : `${message}\nWorker stderr:\n${stderr.trimEnd()}`;

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (
      error: Error | undefined,
      result?: MeasuredSample
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      machine.stop();
      void worker.terminate();
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
    };
    const watch = (): void => {
      clearTimeout(timer);
      if (timeout <= MAX_TIMEOUT)
        timer = setTimeout(() => {
          settle(
            workerError(
              withStderr(
                `mm-bench: ${label} made no progress for ${String(timeout)} ms, so its worker was stopped.`
              )
            )
          );
        }, timeout);
    };
    watch();

    worker.on('message', (message: WorkerMessage) => {
      switch (message.type) {
        case 'progress':
          watch();
          break;
        case 'result': {
          machine.take();
          const { async, sample, start } = message;
          const end = start + BigInt(Math.round(sample.outerTime));
          settle(undefined, {
            async,
            sample: { ...sample, machine: machine.ticks(start, end) },
          });
          break;
        }
        case 'error':
          settle(
            workerError(
              withStderr(`mm-bench: ${label} failed: ${message.message}`),
              message
            )
          );
          break;
        case 'not-reached':
          settle(
            workerError(
              `mm-bench: the worker imported ${task.file} but never reached the call measuring ${label}. The workers run the entry script by default: pass { file: import.meta.url } when the call is in another file or the script is started by a tool (test runner, REPL), and keep the cases the same on every run.`
            )
          );
          break;
      }
    });
    worker.on('error', (error) => {
      settle(workerError(withStderr(`mm-bench: ${label} failed.`), error));
    });
    worker.on('exit', (code) => {
      settle(
        workerError(
          withStderr(
            // 13: unsettled top-level await
            code === 0 || code === 13 ?
              `mm-bench: the worker of ${label} ran out of work before the case finished: does the case return a promise that never settles?`
            : `mm-bench: the worker of ${label} exited with code ${String(code)} before finishing.`
          )
        )
      );
    });
  });
