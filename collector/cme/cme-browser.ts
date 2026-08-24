import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Camoufox } from 'camoufox-js';

export const CME_LOGIN_URL = 'https://www.cmegroup.com/';
export const CME_VOL2VOL_URL = 'https://www.cmegroup.com/tools-information/quikstrike/vol2vol-expected-range.html';

export class CmeSessionError extends Error {
  constructor(message: string, readonly code: 'challenge' | 'reauth_required' | 'failed' = 'failed') {
    super(message);
    this.name = 'CmeSessionError';
  }
}

export interface CmeBrowserSession {
  browser: any;
  context: any;
  page: any;
  storagePath: string;
  saveStorageState(): Promise<void>;
  close(): Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function cmeStoragePath(): string {
  return path.resolve(process.env.CME_STORAGE_STATE_PATH ?? 'runtime/cme-storage-state.json');
}

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

export async function openCmeBrowser(): Promise<CmeBrowserSession> {
  const storagePath = cmeStoragePath();
  const hasStorage = await fileExists(storagePath);
  const browser = await Camoufox({
    headless: process.env.CME_HEADLESS !== 'false',
    timeout: Number(process.env.CME_BROWSER_TIMEOUT_MS ?? 90_000),
  });
  const context = typeof browser.newContext === 'function'
    ? await browser.newContext(hasStorage ? { storageState: storagePath } : {})
    : browser;
  const page = typeof context.newPage === 'function' ? await context.newPage() : await browser.newPage();

  return {
    browser,
    context,
    page,
    storagePath,
    async saveStorageState() {
      if (typeof context.storageState !== 'function') return;
      const state = await context.storageState();
      await mkdir(path.dirname(storagePath), { recursive: true });
      const temporaryPath = `${storagePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, storagePath);
    },
    async close() {
      await page.close?.().catch(() => undefined);
      if (page !== browser && typeof browser.close === 'function') await browser.close().catch(() => undefined);
    },
  };
}

async function pageText(page: any): Promise<string> {
  return String(await page.locator?.('body')?.innerText?.().catch(() => '') ?? '').toLowerCase();
}

const emailSelectors = [
  '#user',
  'input[name="email"]',
  'input[name="username"]',
  'input[name="loginfmt"]',
  'input[type="email"]',
  '#signInName',
];

const passwordSelectors = [
  'input[name="password"]',
  'input[type="password"]',
  '#password',
];

async function hasVisibleLoginForm(page: any): Promise<boolean> {
  return Boolean(await page.evaluate?.(({ email, password }: { email: string[]; password: string[] }) => {
    const doc = (globalThis as any).document as any;
    const getComputedStyle = (globalThis as any).getComputedStyle as (element: any) => any;
    const isVisible = (element: any) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    };
    const firstVisible = (selectors: string[]) => selectors
      .map((selector) => doc.querySelector(selector))
      .find((element) => isVisible(element));
    return Boolean(firstVisible(email) && firstVisible(password));
  }, { email: emailSelectors, password: passwordSelectors }).catch(() => false));
}

export async function hasCmeChallenge(page: any): Promise<boolean> {
  const body = await pageText(page);
  const url = String(page.url?.() ?? '').toLowerCase();
  return /captcha|robot|verify|one-time|mfa|multi-factor|security code|challenge/.test(`${url} ${body}`);
}

export async function isCmeLoginPage(page: any): Promise<boolean> {
  const url = String(page.url?.() ?? '').toLowerCase();
  if (url.includes('login.cmegroup.com') || url.includes('/sso/login')) return true;
  return hasVisibleLoginForm(page);
}

async function isAuthenticated(page: any): Promise<boolean> {
  if (await isCmeLoginPage(page) || await hasCmeChallenge(page)) return false;
  const body = await pageText(page);
  return /log out|logout|my account|my profile|sign out|quikstrike/.test(body);
}

async function clickCmeLoginAndFindPage(session: CmeBrowserSession): Promise<any> {
  const { page, context } = session;
  const pagesBefore = new Set<any>(await context.pages?.().catch(() => []) ?? []);
  let clicked = false;

  try {
    const loginButton = page.getByRole?.('button', { name: /^log in$/i }).first?.();
    if (loginButton && await loginButton.count?.()) {
      await loginButton.click({ timeout: 15_000 });
      clicked = true;
    }
  } catch {
    // Fall back to a DOM click for older Camoufox locator implementations.
  }

  if (!clicked) {
    clicked = Boolean(await page.evaluate?.(() => {
      const doc = (globalThis as any).document as any;
      const getComputedStyle = (globalThis as any).getComputedStyle as (element: any) => any;
      const isVisible = (element: any) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
      };
      const candidates = Array.from(doc.querySelectorAll('button, a')) as any[];
      const loginButton = candidates.find((element) => isVisible(element) && /^\s*log in\s*$/i.test(element.textContent ?? '')) as any;
      loginButton?.click();
      return Boolean(loginButton);
    }).catch(() => false));
  }

  if (!clicked) return page;

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pages = await context.pages?.().catch(() => []) ?? [];
    const candidates = [...new Set<any>([page, ...pages])];
    const popup = candidates.find((candidate) => !pagesBefore.has(candidate));
    if (popup && (await isCmeLoginPage(popup) || await hasVisibleLoginForm(popup))) return popup;
    if (await isCmeLoginPage(page) || await hasVisibleLoginForm(page)) return page;
    await sleep(500);
  }
  return page;
}

async function fillLoginForm(page: any, email: string, password: string): Promise<boolean> {
  return Boolean(await page.evaluate(({ emailValue, passwordValue, email, password }: { emailValue: string; passwordValue: string; email: string[]; password: string[] }) => {
    const doc = (globalThis as any).document as any;
    const isVisible = (element: any) => {
      if (!element) return false;
      const style = (globalThis as any).getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    };
    const firstVisible = (selectors: string[]) => selectors.map((selector) => doc.querySelector(selector)).find(isVisible);
    const emailInput = firstVisible(email) as any;
    const passwordInput = firstVisible(password) as any;
    if (!emailInput || !passwordInput) return false;
    if (emailInput) {
      emailInput.value = emailValue;
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (passwordInput) {
      passwordInput.value = passwordValue;
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const submit = Array.from(doc.querySelectorAll('button[type="submit"], input[type="submit"], #login-button'))
      .find(isVisible) as any;
    if (submit) submit.click();
    else passwordInput.form?.requestSubmit?.();
    return true;
  }, { emailValue: email, passwordValue: password, email: emailSelectors, password: passwordSelectors }).catch(() => false));
}

export async function ensureCmeAuthenticated(session: CmeBrowserSession): Promise<void> {
  const { page } = session;
  await page.goto(CME_VOL2VOL_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(5_000);
  if (await isAuthenticated(page)) {
    await session.saveStorageState();
    return;
  }
  if (await hasCmeChallenge(page)) {
    throw new CmeSessionError('CME presented a login challenge; manual completion is required', 'challenge');
  }

  const email = process.env.CME_EMAIL;
  const password = process.env.CME_PASSWORD;
  if (!email || !password) {
    throw new CmeSessionError('Saved CME session is invalid; CME_EMAIL/CME_PASSWORD are required for re-login', 'reauth_required');
  }

  await page.goto(CME_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(3_000);
  const loginPage = await clickCmeLoginAndFindPage(session);
  const formDeadline = Date.now() + 30_000;
  while (!(await hasVisibleLoginForm(loginPage)) && Date.now() < formDeadline) {
    if (await hasCmeChallenge(loginPage)) {
      throw new CmeSessionError('CME presented MFA/CAPTCHA; complete it manually and rerun auth', 'challenge');
    }
    await sleep(1_000);
  }
  if (!(await fillLoginForm(loginPage, email, password))) {
    throw new CmeSessionError('CME login form did not appear after opening Log In', 'reauth_required');
  }
  const deadline = Date.now() + Number(process.env.CME_LOGIN_TIMEOUT_MS ?? 300_000);
  while (Date.now() < deadline) {
    await sleep(5_000);
    if (await isAuthenticated(loginPage)) break;
    if (await hasCmeChallenge(loginPage)) {
      throw new CmeSessionError('CME presented MFA/CAPTCHA; complete it manually and rerun auth', 'challenge');
    }
  }
  if (!(await isAuthenticated(loginPage))) {
    throw new CmeSessionError('Automated CME login timed out', 'reauth_required');
  }
  await loginPage.goto(CME_VOL2VOL_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await sleep(8_000);
  if (!(await isAuthenticated(loginPage))) {
    throw new CmeSessionError('CME login completed but Vol2Vol access could not be verified', 'failed');
  }
  await session.saveStorageState();
}

export async function pageFetch<T>(page: any, url: string, init: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(async ({ fetchUrl, fetchInit }: { fetchUrl: string; fetchInit: Record<string, unknown> }) => {
    const response = await fetch(fetchUrl, fetchInit as RequestInit);
    if (!response.ok) throw new Error(`CME request failed (${response.status}): ${fetchUrl}`);
    return response.json();
  }, { fetchUrl: url, fetchInit: init });
}
