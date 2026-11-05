import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { knownPins } from "../db/schema";
import type { ParsedUpdate } from "../ssh/parsers";

/**
 * Records which packages the latest checks found pinned. This is stored apart from
 * the update cache, which any refresh can clear, and from hidden updates, which do
 * not exist when auto-hide is off, because a failed pin lookup says nothing about
 * pins. Releasing known ones would unhide them and allow by-name upgrades that
 * override the pin.
 *
 * A complete detection replaces the manager's pins. An incomplete one only adds to
 * them and returns the updates with the known pins marked as kept back.
 */
export function reconcileKnownPins(
  systemId: number,
  pkgManager: string,
  updates: ParsedUpdate[],
  detectionIncomplete: boolean,
): ParsedUpdate[] {
  return getDb().transaction((tx) => {
    const managerFilter = and(
      eq(knownPins.systemId, systemId),
      eq(knownPins.pkgManager, pkgManager),
    );
    let reconciled = updates;
    if (detectionIncomplete) {
      const known = new Set(
        tx
          .select({ packageName: knownPins.packageName })
          .from(knownPins)
          .where(managerFilter)
          .all()
          .map((row) => row.packageName),
      );
      reconciled = updates.map((update) =>
        known.has(update.packageName) ? { ...update, isKeptBack: true } : update,
      );
    } else {
      tx.delete(knownPins).where(managerFilter).run();
    }

    for (const update of reconciled) {
      if (!update.isKeptBack) continue;
      tx.insert(knownPins)
        .values({ systemId, pkgManager, packageName: update.packageName })
        .onConflictDoNothing()
        .run();
    }
    return reconciled;
  });
}
