import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Group rooms in real Chrome: four isolated browser contexts, real WebRTC mesh (6 connections),
 * pairwise post-quantum handshakes, against a wrangler dev where free rooms hold 4 people
 * and may send files (ROOM_MAX_PEERS_FREE=4, ROOM_FILES_FREE=1, see playwright.config.ts). Super
 * rooms will set this for real.
 */

let ipCounter = 0;

async function person(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "CF-Connecting-IP": `10.88.0.${++ipCounter}` },
  });
  return context.newPage();
}

const body = (page: Page) => page.locator("body");

async function room(browser: Browser, size: number) {
  const creator = await person(browser);
  await creator.goto("/");
  await creator.getByTestId("create").click();
  await creator.waitForURL(/\/join\/#[A-Za-z0-9_-]{22}\./);
  await expect(body(creator)).toHaveAttribute("data-status", "waiting");
  const invite = await creator.getByTestId("invite").inputValue();
  const others: Page[] = [];
  for (let i = 1; i < size; i++) {
    const p = await person(browser);
    await p.goto(invite);
    others.push(p);
  }
  const everyone = [creator, ...others];
  for (const p of everyone) await expect(body(p)).toHaveAttribute("data-members", String(size - 1));
  return { everyone, invite };
}

test("four people: a full mesh, names, messages to everyone, someone leaving, a fifth turned away", async ({
  browser,
}) => {
  const { everyone, invite } = await room(browser, 4);
  const [ana, bob, carol, dan] = everyone as [Page, Page, Page, Page];
  for (const p of everyone) {
    await expect(body(p)).toHaveAttribute("data-status", "sealed");
    await expect(p.getByTestId("members").locator("li[data-state=sealed]")).toHaveCount(3);
  }

  // A nickname travels over the encrypted links only.
  await ana.getByTestId("nickname-input").fill("Ana");
  await ana.getByTestId("nickname-save").click();
  for (const p of [bob, carol, dan]) {
    await expect(p.getByTestId("members")).toContainText("Ana · Peer");
  }

  // One message, encrypted once per member, reaches all three with the sender's name.
  await ana.getByTestId("message-input").fill("hello group");
  await ana.getByTestId("send").click();
  for (const p of [bob, carol, dan]) {
    await expect(p.getByTestId("messages").locator('li[data-mine="false"]')).toHaveText([
      /^Ana · Peer [0-9A-F]{4}: hello group$/,
    ]);
  }

  // Carol leaves: the others get a line, keep the transcript and keep talking.
  await carol.getByTestId("leave").click();
  for (const p of [ana, bob, dan]) {
    await expect(body(p)).toHaveAttribute("data-members", "2");
    await expect(p.getByTestId("messages").locator('li[data-system="left"]')).toHaveCount(1);
    await expect(body(p)).toHaveAttribute("data-status", "sealed");
  }
  await bob.getByTestId("message-input").fill("still here");
  await bob.getByTestId("send").click();
  await expect(dan.getByTestId("messages").locator('li[data-mine="false"]')).toHaveCount(2);

  // Nobody was shown a different set of people.
  for (const p of [ana, bob, dan]) await expect(body(p)).toHaveAttribute("data-mismatch", "false");

  // Carol's slot is free again: a newcomer fits, and then a fifth person doesn't.
  const erin = await person(browser);
  await erin.goto(invite);
  for (const p of [ana, bob, dan, erin]) await expect(body(p)).toHaveAttribute("data-members", "3");
  const frank = await person(browser);
  await frank.goto(invite);
  await expect(body(frank)).toHaveAttribute("data-error", "room_full");

  // Only the creator can end it, for everyone.
  await expect(bob.getByTestId("destroy")).toHaveCount(0);
  await ana.getByTestId("destroy").click();
  for (const p of [bob, dan, erin]) {
    await expect(body(p)).toHaveAttribute("data-status", "terminated");
    await expect(body(p)).toHaveAttribute("data-end-reason", "destroyed_by_peer");
  }
});

test("when everyone else leaves, the creator waits in a room that is still alive", async ({
  browser,
}) => {
  const { everyone, invite } = await room(browser, 3);
  const [ana, bob, carol] = everyone as [Page, Page, Page];
  await bob.getByTestId("leave").click();
  await carol.close({ runBeforeUnload: true }); // closing the tab counts as leaving
  await expect(body(ana)).toHaveAttribute("data-status", "waiting");

  const dan = await person(browser);
  await dan.goto(invite);
  await expect(body(ana)).toHaveAttribute("data-status", "sealed");
  await expect(body(dan)).toHaveAttribute("data-status", "sealed");
});

test("a 2 MB file reaches everyone, byte for byte, verified on both ends", async ({ browser }) => {
  const { everyone } = await room(browser, 3);
  const [ana, bob, carol] = everyone as [Page, Page, Page];
  await expect(body(ana)).toHaveAttribute("data-files", "true");

  const bytes = randomBytes(2 * 1024 * 1024);
  const sha = createHash("sha256").update(bytes).digest("hex");
  await ana
    .getByTestId("file-input")
    .setInputFiles({ name: "big.bin", mimeType: "application/octet-stream", buffer: bytes });

  for (const p of [bob, carol]) {
    const item = p.locator('li[data-kind="file"]');
    await expect(item).toHaveAttribute("data-file-status", "received");
    const link = item.getByTestId("file-link");
    await expect(link).toHaveAttribute("download", "big.bin");
    // Hash what the page will hand to the user (the blob: URL), inside the page.
    const got = await link.evaluate(async (a: HTMLAnchorElement) => {
      const buf = await (await fetch(a.href)).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    });
    expect(got).toBe(sha);
  }
  const mine = ana.locator('li[data-kind="file"]');
  await expect(mine).toHaveAttribute("data-file-status", "delivered");
  await expect(mine.getByTestId("file-status")).toContainText("delivered to 2 of 2");

  // Chat still works alongside.
  await bob.getByTestId("message-input").fill("got it");
  await bob.getByTestId("send").click();
  await expect(
    ana.getByTestId("messages").locator('li[data-kind="text"][data-mine="false"]'),
  ).toHaveText([/got it$/]);
});
