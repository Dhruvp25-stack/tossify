"""
scraper_once.py - Single-shot version for GitHub Actions cron
Uses the proven scraping logic, pushes result to Render server.
"""
import asyncio, json, os, re, requests, logging
from datetime import datetime
from playwright.async_api import async_playwright

BASE_URL     = "https://gaminghelperonline.com"
LIVE_URL     = "https://gaminghelperonline.com/live-bets"
SESSION_FILE = "session.json"
OUTPUT_FILE  = "live_matches.json"
USERNAME     = "6356469306"
PASSWORD     = "Dhruvpatni@25"

NODE_SERVER_URL = os.environ.get("NODE_SERVER_URL", "http://localhost:3000")
SCRAPER_SECRET  = os.environ.get("SCRAPER_SECRET", "my_new_scraper")

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger(__name__)


# ── Push to Render server ──────────────────────────────────────
def push_to_server(payload):
    try:
        r = requests.post(
            f"{NODE_SERVER_URL}/api/scraper/push",
            json=payload,
            headers={"x-scraper-key": SCRAPER_SECRET},
            timeout=15
        )
        log.info(f"Push result: {r.json()}")
    except Exception as e:
        log.error(f"Push error: {e}")


# ── Safe page load ─────────────────────────────────────────────
async def goto_safe(page, url):
    await page.goto(url, wait_until="domcontentloaded", timeout=60000)
    await page.wait_for_timeout(3000)


# ── Login check ───────────────────────────────────────────────
async def is_logged_in(page):
    try:
        login_btn = page.get_by_text("Login", exact=True).first
        await login_btn.wait_for(timeout=3000)
        return not await login_btn.is_visible()
    except:
        return True


# ── Login ─────────────────────────────────────────────────────
async def login(page, context):
    log.info("Logging in...")
    await goto_safe(page, BASE_URL)
    await page.get_by_text("Login", exact=True).first.click()
    await page.wait_for_timeout(2000)
    await page.get_by_placeholder("Phone No.").fill(USERNAME)
    await page.get_by_placeholder("Enter Password").fill(PASSWORD)
    await page.locator("button:has-text('Login')").last.click()
    await page.wait_for_timeout(7000)
    await context.storage_state(path=SESSION_FILE)
    log.info("Session saved")


# ── Open live bets page ────────────────────────────────────────
async def open_live(page):
    try:
        await goto_safe(page, BASE_URL)
        link = page.locator("a[href='/live-bets']").first
        await link.wait_for(timeout=5000)
        await link.click()
        await page.wait_for_timeout(5000)
    except:
        await goto_safe(page, LIVE_URL)


# ── Extract time from text ─────────────────────────────────────
def get_datetime(text):
    patterns = [
        r"(\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2}\s?[APMapm]{2})",
        r"(\d{1,2}\s+\w+\s+\d{1,2}:\d{2}\s?[APMapm]{2})",
        r"(\d{1,2}/\d{1,2}/\d{4}\s+\d{1,2}:\d{2}\s?[APMapm]{2})",
        r"(\d{1,2}:\d{2}\s?[APMapm]{2})",
        r"(\d{1,2}:\d{2})",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None


# ── Scrape matches ─────────────────────────────────────────────
async def scrape(page):
    rows = await page.query_selector_all("[class*='item'], [class*='row']")
    data, seen = [], set()

    for row in rows:
        try:
            txt = (await row.inner_text()).strip()
            if "vs" not in txt.lower():
                continue

            lines = [x.strip() for x in txt.split("\n") if x.strip()]
            if not lines:
                continue

            match = lines[0]
            if match in seen:
                continue
            seen.add(match)

            full = " | ".join(lines)

            imgs = await row.query_selector_all("img")
            logos = []
            for img in imgs[:2]:
                src = await img.get_attribute("src")
                if src:
                    logos.append(src)

            data.append({
                "match": match,
                "bet_closing_time": get_datetime(full),
                "logo1": logos[0] if len(logos) > 0 else None,
                "logo2": logos[1] if len(logos) > 1 else None
            })

        except:
            pass

    return data


# ── Main ──────────────────────────────────────────────────────
async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)

        context = (
            await browser.new_context(storage_state=SESSION_FILE)
            if os.path.exists(SESSION_FILE)
            else await browser.new_context()
        )

        page = await context.new_page()

        await goto_safe(page, BASE_URL)

        if await is_logged_in(page):
            log.info("Auto login successful")
        else:
            log.info("Session expired, logging in...")
            await login(page, context)

        await open_live(page)

        matches = await scrape(page)

        payload = {
            "updated_at": datetime.now().isoformat(),
            "total_matches": len(matches),
            "matches": matches
        }

        # Save to JSON file
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

        log.info(f"Scraped {len(matches)} matches")
        for m in matches:
            log.info(f"  🏟 {m['match']} | ⏰ {m['bet_closing_time']}")

        # Push to Render server
        push_to_server(payload)

        await browser.close()


asyncio.run(main())
