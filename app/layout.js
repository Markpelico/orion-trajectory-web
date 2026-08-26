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
  title: "Orion Trajectory Display",
  description:
    "Interactive replay of an EFT-1-style Orion mission: launch, 5,800 km apogee, 8.9 km/s reentry. Web console for the NASA Trick desktop tool.",
  metadataBase: new URL("https://orion.markpelico.com"),
  openGraph: {
    title: "Orion Trajectory Display",
    description:
      "Launch to splashdown in your browser. Web console for a NASA Trick trajectory tool.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Orion Trajectory Display",
    description:
      "Launch to splashdown in your browser. Web console for a NASA Trick trajectory tool.",
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
