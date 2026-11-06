import { EventEmitter } from "node:events";

/**
 * 进程内事件总线：QQ 网关推送的消息事件经这里分发给各浏览器（SSE）。
 * 每条事件都带 userId，SSE 端点按用户过滤，保证多账号互不干扰。
 */

export interface BusEvent {
  type: string;
  userId: string;
  data: unknown;
}

type Listener = (event: BusEvent) => void;

const globalForBus = globalThis as unknown as { __qqBusEmitter?: EventEmitter };

function getEmitter(): EventEmitter {
  if (!globalForBus.__qqBusEmitter) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    globalForBus.__qqBusEmitter = emitter;
  }
  return globalForBus.__qqBusEmitter;
}

export const bus = {
  emit(userId: string, type: string, data: unknown): void {
    getEmitter().emit("event", { type, userId, data } satisfies BusEvent);
  },
  subscribe(listener: Listener): () => void {
    const emitter = getEmitter();
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  },
};

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}
