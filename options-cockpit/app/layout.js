export const metadata = {
  title: "Options Cockpit",
  description: "Live quotes, chains, and defined-risk math.",
};
import "./globals.css";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
