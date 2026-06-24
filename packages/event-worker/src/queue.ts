// Coalescing run-queue: many events arriving while a session is in flight
// collapse into a single follow-up run, instead of one billed session per event.
export function createRunQueue(run: () => Promise<void>) {
  let pending = false;
  let running = false;

  async function drain() {
    running = true;
    do {
      pending = false;
      await run();
    } while (pending);
    running = false;
  }

  return {
    // Call on every relevant incoming event.
    notify(): void {
      if (running) {
        pending = true;
        return;
      }
      void drain();
    },
    isRunning(): boolean {
      return running;
    },
  };
}
