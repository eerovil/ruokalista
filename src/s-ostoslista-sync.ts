import { SOstoslistaError, type SOstoslistaKey } from "./s-ostoslista.ts";
import {
  forgetSentNote,
  rememberSentNote,
  sentNotes,
} from "./s-ostoslista-notes.ts";
import type { ShoppingItem } from "./shopping.ts";

/**
 * The part of the S-ostoslista client the reconciliation workflow needs.
 *
 * Kept structural on purpose: `SOstoslistaClient` is the production adapter,
 * while focused tests can supply a tiny fake without knowing HTTP at all.
 */
export interface SOstoslistaSyncClient {
  add(key: SOstoslistaKey, quantity?: number | null): Promise<unknown>;
  remove(key: SOstoslistaKey): Promise<unknown>;
  sync(): Promise<void>;
}

/** Only the shopping-row facts that can change what is sent externally. */
export type SOstoslistaSendItem = Pick<
  ShoppingItem,
  "key" | "name" | "total" | "chosen"
>;

export type SOstoslistaSendOutcome =
  | {
      status: "sent";
      sent: number;
      total: number;
      synced: true;
    }
  | {
      status: "sent";
      sent: number;
      total: number;
      synced: false;
      syncError: unknown;
    }
  | {
      status: "partial";
      sent: number;
      total: number;
      error: unknown;
    };

/**
 * Reconcile one freshly-computed Ruokalista shopping list into S-ostoslista.
 *
 * This owns the retry contract rather than the screen that happens to invoke it:
 *
 * - one external EAN row receives the aggregate packet count across local rows;
 * - a text row is remembered by its exact sent words, so only our own note can
 *   later be removed;
 * - replacements are add-first, delete-second, remember/forget-last, making a
 *   retry safe after every interruption point;
 * - an already-missing old note is the desired state, not an outage;
 * - the phone is pushed only after every row has been reconciled, and a failed
 *   push is a warning rather than a failed send.
 */
export async function sendToSOstoslista(
  db: D1Database,
  householdId: number,
  client: SOstoslistaSyncClient,
  items: readonly SOstoslistaSendItem[],
): Promise<SOstoslistaSendOutcome> {
  const packets = packetCounts(items);
  const addedProducts = new Set<string>();
  const outstanding = await sentNotes(db, householdId);
  let sent = 0;

  try {
    for (const item of items) {
      const previous = outstanding.get(item.key) ?? null;

      if (item.chosen.length === 0) {
        const note = `${item.name} — ${item.total}`;
        await client.add({ note });

        // Re-sending identical words is the same keyed external row. Removing
        // `previous` here would delete the row we just made sure exists.
        if (previous !== note) {
          if (previous !== null) await dropRememberedNote(client, previous);
          await rememberSentNote(db, householdId, item.key, note);
        }
      } else {
        for (const { product } of item.chosen) {
          if (addedProducts.has(product.ean)) continue;
          addedProducts.add(product.ean);
          await client.add(
            { ean: product.ean },
            packets.get(product.ean) ?? 1,
          );
        }

        // Product first, old text second, local receipt last. If any one of
        // these steps loses its response, repeating the whole send converges on
        // the same state instead of stranding either representation.
        if (previous !== null) {
          await dropRememberedNote(client, previous);
          await forgetSentNote(db, householdId, item.key);
        }
      }

      sent += 1;
    }
  } catch (error) {
    return { status: "partial", sent, total: items.length, error };
  }

  try {
    await client.sync();
    return { status: "sent", sent, total: items.length, synced: true };
  } catch (syncError) {
    return {
      status: "sent",
      sent,
      total: items.length,
      synced: false,
      syncError,
    };
  }
}

/**
 * Remove a note this app previously recorded as its own.
 *
 * Somebody may have collected/cleared it on the phone since our last send; a
 * provider 404 then already means exactly what this reconciliation wants.
 */
async function dropRememberedNote(
  client: SOstoslistaSyncClient,
  note: string,
): Promise<void> {
  try {
    await client.remove({ note });
  } catch (error) {
    if (error instanceof SOstoslistaError && error.status === 404) return;
    throw error;
  }
}

/** One external product row, one packet count across every local shopping row. */
function packetCounts(items: readonly SOstoslistaSendItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const { product, count } of item.chosen) {
      counts.set(product.ean, (counts.get(product.ean) ?? 0) + count);
    }
  }
  return counts;
}
