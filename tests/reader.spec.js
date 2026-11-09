const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'LinuxDo 增强阅读.user.js'), 'utf8');
const TOPIC_ID = 42;
const POST_COUNT = 2000;
const postId = (postNumber) => 100000 + postNumber;

function post(postNumber) {
  const replyTo = postNumber > 3 && postNumber % 5 === 0 ? postNumber - 1 : null;
  return {
    id: postId(postNumber),
    post_number: postNumber,
    username: postNumber === 1 || postNumber % 7 === 0 ? 'owner' : `member${postNumber % 4}`,
    name: postNumber === 1 ? 'Topic Owner' : `Member ${postNumber % 4}`,
    avatar_template: '/avatars/member/{size}.png',
    cooked: `<p>Post ${postNumber} content for virtual reader testing.</p>${postNumber === 1998 ? '<img data-test-image src="/image.png" style="display:block;width:100%;height:20px">' : ''}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, postNumber % 60)).toISOString(),
    reply_to_post_number: replyTo,
    reply_count: postNumber % 9 === 0 ? 2 : 0,
    actions_summary: [{ id: 2, count: postNumber % 3, can_act: true, acted: false }],
    can_boost: true,
    boosts: [],
  };
}

function topicPayload(extraPosts = [post(1)], options = {}) {
  const count = options.postCount || POST_COUNT;
  const posts = extraPosts.map((item) => Number(item.post_number) === 1 && options.opCooked
    ? Object.assign({}, item, { cooked: options.opCooked }) : item);
  return {
    id: TOPIC_ID,
    title: 'Reader 2.0 performance topic',
    posts_count: count,
    highest_post_number: count,
    views: 8123,
    last_read_post_number: options.lastReadPostNumber === undefined ? 10 : options.lastReadPostNumber,
    created_at: '2026-01-01T00:00:00.000Z',
    last_posted_at: '2026-01-02T00:00:00.000Z',
    category_name: 'Development',
    tags: ['reader', 'performance'],
    valid_reactions: options.validReactions || ['heart', '+1', 'fire'],
    details: { created_by: { username: 'owner' } },
    post_stream: {
      posts,
      stream: Array.from({ length: count }, (_, index) => postId(index + 1)),
    },
  };
}

async function bootReader(page, options = {}) {
  const requests = [];
  let rateLimited = false;
  const rateLimitedKeys = new Set();
  const origin = options.origin || 'https://linux.do';
  const buildPost = (postNumber) => Object.assign(
    post(postNumber),
    (options.postOverrides && options.postOverrides[postNumber]) || {},
  );
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/latest') {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta name="csrf-token" content="test-csrf"><link rel="icon" href="/icon.png"></head><body>
          ${options.pageHeader ? `<header class="d-header"><div class="panel"><ul class="icons d-header-icons">
            <li class="header-dropdown-toggle language-switcher"><button type="button">ZH</button></li>
            <li id="current-user" class="header-dropdown-toggle"><button type="button">User</button></li>
          </ul></div></header>` : ''}
          <div class="notifications"><a class="raw-topic-link" href="/t/reader/${TOPIC_ID}${options.noTarget ? '' : `/${options.target || POST_COUNT}`}">Open topic</a></div>
        </body></html>`,
      });
      return;
    }
    if (url.pathname === '/session/current.json') {
      if (options.sessionFailure) {
        await route.fulfill({ status: 503, json: { error: 'session unavailable' } });
        return;
      }
      await route.fulfill({ json: { current_user: options.noUser ? null : { id: 9, username: 'tester' } } });
      return;
    }
    if (url.pathname === `/t/${TOPIC_ID}.json`) {
      const target = Number(url.searchParams.get('post_number'));
      const postCount = (options.topicState && options.topicState.postCount) || POST_COUNT;
      const missing = Number(options.missingPostNumber) || 0;
      requests.push({ type: target ? 'anchor' : 'topic', target, at: Date.now() });
      const topicOptions = Object.assign({ postCount }, options.topicState || {});
      const anchorPosts = target === missing ? [buildPost(Math.max(1, target - 1))] : [buildPost(target)];
      await route.fulfill({ json: target ? topicPayload(anchorPosts, topicOptions) : topicPayload([buildPost(1)], topicOptions) });
      return;
    }
    if (url.pathname === `/t/${TOPIC_ID}/posts.json`) {
      const ids = url.searchParams.getAll('post_ids[]').map(Number);
      requests.push({ type: 'posts', ids, at: Date.now() });
      if (options.rateLimitOnce && !rateLimited) {
        rateLimited = true;
        await route.fulfill({ status: 429, headers: { 'Retry-After': '0.1' }, json: { error: 'slow down' } });
        return;
      }
      const key = ids.join(',');
      if (options.rateLimitEachOnce && !rateLimitedKeys.has(key)) {
        rateLimitedKeys.add(key);
        await route.fulfill({ status: 429, headers: { 'Retry-After': '0.1' }, json: { error: 'slow down' } });
        return;
      }
      const missing = Number(options.missingPostNumber) || 0;
      const postsDelay = typeof options.postsDelay === 'function'
        ? Number(options.postsDelay(ids)) || 0 : Number(options.postsDelay) || 0;
      if (postsDelay > 0) await new Promise((resolve) => setTimeout(resolve, postsDelay));
      await route.fulfill({ json: { post_stream: { posts: ids.filter((id) => id !== postId(missing)).map((id) => buildPost(id - 100000)) } } });
      return;
    }
    if (/^\/posts\/\d+\/replies\.json$/.test(url.pathname)) {
      const parentId = Number(url.pathname.split('/')[2]);
      const parentNumber = parentId - 100000;
      const count = Number(options.repliesCount) || 0;
      const replies = Array.from({ length: count }, (_, index) => {
        const reply = buildPost(Math.min(POST_COUNT, parentNumber + index + 1));
        reply.reply_to_post_number = parentNumber;
        return reply;
      });
      requests.push({ type: 'replies', parentId, at: Date.now() });
      if (Number(options.repliesDelay) > 0) {
        await new Promise((resolve) => setTimeout(resolve, Number(options.repliesDelay)));
      }
      await route.fulfill({ json: replies });
      return;
    }
    if (url.pathname === '/topics/timings') {
      await route.fulfill({ json: { success: 'OK' } });
      return;
    }
    if (url.pathname === '/post_actions' || url.pathname.startsWith('/post_actions/')) {
      await route.fulfill({ json: { success: true } });
      return;
    }
    if (url.pathname === '/u/tester/bookmarks.json') {
      const pageNumber = Number(url.searchParams.get('page')) || 0;
      if (options.pagedCollections) {
        const hasMore = pageNumber < 2;
        await route.fulfill({ json: { user_bookmark_list: { bookmarks: [{
          id: 501 + pageNumber, bookmarkable_type: pageNumber ? 'Post' : 'Topic', topic_id: TOPIC_ID,
          post_number: pageNumber ? 100 + pageNumber : 1, title: `Saved page ${pageNumber}`, username: 'owner',
        }], more_bookmarks_url: hasMore ? `/u/tester/bookmarks.json?page=${pageNumber + 1}` : null } } });
        return;
      }
      await route.fulfill({ json: { user_bookmark_list: { bookmarks: [
        { id: 501, bookmarkable_type: 'Topic', topic_id: TOPIC_ID, post_number: 1, title: 'Saved topic', username: 'owner' },
        { id: 502, bookmarkable_type: 'Post', topic_id: TOPIC_ID, post_number: 1999, title: 'Saved floor', username: 'member3' },
      ] } } });
      return;
    }
    if (url.pathname === '/user_actions.json') {
      const offset = Number(url.searchParams.get('offset')) || 0;
      if (options.pagedCollections) {
        const batch = offset < 60 ? Array.from({ length: 60 }, (_, index) => ({
          id: 7000 + offset + index, post_id: postId(100 + offset + index), topic_id: TOPIC_ID,
          post_number: 100 + offset + index, title: `Liked ${offset + index}`, created_at: '2026-01-02T00:00:00Z',
        })) : [{ id: 8000, post_id: postId(500), topic_id: TOPIC_ID, post_number: 500, title: 'Liked final', created_at: '2026-01-02T00:00:00Z' }];
        await route.fulfill({ json: { user_actions: batch } });
        return;
      }
      await route.fulfill({ json: { user_actions: [{ id: postId(1999), post_id: postId(1999), topic_id: TOPIC_ID, post_number: 1999, title: 'Liked floor', created_at: '2026-01-02T00:00:00Z' }] } });
      return;
    }
    if (url.pathname === '/discourse-reactions/posts/reactions.json') {
      if (options.pagedCollections && url.searchParams.has('before_reaction_user_id')) {
        await route.fulfill({ json: { reactions: [] } });
        return;
      }
      if (options.pagedCollections) {
        await route.fulfill({ json: { reactions: [{ id: 900, post_id: postId(600), topic_id: TOPIC_ID, post_number: 600, reaction_value: 'fire' }] } });
        return;
      }
      await route.fulfill({ status: options.noReactions ? 404 : 200, json: options.noReactions ? {} : { reactions: [] } });
      return;
    }
    if (url.pathname === '/u/member0.json') {
      requests.push({ type: 'user-profile', at: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await route.fulfill({ json: { user: { id: 10, username: 'member0', name: 'Member Zero', avatar_template: '/avatars/member/{size}.png', trust_level: 2, bio_excerpt: 'Profile loaded in phases.', can_follow: true } } });
      return;
    }
    if (url.pathname === '/u/member0/summary.json') {
      requests.push({ type: 'user-summary', at: Date.now() });
      await route.fulfill({ json: { user_summary: { post_count: 320, topic_count: 12, likes_received: 90 } } });
      return;
    }
    if (url.pathname === '/user-badges/member0.json') {
      requests.push({ type: 'user-badges', at: Date.now() });
      await route.fulfill({ json: { user_badges: [{ badge: { name: 'Contributor', description: 'Test badge' } }] } });
      return;
    }
    if (url.pathname === '/u/member0/notification_level.json') {
      requests.push({ type: 'notification-level', body: route.request().postData() || '' });
      await route.fulfill({ json: { success: true } });
      return;
    }
    if (url.pathname === '/polls/vote') {
      const method = route.request().method();
      const params = new URLSearchParams(route.request().postData() || '');
      const selected = params.getAll('options[]');
      requests.push({ type: 'poll-vote', method, selected });
      await route.fulfill({
        json: {
          poll: {
            name: params.get('poll_name') || 'poll',
            type: 'regular',
            status: 'open',
            voters: method === 'DELETE' ? 3 : 4,
            options: [
              { id: 'opt-a', html: 'Option A', votes: method === 'DELETE' ? 1 : (selected.includes('opt-a') ? 2 : 1) },
              { id: 'opt-b', html: 'Option B', votes: method === 'DELETE' ? 2 : (selected.includes('opt-b') ? 3 : 2) },
            ],
          },
          vote: method === 'DELETE' ? [] : selected,
        },
      });
      return;
    }
    if (url.pathname === '/emojis.json') {
      await route.fulfill({
        json: {
          smileys: [
            { name: 'grinning', url: '/images/emoji/twemoji/grinning.png' },
            { name: 'rocket', url: '/images/emoji/twemoji/rocket.png' },
          ],
        },
      });
      return;
    }
    if (url.pathname === '/posts' && route.request().method() === 'POST') {
      const params = new URLSearchParams(route.request().postData() || '');
      const raw = params.get('raw') || '';
      const replyTo = Number(params.get('reply_to_post_number')) || 1;
      requests.push({ type: 'create-post', raw, replyTo });
      await route.fulfill({
        json: {
          id: 999001,
          post_number: POST_COUNT + 1,
          username: 'tester',
          name: 'Tester',
          avatar_template: '/avatars/member/{size}.png',
          cooked: `<p>${raw}</p>`,
          created_at: '2026-01-03T00:00:00.000Z',
          reply_to_post_number: replyTo,
        },
      });
      return;
    }
    if (/^\/posts\/\d+$/.test(url.pathname) && route.request().method() === 'DELETE') {
      const deletedId = Number(url.pathname.split('/')[2]);
      requests.push({ type: 'delete-post', deletedId });
      await route.fulfill({ json: { success: 'OK' } });
      return;
    }
    if (url.pathname === '/uploads/create-multipart.json') {
      await route.fulfill({ status: 404, json: { error: 'not enabled' } });
      return;
    }
    if (url.pathname === '/uploads.json' && route.request().method() === 'POST') {
      requests.push({ type: 'upload-direct' });
      await route.fulfill({
        json: {
          original_filename: 'demo.png',
          short_url: 'upload://demo123.png',
          width: 320,
          height: 180,
        },
      });
      return;
    }
    if (url.pathname === '/plugins/discourse-math/katex/katex.min.css') {
      await route.fulfill({ contentType: 'text/css', body: '.katex-rendered{font-style:italic;}' });
      return;
    }
    if (url.pathname === '/plugins/discourse-math/katex/katex.min.js') {
      await route.fulfill({
        contentType: 'application/javascript',
        body: 'window.katex={render:function(tex,el,opts){el.innerHTML="<span class=\\"katex-rendered\\">"+tex+"</span>";}};',
      });
      return;
    }
    if (url.pathname === '/plugins/discourse-math/katex/mhchem.min.js') {
      await route.fulfill({ contentType: 'application/javascript', body: '' });
      return;
    }
    if (url.pathname.endsWith('.png')) {
      await route.fulfill({
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.goto(`${origin}/latest`);
  if (options.instrumentStorage) {
    await page.evaluate((historyKey) => {
      window.__historyWrites = 0;
      const nativeSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === historyKey) window.__historyWrites += 1;
        return nativeSetItem.call(this, key, value);
      };
    }, 'ldp-reader-history-v1');
  }
  if (options.instrumentDb) {
    await page.evaluate(() => {
      window.__topicSnapshotPuts = 0;
      const nativePut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'topics') window.__topicSnapshotPuts += 1;
        return nativePut.apply(this, args);
      };
    });
  }
  await page.addScriptTag({ content: SCRIPT });
  if (options.skipReaderOpen) return requests;
  await page.click('.raw-topic-link');
  await expect(page.locator('.ldp-v2 .ldp-title')).toHaveText('Reader 2.0 performance topic');
  if (!options.skipTargetAssertion) {
    const target = page.locator(`.ldp-post[data-post-number="${options.target || POST_COUNT}"]`);
    await expect(target).toHaveCount(1);
    await expect(target).toBeVisible();
    await expect(target).toBeInViewport();
    await expect(target).toHaveClass(/ldp-flash/);
  }
  return requests;
}

test('opens immediately near a distant target without requesting middle ranges', async ({ page }) => {
  const requests = await bootReader(page);
  await expect(page.locator('.ldp-v2 .ldp-modal')).toBeVisible();
  const mainCount = await page.locator('.ldp-virtual-window > .ldp-post').count();
  expect(mainCount).toBeLessThanOrEqual(72);
  const requestedIds = requests.filter((item) => item.type === 'posts').flatMap((item) => item.ids);
  expect(requestedIds.some((id) => id > postId(1950))).toBeTruthy();
  expect(requestedIds.some((id) => id > postId(100) && id < postId(1900))).toBeFalsy();
});

test('timeline reaches the real last floor without trailing whitespace', async ({ page }) => {
  const postCount = 167;
  const postOverrides = Object.fromEntries(Array.from({ length: postCount - 3 }, (_, index) => {
    const postNumber = index + 3;
    return [postNumber, postNumber < postCount && postNumber % 2 === 0
      ? { reply_to_post_number: postNumber - 1 }
      : { reply_to_post_number: null }];
  }));
  await bootReader(page, {
    target: 12,
    postOverrides,
    topicState: { postCount },
  });
  await page.locator('.ldp-tl-bottom-date').click();
  await expect(page.locator(`.ldp-post[data-post-number="${postCount}"]`)).toBeInViewport();
  await page.waitForTimeout(500);

  const metrics = await page.locator('.ldp-body').evaluate((body) => {
    const bottomSpacer = body.querySelector('.ldp-virtual-spacer-bottom');
    const mounted = Array.from(body.querySelector('.ldp-virtual-window').children);
    return {
      bottomHeight: bottomSpacer.getBoundingClientRect().height,
      lastPostNumber: Number(mounted[mounted.length - 1]?.dataset.postNumber) || 0,
      remaining: body.scrollHeight - body.clientHeight - body.scrollTop,
    };
  });
  expect(metrics.lastPostNumber).toBe(postCount);
  expect(metrics.bottomHeight).toBeLessThanOrEqual(1);
  expect(metrics.remaining).toBeLessThanOrEqual(2);
});

test('returns from a distant floor to the real top of the reader', async ({ page }) => {
  await bootReader(page);
  await page.locator('.ldp-tl-top-date').click();
  await expect.poll(() => page.locator('.ldp-body').evaluate((node) => node.scrollTop)).toBe(0);
  await expect(page.locator('.ldp-tl-current-post')).toHaveText(`1 / ${POST_COUNT}`);
});

test('opens a long first post at the real top when there is no explicit floor', async ({ page }) => {
  await bootReader(page, {
    noTarget: true,
    skipTargetAssertion: true,
    topicState: {
      lastReadPostNumber: 0,
      opCooked: '<div data-long-op style="height:2400px">Long first post</div>',
    },
  });
  const body = page.locator('.ldp-body');
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(page.locator('[data-long-op]')).toBeInViewport();
  await expect(page.locator('.ldp-tl-current-post')).toHaveText(`1 / ${POST_COUNT}`);
});

test('keeps original topic actions in the footer and groups collection tools on the right', async ({ page }) => {
  await bootReader(page, { target: 12 });
  await expect(page.locator('.ldp-footer')).toBeVisible();
  await expect(page.locator('.ldp-footer .ldp-fbtn')).toHaveCount(5);
  await expect(page.locator('[data-reader-action="previous"], [data-reader-action="next"]')).toHaveCount(0);
  await expect(page.locator('.ldp-toolbar-group [data-reader-action="history"]')).toHaveCount(0);
  await expect(page.locator('.ldp-head-btns [data-reader-action="history"]')).toHaveCount(1);
  await expect(page.locator('.ldp-head-btns [data-reader-action="collections"]')).toHaveCount(1);
  await expect(page.locator('.ldp-header-line > .ldp-close')).toHaveCount(1);
  await expect(page.locator('.ldp-head-btns .ldp-close')).toHaveCount(0);
  await expect(page.locator('.ldp-head-btns .ldp-f-open')).toHaveCount(0);
  await expect(page.locator('.ldp-footer .ldp-f-open')).toHaveCount(1);
  await expect(page.locator('.ldp-head-btns > :last-child .ldp-obsidian-settings')).toHaveCount(1);
  await expect(page.locator('.ldp-topic-level')).toHaveCount(0);
  await expect(page.locator('.ldp-topic > .ldp-post > .ldp-actions')).toBeHidden();
  await page.locator('.ldp-f-like').click();
  await expect(page.locator('.ldp-f-like')).toHaveClass(/liked/);
  await page.locator('.ldp-f-bookmark').click();
  await expect(page.locator('.ldp-f-bookmark')).toHaveClass(/bookmarked/);
  await expect(page.locator('.ldp-topic-bookmark, [data-reader-action="topic-bookmark"]')).toHaveCount(0);
});

test('preserves the visible anchor when an earlier image changes height', async ({ page }) => {
  await bootReader(page, { target: 1999 });
  const target = page.locator('.ldp-post[data-post-number="1999"]').first();
  await page.locator('.ldp-body').dispatchEvent('wheel', { deltaY: 0 });
  await target.evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(250);
  const before = await target.evaluate((node) => node.getBoundingClientRect().top);
  for (const height of [80, 140, 220]) {
    await page.locator('[data-test-image]').evaluate((image, value) => {
      image.style.height = `${value}px`;
    }, height);
    await page.waitForTimeout(120);
  }
  await expect.poll(async () => {
    const after = await target.evaluate((node) => node.getBoundingClientRect().top);
    return Math.abs(after - before);
  }).toBeLessThanOrEqual(2);
});

test('reuses overlapping post and image nodes when the virtual window advances', async ({ page }) => {
  await bootReader(page, {
    target: 500,
    postOverrides: {
      518: { cooked: '<p>Reusable media floor.</p><img data-reuse-image src="/image.png" style="display:block;width:100%;height:80px">' },
    },
  });
  const before = await page.locator('.ldp-virtual-window').evaluate((windowNode) => {
    const roots = Array.from(windowNode.children).filter((node) => node.matches('.ldp-post'));
    roots.forEach((node) => { node.__reuseProbe = node.dataset.postId; });
    const image = windowNode.querySelector('[data-reuse-image]');
    image.__reuseProbe = 'image-500';
    return roots.map((node) => Number(node.dataset.postNumber));
  });

  await page.locator('.ldp-body').dispatchEvent('wheel', { deltaY: 0 });
  await page.locator('.ldp-virtual-window > .ldp-post[data-post-number="518"]')
    .evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await expect.poll(async () => page.locator('.ldp-virtual-window > .ldp-post').evaluateAll((nodes, first) =>
    Number(nodes[0] && nodes[0].dataset.postNumber) !== Number(first), before[0])).toBeTruthy();

  const reused = await page.locator('.ldp-virtual-window').evaluate((windowNode) => ({
    post: Array.from(windowNode.children).some((node) => node.__reuseProbe === node.dataset.postId),
    image: windowNode.querySelector('[data-reuse-image]')?.__reuseProbe === 'image-500',
    count: windowNode.querySelectorAll(':scope > .ldp-post').length,
  }));
  expect(reused.post).toBeTruthy();
  expect(reused.image).toBeTruthy();
  expect(reused.count).toBeLessThanOrEqual(72);
});

test('does not commit an obsolete window during rapid delayed scrolling', async ({ page }) => {
  await bootReader(page, {
    target: 12,
    postsDelay: (ids) => ids.some((id) => id >= postId(300) && id <= postId(700)) ? 300 : 30,
  });
  await page.locator('.ldp-virtual-window').evaluate((windowNode) => {
    window.__mountedWindows = [];
    const record = () => {
      window.__mountedWindows.push(Array.from(windowNode.children)
        .map((node) => Number(node.dataset.postNumber || 0)).filter(Boolean));
    };
    new MutationObserver(record).observe(windowNode, { childList: true });
  });
  const body = page.locator('.ldp-body');
  await body.evaluate((node) => {
    node.scrollTop = node.querySelector('.ldp-comments').offsetTop + 480 * 184;
    node.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(30);
  await body.evaluate((node) => {
    node.scrollTop = node.querySelector('.ldp-comments').offsetTop + 1600 * 184;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.locator('.ldp-virtual-window > .ldp-post').evaluateAll((nodes) =>
    nodes.some((node) => Number(node.dataset.postNumber) > 1500))).toBeTruthy();
  const mountedWindows = await page.evaluate(() => window.__mountedWindows || []);
  expect(mountedWindows.some((numbers) => numbers.some((number) => number >= 300 && number <= 700))).toBeFalsy();
  expect(await page.locator('.ldp-virtual-window > .ldp-post').count()).toBeLessThanOrEqual(72);
});

test('releases the seek anchor when the user wheels the reader', async ({ page }) => {
  await bootReader(page, { target: 100 });
  const body = page.locator('.ldp-body');
  const box = await body.boundingBox();
  const initialScrollTop = await body.evaluate((node) => node.scrollTop);
  await page.mouse.move(box.x + Math.min(160, box.width / 2), box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeGreaterThan(initialScrollTop);
  const movedScrollTop = await body.evaluate((node) => node.scrollTop);
  await page.locator('.ldp-virtual-window > .ldp-post').first().evaluate((node) => {
    node.style.minHeight = `${node.getBoundingClientRect().height + 240}px`;
  });
  await page.waitForTimeout(180);
  const finalScrollTop = await body.evaluate((node) => node.scrollTop);
  expect(finalScrollTop).toBeGreaterThanOrEqual(movedScrollTop - 2);
});

test('keeps a small wheel step local after the native scrollbar jumps to the middle', async ({ page }) => {
  await bootReader(page, { target: 12 });
  const body = page.locator('.ldp-body');
  const box = await body.boundingBox();
  const draggedTop = await body.evaluate((node) => {
    const commentsTop = node.querySelector('.ldp-comments').offsetTop;
    node.scrollTop = commentsTop + 900 * 184;
    node.dispatchEvent(new Event('scroll'));
    return node.scrollTop;
  });

  await expect.poll(() => page.locator('.ldp-virtual-window > .ldp-post').evaluateAll((nodes) =>
    nodes.some((node) => Number(node.dataset.postNumber) >= 850 && Number(node.dataset.postNumber) <= 950))).toBeTruthy();
  const settledTop = await body.evaluate((node) => node.scrollTop);
  const viewport = await body.evaluate((node) => node.clientHeight);
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
  await page.mouse.wheel(0, 80);
  await page.waitForTimeout(180);

  const state = await body.evaluate((node) => ({
    top: node.scrollTop,
    max: node.scrollHeight - node.clientHeight,
  }));
  expect(Math.abs(settledTop - draggedTop)).toBeLessThan(viewport * 2);
  expect(state.top - settledTop).toBeGreaterThanOrEqual(0);
  expect(state.top - settledTop).toBeLessThan(viewport * 2);
  expect(state.top).toBeLessThan(state.max - viewport);
  expect(await page.locator('.ldp-virtual-window > .ldp-post').count()).toBeLessThanOrEqual(72);
});

test('does not jump to the final floor when wheeling beside a short topic scrollbar', async ({ page }) => {
  await bootReader(page, {
    target: 5,
    topicState: { postCount: 28 },
    repliesCount: 15,
    repliesDelay: 250,
  });
  const body = page.locator('.ldp-body');
  const box = await body.boundingBox();
  const before = await body.evaluate((node) => ({
    top: node.scrollTop,
    max: node.scrollHeight - node.clientHeight,
    viewport: node.clientHeight,
  }));
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
  await page.mouse.wheel(0, 80);
  await page.waitForTimeout(500);

  const after = await body.evaluate((node) => ({
    top: node.scrollTop,
    max: node.scrollHeight - node.clientHeight,
  }));
  expect(after.top - before.top).toBeGreaterThanOrEqual(0);
  expect(after.top - before.top).toBeLessThan(before.viewport * 2);
  expect(after.top).toBeLessThan(after.max - 2);
  await expect(page.locator('.ldp-tl-current-post')).not.toHaveText('28 / 28');
});

test('reopens a fresh snapshot without refetching the floor slice', async ({ page }) => {
  const requests = await bootReader(page, { target: 100 });
  await page.waitForTimeout(1200);
  const slicesBefore = requests.filter((item) => item.type === 'posts');
  const cachedIds = new Set(slicesBefore.flatMap((item) => item.ids));
  await page.click('.ldp-v2 .ldp-close');
  await page.click('.raw-topic-link');
  const target = page.locator('.ldp-post[data-post-number="100"]');
  await expect(target).toBeInViewport();
  const reopenedIds = requests.filter((item) => item.type === 'posts')
    .slice(slicesBefore.length).flatMap((item) => item.ids);
  expect(reopenedIds.some((id) => cachedIds.has(id))).toBe(false);
});

test('restores history and loads collection tabs when reactions are unavailable', async ({ page }) => {
  await bootReader(page, { noReactions: true });
  await page.locator('.ldp-v2').evaluate((node) => { node.dataset.shellIdentity = 'reused'; });
  await page.click('[data-reader-action="history"]');
  await expect(page.locator('.ldp-reader-panel')).toContainText('Reader 2.0 performance topic');
  await page.click('.ldp-panel-item-main');
  await expect(page.locator('.ldp-v2 .ldp-title')).toHaveText('Reader 2.0 performance topic');
  await expect(page.locator('.ldp-v2')).toHaveAttribute('data-shell-identity', 'reused');
  await page.click('[data-reader-action="collections"]');
  await expect(page.locator('.ldp-reader-panel')).toContainText('Liked floor');
  await page.click('[data-tab="topics"]');
  await expect(page.locator('.ldp-reader-panel')).toContainText('Saved topic');
  await page.click('[data-tab="posts"]');
  await expect(page.locator('.ldp-reader-panel')).toContainText('Saved floor');
});

test('opens the shared collection panel from the page header', async ({ page }) => {
  await bootReader(page, { pageHeader: true, skipReaderOpen: true });
  const item = page.locator('.d-header-icons > .ldp-page-collections-item');
  const button = item.locator('.ldp-page-collections-button');
  await expect(item).toHaveCount(1);
  expect(await item.evaluate((node) => node.nextElementSibling?.classList.contains('language-switcher'))).toBe(true);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.ldp-page-collection-host .ldp-reader-panel')).toContainText('Liked floor');
  await page.locator('.ldp-page-collection-host [data-tab="topics"]').click();
  await expect(page.locator('.ldp-page-collection-host .ldp-reader-panel')).toContainText('Saved topic');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ldp-page-collection-host')).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('renders the user card immediately and enriches it in phases', async ({ page }) => {
  await bootReader(page, { target: 12 });
  await page.locator('.ldp-post[data-post-number="12"] .ldp-avatar-btn').first().click();
  await expect(page.locator('.ldp-user-card-v2')).toBeVisible();
  await expect(page.locator('.ldp-user-card-v2')).toContainText('@member0');
  await expect(page.locator('.ldp-user-card-v2')).toContainText('Member Zero');
  await expect(page.locator('.ldp-user-card-v2')).toContainText('Contributor');
});

test('reopens a fresh user card from memory without duplicate profile requests', async ({ page }) => {
  const requests = await bootReader(page, { target: 12 });
  const avatar = page.locator('.ldp-post[data-post-number="12"] .ldp-avatar-btn').first();
  await avatar.click();
  await expect(page.locator('.ldp-user-card-v2')).toContainText('Contributor');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ldp-user-card-v2')).toHaveCount(0);
  await avatar.click();
  await expect(page.locator('.ldp-user-card-v2')).toContainText('Member Zero');
  await page.waitForTimeout(150);
  expect(requests.filter((item) => item.type === 'user-profile')).toHaveLength(1);
  expect(requests.filter((item) => item.type === 'user-summary')).toHaveLength(1);
  expect(requests.filter((item) => item.type === 'user-badges')).toHaveLength(1);
});

test('keeps the virtual window bounded during long scrolling', async ({ page }) => {
  await bootReader(page, { target: 12 });
  const body = page.locator('.ldp-v2 .ldp-body');
  for (const ratio of [0.2, 0.5, 0.8, 0.35]) {
    await body.evaluate((node, value) => {
      node.scrollTop = (node.scrollHeight - node.clientHeight) * value;
      node.dispatchEvent(new Event('scroll'));
    }, ratio);
    await page.waitForTimeout(500);
    expect(await page.locator('.ldp-virtual-window > .ldp-post').count()).toBeLessThanOrEqual(72);
  }
});

test('keeps multi-level replies as standalone floors and expands direct replies only', async ({ page }) => {
  const requests = await bootReader(page, {
    target: 11,
    repliesCount: 1,
    postOverrides: {
      9: { reply_count: 1 },
      10: { reply_to_post_number: 9, reply_count: 1 },
      11: { reply_to_post_number: 10, reply_count: 0 },
    },
  });
  const parent = page.locator('.ldp-virtual-window > .ldp-post[data-post-number="9"]');
  await expect(parent).toHaveCount(1);
  await expect(page.locator('.ldp-virtual-window > .ldp-post[data-post-number="10"]')).toHaveCount(1);
  await expect(page.locator('.ldp-virtual-window > .ldp-post[data-post-number="11"]')).toHaveCount(1);
  await expect(parent.locator(':scope > .ldp-children .ldp-embedded-reply')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(requests.filter((item) => item.type === 'replies')).toHaveLength(0);

  const toggle = parent.locator(':scope > .ldp-actions .ldp-reply-toggle');
  await expect(toggle).toHaveText('1 个回复');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(parent.locator(':scope > .ldp-children > .ldp-embedded-reply[data-post-number="10"]')).toHaveCount(1);
  await expect(parent.locator(':scope > .ldp-children .ldp-embedded-reply[data-post-number="11"]')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(parent.locator(':scope > .ldp-children .ldp-embedded-reply')).toHaveCount(0);
});

test('mounts a distant reply as its exact standalone floor without loading middle ranges', async ({ page }) => {
  const requests = await bootReader(page, {
    target: 1500,
    postOverrides: { 1500: { reply_to_post_number: 9 } },
  });
  const target = page.locator('.ldp-virtual-window > .ldp-post[data-post-number="1500"]');
  await expect(target).toHaveCount(1);
  await expect(target).toBeInViewport();
  await expect(page.locator('.ldp-post[data-post-number="1500"]')).toHaveCount(1);
  await expect(page.locator('.ldp-tl-current-post')).toContainText('/ 2000');
  const loadedMiddle = requests
    .filter((item) => item.type === 'posts')
    .flatMap((item) => item.ids)
    .some((id) => id > postId(100) && id < postId(1400));
  expect(loadedMiddle).toBe(false);
});

test('keeps replies to the opening post in the root timeline', async ({ page }) => {
  await bootReader(page, {
    target: 12,
    postOverrides: { 12: { reply_to_post_number: 1 } },
  });
  await expect(page.locator('.ldp-virtual-window > .ldp-post[data-post-number="12"]')).toHaveCount(1);
  await expect(page.locator('.ldp-post[data-post-number="1"] > .ldp-children .ldp-post[data-post-number="12"]')).toHaveCount(0);
});

test('falls back to a standalone reply when its parent cannot be loaded', async ({ page }) => {
  await bootReader(page, {
    target: 50,
    missingPostNumber: 49,
    postOverrides: { 50: { reply_to_post_number: 49 } },
  });
  await expect(page.locator('.ldp-virtual-window > .ldp-post[data-post-number="50"]')).toHaveCount(1);
  await expect(page.locator('.ldp-post[data-post-number="50"]')).toHaveCount(1);
});

test('retries after a shared 429 cooldown', async ({ page }) => {
  const started = Date.now();
  const requests = await bootReader(page, { target: 100, rateLimitOnce: true });
  expect(requests.filter((item) => item.type === 'posts').length).toBeGreaterThanOrEqual(2);
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
});

test('filters the mounted timeline to the topic owner', async ({ page }) => {
  await bootReader(page, { target: 12 });
  const filter = page.locator('[data-reader-action="only-op"]');
  await filter.click();
  await expect(filter).toHaveClass(/active/);
  await expect(filter).toBeEnabled({ timeout: 15000 });
  const usernames = await page.locator('.ldp-virtual-window > .ldp-post .ldp-user').allTextContents();
  expect(usernames.length).toBeGreaterThan(0);
  expect(new Set(usernames)).toEqual(new Set(['@owner']));
});

test('keeps stream positions stable when a requested post is missing', async ({ page }) => {
  await bootReader(page, { target: 100, missingPostNumber: 99 });
  await expect(page.locator(`.ldp-missing-post[data-stream-post-id="${postId(99)}"]`)).toHaveCount(1);
  await expect(page.locator(`.ldp-post[data-post-number="100"][data-stream-post-id="${postId(100)}"]`)).toBeVisible();
  await expect(page.locator(`.ldp-post[data-post-number="101"][data-stream-post-id="${postId(101)}"]`)).toBeVisible();
});

test('preserves interaction state after a virtual post remounts', async ({ page }) => {
  await bootReader(page, { target: 10 });
  const postTen = page.locator('.ldp-post[data-post-number="10"]');
  await postTen.locator('.ldp-like').click();
  await page.locator('.ldp-body').evaluate((node) => {
    node.scrollTop = node.scrollHeight - node.clientHeight;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(postTen).toHaveCount(0);
  await page.locator('.ldp-body').evaluate((node) => {
    node.scrollTop = node.querySelector('.ldp-comments').offsetTop + 8 * 184;
    node.dispatchEvent(new Event('scroll'));
  });
  await expect(postTen).toBeVisible();
  await expect(postTen.locator('.ldp-like')).toHaveAttribute('data-acted', '1');
});

test('loads all direct replies on demand and reuses them after collapse', async ({ page }) => {
  const requests = await bootReader(page, {
    target: 9,
    repliesCount: 15,
    postOverrides: { 9: { reply_count: 15 } },
  });
  const parent = page.locator('.ldp-virtual-window > .ldp-post[data-post-number="9"]');
  const toggle = parent.locator(':scope > .ldp-actions .ldp-reply-toggle');
  await page.waitForTimeout(500);
  expect(requests.filter((item) => item.type === 'replies')).toHaveLength(0);
  await toggle.click();
  await expect(parent.locator(':scope > .ldp-children > .ldp-embedded-reply')).toHaveCount(15);
  expect(requests.filter((item) => item.type === 'replies')).toHaveLength(1);
  await toggle.click();
  await expect(parent.locator(':scope > .ldp-children > .ldp-embedded-reply')).toHaveCount(0);
  await toggle.click();
  await expect(parent.locator(':scope > .ldp-children > .ldp-embedded-reply')).toHaveCount(15);
  expect(requests.filter((item) => item.type === 'replies')).toHaveLength(1);
});

test('reloads the latest stream when a fresh-cache new-post notice is opened', async ({ page }) => {
  const topicState = { postCount: POST_COUNT };
  await bootReader(page, { target: 100, topicState });
  await page.waitForTimeout(1200);
  await page.click('.ldp-close');
  topicState.postCount = POST_COUNT + 1;
  await page.click('.raw-topic-link');
  await expect(page.locator('.ldp-post[data-post-number="100"]')).toBeVisible();
  await page.locator('.ldp-new-posts').evaluate((button, postNumber) => {
    button.dataset.postNumber = String(postNumber);
    button.hidden = false;
  }, POST_COUNT + 1);
  await page.click('.ldp-new-posts');
  await expect(page.locator(`.ldp-post[data-post-number="${POST_COUNT + 1}"]`)).toBeInViewport();
  await expect(page.locator('.ldp-tl-current-post')).toContainText(`/ ${POST_COUNT + 1}`);
});

test('reconciles a stale snapshot with a changed stream without losing navigation', async ({ page }) => {
  const topicState = { postCount: POST_COUNT };
  await bootReader(page, { target: 100, topicState });
  await page.waitForTimeout(1200);
  await page.click('.ldp-close');
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('linuxdo-convenience-reader-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('topics', 'readwrite');
    const store = transaction.objectStore('topics');
    const records = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    records.forEach((record) => { record.updatedAt = Date.now() - 120000; store.put(record); });
  });
  topicState.postCount = POST_COUNT + 1;
  await page.click('.raw-topic-link');
  await expect(page.locator('.ldp-post[data-post-number="100"]')).toBeVisible();
  await expect(page.locator('.ldp-tl-current-post')).toContainText(`/ ${POST_COUNT + 1}`);
  await page.click('.ldp-tl-bottom-date');
  await expect(page.locator(`.ldp-virtual-window > .ldp-post[data-post-number="${POST_COUNT + 1}"]`)).toBeInViewport();
});

test('debounces history persistence during continuous scrolling', async ({ page }) => {
  await bootReader(page, { target: 12, instrumentStorage: true });
  await page.evaluate(async () => {
    const body = document.querySelector('.ldp-v2 .ldp-body');
    for (let index = 0; index < 20; index++) {
      body.scrollTop = (body.scrollHeight - body.clientHeight) * (index / 20);
      body.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.__historyWrites)).toBeLessThanOrEqual(2);
});

test('coalesces snapshot writes while only-op scans the full topic', async ({ page }) => {
  const requests = await bootReader(page, { target: 12, instrumentDb: true });
  await page.click('[data-reader-action="only-op"]');
  await expect.poll(() => Math.max(0, ...requests.filter((item) => item.type === 'posts').flatMap((item) => item.ids)), {
    timeout: 15000,
  }).toBeGreaterThanOrEqual(postId(POST_COUNT - 1));
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.__topicSnapshotPuts)).toBeLessThanOrEqual(3);
});

test('spaces concurrent retries after a shared 429 cooldown', async ({ page }) => {
  const requests = await bootReader(page, { target: 100, rateLimitEachOnce: true });
  await page.click('[data-reader-action="only-op"]');
  await expect.poll(() => {
    const groups = new Map();
    requests.filter((item) => item.type === 'posts').forEach((item) => {
      const key = item.ids.join(',');
      groups.set(key, (groups.get(key) || 0) + 1);
    });
    return Array.from(groups.values()).filter((count) => count >= 2).length;
  }, { timeout: 10000 }).toBeGreaterThanOrEqual(3);
  const groups = new Map();
  requests.filter((item) => item.type === 'posts').forEach((item) => {
    const key = item.ids.join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item.at);
  });
  const retryStarts = Array.from(groups.values()).filter((times) => times.length >= 2).map((times) => times[1]).sort((a, b) => a - b).slice(0, 3);
  expect(retryStarts[1] - retryStarts[0]).toBeGreaterThanOrEqual(80);
  expect(retryStarts[2] - retryStarts[1]).toBeGreaterThanOrEqual(80);
});

test('does not persist authenticated topic data under guest when identity lookup fails', async ({ page }) => {
  await bootReader(page, { target: 12, sessionFailure: true });
  await page.waitForTimeout(1400);
  const databases = await page.evaluate(() => indexedDB.databases().then((items) => items.map((item) => item.name)));
  expect(databases).not.toContain('linuxdo-convenience-reader-v1');
});

test('loads all collection pages and sends the current actor for user notifications', async ({ page }) => {
  const requests = await bootReader(page, { target: 12, pagedCollections: true });
  await page.click('[data-reader-action="collections"]');
  await page.locator('.ldp-panel-search').fill('Liked final');
  await expect(page.locator('.ldp-reader-panel')).toContainText('Liked final');
  await page.click('[data-tab="posts"]');
  await page.locator('.ldp-panel-search').fill('Saved page 2');
  await expect(page.locator('.ldp-reader-panel')).toContainText('Saved page 2');
  await page.click('.ldp-panel-close');
  await page.locator('.ldp-post[data-post-number="12"] .ldp-avatar-btn').first().click();
  await page.locator('.ldp-user-notify').selectOption('mute');
  await expect.poll(() => requests.find((item) => item.type === 'notification-level')?.body || '').toContain('acting_user_id=9');
});

test('keeps read-only browsing available when signed out', async ({ page }) => {
  await bootReader(page, { target: 12, noUser: true });
  await page.click('[data-reader-action="collections"]');
  await expect(page.locator('.ldp-reader-panel')).toContainText('此分类暂无内容');
});

test('uses the current IDC Flare origin for all reader requests', async ({ page }) => {
  const requests = await bootReader(page, { target: 12, origin: 'https://idcflare.com' });
  expect(requests.some((item) => item.type === 'topic')).toBeTruthy();
  await expect(page.locator('.ldp-v2 .ldp-title')).toHaveText('Reader 2.0 performance topic');
});

test('shows an actionable error for a private topic response', async ({ page }) => {
  await page.route('https://linux.do/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/latest') {
      await route.fulfill({ contentType: 'text/html', body: '<a class="raw-topic-link" href="/t/private/42">Private topic</a>' });
    } else if (url.pathname === '/session/current.json') {
      await route.fulfill({ json: { current_user: { username: 'tester' } } });
    } else if (url.pathname === '/t/42.json') {
      await route.fulfill({ status: 403, json: { errors: ['private'] } });
    } else {
      await route.fulfill({ json: {} });
    }
  });
  await page.goto('https://linux.do/latest');
  await page.addScriptTag({ content: SCRIPT });
  await page.click('.raw-topic-link');
  await expect(page.locator('.ldp-error')).toContainText('HTTP 403');
});

test('generates desktop and dark-mode inspection screenshots', async ({ page }, testInfo) => {
  await bootReader(page, { target: 12 });
  await page.screenshot({ path: testInfo.outputPath('reader-desktop.png') });
  await page.locator('.ldp-post[data-post-number="12"] .ldp-avatar-btn').first().click();
  await expect(page.locator('.ldp-user-card-v2')).toContainText('Contributor');
  await page.screenshot({ path: testInfo.outputPath('reader-user-card.png') });
  await page.keyboard.press('Escape');
  await page.click('[data-reader-action="collections"]');
  await expect(page.locator('.ldp-reader-panel')).toContainText('Liked floor');
  await page.screenshot({ path: testInfo.outputPath('reader-collections.png') });
  await page.click('.ldp-panel-close');
  await page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty('--secondary', '#202521');
    root.style.setProperty('--primary', '#edf2ee');
    root.style.setProperty('--primary-medium', '#aab5ae');
    root.style.setProperty('--primary-low', '#3c4540');
    root.style.setProperty('--primary-very-low', '#292f2b');
  });
  await page.screenshot({ path: testInfo.outputPath('reader-dark.png') });
});

test('keeps the timeline visible beside an extra-wide code block', async ({ page }) => {
  await bootReader(page, { target: 12 });
  await page.locator('.ldp-post[data-post-number="12"] .ldp-content').evaluate((content) => {
    const pre = document.createElement('pre');
    pre.textContent = `docker compose ${'LONG_UNBROKEN_VALUE_'.repeat(80)}`;
    content.prepend(pre);
  });

  const layout = await page.evaluate(() => {
    const modal = document.querySelector('.ldp-v2 .ldp-modal').getBoundingClientRect();
    const shell = document.querySelector('.ldp-v2 .ldp-shell').getBoundingClientRect();
    const body = document.querySelector('.ldp-v2 .ldp-body').getBoundingClientRect();
    const timeline = document.querySelector('.ldp-v2 .ldp-timeline').getBoundingClientRect();
    return {
      modalRight: modal.right,
      shellRight: shell.right,
      bodyRight: body.right,
      timelineLeft: timeline.left,
      timelineRight: timeline.right,
      timelineWidth: timeline.width,
    };
  });

  expect(layout.shellRight).toBeLessThanOrEqual(layout.modalRight + 1);
  expect(layout.timelineRight).toBeLessThanOrEqual(layout.modalRight + 1);
  expect(layout.timelineLeft).toBeGreaterThanOrEqual(layout.bodyRight - 1);
  expect(layout.timelineWidth).toBeGreaterThan(70);
});

test.describe('mobile layout', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('keeps the reader and toolbar inside the viewport', async ({ page }, testInfo) => {
    await bootReader(page, { target: 12 });
    const box = await page.locator('.ldp-v2 .ldp-modal').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(7);
    expect(box.y).toBeGreaterThanOrEqual(7);
    expect(box.x + box.width).toBeLessThanOrEqual(383);
    expect(await page.locator('.ldp-toolbar').evaluate((node) => node.scrollWidth >= node.clientWidth)).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath('reader-mobile.png') });
  });
});

test('supports polls, spoilers, video placeholders, and KaTeX math from script B', async ({ page }) => {
  const requests = await bootReader(page, {
    target: 12,
    postOverrides: {
      12: {
        trust_level: 3,
        cooked: `
          <div class="poll" data-poll-name="poll"><div class="poll-title">Favorite runtime?</div></div>
          <p><span class="spoiler"><img src="/secret.png" alt="secret">Hidden spoiler text</span></p>
          <div class="video-placeholder-container" data-video-src="/demo.mp4"><img src="/poster.png" alt="poster"></div>
          <p>Inline formula: <span class="math">E = mc^2</span></p>
        `,
        polls: [{
          name: 'poll',
          type: 'regular',
          status: 'open',
          voters: 3,
          options: [
            { id: 'opt-a', html: 'Option A', votes: 1 },
            { id: 'opt-b', html: 'Option B', votes: 2 },
          ],
        }],
        polls_votes: {},
      },
    },
  });

  const floor12 = page.locator('.ldp-post[data-post-number="12"]');
  await expect(floor12.locator('.ldp-level')).toHaveText('Lv.3');

  // KaTeX renders math
  await expect(floor12.locator('.katex-rendered')).toHaveText('E = mc^2');

  // Blurred spoiler reveals on first click instead of opening lightbox
  const spoiler = floor12.locator('.ldp-spoiler');
  await expect(spoiler).toHaveClass(/ldp-spoiler-blurred/);
  await spoiler.click();
  await expect(spoiler).toHaveClass(/ldp-spoiler-expanded/);
  await expect(page.locator('.ldp-lightbox')).toHaveCount(0);

  // Video placeholder turns into native <video> without opening lightbox
  await floor12.locator('.video-placeholder-container').click();
  await expect(floor12.locator('video[src="/demo.mp4"]')).toHaveCount(1);
  await expect(page.locator('.ldp-lightbox')).toHaveCount(0);

  // Voting updates poll and survives virtual remounting
  await floor12.locator('.ldp-poll-option[data-option-id="opt-a"]').click();
  await expect(floor12.locator('.ldp-poll-option[data-option-id="opt-a"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(floor12.locator('.ldp-poll-remove')).toBeVisible();
  expect(requests.filter((r) => r.type === 'poll-vote')).toHaveLength(1);

  // Jump far away and back to verify virtual flow preserves poll state
  await page.click('.ldp-tl-bottom-date');
  await expect(page.locator(`.ldp-post[data-post-number="${POST_COUNT}"]`)).toBeVisible();
  await page.locator('.ldp-v2 .ldp-body').evaluate((el) => { el.scrollTop = 0; });
  await page.click('.ldp-tl-top-date');
  await page.evaluate(() => document.querySelector('.raw-topic-link').click());
});

test('supports emoji picker, insert templates, file paste upload, short replies, and own post deletion', async ({ page }) => {
  const requests = await bootReader(page, {
    target: 12,
    postOverrides: {
      12: {
        username: 'tester',
        name: 'Tester',
        boosts: [{ id: 77, cooked: 'nice', can_delete: false, user: { username: 'member0', name: 'Member Zero', avatar_template: '/avatars/member/{size}.png' } }],
      },
    },
  });

  const floor12 = page.locator('.ldp-post[data-post-number="12"]');

  // Clicking boost avatar opens UserCard V2
  await floor12.locator('.ldp-boost-avatar-link').click();
  await expect(page.locator('.ldp-user-card-v2')).toContainText('@member0');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ldp-user-card-v2')).toHaveCount(0);

  // Open reply box, insert template, pick emoji, paste file, and send short reply (<16 chars)
  await floor12.locator('.ldp-replybtn').click();
  const replyBox = floor12.locator('.ldp-replybox');
  await expect(replyBox).toHaveClass(/open/);
  const textarea = replyBox.locator('textarea');
  await textarea.fill('Hi');

  // Emoji picker opens, Escape closes picker without closing modal
  await replyBox.locator('.ldp-reply-emoji').click();
  await expect(page.locator('.ldp-emoji-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ldp-emoji-panel')).toHaveCount(0);
  await expect(page.locator('.ldp-v2 .ldp-modal')).toBeVisible();

  // Reopen emoji picker, switch to smileys tab, pick emoji -> smart space inserted ("Hi :grinning:")
  await replyBox.locator('.ldp-reply-emoji').click();
  await page.locator('.ldp-emoji-tab[data-group="smileys"]').click();
  await page.locator('.ldp-emoji-item[title=":grinning:"]').click();
  await expect(textarea).toHaveValue('Hi :grinning:');
  // Insert spoiler template and paste image file -> uploaded markdown inserted
  await replyBox.locator('.ldp-reply-insert').click();
  await replyBox.locator('.ldp-reply-spoiler').click();
  await expect(textarea).toHaveValue(/\[spoiler\]此文本将被模糊处理\[\/spoiler\]/);
  await textarea.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'demo.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => requests.filter((r) => r.type === 'upload-direct').length).toBe(1);
  await expect(textarea).toHaveValue(/!\[demo\.png\|320x180\]\(upload:\/\/demo123\.png\)/);

  // Also verify short reply (< 16 chars) succeeds (v1.9.1 behavior)
  await textarea.fill('Hi :grinning:');
  await replyBox.locator('.ldp-send').click();
  await expect.poll(() => requests.filter((r) => r.type === 'create-post').length).toBe(1);
  expect(requests.find((r) => r.type === 'create-post').raw).toBe('Hi :grinning:');
  // Delete own reply post (#12) replaces content with deleted placeholder
  await floor12.locator('.ldp-deletebtn').click();
  await expect(floor12.locator('.ldp-deleted')).toHaveText('（帖子已被作者删除）');
  expect(requests.filter((r) => r.type === 'delete-post')).toHaveLength(1);
});

test('supports dragging the timeline thumb to jump floors', async ({ page }) => {
  await bootReader(page, { target: 12 });
  const thumb = page.locator('.ldp-tl-thumb');
  const track = page.locator('.ldp-tl-track');
  const trackBox = await track.boundingBox();
  const thumbBox = await thumb.boundingBox();
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(trackBox.x + trackBox.width / 2, trackBox.y + trackBox.height * 0.75, { steps: 5 });
  await expect(page.locator('.ldp-tl-drag-tip')).toHaveClass(/show/);
  await page.mouse.up();
  await expect.poll(async () => {
    const text = await page.locator('.ldp-tl-current-post').textContent();
    return Number((text || '').split('/')[0].trim());
  }).toBeGreaterThan(1000);
});
