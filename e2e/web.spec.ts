import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** A fake GitHub API for live lookups of live/repo. Everything else fails. */
async function fakeGitHub(page: Page, opts: { rateLimited?: boolean } = {}) {
  await page.route("https://api.github.com/**", async (route) => {
    const u = new URL(route.request().url());
    if (opts.rateLimited && !route.request().headers().authorization) {
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1200), "x-ratelimit-limit": "60", "access-control-expose-headers": "x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-limit" },
        body: JSON.stringify({ message: "API rate limit exceeded" }),
      });
    }
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (u.pathname === "/repos/live/repo") return json({ full_name: "live/repo", html_url: "https://github.com/live/repo", description: "Live <b>repo</b>", stargazers_count: 42, default_branch: "main", language: "Go", archived: false, fork: false });
    if (u.pathname === "/repos/live/repo/commits") {
      if (u.searchParams.get("page") !== "1") return json([]);
      return json([
        { sha: "aaaaaaa1", html_url: "https://github.com/live/repo/commit/aaaaaaa1", commit: { message: "feat: x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>", author: { name: "d", email: "d@x", date: new Date().toISOString() }, committer: { name: "d", email: "d@x", date: new Date().toISOString() } }, author: { login: "d" }, committer: { login: "d" }, parents: [{}] },
        { sha: "bbbbbbb2", html_url: "javascript:alert(1)", commit: { message: "fix: y", author: { name: "d", email: "d@x", date: new Date().toISOString() }, committer: { name: "d", email: "d@x", date: new Date().toISOString() } }, author: { login: "d" }, committer: { login: "d" }, parents: [{}] },
      ]);
    }
    if (u.pathname === "/repos/live/repo/pulls") return json([]);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Not Found" }) });
  });
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}

test.describe("web app (#11)", () => {
  test.beforeEach(async ({ page }) => fakeGitHub(page));

  test("search goes to the repo page and shows the stored report", async ({ page }) => {
    await page.goto("");
    await page.getByRole("searchbox").or(page.locator("#q")).fill("https://github.com/demo/alpha");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/howmuchai\/r\/demo\/alpha\/$/);
    await expect(page.locator("h1")).toHaveText("demo/alpha");
    await expect(page.locator(".big")).toHaveText("75%");
    await expect(page.getByText("measure live")).toBeVisible();
  });

  test("rejects input that is not a repository", async ({ page }) => {
    await page.goto("");
    await page.locator("#q").fill("not a repo");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "owner/repo" })).toBeVisible();
    await expect(page).toHaveURL(/\/howmuchai\/$/);
  });

  test("measures an untracked repo live against the API", async ({ page }) => {
    await page.goto("r/live/repo/");
    await expect(page.locator("h1")).toHaveText("live/repo");
    await expect(page.locator(".big")).toHaveText("50%");
    await expect(page.getByText("Cursor").first()).toBeVisible();
    await page.getByText("Put the badge or card in your README").click();
    await expect(page.getByText("Ask to track it")).toBeVisible();
  });

  test("renders hostile text as text and never links outside GitHub", async ({ page }) => {
    await page.goto("r/demo/xss/");
    await expect(page.locator("h1")).toHaveText("demo/xss");
    await page.getByText(/^Evidence/).click();
    await expect(page.locator(".evidence li").first()).toContainText("<img src=x");
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await page.goto("r/live/repo/?live");
    await expect(page.locator(".big")).toHaveText("50%");
    const hrefs = await page.locator("main a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
    for (const h of hrefs) expect(h.startsWith("javascript:")).toBe(false);
  });

  test("filters the leaderboard", async ({ page }) => {
    await page.goto("leaderboard/");
    await expect(page.locator("table.lb tbody tr")).toHaveCount(3);
    await page.getByLabel("Filter repositories").fill("beta");
    await expect(page.locator("table.lb tbody tr")).toHaveCount(1);
    await expect(page.locator("table.lb tbody")).toContainText("demo/beta");
    await page.getByRole("button", { name: "Most stars" }).click();
    await expect(page.getByRole("button", { name: "Most stars" })).toHaveAttribute("aria-pressed", "true");
  });

  test("keyboard only: tab to the search, type, enter", async ({ page }) => {
    await page.goto("");
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.id === "q")) break;
    }
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("q");
    await page.keyboard.type("demo/beta");
    await page.keyboard.press("Enter");
    await expect(page.locator("h1")).toHaveText("demo/beta");
  });

  for (const path of ["", "leaderboard/", "method/", "r/demo/alpha/"]) {
    test(`has no serious accessibility violations: /${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await axe(page);
    });
  }
});

test("explains the rate limit and recovers with a token (#11)", async ({ page }) => {
  await fakeGitHub(page, { rateLimited: true });
  await page.goto("r/live/repo/");
  await expect(page.getByRole("alert")).toContainText("60 API requests per hour");
  await page.getByText("Use a GitHub token").click();
  await page.getByLabel("GitHub token").fill("github_pat_test");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("h1")).toHaveText("live/repo");
  await expect(page.locator(".big")).toHaveText("50%");
});
