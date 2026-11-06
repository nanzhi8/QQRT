"use client";

import { useCallback, useEffect, useState } from "react";
import { getAuthToken, linkOf, pathOf } from "@/lib/api";

/**
 * 安全读取响应体：服务端返回非 JSON（HTML 错误页 / 网关 5xx / 空体）时不抛异常，
 * 而是返回一个带 error.message 的对象，避免真实错误被笼统的「网络错误」掩盖。
 */
async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) {
    return { success: false, error: { message: `服务端无响应内容（HTTP ${res.status}）` } };
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      success: false,
      error: { message: `服务端返回异常（HTTP ${res.status}）` },
    };
  }
}

/**
 * 管理接口地址：token 用查询参数 ?t= 传（托管反代会剥掉 Authorization 头），
 * 分享链接的 sharecode 也要带上，否则请求会被拦成「链接不完整」。
 */
function adminUrl(path: string): string {
  const url = pathOf(path);
  const params = new URLSearchParams();
  if (typeof window !== "undefined") {
    const sharecode = new URLSearchParams(window.location.search).get("sharecode");
    if (sharecode) params.set("sharecode", sharecode);
  }
  const token = getAuthToken();
  if (token) params.set("t", token);
  const qs = params.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

/** 从响应体里取错误文案。 */
function errMsg(body: Record<string, unknown>, fallback: string): string {
  const e = body.error as { message?: string } | undefined;
  return (e && e.message) || fallback;
}

export default function AddUser() {
  const [ready, setReady] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const [setupPass, setSetupPass] = useState("");
  const [setupPass2, setSetupPass2] = useState("");
  const [loginUser, setLoginUser] = useState("admin");
  const [loginPass, setLoginPass] = useState("");
  const [newUser, setNewUser] = useState("");
  const [newPass, setNewPass] = useState("");
  const [users, setUsers] = useState<Array<{ id: string; username: string; createdAt: number }>>([]);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(adminUrl("/api/admin/status"), { cache: "no-store" });
      const body = await readBody(res);
      setInitialized(!!body.initialized);
    } catch {
      setInitialized(false);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadStatus();
    });
  }, [loadStatus]);

  // 已经用管理员登录过主控制台：直接进入管理界面
  useEffect(() => {
    if (!ready || !initialized || adminAuthed) return;
    if (!getAuthToken()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(adminUrl("/api/admin/users"), { cache: "no-store" });
        const body = await readBody(res);
        if (!cancelled && res.ok && body.success !== false) setAdminAuthed(true);
      } catch {
        /* 保持登录表单 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, initialized, adminAuthed]);

  useEffect(() => {
    if (!adminAuthed) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(adminUrl("/api/admin/users"), { cache: "no-store" });
        const body = await readBody(res);
        if (!cancelled) setUsers(Array.isArray(body.users) ? (body.users as never[]) : []);
      } catch {
        if (!cancelled) setUsers([]);
      }
    };
    queueMicrotask(() => {
      void load();
    });
    return () => {
      cancelled = true;
    };
  }, [adminAuthed]);

  const doSetup = async () => {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      if (!setupPass || setupPass.length < 6) {
        setError("管理员密码至少 6 位");
        return;
      }
      if (setupPass !== setupPass2) {
        setError("两次输入的密码不一致");
        return;
      }
      const res = await fetch(adminUrl("/api/admin/setup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: setupPass }),
      });
      const body = await readBody(res);
      if (!res.ok || body.success === false) {
        setError(errMsg(body, "初始化失败"));
        return;
      }
      setInitialized(true);
      setAdminAuthed(true);
      setInfo("管理员密码已设置，已自动登录");
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  const doLogin = async () => {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch(adminUrl("/api/admin/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginUser, password: loginPass }),
      });
      const body = await readBody(res);
      if (!res.ok || body.success === false) {
        setError(errMsg(body, "管理员登录失败"));
        return;
      }
      setAdminAuthed(true);
      setInfo("管理员登录成功");
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  const doAddUser = async () => {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      if (!newUser || !newPass) {
        setError("请填写新用户账号和密码");
        return;
      }
      const res = await fetch(adminUrl("/api/admin/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUser, password: newPass }),
      });
      const body = await readBody(res);
      if (!res.ok || body.success === false) {
        setError(errMsg(body, "添加用户失败"));
        return;
      }
      setInfo(`已添加用户：${(body.user as { username?: string } | undefined)?.username ?? ""}`);
      setNewUser("");
      setNewPass("");
      const listRes = await fetch(adminUrl("/api/admin/users"), { cache: "no-store" });
      const listBody = await readBody(listRes);
      setUsers(Array.isArray(listBody.users) ? (listBody.users as never[]) : []);
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  const doDeleteUser = async (id: string) => {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch(adminUrl("/api/admin/users/delete"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = await readBody(res);
      if (!res.ok || body.success === false) {
        setError(errMsg(body, "删除失败"));
        return;
      }
      setInfo("用户已删除");
      const listRes = await fetch(adminUrl("/api/admin/users"), { cache: "no-store" });
      const listBody = await readBody(listRes);
      setUsers(Array.isArray(listBody.users) ? (listBody.users as never[]) : []);
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return <div className="min-h-screen grid place-items-center"><div className="text-sm text-ink-soft">加载中…</div></div>;
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="font-display text-xl font-bold text-ink">账号管理</h1>
          <p className="text-sm text-ink-soft mt-1">管理员注册新的控制台账号，供他人登录手表使用</p>
          <a href={linkOf("/")} className="inline-block text-xs text-ink-soft hover:text-brand mt-2">
            ← 返回控制台
          </a>
        </div>

        <div className="bg-card rounded-2xl border border-line p-5 shadow-sm">
          {!initialized ? (
            <>
              <label className="block text-xs text-ink-soft mb-1">设置管理员密码</label>
              <input
                type="password"
                value={setupPass}
                onChange={(e) => setSetupPass(e.target.value)}
                placeholder="至少 6 位"
                className="w-full h-10 px-3 rounded-lg bg-panel border border-line text-ink text-sm mb-3"
              />
              <label className="block text-xs text-ink-soft mb-1">确认管理员密码</label>
              <input
                type="password"
                value={setupPass2}
                onChange={(e) => setSetupPass2(e.target.value)}
                placeholder="再次输入"
                className="w-full h-10 px-3 rounded-lg bg-panel border border-line text-ink text-sm mb-4"
              />
              <button onClick={doSetup} disabled={busy} className="w-full h-11 rounded-xl bg-brand text-white font-semibold disabled:opacity-60">
                {busy ? "请稍候…" : "初始化管理员"}
              </button>
            </>
          ) : !adminAuthed ? (
            <>
              <label className="block text-xs text-ink-soft mb-1">管理员账号</label>
              <input
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
                className="w-full h-10 px-3 rounded-lg bg-panel border border-line text-ink text-sm mb-3"
              />
              <label className="block text-xs text-ink-soft mb-1">管理员密码</label>
              <input
                type="password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                className="w-full h-10 px-3 rounded-lg bg-panel border border-line text-ink text-sm mb-4"
              />
              <button onClick={doLogin} disabled={busy} className="w-full h-11 rounded-xl bg-brand text-white font-semibold disabled:opacity-60">
                {busy ? "请稍候…" : "管理员登录"}
              </button>
            </>
          ) : (
            <>
              <label className="block text-xs text-ink-soft mb-1">新用户账号</label>
              <input
                value={newUser}
                onChange={(e) => setNewUser(e.target.value)}
                placeholder="2-20 位中文、字母、数字或下划线"
                className="w-full h-10 px-3 rounded-lg bg-panel border border-line text-ink text-sm mb-3"
              />
              <label className="block text-xs text-ink-soft mb-1">新用户密码</label>
              <input
                type="password"
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
                placeholder="6-64 位"
                className="w-full h-10 px-3 rounded-lg bg-panel border border-line text-ink text-sm mb-4"
              />
              <button onClick={doAddUser} disabled={busy} className="w-full h-11 rounded-xl bg-brand text-white font-semibold disabled:opacity-60">
                {busy ? "请稍候…" : "添加用户"}
              </button>

              <div className="mt-5">
                <div className="text-sm font-semibold text-ink mb-2">用户列表</div>
                {users.length === 0 ? (
                  <div className="text-sm text-ink-soft">暂无内部用户</div>
                ) : (
                  <div className="space-y-2">
                    {users.map((u) => (
                      <div key={u.id} className="flex items-center justify-between gap-3 rounded-lg bg-panel border border-line px-3 py-2">
                        <div className="min-w-0">
                          <div className="text-sm text-ink truncate">{u.username}</div>
                          <div className="text-xs text-ink-soft">{new Date(u.createdAt).toLocaleString()}</div>
                        </div>
                        <button
                          onClick={() => doDeleteUser(u.id)}
                          disabled={busy}
                          className="shrink-0 rounded-lg bg-danger-soft text-danger px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {error && <div className="text-sm text-danger mt-3">{error}</div>}
          {info && <div className="text-sm text-brand mt-3">{info}</div>}
        </div>
      </div>
    </div>
  );
}
