export const metadata = {
  title: "Options Cockpit",
  description: "Live quotes, chains, and defined-risk math.",
};
import "./globals.css";

// Fit the phone's width; the page itself handles narrow screens (globals.css).
export const viewport = { width: "device-width", initialScale: 1, themeColor: "#E8E5DD" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
