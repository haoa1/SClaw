#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cutover_v2.py — SClaw-aware 切库编排器
=====================================
把「stop 桥接 → 停 SClaw → 跑 promote 闸门 → 重启桥接 → 拉起 SClaw → 验证」串成一条
可重入、可回滚的流水线，解决 os.rename 掉包后「持有者还抱着旧 inode」的静默脏读问题。

为什么必须停 garuda-mcp-bridge
------------------------------
garuda_mcp.py 的 _listen_sse() 是一个 while True 循环，**每次重连前都会调用
_ensure_sclaw()**；一旦发现 3001 端口不通，就用 sclaw_launcher.py 自动把 SClaw 拉起来。
于是：单独 kill SClaw 是**留不住它的** —— 约 5s 后桥接会把它复活，而复活后的 SClaw
若在 rename *之前* 起来，就又会抱住旧 inode。
因此必须先把桥接停掉（桥接是唯一会拉起 SClaw 的 actor），切完再启。

时序
----
  1. preflight    : 构建器已退出 / v2 就绪 / 持有者只有 SClaw
  2. stop bridge  : systemctl stop garuda-mcp-bridge   ← 唯一 actor 下线
  3. stop SClaw   : TERM → 等 fd 释放（最多 20s）→ KILL
  4. gate --yes   : backup → os.rename → verify（闸门自带回滚）
  5. start bridge : systemctl start（ensure 自动拉起 SClaw，拿到新 inode）
  6. verify       : 新 PID ≠ 旧 PID，且 fd 的 inode == 新文件 inode  ← 端到端铁证

用法
----
  python3 cutover_v2.py            # dry-run，只体检 + 打印计划
  python3 cutover_v2.py --yes      # 真正执行
  python3 cutover_v2.py --skip-bridge-stop   # 桥接已是 inactive 时跳过停桥（幂等兜底）
"""
import argparse
import os
import re
import subprocess
import sys
import time

BACKEND = "/root/sclaw/backend"
DATA = os.path.join(BACKEND, "data")
PROD = os.path.join(DATA, "clean_daily.db")
V2 = os.path.join(DATA, "clean_daily_v2.db")
GATE = os.path.join(BACKEND, "scripts", "promote_v2_to_prod.py")
BRIDGE = "garuda-mcp-bridge.service"
PORT = 3001


# ---------- 基础设施 ----------
def sh(cmd, timeout=60):
    r = subprocess.run(["bash", "-lc", cmd], capture_output=True,
                       text=True, timeout=timeout)
    return r.returncode, (r.stdout or ""), (r.stderr or "")


def say(tag, msg):
    print("[%s] %s" % (tag, msg), flush=True)


def inode_of(path):
    try:
        return os.stat(path).st_ino
    except OSError:
        return None


def fd_inodes(pid):
    """返回 {fd: (target, inode)}，inode 取 /proc/<pid>/fd 解析后的真实 inode。"""
    out = {}
    d = "/proc/%s/fd" % pid
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for fd in names:
        try:
            tgt = os.readlink(os.path.join(d, fd))
        except OSError:
            continue
        if tgt.startswith("/") and "clean_daily" in tgt:
            try:
                out[fd] = (tgt, os.stat("/proc/%s/fd/%s" % (pid, fd)).st_ino)
            except OSError:
                out[fd] = (tgt, None)
    return out


def openers_of(path):
    """扫 /proc 找持有 path 的进程（按 inode 匹配，避免同名不同 inode 误判）。"""
    want = inode_of(path)
    me = os.getpid()
    anc = set()
    p = me
    while p and p != 1:          # 排除自身祖先链
        anc.add(p)
        try:
            p = int(open("/proc/%d/stat" % p).read().split(") ", 1)[1].split()[1])
        except Exception:
            break
    hits = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        ipid = int(pid)
        if ipid in anc:
            continue
        for fd, (tgt, ino) in fd_inodes(pid).items():
            if ino == want and want is not None:
                try:
                    cmd = open("/proc/%s/cmdline" % pid, "rb").read().replace(b"\0", b" ").decode().strip()
                except OSError:
                    cmd = "?"
                hits.append((ipid, cmd[:90]))
                break
    return hits


def port_open(host="127.0.0.1", port=PORT, timeout=1.5):
    import socket
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def procs_matching(pat):
    rc, out, _ = sh("pgrep -f %s" % pat)
    return [int(x) for x in out.split() if x.isdigit()]


def sclaw_pids():
    """SClaw 后端 node 进程（cwd=/root/sclaw/backend 且 cmd=node dist/index.js）。"""
    res = []
    for pid in procs_matching("'node dist/index.js'"):
        try:
            if os.readlink("/proc/%d/cwd" % pid) == BACKEND:
                res.append(pid)
        except OSError:
            pass
    return res


# ---------- 步骤 ----------
def step_preflight(rehearse=False):
    say("1/6", "preflight")
    ok = True
    for p in (PROD, V2, GATE):
        if not os.path.exists(p):
            say("  ✗", "缺失 %s" % p)
            ok = False
        else:
            say("  ✓", "%s (%.1f MB)" % (os.path.basename(p), os.path.getsize(p) / 1e6))

    builders = procs_matching("v2_build")
    builders = [p for p in builders if p != os.getpid()]
    if builders:
        if rehearse:
            say("  !", "构建器仍在跑 PID=%s（--rehearse 彩排：仅忽略此条）" % builders)
        else:
            say("  ✗", "构建器仍在跑 PID=%s —— v2 未定稿，拒绝切库" % builders)
            ok = False
    else:
        say("  ✓", "v2_build 已退出")

    holders = openers_of(PROD)
    say("  ·", "prod 持有者: %s" % (holders or "无"))
    # 构建器本身也是 prod 的读者 —— 它由上面的 builders 检查负责，不在这里重复报错
    KNOWN = ("dist/index.js", "v2_build")
    unexpected = [(p, c) for p, c in holders if not any(k in c for k in KNOWN)]
    if unexpected:
        say("  ✗", "出现预期外的持有者（既非 SClaw 也非构建器）: %s" % unexpected)
        say("     ", "→ 请先弄清它是什么，再决定是否继续")
        ok = False
    return ok, holders


def step_stop_bridge(dry):
    say("2/6", "停掉 garuda-mcp-bridge（唯一会自动拉起 SClaw 的 actor）")
    rc, out, _ = sh("systemctl is-active %s" % BRIDGE)
    active = out.strip() == "active"
    say("  ·", "当前状态: %s" % out.strip())
    if dry:
        say("  →", "dry-run：将执行 systemctl stop %s" % BRIDGE)
        return True
    if not active:
        say("  ·", "已是 inactive，跳过")
        return True
    rc, out, err = sh("systemctl stop %s" % BRIDGE, timeout=90)
    if rc != 0:
        say("  ✗", "stop 失败: %s%s" % (out, err))
        return False
    rc, out, _ = sh("systemctl is-active %s" % BRIDGE)
    if out.strip() == "active":
        say("  ✗", "stop 后仍 active")
        return False
    say("  ✓", "桥接已停（自动拉起能力已摘除）")
    return True


def step_stop_sclaw(dry, old_pids):
    say("3/6", "停 SClaw 并等 fd 释放")
    say("  ·", "目标 PID: %s" % (old_pids or "无"))
    if dry:
        say("  →", "dry-run：将 TERM → 等 20s → KILL")
        return True, old_pids
    if not old_pids:
        say("  ·", "没有 SClaw 在跑")
        return True, []
    for pid in old_pids:
        sh("kill -TERM %d" % pid)
    deadline = time.time() + 20
    while time.time() < deadline:
        if not sclaw_pids():
            break
        time.sleep(0.5)
    left = sclaw_pids()
    for pid in left:
        say("  !", "PID %d 未退，KILL" % pid)
        sh("kill -KILL %d" % pid)
    time.sleep(1.0)
    left = sclaw_pids()
    if left:
        say("  ✗", "仍存活: %s" % left)
        return False, left
    # fd 释放 + 端口让出
    deadline = time.time() + 15
    while time.time() < deadline and port_open():
        time.sleep(0.5)
    if port_open():
        say("  ✗", "端口 %d 仍被占用" % PORT)
        return False, []
    say("  ✓", "SClaw 已停，端口 %d 已让出" % PORT)
    return True, []


def step_gate(dry):
    say("4/6", "跑 promote 闸门（backup → rename → verify，自带回滚）")
    cmd = "cd %s && python3 %s%s" % (BACKEND, GATE, "" if dry else " --yes")
    if dry:
        say("  →", "dry-run：将执行 %s" % cmd)
        return True
    say("  $", cmd)
    # 只跑一次！闸门有副作用（备份+rename），绝不可重跑。
    r = subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=3600)
    tail = (r.stdout or "").strip().splitlines()[-25:]
    for ln in tail:
        print("    | " + ln)
    if r.returncode != 0:
        say("  ✗", "闸门 rc=%d" % r.returncode)
        if r.stderr:
            print("    | " + r.stderr.strip().splitlines()[-1][:160])
        return False
    say("  ✓", "闸门通过")
    return True


def step_start_bridge(dry):
    say("5/6", "重启桥接（ensure 会自动拉起 SClaw，拿到新 inode）")
    if dry:
        say("  →", "dry-run：将执行 systemctl start %s" % BRIDGE)
        return True
    rc, out, err = sh("systemctl start %s" % BRIDGE, timeout=90)
    if rc != 0:
        say("  ✗", "start 失败: %s%s" % (out, err))
        return False
    say("  ✓", "systemctl start 已下发")
    return True


def step_verify(dry, old_pids, old_inode):
    say("6/6", "验证（SClaw 复活 + 新 inode 铁证）")
    if dry:
        say("  →", "dry-run：将轮询 3001 并比对 fd inode")
        return True
    deadline = time.time() + 60
    new_pids = []
    while time.time() < deadline:
        new_pids = [p for p in sclaw_pids() if p not in old_pids]
        if new_pids and port_open():
            break
        time.sleep(2)
    if not new_pids:
        say("  ✗", "SClaw 未在 60s 内复活（检查 mcp_listen.log 的 [ensure] 行）")
        return False
    new_pid = new_pids[0]
    say("  ✓", "SClaw 复活: PID %d（旧 %s）" % (new_pid, old_pids))

    # 注意：curl 的 -w 占位符 %{http_code} 必须转义成 %%{http_code}，
    # 否则会被 % PORT 当成非法格式符 -> ValueError（2026-09-12 实测踩坑）。
    rc, out, _ = sh("curl -s -m 5 -o /dev/null -w %%{http_code} http://127.0.0.1:%d/mcp" % PORT)
    say("  ·", "/mcp -> HTTP %s" % out.strip())

    fds = fd_inodes(new_pid)
    now_inode = inode_of(PROD)
    say("  ·", "prod inode: %s（切换前 %s）" % (now_inode, old_inode))
    if not fds:
        say("  !", "新 SClaw 尚未打开 clean_daily.db（可能懒加载，稍后再看）")
    for fd, (tgt, ino) in fds.items():
        mark = "✓ 新" if ino == now_inode else "✗ 旧(脏读!)"
        say("  %s" % mark, "fd=%s -> %s (inode=%s)" % (fd, tgt, ino))
    if fds and all(ino == now_inode for _, ino in fds.values()):
        say("  ✓✓", "SClaw 已持有新 inode —— 端到端切换完成")
        return True
    if not fds:
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true", help="真正执行（默认 dry-run）")
    ap.add_argument("--skip-bridge-stop", action="store_true",
                    help="桥接已是 inactive 时跳过停桥（幂等）")
    ap.add_argument("--rehearse", action="store_true",
                    help="彩排：仅与 dry-run 搭配，忽略「构建器仍在跑」一条，以便走完 2~6 步")
    a = ap.parse_args()
    dry = not a.yes
    if a.rehearse and not dry:
        print("!! --rehearse 只能用于 dry-run（不加 --yes）；拒绝执行")
        return 2

    print("=" * 68)
    print("cutover_v2.py  %s" % ("【DRY-RUN】" if dry else "【EXECUTE】"))
    print("=" * 68)

    old_inode = inode_of(PROD)
    old_pids = sclaw_pids()

    ok, holders = step_preflight(rehearse=a.rehearse)
    if not ok:
        say("ABORT", "preflight 未通过")
        return 2

    if a.skip_bridge_stop:
        say("2/6", "（--skip-bridge-stop）跳停桥")
    else:
        if not step_stop_bridge(dry):
            say("ABORT", "停桥失败")
            return 3

    ok, _ = step_stop_sclaw(dry, old_pids)
    if not ok:
        say("RECOVER", "尝试把桥接启回来…")
        if not dry:
            sh("systemctl start %s" % BRIDGE)
        return 4

    if not step_gate(dry):
        say("RECOVER", "闸门失败（其自带回滚）→ 尝试把桥接启回来…")
        if not dry:
            sh("systemctl start %s" % BRIDGE)
            say("RECOVER", "等 SClaw 复活…")
            for _ in range(30):
                if sclaw_pids() and port_open():
                    break
                time.sleep(2)
            say("RECOVER", "SClaw PID=%s" % sclaw_pids())
        return 5

    if not step_start_bridge(dry):
        say("ABORT", "桥接启动失败 —— 手动: systemctl start %s" % BRIDGE)
        return 6

    if not step_verify(dry, old_pids, old_inode):
        say("WARN", "验证未完全通过，人工确认")
        return 7

    print("=" * 68)
    print("✅ cutover 完成" if not dry else "✅ dry-run 通过（未改动任何东西）")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
