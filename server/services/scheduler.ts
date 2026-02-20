import * as cacheService from "./cache-service";
import * as updateService from "./update-service";

const CHECK_INTERVAL = 900_000; // 15 minutes in ms

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimeout: ReturnType<typeof setTimeout> | null = null;

async function runCheck(): Promise<void> {
  try {
    const staleIds = cacheService.getStaleSystemIds();
    if (staleIds.length > 0) {
      console.log(`Scheduler: refreshing ${staleIds.length} stale systems`);
      await Promise.allSettled(
        staleIds.map((id) => updateService.checkUpdates(id))
      );
    }
  } catch (e) {
    console.error("Scheduler error:", e);
  }
}

export function start(): void {
  // Wait 30s before first check to let the app fully start
  initialTimeout = setTimeout(() => {
    runCheck();
    timer = setInterval(runCheck, CHECK_INTERVAL);
  }, 30_000);
}

export function stop(): void {
  if (initialTimeout) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
