/**
 * NOSTR types - Re-exports from @unicitylabs/nostr-js-sdk
 * with additional bounty-net specific types
 */

// Re-export SDK types
export type {
  SignedEventData as NostrEvent,
  UnsignedEventData,
  EventTag,
  FilterData as NostrFilter,
} from "@unicitylabs/nostr-js-sdk";

export type { NostrEventListener } from "@unicitylabs/nostr-js-sdk";

// Re-export SDK classes
export {
  Event,
  Filter,
  NostrKeyManager,
  NostrClient,
  CallbackEventListener,
} from "@unicitylabs/nostr-js-sdk";

// Subscription callback (simplified)
export type EventCallback = (
  event: import("@unicitylabs/nostr-js-sdk").Event,
) => void;
