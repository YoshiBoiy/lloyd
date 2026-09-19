RDK_HOST='root@192.168.128.10'

ssh "$RDK_HOST" 'mkdir -p ~/lloyd/apps/edge-gateway'

rsync -av \
  --exclude='.venv' \
  --exclude='__pycache__' \
  --exclude='.pytest_cache' \
  --exclude='.ruff_cache' \
  --exclude='*.egg-info' \
  /Users/yash/.codex/worktrees/backend-edge/lloyd/apps/edge-gateway/ \
  "$RDK_HOST:~/lloyd/apps/edge-gateway/"
