const { test, expect } = require('@playwright/test');

const TEST_ROOM = `test-room-${Date.now()}`;
const TEST_NAME = 'TestUser';

// Helper: join a room with a given name
async function joinRoom(page, name, room) {
  await page.fill('#nameInput', name);
  await page.fill('#roomInput', room);
  await page.click('#joinBtn');
  await expect(page.locator('#chat')).toHaveClass(/active/);
}

// Helper: send a message and wait for it to appear
async function sendMessage(page, text) {
  await page.fill('#msgInput', text);
  await page.click('.send-btn');
  await expect(page.locator('.msg-bubble', { hasText: text })).toBeVisible();
}

// ─────────────────────────────────────────────
// Test: Lobby → Join → Chat flow
// ─────────────────────────────────────────────
test('can join a room and see the chat interface', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#lobby')).toBeVisible();
  await expect(page.locator('#chat')).not.toHaveClass(/active/);

  await joinRoom(page, TEST_NAME, TEST_ROOM);

  await expect(page.locator('#lobby')).toHaveClass(/hidden/);
  await expect(page.locator('.room-badge')).toHaveText(`# ${TEST_ROOM}`);
});

// ─────────────────────────────────────────────
// Test: Send and receive own message
// ─────────────────────────────────────────────
test('can send a message and see it in the chat', async ({ page }) => {
  await page.goto('/');
  const room = `send-${Date.now()}`;
  await joinRoom(page, TEST_NAME, room);

  await sendMessage(page, 'Hello world!');

  const msg = page.locator('.msg.mine .msg-bubble', { hasText: 'Hello world!' });
  await expect(msg).toBeVisible();

  const author = page.locator('.msg.mine .msg-author');
  await expect(author.first()).toHaveText('You');
});

// ─────────────────────────────────────────────
// Test: Cookie persistence — name and ID survive refresh
// ─────────────────────────────────────────────
test('cookies persist user name and ID across refresh', async ({ page }) => {
  await page.goto('/');
  const room = `cookie-${Date.now()}`;
  await joinRoom(page, 'CookieUser', room);

  const cookies = await page.context().cookies();
  const idCookie = cookies.find(c => c.name === 'buzz_user_id');
  const nameCookie = cookies.find(c => c.name === 'buzz_user_name');
  expect(idCookie).toBeTruthy();
  expect(nameCookie).toBeTruthy();
  expect(nameCookie.value).toBe('CookieUser');

  const savedId = idCookie.value;

  await page.reload();
  await expect(page.locator('#chat')).toHaveClass(/active/, { timeout: 5000 });

  const cookiesAfter = await page.context().cookies();
  const idAfter = cookiesAfter.find(c => c.name === 'buzz_user_id');
  expect(idAfter.value).toBe(savedId);
});

// ─────────────────────────────────────────────
// Test: Messages persist after refresh (via Gun localStorage)
// ─────────────────────────────────────────────
test('messages survive page refresh', async ({ page }) => {
  await page.goto('/');
  const room = `persist-${Date.now()}`;
  await joinRoom(page, 'PersistUser', room);

  await sendMessage(page, 'Before refresh');

  // Poll until Gun has flushed to localStorage
  await page.waitForFunction(() => {
    return Object.keys(localStorage).length > 0;
  }, { timeout: 10000 });

  // Extra buffer for Gun's async write
  await page.waitForTimeout(2000);

  await page.reload();
  await expect(page.locator('#chat')).toHaveClass(/active/, { timeout: 5000 });

  const msg = page.locator('.msg-bubble', { hasText: 'Before refresh' });
  await expect(msg).toBeVisible({ timeout: 15000 });
});

// ─────────────────────────────────────────────
// Test: Messages render in chronological order
//
// Strategy: use addInitScript to seed Gun localStorage
// BEFORE the page loads, so the initial-load buffer
// picks them up and sorts them.
// ─────────────────────────────────────────────
test('messages are displayed in chronological order', async ({ page }) => {
  const room = `order-${Date.now()}`;

  // Seed Gun's localStorage with messages in REVERSE timestamp order.
  // Gun stores its graph under a single '' key or per-node keys.
  // We'll seed directly via addInitScript before Gun initializes.
  await page.addInitScript((room) => {
    // Write messages into Gun's localStorage graph before Gun loads
    const graph = JSON.parse(localStorage.getItem('gun/') || '{}');
    const ns = `buzz-chat-v1/${room}/messages`;
    const now = Date.now();

    // Create the message nodes with timestamps out of order
    const messages = {
      'msg-c': { text: 'Third',  author: 'Bot', authorId: 'bot', ts: now,         _: { '#': `${ns}/msg-c`, '>': { text: now, author: now, authorId: now, ts: now } } },
      'msg-a': { text: 'First',  author: 'Bot', authorId: 'bot', ts: now - 20000, _: { '#': `${ns}/msg-a`, '>': { text: now, author: now, authorId: now, ts: now } } },
      'msg-b': { text: 'Second', author: 'Bot', authorId: 'bot', ts: now - 10000, _: { '#': `${ns}/msg-b`, '>': { text: now, author: now, authorId: now, ts: now } } },
    };

    // Build Gun graph structure
    graph[ns] = { _: { '#': ns, '>': { 'msg-c': now, 'msg-a': now, 'msg-b': now } }, 'msg-c': { '#': `${ns}/msg-c` }, 'msg-a': { '#': `${ns}/msg-a` }, 'msg-b': { '#': `${ns}/msg-b` } };
    graph[`${ns}/msg-c`] = messages['msg-c'];
    graph[`${ns}/msg-a`] = messages['msg-a'];
    graph[`${ns}/msg-b`] = messages['msg-b'];

    localStorage.setItem('gun/', JSON.stringify(graph));
  }, room);

  // Set cookies so auto-join works
  await page.context().addCookies([
    { name: 'buzz_user_name', value: 'OrderUser', domain: 'localhost', path: '/' },
    { name: 'buzz_user_id', value: 'order-test-id', domain: 'localhost', path: '/' },
  ]);

  await page.goto(`/?room=${room}`);
  await expect(page.locator('#chat')).toHaveClass(/active/, { timeout: 5000 });

  // Wait for messages to render
  await expect(page.locator('.msg.theirs .msg-bubble', { hasText: 'Third' }))
    .toBeVisible({ timeout: 10000 });

  const bubbles = page.locator('.msg.theirs .msg-bubble');
  const texts = await bubbles.allTextContents();
  const ordered = texts.filter(t => ['First', 'Second', 'Third'].includes(t));
  expect(ordered).toEqual(['First', 'Second', 'Third']);
});

// ─────────────────────────────────────────────
// Test: Pagination — only last 50 rendered initially
//
// Strategy: join room, immediately inject 70 messages
// via Gun. They arrive during the initial buffer window
// and get sorted + paginated on flush.
// ─────────────────────────────────────────────
test('initial load shows only last 50 messages with load-more button', async ({ page }) => {
  const room = `page-${Date.now()}`;
  await page.goto(`/?room=${room}`);

  // Join quickly to start the buffer window
  await page.fill('#nameInput', 'PageUser');
  await page.fill('#roomInput', room);
  await page.click('#joinBtn');
  await expect(page.locator('#chat')).toHaveClass(/active/);

  // Immediately inject 70 messages — they'll land in the initial buffer
  await page.evaluate(({ count, room }) => {
    const ref = gun.get('buzz-chat-v1').get(room).get('messages');
    const baseTs = Date.now() - count * 1000;
    for (let i = 0; i < count; i++) {
      ref.get(`inject-${i}`).put({
        text: `Message ${i + 1}`,
        author: 'Bot',
        authorId: 'bot-id',
        ts: baseTs + i * 1000,
      });
    }
  }, { count: 70, room });

  // Wait for debounced flush (400ms after last message + rendering)
  await expect(page.locator('.msg.theirs .msg-bubble', { hasText: 'Message 70' }))
    .toBeVisible({ timeout: 10000 });

  // Should see the "Load older messages" button
  const loadMoreBtn = page.locator('.load-more');
  await expect(loadMoreBtn).toBeVisible({ timeout: 3000 });

  // Count visible bot messages — should be 50
  const bubbles = page.locator('.msg.theirs .msg-bubble');
  const count = await bubbles.count();
  expect(count).toBe(50);

  await expect(bubbles.last()).toHaveText('Message 70');
  await expect(bubbles.first()).toHaveText('Message 21');
});

// ─────────────────────────────────────────────
// Test: Clicking "Load more" renders older messages
// ─────────────────────────────────────────────
test('load-more button reveals older messages', async ({ page }) => {
  const room = `loadmore-${Date.now()}`;
  await page.goto(`/?room=${room}`);

  await page.fill('#nameInput', 'LoadUser');
  await page.fill('#roomInput', room);
  await page.click('#joinBtn');
  await expect(page.locator('#chat')).toHaveClass(/active/);

  // Inject 70 messages during initial buffer window
  await page.evaluate(({ count, room }) => {
    const ref = gun.get('buzz-chat-v1').get(room).get('messages');
    const baseTs = Date.now() - count * 1000;
    for (let i = 0; i < count; i++) {
      ref.get(`inject-${i}`).put({
        text: `Message ${i + 1}`,
        author: 'Bot',
        authorId: 'bot-id',
        ts: baseTs + i * 1000,
      });
    }
  }, { count: 70, room });

  // Wait for flush
  await expect(page.locator('.msg.theirs .msg-bubble', { hasText: 'Message 70' }))
    .toBeVisible({ timeout: 10000 });

  // Click load more
  await page.click('.load-more');

  // All 70 should be visible
  const bubbles = page.locator('.msg.theirs .msg-bubble');
  await expect(bubbles).toHaveCount(70, { timeout: 3000 });

  await expect(bubbles.first()).toHaveText('Message 1');
  await expect(page.locator('.load-more')).not.toBeVisible();
});

// ─────────────────────────────────────────────
// Test: Emoji-only messages get enlarged styling
// ─────────────────────────────────────────────
test('emoji-only messages render with enlarged styling', async ({ page }) => {
  await page.goto('/');
  const room = `emoji-${Date.now()}`;
  await joinRoom(page, 'EmojiUser', room);

  await sendMessage(page, '🔥🎉');

  const emojiBubble = page.locator('.msg-bubble.emoji-only');
  await expect(emojiBubble).toBeVisible();

  await sendMessage(page, 'Hello 🔥');
  const allBubbles = page.locator('.msg-bubble');
  const lastBubble = allBubbles.last();
  await expect(lastBubble).not.toHaveClass(/emoji-only/);
});

// ─────────────────────────────────────────────
// Test: Auto-rejoin skips lobby when cookie + room param exist
// ─────────────────────────────────────────────
test('returning user with room URL auto-joins without lobby', async ({ page }) => {
  await page.goto('/');
  const room = `auto-${Date.now()}`;
  await joinRoom(page, 'AutoUser', room);

  await page.goto(`/?room=${room}`);

  await expect(page.locator('#chat')).toHaveClass(/active/, { timeout: 5000 });
  await expect(page.locator('#lobby')).toHaveClass(/hidden/);
  await expect(page.locator('.room-badge')).toHaveText(`# ${room}`);
});

// ─────────────────────────────────────────────
// Test: Name input is pre-filled from cookie
// ─────────────────────────────────────────────
test('name input is pre-filled from cookie on fresh visit', async ({ page }) => {
  await page.goto('/');
  const room = `prefill-${Date.now()}`;
  await joinRoom(page, 'PreFillUser', room);

  await page.goto('/');
  const nameInput = page.locator('#nameInput');
  await expect(nameInput).toHaveValue('PreFillUser');
});

// ─────────────────────────────────────────────
// Test: Gun.js localStorage is enabled
// ─────────────────────────────────────────────
test('Gun.js localStorage is enabled', async ({ page }) => {
  await page.goto('/');
  const room = `ls-${Date.now()}`;
  await joinRoom(page, 'LSUser', room);

  await sendMessage(page, 'localStorage test');

  const hasData = await page.waitForFunction(() => {
    return Object.keys(localStorage).length > 0;
  }, { timeout: 10000 });
  expect(hasData).toBeTruthy();
});
