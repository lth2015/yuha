import type { JobView } from '@yuha/contracts';

/**
 * The phases a generation actually reports, in order, and the one place that
 * turns a phase into a fraction.
 *
 * There were two of these before — the home screen listed four phases and the
 * studio listed six — so the same job appeared to make different progress
 * depending on which screen you happened to be on. The API reports these six.
 *
 * `fractionOfPhase` is deliberately coarse and deliberately honest: it is the
 * position of a real, server-reported phase in a real sequence. Nothing here
 * interpolates with a timer, because a bar that keeps moving while the server
 * has gone quiet is a lie about what is happening.
 */
export const JOB_PHASES = [
  'validating',
  'queued',
  'generating',
  'processing',
  'verifying',
  'done',
] as const satisfies readonly JobView['phase'][];

export type JobPhase = (typeof JOB_PHASES)[number];

/** i18n key for a phase's label. */
export function phaseKey(phase: JobView['phase']): string {
  return JOB_PHASES.includes(phase as JobPhase) ? `create.phase.${phase}` : 'create.phase.working';
}

/**
 * 0..1 for the score's written region. An unknown phase (`failed`) returns
 * what has been reached so far rather than snapping to either end.
 */
export function fractionOfPhase(phase: JobView['phase']): number {
  const i = JOB_PHASES.indexOf(phase as JobPhase);
  if (i < 0) return 0.5;
  // The first phase should already show something committed, and only `done`
  // fills the score completely.
  return (i + 1) / JOB_PHASES.length;
}
