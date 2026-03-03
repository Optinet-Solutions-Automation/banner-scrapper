import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Allow images from the local backend server
  images: {
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost', port: '3001', pathname: '/banners/**' },
    ],
  },
};

export default nextConfig;
