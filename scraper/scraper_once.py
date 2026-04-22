"""
scraper_once.py  –  Single-shot version for cron / GitHub Actions
Scrapes once, pushes to server, exits.
"""
import asyncio, json, os, re, requests, logging
from datetime import datetime
from playwright.async_api import async_playwright

BASE_URL       = "https://gaminghelperonline.com"
LIVE_URL       = "https://gaminghelperonline.com/live-bets"
SESSION_FILE   = "session.json"
OUTPUT_FILE    = "live_matches.json"
USERNAME       = "6356469306"
PASSWORD       = "Dhruvpatni@25"

# These are read from GitHub Secrets — must match server.js exactly
NODE_SERVER_URL = os.environ.get("NODE_SERVER_URL", "http://localhost:3000")
SCRAPER_SECRET  = os.environ.get("SCRAPER_SECRET",  "my_new_scraper")

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger(__name__)

def push_to_server(payload):
    try:
        r = requests.post(f"{NODE_SERVER_URL}/api/scraper/push", json=payload,
            headers={"x-scraper-key": SCRAPER_SECRET}, timeout=15)
        d = r.json()
        log.info(f"Push result: {d}")
    except Exception as e:
        log.error(f"Push error: {e}")

async def goto_safe(page, url):
    await page.goto(url, wait_until="domcontentloaded", timeout=60000)
    await page.wait_for_timeout(4000)

async def is_logged_in(page):
    try:
        return not await page.get_by_text("Login", exact=True).first.is_visible(timeout=2000)
    except:
        return True

async def login(page, context):
    await goto_safe(page, BASE_URL)
    await page.get_by_text("Login", exact=True).first.click()
    await page.wait_for_timeout(2000)
    await page.get_by_placeholder("Phone No.").fill(USERNAME)
    await page.get_by_placeholder("Enter Password").fill(PASSWORD)
    await page.locator("button:has-text('Login')").last.click()
    await page.wait_for_timeout(6000)
    await context.storage_state(path=SESSION_FILE)

def get_datetime(text):
    m = re.search(r"(\d{1,2}\s+\w+\s+\d{1,2}:\d{2}\s?[APMapm]{2})", text)
    return m.group(1) if m else None

async def scrape(page):
    rows = await page.query_selector_all("[class*='item'], [class*='row']")
    data, seen = [], set()
    for row in rows:
        txt = (await row.inner_text()).strip()
        if "vs" not in txt.lower(): continue
        lines = [x.strip() for x in txt.split("\n") if x.strip()]
        match = lines[0]
        if match in seen: continue
        seen.add(match)
        full = " | ".join(lines)
        imgs = await row.query_selector_all("img")
        logos = []
        for img in imgs[:2]:
            src = await img.get_attribute("src")
            if src: logos.append(src)
        data.append({"match": match, "bet_closing_time": get_datetime(full),
            "logo1": logos[0] if logos else None, "logo2": logos[1] if len(logos)>1 else None})
    return data

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = (await browser.new_context(storage_state=SESSION_FILE)
                   if os.path.exists(SESSION_FILE)
                   else await browser.new_context())
        page = await context.new_page()
        await goto_safe(page, BASE_URL)
        if not await is_logged_in(page):
            await login(page, context)
        try:
            await goto_safe(page, BASE_URL)
            await page.locator("a[href='/live-bets']").first.click()
            await page.wait_for_timeout(5000)
        except:
            await goto_safe(page, LIVE_URL)
        matches = await scrape(page)
        payload = {"updated_at": datetime.now().isoformat(), "total_matches": len(matches), "matches": matches}
        with open(OUTPUT_FILE, "w") as f: json.dump(payload, f, indent=2, ensure_ascii=False)
        log.info(f"Scraped {len(matches)} matches")
        push_to_server(payload)
        await browser.close()

asyncio.run(main())
