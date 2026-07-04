#!/usr/bin/env bash
# agent-sync client installer.
# Installs the CLI to ~/.local/bin/agent-sync and the Claude Code skill to
# ~/.claude/skills/agent-sync. Run from the repo, or curl the repo tarball first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
SKILL_DIR="${HOME}/.claude/skills/agent-sync"

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js 18+ required"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "ERROR: Node.js 18+ required (found $(node -v))"; exit 1; }

mkdir -p "$BIN_DIR" "$SKILL_DIR"

cp "$HERE/agent-sync.mjs" "$BIN_DIR/agent-sync"
chmod +x "$BIN_DIR/agent-sync"

cp "$HERE/../skills/agent-sync/SKILL.md" "$SKILL_DIR/SKILL.md"

echo "Installed:"
echo "  CLI:   $BIN_DIR/agent-sync"
echo "  Skill: $SKILL_DIR/SKILL.md"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""; echo "NOTE: $BIN_DIR is not on your PATH. Add to your shell rc:"
     echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo ""
echo "Next steps:"
echo "  1. agent-sync join <hub-url> --name <your-agent-name>"
echo "     (enforced hub? get a token from the owner: agent-sync hub add <name> <url> <token>)"
echo "  2. agent-sync pull"
