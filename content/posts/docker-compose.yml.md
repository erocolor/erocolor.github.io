+++
date = '2026-05-25T21:20:52+08:00'
draft = false
title = 'Docker Compose.yml'
+++
备份
```
services:
  # ==================== 自动追番 ====================
  ab:
    image: "ghcr.io/estrellaxd/auto_bangumi:latest"
    container_name: ab
    volumes:
      - /home/color/ab/config:/app/config
      - /home/color/ab/data:/app/data
      - /mnt/nas/10:/10          # 改用系统 NFS 挂载
      - /mnt/nas/16:/16
    restart: unless-stopped
    network_mode: host
    environment:
      - TZ=Asia/Shanghai
      - PUID=1000
      - PGID=1000

  # ==================== 媒体服务器 ====================
  emby:
    image: amilys/embyserver:latest
    container_name: emby
    network_mode: host
    environment:
      - HTTP_PROXY=http://127.0.0.1:7890
      - HTTPS_PROXY=http://127.0.0.1:7890
      - PUID=1000
      - PGID=1000
      - TZ=Asia/Shanghai
    volumes:
      - /home/color/emby:/config
      - /mnt/nas/10:/10
      - /mnt/nas/16:/16
    devices:
      - /dev/dri:/dev/dri
    restart: always
  # ==================== BT 下载器 ====================
  qb:
    image: linuxserver/qbittorrent:5.0.0
    container_name: qb
    network_mode: host
    mem_limit: 2G
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Asia/Shanghai
      - WEBUI_PORT=8080
    volumes:
      - /home/color/qb/config:/config
      - /home/color/qb/downloads:/downloads
      - /mnt/nas/16:/16
    restart: always
  # ==================== qBittorrent 2 - 辅种/刷流 ====================
  qb2:
    image: linuxserver/qbittorrent:5.0.0
    container_name: qb2
    network_mode: host
    mem_limit: 2G
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Asia/Shanghai
      - WEBUI_PORT=8081        # ⚠️ 不同端口，避免冲突
    volumes:
      - /home/color/qb2/config:/config   # ⚠️ 不同配置目录
      - /mnt/downloads2:/downloads       # ⚠️ 不同下载目录（可选）
      - /mnt/nas/16:/16
    restart: always
  # ==================== BT 下载器 - Transmission ====================
  tr:
    image: linuxserver/transmission:latest
    container_name: tr
    network_mode: host
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Asia/Shanghai
      - USER=color
      - PASS=adminadmin
      - TRANSMISSION_WEB_HOME=/config/web
    volumes:
      - /home/color/tr:/config
      - /mnt/nas/16:/16
      - /home/color/tr/downloads:/downloads
      - /home/color/tr/watch:/watch
    restart: unless-stopped
  # ==================== PT 助手 ====================
  iy:
    image: iyuucn/iyuuplus-dev:latest
    container_name: iy
    environment:
      - TZ=Asia/Shanghai
      - PUID=1000
      - PGID=1000
    volumes:
      - /home/color/iyuu/config:/iyuu
      - /home/color/iyuu/data:/data
      - /home/color/qb/config:/qb        # 挂载 QB 配置目录，方便 IYUU 读取
      - /mnt/nas/10:/10                  # 改为系统挂载
      - /mnt/nas/16:/16                  # 改为系统挂载
    ports:
      - "8780:8780"
    restart: always
    stdin_open: true
    tty: true
  # ==================== 笔记服务 ====================
  mm:
    image: neosmemo/memos:stable
    container_name: mm
    environment:
      - TZ=Asia/Shanghai
      - MEMOS_MODE=prod
      - MEMOS_PORT=5230
    volumes:
      - /home/color/mm:/var/opt/memos
    ports:
      - 5230:5230
    restart: always
      # ==================== BT 反吸血 ====================
  pbh:
    image: ghostchu/peerbanhelper:latest
    container_name: pbh
    environment:
      - TZ=Asia/Shanghai
      - PUID=1000
      - PGID=1000
    volumes:
      - /home/color/pbh/data:/app/data
      - /etc/localtime:/etc/localtime:ro
    ports:
      - 9898:9898
    restart: always
  # ==================== 硬链接工具 ====================
  hl:
    image: likun7981/hlink:latest
    container_name: hl
    environment:
      - HLINK_HOME=/home/color/hl
    volumes:
      - /home/color/color4/hl:/home/color/hl
      - /mnt/nas/10:/10
      - /mnt/nas/16:/16
    ports:
      - 9030:9090
    restart: always
  # ==================== 思源笔记 ====================
  sy:
    image: b3log/siyuan:latest
    container_name: sy
    environment:
      - TZ=Asia/Shanghai
      - PUID=1000
      - PGID=1000
    volumes:
      - /home/color/sy/workspace:/siyuan/workspace
    ports:
      - 6806:6806
    command:
      - --workspace=/siyuan/workspace/
      - --accessAuthCode=xxxx    #密码
    restart: always
   # ==================== 导航面板 ====================
  sp:
    image: hslr/sun-panel:latest
    container_name: sp
    environment:
      - TZ=Asia/Shanghai
      - PUID=1000
      - PGID=1000
    volumes:
      - /home/color/sp/conf:/app/conf
      - /var/run/docker.sock:/var/run/docker.sock  # 管理 Docker 容器
    ports:
      - 3002:3002
    restart: always

  # ======= meta面板 ==========
  metacubexd:
    container_name: meta
    image: swr.cn-north-4.myhuaweicloud.com/ddn-k8s/ghcr.io/metacubex/metacubexd:v1.245.1
    restart: always
    ports:
      - '3980:80'
```
