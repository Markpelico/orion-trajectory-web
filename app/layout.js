import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata = {
  title: "Orion Trajectory Display — Artemis II",
  description:
    "Replay the real Artemis II mission from the JPL Horizons ephemeris: launch, translunar injection, a 6,545 km lunar flyby, and an 11 km/s Pacific reentry.",
  metadataBase: new URL("https://orion.markpelico.com"),
  openGraph: {
    title: "Orion Trajectory Display — Artemis II",
    description:
      "Launch to lunar flyby to splashdown in your browser, from the real Artemis II ephemeris.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Orion Trajectory Display — Artemis II",
    description:
      "Launch to lunar flyby to splashdown in your browser, from the real Artemis II ephemeris.",
    images: ["/og.png"],
  },
};

export const viewport = {
  themeColor: "#040508",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>{children}</body>
    </html>
  );
}
