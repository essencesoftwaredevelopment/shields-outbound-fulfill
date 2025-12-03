import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // Proxy API calls to the Express server during dev
    const base = process.env.SERVER_URL && /^(http:\/\/|https:\/\/)/.test(process.env.SERVER_URL)
      ? process.env.SERVER_URL.replace(/\/$/, '')
      : 'http://localhost:4000';
    return [
      {
        source: '/api/:path*',
        destination: `${base}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
