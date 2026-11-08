// Runs a Monte Carlo simulation off the event loop (PF-037). The engine is pure, so the worker needs only the project JSON.
import { parentPort, workerData } from 'node:worker_threads';
import { simulate } from '../../engine/src/index.ts';

const { project, iterations, seed } = workerData as { project: Parameters<typeof simulate>[0]; iterations: number; seed: number };
parentPort!.postMessage(simulate(project, iterations, seed));
