"""
scraper_once.py  -  Single-shot version for cron / GitHub Actions
Scrapes once, pushes to server, exits.
"""
import asyncio, json, os, re, requests, logging
from datetime import datetime
from playwright.async_api import async_playwright

BASE_URL        = "https://gaminghelperonline.com"
LIVE_URL        = "https://gaminghelperonline.com/live-bets"
SESSION_FILE    = "session.json"
OUTPUT_FILE     = "live_matches.json"
USERNAME        = "6356469306"
PASSWORD        = "Dhruvpatni@25"

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
    """Extract time from text - tries many patterns"""
    patterns = [
        r"(\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2}\s?[APMapm]{2})",
        r"(\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2})",
        r"(\d{1,2}\s+\w+\s+\d{1,2}:\d{2}\s?[APMapm]{2})",
        r"(\d{1,2}/\d{1,2}/\d{4}\s+\d{1,2}:\d{2}\s?[APMapm]{2})",
        r"(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s?[APMapm]{2})",
        r"(\d{1,2}:\d{2}\s?[APMapm]{2})",
        r"(\d{1,2}:\d{2})",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None

async def scrape(page):
    # Wait for page to fully load
    await page.wait_for_timeout(3000)

    # Try multiple selectors to get all match elements
    selectors = [
        "[class*='match']",
        "[class*='event']",
        "[class*='item']",
        "[class*='row']",
        "[class*='card']",
        "[class*='game']",
        "tr",
        "li",
    ]

    data, seen = [], set()

    for selector in selectors:
        try:
            rows = await page.query_selector_all(selector)
            for row in rows:
                try:
                    txt = (await row.inner_text()).strip()
                    if not txt or len(txt) < 5: continue
                    if "vs" not in txt.lower(): continue

                    # Extract match name (first line or the vs line)
                    lines = [x.strip() for x in txt.split("\n") if x.strip()]
                    # Find the vs line
                    match_line = None
                    for line in lines:
                        if " vs " in line.lower() or " v " in line.lower():
                            match_line = line
                            break
                    if not match_line:
                        match_line = lines[0]

                    # Clean up match name
                    match_name = re.sub(r'\s+', ' ', match_line).strip()
                    if match_name in seen: continue
                    if len(match_name) < 5: continue
                    seen.add(match_name)

                    # Get full text for time extraction
                    full = " | ".join(lines)
                    bet_time = get_datetime(full)

                    # Get logos
                    imgs = await row.query_selector_all("img")
                    logos = []
                    for img in imgs[:2]:
                        src = await img.get_attribute("src")
                        if src and not src.endswith('.svg') and 'icon' not in src.lower():
                            logos.append(src)

                    data.append({
                        "match": match_name,
                        "bet_closing_time": bet_time,
                        "logo1": logos[0] if logos else None,
                        "logo2": logos[1] if len(logos) > 1 else None
                    })
                except:
                    continue
        except:
            continue

        if len(data) >= 3:
            break  # Got enough from this selector

    # Deduplicate by team names
    final, seen_teams = [], set()
    for d in data:
        parts = re.split(r'\s+vs\s+|\s+v\s+', d['match'], flags=re.IGNORECASE)
        if len(parts) >= 2:
            key = f"{parts[0].strip().lower()}|{parts[1].strip().lower()}"
            if key not in seen_teams:
                seen_teams.add(key)
                final.append(d)
        else:
            final.append(d)

    return final

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = (await browser.new_context(storage_state=SESSION_FILE)
                   if os.path.exists(SESSION_FILE)
                   else await browser.new_context())
        page = await context.new_page()

        # Set longer timeout
        page.set_default_timeout(60000)

        await goto_safe(page, BASE_URL)
        if not await is_logged_in(page):
            await login(page, context)

        # Navigate to live bets
        try:
            await goto_safe(page, BASE_URL)
            await page.locator("a[href='/live-bets']").first.click()
            await page.wait_for_timeout(6000)
        except:
            await goto_safe(page, LIVE_URL)

        # Take screenshot for debugging
        try:
            await page.screenshot(path="debug_screenshot.png")
            log.info("Screenshot saved")
        except:
            pass

        # Log page content for debugging
        try:
            content = await page.content()
            log.info(f"Page length: {len(content)} chars")
        except:
            pass

        matches = await scrape(page)
        log.info(f"Scraped {len(matches)} matches: {[m['match'] for m in matches]}")

        payload = {
            "updated_at": datetime.now().isoformat(),
            "total_matches": len(matches),
            "matches": matches
        }
        with open(OUTPUT_FILE, "w") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

        push_to_server(payload)
        await browser.close()

asyncio.run(main())
