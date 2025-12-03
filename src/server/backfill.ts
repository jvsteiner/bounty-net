import { v4 as uuid } from "uuid";
import { ManagedIdentity } from "../services/identity/manager.js";
import { DatabaseWrapper } from "../storage/database.js";
import {
  SyncStateRepository,
  ReportsRepository,
  ResponsesRepository,
} from "../storage/repositories/index.js";
import {
  BugResponseContentSchema,
  type ResponseType,
} from "../types/events.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("backfill");

const VALID_RESPONSE_TYPES = new Set([
  "acknowledged",
  "accepted",
  "rejected",
  "fix_published",
]);

/**
 * For reporters without a daemon, catch up on responses at startup.
 */
export async function backfillResponses(
  identity: ManagedIdentity,
  db: DatabaseWrapper,
): Promise<void> {
  const syncRepo = new SyncStateRepository(db);
  const reportsRepo = new ReportsRepository(db);
  const responsesRepo = new ResponsesRepository(db);

  // Get last sync time - default to NOW for fresh installs (don't fetch historical data)
  const lastSync =
    syncRepo.get("reporter_last_sync") ?? Math.floor(Date.now() / 1000);

  logger.info(
    `Backfilling responses since ${new Date(lastSync * 1000).toISOString()}`,
  );

  // Query for responses to our sent reports
  const responses = await identity.client.queryResponses(lastSync);

  let count = 0;
  for (const { event, content } of responses) {
    // Skip responses with unknown/old format
    if (!VALID_RESPONSE_TYPES.has(content.response_type)) {
      continue;
    }
    const responseType = content.response_type as ResponseType;

    // Find the original report - must be one we sent
    const report = reportsRepo.findById(content.report_id);
    if (!report || report.sender_pubkey !== identity.client.getPublicKey())
      continue;

    // Check if we already have this response
    const existing = responsesRepo.findByEventId(event.id);
    if (existing) continue;

    // Update report status
    reportsRepo.updateStatus(content.report_id, responseType);

    // Store response
    responsesRepo.create({
      id: uuid(),
      report_id: content.report_id,
      response_type: responseType,
      message: content.message,
      commit_hash: content.commit_hash,
      bounty_paid: content.bounty_paid
        ? parseInt(content.bounty_paid, 10)
        : undefined,
      responder_pubkey: event.pubkey,
      created_at: event.created_at * 1000,
      nostr_event_id: event.id,
    });

    count++;
  }

  // Update sync state
  syncRepo.set("reporter_last_sync", Math.floor(Date.now() / 1000));

  logger.info(`Backfilled ${count} responses`);
}
