#!/usr/bin/env python3
"""
Phase 0 analyser for a Glow display local MQTT capture.

Capture (one line per message):
  mosquitto_sub -h <homey-ip> -p 1883 [-u USER -P PASS] -t 'glow/#' -F '%I %t %p' > glow-capture.log

Run:
  python3 analyse_glow_capture.py glow-capture.log

Prints a summary that is safe to paste into chat: MPAN, MPRN, EUI, supplier and unit IDs are
masked. Standard library only; works with the python3 that ships with macOS.
"""
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

POWER_NO_READING = -8388.608
CUM_NO_READING = {281474976710655.0, 281474976710.655}
MAX_KW = 30.0           # electricity plausibility, kW
MAX_GAS_M3_PER_H = 10.0  # gas plausibility, m3/h
LOCAL = None             # filled from the first arrival time's offset


def mask(s):
    s = str(s or "")
    return ("…" + s[-4:]) if len(s) > 4 else s


def parse_time(s):
    """Accepts 2026-10-25T15:42:01+0100, +01:00, Z, or no offset (treated as UTC)."""
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    m = re.match(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}):?(\d{2})?$", s)
    if m:
        base = datetime.strptime(m.group(1).replace(" ", "T"), "%Y-%m-%dT%H:%M:%S")
        if m.group(3):
            sign = 1 if m.group(3)[0] == "+" else -1
            off = timedelta(hours=int(m.group(3)[1:]), minutes=int(m.group(4) or 0)) * sign
            return base.replace(tzinfo=timezone(off))
        return base.replace(tzinfo=timezone.utc)
    m = re.match(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})$", s)
    if m:
        return datetime.strptime(m.group(1).replace(" ", "T"), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    return None


def loc(dt):
    return dt.astimezone(LOCAL).strftime("%d %b %H:%M:%S") if dt else "?"


def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def gaps_summary(times):
    if len(times) < 2:
        return "n/a"
    gaps = [(b - a).total_seconds() for a, b in zip(times, times[1:])]
    return f"median {statistics.median(gaps):.0f}s, max {max(gaps):.0f}s"


def main(path):
    global LOCAL
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    issues = defaultdict(list)          # rule -> examples
    by_kind = defaultdict(list)         # (unit, kind) -> [(arrival, payload_dict)]
    unparsed = 0

    for n, line in enumerate(lines, 1):
        if not line.strip():
            continue
        parts = line.split(" ", 2)
        if len(parts) < 3:
            unparsed += 1
            continue
        arrival = parse_time(parts[0])
        topic, payload = parts[1], parts[2]
        if arrival is None:
            unparsed += 1
            continue
        if LOCAL is None:
            LOCAL = arrival.tzinfo
        seg = topic.split("/")
        if len(seg) < 3:
            continue
        unit = seg[1].upper().replace(":", "")
        kind = seg[-1] if seg[2] == "SENSOR" else seg[2]
        try:
            data = json.loads(payload)
        except ValueError:
            issues["1 invalid JSON"].append(f"line {n} {loc(arrival)} {topic}")
            continue
        by_kind[(unit, kind)].append((arrival, data))

    if not by_kind:
        print("No glow messages found. Check the topic prefix and the capture format (-F '%I %t %p').")
        return

    all_arrivals = [a for v in by_kind.values() for a, _ in v]
    print("== Capture ==")
    print(f"{len(lines)} lines, {unparsed} unparseable, {loc(min(all_arrivals))} → {loc(max(all_arrivals))}"
          f" ({(max(all_arrivals) - min(all_arrivals)).total_seconds() / 3600:.1f} h)")
    units = sorted({u for u, _ in by_kind})
    for u in units:
        print(f"Unit {mask(u)}: " + ", ".join(f"{k} {len(v)} msgs ({gaps_summary([a for a, _ in v])})"
                                              for (uu, k), v in sorted(by_kind.items()) if uu == u))

    for (unit, kind), msgs in sorted(by_kind.items()):
        print(f"\n== {mask(unit)} {kind} ==")
        if kind == "STATE":
            state(msgs)
        elif kind in ("electricitymeter", "gasmeter"):
            meter(kind, msgs, issues)
        else:
            print(f"{len(msgs)} messages on an unexpected topic")

    print("\n== Validation rule hits (what the app would reject) ==")
    if not issues:
        print("None")
    for rule in sorted(issues):
        ex = issues[rule]
        print(f"{rule}: {len(ex)}")
        for e in ex[:5]:
            print(f"    {e}")


def state(msgs):
    han = Counter()
    rssi, lqi = [], []
    sw, hw, smets = set(), set(), set()
    changes = []
    prev = None
    for a, d in msgs:
        h = d.get("han") or {}
        s = h.get("status")
        han[s] += 1
        if s != prev and prev is not None:
            changes.append(f"{loc(a)} {prev} → {s}")
        prev = s
        if num(h.get("rssi")):
            rssi.append(h["rssi"])
        if num(h.get("lqi")):
            lqi.append(h["lqi"])
        sw.add(d.get("software"))
        hw.add(d.get("hardware"))
        smets.add(d.get("smetsversion"))
    print(f"HAN status counts: {dict(han)}")
    if changes:
        print("HAN status changes: " + "; ".join(changes[:10]))
    if rssi:
        print(f"RSSI {min(rssi)} to {max(rssi)} (median {statistics.median(rssi)}); "
              f"LQI {min(lqi) if lqi else '?'} to {max(lqi) if lqi else '?'}")
    print(f"Software {sorted(map(str, sw))}, hardware {sorted(map(str, hw))}, SMETS {sorted(map(str, smets))}")
    print(f"Fields in last message: {sorted(msgs[-1][1].keys())}")


def meter(kind, msgs, issues):
    gas = kind == "gasmeter"
    first = msgs[0][1].get(kind) or {}
    imp0 = (first.get("energy") or {}).get("import") or {}
    print(f"Import fields: {sorted(imp0.keys())}")
    print(f"Export fields: {sorted(((first.get('energy') or {}).get('export') or {}).keys())}")
    print(f"{'MPRN' if gas else 'MPAN'} {mask(imp0.get('mprn' if gas else 'mpan'))}, supplier {mask(imp0.get('supplier'))}")

    resend_same = resend_diff = 0
    prev_ts = prev_vals = None
    lags = []
    last_good = {}
    accepted = defaultdict(list)
    rates, standing = [], []
    neg_power, powers = [], []
    vol_missing = 0
    fresh_times = []
    track = ["cumulativevol", "cumulative"] if gas else ["cumulative", "export"]

    for a, d in msgs:
        body = d.get(kind)
        if not isinstance(body, dict):
            issues["1 missing top-level object"].append(f"{loc(a)} {kind}")
            continue
        ts = parse_time(str(body.get("timestamp", "")))
        if ts is None or ts.year < 2020 or ts > a + timedelta(days=1):
            issues["2 bad timestamp"].append(f"{loc(a)} {kind} timestamp={body.get('timestamp')}")
            continue
        lags.append((a - ts).total_seconds())
        energy = body.get("energy") or {}
        imp = energy.get("import") or {}
        exp = energy.get("export") or {}
        price = imp.get("price") or {}
        vals = {
            "cumulative": imp.get("cumulative"),
            "export": exp.get("cumulative"),
            "cumulativevol": imp.get("cumulativevol"),
            "power": (body.get("power") or {}).get("value"),
            "unitrate": price.get("unitrate"),
            "standingcharge": price.get("standingcharge"),
        }
        if prev_ts is not None and ts == prev_ts:
            if vals == prev_vals:
                resend_same += 1
            else:
                resend_diff += 1
        else:
            fresh_times.append(a)
        prev_ts, prev_vals = ts, vals

        if gas and "cumulativevol" not in imp:
            vol_missing += 1

        # rules 3-6 on non-cumulative fields
        p = vals["power"]
        if not gas:
            if not num(p):
                issues["3 power null/missing"].append(f"{loc(a)} {p}")
            elif abs(p - POWER_NO_READING) < 1e-6:
                issues["4 power no-reading value"].append(loc(a))
            elif abs(p) > MAX_KW:
                issues["6 power out of range"].append(f"{loc(a)} {p} kW")
            else:
                powers.append((a, p))
                if p < 0:
                    neg_power.append((a, p))
        for f, store in (("unitrate", rates), ("standingcharge", standing)):
            v = vals[f]
            if not num(v):
                issues[f"3 {kind} {f} null/missing"].append(f"{loc(a)} {v}")
            elif v == 0:
                issues[f"5 {kind} {f} zero"].append(loc(a))
            elif not 0 < v < 5:
                issues[f"6 {kind} {f} out of range"].append(f"{loc(a)} {v}")
            else:
                store.append((a, v))

        # rules 3-5, 7-8 on cumulative fields
        for f in track:
            v = vals[f]
            if f == "cumulativevol" and "cumulativevol" not in imp:
                continue
            if not num(v):
                issues[f"3 {kind} {f} null/missing"].append(f"{loc(a)} {v}")
                continue
            if float(v) in CUM_NO_READING:
                issues[f"4 {kind} {f} no-reading value"].append(loc(a))
                continue
            if v == 0 and f != "export":
                issues[f"5 {kind} {f} zero"].append(loc(a))
                continue
            if f in last_good:
                la, lv = last_good[f]
                hours = max((a - la).total_seconds() / 3600, 0)
                if v < lv:
                    issues[f"7 {kind} {f} decreased"].append(f"{loc(a)} {lv} → {v}")
                    continue
                if gas:
                    limit = MAX_GAS_M3_PER_H * hours + 0.05
                    if f == "cumulative":
                        limit = MAX_GAS_M3_PER_H * 11.5 * hours + 0.6
                else:
                    limit = MAX_KW * hours + 0.1
                if v - lv > limit:
                    issues[f"8 {kind} {f} implausible jump"].append(f"{loc(a)} {lv} → {v} in {hours * 60:.0f} min")
                    continue
            last_good[f] = (a, v)
            accepted[f].append((a, v))

    if lags:
        print(f"Arrival minus payload timestamp: median {statistics.median(lags):.0f}s, "
              f"max {max(lags):.0f}s, min {min(lags):.0f}s")
    print(f"Re-sends with same payload timestamp: {resend_same} identical, {resend_diff} with different values; "
          f"fresh readings {len(fresh_times)} ({gaps_summary(fresh_times)})")

    for f in track:
        series = accepted[f]
        if series:
            changes = [a for (a0, v0), (a, v) in zip(series, series[1:]) if v != v0]
            print(f"{f} (accepted readings only): {series[0][1]} → {series[-1][1]} (Δ {series[-1][1] - series[0][1]:.3f}), "
                  f"{len(changes)} changes ({gaps_summary(changes)})")
        else:
            print(f"{f}: never a positive number in this capture")
    if gas:
        print(f"Messages without cumulativevol: {vol_missing} of {len(msgs)}")
    else:
        if powers:
            ps = [p for _, p in powers]
            print(f"Power: {min(ps)} to {max(ps)} kW; {len(neg_power)} negative readings")
            if neg_power:
                hours = Counter(a.astimezone(LOCAL).strftime("%H:00") for a, _ in neg_power)
                print("Negative power by hour: " + ", ".join(f"{h} ×{c}" for h, c in sorted(hours.items())))
            else:
                print("No negative power seen: the sign during export is still unconfirmed")

    for label, series in (("Unit rate", rates), ("Standing charge", standing)):
        if not series:
            continue
        events = [f"{loc(series[0][0])} {series[0][1]}"]
        events += [f"{loc(a)} {v0} → {v}" for (a0, v0), (a, v) in zip(series, series[1:]) if v != v0]
        print(f"{label}: {len(events) - 1} changes; " + "; ".join(events[:12]))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 analyse_glow_capture.py glow-capture.log")
    main(sys.argv[1])
