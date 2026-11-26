import { z } from 'zod';

/** Music Gift Invitation (docs/GIFT_INVITATION_PLAN.md). Limits in code points. */
export const GIFT_THEMES = ['warm', 'romantic', 'celebration'] as const;
export const GIFT_NAME_MAX = 30;
export const GIFT_MESSAGE_MAX = 300;

const cp = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .refine((s) => [...s].length <= max, { message: `at most ${max} characters` });
/** The message keeps its line breaks: it is a letter. */
const letter = z
  .string()
  .transform((s) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim())
  .refine((s) => [...s].length <= GIFT_MESSAGE_MAX, { message: `at most ${GIFT_MESSAGE_MAX} characters` });

export const giftInvitationRequest = z.object({
  recipientName: cp(GIFT_NAME_MAX).refine((s) => s.length > 0, { message: 'who it is for is required' }),
  senderName: cp(GIFT_NAME_MAX).default(''),
  message: letter.default(''),
  theme: z.enum(GIFT_THEMES).default('warm'),
});
export type GiftInvitationRequest = z.infer<typeof giftInvitationRequest>;

export const giftInvitationPatch = z.object({
  recipientName: cp(GIFT_NAME_MAX).refine((s) => s.length > 0, { message: 'who it is for is required' }).optional(),
  senderName: cp(GIFT_NAME_MAX).optional(),
  message: letter.optional(),
  theme: z.enum(GIFT_THEMES).optional(),
});

/** What an anonymous recipient's browser is told: the words and the song, nothing that identifies anybody or anything stored. */
export interface PublicGiftView {
  recipientName: string;
  senderName: string;
  message: string;
  theme: (typeof GIFT_THEMES)[number];
  song: {
    title: string;
    durationSeconds: number;
    coverSeed: number;
    styles: string[];
    vocalMode: 'instrumental' | 'with_vocals';
    lyrics: string | null;
  };
}

export const GIFT_EVENTS = ['view', 'play_start', 'play_complete', 'cta_click', 'share'] as const;
export const giftEventRequest = z.object({
  name: z.enum(GIFT_EVENTS),
  /** A random id the browser keeps, so one visitor's refreshes count once a day. Hashed before it is stored. */
  visitor: z.string().min(8).max(64),
});
