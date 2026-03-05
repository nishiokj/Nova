#!/usr/bin/env python3
"""Test Health Referee — evaluates test suite strength via mutation testing.

Produces a health snapshot from the current state of source code and tests.
All artifacts live in /tmp/test-health-<repo-hash>/ — nothing touches the repo.

Usage:
    referee.py [--mechanical] [--semantic] [--all] [--report-only] [--clean]

Workflow:
    1. Write tests:       /dev-test <target>
    2. Generate attacks:  /red-team <target>
    3. Evaluate:          referee.py --all
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# ─── Configuration ────────────────────────────────────────────────────────────

FAULT_CLASSES = [
    "wrong_value",
    "wrong_path",
    "missing_action",
    "wrong_binding",
    "wrong_sequencing",
    "boundary_error",
    "error_handling",
    "resource_lifecycle",
]

# Colors
RED = "\033[0;31m"
GREEN = "\033[0;32m"
YELLOW = "\033[0;33m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def get_repo_root() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except subprocess.CalledProcessError:
        print("Not in a git repository.", file=sys.stderr)
        sys.exit(1)


def get_health_dir(repo_root: str) -> Path:
    repo_hash = hashlib.md5(repo_root.encode()).hexdigest()[:12]
    return Path(f"/tmp/test-health-{repo_hash}")


# ─── Classification ──────────────────────────────────────────────────────────

def classify_mutant(desc: str) -> str:
    d = desc.lower()

    # Arithmetic operators → wrong_value
    if any(op in d for op in [
        "replace + with", "replace - with", "replace * with",
        "replace / with", "replace % with",
    ]):
        return "wrong_value"

    # Comparison operators → wrong_path
    if any(op in d for op in [
        "replace < with", "replace > with", "replace == with",
        "replace != with", "replace <= with", "replace >= with",
    ]):
        return "wrong_path"

    # Boolean/logical → wrong_path
    if any(op in d for op in [
        "negate", "replace && with", "replace || with",
        "replace true", "replace false",
    ]):
        return "wrong_path"

    # Return value / default replacement → missing_action
    if any(op in d for op in ["with default", "-> ()"]):
        return "missing_action"

    # Range boundaries
    if any(op in d for op in ["replace .. ", "replace ..="]):
        return "boundary_error"

    # Error/Result manipulation
    if any(op in d for op in ["replace err", "replace ok", "remove ?"]):
        return "error_handling"

    return "uncategorized"


# ─── Mechanical Layer ─────────────────────────────────────────────────────────

def run_mechanical(repo_root: str, health_dir: Path) -> dict | None:
    print(f"{BOLD}═══ Layer 1: Mechanical Mutations (cargo-mutants) ═══{RESET}\n")

    if not shutil.which("cargo-mutants"):
        print(f"{YELLOW}cargo-mutants not installed. Install with: cargo install cargo-mutants{RESET}")
        print(f"{DIM}Skipping mechanical layer.{RESET}\n")
        return None

    mutants_out = health_dir / "mechanical"
    mutants_out.mkdir(parents=True, exist_ok=True)

    print(f"{DIM}Running cargo-mutants... this may take a while.{RESET}")
    subprocess.run(
        ["cargo", "mutants", "--output", str(mutants_out)],
        cwd=repo_root, capture_output=False,
    )

    outcomes_path = mutants_out / "outcomes.json"
    if not outcomes_path.exists():
        print(f"{RED}No outcomes file found. cargo-mutants may have failed.{RESET}")
        return None

    with open(outcomes_path) as f:
        data = json.load(f)

    results = {fc: {"killed": 0, "survived": 0, "unviable": 0, "timeout": 0} for fc in FAULT_CLASSES + ["uncategorized"]}

    for outcome in data.get("outcomes", []):
        scenario = outcome.get("scenario", {})
        mutant = scenario.get("mutant", {})
        desc = str(mutant.get("description", "")) if isinstance(mutant, dict) else str(mutant)
        summary = str(outcome.get("summary", ""))

        fc = classify_mutant(desc)

        if any(k in summary for k in ["Caught", "caught"]):
            results[fc]["killed"] += 1
        elif any(k in summary for k in ["Missed", "missed"]):
            results[fc]["survived"] += 1
        elif any(k in summary for k in ["Unviable", "unviable"]):
            results[fc]["unviable"] += 1
        elif any(k in summary for k in ["Timeout", "timeout"]):
            results[fc]["timeout"] += 1

    # Print results
    print(f"\n{BOLD}Mechanical Results:{RESET}\n")
    print(f"{'Fault Class':<22} {'Kill Rate':<14} {'Status'}")
    print("─" * 52)

    total_killed = 0
    total_tested = 0

    for fc in FAULT_CLASSES:
        r = results[fc]
        tested = r["killed"] + r["survived"]
        if tested == 0:
            print(f"{fc:<22} {'--':<14} NOT TESTED")
            continue

        total_killed += r["killed"]
        total_tested += tested
        rate = r["killed"] / tested * 100
        status = "OK" if rate >= 80 else ("WEAK" if rate >= 50 else "GAP")
        print(f"{fc:<22} {r['killed']}/{tested}  {rate:>3.0f}%    {status}")

    if total_tested > 0:
        overall = total_killed / total_tested * 100
        print("─" * 52)
        print(f"{'Overall':<22} {total_killed}/{total_tested}  {overall:>3.0f}%")

    # Save results
    results_path = health_dir / "mechanical_results.json"
    with open(results_path, "w") as f:
        json.dump({"layer": "mechanical", "results": results}, f, indent=2)

    return results


# ─── Semantic Layer ───────────────────────────────────────────────────────────

def run_semantic(repo_root: str, health_dir: Path) -> dict | None:
    print(f"{BOLD}═══ Layer 2: Semantic Mutations (LLM-generated) ═══{RESET}\n")

    semantic_dir = health_dir / "semantic"
    if not semantic_dir.exists() or not any(semantic_dir.iterdir()):
        print(f"{YELLOW}No semantic mutations found in {semantic_dir}{RESET}")
        print(f"{DIM}Run /red-team <target> to generate semantic mutations.{RESET}\n")
        return None

    # Check for clean working tree
    status = subprocess.run(
        ["git", "-C", repo_root, "status", "--porcelain", "--ignore-submodules"],
        capture_output=True, text=True,
    )
    if status.stdout.strip():
        print(f"{YELLOW}Warning: working tree has uncommitted changes.{RESET}")
        print(f"{DIM}Mutations are evaluated against HEAD. Uncommitted changes won't be included.{RESET}\n")

    results = {fc: {"killed": 0, "survived": 0, "unviable": 0} for fc in FAULT_CLASSES + ["uncategorized"]}
    mutation_count = 0
    survived_total = 0
    killed_total = 0
    unviable_total = 0

    for mutation_dir in sorted(semantic_dir.iterdir()):
        if not mutation_dir.is_dir():
            continue

        meta_path = mutation_dir / "mutation.json"
        patch_path = mutation_dir / "mutation.patch"

        if not meta_path.exists() or not patch_path.exists():
            continue

        mutation_count += 1
        mutation_id = mutation_dir.name

        try:
            with open(meta_path) as f:
                meta = json.load(f)
            fault_class = meta.get("fault_class", "uncategorized")
            gap = meta.get("gap", "no description")
        except (json.JSONDecodeError, KeyError):
            fault_class = "uncategorized"
            gap = "parse error"

        # Create isolated worktree
        worktree = f"/tmp/referee-{mutation_id}-{os.getpid()}"
        wt_result = subprocess.run(
            ["git", "-C", repo_root, "worktree", "add", "-q", worktree, "HEAD"],
            capture_output=True, text=True,
        )
        if wt_result.returncode != 0:
            print(f"  {RED}✗{RESET} {mutation_id}: failed to create worktree")
            results[fault_class]["unviable"] += 1
            unviable_total += 1
            continue

        try:
            # Apply patch
            apply_result = subprocess.run(
                ["git", "-C", worktree, "apply", str(patch_path)],
                capture_output=True, text=True,
            )
            if apply_result.returncode != 0:
                print(f"  {RED}✗{RESET} {mutation_id} {DIM}[{fault_class}]{RESET}: UNVIABLE — patch failed to apply")
                results[fault_class]["unviable"] += 1
                unviable_total += 1
                continue

            # Verify compilation
            check_result = subprocess.run(
                ["cargo", "check", "--quiet"],
                cwd=worktree, capture_output=True, text=True,
            )
            if check_result.returncode != 0:
                print(f"  {RED}✗{RESET} {mutation_id} {DIM}[{fault_class}]{RESET}: UNVIABLE — does not compile")
                results[fault_class]["unviable"] += 1
                unviable_total += 1
                continue

            # Run tests
            test_result = subprocess.run(
                ["cargo", "test", "--quiet"],
                cwd=worktree, capture_output=True, text=True,
            )
            if test_result.returncode == 0:
                print(f"  {GREEN}●{RESET} {mutation_id} {DIM}[{fault_class}]{RESET}: {GREEN}SURVIVED{RESET} — {DIM}{gap}{RESET}")
                results[fault_class]["survived"] += 1
                survived_total += 1
            else:
                print(f"  {DIM}○{RESET} {mutation_id} {DIM}[{fault_class}]{RESET}: {DIM}KILLED{RESET}")
                results[fault_class]["killed"] += 1
                killed_total += 1

        finally:
            # Cleanup worktree
            subprocess.run(
                ["git", "-C", repo_root, "worktree", "remove", "-f", worktree],
                capture_output=True, text=True,
            )

    if mutation_count == 0:
        print(f"{DIM}No valid mutations found.{RESET}")
        return None

    print(f"\n{BOLD}Semantic Results:{RESET}\n")
    print(f"  Mutations evaluated: {mutation_count}")
    print(f"  {GREEN}Survived (gaps found):{RESET} {survived_total}")
    print(f"  {DIM}Killed (tests caught):{RESET} {killed_total}")
    print(f"  {RED}Unviable (bad patches):{RESET} {unviable_total}")

    if survived_total > 0:
        print(f"\n  {BOLD}Red team found {survived_total} gap(s) in the test suite.{RESET}")
    else:
        print(f"\n  {BOLD}Blue team held. All mutations were caught.{RESET}")

    # Save results
    results_path = health_dir / "semantic_results.json"
    with open(results_path, "w") as f:
        json.dump({"layer": "semantic", "results": results}, f, indent=2)

    return results


# ─── Combined Report ─────────────────────────────────────────────────────────

def generate_report(health_dir: Path):
    print(f"\n{BOLD}═══ Combined Test Health Report ═══{RESET}\n")

    mech = {}
    sem = {}

    mech_path = health_dir / "mechanical_results.json"
    sem_path = health_dir / "semantic_results.json"

    if mech_path.exists():
        with open(mech_path) as f:
            mech = json.load(f).get("results", {})

    if sem_path.exists():
        with open(sem_path) as f:
            sem = json.load(f).get("results", {})

    if not mech and not sem:
        print("No results to report. Run with --mechanical and/or --semantic first.")
        return

    print(f"{'Fault Class':<22} {'Mechanical':<16} {'Semantic':<16} {'Combined':<14} {'Status'}")
    print("─" * 78)

    total_killed = 0
    total_tested = 0
    classes_with_data = 0
    classes_ok = 0
    blind_spots = []

    for fc in FAULT_CLASSES:
        m = mech.get(fc, {"killed": 0, "survived": 0, "unviable": 0})
        s = sem.get(fc, {"killed": 0, "survived": 0, "unviable": 0})

        m_tested = m["killed"] + m["survived"]
        s_tested = s["killed"] + s["survived"]
        combined_killed = m["killed"] + s["killed"]
        combined_tested = m_tested + s_tested

        if combined_tested == 0:
            print(f"{fc:<22} {'--':<16} {'--':<16} {'--':<14} NOT TESTED")
            blind_spots.append(fc)
            continue

        classes_with_data += 1
        total_killed += combined_killed
        total_tested += combined_tested

        m_str = f"{m['killed']}/{m_tested} ({m['killed']/m_tested*100:.0f}%)" if m_tested > 0 else "--"
        s_str = f"{s['killed']}/{s_tested}" if s_tested > 0 else "--"

        rate = combined_killed / combined_tested * 100
        if rate >= 80:
            status = "OK"
            classes_ok += 1
        elif rate >= 50:
            status = "WEAK"
        elif rate > 0:
            status = "GAP"
        else:
            status = "FAILING"

        c_str = f"{combined_killed}/{combined_tested}  {rate:>3.0f}%"
        print(f"{fc:<22} {m_str:<16} {s_str:<16} {c_str:<14} {status}")

    print("─" * 78)

    if total_tested > 0:
        overall = total_killed / total_tested * 100
        print(f"{'TOTAL':<22} {'':<16} {'':<16} {total_killed}/{total_tested}  {overall:>3.0f}%")
        print()
        print(f"Fault class coverage: {classes_with_data}/{len(FAULT_CLASSES)} tested, {classes_ok}/{classes_with_data} healthy")

    if blind_spots:
        print(f"Blind spots (no mutations generated): {', '.join(blind_spots)}")

    # Write combined report JSON
    report = {
        "health_dir": str(health_dir),
        "fault_classes": {},
        "total_killed": total_killed,
        "total_tested": total_tested,
        "overall_kill_rate": total_killed / total_tested * 100 if total_tested > 0 else 0,
        "classes_tested": classes_with_data,
        "classes_total": len(FAULT_CLASSES),
        "blind_spots": blind_spots,
        "survived_mutations": [],
    }

    for fc in FAULT_CLASSES:
        m = mech.get(fc, {"killed": 0, "survived": 0, "unviable": 0})
        s = sem.get(fc, {"killed": 0, "survived": 0, "unviable": 0})
        report["fault_classes"][fc] = {
            "mechanical": m,
            "semantic": s,
            "combined_killed": m["killed"] + s["killed"],
            "combined_tested": m["killed"] + m["survived"] + s["killed"] + s["survived"],
        }

    # Collect survived semantic mutations for blue team consumption
    semantic_dir = health_dir / "semantic"
    if semantic_dir.exists():
        for mutation_dir in sorted(semantic_dir.iterdir()):
            meta_path = mutation_dir / "mutation.json"
            if not meta_path.exists():
                continue
            try:
                with open(meta_path) as f:
                    meta = json.load(f)
                # Check if this mutation survived (semantic results)
                fc = meta.get("fault_class", "uncategorized")
                sem_fc = sem.get(fc, {})
                if sem_fc.get("survived", 0) > 0:
                    report["survived_mutations"].append(meta)
            except (json.JSONDecodeError, KeyError):
                pass

    report_path = health_dir / "report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\nFull report: {report_path}")


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Evaluate test suite health via mutation testing.",
        epilog="Workflow:\n"
               "  1. Write tests:       /dev-test <target>\n"
               "  2. Generate attacks:  /red-team <target>\n"
               "  3. Evaluate:          referee.py --all",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--mechanical", action="store_true", help="Run mechanical mutations only")
    parser.add_argument("--semantic", action="store_true", help="Evaluate semantic mutations only")
    parser.add_argument("--all", action="store_true", help="Run both layers (default)")
    parser.add_argument("--report-only", action="store_true", help="Regenerate report from existing results")
    parser.add_argument("--clean", action="store_true", help="Delete all cached results and start fresh")
    args = parser.parse_args()

    repo_root = get_repo_root()
    health_dir = get_health_dir(repo_root)

    if args.clean:
        if health_dir.exists():
            shutil.rmtree(health_dir)
            print(f"Cleaned {health_dir}")
        return

    health_dir.mkdir(parents=True, exist_ok=True)

    # Default to --all if no layer specified
    run_mech = args.mechanical or args.all or not (args.mechanical or args.semantic or args.report_only)
    run_sem = args.semantic or args.all or not (args.mechanical or args.semantic or args.report_only)

    if args.report_only:
        generate_report(health_dir)
        return

    print(f"{BOLD}Test Health Referee{RESET}")
    print(f"{DIM}Health dir: {health_dir}{RESET}")
    print(f"{DIM}Repo: {repo_root}{RESET}\n")

    os.chdir(repo_root)

    if run_mech:
        run_mechanical(repo_root, health_dir)
        print()

    if run_sem:
        run_semantic(repo_root, health_dir)
        print()

    generate_report(health_dir)


if __name__ == "__main__":
    main()
