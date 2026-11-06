/**
 * 自包含控制台页面（零外部资源）。
 *
 * 为什么不用 React 页面：托管分享链接的反代会拦截所有不带 `sharecode` 的请求，
 * 而 Next 生成的 `/_next/static/*.js|css` 不会带这个参数 → 全部 403，
 * 浏览器只拿到 HTML、没有 JS，页面就"卡住/超时"。
 * 这里把 CSS 和 JS 全部内联进文档，整页只有一次请求，绕开这个问题。
 */

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#0b1110;color:#e6f1ee;font:14px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:420px;margin:0 auto;padding:24px 16px 48px}
.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:44px;height:44px;border-radius:14px;background:#0e7566;display:grid;place-items:center;font-size:20px;font-weight:700;color:#fff}
.t1{font-size:17px;font-weight:700}
.t2{font-size:12px;color:#8aa39d}
.card{background:#111a18;border:1px solid #1f2c29;border-radius:16px;padding:16px;margin-bottom:12px}
.card h3{margin:0 0 12px;font-size:14px;font-weight:600}
label{display:block;font-size:12px;color:#8aa39d;margin:0 0 4px}
input{width:100%;height:42px;padding:0 12px;border-radius:10px;border:1px solid #223330;background:#0d1614;color:#e6f1ee;font-size:14px;outline:none}
input:focus{border-color:#1f9c88}
button{height:42px;border:0;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer}
.btn{width:100%;background:#0e7566;color:#fff;margin-top:12px}
.btn:disabled{opacity:.6}
.btn2{background:#16211f;color:#cfe6e0;border:1px solid #223330}
.row{display:flex;gap:8px;margin-top:8px}
.row>*{flex:1}
.kv{display:flex;justify-content:space-between;font-size:13px;color:#a9c2bc;padding:3px 0}
.pill{font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px}
.on{background:#0d332c;color:#3fd0b0}
.off{background:#2a1c1a;color:#e0776b}
.err{color:#ff8b7a;font-size:13px;margin-top:10px;white-space:pre-wrap}
.ok{color:#3fd0b0;font-size:13px;margin-top:10px;white-space:pre-wrap}
a{color:#3fd0b0}
.code{display:flex;gap:8px;margin-top:10px}
.code code{flex:1;height:42px;display:grid;place-items:center;border-radius:10px;background:#0d1614;border:1px solid #223330;font-size:18px;font-weight:700;letter-spacing:2px}
.small{font-size:12px;color:#7b938e;margin-top:8px;word-break:break-all}
.list{margin-top:12px}
.item{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#0d1614;border:1px solid #223330;border-radius:10px;padding:8px 10px;margin-bottom:8px}
.del{height:32px;padding:0 12px;border-radius:8px;background:#3a1a16;color:#ff8b7a;font-size:12px}
`;

/** 所有请求都带上 sharecode（托管反代要求）和 t（登录态） */
const JS_HELPERS = `
var SC = new URLSearchParams(location.search).get('sharecode');
var TK = 'qqrt_token';
function token(){ try { return localStorage.getItem(TK) || ''; } catch(e){ return ''; } }
function setToken(t){ try { t ? localStorage.setItem(TK,t) : localStorage.removeItem(TK); } catch(e){} }
function apiUrl(p){
  var u = p + (p.indexOf('?') >= 0 ? '&' : '?');
  var qs = [];
  if (SC) qs.push('sharecode=' + encodeURIComponent(SC));
  var t = token();
  if (t) qs.push('t=' + encodeURIComponent(t));
  return qs.length ? p + (p.indexOf('?') >= 0 ? '&' : '?') + qs.join('&') : p;
}
async function api(p, opts){
  var r = await fetch(apiUrl(p), opts || {});
  var j = null;
  try { j = await r.json(); } catch(e){}
  if (!r.ok || (j && j.success === false)) {
    var msg = (j && j.error && j.error.message) || ('请求失败 HTTP ' + r.status);
    throw new Error(msg);
  }
  return j || {};
}
function el(id){ return document.getElementById(id); }
function showErr(m){ var e = el('err'); if (e) { e.textContent = m || ''; } }
function showOk(m){ var o = el('ok'); if (o) { o.textContent = m || ''; } }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
`;

function page(title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0b1110">
<title>${title}</title>
<style>${CSS}</style>
</head><body>
<div class="wrap">${body}</div>
<script>${JS_HELPERS}
${script}
</script>
</body></html>`;
}

/** 控制台首页：登录 + 绑定机器人 + 常驻开关 + 短码 + 账号管理入口 */
export function consoleHtml(): string {
  const body = `
<div class="head">
  <div class="brand">
    <div class="logo">Q</div>
    <div>
      <div class="t1">QQ 机器人控制台</div>
      <div class="t2" id="who">未登录</div>
    </div>
  </div>
  <a href="#" id="logout" style="display:none;font-size:13px;color:#8aa39d">退出</a>
</div>

<div class="card" id="loginCard">
  <h3>登录</h3>
  <label>账号</label>
  <input id="u" value="admin" autocomplete="username">
  <label style="margin-top:10px">密码</label>
  <input id="p" type="password" autocomplete="current-password">
  <button class="btn" id="doLogin">登录</button>
  <div class="err" id="err"></div>
  <div class="ok" id="ok"></div>
</div>

<div id="panel" style="display:none">
  <div class="card">
    <h3>机器人状态</h3>
    <div class="kv"><span>状态</span><span class="pill off" id="stPill">未连接</span></div>
    <div class="kv"><span>机器人</span><span id="stBot">—</span></div>
    <div class="kv"><span>AppID</span><span id="stApp">—</span></div>
    <div class="kv" id="stErrRow" style="display:none"><span>错误</span><span id="stErr" style="color:#ff8b7a"></span></div>
  </div>

  <div class="card">
    <h3>绑定 QQ 机器人</h3>
    <label>AppID</label>
    <input id="appId" placeholder="QQ 开放平台 AppID">
    <label style="margin-top:10px">AppSecret</label>
    <input id="appSecret" type="password" placeholder="QQ 开放平台 AppSecret">
    <button class="btn" id="doConnect">保存并连接</button>
    <div class="row" id="disconnectRow" style="display:none">
      <button class="btn2" id="doDisconnect">断开</button>
      <button class="btn2" id="doClear">断开并清除凭证</button>
    </div>
    <div class="small">凭证加密保存在服务器，关闭网页后服务器仍常驻接收消息。</div>
  </div>

  <div class="card">
    <h3>常驻接收</h3>
    <div class="kv"><span id="recvText">—</span><button class="btn2" id="doToggle" style="width:88px;height:36px">切换</button></div>
  </div>

  <div class="card">
    <h3>手表登录</h3>
    <div class="small" style="margin-top:0">手环「服务器地址」只填下面这串分享码即可（手表输入法打不出 ? 和 =）。</div>
    <div class="code"><code id="shareCode"></code><button class="btn2" id="doCopy" style="width:70px;height:42px">复制</button></div>
    <div class="small" id="shareHost"></div>
  </div>

  <div class="card" id="adminCard" style="display:none">
    <h3>账号管理</h3>
    <div class="small" style="margin-top:0">管理员注册新账号，对方可用自己的账号登录手表（各自独立的消息与机器人配置）。</div>
    <a href="#" id="toAccounts" style="display:inline-block;margin-top:10px">注册新账号 / 管理用户 ›</a>
  </div>

  <div class="err" id="err2"></div>
  <div class="ok" id="ok2"></div>
</div>`;

  const script = `
var state = { status: null, me: '' };

function pill(st){
  var p = el('stPill');
  var map = { connected: ['已连接','on'], connecting: ['连接中…','on'], error: ['连接出错','off'], disconnected: ['未连接','off'] };
  var v = map[st] || ['未知','off'];
  p.textContent = v[0]; p.className = 'pill ' + v[1];
}

async function refresh(){
  var r = await api('/api/bot/status', { cache: 'no-store' });
  var s = r.status || {};
  state.status = s;
  pill(s.status);
  el('stBot').textContent = (s.bot && s.bot.username) || '—';
  el('stApp').textContent = s.appId || '—';
  var hasErr = !!s.lastError;
  el('stErrRow').style.display = hasErr ? 'flex' : 'none';
  el('stErr').textContent = s.lastError || '';
  el('disconnectRow').style.display = s.hasCredentials ? 'flex' : 'none';
  el('doConnect').textContent = s.hasCredentials ? '重新连接（使用已保存凭证）' : '保存并连接';
  el('recvText').textContent = s.receive ? '开启中：服务器持续接收并入库消息' : '已关闭：停止接收新消息';
  el('doToggle').textContent = s.receive ? '关闭' : '开启';
  el('adminCard').style.display = state.me === 'admin' ? 'block' : 'none';
}

async function boot(){
  var t = token();
  if (!t) return;
  try {
    var r = await api('/api/bot/status', { cache: 'no-store' });
    state.me = (r.status && r.status.username) || '';
    // 有的版本 status 不返回 username，用登录时记录的名字兜底
    state.me = state.me || (localStorage.getItem('qqrt_user') || '');
    enterConsole();
    await refresh();
    setInterval(function(){ if (token()) { refresh().catch(function(){}); } }, 8000);
  } catch (e) {
    setToken(''); localStorage.removeItem('qqrt_user');
  }
}

function enterConsole(){
  el('loginCard').style.display = 'none';
  el('panel').style.display = 'block';
  el('logout').style.display = 'block';
  el('who').textContent = '已登录：' + (state.me || '—');
}

el('doLogin').onclick = async function(){
  showErr('');
  var u = el('u').value.trim(), p = el('p').value;
  if (!u || !p) { showErr('请输入账号和密码'); return; }
  el('doLogin').disabled = true;
  try {
    var r = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    if (r.token) setToken(r.token);
    state.me = u;
    try { localStorage.setItem('qqrt_user', u); } catch(e){}
    enterConsole();
    await refresh();
    setInterval(function(){ if (token()) { refresh().catch(function(){}); } }, 8000);
  } catch (e) {
    showErr(e.message);
  } finally {
    el('doLogin').disabled = false;
  }
};

el('logout').onclick = async function(ev){
  ev.preventDefault();
  try { await api('/api/auth/logout', { method: 'POST' }); } catch(e){}
  setToken(''); try { localStorage.removeItem('qqrt_user'); } catch(e){}
  location.reload();
};

el('doConnect').onclick = async function(){
  showErr('');
  var id = el('appId').value.trim(), sec = el('appSecret').value.trim();
  var s = state.status || {};
  if (!id && !s.hasCredentials) { showErr('请填写 AppID 与 AppSecret'); return; }
  el('doConnect').disabled = true;
  try {
    await api('/api/bot/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: id || undefined, appSecret: sec || undefined }) });
    el('appSecret').value = '';
    await refresh();
  } catch (e) { showErr(e.message); } finally { el('doConnect').disabled = false; }
};

el('doDisconnect').onclick = async function(){
  showErr('');
  try { await api('/api/bot/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clearCreds: false }) }); await refresh(); }
  catch (e) { showErr(e.message); }
};

el('doClear').onclick = async function(){
  if (!confirm('确定断开并清除已保存的 AppID / AppSecret？')) return;
  showErr('');
  try { await api('/api/bot/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clearCreds: true }) }); await refresh(); }
  catch (e) { showErr(e.message); }
};

el('doToggle').onclick = async function(){
  var s = state.status || {};
  try { await api('/api/bot/receive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !s.receive }) }); await refresh(); }
  catch (e) { showErr(e.message); }
};

// 分享码直接取自当前地址栏，手表输入这串即可
(function initShare(){
  el('shareCode').textContent = SC || '(地址缺少 sharecode)';
  el('shareHost').textContent = SC ? ('完整链接：' + location.origin + '/?sharecode=' + SC) : '';
})();

el('doCopy').onclick = function(){
  var c = el('shareCode').textContent;
  if (!c) return;
  if (navigator.clipboard) { navigator.clipboard.writeText(c).then(function(){ el('doCopy').textContent = '已复制'; setTimeout(function(){ el('doCopy').textContent = '复制'; }, 1500); }); }
};

el('toAccounts').onclick = function(ev){
  ev.preventDefault();
  location.href = '/adduser' + (SC ? '?sharecode=' + encodeURIComponent(SC) : '');
};

boot();
`;

  return page("QQ 机器人控制台", body, script);
}

/** 账号管理页：注册新用户 + 列表 + 删除（仅 admin） */
export function accountsHtml(): string {
  const body = `
<div class="head">
  <div class="brand">
    <div class="logo">Q</div>
    <div>
      <div class="t1">账号管理</div>
      <div class="t2">管理员注册新的控制台账号</div>
    </div>
  </div>
  <a href="#" id="back" style="font-size:13px;color:#8aa39d">返回</a>
</div>

<div class="card">
  <h3>新增账号</h3>
  <label>新用户账号</label>
  <input id="nu" placeholder="2-20 位中文、字母、数字或下划线">
  <label style="margin-top:10px">新用户密码</label>
  <input id="np" type="password" placeholder="6-64 位">
  <button class="btn" id="doAdd">添加用户</button>
  <div class="err" id="err"></div>
  <div class="ok" id="ok"></div>
</div>

<div class="card">
  <h3>内部用户</h3>
  <div id="list" class="list"><div class="small">加载中…</div></div>
</div>`;

  const script = `
function backUrl(){ return '/' + (SC ? '?sharecode=' + encodeURIComponent(SC) : ''); }

el('back').onclick = function(ev){ ev.preventDefault(); location.href = backUrl(); };

async function load(){
  try {
    var r = await api('/api/admin/users', { cache: 'no-store' });
    var users = r.users || [];
    if (!users.length) { el('list').innerHTML = '<div class="small">暂无内部用户</div>'; return; }
    el('list').innerHTML = users.map(function(u){
      return '<div class="item"><div><div>' + esc(u.username) + '</div><div class="small" style="margin:0">' + esc(new Date(u.createdAt).toLocaleString()) + '</div></div>' +
        '<button class="del" data-id="' + esc(u.id) + '">删除</button></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.del'), function(b){
      b.onclick = function(){ del(b.getAttribute('data-id')); };
    });
  } catch (e) {
    el('list').innerHTML = '<div class="err">' + esc(e.message) + '</div>';
    if (/登录/.test(e.message)) { location.href = backUrl(); }
  }
}

async function del(id){
  if (!confirm('删除这个用户？')) return;
  try { await api('/api/admin/users/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) }); await load(); }
  catch (e) { el('err').textContent = e.message; }
}

el('doAdd').onclick = async function(){
  el('err').textContent = ''; el('ok').textContent = '';
  var u = el('nu').value.trim(), p = el('np').value;
  if (!u || !p) { el('err').textContent = '请填写账号和密码'; return; }
  el('doAdd').disabled = true;
  try {
    var r = await api('/api/admin/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    el('ok').textContent = '已添加：' + ((r.user && r.user.username) || u);
    el('nu').value = ''; el('np').value = '';
    await load();
  } catch (e) {
    el('err').textContent = e.message;
  } finally {
    el('doAdd').disabled = false;
  }
};

load();
`;

  return page("账号管理", body, script);
}
