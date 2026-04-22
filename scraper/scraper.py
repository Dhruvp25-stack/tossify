"""
Tossify Live Match Scraper
─────────────────────────
• Scrapes gaminghelperonline.com/live-bets every 15 seconds
• Pushes results to your Node.js server via POST /api/scraper/push
• Run this separately alongside your Node server

Install deps:
  pip install playwright requests
  playwright install chromium

Usage:
  python scraper.py

For production (Cloudflare Worker / Vercel Cron):
  - Deploy this script on a VPS or GitHub Actions schedule
  - Or use the GitHub Actions workflow in /scraper/github_action.yml
"""

import asyncio
import json
import os
import re
import time
import logging
import requests
from datetime import datetime
from playwright.async_api import async_playwright

# ── Config ────────────────────────────────────────────────────
BASE_URL        = "https://gaminghelperonline.com"
LIVE_URL        = "https://gaminghelperonline.com/live-bets"
SESSION_FILE    = "session.json"
OUTPUT_FILE     = "live_matches.json"

USERNAME        = "6356469306"
PASSWORD        = "Dhruvpatni@25"

HEADLESS        = True          # set False for debugging
REFRESH_SECONDS = 15

# Your Node.js server URL  (change in production)
NODE_SERVER_URL = "http://localhost:3000"
SCRAPER_SECRET  = "my_new_scraper"

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger(__name__)

# ── Push to server ────────────────────────────────────────────
def push_to_server(payload):
    try:
        r = requests.post(
            f"{NODE_SERVER_URL}/api/scraper/push",
            json=payload,
            headers={"x-scraper-key": SCRAPER_SECRET},
            timeout=10
        )
        data = r.json()
        if data.get("ok"):
            log.info(f"✅ Pushed {data.get('count',0)} matches to server")
        else:
            log.warning(f"⚠️  Server rejected push: {data}")
    except Exception as e:
        log.error(f"❌ Push failed: {e}")

# ── Playwright helpers ────────────────────────────────────────
async def goto_safe(page, url):
    await page.goto(url, wait_until="domcontentloaded", timeout=60000)
    await page.wait_for_timeout(4000)

async def is_logged_in(page):
    try:
        return not await page.get_by_text("Login", exact=True).first.is_visible(timeout=2000)
    except:
        return True

async def login(page, context):
    log.info("🔐 Logging in to gaminghelperonline.com ...")
    await goto_safe(page, BASE_URL)
    await page.get_by_text("Login", exact=True).first.click()
    await page.wait_for_timeout(2000)
    await page.get_by_placeholder("Phone No.").fill(USERNAME)
    await page.get_by_placeholder("Enter Password").fill(PASSWORD)
    await page.locator("button:has-text('Login')").last.click()
    await page.wait_for_timeout(6000)
    await context.storage_state(path=SESSION_FILE)
    log.info("💾 Session saved")

async def open_live(page):
    try:
        await goto_safe(page, BASE_URL)
        await page.locator("a[href='/live-bets']").first.click()
        await page.wait_for_timeout(5000)
    except:
        await goto_safe(page, LIVE_URL)

def get_datetime(text):
    m = re.search(r"(\d{1,2}\s+\w+\s+\d{1,2}:\d{2}\s?[APMapm]{2})", text)
    return m.group(1) if m else None

async def scrape(page):
    rows = await page.query_selector_all("[class*='item'], [class*='row']")
    data = []
    seen = set()
    for row in rows:
        txt = (await row.inner_text()).strip()
        if "vs" not in txt.lower():
            continue
        lines = [x.strip() for x in txt.split("\n") if x.strip()]
        match  = lines[0]
        if match in seen:
            continue
        seen.add(match)
        full  = " | ".join(lines)
        imgs  = await row.query_selector_all("img")
        logos = []
        for img in imgs[:2]:
            src = await img.get_attribute("src")
            if src:
                logos.append(src)
        data.append({
            "match":            match,
            "bet_closing_time": get_datetime(full),
            "logo1":            logos[0] if logos else None,
            "logo2":            logos[1] if len(logos) > 1 else None
        })
    return data

# ── Main loop ─────────────────────────────────────────────────
async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=HEADLESS)

        if os.path.exists(SESSION_FILE):
            context = await browser.new_context(storage_state=SESSION_FILE)
        else:
            context = await browser.new_context()

        page = await context.new_page()
        await goto_safe(page, BASE_URL)

        if not await is_logged_in(page):
            await login(page, context)
        else:
            log.info("✅ Already logged in")

        while True:
            try:
                await open_live(page)
                matches = await scrape(page)

                payload = {
                    "updated_at":    datetime.now().isoformat(),
                    "total_matches": len(matches),
                    "matches":       matches
                }

                # Save local JSON (backup)
                with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
                    json.dump(payload, f, indent=2, ensure_ascii=False)

                log.info(f"\n🏏 {len(matches)} LIVE MATCHES scraped")
                for m in matches:
                    log.info(f"  🏟️  {m['match']}  ⏰ {m['bet_closing_time']}")

                # Push to Tossify server → real-time broadcast to all users
                push_to_server(payload)

                await asyncio.sleep(REFRESH_SECONDS)

            except Exception as e:
                log.error(f"Loop error: {e}")
                await asyncio.sleep(30)  # wait before retry

if __name__ == "__main__":
    asyncio.run(main())
