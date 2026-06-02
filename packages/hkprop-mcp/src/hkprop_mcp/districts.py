"""HK district code lookup table for 28Hse URLs.

28Hse encodes district as a path segment ``dg{NN}`` after the property type.
The full list was harvested from 28Hse's district selector. Codes are stable
(don't change between sessions).

Pattern: ``https://www.28hse.com/en/rent/a3/dg{code}[/page-N]``

The three top-level regions also have codes used in the path:
  - ``a1`` -> Hong Kong Island
  - ``a2`` -> Kowloon
  - ``a3`` -> New Territories (includes Tuen Mun, Yuen Long, etc.)

Example target districts (New Territories):
  - Tuen Mun (dg48)
  - Yuen Long (dg47)
  - Tin Shui Wai (dg49)
  - (also Tsuen Wan dg44 / Tung Chung dg54)
"""

from __future__ import annotations

# region code -> (en_name, zh_name)
REGIONS: dict[str, tuple[str, str]] = {
    "a1": ("Hong Kong Island", "港島"),
    "a2": ("Kowloon", "九龍"),
    "a3": ("New Territories", "新界"),
    "a4": ("Outlying Islands", "離島"),
}

# district code -> (region_code, en_name, zh_name)
DISTRICTS: dict[str, tuple[str, str, str]] = {
    # ---------- Hong Kong Island (a1) ----------
    "dg1": ("a1", "Central", "中環"),
    "dg2": ("a1", "Admiralty", "金鐘"),
    "dg3": ("a1", "Sheung Wan", "上環"),
    "dg4": ("a1", "Sai Ying Pun", "西營盤"),
    "dg5": ("a1", "Shek Tong Tsui", "石塘咀"),
    "dg6": ("a1", "Kennedy Town", "堅尼地城"),
    "dg7": ("a1", "Mid-Levels", "半山"),
    "dg8": ("a1", "The Peak", "山頂"),
    "dg9": ("a1", "Pok Fu Lam", "薄扶林"),
    "dg10": ("a1", "Aberdeen", "香港仔"),
    "dg11": ("a1", "Ap Lei Chau", "鴨脷洲"),
    "dg12": ("a1", "Wan Chai", "灣仔"),
    "dg13": ("a1", "Causeway Bay", "銅鑼灣"),
    "dg14": ("a1", "Happy Valley", "跑馬地"),
    "dg15": ("a1", "Tin Hau", "天后"),
    "dg16": ("a1", "Tai Hang", "大坑"),
    "dg17": ("a1", "North Point", "北角"),
    "dg18": ("a1", "Quarry Bay", "鰂魚涌"),
    "dg19": ("a1", "Tai Koo", "太古"),
    "dg20": ("a1", "Sai Wan Ho", "西灣河"),
    "dg21": ("a1", "Shau Kei Wan", "筲箕灣"),
    "dg22": ("a1", "Chai Wan", "柴灣"),
    "dg23": ("a1", "Heng Fa Chuen", "杏花邨"),
    "dg24": ("a1", "Stanley", "赤柱"),
    "dg25": ("a1", "Repulse Bay", "淺水灣"),
    # ---------- Kowloon (a2) ----------
    "dg26": ("a2", "Tsim Sha Tsui", "尖沙咀"),
    "dg27": ("a2", "Jordan", "佐敦"),
    "dg28": ("a2", "Yau Ma Tei", "油麻地"),
    "dg29": ("a2", "Mong Kok", "旺角"),
    "dg30": ("a2", "Prince Edward", "太子"),
    "dg31": ("a2", "Sham Shui Po", "深水埗"),
    "dg32": ("a2", "Cheung Sha Wan", "長沙灣"),
    "dg33": ("a2", "Lai Chi Kok", "荔枝角"),
    "dg34": ("a2", "Mei Foo", "美孚"),
    "dg35": ("a2", "Olympic", "奧運"),
    "dg36": ("a2", "Tai Kok Tsui", "大角咀"),
    "dg37": ("a2", "Ho Man Tin", "何文田"),
    "dg38": ("a2", "Kowloon Tong", "九龍塘"),
    "dg39": ("a2", "Kowloon City", "九龍城"),
    "dg40": ("a2", "To Kwa Wan", "土瓜灣"),
    "dg41": ("a2", "Hung Hom", "紅磡"),
    "dg42": ("a2", "Whampoa", "黃埔"),
    "dg43": ("a2", "Kwun Tong", "觀塘"),
    # ---------- New Territories (a3) ----------
    "dg44": ("a3", "Tsuen Wan", "荃灣"),
    "dg45": ("a3", "Kwai Chung", "葵涌"),
    "dg46": ("a3", "Tsing Yi", "青衣"),
    "dg47": ("a3", "Yuen Long", "元朗"),
    "dg48": ("a3", "Tuen Mun", "屯門"),
    "dg49": ("a3", "Tin Shui Wai", "天水圍"),
    "dg50": ("a3", "Sheung Shui", "上水"),
    "dg51": ("a3", "Fanling", "粉嶺"),
    "dg52": ("a3", "Tai Po", "大埔"),
    "dg53": ("a3", "Sha Tin", "沙田"),
    "dg55": ("a3", "Ma On Shan", "馬鞍山"),
    "dg56": ("a3", "Tseung Kwan O", "將軍澳"),
    "dg57": ("a3", "Sai Kung", "西貢"),
    "dg58": ("a3", "Clear Water Bay", "清水灣"),
    # ---------- Outlying Islands (a4) ----------
    "dg54": ("a4", "Tung Chung", "東涌"),
    "dg59": ("a4", "Discovery Bay", "愉景灣"),
    "dg60": ("a4", "Cheung Chau", "長洲"),
    "dg61": ("a4", "Lamma Island", "南丫島"),
    "dg62": ("a4", "Mui Wo", "梅窩"),
}

# Building / property type codes
PROPERTY_TYPES: dict[str, tuple[str, str]] = {
    "apartment": ("apartment", "私人住宅 / 屋苑"),
    "village": ("village house", "村屋"),
    "serviced": ("serviced apartment", "服務式住宅"),
    "office": ("office", "寫字樓"),
    "shop": ("shop", "舖位"),
    "industrial": ("industrial", "工商"),
    "carpark": ("carpark", "車位"),
}


def find_district(query: str) -> tuple[str, str, str] | None:
    """Look up a district by English or Chinese name (case-insensitive).

    Returns (code, en_name, zh_name) or None.
    """
    q = query.strip().lower()
    if not q:
        return None
    for code, (_region, en, zh) in DISTRICTS.items():
        if en.lower() == q or zh == query.strip():
            return code, en, zh
    # Loose match (substring)
    for code, (_region, en, zh) in DISTRICTS.items():
        if q in en.lower() or query.strip() in zh:
            return code, en, zh
    return None


def list_all() -> list[dict[str, str]]:
    """Return all districts as a list of dicts for the MCP resource."""
    return [
        {
            "code": code,
            "region_code": region,
            "region_en": REGIONS[region][0],
            "region_zh": REGIONS[region][1],
            "name_en": en,
            "name_zh": zh,
        }
        for code, (region, en, zh) in DISTRICTS.items()
    ]
