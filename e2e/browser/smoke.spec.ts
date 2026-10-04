import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Real browser, real WebRTC: the part the Node tests can only simulate. Each person gets an isolated
 * browser context (separate storage, separate RTCPeerConnection stack, like two profiles) and a
 * distinct CF-Connecting-IP so the worker's per-IP rate limits treat them as different clients.
 */

let ipCounter = 0;

async function person(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": `10.77.0.${++ipCounter}` },
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[browser ${ipCounter}] ${msg.text()}`);
  });
  return page;
}

const status = (page: Page) => page.locator("body");

async function createRoom(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByTestId("create").click();
  await page.waitForURL(/\/join\/#[A-Za-z0-9_-]{22}\./);
  await expect(status(page)).toHaveAttribute("data-status", "waiting");
  return page.getByTestId("invite").inputValue();
}

async function pair(browser: Browser): Promise<{ alice: Page; bob: Page; invite: string }> {
  const alice = await person(browser);
  const invite = await createRoom(alice);
  const bob = await person(browser);
  await bob.goto(invite);
  await expect(status(alice)).toHaveAttribute("data-status", "sealed");
  await expect(status(bob)).toHaveAttribute("data-status", "sealed");
  return { alice, bob, invite };
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("send").click();
}

async function bootLog(page: Page): Promise<string> {
  return (await page.getByTestId("log").innerText()).trim();
}

test("two browsers pair over real WebRTC, chat both ways, and destroy ends it for both", async ({
  browser,
}) => {
  const { alice, bob, invite } = await pair(browser);

  // The invite link carries the room id and the key in the fragment, which never reaches a server.
  expect(invite).toMatch(/^http:\/\/localhost:5173\/join\/#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);

  // Same machine, no TURN secrets: the path must be a direct one.
  await expect(status(alice)).toHaveAttribute("data-connection", "direct");
  await expect(status(bob)).toHaveAttribute("data-connection", "direct");
  // Free room: no file sending.
  await expect(status(alice)).toHaveAttribute("data-files", "false");
  await expect(alice.getByTestId("file-input")).toHaveCount(0);

  await send(alice, "hello from alice");
  await expect(bob.getByTestId("messages").locator('li[data-mine="false"]')).toHaveText([
    "hello from alice",
  ]);
  await send(bob, "hi alice\nsecond line");
  await expect(alice.getByTestId("messages").locator('li[data-mine="false"]')).toHaveText([
    "hi alice\nsecond line",
  ]);

  const log = await bootLog(alice);
  console.log(`alice boot log:\n${log}`);
  for (const code of ["signaling.connected", "peer.joined", "dc.open", "path.direct", "pq.done"]) {
    expect(log).toContain(code);
  }

  await alice.getByTestId("destroy").click();
  await expect(status(alice)).toHaveAttribute("data-status", "terminated");
  await expect(status(alice)).toHaveAttribute("data-end-reason", "destroyed_by_me");
  await expect(status(bob)).toHaveAttribute("data-status", "terminated");
  await expect(status(bob)).toHaveAttribute("data-end-reason", "destroyed_by_peer");
  // Terminated rooms wipe the transcript.
  await expect(bob.getByTestId("messages").locator("li")).toHaveCount(0);

  // The link is dead afterwards.
  const late = await person(browser);
  await late.goto(invite);
  await expect(status(late)).toHaveAttribute("data-status", "error");
  await expect(status(late)).toHaveAttribute("data-error", "room_not_found");
});

test("a third person is turned away", async ({ browser }) => {
  const { alice, bob, invite } = await pair(browser);
  const carol = await person(browser);
  await carol.goto(invite);
  await expect(status(carol)).toHaveAttribute("data-status", "error");
  await expect(status(carol)).toHaveAttribute("data-error", "room_full");
  // The pair is unaffected.
  await send(alice, "still here");
  await expect(bob.getByTestId("messages").locator('li[data-mine="false"]')).toHaveText([
    "still here",
  ]);
});

test("closing the tab ends the room for the other person", async ({ browser }) => {
  const { alice, bob } = await pair(browser);
  await bob.close({ runBeforeUnload: true });
  await expect(status(alice)).toHaveAttribute("data-status", "terminated");
  await expect(status(alice)).toHaveAttribute("data-end-reason", "peer_left");
});

test("only the creator sees 'Poof it now'; the guest can only leave", async ({ browser }) => {
  const { alice, bob } = await pair(browser);
  await expect(alice.getByTestId("destroy")).toBeVisible();
  await expect(alice.getByTestId("leave")).toHaveCount(0);
  await expect(bob.getByTestId("destroy")).toHaveCount(0);

  await bob.getByTestId("leave").click();
  await bob.waitForURL("http://localhost:5173/");
  // A free room ends for the creator when the other person leaves.
  await expect(status(alice)).toHaveAttribute("data-status", "terminated");
  await expect(status(alice)).toHaveAttribute("data-end-reason", "peer_left");
});

test("the creator can still destroy after reloading the tab", async ({ browser }) => {
  const alice = await person(browser);
  const invite = await createRoom(alice);
  await alice.reload();
  await expect(status(alice)).toHaveAttribute("data-status", "waiting");
  await expect(alice.getByTestId("destroy")).toBeVisible();

  const bob = await person(browser);
  await bob.goto(invite);
  await expect(status(bob)).toHaveAttribute("data-status", "sealed");
  await alice.getByTestId("destroy").click();
  await expect(status(bob)).toHaveAttribute("data-end-reason", "destroyed_by_peer");

  // The secret lived in sessionStorage only, and is gone once the room is.
  const leftovers = await alice.evaluate(() => ({
    session: Object.keys(sessionStorage),
    local: Object.keys(localStorage),
  }));
  expect(leftovers).toEqual({ session: [], local: [] });
});

test("a guest joins with the 4-word code, which then stops working", async ({ browser }) => {
  const alice = await person(browser);
  await createRoom(alice);
  await alice.getByTestId("share-code").click();
  const code = (await alice.getByTestId("phrase").innerText()).trim();
  expect(code).toMatch(/^[a-z]+(-[a-z]+){3}$/);

  // Typed the way a person would: spaces, some capitals.
  const bob = await person(browser);
  await bob.goto("/");
  await bob
    .getByTestId("code-input")
    .fill(code.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase()));
  await bob.getByTestId("join").click();
  await bob.waitForURL(/\/join\/#[A-Za-z0-9_-]{22}\./);
  await expect(status(alice)).toHaveAttribute("data-status", "sealed");
  await expect(status(bob)).toHaveAttribute("data-status", "sealed");
  expect(bob.url()).toBe(await alice.getByTestId("invite").inputValue());

  // One-time: someone who sees the code later gets nothing.
  const carol = await person(browser);
  await carol.goto("/");
  await carol.getByTestId("code-input").fill(code);
  await carol.getByTestId("join").click();
  await expect(carol.getByTestId("join-error")).toHaveText("not_found_or_expired");
  expect(carol.url()).toBe("http://localhost:5173/");
});

test("a broken link shows invalid_link without calling the server", async ({ browser }) => {
  const page = await person(browser);
  await page.goto("/join/#not-a-room.nope");
  await expect(status(page)).toHaveAttribute("data-status", "error");
  await expect(status(page)).toHaveAttribute("data-error", "invalid_link");
});

test("a browser without WebRTC gets the unsupported screen instead of a broken room", async ({
  browser,
}) => {
  const alice = await person(browser);
  const invite = await createRoom(alice);

  const context = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": `10.77.0.${++ipCounter}` },
  });
  await context.addInitScript(() => {
    // What some locked-down browsers and privacy extensions do.
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });
  const bob = await context.newPage();
  await bob.goto(invite);
  await expect(bob.getByTestId("unsupported")).toHaveAttribute("data-missing", "webrtc");
  // It never joined: Alice is still alone.
  await expect(status(alice)).toHaveAttribute("data-status", "waiting");
  await context.close();
});

test("an in-app browser is told to open the link in the real browser, and can still continue", async ({
  browser,
}) => {
  const alice = await person(browser);
  const invite = await createRoom(alice);

  const context = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": `10.77.0.${++ipCounter}` },
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Instagram 352.0.0.38.100 Android",
  });
  const bob = await context.newPage();
  await bob.goto(invite);
  await expect(bob.getByTestId("in-app")).toHaveAttribute("data-app", "instagram");
  await expect(bob.getByTestId("in-app")).toHaveAttribute("data-platform", "android");
  await expect(status(bob)).toHaveAttribute("data-status", "sealed");
  await expect(status(alice)).toHaveAttribute("data-status", "sealed");
  await context.close();
});
