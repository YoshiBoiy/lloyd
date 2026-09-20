"""Privacy-safe case-match hints (TDD v2 §5.4).

Hints are derived from the *sanitized* blocks only, are limited to the closed
SafeMatchHints schema, and are omitted whenever the evidence is ambiguous.
Nothing here may emit names, addresses, identifiers, raw values or hashes of them.
"""
import re

STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
}
STATE_NAMES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME",
    "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
    "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
    "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", "tennessee": "TN",
    "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY",
}
STATE_LABEL = re.compile(r"(?im)\b(?:primary\s+)?(?:risk\s+)?state\s*[:=]\s*([A-Za-z .]{2,20})\b")
YEAR_LABEL = re.compile(r"(?im)\b(?:year\s+built|construction\s+year|built\s+in)\s*[:=]?\s*((?:19|20)\d{2})\b")
TIV_LABEL = re.compile(r"(?im)\b(?:tiv|total\s+insured\s+value)\s*[:=]?\s*\$?\s*([\d,]{4,})")


def risk_state(text: str) -> str | None:
    found = set()
    for match in STATE_LABEL.finditer(text):
        raw = match.group(1).strip()
        code = raw.upper() if len(raw) == 2 else STATE_NAMES.get(raw.lower())
        if code in STATES:
            found.add(code)
    # Ambiguous evidence stays local; a single unambiguous state is generalizable.
    return next(iter(found)) if len(found) == 1 else None


def year_range(text: str) -> list[int] | None:
    years = sorted({int(m.group(1)) for m in YEAR_LABEL.finditer(text)})
    if not years:
        return None
    decade = years[0] // 10 * 10
    return [decade, decade + 9]


def tiv_bucket(text: str) -> str | None:
    values = []
    for match in TIV_LABEL.finditer(text):
        try:
            values.append(int(match.group(1).replace(",", "")))
        except ValueError:
            continue
    if not values:
        return None
    value = max(values)
    if value < 1_000_000:
        return "lt_1m"
    if value < 10_000_000:
        return "1m_10m"
    if value < 100_000_000:
        return "10m_100m"
    return "gte_100m"


def build_hints(sanitized_blocks: list[str], classification: dict) -> dict:
    """Return only schema-allowed hints. `documentType` always mirrors the classification
    so the backend can reject any disagreement."""
    text = "\n".join(sanitized_blocks)
    hints: dict = {"documentType": classification["documentType"]}
    state = risk_state(text)
    if state:
        hints["riskState"] = state
    lob = classification.get("attributes", {}).get("lineOfBusiness", "unknown")
    if lob in {"property", "casualty", "mixed"}:
        hints["lineOfBusiness"] = lob
    years = year_range(text)
    if years:
        hints["yearRange"] = years
    bucket = tiv_bucket(text)
    if bucket:
        hints["tivBucket"] = bucket
    return hints
