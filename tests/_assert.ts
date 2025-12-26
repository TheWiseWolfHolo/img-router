export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const ok = deepEqual(actual, expected);
  if (!ok) {
    const hint = message ? `: ${message}` : "";
    throw new Error(
      `assertEquals failed${hint}\nactual:   ${stringify(actual)}\nexpected: ${stringify(expected)}`,
    );
  }
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  messageContains?: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (messageContains) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes(messageContains)) {
        throw new Error(`assertRejects: error message not match\nactual: ${msg}\nexpected includes: ${messageContains}`);
      }
    }
    return;
  }
  throw new Error("assertRejects: expected promise to reject, but it resolved");
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (!deepEqual(ak, bk)) return false;
    for (const k of ak) {
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }

  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}


