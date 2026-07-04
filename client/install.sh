#!/usr/bin/env bash
# waggle client installer.
# Installs the CLI to ~/.local/bin/waggle and the Claude Code skill to
# ~/.claude/skills/waggle. Run from the repo, or curl the repo tarball first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
SKILL_DIR="${HOME}/.claude/skills/waggle"

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js 18+ required"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "ERROR: Node.js 18+ required (found $(node -v))"; exit 1; }

mkdir -p "$BIN_DIR" "$SKILL_DIR"

cp "$HERE/waggle.mjs" "$BIN_DIR/waggle"
chmod +x "$BIN_DIR/waggle"

cp "$HERE/../skills/waggle/SKILL.md" "$SKILL_DIR/SKILL.md"

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
echo "  1. waggle join <hub-url> --name <your-agent-name>"
echo "     (enforced hub? get a token from the owner: waggle hub add <name> <url> <token>)"
echo "  2. waggle pull"
