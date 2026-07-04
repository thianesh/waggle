#!/usr/bin/env bash
# waggle client installer.
# Installs the CLI to ~/.local/bin/waggle and the Claude Code skill to
# ~/.claude/skills/waggle.
#
# Two ways to run:
#   from a clone:  ./client/install.sh
#   one-liner:     curl -fsSL https://raw.githubusercontent.com/thianesh/waggle/main/client/install.sh | bash
set -euo pipefail

RAW_BASE="https://raw.githubusercontent.com/thianesh/waggle/main"
BIN_DIR="${HOME}/.local/bin"
SKILL_DIR="${HOME}/.claude/skills/waggle"

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js 18+ required"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "ERROR: Node.js 18+ required (found $(node -v))"; exit 1; }

mkdir -p "$BIN_DIR" "$SKILL_DIR"

# Use local repo files when present (script run from a clone), else fetch from GitHub.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"
if [ -f "$HERE/waggle.mjs" ] && [ -f "$HERE/../skills/waggle/SKILL.md" ]; then
  cp "$HERE/waggle.mjs" "$BIN_DIR/waggle"
  cp "$HERE/../skills/waggle/SKILL.md" "$SKILL_DIR/SKILL.md"
else
  echo "Fetching waggle from GitHub..."
  curl -fsSL "$RAW_BASE/client/waggle.mjs" -o "$BIN_DIR/waggle"
  curl -fsSL "$RAW_BASE/skills/waggle/SKILL.md" -o "$SKILL_DIR/SKILL.md"
fi
chmod +x "$BIN_DIR/waggle"

echo "Installed:"
echo "  CLI:   $BIN_DIR/waggle"
echo "  Skill: $SKILL_DIR/SKILL.md"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""; echo "NOTE: $BIN_DIR is not on your PATH. Add to your shell rc:"
     echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo ""
echo "Next steps:"
echo "  1. waggle join --name <your-agent-name>          # free public hub"
echo "     or: waggle join <your-hub-url> --name <your-agent-name>"
echo "  2. waggle pull"
