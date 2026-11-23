import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../index';
import { parseManualInput, putOverride } from '../overrides';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
// SHARDS=256 puts 22099131 in shard 216 (the shared shard vector).
const BAN = '22099131';
const SHARD = 'data-1/shards/216.json';

/** An in-memory KV namespace that pages `list` every `pageSize` keys. */
function memoryKV(pageSize = 1000) {
  const store = new Map<string, { value: string; metadata?: unknown }>();
  const gets: { key: string; opts: unknown }[] = [];
  const kv = {
    get: async (key: string, opts?: { type?: string }) => {
      gets.push({ key, opts });
      const e = store.get(key);
      if (!e) return null;
      return opts?.type === 'json' ? JSON.parse(e.value) : e.value;
    },
    put: async (key: string, value: string, opts?: { metadata?: unknown }) => {
      store.set(key, { value, metadata: opts?.metadata });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const done = start + pageSize >= keys.length;
      return {
        keys: keys.slice(start, start + pageSize).map((name) => ({ name, metadata: store.get(name)!.metadata })),
        list_complete: done,
        cursor: done ? undefined : String(start + pageSize),
      };
    },
  };
  return { kv: kv as unknown as KVNamespace, store, gets };
}

const r2obj = (v: unknown) => ({ json: () => Promise.resolve(v) });
const published = (rows: unknown[]) =>
  ({
    get: (k: string) =>
      Promise.resolve(k === 'latest.json' ? r2obj({ latest: 'data-1' }) : k === SHARD ? r2obj(rows) : null),
  }) as unknown as R2Bucket;

const FIA_HIT = () => Promise.resolve(Response.json({ businessNm: '台灣積體電路製造股份有限公司', isUseInvoice: 'Y' }));
const FIA_404 = () => Promise.resolve(new Response(null, { status: 404 }));
const FIA_DOWN = () => Promise.reject(new Error('network error'));
const GCIS_MISS = () => Promise.resolve(Response.json([]));
const GCIS_HIT = () =>
  Promise.resolve(Response.json([{ Company_Status_Desc: '核准設立', Company_Name: '某某股份有限公司', Revoke_App_Date: '' }]));
/** Route fetch by host: FIA answers with `fia`, GCIS with `gcis`. */
const upstream = (fia: () => Promise<Response>, gcis = GCIS_MISS) =>
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (String(input).includes('data.gcis.nat.gov.tw') ? gcis() : fia())));

const MANUAL = { name: '王大明會計師事務所', kind: 'business', address: '臺北市中正區', note: '客服確認 2026-11' } as const;

let cached: Response | undefined;
const put = vi.fn(async (_k: Request, _r: Response) => {});
beforeEach(() => {
  cached = undefined;
  vi.stubGlobal('caches', { default: { match: () => Promise.resolve(cached?.clone()), put } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  put.mockClear();
});

const vat = (env: Env) =>
  worker.fetch(new Request(`https://w/v1/vat/${BAN}`, { headers: { Origin: 'https://a.example' } }), { SHARDS: '256', ...env }, ctx);

async function seeded(rec = MANUAL) {
  const m = memoryKV();
  const parsed = parseManualInput(BAN, rec);
  if (!parsed.ok) throw new Error(parsed.error);
  await putOverride(m.kv, parsed.value);
  m.gets.length = 0;
  return m;
}

describe('/v1/vat with a manual override', () => {
  it('answers the manual record when the dataset, FIA and GCIS all miss, and never caches it', async () => {
    upstream(FIA_404);
    const { kv, gets } = await seeded();
    const res = await vat({ UBN_BUCKET: published([]), OVERRIDES: kv });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      found: true,
      ban: BAN,
      name: '王大明會計師事務所',
      address: '臺北市中正區',
      kind: 'business',
      source: 'manual',
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    // The official found:false is what goes into the edge cache.
    expect(put).toHaveBeenCalledTimes(1);
    expect(await put.mock.calls[0][1].json()).toEqual({ found: false, ban: BAN });
    expect(gets).toEqual([{ key: `ban:${BAN}`, opts: { type: 'json', cacheTtl: 60 } }]);
  });

  it('leaves a dataset hit unchanged and never reads KV', async () => {
    upstream(FIA_404);
    const { kv, gets } = await seeded();
    const res = await vat({ UBN_BUCKET: published([{ ban: BAN, name: '台積電' }]), OVERRIDES: kv });
    expect(await res.json()).toMatchObject({ found: true, name: '台積電', source: 'dataset' });
    expect(gets).toEqual([]);
  });

  it('leaves a FIA hit unchanged', async () => {
    upstream(FIA_HIT);
    const { kv, gets } = await seeded();
    const res = await vat({ UBN_BUCKET: published([]), OVERRIDES: kv });
    expect(await res.json()).toMatchObject({ found: true, name: '台灣積體電路製造股份有限公司', source: 'fia-api' });
    expect(gets).toEqual([]);
  });

  it('leaves a GCIS hit unchanged', async () => {
    upstream(FIA_404, GCIS_HIT);
    const { kv } = await seeded();
    const res = await vat({ UBN_BUCKET: published([]), OVERRIDES: kv });
    expect(await res.json()).toMatchObject({ found: true, name: '某某股份有限公司', source: 'gcis' });
  });

  it('overlays a found:false that was cached before the override was added', async () => {
    const f = vi.fn(FIA_404);
    vi.stubGlobal('fetch', f);
    cached = new Response(JSON.stringify({ found: false, ban: BAN }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
    });
    const { kv } = await seeded();
    const res = await vat({ UBN_BUCKET: published([]), OVERRIDES: kv });
    expect(await res.json()).toMatchObject({ found: true, source: 'manual' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(f).not.toHaveBeenCalled();
  });

  it('leaves a cached found:true unchanged and never reads KV', async () => {
    cached = new Response(JSON.stringify({ found: true, ban: BAN, name: '台積電', source: 'dataset' }));
    const { kv, gets } = await seeded();
    const res = await vat({ OVERRIDES: kv });
    expect(await res.json()).toMatchObject({ source: 'dataset' });
    expect(gets).toEqual([]);
  });

  it('answers the manual record instead of a 502 when FIA is down', async () => {
    upstream(FIA_DOWN);
    const { kv } = await seeded();
    const res = await vat({ UBN_BUCKET: published([]), OVERRIDES: kv });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ found: true, source: 'manual' });
    expect(put).not.toHaveBeenCalled();
  });

  it('keeps the 502 when FIA is down and there is no override', async () => {
    upstream(FIA_DOWN);
    const res = await vat({ UBN_BUCKET: published([]), OVERRIDES: memoryKV().kv });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ found: null, ban: BAN, error: 'upstream_unavailable' });
  });

  it('serves the official found:false when KV throws', async () => {
    upstream(FIA_404);
    const kv = { get: () => Promise.reject(new Error('kv down')) } as unknown as KVNamespace;
    const res = await vat({ UBN_BUCKET: published([]), OVERRIDES: kv });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false, ban: BAN });
  });

  it('ignores a malformed KV value', async () => {
    upstream(FIA_404);
    const m = memoryKV();
    m.store.set(`ban:${BAN}`, { value: JSON.stringify({ name: '' }) });
    const res = await vat({ UBN_BUCKET: published([]), OVERRIDES: m.kv });
    expect(await res.json()).toEqual({ found: false, ban: BAN });
  });

  it('omits useInvoice, status, and the operator note', async () => {
    upstream(FIA_404);
    const { kv } = await seeded();
    const body = await (await vat({ UBN_BUCKET: published([]), OVERRIDES: kv })).json();
    expect(body).not.toHaveProperty('useInvoice');
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('note');
  });
});

describe('parseManualInput', () => {
  it('trims fields and drops blank optional ones', () => {
    expect(parseManualInput(BAN, { name: '  某某診所 ', address: ' ', note: '', kind: '' })).toEqual({
      ok: true,
      value: { ban: BAN, name: '某某診所' },
    });
  });

  const invalid: [string, string, unknown][] = [
    ['a bad checksum', '22099132', { name: 'x' }],
    ['a non-object body', BAN, ['x']],
    ['a missing name', BAN, {}],
    ['a blank name', BAN, { name: '   ' }],
    ['a name over 200 chars', BAN, { name: '名'.repeat(201) }],
    ['a name with a control character', BAN, { name: 'a\nb' }],
    ['an unknown kind', BAN, { name: 'x', kind: 'clinic' }],
    ['an address over 300 chars', BAN, { name: 'x', address: 'a'.repeat(301) }],
    ['a note over 500 chars', BAN, { name: 'x', note: 'a'.repeat(501) }],
    ['a non-string note', BAN, { name: 'x', note: 1 }],
    ['a name with a Private Use Area glyph', BAN, { name: '王\uE000明會計師事務所' }],
    ['an address with a Private Use Area glyph', BAN, { name: 'x', address: '臺北市\uE000' }],
    ['a name with a lone surrogate', BAN, { name: 'a\uD800b' }],
    ['a note with a lone surrogate', BAN, { name: 'x', note: '\uDC00' }],
  ];
  for (const [what, ban, body] of invalid) {
    it(`rejects ${what}`, () => {
      expect(parseManualInput(ban, body).ok).toBe(false);
    });
  }

  it('keeps the longest allowed name inside the 1024-byte KV metadata limit', async () => {
    const m = memoryKV();
    const parsed = parseManualInput(BAN, { name: '龘'.repeat(200) });
    if (!parsed.ok) throw new Error(parsed.error);
    await putOverride(m.kv, parsed.value);
    const bytes = new TextEncoder().encode(JSON.stringify(m.store.get(`ban:${BAN}`)!.metadata)).length;
    expect(bytes).toBeLessThanOrEqual(1024);
  });
});

describe('admin API', () => {
  const TOKEN = 's3cret-token';
  const call = (env: Env, method: string, path: string, opts: { token?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? TOKEN : opts.token;
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    return worker.fetch(new Request(`https://w${path}`, { method, headers, body }), { SHARDS: '256', ...env }, ctx);
  };

  it('adds, serves, and deletes an override end to end', async () => {
    upstream(FIA_404);
    const { kv } = memoryKV();
    const env: Env = { UBN_BUCKET: published([]), OVERRIDES: kv, ADMIN_TOKEN: TOKEN };

    const putRes = await call(env, 'PUT', `/admin/api/overrides/${BAN}`, { body: MANUAL });
    expect(putRes.status).toBe(200);
    const saved = (await putRes.json()) as { record: { updatedAt: string } };
    expect(saved).toMatchObject({ record: { ban: BAN, ...MANUAL }, officialFound: false });
    expect(Date.parse(saved.record.updatedAt)).not.toBeNaN();

    expect(await (await vat(env)).json()).toMatchObject({ found: true, name: MANUAL.name, source: 'manual' });
    expect(await (await call(env, 'GET', `/admin/api/overrides/${BAN}`)).json()).toEqual({ record: saved.record });

    const del = await call(env, 'DELETE', `/admin/api/overrides/${BAN}`);
    expect(del.status).toBe(204);
    expect(await (await vat(env)).json()).toEqual({ found: false, ban: BAN });
    expect((await call(env, 'GET', `/admin/api/overrides/${BAN}`)).status).toBe(404);
    expect((await call(env, 'DELETE', `/admin/api/overrides/${BAN}`)).status).toBe(204);
  });

  it('reports officialFound true when FIA knows the ban, and null when FIA is down', async () => {
    const env: Env = { UBN_BUCKET: published([]), OVERRIDES: memoryKV().kv, ADMIN_TOKEN: TOKEN };
    upstream(FIA_HIT);
    expect(await (await call(env, 'PUT', `/admin/api/overrides/${BAN}`, { body: MANUAL })).json()).toMatchObject({
      officialFound: true,
    });
    upstream(FIA_DOWN);
    expect(await (await call(env, 'PUT', `/admin/api/overrides/${BAN}`, { body: MANUAL })).json()).toMatchObject({
      officialFound: null,
    });
  });

  it('reads the edited record past the KV edge cache, so a re-edit never loads a stale copy', async () => {
    const { kv, gets } = await seeded();
    const res = await call({ OVERRIDES: kv, ADMIN_TOKEN: TOKEN }, 'GET', `/admin/api/overrides/${BAN}`);
    expect(res.status).toBe(200);
    expect(gets).toEqual([{ key: `ban:${BAN}`, opts: { type: 'json' } }]);
  });

  it('answers 404, not a 500, for a KV value that is not JSON', async () => {
    const { kv, store } = memoryKV();
    store.set(`ban:${BAN}`, { value: 'abc' });
    const env: Env = { UBN_BUCKET: published([]), OVERRIDES: kv, ADMIN_TOKEN: TOKEN };
    expect((await call(env, 'GET', `/admin/api/overrides/${BAN}`)).status).toBe(404);
    upstream(FIA_404);
    expect(await (await vat(env)).json()).toEqual({ found: false, ban: BAN });
  });

  it('accepts the token when the stored secret has surrounding whitespace', async () => {
    const res = await call({ OVERRIDES: memoryKV().kv, ADMIN_TOKEN: `${TOKEN}\n` }, 'GET', '/admin/api/overrides');
    expect(res.status).toBe(200);
  });

  it('confirms a save with officialFound null when FIA hangs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      upstream(() => new Promise<Response>(() => {}));
      const { kv, store } = memoryKV();
      const pending = call({ UBN_BUCKET: published([]), OVERRIDES: kv, ADMIN_TOKEN: TOKEN }, 'PUT', `/admin/api/overrides/${BAN}`, {
        body: MANUAL,
      });
      let settled = false;
      void pending.then(() => (settled = true));
      // The token check awaits real crypto first, so the timeout is armed only after it.
      for (let i = 0; i < 100 && !settled; i++) await vi.advanceTimersByTimeAsync(100);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ officialFound: null });
      expect(store.has(`ban:${BAN}`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists every override across KV list pages', async () => {
    upstream(FIA_404);
    const { kv } = memoryKV(2);
    const env: Env = { OVERRIDES: kv, ADMIN_TOKEN: TOKEN };
    for (const [ban, name] of [['22099131', '甲'], ['04595257', '乙'], ['87003412', '丙']]) {
      expect((await call(env, 'PUT', `/admin/api/overrides/${ban}`, { body: { name } })).status).toBe(200);
    }
    const { overrides } = (await (await call(env, 'GET', '/admin/api/overrides')).json()) as {
      overrides: { ban: string; name: string }[];
    };
    expect(overrides.map((o) => [o.ban, o.name])).toEqual([
      ['04595257', '乙'],
      ['22099131', '甲'],
      ['87003412', '丙'],
    ]);
  });

  for (const [what, token] of [['a missing', null], ['a wrong', 'nope'], ['a longer', `${TOKEN}x`]] as const) {
    it(`answers 401 to ${what} token, on every route`, async () => {
      const { kv, store } = memoryKV();
      const env: Env = { OVERRIDES: kv, ADMIN_TOKEN: TOKEN };
      for (const [method, path] of [
        ['GET', '/admin/api/overrides'],
        ['GET', `/admin/api/overrides/${BAN}`],
        ['PUT', `/admin/api/overrides/${BAN}`],
        ['DELETE', `/admin/api/overrides/${BAN}`],
      ]) {
        const res = await call(env, method, path, { token, body: method === 'PUT' ? MANUAL : undefined });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
      expect(store.size).toBe(0);
    });
  }

  it('answers 503 on the API but still serves the page when ADMIN_TOKEN is unset or empty', async () => {
    for (const ADMIN_TOKEN of [undefined, '']) {
      const env: Env = { OVERRIDES: memoryKV().kv, ADMIN_TOKEN };
      const res = await call(env, 'GET', '/admin/api/overrides', { token: '' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'admin_disabled' });
      expect((await call(env, 'GET', '/admin')).status).toBe(200);
    }
  });

  const bad: [string, string, unknown, string][] = [
    ['a bad checksum', '22099132', MANUAL, 'invalid_ubn'],
    ['a non-numeric ban', 'abc', MANUAL, 'invalid_ubn'],
    ['an empty name', BAN, { name: '' }, 'invalid_name'],
    ['a name over 200 chars', BAN, { name: 'x'.repeat(201) }, 'invalid_name'],
    ['an unknown kind', BAN, { name: 'x', kind: 'clinic' }, 'invalid_kind'],
    ['a body that is not JSON', BAN, '{name:', 'invalid_body'],
  ];
  for (const [what, ban, body, error] of bad) {
    it(`answers 400 ${error} to a PUT with ${what}`, async () => {
      const { kv, store } = memoryKV();
      const res = await call({ OVERRIDES: kv, ADMIN_TOKEN: TOKEN }, 'PUT', `/admin/api/overrides/${ban}`, { body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
      expect(store.size).toBe(0);
    });
  }

  it('serves the admin page as HTML without CORS headers', async () => {
    const res = await call({ OVERRIDES: memoryKV().kv, ADMIN_TOKEN: TOKEN }, 'GET', '/admin', { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await res.text()).toContain('統編手動資料');
  });
});

describe('without the OVERRIDES binding', () => {
  it('404s every /admin route, even with a token', async () => {
    for (const [method, path] of [
      ['GET', '/admin'],
      ['GET', '/admin/api/overrides'],
      ['PUT', `/admin/api/overrides/${BAN}`],
    ]) {
      const res = await worker.fetch(
        new Request(`https://w${path}`, {
          method,
          headers: { Authorization: 'Bearer t' },
          body: method === 'PUT' ? '{}' : undefined,
        }),
        { ADMIN_TOKEN: 't' },
        ctx,
      );
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it('answers a miss as found:false, cached as before', async () => {
    upstream(FIA_404);
    const res = await vat({ UBN_BUCKET: published([]) });
    expect(await res.json()).toEqual({ found: false, ban: BAN });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });
});
