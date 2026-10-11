FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# 1. 필수 패키지, 오픈박스, 크로미움, 폰트, GUI 도구 설치
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    locales \
    openbox \
    chromium \
    xdotool \
    x11-utils \
    xclip \
    maim \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    procps \
    net-tools \
    netcat-openbsd \
    socat \
    ssl-cert \
    xauth \
    x11-xkb-utils \
    xkb-data \
    && sed -i -e 's/# ko_KR.UTF-8 UTF-8/ko_KR.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=ko_KR.UTF-8
ENV LANGUAGE=ko_KR:ko
ENV LC_ALL=ko_KR.UTF-8

# 2. KasmVNC 1.5.0 설치
RUN curl -sSL -o /tmp/kasmvnc.deb https://github.com/kasmtech/KasmVNC/releases/download/v1.5.0/kasmvncserver_bookworm_1.5.0_amd64.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb \
    && rm -rf /var/lib/apt/lists/*

# 3. 비특권 사용자(computer) 생성 및 권한 설정
RUN useradd -m -u 1000 -s /bin/bash computer \
    && mkdir -p /etc/kasmvnc /home/computer/.vnc /home/computer/.config/openbox \
    && chown -R computer:computer /home/computer

# 4. KasmVNC 설정 및 비밀번호(vncpass) 등록
COPY kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml
RUN mkdir -p /home/computer/.vnc \
    && touch /home/computer/.vnc/.de-was-selected \
    && cp /etc/kasmvnc/kasmvnc.yaml /home/computer/.vnc/kasmvnc.yaml \
    && printf "vncpass\nvncpass\n" | kasmvncpasswd -u computer -wo /home/computer/.kasmpasswd \
    && openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
         -keyout /home/computer/.vnc/self.key -out /home/computer/.vnc/self.crt \
         -subj "/CN=talorys-computer" 2>/dev/null \
    && chmod 600 /home/computer/.kasmpasswd /home/computer/.vnc/self.key \
    && chown -R computer:computer /home/computer

# 5. 시작 스크립트 복사
COPY xstartup /home/computer/.vnc/xstartup
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /home/computer/.vnc/xstartup /entrypoint.sh \
    && chown -R computer:computer /home/computer/.vnc

USER computer
ENV HOME=/home/computer
ENV DISPLAY=:1
WORKDIR /home/computer

EXPOSE 8444 9222

ENTRYPOINT ["/entrypoint.sh"]
