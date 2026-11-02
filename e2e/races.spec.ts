import { expect, test } from "@playwright/test";

// No test talks to GitHub: every API call fails unless a test routes it.
test.beforeEach(async ({ page }) => {
  await page.route("https://api.github.com/**", (r) => r.fulfill({ status: 503, body: "{}" }));
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function navigate(page: import("@playwright/test").Page, path: string) {
  await page.evaluate((p) => {
    history.pushState(null, "", `/howmuchai/${p}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("a slow report cannot overwrite the page the user went to next (#10)", async ({ page }) => {
  await page.route("**/data/repos/demo/alpha.json", async (route) => {
    await delay(1500);
    await route.continue();
  });
  await page.goto("r/demo/alpha/");
  await navigate(page, "r/demo/beta/");
  await expect(page.locator("h1")).toHaveText("demo/beta");
  await delay(2000);
  await expect(page.locator("h1")).toHaveText("demo/beta");
  await expect(page).toHaveTitle(/demo\/beta/);
});

test("a slow failure cannot replace a later report (#10)", async ({ page }) => {
  await page.route("**/data/repos/demo/missing.json", async (route) => {
    await delay(1200);
    await route.fulfill({ status: 404, body: "" });
  });
  await page.goto("r/demo/missing/");
  await navigate(page, "r/demo/beta/");
  await expect(page.locator("h1")).toHaveText("demo/beta");
  await delay(2500);
  await expect(page.locator(".error")).toHaveCount(0);
  await expect(page.locator("h1")).toHaveText("demo/beta");
});

test("a slow leaderboard cannot replace a report (#10)", async ({ page }) => {
  await page.route("**/data/leaderboard.json", async (route) => {
    await delay(1500);
    await route.continue();
  });
  await page.goto("leaderboard/");
  await navigate(page, "r/demo/alpha/");
  await expect(page.locator("h1")).toHaveText("demo/alpha");
  await delay(2000);
  await expect(page.locator("h1")).toHaveText("demo/alpha");
});

test("back and forward show the right report (#10)", async ({ page }) => {
  await page.goto("r/demo/alpha/");
  await expect(page.locator("h1")).toHaveText("demo/alpha");
  await navigate(page, "r/demo/beta/");
  await expect(page.locator("h1")).toHaveText("demo/beta");
  await page.goBack();
  await expect(page.locator("h1")).toHaveText("demo/alpha");
  await page.goForward();
  await expect(page.locator("h1")).toHaveText("demo/beta");
});
