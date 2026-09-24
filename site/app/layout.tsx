import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import "./editor.css";

export const metadata: Metadata = {
  title: "Subtitle Merger",
  description: "Inspect a local video, generate or add subtitle tracks, edit them, and export entirely in your browser.",
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
