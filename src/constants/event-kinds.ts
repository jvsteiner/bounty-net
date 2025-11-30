export const EVENT_KINDS = {
  BUG_REPORT: 31337,
  BUG_RESPONSE: 31338,
  BOUNTY: 31339,
} as const;

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];
