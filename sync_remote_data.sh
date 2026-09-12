#!/bin/bash
# Remote SClaw data sync → local (ESSENTIAL set + plugins), background, resumable
LOG=/root/sclaw/sync_remote_data.log
SSH_KEY=/root/.ssh/id_ed25519
REMOTE=root@47.109.31.187
SSH="ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
DEST=/root/sclaw/backend/data

echo "=== $(date) 同步开始 ===" >> $LOG

# 1. 必要 DB 集 (从远程 /root/sclaw/data, 排除5m) → 本地 backend/data
echo "--- [1/3] 必要DB集 (m30/history/cloud_extra/turnover/ml, 排除5m) ---" >> $LOG
rsync -avh --partial -e "$SSH" --exclude 'stock_5m.db*' \
  $REMOTE:/root/sclaw/data/ $DEST/ >> $LOG 2>&1
echo "--- [1/3] 结束 rc=$? ---" >> $LOG

# 2. stock_list.json
echo "--- [2/3] stock_list.json ---" >> $LOG
rsync -avh --partial -e "$SSH" \
  $REMOTE:/root/sclaw/backend/data/stock_list.json $DEST/stock_list.json >> $LOG 2>&1
echo "--- [2/3] 结束 rc=$? ---" >> $LOG

# 3. plugins (merge, 不删除本地独有)
echo "--- [3/3] plugins ---" >> $LOG
rsync -avh --partial -e "$SSH" \
  $REMOTE:/root/sclaw/plugins/ /root/sclaw/plugins/ >> $LOG 2>&1
echo "--- [3/3] 结束 rc=$? ---" >> $LOG

echo "=== $(date) 同步全部结束 ===" >> $LOG
