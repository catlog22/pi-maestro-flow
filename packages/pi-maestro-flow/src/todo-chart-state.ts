let durationChartEnabled = true;

export function setTodoDurationChartEnabled(value: unknown): void {
  if (typeof value === "boolean") durationChartEnabled = value;
}

export function isTodoDurationChartEnabled(): boolean {
  return durationChartEnabled;
}
