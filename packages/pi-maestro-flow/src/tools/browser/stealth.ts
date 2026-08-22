/**
 * Stealth patches for launched Chromium instances.
 *
 * Goal: reduce the most common automated-browser fingerprints so headless
 * scraping (B-0.2) passes naive `navigator.webdriver` / plugins / chrome checks.
 * This is intentionally a light touch — it is NOT a counter to Cloudflare managed
 * challenges or advanced bot detection. For CAPTCHA / login-state scenarios, use
 * attach mode (B-0.1) to drive the user's real browser instead; stealth is never
 * injected into `connected` (attach/cdpUrl) tabs.
 *
 * `STEALTH_INIT_JS` is injected via `page.evaluateOnNewDocument`, so it runs
 * before any page script on every navigation. `STEALTH_LAUNCH_ARGS` are merged
 * into the puppeteer launch args.
 */

export const STEALTH_INIT_JS = `
(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  } catch (e) {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  } catch (e) {}
  try {
    const fakePlugin = Object.create(Plugin.prototype);
    Object.defineProperties(fakePlugin, {
      name: { value: 'Chrome PDF Plugin' },
      filename: { value: 'internal-pdf-viewer' },
      description: { value: 'Portable Document Format' },
    });
    const fakeArray = Object.create(PluginArray.prototype);
    Object.defineProperty(fakeArray, 'length', { get: () => 1 });
    Object.defineProperty(fakeArray, 0, { get: () => fakePlugin });
    Object.defineProperty(navigator, 'plugins', { get: () => fakeArray });
  } catch (e) {}
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
  } catch (e) {}
  try {
    const original = navigator.permissions && navigator.permissions.query;
    if (original) {
      navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus)
          : original.call(navigator.permissions, parameters);
    }
  } catch (e) {}
})();
`;

export const STEALTH_LAUNCH_ARGS: string[] = [
  "--disable-blink-features=AutomationControlled",
];
