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
  let completedCalls = 0;
  let uncompletedCalls = 0;
  let sweepCompleted103 = false;
  const kidPods = [];
  const kidPositions = [];
  const kidSaves = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  // ---- mock the PinePods API ----
  await context.route(`${SERVER}/**`, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (body) => route.fulfill({ json: body });
    if (p === '/api/data/get_key') {
      const auth = route.request().headers()['authorization'] ?? '';
      const user = Buffer.from(auth.replace('Basic ', ''), 'base64').toString().split(':')[0];
      const userId = user === 'kid' ? 8 : 7;
      return json({
        status: 'success',
        retrieved_key: `k${userId}`,
        user_id: userId,
        mfa_required: false,
      });
    }
    if (p.startsWith('/api/data/user_details_id/'))
      return p.endsWith('/8')
        ? json({ UserID: 8, Fullname: 'Kid Tester', Username: 'kid', Email: 'k@x.y' })
        : json({ UserID: 7, Fullname: 'Fred Tester', Username: 'fred', Email: 'f@x.y' });
    if (p.startsWith('/api/data/return_pods/'))
      return json({ pods: p.endsWith('/8') ? kidPods : pods });
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
    if (p === '/api/data/podcast_episodes') {
      // The kid's copy of the feed: same episodes, different ids, no history.
      if (url.searchParams.get('user_id') === '8')
        return json({
          episodes: episodes.map((e) => ({
            ...e,
            episodeid: e.episodeid + 1000,
            listenduration: null,
            completed: false,
            saved: false,
          })),
          total: episodes.length,
        });
      return json({
        episodes: episodes.map((e) => ({
          ...e,
          Episodetitle: e.episodetitle,
          episodetitle: undefined,
        })),
        total: episodes.length,
      });
    }
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
    if (p === '/api/data/fetch_podcast_feed')
      return json({
        episodes: [
          {
            title: 'Found Ep',
            description: 'A found episode',
            pub_date: '2026-08-01T00:00:00Z',
            enclosure_url: `${SERVER}/audio/found.mp3`,
            enclosure_length: '123',
            artwork: '',
            content: null,
            duration: 600,
            guid: 'found-guid-1',
            is_video: false,
          },
        ],
      });
    if (p === '/api/data/get_episode_metadata') {
      const body = route.request().postDataJSON();
      const ep = episodes.find((e) => e.episodeid === body.episode_id);
      if (!ep) return route.fulfill({ status: 404, json: {} });
      // Simulates "finished on another device" for the sweep test.
      const completed = ep.episodeid === 103 && sweepCompleted103 ? true : ep.completed;
      return json({ episode: { ...ep, completed } });
    }
    if (p === '/api/data/save_episode' || p === '/api/data/remove_saved_episode') {
      const body = route.request().postDataJSON();
      if (p === '/api/data/save_episode' && body.user_id === 8) kidSaves.push(body.episode_id);
      return json({ detail: 'ok' });
    }
    if (p === '/api/data/mark_episode_completed') {
      completedCalls++;
      return json({ detail: 'ok' });
    }
    if (p === '/api/data/mark_episode_uncompleted') {
      uncompletedCalls++;
      return json({ detail: 'ok' });
    }
    if (p === '/api/data/record_listen_duration') {
      const body = route.request().postDataJSON();
      if (body.user_id === 8) kidPositions.push([body.episode_id, body.listen_duration]);
      return json({ detail: 'ok' });
    }
    if (p === '/api/data/add_podcast') {
      const body = route.request().postDataJSON();
      if (body.podcast_values.user_id === 8)
        kidPods.push({ ...pods[0], podcastid: 2, feedurl: body.podcast_values.pod_feed_url });
      return json({ success: true, podcast_id: 2, first_episode_id: 1101 });
    }
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
  // Fresh profile: no cache yet, so wait for the first feed fetch to render.
  await page.waitForFunction(() => document.body.textContent.includes('Episode One'));
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

  // ---- feed preview: open a search result, see and play its episodes ----
  await page
    .locator('.episode-row', { hasText: 'Found Cast' })
    .locator('.episode-main')
    .click();
  await page.waitForFunction(() => location.pathname === '/preview');
  await page.waitForFunction(() => document.body.textContent.includes('Found Ep'));
  await page
    .locator('.episode-row', { hasText: 'Found Ep' })
    .locator('button[title="Play"]')
    .click();
  await page.waitForSelector('.player-bar');
  const previewBar = await page.textContent('.player-bar');
  if (!previewBar.includes('Found Ep')) throw new Error('Preview episode not playing');
  console.log('PASS podcast preview with playable episodes');

  // ---- subscribe from the preview lands on the real podcast page ----
  await page.click('.pod-header .btn');
  await page.waitForFunction(() => location.pathname === '/podcasts/2', null, { timeout: 15000 });
  await page.waitForFunction(() => document.body.textContent.includes('Episode One'));
  console.log('PASS subscribe from preview');

  // ---- search state survives navigating away and back ----
  await page.click('nav.sidebar a[href="/search"]');
  // Wait on the input itself — 'Found Cast' also shows in the player bar,
  // which would match before the async state restore completes.
  await page.waitForFunction(
    () => document.querySelector('input[type=search]')?.value === 'found',
    null,
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () => document.querySelector('.content')?.textContent.includes('Found Cast'),
    null,
    { timeout: 10000 },
  );
  const btnText = await page.textContent('.searchbar button');
  if (!btnText.includes('Search')) throw new Error('Search button has no label');
  console.log('PASS search state restored after navigation');

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
  await page.waitForFunction(() => document.body.textContent.includes('Description'));
  const detailBody = await page.textContent('body');
  if (!detailBody.includes('First test episode')) throw new Error('Detail missing description');
  console.log('PASS episode detail page');

  // ---- finish flow: download, play to the end (mock audio is 1s) ----
  // Expect: server told it's completed, local offline copy auto-removed,
  // Mark played button flips to Mark unplayed.
  await page.locator('.detail-actions button', { hasText: 'Download' }).click();
  await page.waitForSelector('.detail-actions button:has-text("Remove download")');
  await page.click('.detail-actions .btn'); // Play/Resume
  await page.waitForSelector('.detail-actions button:has-text("Mark unplayed")', {
    timeout: 15000,
  });
  await page.waitForSelector('.detail-actions button:has-text("Remove download")', {
    state: 'detached',
  });
  if (completedCalls < 1) throw new Error('mark_episode_completed was not called on finish');
  console.log('PASS auto-complete + auto-remove download on finish');

  // ---- manual mark unplayed / played toggle ----
  await page.locator('.detail-actions button', { hasText: 'Mark unplayed' }).click();
  await page.waitForSelector('.detail-actions button:has-text("Mark played")');
  if (uncompletedCalls < 1) throw new Error('mark_episode_uncompleted was not called');
  console.log('PASS mark played/unplayed toggle');

  // ---- play from detail, then full-screen player ----
  await page.click('.detail-actions .btn');
  await page.waitForSelector('.player-bar');
  await page.click('.player-bar .player-info');
  await page.waitForSelector('.full-player');
  const fp = await page.textContent('.full-player');
  if (!fp.includes('Episode One')) throw new Error('Full player missing episode');
  // Sleep timer: set 30m, button shows countdown, then cancel.
  await page.click('.full-player button[title="Sleep timer"]');
  await page.click('.sleep-options button:has-text("30m")');
  await page.waitForFunction(() => {
    const b = document.querySelector('.full-player button[title="Sleep timer"]');
    return b && /\d+m/.test(b.textContent);
  });
  await page.click('.full-player button[title="Sleep timer"]');
  await page.click('.sleep-options button:has-text("Off")');
  await page.waitForFunction(() => {
    const b = document.querySelector('.full-player button[title="Sleep timer"]');
    return b && !/\d+m/.test(b.textContent);
  });
  console.log('PASS sleep timer set and cancel');
  await page.click('.full-player-top .icon-btn');
  await page.waitForSelector('.full-player', { state: 'detached' });
  console.log('PASS full-screen player');

  // ---- Show details from the full player navigates to episode detail ----
  await page.click('.player-bar .player-info');
  await page.waitForSelector('.full-player');
  await page.click('.fp-notes');
  await page.waitForSelector('.full-player', { state: 'detached' });
  await page.waitForFunction(() => location.pathname === '/episodes/101');
  await page.waitForFunction(() => document.body.textContent.includes('Description'));
  console.log('PASS show notes from full player');

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

  // ---- startup sweep removes downloads completed on another device ----
  // Inject a local download for Episode Three, verify it lists, then flip
  // its server-side completed flag and reload: the sweep must delete it.
  await page.evaluate(async (ep) => {
    const accountId = localStorage.getItem('pinepods.activeAccountId');
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('pinepods-offline');
      req.onsuccess = () => {
        const tx = req.result.transaction(['downloads', 'downloadBlobs'], 'readwrite');
        const key = `${accountId}:${ep.episodeid}`;
        tx.objectStore('downloads').put({
          key,
          accountId,
          episode: ep,
          mimeType: 'audio/wav',
          size: 3,
          downloadedAt: Date.now(),
        });
        tx.objectStore('downloadBlobs').put({ key, blob: new Blob([new Uint8Array(3)]) });
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, episodes[2]);
  await page.click('nav.sidebar a[href="/downloads"]');
  await page.waitForFunction(() => document.body.textContent.includes('Episode Three'));
  sweepCompleted103 = true;
  await page.reload();
  await page.waitForSelector('.page-title');
  await page.waitForFunction(() => !document.body.textContent.includes('Episode Three'), null, {
    timeout: 15000,
  });
  console.log('PASS startup sweep of completed downloads');

  // ---- accounts page: add a second account and switch ----
  await page.click('nav.sidebar a[href="/accounts"]');
  await page.waitForSelector('.account-row');
  const acct = await page.textContent('body');
  if (!acct.includes('Fred Tester')) throw new Error('Account name missing');
  console.log('PASS accounts page');

  // ---- transfer podcasts to a second account ----
  await page.click('.btn:has-text("Add account")');
  await page.waitForSelector('.login-card');
  await page.fill('#server', SERVER);
  await page.fill('#username', 'kid');
  await page.fill('#password', 'pw');
  await page.click('button[type=submit]');
  await page.waitForSelector('.page-title');
  // Switch back to the source account.
  await page.click('nav.sidebar a[href="/accounts"]');
  await page
    .locator('.account-row', { hasText: 'Fred Tester' })
    .locator('button:has-text("Switch")')
    .click();
  await page.waitForSelector('.account-row:has-text("Fred Tester") .pill:has-text("active")');
  await page.click('button:has-text("Transfer podcasts")');
  await page
    .locator('.account-row', { hasText: 'Test Cast' })
    .locator('input[type=checkbox]')
    .check();
  await page.click('.btn:has-text("Transfer 1 podcast")');
  await page.waitForFunction(() => document.body.textContent.includes('Transfer complete'), null, {
    timeout: 30000,
  });
  const summary = await page.textContent('body');
  if (!summary.includes('2 positions')) throw new Error(`Expected 2 positions copied: ${summary}`);
  if (!kidPositions.some(([id, s]) => id === 1101 && s === 300))
    throw new Error(`Episode One position not copied: ${JSON.stringify(kidPositions)}`);
  if (!kidPositions.some(([id, s]) => id === 1103 && s === 1790))
    throw new Error(`Episode Three position not copied: ${JSON.stringify(kidPositions)}`);
  if (!kidSaves.includes(1102))
    throw new Error(`Saved flag not copied: ${JSON.stringify(kidSaves)}`);
  console.log('PASS transfer subscription + history to second account');
  await page.click('.btn:has-text("Done")');
  await page.waitForSelector('.account-row');

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
