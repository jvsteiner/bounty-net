export const COINS = {
  ALPHA: "414c504841",
} as const;

export type CoinId = (typeof COINS)[keyof typeof COINS];

export const DEFAULT_RELAY = "wss://nostr-relay.testnet.unicity.network";

export const DEFAULT_AGGREGATOR_URL =
  "https://goggregator-test.unicity.network";
