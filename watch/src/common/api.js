/**
 * QQRT for Xiaomi Band 9 Pro (Vela / HyperOS)
 * 公共网络层：只使用 @system.fetch（Vela 支持），不使用 request/download/upload。
 * 服务端接口与旧版 QQRT 保持一致：/api/watch/*
 */
import fetch from '@system.fetch'
import storage from '@system.storage'
import prompt from '@system.prompt'
import router from '@system.router'

const K_HOST = 'qq_host'
const K_TOKEN = 'qq_token'
const K_ACCT = 'qq_acct'
const K_SAVED_LOGIN = 'qq_saved_login'
const K_AUTO_LOGIN = 'qq_auto_login'
const K_FONT = 'qq_font'
const K_TRIM = 'qq_trim'

const auth = { host: '', token: '', account: '' }

/* ---------------- 存储 ---------------- */
export function sget(key, cb) {
  try {
    storage.get({
      key: key,
      default: '',
      success: function (v) {
        cb && cb(typeof v === 'string' ? v : (v && v.value) || '')
      },
      fail: function () { cb && cb('') }
    })
  } catch (e) { cb && cb('') }
}

export function sset(key, val, cb) {
  try {
    storage.set({
      key: key,
      value: String(val === undefined || val === null ? '' : val),
      success: function () { cb && cb(null) },
      fail: function () { cb && cb(new Error('本地存储写入失败')) }
    })
  } catch (e) { cb && cb(e) }
}

export function sdel(key, cb) {
  try {
    storage.delete({ key: key, success: function () { cb && cb(null) }, fail: function () { cb && cb(new Error('本地存储删除失败')) } })
  } catch (e) { cb && cb(e) }
}

/* ---------------- 服务器地址 ---------------- */
export function normHost(v) {
  var s = String(v || '').trim()
  if (!s) return ''
  // 纯字母数字（没有点/斜杠/冒号）= 分享码，自动补成完整分享链接。
  // 手环输入法打不出 ? 和 =，这样只需输入 8~40 位码。
  if (/^[A-Za-z0-9_-]{6,40}$/.test(s)) {
    return DEFAULT_BASE + '/?sharecode=' + s.toUpperCase()
  }
  if (s.indexOf('://') < 0) {
    // 局域网 / 本机地址默认走 http，公网域名默认 https
    var isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(s)
    s = (isLocal ? 'http://' : 'https://') + s
  }
  while (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.substring(0, s.length - 1)
  return s
}

/**
 * 旧版「dpaste 短码」识别。
 * 现在托管分享链接的 sharecode 也是纯字母数字，两者无法区分，且 dpaste 在国内
 * 经常连不上，表现为「短码解析失败，请检查网络」。所以默认不再走 dpaste，
 * 只有显式以 # 开头时才当作短码（保留兼容）。
 */
export function isShortCode(v) {
  return /^#[A-Za-z0-9]{5,32}$/.test(String(v || '').trim())
}

/* 短码 -> 真实地址（dpaste 纯文本） */
export function resolveShortCode(code, cb) {
  const url = 'https://dpaste.com/' + String(code || '').trim().replace(/^#/, '') + '.txt'
  try {
    fetch.fetch({
      url: url,
      method: 'GET',
      responseType: 'text',
      success: function (resp) {
        const txt = String((resp && resp.data) || '').trim()
        if (/^https?:\/\/[^\/\s]+/i.test(txt)) cb(null, txt)
        else cb(new Error('短码内容不是有效地址'))
      },
      fail: function () { cb(new Error('短码解析失败，请检查网络')) }
    })
  } catch (e) { cb(new Error('短码解析失败')) }
}

/* ---------------- 登录态 ---------------- */
export function loadAuth(cb) {
  sget(K_HOST, function (h) {
    auth.host = normHost(h)
    sget(K_TOKEN, function (t) {
      auth.token = String(t || '')
      sget(K_ACCT, function (a) {
        auth.account = String(a || '')
        cb && cb()
      })
    })
  })
}

export function saveHost(host, cb) {
  const h = normHost(host)
  if (!h) { cb && cb(new Error('地址无效')); return }
  auth.host = h
  sset(K_HOST, h, cb)
}

export function saveLogin(token, account, cb) {
  auth.token = String(token || '')
  auth.account = String(account || '')
  sset(K_TOKEN, auth.token, (tokenErr) => {
    if (tokenErr) { cb && cb(tokenErr); return }
    sset(K_ACCT, auth.account, cb)
  })
}

export function saveRememberedLogin(host, account, password, cb) {
  const value = JSON.stringify({ host: normHost(host), account: String(account || ''), password: String(password || '') })
  sset(K_SAVED_LOGIN, value, (err) => {
    if (err) { cb && cb(err); return }
    sset(K_AUTO_LOGIN, '1', (enableErr) => {
      if (!enableErr) { cb && cb(null); return }
      sdel(K_SAVED_LOGIN, () => { cb && cb(enableErr) })
    })
  })
}

export function clearRememberedLogin(cb) {
  sdel(K_SAVED_LOGIN, (err) => {
    if (err) {
      sset(K_AUTO_LOGIN, '0', () => { cb && cb(err) })
      return
    }
    sset(K_AUTO_LOGIN, '0', cb)
  })
}

export function loadRememberedLogin(cb) {
  sget(K_AUTO_LOGIN, (enabled) => {
    sget(K_SAVED_LOGIN, (raw) => {
      if (enabled !== '1') { cb && cb({ enabled: false, host: '', account: '', password: '' }); return }
      let saved = null
      try { saved = raw ? JSON.parse(raw) : null } catch (e) {}
      cb && cb({ enabled: true, host: normHost(saved && saved.host || ''), account: saved && saved.account || '', password: saved && saved.password || '' })
    })
  })
}

export function clearLogin(cb) {
  auth.token = ''
  sset(K_TOKEN, '', cb)
}

export function getHost() { return auth.host }
export function getToken() { return auth.token }
export function getAccount() { return auth.account }
export function hasAuth() { return !!(auth.host && auth.token) }

/**
 * 默认服务器（WorkBuddy 托管分享链接）。
 * 分享链接必须带 sharecode，否则反代会返回 403。
 * 手环输入法打不出 ? 和 =，所以支持「只填分享码」：
 *   TFK3NX7DXP  →  https://<host>/?sharecode=TFK3NX7DXP
 */
export const DEFAULT_BASE = 'https://qqrt-chat-server.apps.workbuddy.host'
export const DEFAULT_SHARECODE = 'TFK3NX7DXP'
export const DEFAULT_HOST = DEFAULT_BASE + '/?sharecode=' + DEFAULT_SHARECODE

/* ---------------- 请求 ---------------- */
export function buildUrl(path, params) {
  // 服务器地址可能自带查询串（如 WorkBuddy 分享链接的 ?sharecode=xxx），
  // 必须拆出来：host 只保留协议+域名，查询串拼到路径参数后面。
  var host = String(auth.host || '')
  var baseQuery = ''
  var qi = host.indexOf('?')
  if (qi >= 0) {
    baseQuery = host.substring(qi + 1)
    host = host.substring(0, qi)
  }
  var url = host + path
  var qs = []
  if (baseQuery) qs.push(baseQuery)
  Object.keys(params || {}).forEach(function (k) {
    var v = params[k]
    if (v === undefined || v === null || v === '') return
    qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
  })
  if (qs.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs.join('&')
  if (auth.token) url += (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(auth.token)
  return url
}

function parseJson(text) {
  try { return JSON.parse(String(text || '')) } catch (e) { return null }
}

/**
 * cb(err, obj)
 * err: { code: 'AUTH' | 'NET' | 'BIZ', msg: '...' }
 */
export function request(method, path, params, body, cb) {
  if (!auth.host) { cb && cb({ code: 'NET', msg: '未设置服务器地址' }); return }
  const url = buildUrl(path, params)
  var done = false
  function finish(err, obj) {
    if (done) return
    done = true
    cb && cb(err, obj)
  }
  const opts = {
    url: url,
    method: method,
    responseType: 'text',
    success: function (resp) {
      const code = Number((resp && resp.code) || 0)
      const obj = parseJson(resp && resp.data)
      if (code === 401 || (obj && obj.success === false && obj.error && obj.error.type === 'AUTH_ERROR')) {
        finish({ code: 'AUTH', msg: '登录已失效' })
        return
      }
      if (code === 403) {
        finish({ code: 'BIZ', msg: '服务器拒绝(403)：地址要填完整分享链接，含 ?sharecode=' })
        return
      }
      if (!obj || obj.success !== true) {
        const em = (obj && obj.error && (obj.error.message || obj.error)) || ('请求失败 ' + code)
        finish({ code: 'BIZ', msg: String(em) })
        return
      }
      finish(null, obj)
    },
    fail: function (data, code) {
      var c = Number(code) || 0
      // 蜂窝 / eSIM 首次建链（PDP 激活、DNS 就绪）常常慢一拍，GET 自动重试一次。
      // POST 绝不重试：可能已经到达服务端，重试会造成重复发消息。
      if (method === 'GET' && retries < 1 && isRetryableNetCode(c)) {
        retries++
        try { setTimeout(fire, 1200) } catch (e) { finish({ code: 'NET', msg: netFailMsg(c) }) }
        return
      }
      finish({ code: 'NET', msg: netFailMsg(c) })
    }
  }
  if (method === 'POST') {
    opts.data = JSON.stringify(body || {})
    opts.header = { 'Content-Type': 'application/json' }
  }
  var retries = 0
  function fire() {
    try {
      fetch.fetch(opts)
    } catch (e) {
      finish({ code: 'NET', msg: '网络请求异常' })
    }
  }
  fire()
}

export function get(path, params, cb) { request('GET', path, params, null, cb) }
export function post(path, body, cb) { request('POST', path, null, body, cb) }

export function testHost(host, cb) {
  const h = normHost(host)
  if (!h) { cb(new Error('地址无效')); return }
  // host 可能带 ?sharecode=xxx
  const qi = h.indexOf('?')
  const base = qi >= 0 ? h.substring(0, qi) : h
  const query = qi >= 0 ? h.substring(qi) : ''
  try {
    fetch.fetch({
      url: base + '/api/watch/test' + query,
      method: 'GET',
      responseType: 'text',
      success: function (resp) {
        const obj = parseJson(resp && resp.data)
        if (obj && obj.success === true) cb(null, obj)
        else cb(new Error('服务器响应异常'))
      },
      fail: function () { cb(new Error('连接失败')) }
    })
  } catch (e) { cb(new Error('连接失败')) }
}

/* ---------------- 设备 / 网络能力（S5 eSIM 适配） ---------------- */

/**
 * 把 Vela fetch 的错误码翻成人话。
 * 60 = TLS 证书链校验失败（缺根证书）；6 = DNS；7 = 连不上；28 = 超时。
 */
/** 6=DNS、7=连不上、28=超时：蜂窝首次建链常见的可重试错误 */
export function isRetryableNetCode(c) {
  var n = Number(c) || 0
  return n === 6 || n === 7 || n === 28 || n === 0
}

export function netFailMsg(code) {
  var c = Number(code) || 0
  if (c === 60 || c === 51) return '证书校验失败(60)：缺根证书，需 CA 补丁'
  if (c === 6) return '域名解析失败(6)：蜂窝 DNS 未就绪或未给应用联网'
  if (c === 7) return '连接失败(7)：Wi-Fi / eSIM 数据未通'
  if (c === 28) return '请求超时(28)：蜂窝建链慢或网络不通'
  if (c === 403) return '服务器拒绝(403)：分享链接要带 ?sharecode='
  return '网络连接失败' + (c ? '(' + c + ')' : '')
}

/** 设备快照（app.ux 里 device.getInfo 的结果） */
export function getDeviceSnapshot() {
  var g = typeof global !== 'undefined' ? global : {}
  var d = g.deviceInfo || {}
  return {
    model: d.model || '未知型号',
    product: d.product || '',
    brand: d.brand || '',
    deviceType: d.deviceType || '',
    osType: d.osType || '',
    osVersionName: d.osVersionName || '',
    platformVersionName: d.platformVersionName || '',
    platformVersionCode: d.platformVersionCode || 0,
    screenWidth: d.screenWidth || 0,
    screenHeight: d.screenHeight || 0,
    screenShape: d.screenShape || g.screenShape || 'rect',
    isCircle: !!g.isCircle,
    designH: g.designH || 480,
    netHint: g.netHint || 'unknown'
  }
}

/**
 * 实测网络：不带登录态直接打 /api/health。
 * cb({ ok, code, ms, msg, hint })
 *   hint: native=可直连 / cert=缺证书 / net=无网络 / server=服务端异常
 * S5（Wi-Fi 或 eSIM）应当直接 ok；手环 10 Pro 需手机代理 + TUN 模块。
 */
export function probeNetwork(cb) {
  var host = String(auth.host || DEFAULT_HOST)
  var qi = host.indexOf('?')
  var base = qi >= 0 ? host.substring(0, qi) : host
  var query = qi >= 0 ? host.substring(qi) : ''
  var url = base + '/api/health' + query
  var t0 = Date.now()
  var done = false
  var attempt = 0
  var MAX = 3
  var watchdog = null

  function finish(o) {
    if (done) return
    done = true
    if (watchdog) { try { clearTimeout(watchdog) } catch (e) {} }
    o.ms = Date.now() - t0
    o.attempts = attempt
    cb && cb(o)
  }

  function fire() {
    attempt++
    try {
      fetch.fetch({
        url: url,
        method: 'GET',
        responseType: 'text',
        success: function (resp) {
          var code = Number(resp && resp.code) || 0
          var obj = parseJson(resp && resp.data)
          if (code >= 200 && code < 300 && obj && obj.ok !== false) {
            finish({ ok: true, code: code, msg: '服务器可达', hint: 'native' })
          } else {
            finish({ ok: false, code: code, msg: '服务器返回 ' + code, hint: 'server' })
          }
        },
        fail: function (data, code) {
          var c = Number(code) || 0
          // eSIM 蜂窝 PDP 激活 / DNS 就绪常常慢一拍，给 3 次机会
          if (attempt < MAX && isRetryableNetCode(c)) {
            try { setTimeout(fire, 1500); return } catch (e) {}
          }
          finish({
            ok: false, code: c, msg: netFailMsg(c),
            hint: (c === 60 || c === 51) ? 'cert' : 'net'
          })
        }
      })
    } catch (e) {
      finish({ ok: false, code: 0, msg: '网络请求异常', hint: 'net' })
    }
  }

  // Vela 的 fetch 没有 timeout 参数，自己加看门狗，避免蜂窝挂起时一直转圈
  try {
    watchdog = setTimeout(function () {
      finish({ ok: false, code: 28, msg: netFailMsg(28) + '（无响应）', hint: 'net' })
    }, 15000)
  } catch (e) {}

  fire()
}

/* ---------------- 通用工具 ---------------- */
export function toast(msg) {
  try { prompt.showToast({ message: String(msg || '') }) } catch (e) {}
}

export function go(uri, params) {
  try { router.push({ uri: uri, params: params || {} }) } catch (e) {}
}

export function back() {
  try { router.back() } catch (e) {}
}

export function replace(uri, params) {
  try { router.replace({ uri: uri, params: params || {} }) } catch (e) {}
}

export function pad2(n) { return n < 10 ? '0' + n : '' + n }

export function hhmm(ts) {
  const t = Number(ts) || 0
  if (!t) return ''
  const d = new Date(t)
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

export function listTime(ts) {
  const t = Number(ts) || 0
  if (!t) return ''
  const d = new Date(t)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return hhmm(t)
  const y = new Date(now.getTime() - 86400000)
  if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return '昨天'
  return (d.getMonth() + 1) + '/' + d.getDate()
}

/* 消息类型 -> 文字占位（图片/语音/视频等只显示标签，不做下载渲染） */
export function msgTag(item) {
  const t = (item && item.msgType) || ''
  if (t === 'image') return '[图片]'
  if (t === 'video') return '[视频]'
  if (t === 'voice' || t === 'audio') return '[语音]'
  if (t === 'music') return '[音乐]'
  if (t === 'file') return '[文件]'
  if (t === 'forward') return '[聊天记录]'
  if (t === 'sticker') return ''
  return ''
}

export function msgText(item) {
  const t = String((item && item.text) || '')
  if (!t) return ''
  if (item && item.msgType === 'forward' && t.indexOf('{') === 0) {
    const m = t.match(/"title"\s*:\s*"([^"]{1,40})"/)
    return m ? m[1] : '[聊天记录]'
  }
  return t
}

export function previewText(item) {
  const txt = msgText(item)
  if (txt) return txt.replace(/\s+/g, ' ')
  const tag = msgTag(item)
  return tag || ''
}

/* ---------------- 表情码 -> Unicode 表情 ---------------- */
const EMOJI_CP = {
  '[微笑]': 0x1F642,
  '[撇嘴]': 0x1F615,
  '[色]': 0x1F60D,
  '[发呆]': 0x1F610,
  '[得意]': 0x1F60F,
  '[流泪]': 0x1F622,
  '[害羞]': 0x1F60A,
  '[闭嘴]': 0x1F910,
  '[睡]': 0x1F634,
  '[大哭]': 0x1F62D,
  '[尴尬]': 0x1F605,
  '[发怒]': 0x1F620,
  '[调皮]': 0x1F61B,
  '[呲牙]': 0x1F601,
  '[惊讶]': 0x1F62E,
  '[难过]': 0x1F61E,
  '[酷]': 0x1F60E,
  '[冷汗]': 0x1F630,
  '[抓狂]': 0x1F62B,
  '[吐]': 0x1F922,
  '[偷笑]': 0x1F92D,
  '[可爱]': 0x1F97A,
  '[白眼]': 0x1F644,
  '[傲慢]': 0x1F624,
  '[饥饿]': 0x1F924,
  '[困]': 0x1F971,
  '[惊恐]': 0x1F631,
  '[流汗]': 0x1F613,
  '[憨笑]': 0x1F604,
  '[悠闲]': 0x1F60C,
  '[奋斗]': 0x1F4AA,
  '[咒骂]': 0x1F92C,
  '[疑问]': 0x2753,
  '[嘘]': 0x1F92B,
  '[晕]': 0x1F635,
  '[敲打]': 0x1F44A,
  '[再见]': 0x1F44B,
  '[擦汗]': 0x1F625,
  '[鼓掌]': 0x1F44F,
  '[坏笑]': 0x1F608,
  '[亲亲]': 0x1F618,
  '[吓]': 0x1F628,
  '[菜刀]': 0x1F52A,
  '[西瓜]': 0x1F349,
  '[啤酒]': 0x1F37A,
  '[篮球]': 0x1F3C0,
  '[咖啡]': 0x2615,
  '[饭]': 0x1F35A,
  '[猪头]': 0x1F437,
  '[玫瑰]': 0x1F339,
  '[爱心]': 0x2764,
  '[心碎]': 0x1F494,
  '[蛋糕]': 0x1F382,
  '[闪电]': 0x26A1,
  '[炸弹]': 0x1F4A3,
  '[足球]': 0x26BD,
  '[便便]': 0x1F4A9,
  '[月亮]': 0x1F319,
  '[太阳]': 0x2600,
  '[礼物]': 0x1F381,
  '[拥抱]': 0x1F917,
  '[强]': 0x1F44D,
  '[弱]': 0x1F44E,
  '[握手]': 0x1F91D,
  '[胜利]': 0x270C,
  '[抱拳]': 0x1F64F,
  '[拳头]': 0x270A,
  '[OK]': 0x1F44C,
  '[转圈]': 0x1F483,
  '[跳绳]': 0x1F938,
  '[激动]': 0x1F929,
  '[街舞]': 0x1F57A,
  '[骷髅]': 0x1F480,
  '[凋谢]': 0x1F940,
  '[乒乓]': 0x1F3D3
}
const EMOJI_MAP = {}
Object.keys(EMOJI_CP).forEach(function (k) {
  try { EMOJI_MAP[k] = String.fromCodePoint(EMOJI_CP[k]) } catch (e) { EMOJI_MAP[k] = k }
})

/** QQ 表情码 -> 本地表情图（手环字体没有 emoji 字形，只能画图） */
const EMOJI_IMG = {
  '[微笑]': '/common/emoji/1f642.png',
  '[撇嘴]': '/common/emoji/1f615.png',
  '[色]': '/common/emoji/1f60d.png',
  '[发呆]': '/common/emoji/1f610.png',
  '[得意]': '/common/emoji/1f60f.png',
  '[流泪]': '/common/emoji/1f622.png',
  '[害羞]': '/common/emoji/1f60a.png',
  '[闭嘴]': '/common/emoji/1f910.png',
  '[睡]': '/common/emoji/1f634.png',
  '[大哭]': '/common/emoji/1f62d.png',
  '[尴尬]': '/common/emoji/1f605.png',
  '[发怒]': '/common/emoji/1f620.png',
  '[调皮]': '/common/emoji/1f61b.png',
  '[呲牙]': '/common/emoji/1f601.png',
  '[惊讶]': '/common/emoji/1f62e.png',
  '[难过]': '/common/emoji/1f61e.png',
  '[酷]': '/common/emoji/1f60e.png',
  '[冷汗]': '/common/emoji/1f630.png',
  '[抓狂]': '/common/emoji/1f62b.png',
  '[吐]': '/common/emoji/1f922.png',
  '[偷笑]': '/common/emoji/1f92d.png',
  '[可爱]': '/common/emoji/1f97a.png',
  '[白眼]': '/common/emoji/1f644.png',
  '[傲慢]': '/common/emoji/1f624.png',
  '[饥饿]': '/common/emoji/1f924.png',
  '[困]': '/common/emoji/1f971.png',
  '[惊恐]': '/common/emoji/1f631.png',
  '[流汗]': '/common/emoji/1f613.png',
  '[憨笑]': '/common/emoji/1f604.png',
  '[悠闲]': '/common/emoji/1f60c.png',
  '[奋斗]': '/common/emoji/1f4aa.png',
  '[咒骂]': '/common/emoji/1f92c.png',
  '[疑问]': '/common/emoji/2753.png',
  '[嘘]': '/common/emoji/1f92b.png',
  '[晕]': '/common/emoji/1f635.png',
  '[敲打]': '/common/emoji/1f44a.png',
  '[再见]': '/common/emoji/1f44b.png',
  '[擦汗]': '/common/emoji/1f625.png',
  '[鼓掌]': '/common/emoji/1f44f.png',
  '[坏笑]': '/common/emoji/1f608.png',
  '[亲亲]': '/common/emoji/1f618.png',
  '[吓]': '/common/emoji/1f628.png',
  '[菜刀]': '/common/emoji/1f52a.png',
  '[西瓜]': '/common/emoji/1f349.png',
  '[啤酒]': '/common/emoji/1f37a.png',
  '[篮球]': '/common/emoji/1f3c0.png',
  '[咖啡]': '/common/emoji/2615.png',
  '[饭]': '/common/emoji/1f35a.png',
  '[猪头]': '/common/emoji/1f437.png',
  '[玫瑰]': '/common/emoji/1f339.png',
  '[爱心]': '/common/emoji/2764.png',
  '[心碎]': '/common/emoji/1f494.png',
  '[蛋糕]': '/common/emoji/1f382.png',
  '[闪电]': '/common/emoji/26a1.png',
  '[炸弹]': '/common/emoji/1f4a3.png',
  '[足球]': '/common/emoji/26bd.png',
  '[便便]': '/common/emoji/1f4a9.png',
  '[月亮]': '/common/emoji/1f319.png',
  '[太阳]': '/common/emoji/2600.png',
  '[礼物]': '/common/emoji/1f381.png',
  '[拥抱]': '/common/emoji/1f917.png',
  '[强]': '/common/emoji/1f44d.png',
  '[弱]': '/common/emoji/1f44e.png',
  '[握手]': '/common/emoji/1f91d.png',
  '[胜利]': '/common/emoji/270c.png',
  '[抱拳]': '/common/emoji/1f64f.png',
  '[拳头]': '/common/emoji/270a.png',
  '[OK]': '/common/emoji/1f44c.png',
  '[转圈]': '/common/emoji/1f483.png',
  '[跳绳]': '/common/emoji/1f938.png',
  '[激动]': '/common/emoji/1f929.png',
  '[街舞]': '/common/emoji/1f57a.png',
  '[骷髅]': '/common/emoji/1f480.png',
  '[凋谢]': '/common/emoji/1f940.png',
  '[乒乓]': '/common/emoji/1f3d3.png'
}

/** 把文本按表情码拆成「文字 + 表情图列表」 */
export function splitEmoji(text) {
  const t = String(text || '')
  const imgs = []
  if (t.indexOf('[') < 0) return { text: t, imgs: imgs }
  const rest = t.replace(/\[[^\]]{1,6}\]/g, function (m) {
    const img = EMOJI_IMG[m]
    if (!img) return m
    if (imgs.length < 6) imgs.push(img)
    return ''
  })
  return { text: rest.replace(/\s+/g, ' ').trim(), imgs: imgs }
}

/** 把 QQ 表情码替换成真表情字符（未收录的保持原样） */
export function renderEmoji(text) {
  var t = String(text || '')
  if (t.indexOf('[') < 0) return t
  return t.replace(/\[[^\]]{1,6}\]/g, function (m) {
    return EMOJI_MAP[m] || m
  })
}

/* ---------------- 富文本：表情码 + 真 emoji 字符 统一转本地表情图 ---------------- */
const UNI_IMG = {}
Object.keys(EMOJI_CP).forEach(function (k) {
  const img = EMOJI_IMG[k]
  if (img) UNI_IMG[EMOJI_CP[k].toString(16)] = img
})

/**
 * 拆成 { text, imgs }：
 *  - [微笑] 这类 QQ 表情码 -> 图
 *  - 🙂 这类真 emoji 字符 -> 图（QQ 转发过来时是字符）
 *  - 没有对应图的 emoji 直接丢掉，手环字体没有字形，留着就是一个方块
 */
export function splitRich(text) {
  const raw = String(text || '')
  const imgs = []
  if (!raw) return { text: '', imgs: imgs }

  const byCode = splitEmoji(raw)
  for (let i = 0; i < byCode.imgs.length && imgs.length < 6; i++) imgs.push(byCode.imgs[i])

  const src = byCode.text
  let clean = ''
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < src.length) {
      const low = src.charCodeAt(i + 1)
      const cp = ((c - 0xd800) << 10) + (low - 0xdc00) + 0x10000
      const img = UNI_IMG[cp.toString(16)]
      if (img) { if (imgs.length < 6) imgs.push(img) }
      i++
      continue
    }
    if (c >= 0x2600 && c <= 0x27bf) continue // 杂项符号，无图直接丢
    clean += src.charAt(i)
  }
  return { text: clean.replace(/\s+/g, ' ').trim(), imgs: imgs.slice(0, 6) }
}

/** 表情码 -> 表情图路径（给表情面板用） */
export function emojiImage(code) {
  return EMOJI_IMG[code] || ''
}

/** 取消息里第一张图片附件的索引，没有返回 -1 */
export function firstImageIndex(item) {
  const atts = (item && item.attachments) || []
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i] || {}
    const kind = String(a.kind || '')
    const name = String(a.filename || '').toLowerCase()
    const ct = String(a.contentType || '').toLowerCase()
    if (kind === 'image' || ct.indexOf('image/') === 0 || /\.(jpg|jpeg|png|webp|gif|bmp)$/.test(name)) return i
  }
  if (item && item.msgType === 'image') return atts.length ? 0 : -1
  return -1
}

/** 会话标题美化：服务端有时把 openid 当标题，显示成一串十六进制很难看 */
export function prettyTitle(title, scope) {
  const t = String(title || '').trim()
  if (!t) return scope === 'group' ? '群聊' : 'QQ好友'
  if (/^[0-9A-Fa-f]{16,}$/.test(t) || (t.length > 20 && !/[\u4e00-\u9fa5]/.test(t))) {
    return (scope === 'group' ? '群聊' : 'QQ好友') + '·' + t.slice(-4)
  }
  return t
}
