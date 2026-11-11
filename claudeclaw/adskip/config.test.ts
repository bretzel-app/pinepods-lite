import { expect, it } from 'vitest';
import { readConfig } from './config';

const full = {
  PINEPODS_URL: 'http://pp:8040',
  PINEPODS_API_KEY: 'k',
  PINEPODS_USER_ID: '7',
  PINEPODS_DB_URL: 'postgres://u:p@db/pp',
  TELEGRAM_TOKEN: 't',
  ADSKIP_ALERT_CHAT_ID: '42',
};

it('names every missing variable', () => {
  expect(() => readConfig({})).toThrow(/PINEPODS_URL.*PINEPODS_API_KEY.*PINEPODS_USER_ID.*PINEPODS_DB_URL.*TELEGRAM_TOKEN.*ADSKIP_ALERT_CHAT_ID/s);
});
it('reads ADSKIP_NOTIFY_SUCCESS as a flag', () => {
  expect(readConfig({ ...full, ADSKIP_NOTIFY_SUCCESS: 'true' }).notifySuccess).toBe(true);
  expect(readConfig({ ...full, ADSKIP_NOTIFY_SUCCESS: undefined }).notifySuccess).toBe(false);
});
it('reads the values', () => {
  expect(readConfig(full)).toEqual({
    pinepodsUrl: 'http://pp:8040', apiKey: 'k', userId: 7, dbUrl: 'postgres://u:p@db/pp',
    telegramToken: 't', chatId: '42', notifySuccess: false,
  });
});
it('rejects a non-numeric user id', () => {
  expect(() => readConfig({ ...full, PINEPODS_USER_ID: 'abc' })).toThrow(/PINEPODS_USER_ID/);
});
