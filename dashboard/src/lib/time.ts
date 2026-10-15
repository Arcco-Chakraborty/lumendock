export function estimateLaptopNow(
  server: number,
  age: number,
  received: number,
  now: number,
): number {
  return server + age + Math.max(0, now - received);
}
export function secondsUntilReset(
  reset: number | null,
  now: number,
): number | null {
  return reset === null
    ? null
    : Math.max(0, Math.ceil((reset * 1000 - now) / 1000));
}
export function elapsedLabel(at: number | null, now: number | null): string {
  if (at === null || now === null) return "Report age unknown";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 60
    ? `${seconds}s ago`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : `${Math.floor(seconds / 3600)}h ago`;
}
export function countdown(seconds: number | null): string {
  if (seconds === null) return "Reset time unknown";
  if (seconds === 0) return "Reset due · awaiting update";
  if (seconds < 60) return `Reset in ${seconds}s`;
  if (seconds < 3600)
    return `Reset in ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `Reset in ${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
