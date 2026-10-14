#!/bin/sh
# e2e-loop 설치: bun 확인 → 의존성 → 환경 점검·자동 설치 → MCP 등록(설치된 Claude·Codex 모두)
# 사용: sh install.sh [--confirm ffmpeg] [--dry-run]
set -e
cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "[e2e-loop] bun 이 없어 설치합니다 (https://bun.sh)."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

echo "[e2e-loop] 의존성 설치"
bun install

echo "[e2e-loop] 환경 점검 + 자동 설치 + MCP 등록"
bun src/cli.ts setup "$@"

echo
echo "[e2e-loop] 끝. 결과의 needs_confirmation(설치 전 질문) 과 manual(직접 할 일)을 확인하세요."
echo "           ffmpeg 처럼 승인이 필요한 항목은: sh install.sh --confirm ffmpeg"
