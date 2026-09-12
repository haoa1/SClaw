# -*- coding: utf-8 -*-
"""SClaw 保活看门狗 —— 保证 SClaw backend 一直运行（用户要求维护）。

职责：
  1. 检测 127.0.0.1:3001 是否存活。
  2. 存活 → 静默退出（无操作）。
  3. 死亡 → 用 node dist/index.js 重新拉起（CREATE_NO_WINDOW 分离进程，日志重定向）。

用法：
  python sclaw_watchdog.py              # 看门狗：挂了自动拉起
  python sclaw_watchdog.py --check      # 仅检查存活，不拉起（测试用）

建议用 Windows 计划任务每 5 分钟跑一次 + 登录时跑一次（见 README/调度说明）。
"""
import socket
import subprocess
import sys
import os
import datetime

BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PORT = 3001
LOG = os.path.join(BACKEND, "sclaw_watchdog.log")
START_LOG = os.path.join(BACKEND, "sclaw_wd_stdout.log")


def now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def alive():
    """端口探活：能连上 3001 即视为存活。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2.0)
    try:
        s.connect(("127.0.0.1", PORT))
        s.close()
        return True
    except Exception:
        try:
            s.close()
        except Exception:
            pass
        return False


def log(msg):
    line = f"[{now()}] {msg}"
    print(line)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def relaunch():
    """重新拉起 SClaw backend（分离进程，不受本脚本退出影响）。"""
    node = "node"
    if os.name == "nt":
        # Windows: 用 DETACHED_PROCESS + CREATE_NO_WINDOW，完全脱离父进程
        flags = 0x00000008 | 0x00000200  # CREATE_NO_WINDOW | DETACHED_PROCESS
        try:
            proc = subprocess.Popen(
                [node, "dist/index.js"],
                cwd=BACKEND,
                stdin=subprocess.DEVNULL,
                stdout=open(START_LOG, "w", encoding="utf-8"),
                stderr=subprocess.STDOUT,
                creationflags=flags,
                close_fds=True,
            )
            log(f"relaunch OK pid={proc.pid} cwd={BACKEND}")
            return True
        except Exception as e:
            log(f"relaunch failed: {e}")
            return False
    else:
        # Unix: start_new_session 脱离会话
        try:
            proc = subprocess.Popen(
                [node, "dist/index.js"],
                cwd=BACKEND,
                stdin=subprocess.DEVNULL,
                stdout=open(START_LOG, "w", encoding="utf-8"),
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
            log(f"relaunch OK pid={proc.pid} cwd={BACKEND}")
            return True
        except Exception as e:
            log(f"relaunch failed: {e}")
            return False


def main():
    check_only = "--check" in sys.argv
    if alive():
        log("SClaw alive (3001 OK) — no action")
        return 0
    log("SClaw DOWN (3001 not reachable)")
    if check_only:
        log("--check mode: would relaunch (skipped)")
        return 0
    ok = relaunch()
    # 拉起后等几秒再探活确认
    import time
    time.sleep(5)
    if alive():
        log("verify: back alive ✓")
        return 0
    log("verify: still down ✗ (will retry next run)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
