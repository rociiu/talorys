#!/bin/bash
set -e

echo "[talorys-computer] Initializing virtual desktop..."

# Display :1 잠금 파일 등 정리
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true

mkdir -p /home/computer/.vnc
touch /home/computer/.vnc/.de-was-selected

if [ ! -f /home/computer/.kasmpasswd ]; then
  printf "vncpass\nvncpass\n" | kasmvncpasswd -u computer -wo /home/computer/.kasmpasswd
  chmod 600 /home/computer/.kasmpasswd
fi

if [ ! -f /home/computer/.vnc/self.key ]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /home/computer/.vnc/self.key \
    -out /home/computer/.vnc/self.crt \
    -subj "/CN=talorys-computer" 2>/dev/null
  chmod 600 /home/computer/.vnc/self.key
fi

if [ ! -f /home/computer/.vnc/kasmvnc.yaml ]; then
  cp /etc/kasmvnc/kasmvnc.yaml /home/computer/.vnc/kasmvnc.yaml
fi

# KasmVNC 가상 디스플레이 시작
vncserver :1 -geometry 1280x800 -depth 24

echo "[talorys-computer] KasmVNC listening on 8444, CDP on 9222."

# 로그 감시하며 포그라운드 유지
trap "vncserver -kill :1" SIGTERM SIGINT

tail -f /home/computer/.vnc/*:1.log 2>/dev/null || sleep infinity
