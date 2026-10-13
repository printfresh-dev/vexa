import { strict as assert } from 'assert';
import { chromium } from 'playwright';
import { checkForGoogleAdmissionIndicators, hasConsentPrompt } from './admission';

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const participant = '<div data-participant-id="participant-1" aria-label="Meeting participant">Meeting participant</div>';
    const runningNotes = '<div role="dialog"><h2>Gemini is taking notes</h2><div role="button">Stop taking notes</div></div>';
    const consent = '<div role="dialog"><h2>Taking notes</h2><p>Accept or decline before joining.</p><button>Accept</button><button>Decline</button></div>';
    // Copy and controls of the panel Meet showed the bot's own account on 2026-10-13.
    const notesOffer = '<div role="dialog"><h2>Remember what was discussed</h2><p>Gemini will take notes for you and share after the meeting.</p><label><input type="checkbox" checked>Also start transcription</label><button>Start taking notes (English)</button></div>';

    await page.setContent(participant + runningNotes);
    assert.equal(await hasConsentPrompt(page), false, 'an active-notes status popover is not a consent gate');
    assert.equal(await checkForGoogleAdmissionIndicators(page), true, 'an admitted participant must not stall behind the status popover');

    await page.setContent(participant + consent);
    assert.equal(await hasConsentPrompt(page), true, 'a real consent dialog still requires a human decision');
    assert.equal(await checkForGoogleAdmissionIndicators(page), false, 'visible participants do not bypass consent');

    await page.setContent(participant + runningNotes + consent);
    assert.equal(await hasConsentPrompt(page), true, 'a status popover must not hide a separate consent dialog');
    assert.equal(await checkForGoogleAdmissionIndicators(page), false, 'consent remains blocking beside an active-notes popover');

    await page.setContent(participant + notesOffer);
    assert.equal(await hasConsentPrompt(page), false, "Gemini's offer to the bot's own account is not a consent gate");
    assert.equal(await checkForGoogleAdmissionIndicators(page), true, 'an admitted participant must not stall behind the notes offer');

    await page.setContent(participant + notesOffer + consent);
    assert.equal(await hasConsentPrompt(page), true, 'the notes offer must not hide a separate consent dialog');
    assert.equal(await checkForGoogleAdmissionIndicators(page), false, 'consent remains blocking beside the notes offer');
    console.log('Google consent DOM regression passed: status popovers and notes offers admit; real consent remains blocking.');
  } finally {
    await browser.close();
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
