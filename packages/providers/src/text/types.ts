import type { MusicIntent } from '@yuha/contracts';

export interface TextUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Modelled cost in JPY minor units; flagged as an estimate unless the vendor returns one. */
  costMinor: number;
  costIsEstimate: boolean;
}

export type IntentResult =
  | { status: 'ok'; intent: MusicIntent; requestId: string | null; usage: TextUsage; repaired: boolean }
  /** The model itself declined (safety filter). Not a technical failure. */
  | { status: 'refused'; requestId: string | null; usage: TextUsage; reason: string }
  | { status: 'failed'; requestId: string | null; usage: TextUsage; code: string; message: string };

export interface IntentRequest {
  /** Derived internally from the style tags; used for demo fixture selection. */
  scene: string;
  /** Untrusted user text. Adapters must treat it as data, never as instructions (AI-03). */
  prompt: string;
  energy: number;
  durationSeconds: number;
  /** simple = description only; custom = lyrics + style tags supplied by the creator. */
  mode: 'simple' | 'custom';
  /** Style tags chosen on the create screen. */
  styles: string[];
  /** true when the song must have no vocals. */
  instrumental: boolean;
  /** Custom-mode lyrics, already screened by the same safety filter as the prompt. */
  lyrics: string | null;
  /** Creator-supplied title, when there is one. */
  title: string | null;
}

export interface ReviseRequest {
  /** What the creator wants changed, in their own words (already safety-screened). */
  instructions: string;
  original: {
    title: string | null;
    styles: string[];
    lyrics: string | null;
    instrumental: boolean;
    durationSeconds: number;
  };
}

export type ReviseResult =
  | { status: 'ok'; title: string | null; styles: string[]; lyrics: string | null; usage: TextUsage }
  | { status: 'refused'; reason: string; usage: TextUsage }
  | { status: 'failed'; reason: string; usage: TextUsage };

export interface TextProvider {
  readonly providerId: string;
  readonly model: string;
  extractIntent(req: IntentRequest): Promise<IntentResult>;
  /** Track editing: rewrite lyrics/styles per instructions. Optional — small local providers may omit it. */
  reviseSong?(req: ReviseRequest): Promise<ReviseResult>;
}
