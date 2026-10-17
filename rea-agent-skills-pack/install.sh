#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"
case "$MODE" in claude|codex|both) ;; *) echo "Uso: $0 {claude|codex|both}" >&2; exit 2;; esac
install_to() {
  local kind="$1" dest="$2" src="$ROOT/skills"
  mkdir -p "$dest"
  for skill in "$src"/*; do
    [[ -d "$skill" ]] || continue
    local name target backup staged
    name="$(basename "$skill")"
    target="$dest/$name"
    staged="$dest/.${name}.staging-$-$RANDOM"
    backup=""

    # Prepare the complete replacement before touching the active installation.
    if ! cp -R -- "$skill" "$staged"; then
      rm -rf -- "$staged"
      echo "Falha ao preparar skill $name; instalação existente preservada." >&2
      return 1
    fi

    if [[ -e "$target" ]]; then
      backup="$dest/.${name}.backup-$(date +%Y%m%d-%H%M%S)-$-$RANDOM"
      if ! mv -- "$target" "$backup"; then
        rm -rf -- "$staged"
        echo "Falha ao criar backup de $target; instalação existente preservada." >&2
        return 1
      fi
      printf 'Backup %s: %s\n' "$kind" "$backup"
    fi

    if ! mv -- "$staged" "$target"; then
      rm -rf -- "$staged"
      if [[ -n "$backup" && -e "$backup" && ! -e "$target" ]]; then
        mv -- "$backup" "$target" || {
          echo "ERRO: não foi possível restaurar $backup para $target" >&2
          return 1
        }
      fi
      echo "Falha ao ativar skill $name; backup restaurado quando possível." >&2
      return 1
    fi
    printf 'Instalada %s: %s\n' "$kind" "$target"
  done
}
if [[ "$MODE" == claude || "$MODE" == both ]]; then
  install_to Claude "${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
fi
if [[ "$MODE" == codex || "$MODE" == both ]]; then
  install_to Codex "${CODEX_SKILLS_DIR:-$HOME/.agents/skills}"
fi
