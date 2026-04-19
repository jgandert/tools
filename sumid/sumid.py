import hashlib
import secrets
import time

SORTED_ALPHABET = '467ACDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'
BASE = len(SORTED_ALPHABET)
CHAR_TO_INDEX = {ch: i for i, ch in enumerate(SORTED_ALPHABET)}

# Tolerant decode: map visually ambiguous characters to their canonical form
TOLERANT_MAP = {'5': 'S', '2': 'Z', '9': 'g', '3': 'E'}
for _alias, _canonical in TOLERANT_MAP.items():
    CHAR_TO_INDEX[_alias] = CHAR_TO_INDEX[_canonical]


def int_to_sum_id_base(n: int) -> str:
    if n < 0:
        raise ValueError("n must be non-negative")
    if n == 0:
        return SORTED_ALPHABET[0]
    out = []
    while n:
        n, rem = divmod(n, BASE)
        out.append(SORTED_ALPHABET[rem])
    return "".join(reversed(out))


MIN_SUM_ID = int_to_sum_id_base(0)
MAX_SUM_ID_INT = (1 << 256) - 1
MAX_SUM_ID = int_to_sum_id_base(MAX_SUM_ID_INT)


def sum_id_base_to_int(s: str) -> int:
    if not s:
        raise ValueError("empty string")
    val = 0
    for ch in s:
        try:
            idx = CHAR_TO_INDEX[ch]
        except KeyError:
            raise ValueError(f"invalid character: {ch!r}")
        val = val * BASE + idx
    return val


def is_valid_sum_id(s: str) -> bool:
    try:
        val = sum_id_base_to_int(s)
    except ValueError:
        return False
    if not (0 <= val <= MAX_SUM_ID_INT):
        return False
    # Reject non-canonical forms (leading zero-chars or tolerant aliases)
    return int_to_sum_id_base(val) == s


def sum_id() -> str:
    """
    Generates a 256-bit base-50-encoded sequential UUID using the nanoseconds
    since the Epoch. Unless you're generating trillions of IDs in the same
    nanosecond, collisions are negligible.

    sum_id = Sequential Universally-Unique & Mergeable ID

    :return: a 256-bit universally unique identifier using
      * 96 most significant bits (12 bytes) for the time to achieve sequential ordering
      * 160 random bits (20 bytes) to reduce the chance of any conflicts
    """
    time_bits = time.time_ns()
    rand_bits = secrets.randbits(160)
    return int_to_sum_id_base((time_bits << 160) + rand_bits)


def random_time_bits() -> int:
    return secrets.randbits(96)


def _str_to_rand_bits(text: str) -> int:
    encoded_text = text.encode('utf-8')

    # digest_size is in bytes (so 8 bit * 20 = 160)
    return int.from_bytes(hashlib.blake2b(encoded_text, digest_size=20).digest())


def sum_id_from_time_ns_and_str_seed(time_ns: int, seed: str) -> str:
    """
    :param time_ns: must be at most 96 bits long
    :param seed: any kind of string
    :return: a sum_id
    """
    return int_to_sum_id_base((time_ns << 160) + _str_to_rand_bits(seed))


def get_time_ns_from_sum_id(sum_id: int) -> int:
    return sum_id >> 160


_MERGE_OVERFLOW_BITS = 18  # extra time precision borrowed from entropy
_MERGE_RAND_BITS = 160 - _MERGE_OVERFLOW_BITS  # 142 random bits (> UUID v4's 122)
_MAX_TIME_96 = (1 << 96) - 1
_RAND_160_MASK = (1 << 160) - 1

# --- Logarithmic scaling helpers (integer-only, using fixed-point log2) ---

_LOG_FRAC_BITS = 16
_LOG_FRAC_MASK = (1 << _LOG_FRAC_BITS) - 1


def _fixed_log2(x: int) -> int:
    """Fixed-point log2 with _LOG_FRAC_BITS fractional bits.  x must be >= 1."""
    k = x.bit_length() - 1  # floor(log2(x))
    if k >= _LOG_FRAC_BITS:
        frac = (x >> (k - _LOG_FRAC_BITS)) & _LOG_FRAC_MASK
    else:
        frac = (x << (_LOG_FRAC_BITS - k)) & _LOG_FRAC_MASK
    return (k << _LOG_FRAC_BITS) + frac


def _inverse_fixed_log2(v: int) -> int:
    """Inverse of _fixed_log2.  Returns approximate x such that _fixed_log2(x) ≈ v."""
    if v <= 0:
        return 1
    k = v >> _LOG_FRAC_BITS
    frac = v & _LOG_FRAC_MASK
    if k >= _LOG_FRAC_BITS:
        return (1 << k) | (frac << (k - _LOG_FRAC_BITS))
    else:
        return (1 << k) | (frac >> (_LOG_FRAC_BITS - k))


def _log_scale(value: int, max_value: int, total_slots: int) -> int:
    """Map value from [0, max_value] → [0, total_slots] with log compression."""
    if value <= 0 or max_value <= 0:
        return 0
    log_val = _fixed_log2(1 + value)
    log_max = _fixed_log2(1 + max_value)
    if log_max == 0:
        return 0
    return min(log_val * total_slots // log_max, total_slots)


def _log_unscale(position: int, max_value: int, total_slots: int) -> int:
    """Inverse of _log_scale.  Recovers approximate value from position."""
    if position <= 0 or max_value <= 0 or total_slots <= 0:
        return 0
    log_max = _fixed_log2(1 + max_value)
    log_val = position * log_max // total_slots
    return max(0, _inverse_fixed_log2(log_val) - 1)


def merge_two_sum_ids(sum_id_a: str, sum_id_b: str) -> str:
    """
    Merge two sum_ids into one that sorts between them.

    The merged time is mapped into the range (lo_time, hi_time) based on when
    the merge occurs, using logarithmic compression so that merges soon after
    creation get far more resolution than merges in the distant future.
    18 overflow bits from the entropy section provide sub-slot precision so that
    repeated merges of the same pair sort chronologically.  The remaining 142
    random bits still exceed UUID v4's 122.
    """
    a = sum_id_base_to_int(sum_id_a)
    b = sum_id_base_to_int(sum_id_b)

    a_time = a >> 160
    b_time = b >> 160

    lo_time, hi_time = (a_time, b_time) if a_time <= b_time else (b_time, a_time)

    now = time.time_ns()
    merge_offset = max(0, now - hi_time)
    future_range = _MAX_TIME_96 - hi_time

    available = hi_time - lo_time
    if available >= 2:
        # leave a 1-slot gap on each side so the merge never equals a parent
        available -= 2

        max_scaled = (available << _MERGE_OVERFLOW_BITS) | ((1 << _MERGE_OVERFLOW_BITS) - 1)
        scaled = _log_scale(merge_offset, future_range, max_scaled)

        merged_time = lo_time + 1 + (scaled >> _MERGE_OVERFLOW_BITS)
        overflow = scaled & ((1 << _MERGE_OVERFLOW_BITS) - 1)
    else:
        # parents too close together — average the time, encode merge time in overflow only
        merged_time = (lo_time + hi_time) // 2
        max_overflow = (1 << _MERGE_OVERFLOW_BITS) - 1
        overflow = _log_scale(merge_offset, future_range, max_overflow)

    rand_bits = (overflow << _MERGE_RAND_BITS) | secrets.randbits(_MERGE_RAND_BITS)

    return int_to_sum_id_base((merged_time << 160) + rand_bits)


def extract_merge_time_ns(sum_id_a: str, sum_id_b: str, merged: str) -> int:
    """
    Recover the approximate wall-clock time (in nanoseconds) at which
    merge_two_sum_ids(a, b) was called, given the two parents and the result.

    This is the inverse of the logarithmic mapping in merge_two_sum_ids.
    """
    a_time = sum_id_base_to_int(sum_id_a) >> 160
    b_time = sum_id_base_to_int(sum_id_b) >> 160
    lo_time, hi_time = (a_time, b_time) if a_time <= b_time else (b_time, a_time)

    m = sum_id_base_to_int(merged)
    merged_time = m >> 160
    entropy = m & _RAND_160_MASK
    overflow = entropy >> _MERGE_RAND_BITS

    future_range = _MAX_TIME_96 - hi_time

    available = hi_time - lo_time
    if not (lo_time <= merged_time <= hi_time):
        raise ValueError("merged ID's time is not between the two parents")
    if available >= 2:
        available -= 2
        max_scaled = (available << _MERGE_OVERFLOW_BITS) | ((1 << _MERGE_OVERFLOW_BITS) - 1)
        scaled = ((merged_time - lo_time - 1) << _MERGE_OVERFLOW_BITS) + overflow
        scaled = min(scaled, max_scaled)
        merge_offset = _log_unscale(scaled, future_range, max_scaled)
    else:
        max_overflow = (1 << _MERGE_OVERFLOW_BITS) - 1
        merge_offset = _log_unscale(overflow, future_range, max_overflow)

    return hi_time + merge_offset


def _time_ns_to_iso(ns: int) -> str:
    from datetime import datetime, timezone
    seconds = ns // 1_000_000_000
    frac_ns = ns % 1_000_000_000
    dt = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S') + f'.{frac_ns:09d}Z'


def _sum_id_iso(s: str) -> str:
    return _time_ns_to_iso(sum_id_base_to_int(s) >> 160)


if __name__ == '__main__':
    print(f"min: '{MIN_SUM_ID}' and max: '{MAX_SUM_ID}'")
    print()
    NANOSECONDS_PER_YEAR = int(365.2425 * 24 * 60 * 60 * 1_000_000_000)
    x = NANOSECONDS_PER_YEAR * 14_000_004_000 * 2
    print("24 billion years requires about", x.bit_length(), "bits")


    def show(label, sid):
        print(f"  {label}: {sid}  ({_sum_id_iso(sid)})")


    m1 = sum_id()
    m1_int = sum_id_base_to_int(m1)
    print(m1, m1_int, bin(m1_int), m1_int.bit_length(), sep=' ' * 4)

    m2 = sum_id()
    print()
    show('m1', m1)
    show('m2', m2)
    print()
    print(is_valid_sum_id(m1))
    print(is_valid_sum_id(m2))
    print(is_valid_sum_id('M'))
    print(is_valid_sum_id('milk'))
    print()


    def show_merged():
        print("# merging two IDs")
        mm = merge_two_sum_ids(m1, m2)

        show('m1', m1)
        show('mm', mm)
        show('m2', m2)

        extracted = extract_merge_time_ns(m1, m2, mm)
        print(f"  merge wall-clock (extracted): {_time_ns_to_iso(extracted)}")

        print(f"  sorted: {sorted([(m1, 'm1'), (mm, 'mm'), (m2, 'm2')])}")
        print()


    show_merged()
    show_merged()
