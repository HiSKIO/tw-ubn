import { validateUBN, type RegistryKind, type UBNResult } from './lib';

/**
 * An operator-entered record for a valid UBN that no public source carries
 * (accounting and law firms, clinics, cram schools …). Stored in KV so the
 * daily Static Assets redeploy, which replaces the shards, leaves it alone.
 */
export interface ManualRecord {
  ban: string;
  name: string;
  kind?: RegistryKind;
  address?: string;
  /** For the operator only; never returned by `/v1/vat`. */
  note?: string;
  updatedAt: string;
}

/** What the list endpoint reads from KV metadata, without a per-key get. */
export interface ManualSummary {
  ban: string;
  name: string;
  updatedAt: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const KINDS: readonly RegistryKind[] = ['business', 'nonprofit', 'school', 'agency'];
const PREFIX = 'ban:';
const LIMITS = { name: 200, address: 300, note: 500 } as const;
const CONTROL = /[\u0000-\u001f\u007f]/;
// Clients drop a title with Private Use Area glyphs (#10), so such a name would never reach checkout.
const PRIVATE_USE = /\p{Co}/u;
// JSON.stringify escapes a lone surrogate to 6 bytes, which would break the metadata size bound.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Validate an operator's input for `ban`. Strings are trimmed; an empty
 * optional field is dropped. Control characters are rejected in `name` and
 * `address` (they end up on an invoice), as are Private Use Area glyphs, but
 * both are allowed in `note`.
 */
export function parseManualInput(ban: string, body: unknown): Parsed<Omit<ManualRecord, 'updatedAt'>> {
  if (!validateUBN(ban)) return { ok: false, error: 'invalid_ubn' };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'invalid_body' };
  const b = body as Record<string, unknown>;

  const name = text(b.name, LIMITS.name, false);
  if (name === null || name === undefined) return { ok: false, error: 'invalid_name' };
  const address = text(b.address, LIMITS.address, false);
  if (address === null) return { ok: false, error: 'invalid_address' };
  const note = text(b.note, LIMITS.note, true);
  if (note === null) return { ok: false, error: 'invalid_note' };
  let kind: RegistryKind | undefined;
  if (b.kind !== undefined && b.kind !== null && b.kind !== '') {
    if (!KINDS.includes(b.kind as RegistryKind)) return { ok: false, error: 'invalid_kind' };
    kind = b.kind as RegistryKind;
  }

  return {
    ok: true,
    value: { ban, name, ...(kind && { kind }), ...(address && { address }), ...(note && { note }) },
  };
}

/** `undefined` when absent or blank, `null` when invalid. */
function text(v: unknown, max: number, allowControl: boolean): string | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return undefined;
  if (t.length > max || LONE_SURROGATE.test(t)) return null;
  if (!allowControl && (CONTROL.test(t) || PRIVATE_USE.test(t))) return null;
  return t;
}

/** The `/v1/vat` answer for a manual record. */
export function manualResult(rec: ManualRecord): UBNResult {
  // useInvoice and status stay unset: the operator doesn't know them, and a
  // missing value reads as "unknown" to clients, where `false` would assert.
  return {
    found: true,
    ban: rec.ban,
    name: rec.name,
    ...(rec.address && { address: rec.address }),
    ...(rec.kind && { kind: rec.kind }),
    source: 'manual',
  };
}

/** Admin writes propagate to every edge within this many seconds. */
const KV_CACHE_TTL = 60;

/**
 * Read the record for `ban`. A value that doesn't parse (e.g. one written by
 * hand with `wrangler kv key put`) is treated as absent rather than served.
 * `fresh` skips the 60 s edge cache, so the admin edit form never loads a
 * record older than the operator's last save.
 */
export async function getOverride(
  kv: KVNamespace,
  ban: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<ManualRecord | null> {
  let raw: unknown;
  try {
    raw = await kv.get<unknown>(PREFIX + ban, fresh ? { type: 'json' } : { type: 'json', cacheTtl: KV_CACHE_TTL });
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    console.error(`override ${ban} is not JSON; ignoring it`);
    return null;
  }
  if (raw === null) return null;
  const parsed = parseManualInput(ban, raw);
  if (!parsed.ok) {
    console.error(`override ${ban} is malformed (${parsed.error}); ignoring it`);
    return null;
  }
  const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;
  return { ...parsed.value, updatedAt: typeof updatedAt === 'string' ? updatedAt : '' };
}

export async function putOverride(kv: KVNamespace, input: Omit<ManualRecord, 'updatedAt'>): Promise<ManualRecord> {
  const rec: ManualRecord = { ...input, updatedAt: new Date().toISOString() };
  // The name is at most 200 UTF-16 units of at most 3 UTF-8 bytes each, with
  // control characters rejected, so the metadata stays under KV's 1024 bytes.
  const metadata: Omit<ManualSummary, 'ban'> = { name: rec.name, updatedAt: rec.updatedAt };
  await kv.put(PREFIX + rec.ban, JSON.stringify(rec), { metadata });
  return rec;
}

export async function deleteOverride(kv: KVNamespace, ban: string): Promise<void> {
  await kv.delete(PREFIX + ban);
}

/** Every override, sorted by ban. KV list is eventually consistent (about 60 s). */
export async function listOverrides(kv: KVNamespace): Promise<ManualSummary[]> {
  const out: ManualSummary[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page: KVNamespaceListResult<Partial<ManualSummary>> = await kv.list({ prefix: PREFIX, cursor });
    for (const k of page.keys) {
      out.push({ ban: k.name.slice(PREFIX.length), name: k.metadata?.name ?? '', updatedAt: k.metadata?.updatedAt ?? '' });
    }
    if (page.list_complete) return out;
    cursor = page.cursor;
  }
}
