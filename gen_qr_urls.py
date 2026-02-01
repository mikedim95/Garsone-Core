#!/usr/bin/env python3
"""
Generate Garsone QR tile public codes only (GT-XXXX-XXXX).

- Output: one GT code per line
- Default: generates 500 new codes per run
- Collision-safe across executions (checks existing file)
"""

import argparse
import os
import secrets
from typing import Set

OUT_FILE_DEFAULT = "qr_codes.txt"

# Crockford Base32 (no I, L, O, U)
CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def random_crockford(n_chars: int) -> str:
    n_bits = n_chars * 5
    value = secrets.randbits(n_bits)

    chars = []
    for _ in range(n_chars):
        chars.append(CROCKFORD32[value & 0b11111])
        value >>= 5

    return "".join(reversed(chars))


def format_gt(code8: str) -> str:
    return f"GT-{code8[:4]}-{code8[4:]}"


def load_existing(out_path: str) -> Set[str]:
    existing = set()
    if not os.path.exists(out_path):
        return existing

    with open(out_path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip().upper()
            if s.startswith("GT-") and len(s) == 11:
                existing.add(s)

    return existing


def generate(count: int, out_path: str) -> int:
    existing = load_existing(out_path)
    new_codes = []

    while len(new_codes) < count:
        code = format_gt(random_crockford(8))
        if code in existing:
            continue
        existing.add(code)
        new_codes.append(code)

    with open(out_path, "a", encoding="utf-8") as f:
        for code in new_codes:
            f.write(code + "\n")

    return len(new_codes)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-n", "--count", type=int, default=500)
    parser.add_argument("-o", "--out", type=str, default=OUT_FILE_DEFAULT)
    args = parser.parse_args()

    created = generate(args.count, args.out)
    print(f"Appended {created} GT codes to {args.out}")


if __name__ == "__main__":
    main()
