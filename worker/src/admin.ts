import { validateUBN } from './lib';
import { deleteOverride, getOverride, listOverrides, parseManualInput, putOverride } from './overrides';

export interface AdminDeps {
  kv: KVNamespace;
  /** Unset or empty disables the API (503); the page still loads. */
  token?: string;
  /** Whether an official source knows `ban` right now; null when that can't be told. */
  officialFound: (ban: string) => Promise<boolean | null>;
}

/**
 * `/admin` (the page) and `/admin/api/overrides[/:ban]`. Same-origin only, so
 * no CORS headers; the bearer token travels in a header, never a cookie, so a
 * cross-site page can't ride on it.
 */
export async function handleAdmin(req: Request, url: URL, deps: AdminDeps): Promise<Response> {
  const path = url.pathname;
  if (path === '/admin') {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    return new Response(PAGE, { headers: PAGE_HEADERS });
  }

  const m = path.match(/^\/admin\/api\/overrides(?:\/([^/]*))?$/);
  if (!m) return json({ error: 'not_found' }, 404);
  if (!deps.token) return json({ error: 'admin_disabled' }, 503);
  if (!(await authorized(req, deps.token))) {
    return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }

  const ban = m[1];
  if (ban === undefined) {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    return json({ overrides: await listOverrides(deps.kv) }, 200);
  }
  if (!validateUBN(ban)) return json({ error: 'invalid_ubn' }, 400);

  switch (req.method) {
    case 'GET': {
      const rec = await getOverride(deps.kv, ban);
      return rec ? json({ record: rec }, 200) : json({ error: 'not_found' }, 404);
    }
    case 'PUT': {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'invalid_body' }, 400);
      }
      const parsed = parseManualInput(ban, body);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const [record, officialFound] = await Promise.all([putOverride(deps.kv, parsed.value), deps.officialFound(ban)]);
      return json({ record, officialFound }, 200);
    }
    case 'DELETE':
      await deleteOverride(deps.kv, ban);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    default:
      return methodNotAllowed('GET, PUT, DELETE');
  }
}

/** Compare SHA-256 digests so the time taken depends on neither content nor length. */
async function authorized(req: Request, token: string): Promise<boolean> {
  const m = (req.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all(
    [m[1].trim(), token].map(async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))),
  );
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function methodNotAllowed(allow: string): Response {
  return json({ error: 'method_not_allowed' }, 405, { Allow: allow });
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const PAGE = `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>統編手動資料</title>
<style>
  :root { --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --bg: #fff; --panel: #f6f8fa; --accent: #0969da; --bad: #cf222e; --warn: #9a6700; --ok: #1a7f37; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --bg: #0d1117; --panel: #151b23; --accent: #4493f8; --bad: #f85149; --warn: #d29922; --ok: #3fb950; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font: 16px/1.5 system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 0 0 12px; }
  p.lead { color: var(--muted); margin: 0 0 20px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  label { display: block; font-weight: 600; margin: 12px 0 4px; }
  label:first-of-type { margin-top: 0; }
  .hint { font-weight: 400; color: var(--muted); font-size: .875rem; }
  input, select, textarea { width: 100%; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
  textarea { min-height: 72px; resize: vertical; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--bad); }
  button:disabled { opacity: .6; cursor: default; }
  #msg { min-height: 1.5em; margin: 0 0 16px; white-space: pre-line; }
  #msg.bad { color: var(--bad); } #msg.warn { color: var(--warn); } #msg.ok { color: var(--ok); }
  .table { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.ban { font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.name { width: 100%; overflow-wrap: anywhere; }
  .when { color: var(--muted); font-size: .875rem; }
  td.act button { display: block; width: 100%; padding: 4px 10px; white-space: nowrap; }
  td.act button + button { margin-top: 6px; }
  #empty { color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>統編手動資料</h1>
  <p class="lead">替查不到公開資料的合法統編（會計師、律師、診所、補習班等）登記抬頭。只有在資料集、財政部與經濟部都查無時，<code>/v1/vat</code> 才會回傳這裡的資料（<code>source: "manual"</code>）。新增、修改或刪除約 60 秒內生效。</p>

  <section>
    <h2>管理權杖</h2>
    <label for="token">ADMIN_TOKEN <span class="hint">只存在這個分頁，關閉後清除</span></label>
    <input id="token" type="password" autocomplete="off" spellcheck="false">
    <div class="row">
      <button id="useToken" class="primary" type="button">使用並載入清單</button>
      <button id="forget" type="button">清除</button>
    </div>
  </section>

  <p id="msg" role="status" aria-live="polite"></p>

  <section>
    <h2>新增或修改</h2>
    <form id="form" novalidate>
      <label for="ban">統編</label>
      <input id="ban" inputmode="numeric" maxlength="8" autocomplete="off" required>
      <label for="name">抬頭 <span class="hint">最多 200 字</span></label>
      <input id="name" maxlength="200" autocomplete="off" required>
      <label for="kind">類型</label>
      <select id="kind">
        <option value="">未指定</option>
        <option value="business">營業人（business）</option>
        <option value="nonprofit">非營利機關團體（nonprofit）</option>
        <option value="school">學校（school）</option>
        <option value="agency">政府機關（agency）</option>
      </select>
      <label for="address">地址 <span class="hint">選填，最多 300 字</span></label>
      <input id="address" maxlength="300" autocomplete="off">
      <label for="note">備註 <span class="hint">選填，最多 500 字，只給管理者看，不會出現在查詢結果</span></label>
      <textarea id="note" maxlength="500"></textarea>
      <div class="row">
        <button id="save" class="primary" type="submit">儲存</button>
        <button id="reset" type="button">清空表單</button>
      </div>
    </form>
  </section>

  <section>
    <h2>已登記的統編</h2>
    <p class="hint">清單最多可能延遲約 60 秒才反映其他人的修改。</p>
    <div class="row" style="margin-top:0;margin-bottom:8px"><button id="reload" type="button">重新整理</button></div>
    <div class="table">
      <table>
        <thead><tr><th>統編</th><th>抬頭／更新時間</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <p id="empty" hidden>還沒有資料。</p>
  </section>
</main>
<script>
(function () {
  'use strict';
  var KEY = 'tw-ubn-admin-token';
  var API = '/admin/api/overrides';
  var ERRORS = {
    invalid_ubn: '統編格式或檢查碼錯誤。',
    invalid_name: '抬頭必填，最多 200 字，不可包含換行等控制字元。',
    invalid_kind: '類型不正確。',
    invalid_address: '地址最多 300 字，不可包含換行等控制字元。',
    invalid_note: '備註最多 500 字。',
    invalid_body: '送出的資料格式不正確。',
    unauthorized: '權杖錯誤或尚未填寫。',
    admin_disabled: '管理 API 尚未啟用：請先用 wrangler secret put ADMIN_TOKEN 設定權杖。',
    not_found: '找不到這筆資料。'
  };
  var $ = function (id) { return document.getElementById(id); };
  var rows = [];

  function load(k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function save(k, v) { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch (e) {} }

  var WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1];
  function validateUBN(ban) {
    if (!/^\\d{8}$/.test(ban)) return false;
    var sum = 0;
    for (var i = 0; i < 8; i++) { var p = Number(ban[i]) * WEIGHTS[i]; sum += Math.floor(p / 10) + (p % 10); }
    return sum % 5 === 0 || (ban[6] === '7' && (sum + 1) % 5 === 0);
  }

  function say(text, tone) { var m = $('msg'); m.textContent = text; m.className = tone || ''; }

  function api(method, path, body) {
    var token = $('token').value.trim();
    if (!token) return Promise.reject(new Error(ERRORS.unauthorized));
    var init = { method: method, headers: { Authorization: 'Bearer ' + token } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(API + path, init).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(ERRORS[data.error] || ('伺服器回應 HTTP ' + res.status + (data.error ? '（' + data.error + '）' : '')));
        return data;
      });
    });
  }

  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString('zh-TW', { hour12: false });
  }

  function render() {
    var tbody = $('rows');
    tbody.textContent = '';
    rows.sort(function (a, b) { return a.ban < b.ban ? -1 : a.ban > b.ban ? 1 : 0; });
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var banTd = document.createElement('td');
      banTd.className = 'ban';
      banTd.textContent = r.ban;
      var nameTd = document.createElement('td');
      nameTd.className = 'name';
      nameTd.textContent = r.name;
      var at = document.createElement('div');
      at.className = 'when';
      at.textContent = when(r.updatedAt);
      nameTd.appendChild(at);
      tr.appendChild(banTd);
      tr.appendChild(nameTd);
      var act = document.createElement('td');
      act.className = 'act';
      var edit = document.createElement('button');
      edit.type = 'button'; edit.textContent = '編輯';
      edit.onclick = function () { editRow(r.ban); };
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'danger'; del.textContent = '刪除';
      del.onclick = function () { deleteRow(r.ban, r.name); };
      act.appendChild(edit); act.appendChild(del);
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
    $('empty').hidden = rows.length > 0;
  }

  function upsertRow(rec) {
    rows = rows.filter(function (r) { return r.ban !== rec.ban; });
    rows.push({ ban: rec.ban, name: rec.name, updatedAt: rec.updatedAt });
    render();
  }

  function reload() {
    return api('GET', '').then(function (data) { rows = data.overrides; render(); say('已載入 ' + rows.length + ' 筆。', 'ok'); })
      .catch(function (e) { say(e.message, 'bad'); });
  }

  function fill(rec) {
    $('ban').value = rec.ban || '';
    $('name').value = rec.name || '';
    $('kind').value = rec.kind || '';
    $('address').value = rec.address || '';
    $('note').value = rec.note || '';
  }

  function editRow(ban) {
    api('GET', '/' + ban).then(function (data) {
      fill(data.record);
      $('name').focus();
      say('正在編輯 ' + ban + '。', '');
    }).catch(function (e) { say(e.message, 'bad'); });
  }

  function deleteRow(ban, name) {
    if (!confirm('確定刪除 ' + ban + '（' + name + '）？')) return;
    api('DELETE', '/' + ban).then(function () {
      rows = rows.filter(function (r) { return r.ban !== ban; });
      render();
      say('已刪除 ' + ban + '，約 60 秒內生效。', 'ok');
    }).catch(function (e) { say(e.message, 'bad'); });
  }

  $('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var ban = $('ban').value.trim();
    var name = $('name').value.trim();
    if (!validateUBN(ban)) { say(ERRORS.invalid_ubn, 'bad'); $('ban').focus(); return; }
    if (!name) { say(ERRORS.invalid_name, 'bad'); $('name').focus(); return; }
    var body = { name: name, kind: $('kind').value, address: $('address').value, note: $('note').value };
    $('save').disabled = true;
    api('PUT', '/' + ban, body).then(function (data) {
      upsertRow(data.record);
      if (data.officialFound === true) {
        say('已儲存 ' + ban + '。\\n注意：官方來源已有這個統編，/v1/vat 會回傳官方資料，這筆手動資料目前不會被使用。', 'warn');
      } else if (data.officialFound === null) {
        say('已儲存 ' + ban + '，約 60 秒內生效。\\n目前無法確認官方來源是否有這個統編（上游暫時無法連線）。', 'warn');
      } else {
        say('已儲存 ' + ban + '，約 60 秒內生效。', 'ok');
      }
    }).catch(function (e) { say(e.message, 'bad'); })
      .then(function () { $('save').disabled = false; });
  });

  $('reset').onclick = function () { fill({}); say('', ''); };
  $('reload').onclick = reload;
  $('useToken').onclick = function () { save(KEY, $('token').value.trim()); reload(); };
  $('forget').onclick = function () { $('token').value = ''; save(KEY, ''); rows = []; render(); say('已清除權杖。', ''); };

  $('token').value = load(KEY);
  render();
  if ($('token').value) reload();
})();
</script>
</body>
</html>
`;
