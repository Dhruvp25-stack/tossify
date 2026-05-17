"""
Telegram Auto Settler for Tossify
────────────────────────────────────────────────────────────────
Scrapes toss results from @gaminghelperoffical on Telegram.
Matches results to active bets by team name + date.
Auto-settles matched bets via /api/auto-settle on the server.

Handles ALL Telegram message patterns:
  BANGLADESH - W WON THE TOSS AND DECIDED TO BOWL
  LANCASHIRE - 18 WON THE TOSS AND DECIDED TO BOWL
  ZAKIR COLLEGE WON THE TOSS DECIDED TO BAT        ← no "AND"
  SUSSEX 2ND WON THE TOSS AND DECIDED TO BOWL
  KARTARPURA WON THE TOSS AND DECIDED TO BAT
  ITALY - W WON THE TOSS AND DECIDED TO BOWL

Runs every 30 minutes via GitHub Actions.

Requirements:
    pip install telethon requests
"""

import asyncio
import re
import os
import requests
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from telethon import TelegramClient
from telethon.tl.types import Message
from telethon.sessions import StringSession

# ─────────────────────────────────────────────
# 🔐 CREDENTIALS — set as GitHub Secrets
# ─────────────────────────────────────────────
API_ID         = int(os.environ.get("TELEGRAM_API_ID",  "32469927"))
API_HASH       = os.environ.get("TELEGRAM_API_HASH",    "6344038b1786b9c267ca121ee732fd02")
SESSION_STRING = os.environ.get("TELEGRAM_SESSION",     "")

# ─────────────────────────────────────────────
# 🌐 Tossify server
# ─────────────────────────────────────────────
SERVER_URL     = os.environ.get("NODE_SERVER_URL",  "https://tossify-oaqh.onrender.com")
SCRAPER_SECRET = os.environ.get("SCRAPER_SECRET",   "my_new_scraper")

# ─────────────────────────────────────────────
# 🎯 Telegram channel
# ─────────────────────────────────────────────
CHANNEL_USERNAME = "gaminghelperoffical"
MESSAGE_LIMIT    = 100   # last 100 messages covers 30-min window

# ─────────────────────────────────────────────
# 🔧 Matching config
# ─────────────────────────────────────────────
NAME_SIMILARITY_THRESHOLD = 0.50   # lowered slightly for partial name matches


# ══════════════════════════════════════════════
# Text helpers
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
    Handles ALL Telegram toss result patterns including:
    - "WON THE TOSS AND DECIDED TO BAT/BOWL"
    - "WON THE TOSS DECIDED TO BAT/BOWL"      (no AND)
    - "WON THE TOSS AND DECIDED BAT/BOWL"     (no TO)
    - "WON THE TOSS DECIDED BAT/BOWL"         (no AND, no TO)
    - Team suffixes: - W, - 18, 2ND, XI etc.
    """
    if not msg_text:
        return None

    upper = msg_text.upper()

    # Must contain WON THE TOSS
    if "WON THE TOSS" not in upper:
        return None

    # Must mention BAT or BOWL after TOSS
    toss_idx  = upper.find("WON THE TOSS")
    after     = upper[toss_idx:]
    if "BAT" not in after and "BOWL" not in after:
        return None

    cleaned = remove_emojis(msg_text).upper()
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()

    # Flexible regex covering all observed patterns
    pattern = (
        r"([A-Z][A-Z0-9\s\-\.\/\&\']+?)"   # team name
        r"\s+WON THE TOSS"
        r"(?:\s+AND)?"                       # optional AND
        r"(?:\s+DECIDED)?"                   # optional DECIDED
        r"(?:\s+TO)?"                        # optional TO
        r"\s+(BAT|BOWL)"                     # result
    )
    m = re.search(pattern, cleaned)
    if not m:
        return None

    team     = m.group(1).strip().strip('-').strip()
    decision = m.group(2).strip()
    team     = re.sub(r'\s{2,}', ' ', team).strip()

    # IST
    IST          = timezone(timedelta(hours=5, minutes=30))
    msg_date_ist = msg_date.astimezone(IST)

    return {
        "winner_team": team,
        "decision":    decision,
        "date_str":    msg_date_ist.strftime("%Y-%m-%d"),
        "datetime":    msg_date_ist,
    }


# ══════════════════════════════════════════════
# Smart team name matching
# ══════════════════════════════════════════════

def clean_team_name(name: str) -> str:
    """
    Normalize team name for matching.
    Removes common suffixes: - W, - 18, 2ND, XI, FC, CC, U19 etc.
    """
    name = name.upper().strip()
    name = re.sub(r'\s*-\s*(W|B|A|XI|2ND|1ST|3RD|18|19|U19|U16|U23|WOMEN|MEN)\s*$', '', name)
    name = re.sub(r'\s+(2ND|1ST|3RD|XI|FC|CC|SC|AC|BC|U19|U16|U23|WOMEN|MEN)\s*$', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def team_similarity(tg_team: str, sys_team: str) -> float:
    """
    Multi-strategy similarity between Telegram team name and system team name.
    Returns best score from all strategies.
    """
    tg_raw    = tg_team.upper().strip()
    sys_raw   = sys_team.upper().strip()
    tg_clean  = clean_team_name(tg_team)
    sys_clean = clean_team_name(sys_team)

    def ratio(a, b):
        return SequenceMatcher(None, a, b).ratio()

    scores = [
        ratio(tg_raw,   sys_raw),    # raw vs raw
        ratio(tg_clean, sys_clean),  # cleaned vs cleaned
        ratio(tg_clean, sys_raw),    # cleaned tg vs raw sys
        ratio(tg_raw,   sys_clean),  # raw tg vs cleaned sys
    ]

    # Substring bonus: one fully contains the other
    if tg_clean in sys_clean or sys_clean in tg_clean:
        scores.append(0.88)

    # Word overlap bonus
    tg_words  = set(tg_clean.split())
    sys_words = set(sys_clean.split())
    if tg_words and sys_words:
        overlap = len(tg_words & sys_words) / max(len(tg_words), len(sys_words))
        scores.append(overlap * 0.90)

    return max(scores)


def find_best_match(winner_team: str, result_date: str, active_matches: list) -> dict | None:
    """
    Find best matching active match for a toss result.
    Uses team name similarity + date proximity scoring.
    """
    best       = None
    best_score = 0.0

    for m in active_matches:
        team_a     = m.get("teamA", "")
        team_b     = m.get("teamB", "")
        match_time = m.get("time", "")

        # Try to extract date from match time string
        match_date = None
        for fmt in ["%d %b %Y", "%d %b", "%Y-%m-%d", "%d/%m/%Y", "%d %B %Y", "%d %B"]:
            try:
                s      = match_time[:len(fmt) + 4].strip()
                parsed = datetime.strptime(s, fmt)
                if parsed.year == 1900:
                    parsed = parsed.replace(year=datetime.now().year)
                match_date = parsed.strftime("%Y-%m-%d")
                break
            except Exception:
                continue

        # Score vs both teams
        score_a      = team_similarity(winner_team, team_a)
        score_b      = team_similarity(winner_team, team_b)
        top_score    = max(score_a, score_b)
        matched_team = team_a if score_a >= score_b else team_b

        # Date bonus
        if match_date:
            if match_date == result_date:
                top_score += 0.25
            else:
                try:
                    diff = abs((
                        datetime.strptime(match_date,  "%Y-%m-%d") -
                        datetime.strptime(result_date, "%Y-%m-%d")
                    ).days)
                    if diff == 1:
                        top_score += 0.10
                except Exception:
                    pass

        if top_score > best_score:
            best_score = top_score
            best       = {**m, "matched_team": matched_team, "match_score": round(top_score, 3)}

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
            timeout=20
        )
        data = r.json()
        if data.get("ok"):
            return data.get("matches", [])
        print(f"  ⚠️  Server error: {data.get('msg')}")
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
            timeout=20
        )
        data = r.json()
        if data.get("ok"):
            print(f"  ✅ Settled match {match_id} → {winner_team} ({data.get('settled', 0)} bets settled)")
            return True
        else:
            print(f"  ⚠️  Settle failed: {data.get('msg')}")
    except Exception as e:
        print(f"  ❌ Settle request error: {e}")
    return False


# ══════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════

async def scrape_and_settle():
    print(f"\n🚀 Tossify Telegram Auto Settler — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # Fetch active matches
    active_matches = get_active_matches()
    print(f"📋 Unsettled matches on server: {len(active_matches)}")
    if not active_matches:
        print("  Nothing to settle. Exiting.")
        return

    # Connect Telegram
    session = StringSession(SESSION_STRING) if SESSION_STRING else "tossify_settler_session"
    async with TelegramClient(session, API_ID, API_HASH) as client:
        print("✅ Telegram connected")

        # Fetch recent messages
        results = []
        print(f"📡 Fetching last {MESSAGE_LIMIT} messages from @{CHANNEL_USERNAME} ...")
        async for message in client.iter_messages(CHANNEL_USERNAME, limit=MESSAGE_LIMIT):
            if not isinstance(message, Message):
                continue
            parsed = parse_toss_message(message.text or "", message.date)
            if parsed:
                results.append(parsed)
                print(f"  📨 {parsed['winner_team']} — {parsed['decision']} [{parsed['date_str']}]")

        print(f"\n🎯 Toss results found: {len(results)}")
        if not results:
            print("  No toss results in recent messages.")
            return

        # Match and settle
        settled_ids = set()
        for result in results:
            remaining = [m for m in active_matches if m["id"] not in settled_ids]
            match = find_best_match(result["winner_team"], result["date_str"], remaining)

            if match:
                print(f"\n  🔗 '{result['winner_team']}' → {match['teamA']} vs {match['teamB']}")
                print(f"     Winner: '{match['matched_team']}' (score: {match['match_score']})")
                ok = auto_settle(match["id"], match["matched_team"], result["winner_team"])
                if ok:
                    settled_ids.add(match["id"])
            else:
                print(f"\n  ❓ No match found for '{result['winner_team']}' on {result['date_str']}")

        print(f"\n✅ Done. Auto-settled {len(settled_ids)} match(es) this run.")


def main():
    asyncio.run(scrape_and_settle())


if __name__ == "__main__":
    main()
