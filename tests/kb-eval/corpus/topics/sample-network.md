---
title: 网络配置
tags: [topic]
---

本话题汇总代理、NAT、桥接的整体配置思路。

## TUN 模式与 NAT 类型
Clash 开启 TUN 模式后，NAT 类型检测会变化。光猫桥接（bridge）后需重新检测 NAT 类型，端口转发才生效。

## BT 上传与 choking
BitTorrent 的 choking 算法影响上传速度，端口可达性与 NAT 类型相关。
