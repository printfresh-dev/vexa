import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { googleAuthJoinCtaSelectors } from './selectors';

// Mirrors waitForLobbyCta's ordered resolution: the first selector with a visible match wins.
async function resolveCta(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const element = page.locator(selector).first();
    if ((await element.count()) > 0 && (await element.isVisible())) {
      return (await element.textContent())?.trim() ?? '';
    }
  }
  return null;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    // Authenticated lobby Meet showed the bot on 2026-10-13 when nobody else was in the call:
    // Gemini's notes chip (a jsname button) comes before the CTA in DOM order.
    const emptyCallLobby = `
      <h1>Ready to join?</h1>
      <div><span>Use Gemini to take notes</span><button jsname="gemini"><span>Start</span></button></div>
      <button jsname="join"><span>Join anyway</span></button>
      <button jsname="other"><span>Other ways to join</span></button>`;
    await page.setContent(emptyCallLobby);

    assert.equal(await resolveCta(page, googleAuthJoinCtaSelectors), 'Join anyway',
      'the bot joins an empty call through "Join anyway"');
    const withoutJoinAnyway = googleAuthJoinCtaSelectors.filter(s => !s.includes('Join anyway'));
    assert.equal(await resolveCta(page, withoutJoinAnyway), 'Start',
      'without the label the structural backstop clicks Gemini\'s chip (the 2026-10-13 failure)');

    await page.setContent(emptyCallLobby.replace('Join anyway', 'Join now'));
    assert.equal(await resolveCta(page, googleAuthJoinCtaSelectors), 'Join now', 'the ordinary lobby is unchanged');
    console.log('Google authenticated-lobby CTA regression passed: "Join anyway" beats the Gemini chip.');
  } finally {
    await browser.close();
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
