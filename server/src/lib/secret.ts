import crypto from "node:crypto";
import fs from "node:fs";
import { config, ensureDirs } from "./config";
import { log } from "./logger";

/**
 * AppSecret 静态加密：AES-256-GCM 存入数据库，密钥单独放在
 * data/secret.key（0600 权限）。数据库泄露不会直接暴露密钥。
 */

const ALGO = "aes-256-gcm";

let key: Buffer | null = null;

function getKey(): Buffer {
  if (key) return key;
  ensureDirs();
  try {
    const existing = fs.readFileSync(config.secretKeyPath);
    if (existing.length === 32) {
      key = existing;
      return key;
    }
    // 文件存在但长度异常：绝不能静默覆盖 —— 那会让数据库里所有已加密的
    // AppSecret 永久无法解密。先备份原文件再重新生成，保留恢复可能。
    log.warn("secret.key 长度异常，先备份再重新生成");
    const backup = `${config.secretKeyPath}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(config.secretKeyPath, backup);
    } catch {
      /* 备份失败不阻断生成 */
    }
  } catch {
    /* 首次运行 */
  }
  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(config.secretKeyPath, fresh, { mode: 0o600 });
  try {
    fs.chmodSync(config.secretKeyPath, 0o600);
  } catch {
    /* 非 POSIX 文件系统 */
  }
  key = fresh;
  return fresh;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  try {
    const [ver, ivB64, tagB64, dataB64] = payload.split(":");
    if (ver !== "v1") throw new Error("unsupported version");
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("无法解密已保存的 AppSecret（密钥文件缺失或损坏）");
  }
}

export function maskSecret(value: string, keep = 3): string {
  if (!value) return "";
  if (value.length <= keep * 2) return "••••";
  return value.slice(0, keep) + "••••" + value.slice(-keep);
}
