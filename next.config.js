/** @type {import('next').NextConfig} */
// Phones on the home Wi-Fi or Tailscale load the dev server by another host name;
// Next.js blocks its client code for hosts not listed here, so the page renders
// but nothing can be clicked. The hosts live in .env.local (DEV_ORIGINS, comma-separated),
// not in git.
const allowedDevOrigins = (process.env.DEV_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
module.exports = { reactStrictMode: true, ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}) };
