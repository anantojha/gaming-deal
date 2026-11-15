// Boundary conversions: everything downstream sees integer cents, ISO strings, booleans.

export function toCents(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
  }
  return null;
}

export function toPct(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

export function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

export function unixSecondsToIso(v: unknown): string | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

export function toInt(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) ? n : null;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
