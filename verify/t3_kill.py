import sys, json, subprocess
sys.path.insert(0, "/Users/jsugamele/Scratch/llmScratch/cc-s4-verify2")
from verify.harness import fresh_state_dir, snap
from src.core.db_migration import ensure_db_migrated
PY="/Users/jsugamele/Scratch/llmScratch/cc-s4-verify2/venv/bin/python3"
for where in ("first","mid"):
    print(f"=== T3 HARD KILL os._exit(9) at {where} ===")
    d = fresh_state_dir("t3_"+where)
    r = subprocess.run([PY,"verify/t3_child.py",str(d),where],capture_output=True,text=True,
                       cwd="/Users/jsugamele/Scratch/llmScratch/cc-s4-verify2")
    print("  child exit code:", r.returncode)
    s = snap(d/"cloude.db")
    print(f"  after kill: version={s['version']} tables={s['tables']} projects={len(s['projects'])} integrity={s['integrity']}")
    print("  DATA INTACT AT v1:", s["version"]=="1" and len(s["projects"])==9)
    print("  WAL/journal leftovers:", [p.name for p in d.glob("cloude.db-*")])
    print("  --- next startup (recovery) ---")
    st = ensure_db_migrated(d, 4, "0.8.3")
    s2 = snap(d/"cloude.db")
    print(f"  status={st.status} trail_status={st.trail_status} schema={s2['version']} projects={len(s2['projects'])} integrity={s2['integrity']}")
    print("  RECOVERED TO v3 WITH DATA:", st.status=="ok" and s2["version"]=="3" and len(s2["projects"])==9)
    for line in (d/"migration_trail.jsonl").read_text().splitlines():
        e=json.loads(line); print("   trail:",e["kind"],e["from_version"],"->",e["to_version"],e["status"],(e["detail"] or "")[:55])
    print()
