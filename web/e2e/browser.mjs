// Launch Chromium for tests and screenshots without downloading anything: CHROMIUM_PATH if set,
// else Playwright's own browser, else the newest headless shell already in Playwright's cache.
import { chromium } from 'playwright';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function cached() {
  for (const dir of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(dir)) continue;
    for (const shell of readdirSync(dir).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse()) {
      for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64', 'chrome-linux']) {
        for (const binary of ['chrome-headless-shell', 'headless_shell']) {
          const path = join(dir, shell, arch, binary);
          if (existsSync(path)) return path;
        }
      }
    }
  }
  return undefined;
}

export function launch() {
  if (process.env.CHROMIUM_PATH) return chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  return existsSync(chromium.executablePath()) ? chromium.launch() : chromium.launch({ executablePath: cached() });
}
