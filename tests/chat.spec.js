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
// Test: Messages persist to Gun localStorage
//
// Verifies that Gun writes message data to localStorage
// so it can be retrieved on subsequent page loads.
// ─────────────────────────────────────────────
test('messages are written to Gun localStorage', async ({ page }) => {
  await page.goto('/');
  const room = `persist-${Date.now()}`;
  await joinRoom(page, 'PersistUser', room);

  await sendMessage(page, 'Persistence test');

  // Verify Gun wrote to localStorage
  const hasData = await page.waitForFunction(() => {
    const keys = Object.keys(localStorage);
    return keys.length > 0;
  }, { timeout: 10000 });
  expect(hasData).toBeTruthy();

  // Verify the message text exists somewhere in localStorage
  const hasMessage = await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      const val = localStorage.getItem(key);
      if (val && val.includes('Persistence test')) return true;
    }
    return false;
  });
  expect(hasMessage).toBe(true);
});

// ─────────────────────────────────────────────
// Test: Messages render in chronological order
//
// Injects messages via Gun right after joining so they
// land in the initial-load buffer and get sorted.
// ─────────────────────────────────────────────
test('messages are displayed in chronological order', async ({ page }) => {
  const room = `order-${Date.now()}`;
  await page.goto('/');
  await joinRoom(page, 'OrderUser', room);

  await page.evaluate(() => {
    const ref = roomRef.get('messages');
    const now = Date.now();
    ref.get('msg-c').put({ text: 'Third',  author: 'Bot', authorId: 'bot', ts: now });
    ref.get('msg-a').put({ text: 'First',  author: 'Bot', authorId: 'bot', ts: now - 20000 });
    ref.get('msg-b').put({ text: 'Second', author: 'Bot', authorId: 'bot', ts: now - 10000 });
  });

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
// Directly populates messageHistory and calls the
// rendering pipeline to test pagination UI logic.
// ─────────────────────────────────────────────
test('initial load shows only last 50 messages with load-more button', async ({ page }) => {
  const room = `page-${Date.now()}`;
  await page.goto('/');
  await joinRoom(page, 'PageUser', room);

  // Wait for initial buffer to flush (empty room, so debounce/max-wait fires)
  await page.waitForTimeout(2500);

  // Directly populate messageHistory and render with pagination
  await page.evaluate(() => {
    const count = 70;
    const baseTs = Date.now() - count * 1000;
    messageHistory = [];
    for (let i = 0; i < count; i++) {
      messageHistory.push({
        text: `Message ${i + 1}`,
        author: 'Bot',
        authorId: 'bot-id',
        ts: baseTs + i * 1000,
      });
    }

    const start = Math.max(0, messageHistory.length - PAGE_SIZE);
    historyOffset = messageHistory.length - start;

    if (start > 0) showLoadMoreButton();

    for (let i = start; i < messageHistory.length; i++) {
      renderMessage(messageHistory[i], true);
    }
  });

  // Should see the "Load older messages" button
  await expect(page.locator('.load-more')).toBeVisible({ timeout: 3000 });

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
  await page.goto('/');
  await joinRoom(page, 'LoadUser', room);

  // Wait for initial buffer to flush
  await page.waitForTimeout(2500);

  // Directly populate messageHistory and render with pagination
  await page.evaluate(() => {
    const count = 70;
    const baseTs = Date.now() - count * 1000;
    messageHistory = [];
    for (let i = 0; i < count; i++) {
      messageHistory.push({
        text: `Message ${i + 1}`,
        author: 'Bot',
        authorId: 'bot-id',
        ts: baseTs + i * 1000,
      });
    }

    const start = Math.max(0, messageHistory.length - PAGE_SIZE);
    historyOffset = messageHistory.length - start;

    if (start > 0) showLoadMoreButton();

    for (let i = start; i < messageHistory.length; i++) {
      renderMessage(messageHistory[i], true);
    }
  });

  // Wait for load-more to appear, then click it
  await expect(page.locator('.load-more')).toBeVisible({ timeout: 3000 });
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
  await expect(allBubbles.last()).not.toHaveClass(/emoji-only/);
});

// ─────────────────────────────────────────────
// Test: Auto-rejoin skips lobby
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
// Test: Name pre-fill from cookie
// ─────────────────────────────────────────────
test('name input is pre-filled from cookie on fresh visit', async ({ page }) => {
  await page.goto('/');
  const room = `prefill-${Date.now()}`;
  await joinRoom(page, 'PreFillUser', room);

  await page.goto('/');
  await expect(page.locator('#nameInput')).toHaveValue('PreFillUser');
});
