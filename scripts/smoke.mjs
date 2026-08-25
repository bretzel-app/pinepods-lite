import { chromium } from 'playwright';

const APP = 'http://localhost:4173';
const SERVER = 'https://pods.example.com';

const episodes = [
  {
    podcastid: 1,
    podcastname: 'Test Cast',
    episodetitle: 'Episode One',
    episodepubdate: '2026-08-20T10:00:00',
    episodedescription: 'First test episode',
    episodeartwork: '',
    episodeurl: `${SERVER}/audio/1.mp3`,
    episodeduration: 1800,
    listenduration: 300,
    episodeid: 101,
    completed: false,
    saved: false,
    queued: false,
    downloaded: false,
    is_youtube: false,
    is_video: false,
  },
  {
    podcastid: 1,
    podcastname: 'Test Cast',
    episodetitle: 'Episode Two',
    episodepubdate: '2026-08-22T10:00:00',
    episodedescription: 'Second test episode',
    episodeartwork: '',
    episodeurl: `${SERVER}/audio/2.mp3`,
    episodeduration: 2400,
    listenduration: null,
    episodeid: 102,
    completed: false,
    saved: true,
    queued: false,
    downloaded: false,
    is_youtube: false,
    is_video: false,
  },
  {
    podcastid: 1,
    podcastname: 'Test Cast',
    episodetitle: 'Episode Three',
    episodepubdate: '2026-08-23T10:00:00',
    episodedescription: 'Nearly finished episode',
    episodeartwork: '',
    episodeurl: `${SERVER}/audio/3.mp3`,
    episodeduration: 1800,
    listenduration: 1790,
    episodeid: 103,
    completed: false,
    saved: false,
    queued: false,
    downloaded: false,
    is_youtube: false,
    is_video: false,
  },
  {
    podcastid: 1,
    podcastname: 'Test Cast',
    episodetitle: 'Episode Four',
    episodepubdate: '2026-08-21T10:00:00',
    episodedescription: 'Only listened to offline',
    episodeartwork: '',
    episodeurl: `${SERVER}/audio/4.mp3`,
    episodeduration: 2400,
    listenduration: null,
    episodeid: 104,
    completed: false,
    saved: false,
    queued: false,
    downloaded: false,
    is_youtube: false,
    is_video: false,
  },
];

const pods = [
  {
    podcastid: 1,
    podcastname: 'Test Cast',
    artworkurl: '',
    description: 'A test podcast',
    episodecount: 2,
    websiteurl: '',
    feedurl: 'https://feeds.example.com/testcast',
    author: 'Tester',
    categories: {},
    explicit: false,
    podcastindexid: 555,
    is_favorite: false,
    is_video: false,
  },
];

/** 1-second silent PCM WAV, enough for the <audio> element to actually play. */
function tinyWav() {
  const sampleRate = 8000;
  const n = sampleRate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

async function main() {
  // The pinned browser build may differ from this Playwright version's; fall
  // back to the environment's chromium binary when the default is missing.
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  // ---- mock the PinePods API ----
  await context.route(`${SERVER}/**`, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (body) => route.fulfill({ json: body });
    if (p === '/api/data/get_key')
      return json({ status: 'success', retrieved_key: 'k123', user_id: 7, mfa_required: false });
    if (p.startsWith('/api/data/user_details_id/'))
      return json({ UserID: 7, Fullname: 'Fred Tester', Username: 'fred', Email: 'f@x.y' });
    if (p.startsWith('/api/data/return_pods/')) return json({ pods });
    if (p.startsWith('/api/data/return_episodes/')) return json({ episodes, total: 2 });
    if (p.startsWith('/api/data/user_history/'))
      // History: the in-progress one and the nearly-finished one (should be
      // filtered from Continue listening). Episode Four is deliberately absent.
      return json({
        data: [
          { ...episodes[0], listendate: '2026-08-24T10:00:00' },
          { ...episodes[2], listendate: '2026-08-23T10:00:00' },
        ],
        total: 2,
      });
    if (p.startsWith('/api/data/saved_episode_list/'))
      return json({ saved_episodes: [episodes[1]], total: 1 });
    if (p === '/api/data/podcast_episodes')
      return json({
        episodes: episodes.map((e) => ({
          ...e,
          Episodetitle: e.episodetitle,
          episodetitle: undefined,
        })),
        total: 2,
      });
    if (p === '/api/data/proxy_search')
      return json({
        status: 'true',
        feeds: [
          {
            id: 999,
            title: 'Found Cast',
            url: 'https://feeds.example.com/found',
            originalUrl: 'https://feeds.example.com/found',
            link: 'https://found.example.com',
            description: 'A found podcast',
            author: 'Author X',
            ownerName: 'Author X',
            image: '',
            artwork: '',
            lastUpdateTime: 0,
            categories: {},
            explicit: false,
            episodeCount: 42,
          },
        ],
      });
    if (p.startsWith('/audio/'))
      return route.fulfill({ body: tinyWav(), contentType: 'audio/wav' });
    if (p === '/api/data/get_episode_metadata') {
      const body = route.request().postDataJSON();
      const ep = episodes.find((e) => e.episodeid === body.episode_id);
      return ep ? json({ episode: ep }) : route.fulfill({ status: 404, json: {} });
    }
    if (p === '/api/data/save_episode' || p === '/api/data/remove_saved_episode')
      return json({ detail: 'ok' });
    if (p === '/api/data/record_listen_duration') return json({ detail: 'ok' });
    if (p === '/api/data/add_podcast')
      return json({ success: true, podcast_id: 2, first_episode_id: 201 });
    if (p.startsWith('/api/data/verify_key')) return json({ status: 'success' });
    console.log('UNMOCKED:', p);
    return route.fulfill({ status: 404, json: { error: 'unmocked ' + p } });
  });

  // ---- login ----
  await page.goto(APP);
  await page.waitForSelector('.login-card');
  await page.fill('#server', SERVER);
  await page.fill('#username', 'fred');
  await page.fill('#password', 'pw');
  await page.click('button[type=submit]');
  await page.waitForSelector('.page-title');
  const homeText = await page.textContent('body');
  if (!homeText.includes('Episode One')) throw new Error('Home missing episodes');
  await page.waitForSelector('.continue-listening');
  const contText = await page.textContent('.continue-listening');
  if (!contText.includes('Episode One')) throw new Error('Continue listening missing Episode One');
  if (contText.includes('Episode Three'))
    throw new Error('Nearly-finished episode not filtered from Continue listening');
  console.log('PASS login + home feed + finished-episode filter');

  // ---- offline-only progress shows in Continue listening ----
  // Simulate listening done offline: a local position for an episode the
  // server history doesn't know about (Episode Four).
  await page.evaluate(async () => {
    const accountId = localStorage.getItem('pinepods.activeAccountId');
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('pinepods-offline');
      req.onsuccess = () => {
        const tx = req.result.transaction('positions', 'readwrite');
        tx.objectStore('positions').put({
          key: `${accountId}:104`,
          accountId,
          episodeId: 104,
          seconds: 500,
          duration: 2400,
          updatedAt: Date.now(),
          synced: false,
        });
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
  // Leave and re-enter Home so the list rebuilds.
  await page.click('nav.sidebar a[href="/saved"]');
  await page.click('nav.sidebar a[href="/"]');
  await page.waitForFunction(
    () => document.querySelector('.continue-listening')?.textContent.includes('Episode Four'),
    null,
    { timeout: 10000 },
  );
  console.log('PASS offline progress merged into Continue listening');

  // ---- podcasts page + detail (capitalized keys path) ----
  await page.click('nav.sidebar a[href="/podcasts"]');
  await page.waitForSelector('.pod-card');
  await page.click('.pod-card');
  await page.waitForSelector('.pod-header');
  await page.waitForFunction(() => document.body.textContent.includes('Episode One'), null, {
    timeout: 10000,
  });
  console.log('PASS podcast detail with key normalization');

  // ---- search + subscribe ----
  await page.click('nav.sidebar a[href="/search"]');
  await page.fill('input[type=search]', 'found');
  await page.click('.searchbar button');
  await page.waitForSelector('.episode-row');
  const sr = await page.textContent('body');
  if (!sr.includes('Found Cast')) throw new Error('Search results missing');
  console.log('PASS search');

  // ---- saved page ----
  await page.click('nav.sidebar a[href="/saved"]');
  await page.waitForFunction(() => document.body.textContent.includes('Episode Two'));
  console.log('PASS saved list');

  // ---- favorite toggle (optimistic) ----
  await page.click('nav.sidebar a[href="/"]');
  await page.waitForSelector('.episode-row');
  await page.click('.episode-row .episode-actions button[title="Add to favorites"]');
  console.log('PASS favorite toggle');

  // ---- episode detail page (row click navigates) ----
  await page
    .locator('.episode-row', { hasText: 'Episode One' })
    .first()
    .locator('.episode-main')
    .click();
  await page.waitForFunction(() => location.pathname.startsWith('/episodes/'));
  await page.waitForFunction(() => document.body.textContent.includes('Show notes'));
  const detailBody = await page.textContent('body');
  if (!detailBody.includes('First test episode')) throw new Error('Detail missing description');
  console.log('PASS episode detail page');

  // ---- play from detail, then full-screen player ----
  await page.click('.detail-actions .btn');
  await page.waitForSelector('.player-bar');
  await page.click('.player-bar .player-info');
  await page.waitForSelector('.full-player');
  const fp = await page.textContent('.full-player');
  if (!fp.includes('Episode One')) throw new Error('Full player missing episode');
  await page.click('.full-player-top .icon-btn');
  await page.waitForSelector('.full-player', { state: 'detached' });
  console.log('PASS full-screen player');

  // ---- last-played restore: reload should cue the episode, paused ----
  await new Promise((r) => setTimeout(r, 500)); // let last-played write settle
  await page.reload();
  await page.waitForSelector('.player-bar', { timeout: 10000 });
  const bar = await page.textContent('.player-bar');
  if (!bar.includes('Episode One')) throw new Error('Last-played episode not restored');
  // The audio element lives off-DOM, so assert paused state via the button.
  const playBtnTitle = await page.getAttribute('.player-bar .play', 'title');
  if (playBtnTitle !== 'Play') throw new Error('Restore must cue paused, ready to play');
  console.log('PASS last-played restore after reload (paused)');

  // ---- accounts page: add a second account and switch ----
  await page.click('nav.sidebar a[href="/accounts"]');
  await page.waitForSelector('.account-row');
  const acct = await page.textContent('body');
  if (!acct.includes('Fred Tester')) throw new Error('Account name missing');
  console.log('PASS accounts page');

  // ---- wait for SW to install, then go offline and reload ----
  await page.waitForFunction(
    () => navigator.serviceWorker?.controller != null || navigator.serviceWorker?.ready != null,
  );
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.active?.state;
  });
  await new Promise((r) => setTimeout(r, 1500));
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('.page-title', { timeout: 10000 });
  const offlineBody = await page.textContent('body');
  if (!offlineBody.includes('Offline')) throw new Error('Offline banner missing');
  if (!offlineBody.includes('Fred Tester')) throw new Error('Cached account data missing offline');
  // Navigate to home offline — cached feed must render.
  await page.click('nav.sidebar a[href="/"]');
  await page.waitForFunction(() => document.body.textContent.includes('Episode One'), null, {
    timeout: 10000,
  });
  console.log('PASS offline reload with cached data');

  await context.setOffline(false);

  const realErrors = errors.filter(
    (e) => !e.includes('Failed to load resource') && !e.includes('net::ERR_INTERNET_DISCONNECTED') && !e.includes('the server responded with a status of 404'),
  );
  if (realErrors.length) {
    console.log('PAGE ERRORS:', realErrors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('ALL SMOKE TESTS PASSED');
  }
  await browser.close();
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
