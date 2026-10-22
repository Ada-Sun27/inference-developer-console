/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Keep native-ish server deps out of the bundler.
    serverComponentsExternalPackages: ["pg", "ioredis"],
  },
};

export default nextConfig;
