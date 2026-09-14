import fs from 'node:fs';
import { defineConfig } from 'vite';

/**
 * Local TLS, when the cert exists.
 *
 * getUserMedia only runs in a secure context, so the localization gate cannot
 * open the camera over plain http on a phone — http://<lan-ip> is not secure.
 * A self-signed cert makes the LAN address count as secure after the one-time
 * browser warning. Absent the cert the server still starts, just over http.
 */
function devHttps() {
  try {
    return {
      key: fs.readFileSync('.certs/dev-key.pem'),
      cert: fs.readFileSync('.certs/dev-cert.pem'),
    };
  } catch {
    return undefined;
  }
}

/**
 * Standalone wayfinding build: one entry, no dashboard sub-apps.
 * Port differs from the dashboard so both can run side by side.
 */
export default defineConfig({
  server: {
    // 3002 is taken by the dashboard-side preview; keep them separable.
    port: 3003,
    strictPort: true,
    // Listen on the LAN so a phone on the same Wi-Fi can reach it.
    host: true,
    https: devHttps(),
    // MultiSet blocks browser origins it does not know; proxying in dev keeps
    // localization testable without whitelisting localhost.
    proxy: {
      '/api/multiset': {
        target: 'https://api.multiset.ai',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/api\/multiset/, ''),
      },
    },
  },
  preview: { port: 4174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
