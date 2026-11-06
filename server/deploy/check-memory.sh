#!/usr/bin/env bash
# QQRT 服务端内存实测脚本（Debian 12 / 2G 机器）
#
# 目的：把「服务端常驻内存 ≤250MB」从口头承诺变成可复现的实测数字。
# 用法（在服务器上，用部署用户或 root）：
#   bash deploy/check-memory.sh
#
# 退出码：0 = 达标（qqbot-web RSS ≤ 250MB）；1 = 超标。
set -uo pipefail

LIMIT_MB=250
APP_NAME="qqbot-web"

echo "=== 机器总内存 ==="
free -m | awk 'NR==1{print $0} /Mem:/{printf "Mem : total=%sMB used=%sMB free=%sMB avail=%sMB\n",$2,$3,$4,$7} /Swap:/{printf "Swap: total=%sMB used=%sMB\n",$2,$3}'

echo
echo "=== PM2 进程内存 ==="
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const list=JSON.parse(s);
    if(!list.length){console.log("(pm2 没有进程)");process.exit(0);}
    for(const p of list){
      const m=p.monit||{};
      const rss=Math.round((m.memory||0)/1048576);
      console.log(`${p.name}  pid=${p.pid}  status=${p.pm2_env&&p.pm2_env.status}  RSS=${rss}MB  restarts=${m.restart_time}`);
    }
  }catch(e){console.log("解析 pm2 jlist 失败：",e.message);}
});
' 2>/dev/null
else
  echo "(未安装 pm2，改用 ps)"
fi

echo
echo "=== 直接量 RSS（精确到 MB）==="
if command -v pm2 >/dev/null 2>&1; then
  PID="$(pm2 pid "$APP_NAME" 2>/dev/null | tr -d '[:space:]')"
else
  PID="$(pgrep -f 'next.*start' | head -1)"
fi

if [ -z "${PID:-}" ]; then
  echo "找不到 $APP_NAME 进程；请先 pm2 start ecosystem.config.cjs"
  exit 1
fi

RSS_KB="$(ps -o rss= -p "$PID" | tr -d '[:space:]')"
RSS_MB=$(( RSS_KB / 1024 ))
echo "$APP_NAME pid=$PID RSS=${RSS_MB}MB"

# 子进程（Next.js 可能 fork worker）也计入
CHILD_KB="$(ps --ppid "$PID" -o rss= 2>/dev/null | awk '{s+=$1} END{print s+0}')"
CHILD_MB=$(( CHILD_KB / 1024 ))
if [ "$CHILD_MB" -gt 0 ]; then
  echo "子进程合计 RSS=${CHILD_MB}MB"
fi
TOTAL_MB=$(( RSS_MB + CHILD_MB ))
echo "合计占用 = ${TOTAL_MB}MB（上限 ${LIMIT_MB}MB）"

echo
if [ "$TOTAL_MB" -le "$LIMIT_MB" ]; then
  echo "结果：达标 ✓（${TOTAL_MB}MB ≤ ${LIMIT_MB}MB）"
  exit 0
else
  echo "结果：超标 ✗（${TOTAL_MB}MB > ${LIMIT_MB}MB）"
  echo "建议：编辑 ecosystem.config.cjs 把 --max-old-space-size 从 192 下调到 160，然后 pm2 restart $APP_NAME"
  exit 1
fi
