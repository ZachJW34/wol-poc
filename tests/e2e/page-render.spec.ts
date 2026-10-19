import { expect, test } from "@playwright/test";

test("the built page renders at a 390px mobile viewport", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);

  const rawHtml = await response?.text();
  expect(rawHtml).toContain('<div id="app"></div>');

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Wake-on-LAN devices",
  );
  const app = page.locator("#app");
  await expect(app.locator("main")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the test harness returns 404 for a missing asset", async ({ page }) => {
  const response = await page.request.get("/missing-asset.js");
  expect(response.status()).toBe(404);
});
