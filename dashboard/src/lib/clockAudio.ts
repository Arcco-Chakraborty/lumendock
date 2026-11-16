/** Offline Web Audio chimes. Call unlock() from a real user gesture. */
class ClockAudio {
  private ctx: AudioContext | null = null;
  private activeAlarmOscillators = new Map<OscillatorNode, () => void>();
  private alarmInterval: ReturnType<typeof setInterval> | null = null;

  private getContext(): AudioContext | null {
    try {
      if (typeof window === "undefined") return null;
      if (!this.ctx || this.ctx.state === "closed") {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return this.ctx;
    } catch { return null; }
  }

  // Creating/resuming the context during Start/Add/Enable gives browsers the
  // required gesture. Sound remains best effort if the platform denies audio.
  unlock(): void { this.getContext(); }

  private tone(ctx: AudioContext, frequency: number, start: number, attack: number, decay: number, duration: number, alarm: boolean) {
    let osc: OscillatorNode | undefined;
    let gain: GainNode | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (osc) this.activeAlarmOscillators.delete(osc);
      try { osc?.disconnect(); } catch {}
      try { gain?.disconnect(); } catch {}
    };
    try {
      osc = ctx.createOscillator();
      gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(alarm ? 0.3 : 0.28, start + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.onended = cleanup;
      if (alarm) this.activeAlarmOscillators.set(osc, cleanup);
      osc.start(start);
      osc.stop(start + duration);
    } catch {
      try { osc?.stop(); } catch {}
      cleanup();
    }
  }

  playTimerDone(): void {
    const ctx = this.getContext();
    if (!ctx) return;
    [587.33, 739.99, 880, 1174.66].forEach((frequency, index) => {
      this.tone(ctx, frequency, ctx.currentTime + index * 0.12, 0.03, 1.2, 1.25, false);
    });
  }

  startAlarm(): void {
    this.stopAlarm();
    const ctx = this.getContext();
    if (!ctx) return;
    const playBeep = () => {
      // A suspended context has a frozen audio clock: scheduling here queues
      // tones indefinitely, to play together if audio is later permitted.
      if (ctx.state !== "running") {
        this.stopActiveAlarmTones();
        return;
      }
      [880, 1046.5].forEach((frequency, index) => {
        this.tone(ctx, frequency, ctx.currentTime + index * 0.15, 0.02, 0.4, 0.45, true);
      });
    };
    playBeep();
    this.alarmInterval = setInterval(playBeep, 1400);
  }

  stopAlarm(): void {
    if (this.alarmInterval !== null) clearInterval(this.alarmInterval);
    this.alarmInterval = null;
    this.stopActiveAlarmTones();
  }

  private stopActiveAlarmTones(): void {
    for (const [osc, cleanup] of this.activeAlarmOscillators) {
      try { osc.stop(); } catch {}
      cleanup();
    }
    this.activeAlarmOscillators.clear();
  }
}

export const clockAudio = new ClockAudio();
