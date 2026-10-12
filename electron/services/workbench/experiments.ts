import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Experiment, ExperimentsData, Trial } from '../../../shared/workbench';
import { load, save } from './local-store';
import { HubError } from '../cli/engine-adapter';
const experiment = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(100), hypothesis: z.string().trim().min(1).max(1000), criterion: z.string().trim().min(1).max(1000), promptA: z.string().trim().min(1).max(2000), promptB: z.string().trim().min(1).max(2000), createdAt: z.iso.datetime() }).strict();
const trial = z.object({ id: z.uuid(), experimentId: z.uuid(), variant: z.enum(['A', 'B']), runId: z.uuid().nullable(), minutes: z.number().min(0).max(1440), rework: z.number().int().min(0).max(1000), outcome: z.enum(['successful', 'partial', 'failed']), evidence: z.string().trim().min(1).max(2000), createdAt: z.iso.datetime() }).strict();
const schema = z.discriminatedUnion('action', [z.object({ action: z.literal('experiment-list') }).strict(), experiment.omit({ id: true, createdAt: true }).extend({ action: z.literal('experiment-save') }).strict(), trial.omit({ id: true, createdAt: true }).extend({ action: z.literal('trial-add') }).strict()]);
export class Experiments {
  constructor(private root: string, private knownRun: (id: string) => boolean) {}
  private data(): ExperimentsData { return load(this.root, 'experiments.json', z.object({ experiments: z.array(experiment).max(100), trials: z.array(trial).max(1000) }).strict(), { experiments: [], trials: [] }); }
  execute(input: unknown): ExperimentsData | Experiment | Trial {
    const request = schema.parse(input); const data = this.data(); if (request.action === 'experiment-list') return data;
    if (request.action === 'experiment-save') { if (data.experiments.length >= 100) throw new HubError('EXPERIMENT_LIMIT', 'Up to 100 experiments are supported.'); const { action: _action, ...fields } = request; const record = { ...fields, id: randomUUID(), createdAt: new Date().toISOString() }; save(this.root, 'experiments.json', { ...data, experiments: [...data.experiments, record] }); return record; }
    if (!data.experiments.some((e) => e.id === request.experimentId)) throw new HubError('EXPERIMENT_MISSING', 'Select an available experiment.');
    if (request.runId && !this.knownRun(request.runId)) throw new HubError('EXPERIMENT_RUN', 'Choose a recorded local session run.');
    if (request.runId && data.trials.some((t) => t.experimentId === request.experimentId && t.runId === request.runId)) throw new HubError('EXPERIMENT_RUN', 'This run is already recorded in this experiment.');
    if (data.trials.length >= 1000) throw new HubError('EXPERIMENT_LIMIT', 'Up to 1,000 trials are supported.');
    const { action: _action, ...fields } = request; const record = { ...fields, id: randomUUID(), createdAt: new Date().toISOString() }; save(this.root, 'experiments.json', { ...data, trials: [...data.trials, record] }); return record;
  }
}
