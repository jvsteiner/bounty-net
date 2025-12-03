import { NostrClient, Filter, CallbackEventListener } from '@unicitylabs/nostr-js-sdk';

const client = new NostrClient(['wss://nostr-relay.testnet.unicity.network']);
await client.connect();

// Query ALL kind 31337 events - no author/ptag filter
const filter = Filter.builder()
  .kinds(31337)
  .since(Math.floor(Date.now()/1000) - 86400)
  .limit(10)
  .build();

console.log('Filter:', JSON.stringify(filter));

const events = [];
const listener = new CallbackEventListener(
  async (event) => {
    events.push(event);
    console.log('Event:', event.id.slice(0,16), 'kind:', event.kind, 'at', new Date(event.created_at * 1000).toISOString());
  },
  () => {
    console.log('EOSE - Total events:', events.length);
    client.disconnect();
    process.exit(0);
  }
);

client.subscribe(filter, listener);

setTimeout(() => {
  console.log('Timeout - Total events:', events.length);
  process.exit(0);
}, 5000);
