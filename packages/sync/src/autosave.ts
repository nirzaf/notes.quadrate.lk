export interface AutosaveCoordinatorOptions<T> {
  delayMs: number;
  save: (value: T) => Promise<void>;
  onError: (error: unknown) => void;
}

export class AutosaveCoordinator<T> {
  private readonly options: AutosaveCoordinatorOptions<T>;
  private pending: T | undefined;
  private hasPending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(options: AutosaveCoordinatorOptions<T>) {
    this.options = options;
  }

  schedule(value: T): void {
    if (this.disposed) return;
    this.pending = value;
    this.hasPending = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.options.delayMs);
  }

  private async drain(): Promise<void> {
    if (this.running || !this.hasPending || this.disposed) return;
    const value = this.pending as T;
    this.pending = undefined;
    this.hasPending = false;
    this.running = (async () => {
      try {
        await this.options.save(value);
      } catch (error: unknown) {
        this.options.onError(error);
      } finally {
        this.running = null;
      }
    })();
    await this.running;
    if (this.hasPending && !this.disposed) await this.drain();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.running || this.hasPending) {
      if (this.running) await this.running;
      else await this.drain();
    }
  }

  cancelPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.hasPending = false;
    this.pending = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
  }
}
