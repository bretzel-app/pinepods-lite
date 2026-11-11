export interface Config {
  pinepodsUrl: string;
  apiKey: string;
  userId: number;
  dbUrl: string;
  telegramToken: string;
  chatId: string;
  notifySuccess: boolean;
}

const REQUIRED = [
  'PINEPODS_URL', 'PINEPODS_API_KEY', 'PINEPODS_USER_ID', 'PINEPODS_DB_URL', 'TELEGRAM_TOKEN', 'ADSKIP_ALERT_CHAT_ID',
] as const;

export function readConfig(env: Record<string, string | undefined>): Config {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  const userId = Number(env.PINEPODS_USER_ID);
  if (!Number.isInteger(userId)) throw new Error('PINEPODS_USER_ID must be an integer');
  return {
    pinepodsUrl: env.PINEPODS_URL!,
    apiKey: env.PINEPODS_API_KEY!,
    userId,
    dbUrl: env.PINEPODS_DB_URL!,
    telegramToken: env.TELEGRAM_TOKEN!,
    chatId: env.ADSKIP_ALERT_CHAT_ID!,
    notifySuccess: env.ADSKIP_NOTIFY_SUCCESS === 'true',
  };
}
