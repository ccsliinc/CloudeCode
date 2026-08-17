#!/bin/bash
# Mutation check for tests/test_altscreen_scroll.node.mjs.
#
# A test that passes is only evidence if it can also FAIL. Each mutation
# below breaks one of the safety properties this module exists to hold;
# every one of them must turn the suite red. Restores the original file
# on exit, including on failure.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/client/js/altscreen-scroll.js"
BAK="$(mktemp)"
cp "$SRC" "$BAK"
trap 'cp "$BAK" "$SRC"; rm -f "$BAK"' EXIT

survived=0

# mutate <name> <python-expression-on-text>
mutate() {
  local name="$1" py="$2"
  cp "$BAK" "$SRC"
  python3 - "$SRC" "$py" <<'PY'
import sys
path, expr = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
old, new = expr.split('||=>||')
if old not in text:
    sys.exit('mutation target not found: ' + old[:60])
open(path, 'w', encoding='utf-8').write(text.replace(old, new, 1))
PY
  if [ $? -ne 0 ]; then echo "SKIP $name (target moved)"; survived=1; return; fi
  if node "$ROOT/tests/test_altscreen_scroll.node.mjs" >/dev/null 2>&1; then
    echo "SURVIVED $name"
    survived=1
  else
    echo "killed    $name"
  fi
}

mutate "transcript footer no longer identifies the open view" \
  "return 'transcript';||=>||return 'live';"

mutate "any alternate screen is treated as claude" \
  "        return 'unknown';
    }

    /**
     * Record a real keystroke||=>||        return 'live';
    }

    /**
     * Record a real keystroke"

mutate "typing guard removed" \
  "if (isTyping()) return true;||=>||if (false) return true;"

mutate "typing guard removed from the delayed arrows" \
  "if (!isTyping()) sendKeys(arrowRun(rows));||=>||sendKeys(arrowRun(rows));"

mutate "in-flight open no longer suppresses a second gesture" \
  "if (openPending() && state !== 'transcript') return true;||=>||if (false) return true;"

mutate "arrows ride along in the same write as the toggle" \
  "sendKeys(CTRL_O);
            if (settleTimer)||=>||sendKeys(CTRL_O + arrowRun(rows));
            if (settleTimer)"

mutate "exitTranscript toggles blind" \
  "if (detectState(term) !== 'transcript') return false;||=>||if (false) return false;"

mutate "per-gesture arrow cap removed" \
  "var n = Math.min(Math.abs(rows), MAX_ROWS_PER_GESTURE);||=>||var n = Math.abs(rows);"

mutate "prompt frame accepts one rule instead of two" \
  "if (isRule(rows[j]) && isPromptLine(rows[j + 1]) && isRule(rows[j + 2])) {||=>||if (isPromptLine(rows[j + 1])) {"

mutate "main screen is claimed instead of falling through" \
  "if (state === 'main') return false;||=>||if (state === 'main') return true;"

mutate "unreadable buffer reported as main screen" \
  "if (typeof type !== 'string' || typeof baseY !== 'number') return 'unknown';||=>||if (typeof type !== 'string' || typeof baseY !== 'number') return 'main';"

mutate "gate goes back to the buffer label instead of scrollback" \
  "if (baseY > 0) return 'main';||=>||if (type !== 'alternate') return 'main';"

mutate "existing scrollback is hijacked instead of left to scrollLines" \
  "if (baseY > 0) return 'main';||=>||if (baseY < 0) return 'main';"

# --- the ownership gate: claude's chrome PLUS evidence of a full-screen
# --- paint. Each half is load-bearing in a different direction.

mutate "THE REPORTED BUG: pre-claude scrollback outranks claude again" \
  "if (owner && (type === 'alternate' || baseY === 0)) return owner;||=>||if (owner && baseY === 0) return owner;"

mutate "claude's chrome alone owns the gesture, hijacking tui: default" \
  "if (owner && (type === 'alternate' || baseY === 0)) return owner;||=>||if (owner) return owner;"

mutate "an unreadable screen over scrollback invents could-not-evaluate" \
  "if (!rows.length) return baseY > 0 ? 'main' : 'unknown';||=>||if (!rows.length) return 'unknown';"

mutate "an unreadable screen with nothing to scroll is called main anyway" \
  "if (!rows.length) return baseY > 0 ? 'main' : 'unknown';||=>||if (!rows.length) return 'main';"

if [ "$survived" -ne 0 ]; then
  echo "MUTATION CHECK FAILED"
  exit 1
fi
echo "MUTATION CHECK PASSED"
