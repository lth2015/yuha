import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Provisional; confirm ownership in Apple Developer before signing/release.
  appId: 'studio.yuha.app',
  appName: 'YUHA',
  webDir: 'dist-ios',
  backgroundColor: '#f6f5f0',
  server: { hostname: 'localhost', iosScheme: 'capacitor' },
  ios: { contentInset: 'never', preferredContentMode: 'mobile', backgroundColor: '#f6f5f0' },
  // Anonymous public GETs only (api.ts enforces the PR-A allowlist). Native
  // HTTP avoids widening production Web CORS. No cookies/auth flow is enabled.
  plugins: { CapacitorHttp: { enabled: true } },
};
export default config;
