import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rolecraft — Your next chapter",
  description: "Your private Software Engineer and Applied AI Engineer career workspace.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
