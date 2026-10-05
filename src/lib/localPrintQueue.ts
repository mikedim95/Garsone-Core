/** Durable delivery state machine. A write that might have reached paper is never retried automatically. */
export type DurablePrintJob = {
  id: string; storeId: string; orderId?: string | null; topic: string; payload: any;
  state: string; createdAt: Date; startedAt?: Date | null; error?: string | null;
};
export interface PrintQueueRepository {
  queued(): Promise<DurablePrintJob[]>;
  claim(id: string): Promise<boolean>;
  delivered(id: string): Promise<void>;
  error(id: string, message: string): Promise<void>;
}
export type DeliveryRoute = { device: string };

export class LocalPrintQueue {
  readonly active = new Set<string>();
  private readonly devices = new Set<string>();
  private running = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly repository: PrintQueueRepository,
    private readonly routeFor: (topic: string) => DeliveryRoute | undefined,
    private readonly write: (job: DurablePrintJob, route: DeliveryRoute) => Promise<void>,
    private readonly deviceAvailable: (device: string) => Promise<boolean>,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(error => console.error('[local-print] queue unavailable', error)); }, 1000);
    this.timer.unref();
    void this.tick().catch(error => console.error('[local-print] queue unavailable', error));
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  isDeviceBusy(device: string) { return this.devices.has(device); }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = (await this.repository.queued()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      const writes: Promise<void>[] = [];
      for (const job of jobs) {
        const route = this.routeFor(job.topic);
        if (!route) {
          await this.repository.error(job.id, 'Printer route is not configured. Ticket has not been sent.');
          continue;
        }
        if (this.devices.has(route.device)) continue;
        if (!await this.deviceAvailable(route.device)) {
          await this.repository.error(job.id, 'Printer device is unavailable. Ticket has not been sent.');
          continue;
        }
        // Claim is a database compare-and-set, committed BEFORE any device I/O.
        if (!await this.repository.claim(job.id)) continue;
        this.devices.add(route.device);
        this.active.add(job.id);
        writes.push(this.deliver(job, route));
      }
      await Promise.all(writes);
    } finally { this.running = false; }
  }

  private async deliver(job: DurablePrintJob, route: DeliveryRoute) {
    try {
      await this.write(job, route);
      // If this update fails after the write, the durable state stays uncertain.
      await this.repository.delivered(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Printer write could not be confirmed';
      await this.repository.error(job.id, message.slice(0, 500)).catch(() => {});
    } finally {
      this.active.delete(job.id);
      this.devices.delete(route.device);
    }
  }
}
