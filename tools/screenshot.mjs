#!/usr/bin/env node
// Renders the tab strip with trapezoid-tabs.css in a throwaway headless
// Firefox profile and saves a PNG, so you can check the CSS still works after
// a Firefox update without touching your real profile. The stylesheet is
// installed with ./apply.sh --profile, so this exercises the installer too.
//
//   node tools/screenshot.mjs [--theme default|light|dark] [--crowded]
//                             [--out FILE] [--scale N] [--firefox PATH] [--keep]
//
// --crowded opens enough tabs to overflow the strip and adds a tab group.
//
// Drives Firefox over Marionette (its built-in remote protocol), no extra
// dependencies. On macOS, pass the .app bundle; it's started through open(1)
// because a Firefox spawned as our child can be refused access to its own
// support folder by macOS privacy controls ("Could not find profile folder").

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { values: opts } = parseArgs({
  options: {
    theme: { type: "string", default: "default" },
    crowded: { type: "boolean", default: false },
    out: { type: "string" },
    scale: { type: "string", default: "2" },
    firefox: {
      type: "string",
      default:
        process.platform === "darwin"
          ? "/Applications/Firefox.app"
          : "firefox",
    },
    keep: { type: "boolean", default: false },
  },
});
const out = resolve(opts.out ?? join(repo, "screenshots", `${opts.theme}${opts.crowded ? "-crowded" : ""}.png`));

const port = 20000 + Math.floor(Math.random() * 20000);
const profile = mkdtempSync(join(tmpdir(), "trapezoid-tabs-"));
const prefs = {
  "marionette.port": port,
  "layout.css.devPixelsPerPx": opts.scale,
  "browser.shell.checkDefaultBrowser": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "browser.startup.page": 0,
  "browser.aboutwelcome.enabled": false,
  "browser.newtabpage.enabled": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  "app.update.disabledForTesting": true,
};
writeFileSync(
  join(profile, "user.js"),
  Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`)
    .join(""),
);
execFileSync(join(repo, "apply.sh"), ["--profile", profile], { stdio: "inherit" });

const ffArgs = ["--headless", "--marionette", "-remote-allow-system-access", "--no-remote", "--profile", profile];
// Headless window size is in device pixels; aim for a 1000x100 CSS-pixel window.
const ffEnv = { MOZ_HEADLESS_WIDTH: String(1000 * opts.scale), MOZ_HEADLESS_HEIGHT: String(100 * opts.scale) };
const firefox = opts.firefox.endsWith(".app")
  ? spawn("open", ["-n", "-g", "-a", opts.firefox,
                   ...Object.entries(ffEnv).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
                   "--args", ...ffArgs], { stdio: "ignore" })
  : spawn(opts.firefox, ffArgs, { env: { ...process.env, ...ffEnv }, stdio: "ignore" });

class Marionette {
  #buf = Buffer.alloc(0);
  #waiters = [];
  #id = 0;

  constructor(sock) {
    this.sock = sock;
    sock.on("data", (d) => {
      this.#buf = Buffer.concat([this.#buf, d]);
      this.#drain();
    });
  }

  // Messages are framed as "<byte length>:<json>".
  #drain() {
    for (;;) {
      const colon = this.#buf.indexOf(":");
      if (colon < 0) return;
      const len = Number(this.#buf.subarray(0, colon).toString());
      if (this.#buf.length < colon + 1 + len) return;
      const msg = JSON.parse(this.#buf.subarray(colon + 1, colon + 1 + len).toString());
      this.#buf = this.#buf.subarray(colon + 1 + len);
      this.#waiters.shift()?.(msg);
    }
  }

  next() {
    return new Promise((r) => this.#waiters.push(r));
  }

  async send(name, params = {}) {
    const body = JSON.stringify([0, ++this.#id, name, params]);
    const reply = this.next();
    this.sock.write(`${Buffer.byteLength(body)}:${body}`);
    const [, , error, result] = await reply;
    if (error) throw new Error(`${name}: ${error.error}: ${error.message}`);
    return result;
  }
}

async function connect() {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const sock = await new Promise((ok, fail) => {
        const s = net.connect(port, "127.0.0.1", () => ok(s));
        s.once("error", fail);
      });
      const m = new Marionette(sock);
      await m.next(); // hello
      return m;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`Marionette never came up on port ${port}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

// Runs in the browser window's chrome scope.
const setup = `
const [theme, crowded] = arguments;
return (async () => {
  if (theme !== "default") {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID("firefox-compact-" + theme + "@mozilla.org");
    await addon.enable();
  }
  const principal = Services.scriptSecurityManager.getSystemPrincipal();
  const titles = ["Mozilla", "Wikipedia, the free encyclopedia", "Hacker News",
                  "GitHub: Let's build from here", "YouTube"];
  for (const title of titles) {
    gBrowser.addTab("data:text/html," + encodeURIComponent("<title>" + title + "</title>"),
                    { triggeringPrincipal: principal });
  }
  if (crowded) {
    for (let i = 1; i <= 30; i++) {
      gBrowser.addTab("data:text/html," + encodeURIComponent("<title>Tab " + i + "</title>"),
                      { triggeringPrincipal: principal });
    }
    gBrowser.addTabGroup([gBrowser.tabs[7], gBrowser.tabs[8]], { label: "Group", color: "blue" });
  }
  gBrowser.pinTab(gBrowser.tabs[1]);
  const grouped = crowded && gBrowser.tabs.find((t) => t.group);
  for (const tab of gBrowser.tabs) {
    try { gBrowser.setIcon(tab, "chrome://branding/content/icon32.png"); } catch {}
  }
  gBrowser.selectedTab = grouped || gBrowser.tabs[3];
  await new Promise((r) => setTimeout(r, 2000));

  const root = getComputedStyle(document.documentElement);
  const bg = getComputedStyle(gBrowser.selectedTab.querySelector(".tab-background"));
  return {
    firefox: Services.appinfo.version,
    nativeTheme: matchMedia("(-moz-native-theme)").matches,
    toolbarBackground: root.getPropertyValue("--toolbar-background-color"),
    toolboxBackground: root.getPropertyValue("--toolbox-background-color"),
    tabMasked: bg.maskImage !== "none",
    tabHeight: gBrowser.selectedTab.querySelector(".tab-stack").getBoundingClientRect().height,
    siblingIndex: CSS.supports("z-index", "calc(100 - sibling-index())"),
  };
})();
`;

let marionette;
try {
  marionette = await connect();
  await marionette.send("WebDriver:NewSession", {});
  await marionette.send("Marionette:SetContext", { value: "chrome" });
  const { value: info } = await marionette.send("WebDriver:ExecuteScript", {
    script: setup,
    args: [opts.theme, opts.crowded],
  });
  console.log(JSON.stringify(info, null, 2));
  const { value: png } = await marionette.send("WebDriver:TakeScreenshot", { full: false, hash: false });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(png, "base64"));
  console.log(`Saved ${out}`);
} finally {
  try {
    await marionette?.send("Marionette:Quit", { flags: ["eForceQuit"] });
  } catch {}
  marionette?.sock.destroy();
  firefox.kill();
  // open(1) exits right away, so also stop whatever is still running on our
  // profile, and wait for it to let go before deleting the profile.
  for (let i = 0; i < 40; i++) {
    try {
      execFileSync("pkill", ["-f", profile], { stdio: "ignore" });
    } catch {
      break; // pkill exits 1 once nothing matches
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (opts.keep) console.log(`Profile kept at ${profile}`);
  else rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
