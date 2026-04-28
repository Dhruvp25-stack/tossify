"""
Telegram Auto Settler for Tossify
────────────────────────────────────────────────────────────────
Scrapes toss results from @gaminghelperoffical on Telegram.
Matches results to active bets by team name + date.
Auto-settles matched bets via /api/auto-settle on the server.

Runs every 30 minutes via GitHub Actions.

Requirements:
    pip install telethon requests python-dotenv
"""

import asyncio
import re
import os
import json
import requests
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from telethon import TelegramClient
from telethon.tl.types import Message

# ─────────────────────────────────────────────
# 🔐 CREDENTIALS — set these as GitHub Secrets
# ─────────────────────────────────────────────
API_ID           = int(os.environ.get("TELEGRAM_API_ID",   "32469927"))
API_HASH         = os.environ.get("TELEGRAM_API_HASH",     "6344038b1786b9c267ca121ee732fd02")
PHONE            = os.environ.get("TELEGRAM_PHONE",        "+91XXXXXXXXXX")
SESSION_STRING   = os.environ.get("TELEGRAM_SESSION",      "")   # Telethon StringSession

# ─────────────────────────────────────────────
# 🌐 Tossify server
# ─────────────────────────────────────────────
SERVER_URL       = os.environ.get("NODE_SERVER_URL",   "https://tossify-oaqh.onrender.com")
SCRAPER_SECRET   = os.environ.get("SCRAPER_SECRET",    "my_new_scraper")

# ─────────────────────────────────────────────
# 🎯 Telegram channel
# ─────────────────────────────────────────────
CHANNEL_USERNAME = "gaminghelperoffical"
MESSAGE_LIMIT    = 100   # fetch last 100 messages (30-min window)

# ─────────────────────────────────────────────
# 🔧 Matching config
# ─────────────────────────────────────────────
NAME_SIMILARITY_THRESHOLD = 0.55   # how close team names need to be (0–1)


# ══════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════

def remove_emojis(text: str) -> str:
    emoji_pattern = re.compile(
        "["
        "\U00000000-\U00000008"
        "\U0000000B-\U0000001F"
        "\U0000007F-\U000000A0"
        "\U00002000-\U00002BFF"
        "\U00002C00-\U00002FFF"
        "\U00003000-\U00003FFF"
        "\U00004000-\U00004DFF"
        "\U00004E00-\U0000FFFF"
        "\U00010000-\U0010FFFF"
        "]+",
        flags=re.UNICODE
    )
    cleaned = emoji_pattern.sub(" ", text)
    cleaned = re.sub(r'[\uFE00-\uFE0F\u200B-\u200F\uFEFF]', '', cleaned)
    return cleaned


def parse_toss_message(msg_text: str, msg_date: datetime) -> dict | None:
    """
    Parses messages like:
      SOMERSET WON THE TOSS AND DECIDED TO BAT
    Returns: { winner_team, date_str }
    """
    if not msg_text:
        return None

    upper = msg_text.upper()
    if "WON THE TOSS AND DECIDED TO" not in upper:
        return None

    cleaned = remove_emojis(msg_text).upper()
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()

    pattern = r"([A-Z][A-Z0-9\s\-\{\}\(\)\.]+?)\s+WON THE TOSS AND DECIDED TO\s+(BAT|BOWL)"
    match = re.search(pattern, cleaned)
    if not match:
        return None

    team = match.group(1).strip().strip("-").strip()
    team = re.sub(r'\s{2,}', ' ', team).strip()

    # IST offset
    IST = timezone(timedelta(hours=5, minutes=30))
    msg_date_ist = msg_date.astimezone(IST)

    return {
        "winner_team": team,
        "date_str":    msg_date_ist.strftime("%Y-%m-%d"),
        "datetime":    msg_date_ist,
    }


def similarity(a: str, b: str) -> float:
    """String similarity ratio between 0 and 1."""
    return SequenceMatcher(None, a.upper().strip(), b.upper().strip()).ratio()


def find_best_match(winner_team: str, result_date: str, active_matches: list) -> dict | None:
    """
    Find the best matching active match for a toss result.
    Matches by:
      1. Team name similarity (teamA or teamB vs winner_team)
      2. Date proximity (match date == result date or within 1 day)
    Returns the match dict with an extra 'matched_team' key.
    """
    best       = None
    best_score = 0.0

    for m in active_matches:
        team_a = m.get("teamA", "")
        team_b = m.get("teamB", "")
        match_time = m.get("time", "")

        # Try to extract date from match time string
        match_date = None
        for fmt in ["%d %b %Y", "%d %b", "%Y-%m-%d", "%d/%m/%Y"]:
            try:
                parsed = datetime.strptime(match_time[:len(fmt)+2].strip(), fmt)
                if parsed.year == 1900:
                    parsed = parsed.replace(year=datetime.now().year)
                match_date = parsed.strftime("%Y-%m-%d")
                break
            except Exception:
                continue

        # Score: similarity to teamA or teamB
        score_a = similarity(winner_team, team_a)
        score_b = similarity(winner_team, team_b)
        top_score = max(score_a, score_b)
        matched_team = team_a if score_a >= score_b else team_b

        # Date bonus: if date matches, boost score
        if match_date:
            if match_date == result_date:
                top_score += 0.3
            elif abs((datetime.strptime(match_date, "%Y-%m-%d") -
                      datetime.strptime(result_date, "%Y-%m-%d")).days) <= 1:
                top_score += 0.1

        if top_score > best_score:
            best_score = top_score
            best       = {**m, "matched_team": matched_team, "match_score": top_score}

    if best and best["match_score"] >= NAME_SIMILARITY_THRESHOLD:
        return best
    return None


# ══════════════════════════════════════════════
# Server API calls
# ══════════════════════════════════════════════

def get_active_matches() -> list:
    """Fetch all unsettled matches from Tossify server."""
    try:
        r = requests.get(
            f"{SERVER_URL}/api/auto-settle/matches",
            headers={"x-scraper-key": SCRAPER_SECRET},
            timeout=15
        )
        data = r.json()
        if data.get("ok"):
            return data.get("matches", [])
        print(f"  ⚠️  Server returned error: {data.get('msg')}")
    except Exception as e:
        print(f"  ❌ Failed to fetch matches: {e}")
    return []


def auto_settle(match_id: str, winner_team: str, winner_raw: str) -> bool:
    """Call server to auto-settle a match."""
    try:
        r = requests.post(
            f"{SERVER_URL}/api/auto-settle",
            headers={
                "x-scraper-key": SCRAPER_SECRET,
                "Content-Type":  "application/json"
            },
            json={
                "matchId":    match_id,
                "winnerTeam": winner_team,
                "winnerRaw":  winner_raw,
            },
            timeout=15
        )
        data = r.json()
        if data.get("ok"):
            print(f"  ✅ Auto-settled match {match_id} → winner: {winner_team} ({data.get('settled',0)} bets)")
            return True
        else:
            print(f"  ⚠️  Auto-settle failed: {data.get('msg')}")
    except Exception as e:
        print(f"  ❌ Auto-settle request failed: {e}")
    return False


# ══════════════════════════════════════════════
# Main scraper
# ══════════════════════════════════════════════

async def scrape_and_settle():
    print(f"\n🚀 Telegram Auto Settler starting — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # ── Fetch active matches from server ──────
    active_matches = get_active_matches()
    print(f"📋 Active unsettled matches from server: {len(active_matches)}")
    if not active_matches:
        print("  Nothing to settle. Exiting.")
        return

    # ── Connect to Telegram ───────────────────
    from telethon.sessions import StringSession
    session = StringSession(SESSION_STRING) if SESSION_STRING else "tossify_settler_session"

    async with TelegramClient(session, API_ID, API_HASH) as client:
        if not SESSION_STRING:
            await client.start(phone=PHONE)
        print(f"✅ Telegram connected")

        # ── Fetch recent messages ─────────────
        results = []
        print(f"📡 Fetching last {MESSAGE_LIMIT} messages from @{CHANNEL_USERNAME} ...")
        async for message in client.iter_messages(CHANNEL_USERNAME, limit=MESSAGE_LIMIT):
            if not isinstance(message, Message):
                continue
            parsed = parse_toss_message(message.text or "", message.date)
            if parsed:
                results.append(parsed)
                print(f"  📨 Found: {parsed['winner_team']} on {parsed['date_str']}")

        print(f"\n🎯 Toss results found: {len(results)}")
        if not results:
            print("  No toss results in recent messages.")
            return

        # ── Match and settle ──────────────────
        settled_ids = set()
        for result in results:
            match = find_best_match(
                result["winner_team"],
                result["date_str"],
                [m for m in active_matches if m["id"] not in settled_ids]
            )
            if match:
                print(f"\n  🔗 Matched: '{result['winner_team']}' → {match['teamA']} vs {match['teamB']}")
                print(f"     Winner team in system: '{match['matched_team']}' (score: {match['match_score']:.2f})")
                ok = auto_settle(match["id"], match["matched_team"], result["winner_team"])
                if ok:
                    settled_ids.add(match["id"])
            else:
                print(f"\n  ❓ No match found for '{result['winner_team']}' on {result['date_str']}")

        print(f"\n✅ Done. Auto-settled {len(settled_ids)} match(es).")


def main():
    asyncio.run(scrape_and_settle())


if __name__ == "__main__":
    main()
