import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "QQ 机器人控制台",
  description: "登录账号、绑定 QQ 机器人，为手表提供收发消息服务。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0e7566",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}
