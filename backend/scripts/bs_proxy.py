#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bs_proxy.py — 给 baostock 的裸 socket 打 SOCKS5 出网补丁（唯一真源）

根因（2026-09-12 实测定性）：厂商按 **IP** 拉黑，不是按账号。
  同一匿名账号：直连（本机 CN 出口）→ 10001011「黑名单用户，请与管理员联系」
                经境外出口            → login success、数据正常返回
  旁证：随便编一个账号名直连同样返回 10001011（而不是「用户名或密码错误」）
        ⇒ 服务端在校验凭据**之前**就按 IP 拒绝。

处置：把 baostock 内部 socket.socket() + connect() 换成「先连本地 SOCKS5，再 CONNECT 目标」。
      出口默认取环境变量 BS_PROXY（形如 127.0.0.1:17891，专用境外 mihomo 隔离实例）。

用法：
    from bs_proxy import install_socks_proxy, proxy_from_env
    p = proxy_from_env()
    if p:
        install_socks_proxy(p)

注意：
  - 补丁是 **进程级** 的。用 ProcessPoolExecutor 时必须让每个子进程各打一次
    （父进程打的补丁在 spawn 模式下不会替子进程生效），所以统一放在 initializer 里。
  - 本模块可被重复调用（同 proxy 直接返回，不同 proxy 报错），避免嵌套打补丁后
    出现「代理自己又去连代理」的握手递归。
"""
import os
import socket

DEFAULT_TIMEOUT = 30.0

_INSTALLED = {"proxy": ""}


def proxy_from_env(default=""):
    """取 BS_PROXY（可被 --proxy 覆盖）；返回 "host:port" 或 ""（空=直连，会被拉黑）"""
    return (os.environ.get("BS_PROXY") or default or "").strip()


def install_socks_proxy(proxy: str, timeout: float = DEFAULT_TIMEOUT,
                        only_hosts=None) -> str:
    """把 socket.socket 换成「先连 SOCKS5、再 CONNECT 目标」的子类。

    baostock 内部用裸 socket.socket() + connect()（socketutil.py），没有代理入口，
    所以只能在这一层打补丁。每个 worker 子进程各自调用一次。

    only_hosts: 可选白名单。给出时 **只有** 目标主机在名单里的连接才走代理，
    其余一律直连。补丁是进程级的，不给白名单的话境内 API（腾讯行情等）也会被
    绕去境外出口 —— 白白多一个 RTT，还会被按境外 IP 限速。
    """
    proxy = (proxy or "").strip()
    phost, _, pport = proxy.partition(":")
    phost, pport = phost.strip(), int(pport or "7891")
    allow = None
    if only_hosts:
        allow = tuple(h.strip().lower() for h in only_hosts if h and h.strip())

    class _SocksSocket(socket.socket):
        def connect(self, addr):
            if not isinstance(addr, tuple):
                return super().connect(addr)
            targ_host, targ_port = addr[0], int(addr[1])
            if allow is not None and targ_host.lower() not in allow:
                return super().connect(addr)      # 不在白名单 → 直连
            super().connect((phost, pport))
            self.settimeout(timeout)          # 代理握手也要有超时，不能无限挂
            self.sendall(b"\x05\x01\x00")     # SOCKS5 无认证
            if self.recv(2) != b"\x05\x00":
                raise OSError("socks5 握手失败")
            h = targ_host.encode()
            self.sendall(b"\x05\x01\x00\x03" + bytes([len(h)]) + h
                         + targ_port.to_bytes(2, "big"))
            rep = self.recv(4)
            if len(rep) < 4 or rep[1] != 0x00:
                raise OSError("socks5 CONNECT 被拒: rep=%r" % (rep,))
            atyp = rep[3]
            if atyp == 1:
                self.recv(4 + 2)
            elif atyp == 3:
                self.recv(self.recv(1)[0] + 2)
            elif atyp == 4:
                self.recv(16 + 2)

    if _INSTALLED["proxy"] == proxy:
        return proxy                        # 已打过：直接复用，避免二次包壳
    if _INSTALLED["proxy"]:
        raise RuntimeError("已对 %s 打过补丁，不能改指 %s" % (_INSTALLED["proxy"], proxy))

    socket.socket = _SocksSocket
    _INSTALLED["proxy"] = proxy
    return "%s:%d" % (phost, pport)
