import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.bretzel.pinepodslite',
  appName: 'PinePods Lite',
  webDir: 'dist',
  android: { allowMixedContent: true },
};

export default config;
