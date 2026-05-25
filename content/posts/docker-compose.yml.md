+++
date = '2026-05-25T21:20:52+08:00'
draft = false
title = '从零开始的ubuntu使用'
+++



使用电视盒子装的armbian系统故障频发，实在懒得折腾，于是把之前的那台主机装上了ubuntu做服务器用，内存从4G跃进到16G,感觉真是幸福。
至于电费，算下来盒子的费用还有折腾的时间，原本还是赚的，现在也算是亡羊补牢吧。
现在硬件太贵，等到价位回落再考虑买个迷你主机。

记录一下安装系统之后的各种设置操作，以供后来参考

# 从零开始人ubuntu使用

1,切换fcitx五笔输入法
打开网络卷/16，下载码表文件和输入法主题。
在下载目录打开终端。
复制码表
sudo cp -r /home/color/下载/wbx.main.dict /usr/share/libime/
复制到主题到目录/home/color/.local/share/fcitx5/table/
修改fcitx配置，五笔字型设置，排序规则：频率-->否。
2,登陆deepseek,开启辅助。
3,设置临时系统网络代理。
下载安装 clash-verge-rev
https://github.com/Clash-Verge-rev/clash-verge-rev
4,更新系统
```sudo apt update && sudo apt upgrade -y```
5,安装多媒体解码器和常用字体
```sudo apt install ubuntu-restricted-extras -y```
6,启用防火墙
```sudo ufw enable```
7,安装优化工具
```
sudo apt install gnome-tweaks -y
```
8,挂载nas-nfs盘
# 1. 安装 NFS 客户端
```
sudo apt install nfs-common -y
```
# 2. 创建挂载点
```
sudo mkdir -p /mnt/nas/16
```
# 3. 挂载 NFS 共享
```
sudo mount -t nfs -o nfsvers=3,rw 192.168.1.177:/volume2/16 /mnt/nas/16
```
# 4. 设置开机自动挂载
```
echo "192.168.1.177:/volume2/16 /mnt/nas/16 nfs nfsvers=3,rw,_netdev,x-systemd.automount 0 0" | sudo tee -a /etc/fstab
echo "192.168.1.177:/volume3/10 /mnt/nas/10 nfs nfsvers=3,rw,_netdev,x-systemd.automount 0 0" | sudo tee -a /etc/fstab
```
# 5. 在容器中使用系统路径
docker run -v /mnt/nas/16:/data ...

# 6. 放行端口
```sudo ufw allow 7892```
查看当前防火墙放行
```sudo ufw status numbered```


/mnt/nas/10
/mnt/nas/16
是NAS里的两块硬盘，之后打算抛弃NAS直接装在服务器上。


docker-compose.yml备份

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
