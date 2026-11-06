"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, errText, getAuthToken, linkOf, setAuthToken, type BotStatus } from "@/lib/api";

/**
 * 精简工作台：登录账号 + 绑定 QQ 机器人二要素（AppID / AppSecret）+ 常驻接收开关。
 * 这是服务端唯一保留的网页，聊天相关 UI 已全部移除。
 */

const USERNAME_KEY = "qqc_username";

function readUsername(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(USERNAME_KEY) || "";
  } catch {
    return "";
  }
}

function writeUsername(name: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USERNAME_KEY, name);
  } catch {
    /* ignore */
  }
}

function clearUsername() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(USERNAME_KEY);
  } catch {
    /* ignore */
  }
}

const STATUS_TEXT: Record<BotStatus["status"], { label: string; cls: string }> = {
  connected: { label: "已连接", cls: "bg-brand-soft text-brand" },
  connecting: { label: "连接中…", cls: "bg-accent-soft text-accent" },
  error: { label: "连接出错", cls: "bg-danger-soft text-danger" },
  disconnected: { label: "未连接", cls: "bg-line-soft text-ink-soft" },
};

export default function Workspace() {
  const [ready, setReady] = useState(false);
  // 从 localStorage 直接初始化，避免在 effect 里同步 setState（React 19 lint 规则）。
  const [username, setUsername] = useState<string>(() => readUsername());

  const [status, setStatus] = useState<BotStatus | null>(null);

  // 认证表单
  const [authUser, setAuthUser] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState("");

  // 绑定表单
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [connectBusy, setConnectBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // 手表登录短码
  const [shareCode, setShareCode] = useState("");
  const [shareHost, setShareHost] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [shareErr, setShareErr] = useState("");
  const [shareCopied, setShareCopied] = useState(false);

  const logoutLocal = useCallback(() => {
    setAuthToken(null);
    clearUsername();
    setUsername("");
    setStatus(null);
  }, []);

  /** 仅 401/鉴权失败才算登录态失效；普通网络抖动不登出。 */
  const isAuthExpired = useCallback((e: unknown) => {
    return e instanceof ApiError && (e.detail.type === "AUTH_ERROR" || e.detail.code === 401);
  }, []);

  // 首次挂载：从 localStorage 恢复用户名（useState 惰性初始化已做），
  // 校验登录态，全部 setState 都放在异步回调里，避免同步 setState。
  useEffect(() => {
    const token = getAuthToken();
    if (token && username) {
      void (async () => {
        try {
          const s = await api.status();
          setStatus(s);
        } catch (e) {
          if (e instanceof ApiError && (e.detail.type === "AUTH_ERROR" || e.detail.code === 401)) {
            setAuthToken(null);
            clearUsername();
            setUsername("");
          }
        } finally {
          setReady(true);
        }
      })();
    } else {
      // 无 token 或未记住用户名：直接标记就绪（在微任务里 setState，规避同步 setState）
      queueMicrotask(() => setReady(true));
    }
  }, [username]);

  // 登录后定时静默轮询机器人状态（不禁用按钮、不闪烁），反映网关重连等变化
  useEffect(() => {
    if (!username) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const s = await api.status();
          setStatus(s);
        } catch (e) {
          if (isAuthExpired(e)) logoutLocal();
        }
      })();
    }, 5000);
    return () => clearInterval(timer);
  }, [username, isAuthExpired, logoutLocal]);

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="text-sm text-ink-soft">加载中…</div>
      </div>
    );
  }

  // ── 未登录：登录 ──────────────────────────────────────────────
  if (!username) {
    const submit = async () => {
      setAuthBusy(true);
      setAuthErr("");
      try {
        const res = await api.login(authUser.trim(), authPass);
        writeUsername(res.user.username);
        setUsername(res.user.username);
        setStatus(null);
      } catch (e) {
        setAuthErr(errText(e));
      } finally {
        setAuthBusy(false);
      }
    };

    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-brand grid place-items-center text-white font-display text-xl font-bold mb-3">
              Q
            </div>
            <h1 className="font-display text-xl font-bold text-ink">QQ 机器人控制台</h1>
            <p className="text-sm text-ink-soft mt-1">登录后绑定机器人，手表即可收发消息</p>
          </div>

          <div className="bg-card rounded-2xl border border-line p-5 shadow-sm">
            <div className="bg-brand rounded-xl p-1 mb-4 text-center text-white font-semibold">登录</div>

            <label className="block text-xs text-ink-soft mb-1">账号</label>
            <input
              value={authUser}
              onChange={(e) => setAuthUser(e.target.value)}
              placeholder="2-20 位中文、字母、数字或下划线"
              className="w-full h-10 px-3 rounded-lg bg-panel border border-line text-ink text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-bright"
            />
            <label className="block text-xs text-ink-soft mb-1">密码</label>
            <input
              type="password"
              value={authPass}
              onChange={(e) => setAuthPass(e.target.value)}
              placeholder="6-64 位"
              className="w-full h-10 px-3 rounded-lg bg-panel border border-line text-ink text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-brand-bright"
            />

            {authErr && <div className="text-sm text-danger mb-3">{authErr}</div>}

            <button
              type="button"
              onClick={submit}
              disabled={authBusy}
              className="w-full h-11 rounded-xl bg-brand text-white font-semibold disabled:opacity-60"
            >
              {authBusy ? "请稍候…" : "登录"}
            </button>
            <div className="text-center mt-3">
              <a href={linkOf("/adduser")} className="text-xs text-ink-soft hover:text-brand">
                没有账号？自助注册 / 账号管理 →
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 已登录：绑定二要素 + 状态 ─────────────────────────────────────────
  const st = status;
  const statCfg = st ? STATUS_TEXT[st.status] : { label: "加载中…", cls: "bg-line-soft text-ink-soft" };

  const doConnect = async () => {
    setConnectBusy(true);
    setMsg("");
    try {
      const a = appId.trim();
      const s = appSecret.trim();
      if (a || s) {
        if (!a || !s) {
          setMsg("AppID 与 AppSecret 需要同时填写");
          return;
        }
        const next = await api.connect(a, s);
        setStatus(next);
        setMsg(next.connected ? "连接成功，机器人已开始常驻接收" : "连接失败，请查看下方错误信息");
      } else {
        const next = await api.connect();
        setStatus(next);
        setMsg(next.connected ? "已重新连接" : "连接失败，请查看下方错误信息");
      }
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setConnectBusy(false);
    }
  };

  const doDisconnect = async (clearCreds: boolean) => {
    setConnectBusy(true);
    setMsg("");
    try {
      const next = await api.disconnect(clearCreds);
      setStatus(next);
      setMsg(clearCreds ? "已断开并清除凭证" : "已断开机器人");
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setConnectBusy(false);
    }
  };

  const doToggleReceive = async (on: boolean) => {
    setMsg("");
    try {
      const next = await api.setReceive(on);
      setStatus(next);
      setMsg(on ? "已开启常驻接收" : "已关闭常驻接收");
    } catch (e) {
      setMsg(errText(e));
    }
  };

  const doShareHost = async () => {
    setShareBusy(true);
    setShareErr("");
    setShareCopied(false);
    try {
      const r = await api.shareHost();
      setShareCode(r.code);
      setShareHost(r.host);
    } catch (e) {
      setShareErr(errText(e));
    } finally {
      setShareBusy(false);
    }
  };

  const doCopyShareCode = async () => {
    if (!shareCode) return;
    try {
      await navigator.clipboard.writeText(shareCode);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2000);
    } catch {
      setShareCopied(false);
    }
  };

  const doLogout = async () => {
    await api.logout();
    setUsername("");
    setStatus(null);
    setAppId("");
    setAppSecret("");
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-brand grid place-items-center text-white font-display text-lg font-bold">
              Q
            </div>
            <div>
              <div className="font-display text-lg font-bold text-ink leading-tight">QQ 机器人控制台</div>
              <div className="text-xs text-ink-soft">已登录：{username}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={doLogout}
            className="text-sm text-ink-soft hover:text-danger transition"
          >
            退出
          </button>
        </div>

        {/* 机器人状态 */}
        <div className="bg-card rounded-2xl border border-line p-5 shadow-sm mb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-ink">机器人状态</div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${statCfg.cls}`}>
              {statCfg.label}
            </span>
          </div>
          <div className="text-sm text-ink-soft space-y-1">
            {st?.bot && <div>机器人：{st.bot.username}</div>}
            {st?.appId && <div>AppID：{st.appId}</div>}
            {st?.lastError && <div className="text-danger">错误：{st.lastError}</div>}
            {!st?.hasCredentials && <div>尚未填写 AppID / AppSecret</div>}
          </div>
        </div>

        {/* 绑定二要素 */}
        <div className="bg-card rounded-2xl border border-line p-5 shadow-sm mb-3">
          <div className="text-sm font-semibold text-ink mb-3">绑定 QQ 机器人二要素</div>
          <label className="block text-xs text-ink-soft mb-1">AppID</label>
          <input
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="QQ 开放平台 AppID"
            className="w-full h-10 px-3 rounded-lg bg-panel border border-line text-ink text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-bright"
          />
          <label className="block text-xs text-ink-soft mb-1">AppSecret</label>
          <input
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder="QQ 开放平台 AppSecret"
            className="w-full h-10 px-3 rounded-lg bg-panel border border-line text-ink text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-brand-bright"
          />
          <button
            type="button"
            onClick={doConnect}
            disabled={connectBusy}
            className="w-full h-11 rounded-xl bg-brand text-white font-semibold disabled:opacity-60"
          >
            {connectBusy
              ? "请稍候…"
              : st?.hasCredentials
                ? "重新连接（使用已保存凭证）"
                : "保存并连接"}
          </button>
          {st?.hasCredentials && (
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                type="button"
                onClick={() => doDisconnect(false)}
                disabled={connectBusy}
                className="h-10 rounded-xl bg-panel border border-line text-ink-soft text-sm font-semibold disabled:opacity-60"
              >
                断开
              </button>
              <button
                type="button"
                onClick={() => doDisconnect(true)}
                disabled={connectBusy}
                className="h-10 rounded-xl bg-danger-soft text-danger text-sm font-semibold disabled:opacity-60"
              >
                断开并清除凭证
              </button>
            </div>
          )}
          <p className="text-xs text-ink-faint mt-3">
            凭证会加密保存到服务器，不会明文存储。连接成功后即使关闭网页，服务器也会常驻接收消息。
          </p>
        </div>

        {/* 常驻接收开关 */}
        <div className="bg-card rounded-2xl border border-line p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-ink">常驻接收</div>
              <div className="text-xs text-ink-soft mt-0.5">
                {st?.receive ? "开启中：服务器持续接收并入库消息" : "已关闭：停止接收新消息"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => doToggleReceive(!st?.receive)}
              className={`relative w-12 h-7 rounded-full transition ${
                st?.receive ? "bg-brand" : "bg-line"
              }`}
            >
              <span
                className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-all ${
                  st?.receive ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
          </div>
        </div>

        {/* 账号管理（仅 admin 可见） */}
        {username === "admin" && (
          <div className="bg-card rounded-2xl border border-line p-5 shadow-sm mt-3">
            <div className="text-sm font-semibold text-ink">账号管理</div>
            <div className="text-xs text-ink-soft mt-0.5 mb-3">
              注册新的控制台账号，对方就能用自己的账号登录手表（各自独立的消息与机器人配置）
            </div>
            <a
              href={linkOf("/adduser")}
              className="flex items-center justify-between w-full h-11 px-4 rounded-xl bg-panel border border-line text-ink text-sm font-semibold hover:border-brand-bright transition"
            >
              <span>注册新账号 / 管理用户</span>
              <span className="text-ink-faint">›</span>
            </a>
          </div>
        )}

        {/* 手表登录短码 */}
        <div className="bg-card rounded-2xl border border-line p-5 shadow-sm mt-3">
          <div className="text-sm font-semibold text-ink mb-1">手表登录短码</div>
          <div className="text-xs text-ink-soft mb-3">
            手表输入法不好打长网址。点下面生成短码，在手表「服务器地址」里输入这串字符即可自动对应本服务器。
          </div>

          <button
            type="button"
            onClick={doShareHost}
            disabled={shareBusy}
            className="w-full h-11 rounded-xl bg-brand text-white font-semibold disabled:opacity-60"
          >
            {shareBusy ? "生成中…" : "生成手表登录短码"}
          </button>

          {shareErr && <div className="text-sm text-danger mt-3">{shareErr}</div>}

          {shareCode && (
            <div className="mt-3">
              <div className="text-xs text-ink-soft mb-1">在手表「服务器地址」输入：</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 h-11 px-3 rounded-lg bg-panel border border-line text-ink text-center text-lg font-bold tracking-widest grid place-items-center break-all">
                  {shareCode}
                </code>
                <button
                  type="button"
                  onClick={doCopyShareCode}
                  className="h-11 px-3 rounded-lg bg-panel border border-line text-ink-soft text-sm font-semibold whitespace-nowrap"
                >
                  {shareCopied ? "已复制" : "复制"}
                </button>
              </div>
              {shareHost && (
                <div className="text-xs text-ink-faint mt-2 break-all">对应服务器：{shareHost}</div>
              )}
              <div className="text-xs text-ink-faint mt-1">
                短码 365 天有效；如更换域名，重新生成一次即可。
              </div>
            </div>
          )}
        </div>

        {msg && (
          <div className={`text-sm mt-3 ${msg.includes("成功") || msg.includes("已") ? "text-brand" : "text-danger"}`}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}
