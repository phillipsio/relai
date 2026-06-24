import { describe, it, expect, vi } from "vitest";
import { createRunQueue } from "./queue.js";

describe("createRunQueue", () => {
  it("runs once for a single notify", async () => {
    const run = vi.fn(async () => {});
    const queue = createRunQueue(run);

    queue.notify();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("coalesces notifies that arrive while a run is in flight into one follow-up run", async () => {
    let resolveCurrent: () => void = () => {};
    const controlledRun = vi.fn(() => new Promise<void>((resolve) => { resolveCurrent = resolve; }));
    const queue = createRunQueue(controlledRun);

    queue.notify(); // starts run #1
    await vi.waitFor(() => expect(controlledRun).toHaveBeenCalledTimes(1));

    // Three more events land while run #1 is still in flight.
    queue.notify();
    queue.notify();
    queue.notify();

    resolveCurrent(); // finish run #1 — exactly one follow-up run should start
    await vi.waitFor(() => expect(controlledRun).toHaveBeenCalledTimes(2));

    resolveCurrent(); // finish run #2 — no more pending, queue goes idle
    await new Promise((r) => setTimeout(r, 10));
    expect(controlledRun).toHaveBeenCalledTimes(2);
    expect(queue.isRunning()).toBe(false);
  });
});
