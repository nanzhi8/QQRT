/**
 * 服务器启动钩子：进程一起来就把所有开启了“常驻接收”的机器人重新连上，
 * 保证即使没人开着浏览器，消息也持续入库。
 *
 * 同时安排每天一次的历史消息清理（pruneOldMessages），防止消息表无限膨胀。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // 稍等片刻再启动，确保数据库连接池就绪。
  setTimeout(() => {
    import("@/server/botManager")
      .then((m) => m.bootAll())
      .catch(() => {});
  }, 1500);
  setTimeout(() => {
    import("@/server/botManager")
      .then((m) => m.bootAll())
      .catch(() => {});
  }, 15000);
  schedulePrune();
  scheduleWatchTextCleanup();
}

function scheduleWatchTextCleanup(): void {
  const run = () => {
    import("@/server/watchMedia")
      .then((m) => m.cleanupWatchTextTemp())
      .catch(() => {});
  };
  run();
  setInterval(run, 5 * 60 * 1000);
}

/** 每天凌晨 3:10 左右清理 60 天前的会话外消息（pruneOldMessages 兜底）。 */
function schedulePrune(): void {
  const DAY_MS = 24 * 3600 * 1000;
  const run = () => {
    import("@/server/repo")
      .then((m) => m.pruneAllUsersOldMessages?.())
      .catch(() => {});
  };
  // 先等数据库就绪再跑首次（延后 2 分钟）
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, DAY_MS);
}
