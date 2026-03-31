const { test, expect } = require('@playwright/test');

// Unique room per test run to avoid cross-contamination
const TEST_ROOM = `test-room-${Date.now()}`;
const TEST_NAME = 'TestUser';

// Helper: join a room with a given name
async function joinRoom(page, name, room) {
  await page.fill('#nameInput', name);
  await page.fill('#roomInput', room);
  await page.click('#joinBtn');
  await expect(page.locator('#chat')).toHaveClass(/active/);
}

// Helper: send a message and wait for it to appear in the DOM
async function sendMessage(page, text) {
  await page.fill('#msgInput', text);
  await page.click('.send-btn');
  await expect(page.locator('.msg-bubble', { hasText: text })).toBeVisible();
}

// Helper: wait for the initial buffer to flush (messages rendered)
async function waitForFlush(page) {
  // The app flushes 400ms after last message arrives, max 2s.
  // Wait for at least one .msg element or the flush timeout.
  await page.waitForTimeout(600);
}

// Helper: inject messages into Gun and wait for them to render
async function injectAndWaitForMessages(page, count, room) {
  await page.evaluate(({ count, room }) => {
    const ref = gun.get('buzz-chat-v1').get(room).get('messages');
    const baseTs = Date.now() - count * 1000;
    for (let i = 0; i < count; i++) {
      const msgId = `inject-${i}-${Math.random().toString(36).slice(2, 6)}`;
      ref.get(msgId).put({
        text: `Message ${i + 1}`,
        author: 'Bot',
        authorId: 'bot-id',
        ts: baseTs + i * 1000,
      });
    }
  }, { count, room });
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

  // Author should show "You" for own messages
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

  // Verify cookies are set
  const cookies = await page.context().cookies();
  const idCookie = cookies.find(c => c.name === 'buzz_user_id');
  const nameCookie = cookies.find(c => c.name === 'buzz_user_name');
  expect(idCookie).toBeTruthy();
  expect(nameCookie).toBeTruthy();
  expect(nameCookie.value).toBe('CookieUser');

  const savedId = idCookie.value;

  // Refresh the page (URL still has ?room=...)
  await page.reload();

  // Should auto-rejoin — chat should be active
  await expect(page.locator('#chat')).toHaveClass(/active/, { timeout: 5000 });

  // ID should be the same after refresh
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

  // Wait for Gun to flush to localStorage
  await page.waitForFunction(() => {
    return Object.keys(localStorage).length > 0;
  }, { timeout: 5000 });

  // Refresh
  await page.reload();
  await expect(page.locator('#chat')).toHaveClass(/active/, { timeout: 5000 });

  // Wait for message to appear (debounced buffer flush + Gun read)
  const msg = page.locator('.msg-bubble', { hasText: 'Before refresh' });
  await expect(msg).toBeVisible({ timeout: 10000 });
});

// ─────────────────────────────────────────────
// Test: Messages render in chronological order
// ─────────────────────────────────────────────
test('messages are displayed in chronological order', async ({ page }) => {
  // Navigate to room URL so auto-join seeds the room reference
  const room = `order-${Date.now()}`;

  // Seed messages into Gun localStorage before joining
  // by going to the page, joining, injecting, then navigating fresh
  await page.goto('/');
  await joinRoom(page, 'OrderUser', room);

  // Inject messages with known timestamps in REVERSE order
  await page.evaluate((room) => {
    const ref = gun.get('buzz-chat-v1').get(room).get('messages');
    const now = Date.now();
    ref.get('msg-c').put({ text: 'Third', author: 'Bot', authorId: 'bot', ts: now });
    ref.get('msg-a').put({ text: 'First', author: 'Bot', authorId: 'bot', ts: now - 20000 });
    ref.get('msg-b').put({ text: 'Second', author: 'Bot', authorId: 'bot', ts: now - 10000 });
  }, room);

  // Wait for Gun to process and the debounced flush to render
  await page.waitForTimeout(1000);

  // These arrived as live messages (after initial flush), so they're in arrival order.
  // Navigate fresh to trigger the initial-load sort path.
  await page.goto(`/?room=${room}`);
  await expect(page.locator('#chat')).toHaveClass(/active/, { timeout: 5000 });

  // Wait for sorted messages to render
  await expect(page.locator('.msg.theirs .msg-bubble', { hasText: 'Third' }))
    .toBeVisible({ timeout: 10000 });

  // Get all message bubbles from "Bot"
  const bubbles = page.locator('.msg.theirs .msg-bubble');
  const texts = await bubbles.allTextContents();
  const ordered = texts.filter(t => ['First', 'Second', 'Third'].includes(t));
  expect(ordered).toEqual(['First', 'Second', 'Third']);
});

// ─────────────────────────────────────────────
// Test: Pagination — only last 50 messages rendered initially
// ─────────────────────────────────────────────
test('initial load shows only last 50 messages with load-more button', async ({ page }) => {
  const room = `page-${Date.now()}`;
  await page.goto('/');
  await joinRoom(page, 'PageUser', room);

  // Inject 70 messages
  await injectAndWaitForMessages(page, 70, room);

  // Wait for Gun to flush to localStorage
  await page.waitForFunction(() => {
    return Object.keys(localStorage).length > 0;
  }, { timeout: 5000 });
  await page.waitForTimeout(500);

  // Navigate fresh to trigger initial-load pagination
  await page.goto(`/?room=${room}`);
  await expect(page.locator('#chat')).toHaveClass(/active/, { timeout: 5000 });

  // Wait for last message to render (proves flush happened)
  await expect(page.locator('.msg.theirs .msg-bubble', { hasText: 'Message 70' }))
    .toBeVisible({ timeout: 10000 });

  // Should see the "Load older messages" button
  const loadMoreBtn = page.locator('.load-more');
  await expect(loadMoreBtn).toBeVisible({ timeout: 3000 });

  // Count visible bot messages — should be 50
  const bubbles = page.locator('.msg.theirs .msg-bubble');
  const count = await bubbles.count();
  expect(count).toBe(50);

  // The last message should be "Message 70"
  await expect(bubbles.last()).toHaveText('Message 70');

  // The first visible should be "Message 21" (70 - 50 + 1)
  await expect(bubbles.first()).toHaveText('Message 21');
});

// ─────────────────────────────────────────────
// Test: Clicking "Load more" renders older messages
// ─────────────────────────────────────────────
test('load-more button reveals older messages', async ({ page }) => {
  const room = `loadmore-${Date.now()}`;
  await page.goto('/');
  await joinRoom(page, 'LoadUser', room);

  // Inject 70 messages
  await injectAndWaitForMessages(page, 70, room);

  // Wait for Gun to flush
  await page.waitForFunction(() => {
    return Object.keys(localStorage).length > 0;
  }, { timeout: 5000 });
  await page.waitForTimeout(500);

  // Navigate fresh
  await page.goto(`/?room=${room}`);
  await expect(page.locator('#chat')).toHaveClass(/active/, { timeout: 5000 });

  // Wait for messages to render
  await expect(page.locator('.msg.theirs .msg-bubble', { hasText: 'Message 70' }))
    .toBeVisible({ timeout: 10000 });

  // Click load more
  await page.click('.load-more');

  // Now all 70 should be visible
  const bubbles = page.locator('.msg.theirs .msg-bubble');
  await expect(bubbles).toHaveCount(70, { timeout: 3000 });

  // First message should now be "Message 1"
  await expect(bubbles.first()).toHaveText('Message 1');

  // No more load-more button
  await expect(page.locator('.load-more')).not.toBeVisible();
});

// ─────────────────────────────────────────────
// Test: Emoji-only messages get enlarged styling
// ─────────────────────────────────────────────
test('emoji-only messages render with enlarged styling', async ({ page }) => {
  await page.goto('/');
  const room = `emoji-${Date.now()}`;
  await joinRoom(page, 'EmojiUser', room);

  // Send an emoji-only message
  await sendMessage(page, '🔥🎉');

  const emojiBubble = page.locator('.msg-bubble.emoji-only');
  await expect(emojiBubble).toBeVisible();

  // Send a mixed message — should NOT get emoji-only class
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

  // Navigate directly to the room URL (simulating bookmark)
  await page.goto(`/?room=${room}`);

  // Should skip lobby and go straight to chat
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

  // Navigate to root (no room param) — should show lobby with name pre-filled
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

  // Send a message to trigger Gun writes
  await sendMessage(page, 'localStorage test');

  // Gun should write to localStorage eventually
  const hasData = await page.waitForFunction(() => {
    return Object.keys(localStorage).length > 0;
  }, { timeout: 5000 });
  expect(hasData).toBeTruthy();
});
